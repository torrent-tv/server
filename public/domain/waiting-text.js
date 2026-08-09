/**
 * @file What the waiting overlay says — the whole of it, from one function.
 *
 * A cold open and a seek into data that has not arrived are the same thing to
 * the viewer and very nearly the same to the system: the picture cannot move
 * and data is being fetched. They are one state group in the machine and one
 * interface on screen, so they are one text as well.
 *
 * Two writers used to share that line — the pipeline's stage string and the
 * buffering formatter — which is how the same wait could read one way while it
 * was opening and another way once it stalled, with no single place to look at
 * to find out why. This function is that place. It takes measurements and
 * returns words; it reads nothing, touches no DOM, and has no idea which of the
 * two situations produced its input, because that is exactly the distinction
 * that should not exist here.
 *
 * Pure, so `node --test` can pin every line of it without a browser.
 */

/**
 * Everything the overlay is allowed to say something about. Every field is
 * optional: a measurement that has not been taken yet is absent, and the line
 * that would have described it is left out rather than shown empty.
 *
 * @typedef {object} WaitingMeasurements
 * @property {string}  [stage] - What the pipeline is doing right now, in words
 *   ("Selecting proxy…"). The one input that is not a number: it names the step,
 *   which no measurement can.
 * @property {number}  [peers] - Peers connected for this torrent.
 * @property {number}  [downloadBytesPerSecond] - Current download rate.
 * @property {number}  [remainingBytes] - Bytes still needed before the picture
 *   can move, from the proxy's read window.
 * @property {number}  [bufferedSeconds] - Media already buffered ahead of the
 *   playhead. Used only when `remainingBytes` is unknown.
 * @property {number}  [cushionPercent] - How much of the required cushion is
 *   present, 0-100.
 * @property {number}  [cushionRemainingSeconds] - Media still needed.
 * @property {string}  [encodeSpeedText] - The encoder's speed, already
 *   validated and rounded by whoever measured it.
 * @property {EncodingRun[]} [encodingRuns] - Every encoder run still going, one
 *   line each. An array rather than "the encoder" because once quality can be
 *   switched without interrupting playback there will be several at once, and
 *   deciding which of them is "the" one would be a judgement this module has no
 *   business making — and would hide the very case worth seeing, two runs
 *   competing for the same cores.
 * @property {number}  [etaSeconds] - The single end-to-end estimate. Zero means
 *   a cushion that genuinely reached its target — never a guess.
 */

/**
 * One encoder run, as far as the overlay is concerned.
 *
 * Both tracks can be encoded at once, and they are encoded by ONE ffmpeg run —
 * so there is one speed for the pair, never one each, and it must not be
 * doubled or summed. What differs is the cost: audio is fractions of a core,
 * video is whole cores, so the two predict very different durations and a step
 * that does not say which is being encoded cannot be checked against reality.
 *
 * `height` tells two simultaneous runs apart: with quality switching the viewer
 * needs to know which rendition each line is about.
 *
 * @typedef {object} EncodingRun
 * @property {boolean} [video] - The video track is being re-encoded.
 * @property {boolean} [audio] - The audio track is being re-encoded.
 * @property {number}  [height] - The rendition being produced, in lines.
 * @property {number}  [remainingSeconds] - Media this run still has to produce.
 * @property {number}  [speedRealtime] - How many seconds of media it makes per
 *   second of wall clock. Below 1 means it cannot keep up.
 */

/** @param {unknown} value @returns {value is number} */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * A byte count in the largest unit that keeps it readable.
 *
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/**
 * A short waiting duration, spelled out in words rather than as a clock face:
 * `00:43` is a position in a film, `43 seconds` is a wait, and the overlay is
 * always talking about the second one.
 *
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  const plural = (value, unit) => `${value} ${unit}${value === 1 ? "" : "s"}`;
  if (!Number.isFinite(seconds) || seconds < 0) {
    return plural(0, "second");
  }
  const total = Math.round(seconds);
  if (total < 60) {
    return plural(total, "second");
  }
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) {
    return minutes > 0 ? `${plural(hours, "hour")} ${plural(minutes, "minute")}` : plural(hours, "hour");
  }
  return rest > 0 ? `${plural(minutes, "minute")} ${plural(rest, "second")}` : plural(minutes, "minute");
}

/**
 * Where the data is coming from: peers, rate, and how much is still to arrive.
 *
 * @param {WaitingMeasurements} measurements
 * @returns {string} Empty when nothing about supply is known yet.
 */
