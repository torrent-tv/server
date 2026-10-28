/** Bytes and elapsed time from the full-load event through the parsed event. */

const TRACKS = ["video", "audio"];
const KINDS = ["init", "media"];
const SAMPLE_WINDOW_MS = 30_000;

function emptyValues() {
  return Object.fromEntries(TRACKS.map(track => [track, Object.fromEntries(KINDS.map(kind => [kind,
    { bytes: 0, elapsedMs: 0, operations: 0, samples: [] }]))]));
}

export class FragmentService {
  #values = emptyValues();

  reset() {
    this.#values = emptyValues();
  }

  record({ track, kind, bytes, elapsedMs, parseElapsedMs = null, bufferingElapsedMs = null,
    eventTimes = {}, bufferingCompletedAt = null, completedAt, fragmentId, fragmentSequence = null,
    partIndex = null, fragmentStartSeconds = null }) {
    if (!TRACKS.includes(track) || !KINDS.includes(kind) || !Number.isSafeInteger(bytes) || bytes <= 0 ||
        !Number.isFinite(elapsedMs) || elapsedMs <= 0 || !Number.isFinite(completedAt) || completedAt < 0) return false;
    const value = this.#values[track][kind];
    const nextBytes = value.bytes + bytes;
    const nextElapsedMs = value.elapsedMs + elapsedMs;
    const nextOperations = value.operations + 1;
    if (!Number.isSafeInteger(nextBytes) || !Number.isFinite(nextElapsedMs) || !Number.isSafeInteger(nextOperations)) {
      return false;
    }
    value.bytes = nextBytes;
    value.elapsedMs = nextElapsedMs;
    value.operations = nextOperations;
    value.samples.push({ bytes, elapsedMs, parseElapsedMs, bufferingElapsedMs, eventTimes: { ...eventTimes },
      bufferingCompletedAt, completedAt, fragmentId, fragmentSequence, partIndex, fragmentStartSeconds });
    const cutoff = completedAt - SAMPLE_WINDOW_MS;
    while (value.samples.length > 0 && value.samples[0].completedAt < cutoff) value.samples.shift();
    return true;
  }

  recordBuffering({ track, kind, fragmentId, start, end }) {
    if (!TRACKS.includes(track) || !KINDS.includes(kind) || typeof fragmentId !== "string" ||
        !Number.isFinite(start) || !Number.isFinite(end) || end < start) return false;
    const samples = this.#values[track][kind].samples;
    const sample = [...samples].reverse().find(value => value.fragmentId === fragmentId &&
      value.bufferingCompletedAt === null);
    if (!sample) return false;
    sample.bufferingElapsedMs = end - start;
    sample.bufferingCompletedAt = end;
    sample.eventTimes.bufferingStart = start;
    sample.eventTimes.bufferingEnd = end;
    return true;
  }

  snapshot(at = performance.now()) {
    return Object.fromEntries(TRACKS.map(track => [track, Object.fromEntries(KINDS.map(kind => {
      const value = this.#values[track][kind];
      return [kind, {
        bytes: value.bytes,
        elapsedMs: value.elapsedMs,
        operations: value.operations,
        samples: value.samples.filter(sample => sample.completedAt <= at &&
          sample.completedAt >= at - SAMPLE_WINDOW_MS).map(({ bytes, elapsedMs, completedAt, fragmentId,
            fragmentSequence, partIndex, fragmentStartSeconds, parseElapsedMs, bufferingElapsedMs,
            bufferingCompletedAt, eventTimes }) => ({
          bytes, elapsedMs, ageMs: Math.max(0, at - completedAt), fragmentId, fragmentStartSeconds,
          fragmentSequence, partIndex,
          parseElapsedMs, bufferingElapsedMs,
          bufferingAgeMs: Number.isFinite(bufferingCompletedAt) ? Math.max(0, at - bufferingCompletedAt) : null,
          eventAgesMs: Object.fromEntries(["loadStart", "loadFirstByte", "loadEnd", "parseStart", "parseEnd",
            "bufferingStart", "bufferingEnd"].map(name => [name,
            Number.isFinite(eventTimes[name]) && eventTimes[name] > 0 && eventTimes[name] <= at
              ? Math.max(0, at - eventTimes[name]) : null]))
        }))
      }];
    }))]));
  }
}

