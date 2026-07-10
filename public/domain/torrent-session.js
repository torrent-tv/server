/** @import { ProxyTransport } from './proxy-transport.js' */

import { pickWebSeedUrl, probeWebSeed } from "./webseed.js";
import { startNetReporter, stopNetReporter } from "./net-report.js";

export class TorrentSession {
  /** @type {(() => void) | null} */
  #seekCleanup = null;

  constructor(onLog) {
    this.onLog = onLog;
    this.current = null;
    this.proxySourceKeyCache = new Map();
    this.consumerId = buildConsumerId();
    this.abortController = new AbortController();
    /**
     * Maps transcode sessionId → ProxyTransport that owns the session.
     * @type {Map<string, import("./proxy-transport.js").ProxyTransport>}
     */
    this.activeTranscodeSessions = new Map();
    /**
     * How to poll the most recently created transcode session's progress.
     * @type {{ progressUrl: string, fetchFn: (url: string, options?: object) => Promise<Response> } | null}
     */
    this.activeProgressPoll = null;
  }

  clear(options = {}) {
    const preferBeacon = options?.preferBeacon === true;
    const reason = typeof options?.reason === "string" ? options.reason : "";
    if (this.#seekCleanup) {
      this.#seekCleanup();
      this.#seekCleanup = null;
    }
    this.abortPendingRequests();
    this.releaseActiveTranscodeSessions({ preferBeacon, reason });
    this.current = null;
    this.proxySourceKeyCache.clear();
    this.activeProgressPoll = null;
  }

  /**
   * Fetch the latest progress snapshot for the most recently created transcode
   * session. Lets callers keep updating the UI while the first segment is being
   * produced/buffered, after `waitForHlsPlaylist` has already returned.
   *
   * @returns {Promise<object | null>}
   */
  async fetchActiveTranscodeProgress() {
    const poll = this.activeProgressPoll;
    if (!poll || typeof poll.progressUrl !== "string" || poll.progressUrl.length === 0) {
      return null;
    }
    return fetchTranscodeProgress(poll.progressUrl, this.abortController.signal, poll.fetchFn);
  }

  abortPendingRequests() {
    this.abortController.abort();
    this.abortController = new AbortController();
  }