function supplyLine({ peers, downloadBytesPerSecond, remainingBytes, bufferedSeconds }) {
  const parts = [];
  if (isNumber(peers)) {
    parts.push(`peers: ${peers}`);
  }
  if (isNumber(downloadBytesPerSecond) && downloadBytesPerSecond > 0) {
    parts.push(`${formatBytes(downloadBytesPerSecond)}/s`);
  }
  if (isNumber(remainingBytes)) {
    parts.push(`${formatBytes(Math.max(0, remainingBytes))} left`);
  } else if (isNumber(bufferedSeconds) && bufferedSeconds > 0) {
    // The proxy did not report its read window — an older proxy, or a read
    // position it does not know yet. What the player already holds is the next
    // best answer to the same question.
    parts.push(`${Math.round(bufferedSeconds)}s buffered`);
  }
  return parts.join(" • ");
}

/**
 * A name for what is being waited for, worked out from the measurements alone.
 *
 * The pipeline names its own steps, but a seek runs none of them: it shows a
 * number of seconds with nothing saying whether the wait is for pieces, for the
 * encoder to be moved to the new position, or for the first segment out of it.
 * Three unrelated waits, one appearance. These are the same distinctions the
 * numbers already carry, so they cost nothing to name.
 *
 * @param {WaitingMeasurements} measurements
 * @returns {string | null} Null when the measurements say nothing yet.
 */
export function stepForMeasurements({ remainingBytes, cushionPercent, cushionRemainingSeconds }) {
  if (isNumber(remainingBytes) && remainingBytes > 0) {
    return "Fetching video data";
  }
  if (isNumber(cushionRemainingSeconds) && cushionRemainingSeconds > 0) {
    // What is being encoded, and how fast, is said by the per-run lines — one
    // each, so two runs competing for the same cores are two visible lines
    // rather than one averaged fiction.
    return `Preparing the last ${Math.ceil(cushionRemainingSeconds)}s of video`;
  }
  if (isNumber(cushionPercent)) {
    return "Starting the picture";
  }
  return null;
}

/**
 * One line describing one encoder run: which tracks of which rendition, how
 * much it still has to make, and how fast it is making it.
 *
 * @param {EncodingRun} run
 * @returns {string} Empty when nothing about this run is worth a line — it is
 *   copying rather than encoding, so there is no encoder to describe.
 */
export function describeEncodingRun(run) {
  if (!run || (run.video !== true && run.audio !== true)) {
    return "";
  }
  const rendition = isNumber(run.height) && run.height > 0 ? `${run.height}p ` : "";
  const tracks = run.video === true && run.audio === true
    ? `${rendition}video and audio`
    : run.video === true ? `${rendition}video` : "audio";
  const details = [];
  if (isNumber(run.remainingSeconds) && run.remainingSeconds > 0) {
    details.push(`${Math.ceil(run.remainingSeconds)}s left`);
  }
  if (isNumber(run.speedRealtime) && run.speedRealtime > 0) {
    // One decimal: the difference between 0.9x and 1.1x is the difference
    // between falling behind and keeping up, and rounding to whole numbers
    // hides it.
    details.push(`${run.speedRealtime.toFixed(1)}x realtime`);
  }
  return details.length > 0 ? `Encoding ${tracks} — ${details.join(", ")}` : `Encoding ${tracks}`;
}

/**
 * The overlay's entire text, one line per thing worth saying, in pipeline
 * order: what step it is on, where the data is coming from, how close the
 * picture is to moving, and finally the one end-to-end time.
 *
 * A stage with nothing to report is omitted rather than shown empty, and is
 * never REPLACED by another — they answer different questions and the viewer
 * needs all of them.
 *
 * @param {WaitingMeasurements} [measurements]
 * @returns {string}
 */
export function formatWaitingText(measurements = {}) {
  const lines = [];
  if (typeof measurements.stage === "string" && measurements.stage.length > 0) {
    lines.push(measurements.stage);
  }
  const supply = supplyLine(measurements);
  if (supply.length > 0) {
    lines.push(supply);
  }
  // One line per encoder still running. With a single run — every session today
  // — this is the one line it always was. With several, which is what quality
  // switching without an interruption will bring, each says what it is making
  // and how fast, because two runs sharing the same cores slow each other down
  // and an averaged single figure would hide exactly that.
  for (const run of Array.isArray(measurements.encodingRuns) ? measurements.encodingRuns : []) {
    const line = describeEncodingRun(run);
    if (line.length > 0) {
      lines.push(line);
    }
  }
  // The time comes last, and it is the answer to the only question actually
  // being asked. ONE number, always the same number, whatever stage the wait is
  // in — never "estimating…" and never "starting now". Those two were a
  // different kind of statement dressed as the same line: one admitted the
  // formula had nothing, the other announced an event. The viewer asked how
  // long, so they are told how long; when it is nearly over, that is zero
  // seconds, which is a duration like any other. Before the first measurement
  // there is no line at all rather than a word standing in for a number.
  if (isNumber(measurements.etaSeconds)) {
    lines.push(`${formatDuration(Math.max(0, measurements.etaSeconds))} until playback`);
  }
  return lines.join("\n");
}
