/**
 * @file Viewer net reporter (client side of adaptive bitrate).
 *
 * The HLS loader records how fast each media segment actually crossed the
 * data channel; this module keeps a short rolling window of those samples
 * and, while a transcode session is active, posts the MEDIAN link throughput
 * plus the player's buffered seconds to the proxy every ~10 s
 * (`POST /api/transcode-sessions/:id/net-report`). The proxy's realtime
 * budget uses the report as its viewer-link downshift trigger.
 *
 * Best-effort telemetry: send failures are ignored, sending stops with the
 * session. Median (not mean) so a single stalled fetch cannot crater the
 * estimate. Module-level singleton — one playback at a time.
 */

const SAMPLE_WINDOW_MS = 30_000;
const REPORT_INTERVAL_MS = 10_000;
// Ignore sub-50ms transfers: tiny/cached responses measure timer noise, not
// the link.
const MIN_SAMPLE_MS = 50;
const MIN_SAMPLES = 2;

/** @type {Array<{ mbps: number, at: number }>} */
let samples = [];
/** @type {{ timer: ReturnType<typeof setInterval> } | null} */
let active = null;

/**
 * Record one completed segment transfer (called by the HLS loader).
 *
 * @param {number} bytes
 * @param {number} ms
 * @returns {void}
 */
export function recordNetSample(bytes, ms) {
  if (!Number.isFinite(bytes) || bytes <= 0 || !Number.isFinite(ms) || ms < MIN_SAMPLE_MS) {
    return;
  }
  const now = Date.now();
  samples.push({ mbps: (bytes * 8) / (ms / 1000) / 1e6, at: now });
  if (samples.length > 64) {
    prune(now);
  }
}

/**
 * @param {number} now
 * @returns {void}
 */
function prune(now) {
  const cutoff = now - SAMPLE_WINDOW_MS;
  samples = samples.filter((s) => s.at >= cutoff);
}

/**
 * Median link throughput over the sample window, or null when there is not
 * enough recent material to estimate.
 *
 * @returns {number | null}
 */
function medianLinkMbps() {
  prune(Date.now());
  if (samples.length < MIN_SAMPLES) {
    return null;
  }
  const sorted = samples.map((s) => s.mbps).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Start reporting for a transcode session. Stops any previous reporter (one
 * playback at a time) and resets the sample window.
 *
 * @param {{ transport: { fetch: (path: string, options?: object) => Promise<unknown> }, sessionId: string, getBufferedAheadSec: () => number }} params
 * @returns {void}
 */
export function startNetReporter({ transport, sessionId, getBufferedAheadSec }) {
  stopNetReporter();
  samples = [];
  const path = `/api/transcode-sessions/${encodeURIComponent(sessionId)}/net-report`;
  const timer = setInterval(() => {
    const linkMbps = medianLinkMbps();
    if (linkMbps === null) {
      return; // nothing measured recently (paused / idle) — skip this tick
    }
    let bufferedAheadSec = 0;
    try {
      const value = getBufferedAheadSec();
      bufferedAheadSec = Number.isFinite(value) && value > 0 ? value : 0;
    } catch {
      // Buffer probe must never break reporting.
    }
    console.debug(
      `[torrent-tv] net-report link=${linkMbps.toFixed(2)}Mbps buffer=${bufferedAheadSec.toFixed(1)}s`
    );
    void transport
      .fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linkMbps, bufferedAheadSec })
      })
      .catch(() => undefined); // best-effort — next tick simply tries again
  }, REPORT_INTERVAL_MS);
  active = { timer };
}

/**
 * Stop reporting (no-op when idle).
 *
 * @returns {void}
 */
export function stopNetReporter() {
  if (active) {
    clearInterval(active.timer);
    active = null;
  }
}