  releaseActiveTranscodeSessions(options = {}) {
    const preferBeacon = options?.preferBeacon === true;
    const reason = typeof options?.reason === "string" ? options.reason : "";
    // The viewer net reporter lives exactly as long as the session it feeds.
    stopNetReporter();
    if (this.activeTranscodeSessions.size === 0) {
      return;
    }
    const sessions = Array.from(this.activeTranscodeSessions.entries());
    this.activeTranscodeSessions.clear();
    for (const [sessionId, transport] of sessions) {
      // [evt] TEMPORARY: timestamped session lifecycle for log correlation.
      console.debug(`[evt] ${nowHms()} transcode-session release id=${sessionId.slice(0, 8)} reason=${reason || "(none)"}`);
      // WebRTC transport: fire-and-forget is unreliable on unload events,
      // and the proxy session expires when the data channel closes anyway.
      if (!transport.isHttp) {
        void transport.fetch(
          `/api/transcode-sessions/${encodeURIComponent(sessionId)}/release`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ consumerId: this.consumerId, reason })
          }
        ).catch(() => undefined);
        continue;
      }

      const endpoint = new URL(
        `api/transcode-sessions/${encodeURIComponent(sessionId)}/release`,
        ensureTrailingSlash(transport.baseUrl)
      );
      const payload = JSON.stringify({
        consumerId: this.consumerId,
        reason
      });
      if (preferBeacon && canUseSendBeacon()) {
        const body = new Blob([payload], { type: "application/json" });
        const sent = navigator.sendBeacon(endpoint.toString(), body);
        if (sent) {
          continue;
        }
      }
      void fetch(endpoint, {
        method: "POST",
        keepalive: true,
        headers: {
          "Content-Type": "application/json"
        },
        body: payload
      }).catch(() => undefined);
    }
  }

  openParsedTorrentDetails({ fileName, torrentBytes, meta }) {
    if (!(torrentBytes instanceof Uint8Array)) {
      throw new Error("torrentBytes must be Uint8Array.");
    }
    if (!meta || typeof meta !== "object" || !Array.isArray(meta.files)) {
      throw new Error("meta must contain parsed torrent details.");
    }
    const sourceName = typeof fileName === "string" && fileName.length > 0 ? fileName : meta.name;
    this.onLog(`Using pre-parsed torrent: ${sourceName}`);
    const torrentSourceBase64 = bytesToBase64(torrentBytes);
    this.current = {
      type: "torrent",
      sourceType: "torrent",
      sourceValue: torrentSourceBase64,
      ...meta
    };
    return this.current;
  }

  /**
   * Open a magnet link as the current source. The file list is unknown until
   * the proxy fetches the metadata from the swarm — the caller enriches
   * `current.name` / `current.files` / `current.isMultiFile` afterwards.
   *
   * @param {{ magnetUri: string }} params
   * @returns {object} The minimal `current` record.
   */
  openMagnetDetails({ magnetUri }) {
    if (typeof magnetUri !== "string" || !/^magnet:\?/i.test(magnetUri.trim())) {
      throw new Error("Not a magnet URI.");
    }
    this.onLog("Using magnet link source.");
    this.current = {
      type: "torrent",
      sourceType: "magnet",
      sourceValue: magnetUri.trim(),
      name: "",
      files: [],
      isMultiFile: false,
      webSeeds: []
    };
    return this.current;
  }

  /**
   * Start playback of a torrent file.
   *
   * Prefers direct webseed playback when a webseed URL is available.
   * Falls back to proxy direct streaming when a transport is supplied.
   *
   * @param {number} fileIndex
   * @param {HTMLVideoElement} videoElement
   * @param {{ transport?: ProxyTransport }} [options]
   * @returns {Promise<{ mode: "webseed" } | { mode: "proxy-direct", sourceKey: string }>}
   */
  async streamFileToVideo(fileIndex, videoElement, options = {}) {
    if (!this.current || this.current.type !== "torrent") {
      throw new Error("Only parsed .torrent file can be streamed in this mode.");
    }

    const file = this.current.files[fileIndex];
    if (!file) {
      throw new Error("File not found in torrent metadata.");
    }
    if (!file.isVideo) {
      throw new Error("Selected file is not a video.");
    }

    const fileUrl = pickWebSeedUrl(file, this.current.webSeeds, this.current.isMultiFile);
    const transport = options.transport ?? null;

    if (fileUrl) {
      const probe = await probeWebSeed(fileUrl, { signal: this.abortController.signal });
      if (!probe.supportsRange) {
        this.onLog("Webseed does not report Accept-Ranges: bytes.");
      }

      this.onLog(`Streaming from webseed: ${fileUrl}`);
      videoElement.pause();
      videoElement.src = fileUrl;
      videoElement.load();
      await videoElement.play().catch(() => undefined);
      return { mode: "webseed" };
    }

    if (!transport) {
      throw new Error("No webseed and no selected proxy client.");
    }

    const sourceKey = await this.registerSourceOnProxy(transport);
    const directProxyUrl = this.buildDirectProxyUrl(transport, sourceKey, fileIndex);
    this.onLog(`Streaming from proxy client: ${new URL(directProxyUrl).origin}`);
    await this.playFromUrl(videoElement, directProxyUrl);
    return { mode: "proxy-direct", sourceKey };
  }

  /**
   * Start HLS transcode playback.
   *
   * Registers the torrent source on the proxy, creates a transcode session,
   * waits for the HLS playlist to be ready, then delegates to `playHls`.
   *
   * @param {number} fileIndex
   * @param {HTMLVideoElement} videoElement
   * @param {{
   *   transport: ProxyTransport,
   *   sourceKey?: string,
   *   playHls: (videoElement: HTMLVideoElement, manifestUrl: string) => Promise<void>,
   *   onTranscodeProgress?: (progress: object) => void,
   *   transcodeVideo?: boolean,
   *   transcodeAudio?: boolean,
   *   targetWidth?: number,
   *   targetHeight?: number
   * }} options
   * @returns {Promise<{ mode: "proxy-hls" }>}
   */
  async streamFileToVideoWithAudioTranscode(fileIndex, videoElement, options = {}) {
    if (!this.current || this.current.type !== "torrent") {
      throw new Error("Only parsed .torrent file can be streamed in this mode.");
    }
    const file = this.current.files[fileIndex];
    if (!file || !file.isVideo) {
      throw new Error("Selected file is not a video.");
    }

    const transport = options.transport ?? null;
    if (!transport) {
      throw new Error("Proxy transport is required for audio transcode.");
    }
    const playHls = typeof options.playHls === "function" ? options.playHls : null;
    if (!playHls) {
      throw new Error("HLS player function is required.");
    }
    const onTranscodeProgress =
      typeof options.onTranscodeProgress === "function" ? options.onTranscodeProgress : null;
    const transcodeVideo = options.transcodeVideo === true;
    const transcodeAudio = options.transcodeAudio === true;
    const targetWidth = Number.isInteger(options.targetWidth) && options.targetWidth > 0 ? options.targetWidth : 0;
    const targetHeight =
      Number.isInteger(options.targetHeight) && options.targetHeight > 0 ? options.targetHeight : 0;
    const manualQuality = options.manualQuality === true;
    const audioTrackIndex =
      Number.isInteger(options.audioTrackIndex) && options.audioTrackIndex > 0
        ? options.audioTrackIndex
        : 0;

    const sourceKey =
      typeof options.sourceKey === "string" && options.sourceKey.length > 0
        ? options.sourceKey
        : await this.registerSourceOnProxy(transport);
    const playlistUrl = await this.tryCreateTranscodeSession(
      transport,
      sourceKey,
      fileIndex,
      onTranscodeProgress,
      transcodeVideo,
      {
        transcodeAudio,
        targetWidth,
        targetHeight,
        manualQuality,
        audioTrackIndex
      }
    );
    if (!playlistUrl) {
      throw new Error("Proxy audio transcode is unavailable.");
    }

    this.onLog(`Streaming via HLS audio transcode from proxy: ${new URL(transport.baseUrl).origin}`);
    console.debug("[torrent-tv] HLS transcode playback", {
      fileIndex,
      transcodeVideo,
      transcodeAudio,
      playlistUrl
    });
    await playHls(videoElement, playlistUrl);

    // Seeking is handled entirely server-side: the proxy serves a complete VOD
    // playlist (full duration, #EXT-X-ENDLIST) and produces segments on demand,
    // restarting ffmpeg at the requested position when the player seeks past
    // the encoded range.  No client-side session restart is required, which
    // also avoids playlist-swap glitches during scrubbing.

    return { mode: "proxy-hls" };
  }

  /**
   * Register the torrent source on the proxy and query the playback plan.
   *
   * Returns the source key, the proxy's recommended playback mode (`"direct"` or
   * `"hls"`), the detected codec names, and a direct stream URL.
   *
   * @param {number} fileIndex
   * @param {ProxyTransport} transport
   * @returns {Promise<{ sourceKey: string, directUrl: string, mode: "direct" | "hls", audioCodec: string, videoCodec: string, container: string, durationSeconds: number, videoWidth: number, videoHeight: number, pending: boolean }>}
   */
  async prepareProxyPlaybackPlan(fileIndex, transport) {
    if (!this.current || this.current.type !== "torrent") {
      throw new Error("Only parsed .torrent file can be streamed in this mode.");
    }
    const file = this.current.files[fileIndex];
    if (!file || !file.isVideo) {
      throw new Error("Selected file is not a video.");
    }
    if (!transport) {
      throw new Error("No selected proxy client.");
    }

    const sourceKey = await this.registerSourceOnProxy(transport);
    const directProxyUrl = this.buildDirectProxyUrl(transport, sourceKey, fileIndex);
    const userAgent =
      typeof navigator === "object" && typeof navigator.userAgent === "string"
        ? navigator.userAgent
        : "";
    const response = await transport.fetch("/api/playback-plan", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      signal: this.abortController.signal,
      body: JSON.stringify({
        sourceKey,
        fileIndex,
        userAgent
      })
    });

    if (!response.ok) {
      let details = "";
      try {
        const payload = await response.json();
        details = typeof payload?.error === "string" ? payload.error : "";
      } catch (_error) {
        // Ignore non-JSON error payload.
      }
      const suffix = details ? `: ${details}` : "";
      throw new Error(`Proxy playback plan request failed (${response.status})${suffix}`);
    }

    const payload = await response.json();
    const mode = payload?.mode === "hls" ? "hls" : "direct";
    const directUrl =
      typeof payload?.directUrl === "string" && payload.directUrl.trim().length > 0
        ? payload.directUrl.trim()
        : directProxyUrl;
    const audioCodec = typeof payload?.audioCodec === "string" ? payload.audioCodec.trim().toLowerCase() : "";
    const videoCodec = typeof payload?.videoCodec === "string" ? payload.videoCodec.trim().toLowerCase() : "";
    const container = typeof payload?.container === "string" ? payload.container.trim().toLowerCase() : "";
    const durationSeconds =
      typeof payload?.durationSeconds === "number" && Number.isFinite(payload.durationSeconds)
        ? payload.durationSeconds
        : 0;
    // Source coded resolution (proxy 2.9.32+; 0 on older proxies) — drives the
    // manual quality menu.
    const videoWidth =
      typeof payload?.videoWidth === "number" && Number.isFinite(payload.videoWidth) ? payload.videoWidth : 0;
    const videoHeight =
      typeof payload?.videoHeight === "number" && Number.isFinite(payload.videoHeight) ? payload.videoHeight : 0;

    // `pending` = the file header is still downloading and codecs could not be
    // probed yet. The caller should poll again (the proxy keeps the header
    // prioritised). Not a failure.
    const pending = payload?.pending === true;

    return {
      sourceKey,
      directUrl,
      mode,
      audioCodec,
      videoCodec,
      container,
      durationSeconds,
      videoWidth,
      videoHeight,
      // Full track inventory (proxy 2.9.26+; empty on older proxies).
      audioTracks: Array.isArray(payload?.audioTracks) ? payload.audioTracks : [],
      subtitleTracks: Array.isArray(payload?.subtitleTracks) ? payload.subtitleTracks : [],
      pending
    };
  }

  async playFromUrl(videoElement, url) {
    videoElement.pause();
    videoElement.src = url;
    videoElement.load();
    await videoElement.play().catch(() => undefined);
  }

  /**
   * Build a direct stream URL string for this transport.
   *
   * @param {import("./proxy-transport.js").ProxyTransport} transport
   * @param {string} sourceKey
   * @param {number} fileIndex
   * @returns {string}
   */
  buildDirectProxyUrl(transport, sourceKey, fileIndex) {
    const base = transport.url("/stream");
    const url = new URL(base);
    url.searchParams.set("sourceKey", sourceKey);
    url.searchParams.set("fileIndex", String(fileIndex));
    return url.toString();
  }

  /**
   * @param {import("./proxy-transport.js").ProxyTransport} transport
   * @param {string} sourceKey
   * @param {number} fileIndex
   * @param {((progress: object) => void) | null} onTranscodeProgress
   * @param {boolean} transcodeVideo
   * @param {{ transcodeAudio?: boolean, targetWidth?: number, targetHeight?: number, startPositionSeconds?: number }} options
   * @returns {Promise<string>} HLS playlist URL
   */
  async tryCreateTranscodeSession(
    transport,
    sourceKey,
    fileIndex,
    onTranscodeProgress,
    transcodeVideo = false,
    options = {}
  ) {
    const startPositionSeconds =
      Number.isFinite(options.startPositionSeconds) && options.startPositionSeconds > 0
        ? options.startPositionSeconds
        : 0;
    const createDeadlineMs = Date.now() + 90_000;
    let attempt = 0;
    let response = null;
    while (Date.now() < createDeadlineMs) {
      response = await transport.fetch("/api/transcode-sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        signal: this.abortController.signal,
        body: JSON.stringify({
          sourceKey,
          fileIndex,
          transcodeVideo,
          transcodeAudio: options.transcodeAudio !== false,
          targetWidth:
            Number.isInteger(options.targetWidth) && options.targetWidth > 0 ? options.targetWidth : undefined,
          targetHeight:
            Number.isInteger(options.targetHeight) && options.targetHeight > 0 ? options.targetHeight : undefined,
          manualQuality: options.manualQuality === true ? true : undefined,
          consumerId: this.consumerId,
          fileName: this.#getFileLogName(fileIndex),
          startPositionSeconds: startPositionSeconds > 0 ? startPositionSeconds : undefined,
          audioTrackIndex:
            Number.isInteger(options.audioTrackIndex) && options.audioTrackIndex > 0
              ? options.audioTrackIndex
              : undefined
        })
      });

      if (response.ok) {
        break;
      }

      let details = "";
      try {
        const payload = await response.json();
        details = typeof payload?.error === "string" ? payload.error : "";
      } catch (_error) {
        // Ignore non-JSON error payload.
      }

      const isWarmupError =
        response.status === 500 && /HLS playlist is still warming up/i.test(details);
      if (isWarmupError) {
        attempt += 1;
        await delay(Math.min(3000, 500 + attempt * 250));
        continue;
      }

      const suffix = details ? `: ${details}` : "";
      throw new Error(`Transcode session request failed (${response.status})${suffix}`);
    }

    if (!response || !response.ok) {
      throw new Error("Timed out waiting for transcode session allocation.");
    }

    const payload = await response.json();
    const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
    const playlistPath = typeof payload?.playlistPath === "string" ? payload.playlistPath.trim() : "";
    if (!playlistPath) {
      throw new Error("Proxy did not return transcode playlist path.");
    }
    const playlistUrl = transport.url(playlistPath);
    const progressPath = sessionId
      ? `/api/transcode-sessions/${encodeURIComponent(sessionId)}/progress`
      : "";
    const progressUrl = progressPath ? transport.url(progressPath) : "";

    if (sessionId) {
      this.activeTranscodeSessions.set(sessionId, transport);
      // [evt] TEMPORARY: timestamped session lifecycle for log correlation.
      console.debug(`[evt] ${nowHms()} transcode-session create id=${sessionId.slice(0, 8)} fileIndex=${fileIndex}`);
      // Viewer net reporter (adaptive bitrate): feed the proxy's link-deficit
      // downshift trigger with measured throughput + buffer while this
      // session is active. Stopped in releaseActiveTranscodeSessions.
      startNetReporter({
        transport,
        sessionId,
        getBufferedAheadSec: bufferedAheadSeconds
      });
    }

    // Build a fetchFn that routes through this transport (required for WebRTC,
    // harmless for HTTP where it just normalises the URL construction).
    const fetchFn = (url, fetchOptions) => {
      const parsed = new URL(url);
      return transport.fetch(parsed.pathname + parsed.search, fetchOptions);
    };

    // Remember how to poll this session's progress so callers can keep showing
    // live status AFTER the playlist is ready, while the first segment is being
    // produced and buffered (waitForHlsPlaylist returns immediately for the
    // synthetic VOD playlist, so it cannot drive that part of the UI).
    this.activeProgressPoll = progressUrl ? { progressUrl, fetchFn } : null;

    await waitForHlsPlaylist(playlistUrl, 15 * 60_000, {
      progressUrl,
      fetchFn,
      onProgress: onTranscodeProgress,
      signal: this.abortController.signal
    });
    return playlistUrl;
  }

  /**
   * @param {import("./proxy-transport.js").ProxyTransport} transport
   * @returns {Promise<string>} sourceKey
   */
  async registerSourceOnProxy(transport) {
    if (!this.current) {
      throw new Error("Torrent source is not loaded.");
    }

    const cacheKey = `${transport.baseUrl}|${this.current.sourceType}|${this.current.sourceValue}`;
    const existing = this.proxySourceKeyCache.get(cacheKey);
    if (existing) {
      return existing;
    }

    const response = await transport.fetch("/api/sources", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      signal: this.abortController.signal,
      body: JSON.stringify({
        sourceType: this.current.sourceType,
        source: this.current.sourceValue
      })
    });
    if (!response.ok) {
      throw new Error(`Proxy source registration failed (${response.status}).`);
    }

    const payload = await response.json();
    const sourceKey = typeof payload?.sourceKey === "string" ? payload.sourceKey : "";
    if (!sourceKey) {
      throw new Error("Proxy did not return sourceKey.");
    }
    this.proxySourceKeyCache.set(cacheKey, sourceKey);
    return sourceKey;
  }

  /**
   * @param {number} fileIndex
   * @returns {string}
   */
  #getFileLogName(fileIndex) {
    const file = Array.isArray(this.current?.files) ? this.current.files[fileIndex] : null;
    if (!file || typeof file !== "object") {
      return "";
    }
    const relativePath = typeof file.relativePath === "string" ? file.relativePath.trim() : "";
    if (relativePath.length > 0) {
      return relativePath;
    }
    return typeof file.name === "string" ? file.name.trim() : "";
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