export const fragmentService = new FragmentService();

/** Observe each fragment's full-load-to-parsed event interval. */
export function observeHlsFragmentService(instance, Events, service = fragmentService,
  now = () => performance.now()) {
  if (!instance || !Events || !service) return;
  const pending = new Map();
  const trackOf = frag => frag?.type === "audio" ? "audio" :
    frag?.type === "main" || frag?.type === "video" ? "video" : null;
  const fragmentIdOf = (frag, part) => frag ? [frag.type ?? "", frag.cc ?? "", frag.level ?? "", frag.sn ?? "",
    Number.isFinite(frag.start) ? frag.start : "", part?.index ?? ""].join(":").slice(0, 128) : null;
  const onLoaded = (_event, data) => {
    const track = trackOf(data?.frag);
    const bytes = data?.payload?.byteLength;
    if (!track || !Number.isSafeInteger(bytes) || bytes <= 0) return;
    const id = fragmentIdOf(data.frag, data.part);
    const queue = pending.get(id) ?? [];
    const kind = data.frag.sn === "initSegment" ? "init" : "media";
    const stats = data.frag.stats;
    const eventTimes = {
      loadStart: stats?.loading?.start,
      loadFirstByte: stats?.loading?.first,
      loadEnd: stats?.loading?.end
    };
    queue.push({ track, kind, bytes, startedAt: now(), eventTimes, fragmentId: id,
      fragmentSequence: Number.isSafeInteger(data.frag.sn) ? data.frag.sn : null,
      partIndex: Number.isSafeInteger(data?.part?.index) ? data.part.index : null,
      fragmentStartSeconds: Number.isFinite(data.frag.start) ? data.frag.start : null });
    pending.set(id, queue);
  };
  const onParsed = (_event, data) => {
    const track = trackOf(data?.frag);
    const id = fragmentIdOf(data?.frag, data?.part);
    if (!track || !id) return;
    const queue = pending.get(id);
    const fragment = queue?.shift();
    if (!queue?.length) pending.delete(id);
    if (!fragment) return;
    const completedAt = now();
    const parsing = data.frag?.stats?.parsing;
    const eventTimes = { ...fragment.eventTimes,
      parseStart: Number.isFinite(parsing?.start) && parsing.start > 0 ? parsing.start : null,
      parseEnd: Number.isFinite(parsing?.end) && parsing.end > 0 ? parsing.end : null };
    const parseElapsedMs = Number.isFinite(parsing?.start) && parsing.start > 0 && Number.isFinite(parsing?.end) &&
      parsing.end >= parsing.start ? parsing.end - parsing.start : null;
    service.record({ ...fragment, elapsedMs: completedAt - fragment.startedAt, parseElapsedMs,
      bufferingElapsedMs: null, eventTimes, bufferingCompletedAt: null, completedAt });
  };
  const onBuffered = (_event, data) => {
    const frag = data?.frag;
    const track = trackOf(frag);
    const id = fragmentIdOf(frag, data?.part);
    if (!track || !id) return;
    const buffering = data.frag?.stats?.buffering;
    if (Number.isFinite(buffering?.start) && buffering.start > 0 && Number.isFinite(buffering?.end) &&
        buffering.end >= buffering.start) {
      service.recordBuffering({ track, kind: frag.sn === "initSegment" ? "init" : "media", fragmentId: id,
        start: buffering.start, end: buffering.end });
    }
  };
  const cleanup = () => {
    pending.clear();
    instance.off?.(Events.FRAG_LOADED, onLoaded);
    instance.off?.(Events.FRAG_PARSED, onParsed);
    instance.off?.(Events.FRAG_BUFFERED, onBuffered);
    instance.off?.(Events.DESTROYING, cleanup);
  };
  if (Events.FRAG_LOADED) instance.on(Events.FRAG_LOADED, onLoaded);
  if (Events.FRAG_PARSED) instance.on(Events.FRAG_PARSED, onParsed);
  if (Events.FRAG_BUFFERED) instance.on(Events.FRAG_BUFFERED, onBuffered);
  if (Events.DESTROYING) instance.on(Events.DESTROYING, cleanup);
}
