/** Actual operation boundaries, enabled only by ?waitTrace=1 (#ttv-185). */
export class WaitTrace {
  constructor({ enabled = false, now = () => performance.now(), id = () => crypto.randomUUID(),
    emit = value => {
      if (typeof window === "object" && typeof window.__ttvClientLogger?.recordWaitTrace === "function") {
        window.__ttvClientLogger.recordWaitTrace(value);
      } else {
        console.debug(`[wait-trace] ${JSON.stringify(value)}`);
      }
    } } = {}) {
    Object.assign(this, { enabled, now, id, emit, current: null, sequence: 0, hlsSequence: 0, manifestParseEnds: new Map() });
  }

  begin(kind, startedAt = this.now()) {
    if (!this.enabled) return;
    if (this.current) this.finish("superseded");
    this.current = { wait: this.id(), attempt: 0, startedAt, fileIndex: null };
    this.emitMs = 0;
    this.event("action", { kind, process: "A0", phase: "begin", startedAt });
  }

  attempt(fileIndex, startedAt, originalOpen) {
    if (!this.enabled) return;
    if (!this.current || (this.current.fileIndex === null && !originalOpen) ||
      (this.current.fileIndex !== null && this.current.fileIndex !== fileIndex)) this.begin("file-choice", startedAt);
    this.current.fileIndex = fileIndex;
    this.current.attempt++;
    this.event("attempt", { fileIndex });
  }

  event(name, fields = {}, context = this.current) {
    if (!context) return;
    const before = this.now();
    this.emit({ version: 1, clock: "browser", wait: context.wait, attempt: context.attempt,
      at: before, event: name, ...fields });
    this.emitMs = (this.emitMs ?? 0) + this.now() - before;
  }

  open(name, fields = {}) {
    const context = this.current && { ...this.current };
    if (!context) return () => {};
    const operation = `b${++this.sequence}`;
    const start = this.now();
    const process = fields.process ?? name.match(/^[A-Z][0-9]+(?:\.(?:[0-9]+[a-z]?|[va]))?/i)?.[0] ?? null;
    this.event("begin", { operation, name, process, phase: "begin", ...fields }, context);
    let ended = false;
    const end = (result = {}) => {
      if (ended) return;
      ended = true;
      const actualEnd = this.now();
      const endedAt = Number.isFinite(result.endedAt) ? result.endedAt : actualEnd;
      this.event("end", { operation, name, process, phase: "end", start, endedAt,
        duration: endedAt - start, ...result }, context);
    };
    end.context = context;
    end.operation = operation;
    return end;
  }

