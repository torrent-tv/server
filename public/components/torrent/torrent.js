import { APP_EVENTS, ERROR_EVENTS, LOADING_EVENTS, PLAYER_EVENTS, TORRENT_EVENTS } from "../../shared/events.js";
import { parseTorrentBytes } from "../../domain/torrent-parser.js";

/**
 * Torrent input view.
 *
 * Responsibilities:
 * - Validate selected files.
 * - Emit a process event for the first valid .torrent file.
 * - Hide itself when loading, player, or error views are shown.
 */
export class Torrent {
  static SELECTOR = {
    dialog: "#torrent",
    form: "#torrent form",
    input: "#torrent__input"
  };

  static MESSAGES = {
    missingDomNodes: "Torrent component DOM nodes are missing.",
    wrongFileType: "Only .torrent files are accepted.",
    parseFailed: "Could not parse torrent file."
  };
  static AUDIO_EXTENSIONS = new Set([
    ".aac",
    ".ac3",
    ".alac",
    ".dts",
    ".eac3",
    ".flac",
    ".m4a",
    ".mp3",
    ".ogg",
    ".opus",
    ".wav"
  ]);
  static SUBTITLE_EXTENSIONS = new Set([
    ".ass",
    ".srt",
    ".ssa",
    ".sub",
    ".sup",
    ".ttml",
    ".vtt",
    ".webvtt"
  ]);

  #dialog;
  #form;
  #input;

  /** @param {SubmitEvent} event */
  #onFormSubmit = (event) => {
    event.preventDefault();
  };

  /** @param {MouseEvent} event */
  #onInputClick = (event) => {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) {
      return;
    }
    // Allow selecting the same file again after cancel/reopen cycles.
    input.value = "";
  };

  /** @param {Event} event */
  #onInputChange = (event) => {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) {
      return;
    }
    if (!input.files || input.files.length === 0) {
      return;
    }
    void this.#processIncomingFiles(input.files);
    input.value = "";
  };

  /** @param {DragEvent} event */
  #onDocumentDragOver = (event) => {
    if (!this.#isPickerOpen()) {
      return;
    }
    event.preventDefault();
  };

  /** @param {DragEvent} event */
  #onDocumentDrop = (event) => {
    if (!this.#isPickerOpen()) {
      return;
    }
    event.preventDefault();
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) {
      return;
    }
    void this.#processIncomingFiles(files);
  };

  /** @param {ClipboardEvent} event */
  #onDocumentPaste = (event) => {
    if (!this.#isPickerOpen()) {
      return;
    }
    const files = event.clipboardData?.files;
    if (!files || files.length === 0) {
      return;
    }
    void this.#processIncomingFiles(files);
  };

  #onErrorShow = () => {
    this.visible = false;
  };

  #onLoadingShow = () => {
    this.visible = false;
  };

  #onPlayerShow = () => {
    this.visible = false;
  };

  #onAppReset = () => {
    this.visible = true;
  };

  constructor() {
    this.#setupElements();
    this.#setupEventHandlers();
    this.#setupViewEventHandlers();
    this.visible = true;
  }

  #setupElements() {
    this.#dialog = document.querySelector(Torrent.SELECTOR.dialog);
    this.#form = document.querySelector(Torrent.SELECTOR.form);
    this.#input = document.querySelector(Torrent.SELECTOR.input);

    if (!this.#dialog || !this.#form || !this.#input) {
      throw new Error(Torrent.MESSAGES.missingDomNodes);
    }
  }

  #setupEventHandlers() {
    this.#form.addEventListener("submit", this.#onFormSubmit);
    this.#input.addEventListener("click", this.#onInputClick);
    this.#input.addEventListener("change", this.#onInputChange);
    document.addEventListener("dragover", this.#onDocumentDragOver);
    document.addEventListener("drop", this.#onDocumentDrop);
    document.addEventListener("paste", this.#onDocumentPaste);
  }

  #setupViewEventHandlers() {
    document.addEventListener(ERROR_EVENTS.SHOW, this.#onErrorShow);
    document.addEventListener(LOADING_EVENTS.SHOW, this.#onLoadingShow);
    document.addEventListener(PLAYER_EVENTS.SHOW, this.#onPlayerShow);
    document.addEventListener(APP_EVENTS.RESET_TO_PICKER, this.#onAppReset);
  }

  /**
   * @param {File} file
   * @returns {boolean}
   */
  #isTorrentFile(file) {
    const lowerName = file.name.toLowerCase();
    return lowerName.endsWith(".torrent") || file.type === "application/x-bittorrent";
  }

  /**
   * @param {FileList} files
   * @returns {File | null}
   */
  #pickFirstTorrentFile(files) {
    for (const file of files) {
      if (this.#isTorrentFile(file)) {
        return file;
      }
    }
    return null;
  }

  /**
   * @param {FileList | File[]} files
   * @returns {Promise<void>}
   */
  async #processIncomingFiles(files) {
    const torrentFile = this.#pickFirstTorrentFile(files);
    if (!torrentFile) {
      document.dispatchEvent(
        new CustomEvent(ERROR_EVENTS.SHOW, {
          detail: {
            title: "Error",
            description: Torrent.MESSAGES.wrongFileType
          }
        })
      );
      return;
    }

    try {
      const torrentBytes = new Uint8Array(await torrentFile.arrayBuffer());
      const meta = await parseTorrentBytes(torrentBytes);
      const mediaFiles = this.#extractMediaFiles(meta.files);
      this.visible = false;
      document.dispatchEvent(
        new CustomEvent(TORRENT_EVENTS.FILE_DETAILS_READY, {
          detail: {
            file: torrentFile,
            torrentBytes,
            meta,
            mediaFiles
          }
        })
      );
    } catch (_error) {
      document.dispatchEvent(
        new CustomEvent(ERROR_EVENTS.SHOW, {
          detail: {
            title: "Error",
            description: Torrent.MESSAGES.parseFailed
          }
        })
      );
      return;
    }
  }

  /**
   * @returns {boolean}
   */
  #isPickerOpen() {
    return this.#dialog.hasAttribute("open");
  }

  /**
   * @param {Array<{ index: number, name: string, path: string, relativePath: string, length: number, isVideo: boolean }>} files
   * @returns {{ video: Array<object>, audio: Array<object>, subtitles: Array<object> }}
   */
  #extractMediaFiles(files) {
    const video = [];
    const audio = [];
    const subtitles = [];
    for (const file of files) {
      const lowerPath = (typeof file.relativePath === "string" ? file.relativePath : file.path).toLowerCase();
      if (file.isVideo) {
        video.push(file);
        continue;
      }
      if (this.#hasExtension(lowerPath, Torrent.AUDIO_EXTENSIONS)) {
        audio.push(file);
        continue;
      }
      if (this.#hasExtension(lowerPath, Torrent.SUBTITLE_EXTENSIONS)) {
        subtitles.push(file);
      }
    }
    return { video, audio, subtitles };
  }

  /**
   * @param {string} lowerPath
   * @param {Set<string>} extensions
   * @returns {boolean}
   */
  #hasExtension(lowerPath, extensions) {
    for (const ext of extensions) {
      if (lowerPath.endsWith(ext)) {
        return true;
      }
    }
    return false;
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
}

function bootstrapTorrent() {
  new Torrent();
}

if (document.readyState !== "loading") {
  bootstrapTorrent();
} else {
  document.addEventListener("DOMContentLoaded", bootstrapTorrent, { once: true });
}
