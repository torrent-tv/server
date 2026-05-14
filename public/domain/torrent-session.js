import { pickWebSeedUrl, probeWebSeed } from "./webseed.js";

export class TorrentSession {
  constructor(onLog) {
    this.onLog = onLog;
    this.current = null;
    this.proxySourceKeyCache = new Map();
    this.consumerId = buildConsumerId();
    this.abortController = new AbortController();
    this.activeTranscodeSessions = new Map();
  }

  clear(options = {}) {
    const preferBeacon = options?.preferBeacon === true;
    const reason = typeof options?.reason === "string" ? options.reason : "";
    this.abortPendingRequests();
    this.releaseActiveTranscodeSessions({ preferBeacon, reason });
    this.current = null;
    this.proxySourceKeyCache.clear();
  }

  abortPendingRequests() {
    this.abortController.abort();
    this.abortController = new AbortController();
  }

  releaseActiveTranscodeSessions(options = {}) {
    const preferBeacon = options?.preferBeacon === true;
    const reason = typeof options?.reason === "string" ? options.reason : "";
    if (this.activeTranscodeSessions.size === 0) {
      return;
    }
    const sessions = Array.from(this.activeTranscodeSessions.entries());
    this.activeTranscodeSessions.clear();
    for (const [sessionId, proxyBaseUrl] of sessions) {
      const endpoint = new URL(
        `api/transcode-sessions/${encodeURIComponent(sessionId)}/release`,
        ensureTrailingSlash(proxyBaseUrl)
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
    const proxyBaseUrl =
      typeof options.proxyBaseUrl === "string" ? options.proxyBaseUrl.trim() : "";

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

    if (!proxyBaseUrl) {
      throw new Error("No webseed and no selected proxy client.");
    }

    const sourceKey = await this.registerSourceOnProxy(proxyBaseUrl);
    const directProxyUrl = this.buildDirectProxyUrl(proxyBaseUrl, sourceKey, fileIndex);
    this.onLog(`Streaming from proxy client: ${directProxyUrl.origin}`);
    await this.playFromUrl(videoElement, directProxyUrl.toString());
    return { mode: "proxy-direct", sourceKey };
  }

  async streamFileToVideoWithAudioTranscode(fileIndex, videoElement, options = {}) {
    if (!this.current || this.current.type !== "torrent") {
      throw new Error("Only parsed .torrent file can be streamed in this mode.");
    }
    const file = this.current.files[fileIndex];
    if (!file || !file.isVideo) {
      throw new Error("Selected file is not a video.");
    }

    const proxyBaseUrl =
      typeof options.proxyBaseUrl === "string" ? options.proxyBaseUrl.trim() : "";
    if (!proxyBaseUrl) {
      throw new Error("Proxy client is required for audio transcode.");
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

    const sourceKey =
      typeof options.sourceKey === "string" && options.sourceKey.length > 0
        ? options.sourceKey
        : await this.registerSourceOnProxy(proxyBaseUrl);
    const playlistUrl = await this.tryCreateTranscodeSession(
      proxyBaseUrl,
      sourceKey,
      fileIndex,
      onTranscodeProgress,
      transcodeVideo,
      {
        transcodeAudio,
        targetWidth,
        targetHeight
      }
    );
    if (!playlistUrl) {
      throw new Error("Proxy audio transcode is unavailable.");
    }

    this.onLog(`Streaming via HLS audio transcode from proxy: ${new URL(playlistUrl).origin}`);
    await playHls(videoElement, playlistUrl);
    return { mode: "proxy-hls" };
  }

  async prepareProxyPlaybackPlan(fileIndex, proxyBaseUrl) {
    if (!this.current || this.current.type !== "torrent") {
      throw new Error("Only parsed .torrent file can be streamed in this mode.");
    }
    const file = this.current.files[fileIndex];
    if (!file || !file.isVideo) {
      throw new Error("Selected file is not a video.");
    }
    if (!proxyBaseUrl) {
      throw new Error("No selected proxy client.");
    }

    const sourceKey = await this.registerSourceOnProxy(proxyBaseUrl);
    const directProxyUrl = this.buildDirectProxyUrl(proxyBaseUrl, sourceKey, fileIndex);
    const endpoint = new URL("api/playback-plan", ensureTrailingSlash(proxyBaseUrl));
    const userAgent =
      typeof navigator === "object" && typeof navigator.userAgent === "string"
        ? navigator.userAgent
        : "";
    const response = await fetch(endpoint, {
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
        : directProxyUrl.toString();
    const audioCodec = typeof payload?.audioCodec === "string" ? payload.audioCodec.trim().toLowerCase() : "";
    const videoCodec = typeof payload?.videoCodec === "string" ? payload.videoCodec.trim().toLowerCase() : "";

    return {
      sourceKey,
      directUrl,
      mode,
      audioCodec,
      videoCodec
    };
  }

  async playFromUrl(videoElement, url) {
    videoElement.pause();
    videoElement.src = url;
    videoElement.load();
    await videoElement.play().catch(() => undefined);
  }

  buildDirectProxyUrl(proxyBaseUrl, sourceKey, fileIndex) {
    const directProxyUrl = new URL("stream", ensureTrailingSlash(proxyBaseUrl));
    directProxyUrl.searchParams.set("sourceKey", sourceKey);
    directProxyUrl.searchParams.set("fileIndex", String(fileIndex));
    return directProxyUrl;
  }

  async tryCreateTranscodeSession(
    proxyBaseUrl,
    sourceKey,
    fileIndex,
    onTranscodeProgress,
    transcodeVideo = false,
    options = {}
  ) {
    const endpoint = new URL("api/transcode-sessions", ensureTrailingSlash(proxyBaseUrl));
    const createDeadlineMs = Date.now() + 90_000;
    let attempt = 0;
    let response = null;
    while (Date.now() < createDeadlineMs) {
      response = await fetch(endpoint, {
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
          consumerId: this.consumerId,
          fileName: this.#getFileLogName(fileIndex)
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
    const playlistUrl = new URL(
      playlistPath.replace(/^\/+/, ""),
      ensureTrailingSlash(proxyBaseUrl)
    ).toString();
    const progressUrl = sessionId
      ? new URL(
          `api/transcode-sessions/${encodeURIComponent(sessionId)}/progress`,
          ensureTrailingSlash(proxyBaseUrl)
        ).toString()
      : "";
    if (sessionId) {
      this.activeTranscodeSessions.set(sessionId, proxyBaseUrl);
    }
    await waitForHlsPlaylist(playlistUrl, 15 * 60_000, {
      progressUrl,
      onProgress: onTranscodeProgress,
      signal: this.abortController.signal
    });
    return playlistUrl;
  }

  async registerSourceOnProxy(proxyBaseUrl) {
    if (!this.current) {
      throw new Error("Torrent source is not loaded.");
    }

    const cacheKey = `${proxyBaseUrl}|${this.current.sourceType}|${this.current.sourceValue}`;
    const existing = this.proxySourceKeyCache.get(cacheKey);
    if (existing) {
      return existing;
    }

    const endpoint = new URL("api/sources", ensureTrailingSlash(proxyBaseUrl));
    const response = await fetch(endpoint, {
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

async function waitForHlsPlaylist(playlistUrl, timeoutMs, telemetry = {}) {
  const startedAt = Date.now();
  let attempt = 0;
  let lastProgressPollMs = 0;
  const progressUrl =
    typeof telemetry.progressUrl === "string" ? telemetry.progressUrl.trim() : "";
  const onProgress = typeof telemetry.onProgress === "function" ? telemetry.onProgress : null;
  const signal = telemetry.signal instanceof AbortSignal ? telemetry.signal : null;

  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const now = Date.now();
    if (progressUrl && onProgress && now - lastProgressPollMs >= 1000) {
      const progress = await fetchTranscodeProgress(progressUrl, signal);
      if (progress) {
        onProgress(progress);
      }
      lastProgressPollMs = now;
    }

    try {
      const response = await fetch(playlistUrl, { cache: "no-store", signal: signal ?? undefined });
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
        if (body.includes("#EXTM3U") && body.includes("#EXT-X-ENDLIST")) {
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

async function fetchTranscodeProgress(progressUrl, signal) {
  try {
    const response = await fetch(progressUrl, { cache: "no-store", signal: signal ?? undefined });
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

function buildConsumerId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `consumer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