  span(name, { process, startedAt, endedAt = this.now(), ...fields }) {
    if (!this.enabled || !Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return;
    const context = this.current && { ...this.current };
    if (!context) return;
    const operation = `b${++this.sequence}`;
    this.event("begin", { operation, name, process, phase: "begin", at: startedAt, ...fields }, context);
    this.event("end", { operation, name, process, phase: "end", at: endedAt, startedAt,
      endedAt, duration: endedAt - startedAt, outcome: "ok", ...fields }, context);
  }

  run(name, work, fields = {}) {
    if (!this.current) return work();
    const end = this.open(name, fields);
    try {
      const result = work();
      if (result?.then) return result.then(value => { end({ outcome: "ok" }); return value; },
        error => { end({ outcome: error?.name === "AbortError" ? "cancelled" : "error", error: String(error?.message ?? error) }); throw error; });
      end({ outcome: "ok" });
      return result;
    } catch (error) {
      end({ outcome: "error", error: String(error?.message ?? error) });
      throw error;
    }
  }

  trackManifestParse(end, hlsInstance) {
    if (!this.enabled || typeof end !== "function") return;
    const pending = this.manifestParseEnds.get(hlsInstance) ?? [];
    pending.push(end);
    this.manifestParseEnds.set(hlsInstance, pending);
  }

  finishManifestParse(result = {}, hlsInstance) {
    const pending = this.manifestParseEnds.get(hlsInstance);
    pending?.shift()?.({ ...result, hlsInstance });
    if (!pending?.length) this.manifestParseEnds.delete(hlsInstance);
  }

  failManifestParses(result = {}, hlsInstance = null) {
    const entries = hlsInstance === null
      ? this.manifestParseEnds.entries()
      : [[hlsInstance, this.manifestParseEnds.get(hlsInstance) ?? []]];
    for (const [instance, pending] of entries) {
      for (const end of pending) end({ ...result, hlsInstance: instance });
      this.manifestParseEnds.delete(instance);
    }
  }

  request(path, method, processOverride = null) {
    const process = processOverride ?? processForRequest(path);
    const end = this.open("proxy-response", { path, method, process });
    return { end, headers: end.context ? { "x-ttv-wait-trace": end.context.wait,
      "x-ttv-wait-attempt": String(end.context.attempt), "x-ttv-wait-operation": end.operation,
      "x-ttv-wait-process": process ?? "" } : {} };
  }

  async fetch(path, options = {}, process = null) {
    const request = this.request(path, options.method ?? "GET", process);
    try {
      const headers = new Headers(options.headers ?? {});
      for (const [name, value] of Object.entries(request.headers)) headers.set(name, value);
      const response = await fetch(path, { ...options, headers });
      request.end({ outcome: "response", status: response.status, bodyComplete: false });
      return response;
    } catch (error) {
      request.end({ outcome: error?.name === "AbortError" ? "cancelled" : "error",
        error: String(error?.message ?? error) });
      throw error;
    }
  }

  finish(outcome, fields = {}) {
    if (!this.current) return;
    this.failManifestParses({ outcome: outcome === "advancing-with-decoded-audio"
      ? "active-at-wait-end" : outcome, reason: "wait-ended" });
    const firstAdvancingFrameElapsedMs = Number.isFinite(fields.firstAdvancingFrameAt)
      ? fields.firstAdvancingFrameAt - this.current.startedAt : null;
    this.event("outcome", { outcome, process: "A0", phase: "end", startedAt: this.current.startedAt,
      elapsed: this.now() - this.current.startedAt, emitMs: this.emitMs,
      ...(firstAdvancingFrameElapsedMs === null ? {} : { firstAdvancingFrameElapsedMs }), ...fields });
    this.current = null;
  }
}

export const waitTrace = new WaitTrace({ enabled: typeof location !== "undefined" &&
  new URLSearchParams(location.search).get("waitTrace") === "1" });

if (waitTrace.enabled && typeof PerformanceObserver === "function") {
  try {
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        waitTrace.event("R6.long-task", { process: "R6", phase: "event", startedAt: entry.startTime,
          durationMs: entry.duration, taskName: entry.name });
      }
    });
    observer.observe({ type: "longtask", buffered: true });
  } catch {
    // silent-ok: this browser does not support long-task entries.
  }
}

