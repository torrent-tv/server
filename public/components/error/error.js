import { APP_EVENTS, ERROR_EVENTS, LOADING_EVENTS, PLAYER_EVENTS } from "../../shared/events.js";

/**
 * Error view.
 *
 * Responsibilities:
 * - Render title/description on `ERROR:SHOW`.
 * - Hide on `LOADING:SHOW` and `PLAYER:SHOW`.
 */
export class ErrorDialog {
  static SELECTOR = {
    dialog: "#error",
    title: "#error__title",
    description: "#error__description"
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

  /** @param {CustomEvent} event */
  #onErrorShow = (event) => {
    const payload = event instanceof CustomEvent ? event.detail : null;
    const title = typeof payload?.title === "string" ? payload.title : "";
    const description = typeof payload?.description === "string" ? payload.description : "";
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

  constructor() {
    this.#dialog = document.querySelector(ErrorDialog.SELECTOR.dialog);
    this.#title = document.querySelector(ErrorDialog.SELECTOR.title);
    this.#description = document.querySelector(ErrorDialog.SELECTOR.description);

    if (!this.#dialog || !this.#title || !this.#description) {
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