/**
 * @param {string} playlistUrl
 * @param {number} timeoutMs
 * @param {{
 *   progressUrl?: string,
 *   fetchFn?: (url: string, options?: object) => Promise<Response>,
 *   onProgress?: ((progress: object) => void) | null,
 *   signal?: AbortSignal | null
 * }} telemetry
 */
async function waitForHlsPlaylist(playlistUrl, timeoutMs, telemetry = {}) {
  const startedAt = Date.now();
  let attempt = 0;
  let lastProgressPollMs = 0;
  const progressUrl =
    typeof telemetry.progressUrl === "string" ? telemetry.progressUrl.trim() : "";
  const onProgress = typeof telemetry.onProgress === "function" ? telemetry.onProgress : null;
  const signal = telemetry.signal instanceof AbortSignal ? telemetry.signal : null;
  // Allow callers to supply a custom fetch (e.g. WebRTC transport).
  const fetchFn =
    typeof telemetry.fetchFn === "function"
      ? telemetry.fetchFn
      : (url, options) => fetch(url, options);

  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const now = Date.now();
    if (progressUrl && onProgress && now - lastProgressPollMs >= 1000) {
      const progress = await fetchTranscodeProgress(progressUrl, signal, fetchFn);
      if (progress) {
        onProgress(progress);
      }
      lastProgressPollMs = now;
    }

    try {
      const response = await fetchFn(playlistUrl, { cache: "no-store", signal: signal ?? undefined });
      if (response.status === 202 || response.status === 404) {
        const retryAfterHeader = response.headers.get("Retry-After");
        const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN;
        const backoffMs = Number.isFinite(retryAfterSec)
          ? Math.max(250, retryAfterSec * 1000)
          : Math.min(3000, 500 + attempt * 250);
        attempt += 1;
        await delay(backoffMs);
        continue;
      }
      if (response.ok) {
        const body = await response.text();
        // With HLS event-type playlists, #EXT-X-ENDLIST is only written when the
        // entire transcode is complete. Start playback as soon as the first
        // segment is present (#EXTINF:), which means buffering can begin immediately.
        if (body.includes("#EXTM3U") && (body.includes("#EXTINF:") || body.includes("#EXT-X-ENDLIST"))) {
          return;
        }
        attempt += 1;
        await delay(Math.min(3000, 500 + attempt * 250));
        continue;
      } else if (response.status >= 500) {
        let details = "";
        try {
          const payload = await response.json();
          details = typeof payload?.error === "string" ? payload.error : "";
        } catch (_error) {
          // Ignore non-JSON responses.
        }
        const suffix = details ? `: ${details}` : "";
        throw new Error(`Transcode playlist request failed (${response.status})${suffix}`);
      }
    } catch (_error) {
      if (isAbortError(_error)) {
        throw _error;
      }
      // Playlist can be temporarily unavailable while ffmpeg is warming up.
    }
    attempt += 1;
    await delay(Math.min(3000, 500 + attempt * 250));
  }
  throw new Error("Timed out waiting for generated HLS playlist.");
}

