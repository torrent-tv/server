/**
 * @file Whether a media element that says it is waiting is really stalled.
 *
 * The element reports `waiting` for two quite different things, and they need
 * opposite answers on screen:
 *
 *   - the picture has nothing to show and stopped — a stall, and the viewer
 *     must be told;
 *   - the picture is still running while some OTHER track is refilled — which
 *     is what changing the audio track does, since the player throws away the
 *     audio it holds and refetches it from where the picture is. Measured on
 *     the addon host: 2.75 s of that, with the picture never stopping. A
 *     spinner there reports a fault that is not happening.
 *
 * What separates them is not time. A window of "ignore waits for N seconds
 * after a track change" hides a REAL stall that begins inside the window — and
 * hides it for good, because `waiting` fires on a transition and an element
 * already waiting does not fire it again. It also swallows a seek made in the
 * same seconds, which is the frozen-frame-with-no-spinner failure this project
 * has already fixed once.
 *
 * What separates them is whether the PICTURE MOVED. That is a fact about the
 * element, available at the moment of the decision, and true of one case and
 * false of the other whatever the clock says.
 */

/**
 * @typedef {object} WaitingSample
 * @property {number} positionSeconds - The element's position.
 * @property {boolean} seeking - Whether the element is seeking.
 * @property {number} readyState - The element's readyState.
 */

/**
 * The smallest movement counted as the picture running. A playing element
 * advances by whole frames — 1/24 s is 0.042 — and a stopped one advances by
 * nothing at all, so anything above measurement noise separates them.
 */
export const PICTURE_MOVED_SECONDS = 0.02;

/**
 * Decide whether to report a wait to the viewer.
 *
 * @param {WaitingSample} whenScheduled - The element when the wait was noticed.
 * @param {WaitingSample} now - The element now, after the debounce.
 * @returns {boolean} True when the viewer should be shown that playback is waiting.
 */
export function shouldReportWaiting(whenScheduled, now) {
  // A seek is a wait the viewer made themselves and it must always show: the
  // position JUMPS to the target, so "the picture moved" would be true of it
  // while nothing is being shown. `seeking` stays true until the data arrives.
  if (now.seeking === true) {
    return true;
  }
  // Enough buffered to keep going: not waiting for anything.
  if (now.readyState >= 3) {
    return false;
  }
  const moved = now.positionSeconds - whenScheduled.positionSeconds;
  // The picture is still running: something else is being refilled — the audio
  // track the viewer just changed — and the viewer can see for themselves that
  // playback continues.
  if (moved >= PICTURE_MOVED_SECONDS) {
    return false;
  }
  return true;
}
