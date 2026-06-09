import { APP_EVENTS, ERROR_EVENTS, LOADING_EVENTS, PLAYER_EVENTS } from "../../shared/events.js";

/**
 * Playlist overlay view.
 */
export class Playlist {

  static SELECTOR = {
    root: "#playlist",
    firstButton: "button:first-of-type",
  };

  static CLASSES = {
    
  };

  static MESSAGES = {
    missingDomNodes: "Playlist component DOM nodes are missing."
  };

  #root;
  #videoFiles = [];
  #currentFileIndex = -1;


  #onAppReset = () => {
    this.#disablePlaylistMode();
    this.#videoFiles = [];
    this.#currentFileIndex = -1;
    this.#renderList();
  };

  /** @param {CustomEvent} event */
  #onSetMediaFiles = (event) => {
    const payload = event instanceof CustomEvent ? event.detail : null;
    this.#videoFiles = Array.isArray(payload?.video) ? payload.video : [];
    this.#currentFileIndex = -1;
    this.#renderList();
  };

  /** @param {CustomEvent} event */
  #onSetActiveMediaFile = (event) => {
    const payload = event instanceof CustomEvent ? event.detail : null;
    const fileIndex = Number(payload?.fileIndex);
    this.#currentFileIndex = Number.isInteger(fileIndex) ? fileIndex : -1;
    this.#updateActiveHighlight();
  };


  constructor() {
    this.#root = document.querySelector(Playlist.SELECTOR.root);

    if (!this.#root) {
      throw new Error(Playlist.MESSAGES.missingDomNodes);
    }

    this.#setupEventHandlers();
  }


  #setupEventHandlers() {
    document.addEventListener(PLAYER_EVENTS.SET_MEDIA_FILES, this.#onSetMediaFiles);
    document.addEventListener(PLAYER_EVENTS.SET_ACTIVE_MEDIA_FILE, this.#onSetActiveMediaFile);
    document.addEventListener(APP_EVENTS.RESET_TO_PICKER, this.#onAppReset);
    document.addEventListener(PLAYER_EVENTS.OPEN_PLAYLIST, this.#onPlaylistOpen);
    document.addEventListener(PLAYER_EVENTS.CLOSE_PLAYLIST, this.#onPlaylistClose);
    document.addEventListener(LOADING_EVENTS.SHOW, this.#onPlaylistClose);
    document.addEventListener(ERROR_EVENTS.SHOW, this.#onAppReset);
    this.#root.addEventListener("click", this.#onListClick);
  }

  #onPlaylistOpen = () => {
    this.#root.removeAttribute('inert');
    this.#root.setAttribute('data-open', true);
    
    const button = this.#root.querySelector(Playlist.SELECTOR.firstButton);
    if (button !== null) button.focus({ preventScroll: true });
  };

  #onPlaylistClose = () => {
    this.#disablePlaylistMode();
  };

  #disablePlaylistMode() {
    const activeElement = document.activeElement;
    if (activeElement instanceof Node && this.#root.contains(activeElement)) {
      document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.FOCUS_PLAYLIST_TOGGLE));
    }
    this.#root.setAttribute('inert', true);
    this.#root.setAttribute('data-open', false);
  }

  /** @param {MouseEvent} event */
  #onListClick = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const button = target.closest("button[data-file-index]");
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    const fileIndex = Number(button.dataset.fileIndex);
    if (!Number.isInteger(fileIndex)) {
      return;
    }
    if (fileIndex === this.#currentFileIndex) {
      document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.CLOSE_PLAYLIST));
      return;
    }
    this.#currentFileIndex = fileIndex;
    document.dispatchEvent(
      new CustomEvent(PLAYER_EVENTS.SELECT_MEDIA_FILE, {
        detail: { fileIndex }
      })
    );
    document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.CLOSE_PLAYLIST));
  };

  #renderList() {
    this.#root.textContent = "";
    for (const file of this.#videoFiles) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.fileIndex = String(file?.index ?? -1);
      button.textContent =
        typeof file?.relativePath === "string" && file.relativePath.length > 0
          ? file.relativePath
          : String(file?.name ?? "Video");
      item.append(button);
      this.#root.append(item);
    }
    this.#updateActiveHighlight();
  }

  /**
   * Mark the button for the currently active file via `aria-current` so it is
   * visually and semantically distinguishable in the playlist.
   */
  #updateActiveHighlight() {
    const buttons = this.#root.querySelectorAll("button[data-file-index]");
    for (const button of buttons) {
      const fileIndex = Number(button.dataset.fileIndex);
      if (Number.isInteger(fileIndex) && fileIndex === this.#currentFileIndex) {
        button.setAttribute("aria-current", "true");
      } else {
        button.removeAttribute("aria-current");
      }
    }
  }
}

function bootstrapPlaylist() {
  new Playlist();
}

if (document.readyState !== "loading") {
  bootstrapPlaylist();
} else {
  document.addEventListener("DOMContentLoaded", bootstrapPlaylist, { once: true });
}