/**
 * @param {string} progressUrl
 * @param {AbortSignal | null} signal
 * @param {(url: string, options?: object) => Promise<Response>} fetchFn
 */
async function fetchTranscodeProgress(progressUrl, signal, fetchFn = fetch) {
  try {
    const response = await fetchFn(progressUrl, { cache: "no-store", signal: signal ?? undefined });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    if (!payload || typeof payload !== "object") {
      return null;
    }
    return payload;
  } catch (_error) {
    if (isAbortError(_error)) {
      throw _error;
    }
    return null;
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Local wall-clock `HH:MM:SS.mmm` for correlating browser logs with the proxy's
 * timestamped logs. TEMPORARY diagnostic helper.
 *
 * @returns {string}
 */
function nowHms() {
  // UTC HH:MM:SS.mmm — same timezone as the proxy logger, so browser and proxy
  // logs line up exactly when correlating them.
  return new Date().toISOString().slice(11, 23);
}

function buildConsumerId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `consumer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Seconds of media buffered ahead of the playhead, for the viewer net
 * reporter. Looks the player element up lazily by its stable id (the app has
 * exactly one video element) — this method runs from the session layer,
 * which has no element reference at session-create time.
 *
 * @returns {number}
 */
function bufferedAheadSeconds() {
  const video = document.querySelector("#player__video");
  if (!(video instanceof HTMLVideoElement)) {
    return 0;
  }
  const t = video.currentTime;
  const ranges = video.buffered;
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= t && t <= ranges.end(i)) {
      return Math.max(0, ranges.end(i) - t);
    }
  }
  return 0;
}

function isAbortError(error) {
  if (error instanceof DOMException) {
    return error.name === "AbortError";
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "AbortError";
}

function canUseSendBeacon() {
  return (
    typeof navigator === "object" &&
    navigator !== null &&
    typeof navigator.sendBeacon === "function"
  );
}
