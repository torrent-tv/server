/** @import { ProxyTransport } from './proxy-transport.js' */

import { PLAYER_EVENTS } from "../shared/events.js";
import { pickWebSeedUrl, probeWebSeed } from "./webseed.js";
import { SESSION_EVENTS } from "../shared/events.js";
import { startNetReporter, stopNetReporter } from "./net-report.js";

// How often the browser re-asserts that it is still watching. Must sit well
// below the proxy's ten-minute session timeout — 30 s leaves twenty chances to
// be heard before it expires, and each one costs a 44-byte response.
const SESSION_KEEPALIVE_MS = 30_000;

export class TorrentSession {
  /** @type {(() => void) | null} */
  #seekCleanup = null;

  /**
   * Sessions whose keepalive answer could not be read, and sessions whose
   * keepalive request failed outright. Both are kept so each condition is
   * reported once per run of it rather than every thirty seconds — which is
   * how often this ping goes out. Entries are dropped when the session is
   * released or reported gone, so neither set outlives the sessions it names.
   *
   * @type {Set<string>}
   */
  #unreadableProgress = new Set();

  /** @type {Set<string>} */
  #pingFailing = new Set();

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
    /** Timer that re-asserts presence; see #keepSessionsAlive. */
    this.keepAliveTimer = null;
    /**
     * How to poll the most recently created transcode session's progress.
     * @type {{ progressUrl: string, fetchFn: (url: string, options?: object) => Promise<Response> } | null}
     */
    this.activeProgressPoll = null;
    /**
     * The transcode session the viewer is watching, as opposed to any that have
     * not been released yet.
     * @type {{ sessionId: string, transport: import("./proxy-transport.js").ProxyTransport } | null}
     */
    this.currentTranscodeSession = null;
  }

  clear(options = {}) {
    const preferBeacon = options?.preferBeacon === true;
    const reason = typeof options?.reason === "string" ? options.reason : "";
    // Tear down the active stream but keep `current` (the parsed torrent
    // details) when the caller wants the playlist to stay usable — e.g. after a
    // failed episode, so re-picking another episode re-enters the loading flow
    // instead of hitting a null `current` and silently doing nothing.
    const keepSource = options?.keepSource === true;
    if (this.#seekCleanup) {
      this.#seekCleanup();
      this.#seekCleanup = null;
    }
    this.abortPendingRequests();
    this.releaseActiveTranscodeSessions({ preferBeacon, reason });
    if (!keepSource) {
      this.current = null;
    }
    // The source-key cache is keyed by the (now closed) transport's baseUrl, so
    // it is always dropped — a re-pick reconnects a fresh proxy and re-registers.
    this.proxySourceKeyCache.clear();
    this.activeProgressPoll = null;
    this.currentTranscodeSession = null;
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

  /**
   * Ask the proxy to prepare a quality rung before the player is told to
   * switch to it.
   *
   * A rung is an encoder that does not exist until it is asked for, so
   * switching first and waiting second shows a spinner for as long as its first
   * segment takes to make. Asking first moves that wait behind the picture that
   * is still playing.
   *
   * Best effort by design: a rung that is not ready in time is not a reason to
   * refuse the viewer their switch — it only means they wait where they would
   * have waited anyway.
   *
   * @param {number} height
   * @param {number} positionSeconds
   * @returns {Promise<boolean>} Whether the rung reported itself ready.
   */
  async prepareQualityVariant(height, positionSeconds) {
    const current = this.currentTranscodeSession;
    if (!current || !this.activeTranscodeSessions.has(current.sessionId) || !Number.isFinite(positionSeconds)) {
      return false;
    }
    const { sessionId, transport } = current;
    const path =
      `/transcode/${encodeURIComponent(sessionId)}/v/${height}/warm` +
      `?position=${positionSeconds.toFixed(3)}`;
    try {
      const response = await transport.fetch(path);
      return response.status === 204;
    } catch (error) {
      console.debug("[torrent-tv] warming the quality variant failed", error);
      return false;
    }
  }

  /**
   * Ask the proxy to have an audio track ready at a position before the player
   * is told to change to it.
   *
   * The player discards the audio it holds the moment it changes track, and it
   * cannot show a frame until the new track covers the playhead — so switching
   * first and producing second shows the track's cold start as a spinner over a
   * stopped picture. The same reason the quality rung above is prepared.
   *
   * Best effort: a track that is not ready in time is not a reason to refuse
   * the viewer their change, it only means they wait where they would have
   * waited anyway.
   *
   * @param {number} trackIndex
   * @param {number} positionSeconds
   * @returns {Promise<"ready" | "not-ready" | "unsupported">} Whether the track reported itself ready.
   */
  async prepareAudioTrack(trackIndex, positionSeconds) {
    const current = this.currentTranscodeSession;
    if (!current || !this.activeTranscodeSessions.has(current.sessionId) || !Number.isFinite(positionSeconds)) {
      return false;
    }
    const { sessionId, transport } = current;
    const path =
      `/transcode/${encodeURIComponent(sessionId)}/a/${trackIndex}/warm` +
      `?position=${positionSeconds.toFixed(3)}`;
    try {
      const response = await transport.fetch(path);
      if (response.status === 204) {
        return "ready";
      }
      // "Not ready in time" and "this proxy cannot prepare a track at all" are
      // different answers and were both reported as false, which then refused
      // the switch for the rest of the session. A 404 is the second: an older
      // proxy with no such route, or a stream whose audio is not published
      // separately. Then the switch should proceed the old way rather than be
      // forbidden.
      return response.status === 404 ? "unsupported" : "not-ready";
    } catch (error) {
      console.debug("[torrent-tv] preparing the audio track failed", error);
      return "unsupported";
    }
  }

  /**
   * Tell the proxy where the viewer seeked to.
   *
   * The proxy cannot work this out for itself. A single seek leaves ~25
   * concurrent segment requests outstanding across a wide span (measured
   * 2026-08-02), so "the segment the player asked for last" is noise — acting
   * on it caused nine encoder restarts in one minute and a ~70 s seek. The
   * position exists only here, in `video.currentTime` once the scrub ends.
   *
   * Same split as Jellyfin (`startTimeTicks`) and webtor (`?t=`): requests
   * fetch data, this states intent. Best-effort — a lost report only means the
   * encoder keeps producing where it already is.
   *
   * @param {number} positionSeconds - Absolute position on the source timeline.
   * @returns {Promise<void>}
   */
  async reportSeek(positionSeconds) {
    if (!Number.isFinite(positionSeconds) || positionSeconds < 0) {
      return;
    }
    const sessions = Array.from(this.activeTranscodeSessions.entries());
    for (const [sessionId, transport] of sessions) {
      const path = `/api/transcode-sessions/${encodeURIComponent(sessionId)}/seek`;
      const init = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Who moved. A session can serve several viewers, and the seeking
        // viewer's own position has to move with them or the proxy judges
        // their next request against where they were before the jump.
        body: JSON.stringify({ positionSeconds, consumerId: this.consumerId })
      };
      try {
        if (!transport.isHttp) {
          await transport.fetch(path, init);
        } else {
          await fetch(new URL(path.slice(1), ensureTrailingSlash(transport.baseUrl)), init);
        }
      } catch (error) {
        // Best-effort in the sense that nothing is retried — but not silent.
        // This is the ONE message that repositions the encoder (every other
        // request only fetches data), so a seek that never arrives leaves the
        // viewer waiting on segments nobody is producing, and the proxy's log
        // shows a perfectly healthy run at the old position. The two sides then
        // disagree about where the viewer is, with nothing to say why.
        // Which session, and whether it is the one on screen: the loop covers
        // every session still held, and a previous episode's session can be
        // among them until it is released.
        const onScreen = this.currentTranscodeSession?.sessionId === sessionId;
        console.warn(
          `[torrent-tv][seek] the proxy was not told about the seek to ${positionSeconds.toFixed(1)}s ` +
          `(session ${sessionId.slice(0, 8)}${onScreen ? ", on screen" : ", not on screen"}): ` +
          `${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  /**
   * Tell the proxy that a delivered fragment sits far from the edge of what is
   * buffered — the earliest evidence that a stream is coming apart.
   *
   * The player already detects this and has only ever written it to the
   * console. It is worth sending because only the PROXY can say what it means:
   * it knows which boundary the segment it produced actually holds, and whether
   * that is the one its number claims. Measured 2026-08-21, this fired four
   * times across half a minute — naming the gap in seconds — while the buffer
   * stood still, before hls.js gave up and jumped the picture forward.
   *
   * Best-effort and quiet: a report about a stall must not add to one. Sent
   * only for the session on screen, because a fragment of an episode nobody is
   * watching says nothing about anybody's playback.
   *
   * @param {{ sn: number, track?: string, fragStartSec: number, bufferEndSec: number, currentTimeSec: number }} report
   * @returns {Promise<void>}
   */
  async reportFragmentFar(report) {
    const sessionId = this.currentTranscodeSession?.sessionId;
    const transport = sessionId ? this.activeTranscodeSessions.get(sessionId) : null;
    if (!sessionId || !transport) {
      return;
    }
    const path = `/api/transcode-sessions/${encodeURIComponent(sessionId)}/fragment-far`;
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report)
    };
    try {
      if (!transport.isHttp) {
        await transport.fetch(path, init);
      } else {
        await fetch(new URL(path.slice(1), ensureTrailingSlash(transport.baseUrl)), init);
      }
    } catch {
      // silent-ok: this is a diagnostic about a stream already in trouble, and
      // nothing downstream depends on it arriving.
    }
  }

  abortPendingRequests() {
    this.abortController.abort();
    this.abortController = new AbortController();
  }

  /**
   * Keep telling the proxy that this viewer is still here, for as long as the
   * browser holds a session.
   *
   * The proxy disposes a transcode session after ten minutes with no request
   * naming it, and that is correct — but it was the ONLY signal of presence,
   * while the browser asserts presence once, at creation, and never again. The
   * two agree by accident during playback, because fetching segments keeps the
   * timer alive; they part the moment the viewer PAUSES. Measured 2026-08-06:
   * after a pause the browser sent nothing at all for thirteen minutes — 39,
   * 17, 11, 4, 5 requests in the last five active minutes, then zero — the
   * session was disposed on schedule, and every request after the resume
   * answered 404 while the player sat frozen on a spinner. Reproducible at
   * will: pause and wait ten minutes.
   *
   * So presence is re-asserted rather than assumed. The ping is the progress
   * endpoint, which the proxy already treats as an access, at an interval far
   * below its timeout; it costs a 44-byte response. It stops on its own when
   * the last session is released, so a viewer who really has gone still frees
   * the session — by the proxy's timer, exactly as before.
   *
   * @returns {void}
   */
  #keepSessionsAlive() {
    if (this.keepAliveTimer) {
      return;
    }
    this.keepAliveTimer = setInterval(() => {
      if (this.activeTranscodeSessions.size === 0) {
        clearInterval(this.keepAliveTimer);
        this.keepAliveTimer = null;
        return;
      }
      for (const [sessionId, transport] of this.activeTranscodeSessions) {
        transport
          .fetch(`/api/transcode-sessions/${encodeURIComponent(sessionId)}/progress`)
          .then(async (response) => {
            // The answer was being thrown away. It is the only reading of the
            // proxy's state during steady playback — everything else polls only
            // while the picture is stopped — and it carries the height the
            // proxy is producing, which is what tells the viewer what automatic
            // quality has settled on.
            if (response?.ok) {
              /** @type {object | null} */
              let detail = null;
              try {
                // ONLY the reading is inside, and the dispatch below is outside
                // on purpose: the quality menu and the estimate both listen for
                // this event, so a listener that throws would be reported here
                // as "the proxy's progress cannot be read" — a catch standing
                // for one condition while covering another, which is the shape
                // that cost release 2.9.124 its whole product.
                detail = await response.json();
              } catch (error) {
                // Said on the EDGE, not on every poll: this runs about every
                // one and a half seconds for as long as the picture moves, and
                // a line per poll would be the flood the rule forbids. What is
                // worth knowing is that the readings stopped being readable —
                // the quality menu and the viewer's estimate are built from
                // them, and both would simply freeze with no explanation.
                if (!this.#unreadableProgress.has(sessionId)) {
                  this.#unreadableProgress.add(sessionId);
                  console.warn(
                    `[torrent-tv][progress] the proxy's progress for session ${sessionId.slice(0, 8)} ` +
                    `cannot be read: ${error instanceof Error ? error.message : String(error)}`
                  );
                }
              }
              if (detail !== null) {
                document.dispatchEvent(new CustomEvent(SESSION_EVENTS.PROGRESS, { detail }));
                // Readable again: the next failure is a new episode and is
                // worth saying once more.
                this.#unreadableProgress.delete(sessionId);
                this.#pingFailing.delete(sessionId);
              }
              return;
            }
            // Any other refusal: not "this session is gone", so the poll goes
            // on — but a session answering 500 twice a minute for the rest of
            // the film left nothing at all in the log, and the branch that
            // abandons a reading must say what it decided from.
            if (response && response.status !== 404) {
              if (!this.#pingFailing.has(sessionId)) {
                this.#pingFailing.add(sessionId);
                console.warn(
                  `[torrent-tv][keepalive] the proxy answered ${response.status} for session ` +
                  `${sessionId.slice(0, 8)}; still polling`
                );
              }
              return;
            }
            // 404 is the proxy saying this session no longer exists — it was
            // disposed, or the proxy restarted. Nothing that polls it will ever
            // succeed again, so stop holding it and say so once; the player
            // rebuilds a session for the same file at the same position.
            if (response?.status !== 404 || !this.activeTranscodeSessions.has(sessionId)) {
              return;
            }
            this.activeTranscodeSessions.delete(sessionId);
            this.#forgetSessionComplaints(sessionId);
            console.debug(`[evt] ${nowHms()} transcode-session gone id=${sessionId.slice(0, 8)}`);
            document.dispatchEvent(new CustomEvent(SESSION_EVENTS.GONE, { detail: { sessionId } }));
          })
          .catch((error) => {
            // A single failure says nothing on its own — the transport may be
            // reconnecting — so it is said once per run of them, not every
            // thirty seconds. But it must be said: twenty of these in a row is
            // the session about to expire on the proxy, and the viewer meets
            // that as a spinner with nothing in the log between the last
            // segment and the first 404.
            if (!this.#pingFailing.has(sessionId)) {
              this.#pingFailing.add(sessionId);
              console.warn(
                `[torrent-tv][keepalive] the proxy is not hearing this session ` +
                `(${sessionId.slice(0, 8)}): ${error instanceof Error ? error.message : String(error)}`
              );
            }
          });
      }
    }, SESSION_KEEPALIVE_MS);
  }

  /**
   * Forget what has been complained about for a session that is over.
   *
   * Without it the sets grow for the life of the page — one entry per episode
   * of a season pack — and nothing owns them.
   *
   * @param {string} sessionId
   * @returns {void}
   */
  #forgetSessionComplaints(sessionId) {
    this.#unreadableProgress.delete(sessionId);
    this.#pingFailing.delete(sessionId);
  }

  releaseActiveTranscodeSessions(options = {}) {
    const preferBeacon = options?.preferBeacon === true;
    const reason = typeof options?.reason === "string" ? options.reason : "";
    // The viewer net reporter lives exactly as long as the session it feeds.
    stopNetReporter();
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    if (this.activeTranscodeSessions.size === 0) {
      return;
    }
    const sessions = Array.from(this.activeTranscodeSessions.entries());
    this.activeTranscodeSessions.clear();
    for (const [sessionId, transport] of sessions) {
      this.#forgetSessionComplaints(sessionId);
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
   * @returns {Promise<{ mode: "proxy-hls", offeredHeights: number[] | null }>}
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
    const { playlistUrl, variantHeight, offeredHeights, lookaheadSeconds, mediaPlaylistUrl } = await this.tryCreateTranscodeSession(
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
        audioTrackIndex,
        // Where the proxy must start encoding. Without it a resume told only
        // hls.js, which then asked for a segment the encoder had never been
        // told to make.
        startPositionSeconds:
          Number.isFinite(options.startPositionSeconds) && options.startPositionSeconds > 0
            ? options.startPositionSeconds
            : 0,
        segmentFormat: typeof options.segmentFormat === "string" ? options.segmentFormat : ""
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
      playlistUrl,
      variantHeight
    });
    // The variant to start on — the one the proxy is already encoding. Zero
    // when this stream has no variants, and then the player has one level and
    // nothing to pin.
    await playHls(videoElement, playlistUrl, {
      preferredHeight: variantHeight,
      // What the proxy holds ahead of the viewer. The player takes its forward
      // buffer ceiling from it rather than from a figure of its own.
      lookaheadSeconds,
      nativeManifestUrl: mediaPlaylistUrl
    });

    // Seeking is handled entirely server-side: the proxy serves a complete VOD
    // playlist (full duration, #EXT-X-ENDLIST) and produces segments on demand,
    // restarting ffmpeg at the requested position when the player seeks past
    // the encoded range.  No client-side session restart is required, which
    // also avoids playlist-swap glitches during scrubbing.

    return { mode: "proxy-hls", offeredHeights };
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
        // silent-ok: the body is optional detail on top of a status the caller
        // already acts on and already reports. A proxy that answers without
        // JSON has still answered.
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
      // The heights this proxy could serve this file at, per playback branch
      // (proxy 2.13.0+; null on older proxies, and then the browser keeps its
      // own ladder). Which branch applies is decided here, from the codecs in
      // this very plan, so the menu can be right from the moment the file is
      // opened rather than from the moment an encoder exists.
      offeredHeights: readOfferedHeights(payload?.offeredHeights),
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
   * @returns {Promise<{ playlistUrl: string, variantHeight: number, offeredHeights: number[] | null, lookaheadSeconds: number, mediaPlaylistUrl: string }>}
   *   The manifest to load — a master playlist when the session offers quality
   *   variants, its media playlist otherwise — the height of the variant the
   *   proxy is already encoding (0 when there are no variants), and the media
   *   playlist on its own, for a player that adapts by itself.
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
          // This browser takes its audio from the master playlist's rendition
          // group, so the picture is encoded without it and each track is
          // encoded once for the file rather than once per quality rung. The
          // proxy has to be told: publishing renditions AND muxing the same
          // audio would play it twice, and a browser that did not know about
          // them would get no sound at all.
          audioRenditions: true,
          consumerId: this.consumerId,
          fileName: this.#getFileLogName(fileIndex),
          startPositionSeconds: startPositionSeconds > 0 ? startPositionSeconds : undefined,
          audioTrackIndex:
            Number.isInteger(options.audioTrackIndex) && options.audioTrackIndex > 0
              ? options.audioTrackIndex
              : undefined,
          // Only sent when this browser needs a specific container to decode
          // what it asked to be copied; otherwise the proxy's own setting
          // decides. See #requiredSegmentFormat in loading.js.
          segmentFormat:
            typeof options.segmentFormat === "string" && options.segmentFormat.length > 0
              ? options.segmentFormat
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
        // silent-ok: the body is optional detail on top of a status the caller
        // already acts on and already reports. A proxy that answers without
        // JSON has still answered.
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
    // A master playlist when this session has quality variants to offer. Given
    // one, the player changes quality by fetching another variant and appending
    // it after what is already buffered — where a media playlist can only be
    // changed by building a new session, which is a cold start with the picture
    // gone. The proxy publishes a master only where the variants can be joined,
    // so its absence is the answer for this file and not a fallback.
    const masterPath = typeof payload?.masterPath === "string" ? payload.masterPath.trim() : "";
    const variantHeight = Number(payload?.variantHeight) || 0;
    // The heights this proxy will actually serve the file at. Sent whether or
    // not there is a master, because a stream without variants still changes
    // quality — by re-opening the session — and the browser used to compose
    // that list itself from the source height, which is a statement about the
    // FILE where the question is about the HOST.
    // Null, not empty, when the field is absent: that is an older proxy which
    // has not been asked what it can serve, and the browser must then fall back
    // to offering what it always did rather than to offering nothing.
    const offeredHeights = Array.isArray(payload?.offeredHeights)
      ? payload.offeredHeights
          .map((height) => Number(height))
          .filter((height) => Number.isFinite(height) && height > 0)
      : null;
    // How far ahead of the viewer the proxy lets its encoder run, in seconds of
    // playback. The player's forward buffer is sized from it, so the two sides
    // agree by construction. Zero from a proxy that does not state it, and the
    // player then keeps its own ceiling.
    const lookaheadSeconds = Number(payload?.lookaheadSeconds) || 0;
    const mediaPlaylistUrl = transport.url(playlistPath);
    const playlistUrl = masterPath ? transport.url(masterPath) : mediaPlaylistUrl;
    const progressPath = sessionId
      ? `/api/transcode-sessions/${encodeURIComponent(sessionId)}/progress`
      : "";
    const progressUrl = progressPath ? transport.url(progressPath) : "";

    // What the proxy says this session's output will carry. Announced so the
    // player can check what it ACTUALLY received against it: a track that never
    // arrives is otherwise noticed only by its absence, minutes later, as a
    // black picture with working sound (measured 2026-08-10 — sixty-five
    // seconds of audio with videoWidth=0 and not one frame decoded).
    const declaredTracks = payload?.tracks && typeof payload.tracks === "object"
      ? { video: payload.tracks.video === true, audio: payload.tracks.audio === true }
      : null;
    if (declaredTracks) {
      document.dispatchEvent(
        new CustomEvent(PLAYER_EVENTS.DECLARED_TRACKS, { detail: declaredTracks })
      );
    }

    if (sessionId) {
      this.activeTranscodeSessions.set(sessionId, transport);
      // The one on screen. The map can hold more than one — a previous file's
      // session lingers until it is released or its progress poll 404s — and
      // anything addressed to "the first entry" would then reach the episode
      // the viewer has just left.
      this.currentTranscodeSession = { sessionId, transport };
      this.#keepSessionsAlive();
      // [evt] TEMPORARY: timestamped session lifecycle for log correlation.
      console.debug(`[evt] ${nowHms()} transcode-session create id=${sessionId.slice(0, 8)} fileIndex=${fileIndex}`);
      // Viewer net reporter (adaptive bitrate): feed the proxy's link-deficit
      // downshift trigger with measured throughput + buffer while this
      // session is active. Stopped in releaseActiveTranscodeSessions.
      startNetReporter({
        transport,
        sessionId,
        // Who is reporting, and where they are. A copied picture is one session
        // shared by everyone watching it, so without these the proxy can only
        // act on whichever viewer reported last.
        consumerId: this.consumerId,
        getBufferedAheadSec: bufferedAheadSeconds,
        getPositionSeconds: playbackPositionSeconds
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

    // The MEDIA playlist, never the master. What is being waited for is a
    // playable segment list, and a master carries none — only pointers to the
    // variants. Waiting on one never finishes.
    await waitForHlsPlaylist(mediaPlaylistUrl, 15 * 60_000, {
      progressUrl,
      fetchFn,
      onProgress: onTranscodeProgress,
      signal: this.abortController.signal
    });
    return {
      playlistUrl,
      variantHeight: masterPath ? variantHeight : 0,
      offeredHeights,
      lookaheadSeconds,
      // The one-variant manifest, for a player that would adapt on its own.
      mediaPlaylistUrl
    };
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
 * The two rung lists a plan carries — one for a copied video, one for a
 * re-encoded one. Null when the proxy did not answer (older than 2.13.0), which
 * is a different thing from answering with nothing: the first leaves the
 * browser's own ladder in place, the second means there is nothing to offer.
 *
 * @param {unknown} value
 * @returns {{ copy: number[], transcode: number[] } | null}
 */
function readOfferedHeights(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const heights = (list) =>
    Array.isArray(list)
      ? list.map((height) => Number(height)).filter((height) => Number.isFinite(height) && height > 0)
      : [];
  return { copy: heights(value.copy), transcode: heights(value.transcode) };
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
        // A master playlist has neither of those and never will: it lists
        // variants, not segments. Waiting on one runs to the fifteen-minute
        // timeout behind a loading screen that never ends — which is exactly
        // what shipping the master did on 2026-08-11, on every session that
        // re-encodes video. Say so rather than wait: whoever passed it here
        // meant the media playlist.
        if (body.includes("#EXT-X-STREAM-INF")) {
          console.warn("[torrent-tv] waited on a master playlist; it lists variants, not segments");
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
          // silent-ok: the body is optional detail on top of a status that is
          // reported and raised immediately below.
        }
        const suffix = details ? `: ${details}` : "";
        // The wait ENDS here, so the line says that rather than "still
        // waiting": a 500 on this route means the session is in its failed
        // state, and nothing a further poll does moves it out — the way back is
        // a new session, which is the caller's to make.
        console.warn(
          `[torrent-tv] the proxy refused the playlist (${response.status})${suffix}; giving up the wait`
        );
        // Thrown for the caller, and marked so the catch below can tell it from
        // the transport failures that catch is for. Unmarked, it was caught by
        // its own handler and the wait simply continued: measured by reading,
        // a session stuck in "failed" answered 500 every three seconds for
        // fifteen minutes without a word, and ended as "timed out waiting for
        // generated HLS playlist" — a message that names none of it.
        const refusal = new Error(`Transcode playlist request failed (${response.status})${suffix}`);
        refusal.isProxyRefusal = true;
        // Retryable, and it must say so: the caller passes `canRetry` straight
        // from this flag to the error screen, and without it the viewer is left
        // on a screen with no way back. The commonest way here is the torrent
        // ceasing to deliver — the run stops short, the session goes to its
        // failed state and answers 500 to everything — which is data starvation,
        // the archetypal keep-waiting case, and a Retry makes a new session
        // that starts the encoder again.
        refusal.canRetry = true;
        throw refusal;
      }
    } catch (error) {
      if (isAbortError(error) || error?.isProxyRefusal === true) {
        throw error;
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
      noteProgressUnreadable(progressUrl, `the proxy answered ${response.status}`);
      return null;
    }
    const payload = await response.json();
    if (!payload || typeof payload !== "object") {
      noteProgressUnreadable(progressUrl, "the answer was not an object");
      return null;
    }
    progressComplainedAbout.delete(progressUrl);
    return payload;
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    noteProgressUnreadable(progressUrl, error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * Which progress endpoints have already been complained about. Named for what
 * it HOLDS: an earlier version called it `progressReadable` while holding the
 * opposite, and a latch whose name inverts its contents is one a later edit
 * reads backwards.
 *
 * This poll runs about every one and a half seconds for as long as the viewer
 * is waiting, so the complaint is made on the EDGE — the first failure after a
 * good reading — and never on every poll.
 *
 * @type {Set<string>}
 */
const progressComplainedAbout = new Set();

/** How many sessions' complaints are remembered at once. See the use below. */
const PROGRESS_COMPLAINTS_KEPT = 8;

/**
 * Say once that the progress readings have stopped arriving, and why.
 *
 * The readings are what the viewer's estimate and the quality menu are built
 * from. When they stop, both simply freeze; without this the log holds nothing
 * at all between a healthy session and a viewer looking at a figure that never
 * changes.
 *
 * @param {string} progressUrl
 * @param {string} reason
 * @returns {void}
 */
function noteProgressUnreadable(progressUrl, reason) {
  if (progressComplainedAbout.has(progressUrl)) {
    return;
  }
  // One entry per session that ever failed, and a session is never seen again
  // once it is over — so the set is bounded here rather than left to grow for
  // the life of the page. The oldest goes first: what it costs is one repeated
  // line about a session from many episodes ago, which is not a flood.
  if (progressComplainedAbout.size >= PROGRESS_COMPLAINTS_KEPT) {
    const [oldest] = progressComplainedAbout;
    progressComplainedAbout.delete(oldest);
  }
  progressComplainedAbout.add(progressUrl);
  // Named, because more than one session can be in flight and a line that
  // cannot be attributed to one of them is a line nobody can act on.
  console.warn(`[torrent-tv][progress] no reading from the proxy for ${describeProgressUrl(progressUrl)}: ${reason}`);
}

/**
 * The session a progress endpoint belongs to, for a log line.
 *
 * @param {string} progressUrl
 * @returns {string}
 */
function describeProgressUrl(progressUrl) {
  const match = /transcode-sessions\/([^/?#]+)/.exec(progressUrl);
  return match ? `session ${match[1].slice(0, 8)}` : progressUrl.slice(0, 80);
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

/**
 * Where the picture is, for the viewer net reporter. Looked up the same way
 * and for the same reason as `bufferedAheadSeconds` above.
 *
 * Null rather than zero when there is no element to read, because the proxy
 * places an audio run at the earliest position it is told and zero is a
 * position: reporting it for a viewer forty minutes in would send the run back
 * to the start of the film. The buffer above can answer zero safely — an
 * unreadable buffer really is no cushion — but a position cannot.
 *
 * @returns {number | null}
 */
function playbackPositionSeconds() {
  const video = document.querySelector("#player__video");
  if (!(video instanceof HTMLVideoElement)) {
    return null;
  }
  const at = video.currentTime;
  return Number.isFinite(at) && at >= 0 ? at : null;
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
