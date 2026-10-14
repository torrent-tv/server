/**
 * @file How long the page's own calls take, set against the long frames the
 * browser reports (torrent-tv/meta#178).
 *
 * Field r26: with the buffer full, the picture moved 0.74 s in 2.4 s while one
 * long frame named the `timeupdate` handler that writes the address (1093 ms)
 * and the next one the network report's `send` (351 ms). Neither path costs a
 * second by itself on paper, and a handler's duration is not proof that it
 * spent the processor all that time. So each part of those calls records when
 * it began and ended, and a long frame is matched to the calls inside its own
 * interval. Counters read when the browser delivers a frame's record are NOT
 * that frame's: the record arrives in a later task (Performance Timeline,
 * "queue the PerformanceObserver task"), so the matching is by time.
 *
 * Once a minute the totals per part and the long frames are said as well,
 * whether or not any frame was long.
 */

/** Spans kept for matching, by part. @type {Array<{ name: string, start: number, end: number }>} */
const spans = [];
/** Per part, this minute: count, sum and largest, in milliseconds. @type {Map<string, { count: number, sum: number, max: number }>} */
const totals = new Map();
const frames = { count: 0, sum: 0, max: 0, blocking: 0 };
let since = 0;
let say = null;

/**
 * A span is kept until no frame record can still name it. Records of a frame
 * are delivered shortly after the frame ends; a span older than the newest
 * frame record cannot be in a later one. Without any long frame the list is
 * cut by age, which only bounds its memory and decides nothing measured.
 */
const KEEP_MS = 30_000;

/**
 * Time one part of a call.
 *
 * @template T
 * @param {string} name
 * @param {() => T} work
 * @returns {T}
 */
export function timed(name, work) {
  const start = performance.now();
  try {
    return work();
  } finally {
    const end = performance.now();
    spans.push({ name, start, end });
    const total = totals.get(name) ?? { count: 0, sum: 0, max: 0 };
    total.count += 1;
    total.sum += end - start;
    total.max = Math.max(total.max, end - start);
    totals.set(name, total);
    prune(end - KEEP_MS);
    report(end);
  }
}

/**
 * Start matching long frames to the timed calls.
 *
 * @param {(line: string) => void} log - Where the lines go (the page's log).
 * @param {typeof PerformanceObserver | undefined} [Observer]
 * @returns {() => void} Stops observing.
 */
export function startPageTimings(log, Observer = globalThis.PerformanceObserver) {
  say = log;
  since = performance.now();
  totals.clear();
  spans.length = 0;
  Object.assign(frames, { count: 0, sum: 0, max: 0, blocking: 0 });
  if (typeof Observer !== "function" || !Observer.supportedEntryTypes?.includes?.("long-animation-frame")) {
    log("[page-timings] long-animation-frame is not reported by this browser; only the call totals are said");
    return () => { say = null; };
  }
  const observer = new Observer((list) => {
    for (const entry of list.getEntries()) noteFrame(entry);
  });
  observer.observe({ type: "long-animation-frame", buffered: false });
  return () => {
    observer.disconnect();
    say = null;
  };
}

/**
 * One long frame: its interval, what the browser names in it, and the timed
 * calls that ran inside it.
 *
 * @param {{ startTime: number, duration: number, blockingDuration?: number,
 *   scripts?: Array<{ duration: number, sourceFunctionName?: string, sourceURL?: string, invoker?: string }> }} entry
 */
export function noteFrame(entry) {
  const start = entry.startTime;
  const end = entry.startTime + entry.duration;
  frames.count += 1;
  frames.sum += entry.duration;
  frames.max = Math.max(frames.max, entry.duration);
  frames.blocking += Number(entry.blockingDuration) || 0;
  const inside = spans.filter(span => span.end > start && span.start < end);
  const scripts = (entry.scripts ?? []).map(script =>
    `${script.invoker ?? "?"}:${script.sourceFunctionName || "(anonymous)"}@${String(script.sourceURL ?? "").split("/").pop()} ${Math.round(script.duration)}ms`);
  say?.(`[page-timings] long frame ${Math.round(entry.duration)}ms (blocking ${Math.round(Number(entry.blockingDuration) || 0)}ms) ` +
    `at ${Math.round(start)}ms; scripts [${scripts.join(", ")}]; timed calls inside ` +
    `[${inside.map(span => `${span.name} ${Math.round(span.end - span.start)}ms`).join(", ")}]`);
  prune(start);
  report(end);
}

/** Drop the spans that ended before `before`. */
function prune(before) {
  while (spans.length > 0 && spans[0].end < before) spans.shift();
}

/** The minute's totals, said once a minute. */
function report(now) {
  if (!say || now - since < 60_000) return;
  const parts = [...totals].map(([name, { count, sum, max }]) =>
    `${name} ${count}× ${Math.round(sum)}ms max ${Math.round(max)}ms`).join(", ");
  say(`[page-timings] in ${((now - since) / 1000).toFixed(1)}s: ${parts || "no timed call"}; ` +
    `long frames ${frames.count}, ${Math.round(frames.sum)}ms in all (blocking ${Math.round(frames.blocking)}ms), longest ${Math.round(frames.max)}ms`);
  totals.clear();
  Object.assign(frames, { count: 0, sum: 0, max: 0, blocking: 0 });
  since = now;
}
