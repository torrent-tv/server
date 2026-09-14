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
 * So a pause we cause is marked as ours before it is issued, and the marker is
 * consumed by the `pause` handler that follows. Anything unmarked came from the
 * viewer.
 */

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
 * Whether the `pause` event now being handled was one of ours, consuming the
 * marker either way — a marker that outlived its event would swallow the
 * viewer's next pause.
 *
 * @param {HTMLVideoElement} video
 * @returns {boolean}
 */
export function consumeOurPause(video) {
  if (!ourPauses.has(video)) {
    return false;
  }
  ourPauses.delete(video);
  return true;
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
 * Written by whoever handles the element's own `pause` and `playing` events,
 * which is the one place that already knows whether a pause was ours.
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
