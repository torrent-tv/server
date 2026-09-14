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

import { FIRST_PROBE_BYTES, nextProbeBytes } from "./transport/link-probe.js";

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
 * The last link speed this connection ever showed.
 *
 * A viewer who has stopped the picture stops measuring, and a report skipped
 * for want of a fresh figure would lose the very fact it is being sent to
 * carry. The last figure is what is known about the link, and it is truer than
 * sending nothing.
 *
 * @type {number | null}
 */
let lastLinkMbps = null;

/**
 * Record one completed segment transfer (called by the HLS loader).
 *
 * @param {number} bytes
 * @param {number} ms - TRANSFER time only. Not the round trip: the time the
 *   proxy spent producing the segment belongs to the encoder and describes
 *   nothing about the link. Passing the round trip made a 22 s wait for one
 *   segment read as a 0.11 Mbit/s link on 2026-08-14, minutes after the same
 *   link had carried 8 MB at 38 Mbit/s.
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
 * Median link throughput (Mbit/s) over the sample window, or null when there
 * is not enough recent material to estimate. Public so callers other than the
 * reporter itself (e.g. the unified download/transcode/delivery ETA in
 * loading.js) can read the CLIENT's own observed delivery speed without a
 * round trip to the proxy — this is the exact figure already posted to it.
 *
 * @returns {number | null}
 */
export function getEstimatedLinkMbps() {
  return medianLinkMbps();
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
 * @param {{ transport: { fetch: (path: string, options?: object) => Promise<unknown> }, sessionId: string, consumerId?: string, getBufferedAheadSec: () => number, getPositionSeconds?: () => number | null, getPlaying?: () => boolean, getWaiting?: () => boolean }} params
 * @returns {void}
 */
export function startNetReporter({
  transport,
  sessionId,
  consumerId = "",
  getBufferedAheadSec,
  getPositionSeconds,
  getPlaying,
  getWaiting
}) {
  stopNetReporter();
  samples = [];
  const path = `/api/transcode-sessions/${encodeURIComponent(sessionId)}/net-report`;
  const send = () => {
    // The last figure stands when nothing has been measured recently. A viewer
    // who has stopped the picture measures nothing by construction, and their
    // stopping is the fact this report exists to carry — skipping the report
    // for want of a link reading would lose exactly the case that matters.
    const measured = medianLinkMbps();
    if (measured !== null) {
      lastLinkMbps = measured;
    }
    // THE LINK FIGURE IS ONE FIELD OF THIS REPORT, NOT ITS TICKET. Everything
    // else in it is a fact about the VIEWER — where they are, how much they
    // hold, whether the picture is moving, whether they are blocked on us,
    // whether the page is on screen — and none of it depends on anything having
    // been measured. A page measures its link from completed transfers, so a
    // page that has not yet been delivered a segment has no figure at all; at a
    // cold open that is every page.
    //
    // Skipped for want of it, as it was until 2026-09-14, the page said nothing
    // whatsoever in exactly the phase where its position matters most. Field
    // that day: one transfer completed in the whole session, the median needs
    // two, so every `reportNow()` — the pauses, the starvation, the tab going
    // hidden — returned on this line. The proxy filled the silence by assuming
    // the film was running and placed a viewer who had not seen a frame 146
    // seconds into it.
    const linkMbps = lastLinkMbps;
    let bufferedAheadSec = 0;
    try {
      const value = getBufferedAheadSec();
      bufferedAheadSec = Number.isFinite(value) && value > 0 ? value : 0;
    } catch {
      // silent-ok: the buffered figure is one field of a report whose point is
      // the link speed beside it, and zero is a truthful reading of a buffer
      // that cannot be read. The report still goes.
    }
    // Where the picture is. A session is shared by every viewer of a copied
    // stream, and the proxy used to work this out by subtracting the buffer
    // above from its own read head — which is the furthest request of ANY
    // viewer, so with two of them the answer belonged to neither. Saying it
    // outright costs one field.
    let positionSeconds = null;
    try {
      const value = typeof getPositionSeconds === "function" ? getPositionSeconds() : NaN;
      positionSeconds = Number.isFinite(value) && value >= 0 ? value : null;
    } catch {
      // silent-ok: same reasoning as the buffer above — the report still goes,
      // and the proxy falls back to the subtraction for a viewer who states
      // nothing.
    }
    // Whether the picture is moving. A stopped viewer consumes nothing, so
    // nothing in front of them ever falls due and the proxy gives the work to
    // whoever is watching. The page knows this exactly; working it out from a
    // position that has not moved takes two reports and is wrong whenever a
    // full cushion makes a playing browser go quiet between segments.
    let playing = false;
    try {
      playing = typeof getPlaying === "function" ? Boolean(getPlaying()) : false;
    } catch {
      // silent-ok: same as the two readings above — the report still goes, and
      // an element that cannot be read has not been seen to advance.
    }
    // WHETHER THIS VIEWER IS BLOCKED ON MATERIAL WE OWE THEM, which is the
    // third state and not the negation of the second. A picture that is not
    // advancing was stopped either by the viewer — who then consumes nothing
    // and can wait — or by us having delivered nothing, and that viewer is the
    // most urgent there is. One boolean held only two of the three and read the
    // second case as the first.
    let waiting = false;
    try {
      waiting = typeof getWaiting === "function" ? Boolean(getWaiting()) : false;
    } catch {
      // silent-ok: an element that cannot be read has not been seen to be
      // blocked either, and the report still goes with everything else in it.
    }
    // WHETHER THIS PAGE IS ON SCREEN AT ALL, and if not, whether the picture was
    // pulled out of it. The browser knows both exactly and the proxy could not
    // tell them apart: a hidden tab has its timers throttled — measured
    // `loopLag=800ms` in the field — so it asks for nothing and looks precisely
    // like a viewer holding a full cushion. Field 2026-09-08: delivery stood
    // still for the last six minutes of a session and nothing anywhere said
    // that the tab had gone away.
    //
    // Picture-in-picture is the case that makes the distinction necessary rather
    // than merely tidy: the tab is hidden and the viewer is watching.
    let onScreen = true;
    let inPictureInPicture = false;
    try {
      inPictureInPicture = Boolean(document.pictureInPictureElement);
      onScreen = document.visibilityState !== "hidden" || inPictureInPicture;
    } catch {
      // silent-ok: same as the readings above — an environment that cannot
      // answer counts as on screen, which is what every page meant before it
      // could say otherwise.
    }
    console.debug(
      `[torrent-tv] net-report link=${linkMbps === null ? "?" : `${linkMbps.toFixed(2)}Mbps`} buffer=${bufferedAheadSec.toFixed(1)}s` +
        (positionSeconds === null ? "" : ` at=${positionSeconds.toFixed(1)}s`) +
        (playing ? "" : waiting ? " waiting" : " paused") +
        (onScreen ? "" : " off-screen") +
        (inPictureInPicture ? " in-pip" : "")
    );
    void transport
      .fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bufferedAheadSec,
          playing,
          waiting,
          onScreen,
          inPictureInPicture,
          ...(consumerId ? { consumerId } : {}),
          ...(linkMbps === null ? {} : { linkMbps }),
          ...(positionSeconds === null ? {} : { positionSeconds })
        })
      })
      .catch(() => undefined); // best-effort — next tick simply tries again
  };
  const timer = setInterval(send, REPORT_INTERVAL_MS);
  active = { timer, send };
}