/** hls.js events are observations, not inferred durations of decoding or append. */
export function observeHlsWait(instance, Events) {
  if (!waitTrace.enabled) return;
  const appends = new Map();
  const remuxes = new Map();
  const codecReadyAt = new Map();
  const hlsInstance = `hls-${++waitTrace.hlsSequence}`;
  for (const name of ["DESTROYING", "MANIFEST_LOADING", "MANIFEST_LOADED", "MANIFEST_PARSED", "LEVEL_LOADING", "LEVEL_LOADED",
    "AUDIO_TRACK_LOADING", "AUDIO_TRACK_LOADED", "FRAG_LOADING", "FRAG_LOADED",
    "FRAG_PARSING_INIT_SEGMENT", "FRAG_PARSED", "BUFFER_CODECS", "BUFFER_CREATED", "BUFFER_APPENDING", "BUFFER_APPENDED", "FRAG_BUFFERED", "ERROR"]) {
    if (!Events[name]) continue;
    instance.on(Events[name], (_event, data) => {
      if (name === "MANIFEST_PARSED") waitTrace.finishManifestParse({ outcome: "parsed" }, hlsInstance);
      const type = data?.id ?? data?.type ?? data?.frag?.type ?? "main";
      const stream = type === "audio" ? "B8.a" : "B8.v";
      const track = trackForHlsType(type, data?.parent);
      if (name === "MANIFEST_LOADED") waitTrace.trackManifestParse(waitTrace.open("B5.manifest-parse", {
        process: "B5", url: data?.url ?? null, hlsInstance
      }), hlsInstance);
      if (name === "FRAG_PARSING_INIT_SEGMENT") {
        const key = `${type}:${data?.frag?.sn ?? "unknown"}`;
        const pending = remuxes.get(key) ?? [];
        pending.push(waitTrace.open(stream, { process: stream, stream: type,
          segment: data?.frag?.sn, level: data?.frag?.level, hlsInstance }));
        remuxes.set(key, pending);
      }
      if (name === "FRAG_PARSED") {
        const key = `${type}:${data?.frag?.sn ?? "unknown"}`;
        const pending = remuxes.get(key);
        pending?.shift()?.({ outcome: "fragment-parsed", hlsInstance });
        if (!pending?.length) remuxes.delete(key);
      }
      if (name === "BUFFER_CODECS") {
        const tracks = ["video", "audio", "audiovideo"].filter(track => data?.[track]);
        const codecStream = data?.frag?.type ?? (tracks.includes("video") || tracks.includes("audiovideo")
          ? "main" : tracks.includes("audio") ? "audio" : type);
        const at = waitTrace.now();
        for (const codecTrack of tracks) codecReadyAt.set(codecTrack, at);
        waitTrace.event(name, { process: "B8", type: codecStream, tracks, segment: data?.frag?.sn });
      }
      if (name === "BUFFER_CREATED") {
        const tracks = data?.tracks ? Object.keys(data.tracks) : [];
        const readyTimes = tracks.map(track => codecReadyAt.get(track));
        const startedAt = readyTimes.length && readyTimes.every(Number.isFinite) ? Math.max(...readyTimes) : null;
        const endedAt = waitTrace.now();
        if (startedAt !== null) waitTrace.span("B9.source-buffers", { process: "B9", startedAt,
          endedAt, tracks, outcome: "created" });
        waitTrace.event(name, { process: "B9", phase: "event", tracks, outcome: "created" });
      }
      if (name === "BUFFER_APPENDING") {
        const isInit = data?.frag?.sn === "initSegment";
        const appendProcess = isInit
          ? (track === "audio" ? "B10.a" : "B10.v")
          : (track === "audio" ? "B12.a" : "B12.v");
        const pending = appends.get(track) ?? [];
        pending.push(waitTrace.open(appendProcess, { stream: track, parent: data?.parent ?? null,
          segment: data?.frag?.sn }));
        appends.set(track, pending);
      }
      if (name === "BUFFER_APPENDED") {
        const pending = appends.get(track);
        pending?.shift()?.({ outcome: "updateend-or-hls-ack", parent: data?.parent ?? null });
        if (!pending?.length) appends.delete(track);
      }
      if (name === "ERROR") {
        const error = { outcome: "error", details: data?.details ?? null, fatal: data?.fatal ?? false };
        if (data?.fatal) {
          waitTrace.failManifestParses(error, hlsInstance);
          for (const pending of remuxes.values()) for (const end of pending) end(error);
          remuxes.clear();
          for (const pending of appends.values()) for (const end of pending) end(error);
          appends.clear();
        }
      }
      if (name === "DESTROYING") {
        const cancelled = { outcome: "cancelled", reason: "hls-destroyed" };
        waitTrace.failManifestParses(cancelled, hlsInstance);
        for (const pending of remuxes.values()) for (const end of pending) end(cancelled);
        remuxes.clear();
        for (const pending of appends.values()) for (const end of pending) end(cancelled);
        appends.clear();
      }
      waitTrace.event(name, { process: name === "MANIFEST_PARSED" ? "B5" : undefined, phase: "event", hlsInstance,
        type, segment: data?.frag?.sn, level: data?.frag?.level,
        tracks: data?.tracks ? Object.keys(data.tracks) : undefined, details: data?.details,
        parent: data?.parent ?? undefined });
    });
  }
}

function trackForHlsType(type, parent = null) {
  return type === "audio" || parent === "audio" ? "audio" : "video";
}

