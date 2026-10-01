
import { playlistRows } from "../../domain/playlist-groups.js";
import { playlistNaming } from "../../domain/media-info.js";
import { APP_EVENTS, ERROR_EVENTS, LOADING_EVENTS, MEDIA_INFO_EVENTS, PLAYER_EVENTS } from "../../shared/events.js";

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
  /** What the metadata service said about the release; see MEDIA_INFO:CHANGED. */
  #media = null;
  /** Each group's summary, by folder, so a name can change without a rebuild. @type {Map<string, HTMLElement>} */
  #summaries = new Map();


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

  /**
   * Names from the metadata service arrived or changed. Applied to the rows
   * already on screen rather than by rebuilding them, so a group the viewer
   * opened stays open.
   *
   * @param {CustomEvent} event
   */
  #onMediaInfo = (event) => {
    const before = playlistRows(this.#videoFiles, playlistNaming(this.#media)).map(r => r.folder ?? r.file?.index).join("|");
    this.#media = event instanceof CustomEvent ? event.detail : null;
    const after = playlistRows(this.#videoFiles, playlistNaming(this.#media)).map(r => r.folder ?? r.file?.index).join("|");
    if (before !== after) this.#renderList(); else this.#applyNames();
  };

  /** @param {CustomEvent} event */
  #onSetActiveMediaFile = (event) => {
    const payload = event instanceof CustomEvent ? event.detail : null;
    const fileIndex = Number(payload?.fileIndex);
    this.#currentFileIndex = Number.isInteger(fileIndex) ? fileIndex : -1;
    this.#applyNames();
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
    document.addEventListener(MEDIA_INFO_EVENTS.CHANGED, this.#onMediaInfo);
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
    if (this.#videoFiles.length < 2) return;
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
    const heading = document.createElement("li");
    heading.id = "playlist__heading";
    this.#root.append(heading);
    this.#summaries = new Map();
    /** Rows a viewer sees without opening anything. @type {number[]} */
    const inView = [];
    const rows = playlistRows(this.#videoFiles, playlistNaming(this.#media));
    const singleSeason = rows.filter(r => r.kind === "group" && r.folder.startsWith("season:")).length === 1;
    for (const row of rows) {
      if (row.kind === "file") {
        this.#root.append(this.#fileItem(row.file, row.label));
        inView.push(Number(row.file?.index));
        continue;
      }
      const item = document.createElement("li");
      const fixed = singleSeason && row.folder.startsWith("season:");
      const group = document.createElement(fixed ? "section" : "details");
      const summary = document.createElement(fixed ? "h2" : "summary");
      summary.textContent = row.label;
      this.#summaries.set(row.folder, summary);
      const files = document.createElement("ul");
      for (const member of row.files) {
        files.append(this.#fileItem(member.file, member.label));
      }
      // The episode names of a folder are wanted when it is opened, whether by
      // the viewer or because it holds what is playing.
      const memberIndexes = row.files.map((member) => Number(member.file?.index));
      group.addEventListener("toggle", () => {
        if (group.open) {
          this.#wantNames(memberIndexes);
        }
      });
      if (fixed) inView.push(...memberIndexes);
      group.append(summary, files);
      item.append(group);
      this.#root.append(item);
    }
    this.#applyNames();
    this.#wantNames(inView);
    this.#updateActiveHighlight();
  }

  /**
   * Put the current names on the rows already built.
   */
  #applyNames() {
    const heading = this.#root.querySelector("#playlist__heading");
    if (heading) {
      const activeWork = this.#media?.pictures?.[String(this.#currentFileIndex)] ?? this.#media?.work;
      heading.textContent = (activeWork?.normalized ?? activeWork)?.title || this.#media?.releaseName || "";
      heading.hidden = !heading.textContent;
    }
    const labels = new Map();
    for (const row of playlistRows(this.#videoFiles, playlistNaming(this.#media))) {
      if (row.kind === "file") {
        labels.set(Number(row.file?.index), row.label);
        continue;
      }
      const summary = this.#summaries.get(row.folder);
      if (summary) {
        summary.textContent = row.label;
      }
      for (const member of row.files) {
        labels.set(Number(member.file?.index), member.label);
      }
    }
    for (const button of this.#root.querySelectorAll(Playlist.SELECTOR.fileButton)) {
      const label = labels.get(Number(button.dataset.fileIndex));
      if (typeof label === "string") {
        button.textContent = label;
      }
    }
  }

  /**
   * @param {number[]} fileIndexes
   */
  #wantNames(fileIndexes) {
    const wanted = fileIndexes.filter(Number.isInteger);
    if (wanted.length > 0) {
      document.dispatchEvent(new CustomEvent(MEDIA_INFO_EVENTS.WANT_FILES, { detail: { fileIndexes: wanted } }));
    }
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
