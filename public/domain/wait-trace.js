/** Actual operation boundaries, enabled only by ?waitTrace=1 (#ttv-185). */
export class WaitTrace {
  constructor({ enabled = false, now = () => performance.now(), id = () => crypto.randomUUID(),
    emit = value => console.debug(`[wait-trace] ${JSON.stringify(value)}`) } = {}) {
    Object.assign(this, { enabled, now, id, emit, current: null, sequence: 0 });
  }

  begin(kind, startedAt = this.now()) {
    if (!this.enabled) return;
    if (this.current) this.finish("superseded");
    this.current = { wait: this.id(), attempt: 0, startedAt, fileIndex: null };
    this.emitMs = 0;
    this.event("action", { kind, startedAt });
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
    this.event("begin", { operation, name, ...fields }, context);
    let ended = false;
    const end = (result = {}) => {
      if (ended) return;
      ended = true;
      this.event("end", { operation, name, start, duration: this.now() - start, ...result }, context);
    };
    end.context = context;
    end.operation = operation;
    return end;
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

  request(path, method) {
    const end = this.open("proxy-response", { path, method });
    return { end, headers: end.context ? { "x-ttv-wait-trace": end.context.wait,
      "x-ttv-wait-attempt": String(end.context.attempt), "x-ttv-wait-operation": end.operation } : {} };
  }

  finish(outcome, fields = {}) {
    if (!this.current) return;
    this.event("outcome", { outcome, startedAt: this.current.startedAt,
      elapsed: this.now() - this.current.startedAt, emitMs: this.emitMs, ...fields });
    this.current = null;
  }
}

export const waitTrace = new WaitTrace({ enabled: typeof location !== "undefined" &&
  new URLSearchParams(location.search).get("waitTrace") === "1" });

/** hls.js events are observations, not inferred durations of decoding or append. */
export function observeHlsWait(instance, Events) {
  if (!waitTrace.enabled) return;
  for (const name of ["MANIFEST_PARSED", "LEVEL_LOADED", "AUDIO_TRACK_LOADED", "FRAG_LOADING", "FRAG_LOADED",
    "FRAG_PARSING_INIT_SEGMENT", "BUFFER_CODECS", "BUFFER_CREATED", "BUFFER_APPENDING", "BUFFER_APPENDED", "FRAG_BUFFERED", "ERROR"]) {
    if (Events[name]) instance.on(Events[name], (_event, data) => waitTrace.event(name, {
      type: data?.type ?? data?.frag?.type, segment: data?.frag?.sn, level: data?.frag?.level,
      tracks: data?.tracks ? Object.keys(data.tracks) : undefined, details: data?.details
    }));
  }
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
    if (!previous) waitTrace.event("first-frame", current);
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
      endPresentation?.({ outcome: "advancing-with-decoded-audio" });
      waitTrace.finish("advancing-with-decoded-audio", { firstAdvancingFrameAt: previous.at,
        confirmedAt: at, frameInterval: at - previous.at, ...current });
      return;
    }
    previous = current;
    callback = video.requestVideoFrameCallback(frame);
  };
  for (const name of ["loadedmetadata", "loadeddata", "canplay", "play", "playing", "pause", "seeking", "seeked", "waiting", "stalled", "error"]) {
    video.addEventListener(name, () => {
      waitTrace.event(`media-${name}`, { mediaTime: video.currentTime, readyState: video.readyState, paused: video.paused });
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