function processForRequest(path) {
  if (path === "/api/proxy-clients/choose") return "A2.1";
  if (path === "/api/sources") return "A4";
  if (/\/api\/sources\/[^/]+\/files(?:\?|$)/.test(path)) return "A6";
  if (/\/api\/sources\/[^/]+\/stats(?:\?|$)/.test(path)) return "A5";
  if (path === "/api/playback-plan") return "A12";
  if (/\/api\/transcode-sessions(?:\?|$)/.test(path)) return "B1";
  if (/\/api\/transcode-sessions\/[^/]+\/net-report(?:\?|$)/.test(path)) return "B2";
  if (/\/api\/transcode-sessions\/[^/]+\/seek(?:\?|$)/.test(path)) return "B4";
  if (/\/transcode\/.*\.m3u8(?:\?|$)/.test(path)) return "B3";
  if (/\/transcode\/.*(?:init|\.mp4)(?:\?|$)/.test(path)) return "B6";
  if (/\/transcode\/.*(?:\.m4s|\.ts)(?:\?|$)/.test(path)) return "B7";
  if (/\/api\/session-progress(?:\?|$)/.test(path)) return "P14";
  if (/\/api\/sources\/[^/]+\/(?:fingerprint|container-metadata|audio|cover)(?:\?|$)/.test(path)) return "A13";
  if (/\/api\/sources\/[^/]+\/subtitles(?:\?|$)/.test(path)) return "A14";
  return null;
}

/** Confirm media-time advance separately from the existing single-frame record. */
export function observeVideoWait(video, readAudio) {
  if (!waitTrace.enabled || !video.requestVideoFrameCallback) return;
  let callback = null;
  let endPresentation = null;
  let previous = null;
  let wait = null;
  let attempt = null;
  const frame = (at, metadata) => {
    callback = null;
    const context = waitTrace.current;
    if (!context || wait !== context.wait || attempt !== context.attempt) return;
    let audio;
    try { audio = readAudio(metadata.mediaTime); }
    catch (error) {
      // silent-ok: finish emits observation-failed; this diagnostic must not interrupt playback.
      waitTrace.finish("observation-failed", { error: String(error?.message ?? error) });
      return;
    }
    const current = { at, mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames,
      expectedDisplayTime: metadata.expectedDisplayTime, presentationTime: metadata.presentationTime,
      audioDecodedBytes: Number.isFinite(video.webkitAudioDecodedByteCount) ? video.webkitAudioDecodedByteCount : null,
      ...audio };
    if (!previous) waitTrace.event("first-frame", { process: "C6", phase: "event", ...current });
    if (!video.paused && previous && metadata.mediaTime > previous.mediaTime &&
      current.audioRequired && current.audioDecodedBytes === null) {
      waitTrace.finish("advancing-audio-output-unverified", current);
      endPresentation?.({ outcome: "audio-output-unverified" });
      return;
    }
    if (!video.paused && previous && metadata.mediaTime > previous.mediaTime &&
      metadata.presentedFrames > previous.presentedFrames && current.audioBuffered &&
      previous.audioBuffered && (!current.audioRequired ||
        (current.audioDecodedBytes > 0 && previous.audioDecodedBytes > 0))) {
      endPresentation?.({ outcome: "advancing-with-decoded-audio", endedAt: previous.at, confirmedAt: at });
      waitTrace.event("C7.audio-ready", { process: "C7", phase: "event", at: previous.at,
        confirmedAt: at, audioRequired: current.audioRequired, audioBuffered: current.audioBuffered,
        audioDecodedBytes: current.audioDecodedBytes });
      waitTrace.finish("advancing-with-decoded-audio", { firstAdvancingFrameAt: previous.at,
        confirmedAt: at, frameInterval: at - previous.at, ...current });
      return;
    }
    previous = current;
    callback = video.requestVideoFrameCallback(frame);
  };
  for (const name of ["loadedmetadata", "loadeddata", "canplay", "play", "playing", "pause", "seeking", "seeked", "waiting", "stalled", "error"]) {
    video.addEventListener(name, () => {
      waitTrace.event(`media-${name}`, { process: name === "play" || name === "playing" ? "C5" : undefined,
        phase: name === "play" ? "begin" : name === "playing" ? "end" : "event", mediaTime: video.currentTime,
        readyState: video.readyState, paused: video.paused });
      if (name === "playing" && waitTrace.current?.attempt > 0) {
        if (callback !== null) video.cancelVideoFrameCallback?.(callback);
        previous = null;
        wait = waitTrace.current.wait;
        attempt = waitTrace.current.attempt;
        endPresentation = waitTrace.open("C6.presentation");
        callback = video.requestVideoFrameCallback(frame);
      }
    });
  }
}
