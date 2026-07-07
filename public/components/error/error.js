import { APP_EVENTS, ERROR_EVENTS, LOADING_EVENTS, PLAYER_EVENTS } from "../../shared/events.js";

/**
 * Error view.
 *
 * Responsibilities:
 * - Render title/description on `ERROR:SHOW`.
 * - Show a "Retry" button when the payload includes `canRetry: true`
 *   (connection lost mid-playback; retry resumes the same file).
 * - Show a "New Torrent" button that resets to the torrent picker, or a
 *   "Choose File" button when the payload includes `canGoBackToPlaylist: true`.
 * - Hide on `LOADING:SHOW`, `PLAYER:SHOW`, `APP:RESET_TO_PICKER`, and `APP:BACK_TO_PLAYLIST`.
 */
export class ErrorDialog {
  static SELECTOR = {
    dialog: "#error",
    title: "#error__title",
    description: "#error__description",
    retryButton: "#error__retry",
    resetButton: "#error__back",
    playlistButton: "#error__playlist"
  };

  static MESSAGES = {
    missingDomNodes: "Error component DOM nodes are missing."
  };

  static DEFAULTS = {
    title: "Error",
    description: "Something went wrong."
  };

  #dialog;
  #title;
  #description;
  #retryButton;
  #resetButton;
  #playlistButton;

  /** @param {CustomEvent} event */
  #onErrorShow = (event) => {
    const payload = event instanceof CustomEvent ? event.detail : null;
    const title = typeof payload?.title === "string" ? payload.title : "";
    const description = typeof payload?.description === "string" ? payload.description : "";
    const canGoBackToPlaylist = payload?.canGoBackToPlaylist === true;
    const canRetry = payload?.canRetry === true;

    // Navigation actions: "New Torrent" is ALWAYS available (a dead torrent
    // must never trap the user), and "Back to episodes" is added when the
    // torrent has more than one video. Retry is an extra action for recoverable
    // errors (connection lost mid-playback).
    this.#retryButton.hidden = !canRetry;
    this.#resetButton.hidden = false;
    this.#playlistButton.hidden = !canGoBackToPlaylist;

    this.#showError({ title, description });
    this.visible = true;
  };

  #onLoadingShow = () => {
    this.visible = false;
  };

  #onPlayerShow = () => {
    this.visible = false;
  };

  #onHide = () => {
    this.visible = false;
  };

  #onResetClick = () => {
    this.visible = false;
    document.dispatchEvent(new CustomEvent(APP_EVENTS.RESET_TO_PICKER));
  };

  #onPlaylistClick = () => {
    this.visible = false;
    document.dispatchEvent(new CustomEvent(APP_EVENTS.BACK_TO_PLAYLIST));
  };

  #onRetryClick = () => {
    this.visible = false;
    document.dispatchEvent(new CustomEvent(APP_EVENTS.RETRY_PLAYBACK));
  };

  constructor() {
    this.#dialog = document.querySelector(ErrorDialog.SELECTOR.dialog);
    this.#title = document.querySelector(ErrorDialog.SELECTOR.title);
    this.#description = document.querySelector(ErrorDialog.SELECTOR.description);
    this.#retryButton = document.querySelector(ErrorDialog.SELECTOR.retryButton);
    this.#resetButton = document.querySelector(ErrorDialog.SELECTOR.resetButton);
    this.#playlistButton = document.querySelector(ErrorDialog.SELECTOR.playlistButton);

    if (!this.#dialog || !this.#title || !this.#description || !this.#retryButton || !this.#resetButton || !this.#playlistButton) {
      throw new Error(ErrorDialog.MESSAGES.missingDomNodes);
    }
    this.#dialog.inert = true;

    this.#setupEventHandlers();
  }

  #setupEventHandlers() {
    document.addEventListener(ERROR_EVENTS.SHOW, this.#onErrorShow);
    document.addEventListener(LOADING_EVENTS.SHOW, this.#onLoadingShow);
    document.addEventListener(PLAYER_EVENTS.SHOW, this.#onPlayerShow);
    document.addEventListener(APP_EVENTS.RESET_TO_PICKER, this.#onHide);
    document.addEventListener(APP_EVENTS.BACK_TO_PLAYLIST, this.#onHide);
    this.#resetButton.addEventListener("click", this.#onResetClick);
    this.#playlistButton.addEventListener("click", this.#onPlaylistClick);
    this.#retryButton.addEventListener("click", this.#onRetryClick);
  }

  /** @param {boolean} value */
  set visible(value) {
    if (value) {
      this.#dialog.inert = false;
      if (!this.#dialog.open) {
        this.#dialog.showModal();
      }
      return;
    }
    if (this.#dialog.open) {
      this.#dialog.close();
    }
    this.#dialog.inert = true;
  }

  /**
   * @param {{ title: string, description: string }} params
   */
  #showError({ title, description }) {
    const safeTitle = typeof title === "string" && title.trim().length > 0 ? title : ErrorDialog.DEFAULTS.title;
    const safeDescription =
      typeof description === "string" && description.trim().length > 0
        ? description
        : ErrorDialog.DEFAULTS.description;
    this.#title.textContent = safeTitle;
    this.#description.textContent = safeDescription;
  }
}

function bootstrapErrorDialog() {
  new ErrorDialog();
}

if (document.readyState !== "loading") {
  bootstrapErrorDialog();
} else {
  document.addEventListener("DOMContentLoaded", bootstrapErrorDialog, { once: true });
}