/**
 * Say it now rather than at the next tick.
 *
 * For the facts that are EVENTS: the viewer stopped the picture, or started it
 * again. Waiting up to ten seconds to mention either would leave the proxy
 * working for somebody who is not watching, or not working for somebody who is.
 *
 * @returns {void}
 */
export function reportNow() {
  active?.send?.();
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

/**
 * Measure this link now, without waiting for a film.
 *
 * Runs once per transport, the moment it is up: the proxy is asked for a
 * stated number of bytes and the transfer is recorded as an ordinary sample,
 * in the same units and the same window as every segment. See
 * `transport/link-probe.js` for why the size is what it is.
 *
 * Best-effort throughout: a proxy one release behind has no such route and
 * answers 404, which is the same as not having measured — the estimate then
 * fills from segments as it always did.
 *
 * It cannot get in a viewer's way for long even if they pick a film at once:
 * the size only grows on a link that has just proved it can carry it, so a thin
 * link is measured by one ask of 64 KiB and a fast one moves the largest ask
 * this makes in tens of milliseconds.
 *
 * @param {{ fetch: (path: string, options?: object) => Promise<{ arrayBuffer?: () => Promise<ArrayBuffer>, ok?: boolean } | unknown> }} transport
 * @returns {Promise<void>}
 */
export async function measureLink(transport) {
  let bytes = FIRST_PROBE_BYTES;
  let measurable = 0;
  for (let ask = 0; ask < 8 && bytes !== null; ask += 1) {
    const startedAt = performance.now();
    let received = 0;
    let ms = 0;
    try {
      const response = await transport.fetch(`/api/link-probe?bytes=${bytes}`);
      if (response?.ok === false) {
        return; // a proxy one release behind has no such route
      }
      received = await asBytes(response);
      // The TRANSFER, never the round trip. The other half is the proxy
      // answering, and adding the two together measures this proxy rather than
      // this link — the error that reported a link which had just carried 8 MB
      // at 38 Mbit/s as 0.11 Mbit/s.
      ms =
        typeof (/** @type {{ transferMs?: number }} */ (response)?.transferMs) === "number"
          ? /** @type {{ transferMs: number }} */ (response).transferMs
          : performance.now() - startedAt;
    } catch {
      // silent-ok: a proxy one release behind has no such route and a channel
      // that is not up cannot be measured. Both mean the same thing — no
      // figure — and the estimate fills from segments as it always did.
      return;
    }
    if (received <= 0) {
      return;
    }
    recordNetSample(received, ms);
    if (ms >= MIN_SAMPLE_MS) {
      measurable += 1;
    }
    bytes = nextProbeBytes({
      lastBytes: bytes,
      lastMs: ms,
      measurableSoFar: measurable,
      minSampleMs: MIN_SAMPLE_MS
    });
  }
}

/**
 * How many bytes a transport answer carried.
 *
 * @param {unknown} response
 * @returns {Promise<number>}
 */
async function asBytes(response) {
  if (response instanceof ArrayBuffer) {
    return response.byteLength;
  }
  if (ArrayBuffer.isView(response)) {
    return response.byteLength;
  }
  const buffer = await /** @type {{ arrayBuffer?: () => Promise<ArrayBuffer> }} */ (response)
    ?.arrayBuffer?.();
  return buffer instanceof ArrayBuffer ? buffer.byteLength : 0;
}
