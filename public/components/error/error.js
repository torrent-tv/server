import { APP_EVENTS, ERROR_EVENTS, LOADING_EVENTS, PLAYER_EVENTS } from "../../shared/events.js";

/**
 * Error view.
 *
 * Responsibilities:
 * - Render title/description on `ERROR:SHOW`.
 * - Show an optional "Back" button when the `ERROR:SHOW` payload includes a `backEvent`.
 * - Hide on `LOADING:SHOW`, `PLAYER:SHOW`, `APP:RESET_TO_PICKER`, and `APP:BACK_TO_PLAYLIST`.
 */
export class ErrorDialog {
  static SELECTOR = {
    dialog: "#error",
    title: "#error__title",
    description: "#error__description",
    backButton: "#error__back"
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
  #backButton;

  /** The event name to dispatch when the back button is clicked, or null. @type {string | null} */
  #backEvent = null;

  /** @param {CustomEvent} event */
  #onErrorShow = (event) => {
    const payload = event instanceof CustomEvent ? event.detail : null;
    const title = typeof payload?.title === "string" ? payload.title : "";
    const description = typeof payload?.description === "string" ? payload.description : "";
    const backEvent = typeof payload?.backEvent === "string" ? payload.backEvent : null;
    this.#backEvent = backEvent;
    this.#backButton.hidden = backEvent === null;
    this.#showError({ title, description });
    this.visible = true;
  };

  #onLoadingShow = () => {
    this.visible = false;
  };

  #onPlayerShow = () => {
    this.visible = false;
  };

  #onAppReset = () => {
    this.visible = false;
  };

  #onBackClick = () => {
    if (!this.#backEvent) {
      return;
    }
    this.visible = false;
    document.dispatchEvent(new CustomEvent(this.#backEvent));
  };

  constructor() {
    this.#dialog = document.querySelector(ErrorDialog.SELECTOR.dialog);
    this.#title = document.querySelector(ErrorDialog.SELECTOR.title);
    this.#description = document.querySelector(ErrorDialog.SELECTOR.description);
    this.#backButton = document.querySelector(ErrorDialog.SELECTOR.backButton);

    if (!this.#dialog || !this.#title || !this.#description || !this.#backButton) {
      throw new Error(ErrorDialog.MESSAGES.missingDomNodes);
    }
    this.#dialog.inert = true;

    this.#setupEventHandlers();
  }

  #setupEventHandlers() {
    document.addEventListener(ERROR_EVENTS.SHOW, this.#onErrorShow);
    document.addEventListener(LOADING_EVENTS.SHOW, this.#onLoadingShow);
    document.addEventListener(PLAYER_EVENTS.SHOW, this.#onPlayerShow);
    document.addEventListener(APP_EVENTS.RESET_TO_PICKER, this.#onAppReset);
    document.addEventListener(APP_EVENTS.BACK_TO_PLAYLIST, this.#onAppReset);
    this.#backButton.addEventListener("click", this.#onBackClick);
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
