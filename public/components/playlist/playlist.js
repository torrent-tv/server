
import { playlistRows } from "../../domain/playlist-groups.js";
import { APP_EVENTS, ERROR_EVENTS, LOADING_EVENTS, PLAYER_EVENTS } from "../../shared/events.js";

/**
 * Playlist overlay view.
 */
export class Playlist {

  static SELECTOR = {
    root: "#playlist",
    // The first thing a viewer can reach: a row, or a folder's summary when the
    // list is grouped (the rows inside a closed group cannot take focus).
    firstFocusable: ":is(summary, button)",
    fileButton: "button[data-file-index]",
  };

  static CLASSES = {
    
  };

  static MESSAGES = {
    missingDomNodes: "Playlist component DOM nodes are missing."
  };

  #root;
  #videoFiles = [];
  #currentFileIndex = -1;
  /** Where the application's state machine is; see APP_EVENTS.STATE_CHANGED. */
  #appState = "";


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
    document.addEventListener(APP_EVENTS.STATE_CHANGED, this.#onAppStateChanged);
    document.addEventListener(PLAYER_EVENTS.SET_MEDIA_FILES, this.#onSetMediaFiles);
    document.addEventListener(PLAYER_EVENTS.SET_ACTIVE_MEDIA_FILE, this.#onSetActiveMediaFile);
    document.addEventListener(APP_EVENTS.RESET_TO_PICKER, this.#onAppReset);
    document.addEventListener(PLAYER_EVENTS.OPEN_PLAYLIST, this.#onPlaylistOpen);
    document.addEventListener(PLAYER_EVENTS.CLOSE_PLAYLIST, this.#onPlaylistClose);
    document.addEventListener(LOADING_EVENTS.SHOW, this.#onPlaylistClose);
    // On error only CLOSE the drawer — do not clear the file list: the error
    // screen's "Choose File" action returns the user to this playlist.
    document.addEventListener(ERROR_EVENTS.SHOW, this.#onPlaylistClose);
    this.#root.addEventListener("click", this.#onListClick);
  }

  #onPlaylistOpen = () => {
    this.#root.removeAttribute('inert');
    this.#root.setAttribute('data-open', true);
    
    const first = this.#root.querySelector(Playlist.SELECTOR.firstFocusable);
    if (first instanceof HTMLElement) first.focus({ preventScroll: true });
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

  /**
   * Where the application is, so a click can mean different things. Only
   * `"ERROR"` is acted on; anything else behaves as before.
   *
   * @param {CustomEvent} event
   */
  #onAppStateChanged = (event) => {
    const state = event instanceof CustomEvent ? event.detail?.state : null;
    this.#appState = typeof state === "string" ? state : "";
  };

  /** @param {MouseEvent} event */
  #onListClick = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const button = target.closest(Playlist.SELECTOR.fileButton);
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    const fileIndex = Number(button.dataset.fileIndex);
    if (!Number.isInteger(fileIndex)) {
      return;
    }
    // Picking the file that is already playing means nothing, so the list just
    // closes — EXCEPT when that file is the one that failed. Then re-picking it
    // is the only way to ask for it again, and swallowing the click left the
    // viewer looking at an empty player with nothing happening: "Choose File"
    // on the error screen reveals the player and opens this list, and the file
    // it highlights is precisely the one that did not load.
    if (fileIndex === this.#currentFileIndex && this.#appState !== "ERROR") {
      document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.CLOSE_PLAYLIST));
      return;
    }
    this.#currentFileIndex = fileIndex;
    this.#updateActiveHighlight(); // immediate feedback; SET_ACTIVE_MEDIA_FILE confirms later
    document.dispatchEvent(
      new CustomEvent(PLAYER_EVENTS.SELECT_MEDIA_FILE, {
        detail: { fileIndex }
      })
    );
    document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.CLOSE_PLAYLIST));
  };

  #renderList() {
    this.#root.textContent = "";
    for (const row of playlistRows(this.#videoFiles)) {
      if (row.kind === "file") {
        this.#root.append(this.#fileItem(row.file, row.label));
        continue;
      }
      const item = document.createElement("li");
      const group = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = row.label;
      const files = document.createElement("ul");
      for (const member of row.files) {
        files.append(this.#fileItem(member.file, member.label));
      }
      group.append(summary, files);
      item.append(group);
      this.#root.append(item);
    }
    this.#updateActiveHighlight();
  }

  /**
   * One row of the list.
   *
   * @param {{ index?: number }} file
   * @param {string} label - What `playlistRows` decided the row is called: the
   *   release's own repeated furniture taken off, and the folder left out inside
   *   a group.
   * @returns {HTMLLIElement}
   */
  #fileItem(file, label) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.fileIndex = String(file?.index ?? -1);
    button.textContent = label;
    item.append(button);
    return item;
  }

  /**
   * Mark the button for the currently active file via `aria-current` so it is
   * visually and semantically distinguishable in the playlist.
   */
  #updateActiveHighlight() {
    const buttons = this.#root.querySelectorAll(Playlist.SELECTOR.fileButton);
    for (const button of buttons) {
      const fileIndex = Number(button.dataset.fileIndex);
      if (Number.isInteger(fileIndex) && fileIndex === this.#currentFileIndex) {
        button.setAttribute("aria-current", "true");
        // The folder holding what plays is opened, so the highlight is in view
        // the next time the list is. Folders the viewer opened stay open.
        const group = button.closest("details");
        if (group !== null) group.open = true;
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
