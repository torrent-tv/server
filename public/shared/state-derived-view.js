import { APP_EVENTS } from "./events.js";

/**
 * @file A view whose presence on screen is decided by the application state.
 *
 * Under a Moore machine an output is a function of the state alone, so every
 * view answers the same question in the same way: given the state, do I belong
 * on screen? Four views had four copies of that answer — two of them identical
 * word for word — which is three copies too many for one rule.
 *
 * A subclass says which states it belongs to and, if it needs more than
 * appearing and disappearing, overrides {@link StateDerivedView#applyAppState}.
 *
 * Subscribing here rather than in each subclass also fixes the order in one
 * place: `torrent-tv.js` is the last module `index.html` loads, so its first
 * announcement arrives after every view has subscribed.
 */
export class StateDerivedView {
  /** @type {(state: string) => boolean} */
  #belongsOnScreen;

  /**
   * Whether this view was on screen before the state now being applied.
   *
   * Kept here because no view has a `visible` GETTER — they all have a setter
   * only — so a subclass asking `this.visible` gets `undefined`, which is
   * falsy, which silently skips whatever it guards. That mistake was made in
   * the player, where it would have stopped the video source ever being
   * released on the way out.
   *
   * @type {boolean}
   */
  #onScreen = false;

  /**
   * @param {(state: string) => boolean} belongsOnScreen - Whether this view is
   *   on screen in the given state. A pure predicate over the state, taken from
   *   `domain/app-state.js` — never a rule of the view's own.
   */
  constructor(belongsOnScreen) {
    this.#belongsOnScreen = belongsOnScreen;
    document.addEventListener(APP_EVENTS.STATE_CHANGED, this.#onAppStateChanged);
  }

  /** @param {CustomEvent} event */
  #onAppStateChanged = (event) => {
    const state = event instanceof CustomEvent ? event.detail?.state : null;
    if (typeof state !== "string") {
      return;
    }
    const belongsOnScreen = this.#belongsOnScreen(state);
    this.applyAppState(state, belongsOnScreen);
    // Recorded after the subclass has acted, so `onScreen` reads as "before
    // this state" throughout `applyAppState`. Done here rather than in
    // `applyAppState` so an override cannot skip it by not calling `super`.
    this.#onScreen = belongsOnScreen;
  };

  /**
   * Whether this view was on screen before the state currently being applied.
   * Meaningful inside {@link StateDerivedView#applyAppState}, where it is what
   * distinguishes "still not on screen" from "leaving the screen now" — the
   * difference between doing nothing and letting go of resources.
   *
   * @returns {boolean}
   */
  get onScreen() {
    return this.#onScreen;
  }

  /**
   * React to the application state. The default is the whole of what most views
   * need. Override to add behaviour, and call `super.applyAppState(...)` so the
   * visibility rule stays in one place.
   *
   * @param {string} _state - The state, for a subclass that needs more than
   *   whether it is on screen.
   * @param {boolean} belongsOnScreen
   * @returns {void}
   */
  applyAppState(_state, belongsOnScreen) {
    this.visible = belongsOnScreen;
  }
}
