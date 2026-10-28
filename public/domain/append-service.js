/** Bytes and elapsed request-to-acknowledgement time for browser buffer appends. */

const TRACKS = ["video", "audio"];
const KINDS = ["init", "media"];
const SAMPLE_WINDOW_MS = 30_000;

function emptyTotals() {
  return Object.fromEntries(TRACKS.map(track => [track,
    Object.fromEntries(KINDS.map(kind => [kind, { bytes: 0, elapsedMs: 0, operations: 0 }]))]));
}

export class AppendService {
  #totals = emptyTotals();
  #samples = emptySamples();

  reset() {
    this.#totals = emptyTotals();
    this.#samples = emptySamples();
  }

  record({ track, kind, bytes, elapsedMs, completedAt, fragmentId = null, fragmentSequence = null,
    partIndex = null, fragmentStartSeconds = null }) {
    if (!TRACKS.includes(track) || !KINDS.includes(kind) || !Number.isSafeInteger(bytes) || bytes <= 0 ||
        !Number.isFinite(elapsedMs) || elapsedMs <= 0 || !Number.isFinite(completedAt) || completedAt < 0) return false;
    const total = this.#totals[track][kind];
    const nextBytes = total.bytes + bytes;
    const nextElapsedMs = total.elapsedMs + elapsedMs;
    const nextOperations = total.operations + 1;
    if (!Number.isSafeInteger(nextBytes) || !Number.isFinite(nextElapsedMs) || !Number.isSafeInteger(nextOperations)) {
      return false;
    }
    total.bytes = nextBytes;
    total.elapsedMs = nextElapsedMs;
    total.operations = nextOperations;
    const samples = this.#samples[track][kind];
    samples.push({ bytes, elapsedMs, completedAt, fragmentId, fragmentSequence, partIndex, fragmentStartSeconds });
    const cutoff = completedAt - SAMPLE_WINDOW_MS;
    while (samples.length > 0 && samples[0].completedAt < cutoff) samples.shift();
    return true;
  }

  snapshot(at = performance.now()) {
    return Object.fromEntries(TRACKS.map(track => [track, Object.fromEntries(KINDS.map(kind => {
      const totals = this.#totals[track][kind];
      const samples = this.#samples[track][kind]
        .filter(sample => sample.completedAt >= at - SAMPLE_WINDOW_MS && sample.completedAt <= at)
        .map(({ bytes, elapsedMs, completedAt, fragmentId, fragmentSequence, partIndex, fragmentStartSeconds }) => ({
          bytes, elapsedMs, ageMs: Math.max(0, at - completedAt), fragmentId, fragmentSequence, partIndex,
          fragmentStartSeconds }));
      return [kind, { ...totals, samples }];
    }))]));
  }
}

function emptySamples() {
  return Object.fromEntries(TRACKS.map(track => [track,
    Object.fromEntries(KINDS.map(kind => [kind, []]))]));
}

export const appendService = new AppendService();

/** Observe actual append work and its updateend acknowledgement for one HLS instance. */
export function observeHlsAppendService(instance, Events, service = appendService,
  now = () => performance.now()) {
  if (!instance || !Events || !service) return;
  const pending = new Map();
  const initSegments = new WeakSet();
  const trackOf = data => {
    const values = [data?.type, data?.id, data?.frag?.type, data?.parent];
    if (values.includes("audio")) return "audio";
    if (values.some(value => value === "main" || value === "video")) return "video";
    return null;
  };
  const onAppending = (_event, data) => {
    const track = trackOf(data);
    if (!track) return;
    const kind = initSegments.has(data?.data) ? "init" : "media";
    const bytes = data?.data?.byteLength ?? data?.data?.length;
    const queue = pending.get(track) ?? [];
    const frag = data?.frag;
    const fragmentId = frag ? [data?.parent ?? "", frag.cc ?? "", frag.level ?? "", frag.sn ?? "",
      Number.isFinite(frag.start) ? frag.start : "", data?.part?.index ?? ""].join(":").slice(0, 128) : null;
    queue.push({ track, kind, bytes, fragmentId,
      fragmentSequence: Number.isSafeInteger(frag?.sn) ? frag.sn : null,
      partIndex: Number.isSafeInteger(data?.part?.index) ? data.part.index : null,
      fragmentStartSeconds: Number.isFinite(frag?.start) ? frag.start : null, startedAt: now() });
    pending.set(track, queue);
  };
  const onCodecs = (_event, data) => {
    for (const track of Object.values(data?.tracks ?? {})) {
      if (track?.initSegment && typeof track.initSegment === "object") initSegments.add(track.initSegment);
    }
  };
  const onAppended = (_event, data) => {
    const track = trackOf(data);
    if (!track) return;
    const queue = pending.get(track);
    const append = queue?.shift();
    if (!queue?.length) pending.delete(track);
    const completedAt = now();
    if (append) service.record({ ...append, elapsedMs: completedAt - append.startedAt, completedAt });
  };
  const cleanup = () => {
    pending.clear();
    instance.off?.(Events.BUFFER_CODECS, onCodecs);
    instance.off?.(Events.BUFFER_APPENDING, onAppending);
    instance.off?.(Events.BUFFER_APPENDED, onAppended);
    instance.off?.(Events.DESTROYING, cleanup);
  };
  if (Events.BUFFER_CODECS) instance.on(Events.BUFFER_CODECS, onCodecs);
  if (Events.BUFFER_APPENDING) instance.on(Events.BUFFER_APPENDING, onAppending);
  if (Events.BUFFER_APPENDED) instance.on(Events.BUFFER_APPENDED, onAppended);
  if (Events.DESTROYING) instance.on(Events.DESTROYING, cleanup);
}
