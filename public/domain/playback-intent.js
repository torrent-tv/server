/**
 * @file Telling the viewer's pauses apart from our own.
 *
 * `video.paused` answers "is it stopped right now", which is not the question
 * anyone actually asks. The application needs "did the VIEWER stop it", and the
 * two disagree exactly where it matters: the pre-buffer gate pauses the element
 * on purpose while a stream is being built, the player pauses it whenever it
 * leaves the screen, and each of those raises a `pause` event indistinguishable
 * from a viewer pressing the button.
 *
 * Reading `!video.paused` at the moment a stream became usable therefore always
 * answered "the viewer does not want playback" — because the pre-buffer had
 * just paused it one line earlier — and every cold open ended stopped on its
 * first frame.
 *
 * A pause we cause is marked before it is issued. Explicit control requests
 * record viewer intent; element events never establish who requested a pause.
 */

/**
 * Who caused a `pause`.
 *
 * @readonly
 */
export const PAUSE_CAUSE = Object.freeze({
  /** We paused it — see {@link pauseWithoutIntent}. */
  OURS: "ours",
  /** The element stopped itself after failing — see {@link noteElementFailed}. */
  ELEMENT: "element",
  /** The person watching. */
  VIEWER: "viewer"
});

/**
 * Elements whose next `pause` event was caused by us. A `WeakSet` so an element
 * that goes away takes its entry with it.
 *
 * @type {WeakSet<HTMLVideoElement>}
 */
const ourPauses = new WeakSet();

/**
 * Pause without it counting as the viewer's decision.
 *
 * @param {HTMLVideoElement} video
 * @returns {void}
 */
export function pauseWithoutIntent(video) {
  if (!(video instanceof HTMLVideoElement) || video.paused) {
    return;
  }
  ourPauses.add(video);
  video.pause();
}

/**
 * Elements that have failed and whose own pause has not been seen yet.
 *
 * @type {WeakSet<object>}
 */
const failedElements = new WeakSet();

/**
 * Record that the element has failed, so the pause it makes next is not read
 * as the viewer's.
 *
 * Recorded whether or not the element is still moving at that instant: the
 * order in which a browser sets `paused` and dispatches `error` is not
 * something this code can rely on, and the record is withdrawn when the
 * picture moves again ({@link noteElementRecovered}), so it cannot outlive the
 * failure it describes. Its one blind spot is a viewer who presses pause
 * between the failure and the element's own pause, which is a few
 * milliseconds, or — on an element the viewer had already stopped, which makes
 * no pause of its own — presses play and pause again before the picture moves.
 *
 * @param {object} video
 * @returns {void}
 */
export function noteElementFailed(video) {
  if (video && typeof video === "object") {
    failedElements.add(video);
  }
}

/**
 * The picture is moving again: any failure recorded on this element is over.
 *
 * @param {object} video
 * @returns {void}
 */
export function noteElementRecovered(video) {
  if (video && typeof video === "object") {
    failedElements.delete(video);
  }
}

/**
 * Who caused the `pause` now being handled, consuming the marker that answered
 * — a marker that outlived its event would swallow the viewer's next pause.
 *
 * Ours is asked first: a pause we issued while a failure is pending is still
 * ours, and the failure's own pause is then still to come.
 *
 * @param {object} video
 * @returns {string} One of {@link PAUSE_CAUSE}.
 */
export function consumePauseCause(video) {
  if (ourPauses.has(video)) {
    ourPauses.delete(video);
    return PAUSE_CAUSE.OURS;
  }
  if (failedElements.has(video)) {
    failedElements.delete(video);
    return PAUSE_CAUSE.ELEMENT;
  }
  return PAUSE_CAUSE.VIEWER;
}

/**
 * Elements the VIEWER has stopped, as opposed to elements that are merely not
 * advancing.
 *
 * The second fact this file exists for, and the one that separates the three
 * states a picture can be in: advancing, stopped by the person watching, or
 * stopped because nothing has been delivered to play. `video.paused` is true in
 * the last two and false in the first, so it cannot tell them apart — and they
 * are opposite instructions to the proxy. A viewer who stopped the picture
 * consumes nothing and can wait; a viewer waiting on material is the most
 * urgent there is.
 *
 * Written only by explicit viewer control requests.
 *
 * @type {WeakSet<HTMLVideoElement>}
 */
const stoppedByViewer = new WeakSet();

/**
 * Record that this element is, or is no longer, stopped by the viewer.
 *
 * @param {HTMLVideoElement} video
 * @param {boolean} stopped
 * @returns {void}
 */
export function noteViewerStopped(video, stopped) {
  if (!(video instanceof HTMLVideoElement)) {
    return;
  }
  if (stopped) {
    stoppedByViewer.add(video);
  } else {
    stoppedByViewer.delete(video);
  }
}

/**
 * Whether the viewer has stopped this element themselves.
 *
 * @param {HTMLVideoElement} video
 * @returns {boolean}
 */
export function viewerHasStopped(video) {
  return video instanceof HTMLVideoElement && stoppedByViewer.has(video);
}
