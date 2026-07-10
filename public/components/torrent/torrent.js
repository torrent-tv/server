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
    input: "#torrent__input",
    magnetInput: "#torrent__magnet",
    demoButton: "#torrent__demo"
  };

  /**
   * Demo content for the picker button: Sintel (2010), an open movie by the
   * Blender Foundation, Creative Commons — legal to stream and to screenshot.
   * The magnet carries a webseed (webtorrent.io), so it starts even when the
   * swarm has few peers. Dead trackers trimmed from the canonical URI.
   */
  static DEMO_MAGNET =
    "magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel" +
    "&tr=udp%3A%2F%2Fexplodie.org%3A6969" +
    "&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337" +
    "&tr=wss%3A%2F%2Ftracker.btorrent.xyz" +
    "&tr=wss%3A%2F%2Ftracker.openwebtorrent.com" +
    "&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F" +
    "&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fsintel.torrent";

  static MESSAGES = {
    missingDomNodes: "Torrent component DOM nodes are missing.",
    wrongFileType: "Only .torrent files are accepted.",
    parseFailed: "Could not parse torrent file.",
    invalidMagnet: "That does not look like a magnet link."
  };

  /**
   * A COMPLETE magnet URI: requires the xt=urn:btih/btmh hash, so partial
   * manual typing ("magnet:?") never auto-starts the flow with garbage.
   */
  static MAGNET_RE = /^magnet:\?.*xt=urn:bt(?:ih|mh):[a-z0-9]{16,}/i;
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
  #magnetInput;
  #demoButton;

  /**
   * Demo button: route the demo magnet through the field + form — the single
   * magnet entry point (same path as paste/URL), so validation, field
   * clearing and the start flow stay identical.
   */
  #onDemoClick = () => {
    this.#magnetInput.setCustomValidity("");
    this.#magnetInput.value = Torrent.DEMO_MAGNET;
    this.#form.requestSubmit();
  };

  /** @param {SubmitEvent} event */
  #onFormSubmit = (event) => {
    event.preventDefault();
    this.#submitMagnetField();
  };

  /**
   * Auto-start on paste/typing: as soon as the field holds a COMPLETE magnet
   * URI, submit through the form (single entry point). Also clears a stale
   * custom-validity message from a previous failed attempt.
   */
  #onMagnetInput = () => {
    this.#magnetInput.setCustomValidity("");
    if (Torrent.MAGNET_RE.test(this.#magnetInput.value.trim())) {
      this.#form.requestSubmit();
    }
  };

  /** Start the magnet flow from the text field (button, Enter or auto-start). */
  #submitMagnetField() {
    const value = this.#magnetInput.value.trim();
    if (value.length === 0) {
      return;
    }
    if (!Torrent.MAGNET_RE.test(value)) {
      // Inline field message (Validation API) — a wrong paste must not rip
      // the user out of the picker into a full error screen.
      this.#magnetInput.setCustomValidity(Torrent.MESSAGES.invalidMagnet);
      this.#magnetInput.reportValidity();
      return;
    }
    this.#magnetInput.setCustomValidity("");
    // Consistent with the file input: the field clears once the flow starts
    // (an instant retry would not help a no-peers failure anyway).
    this.#magnetInput.value = "";
    this.#processMagnet(value);
  }

  /** @param {string} magnetUri */
  #processMagnet(magnetUri) {
    document.dispatchEvent(
      new CustomEvent(TORRENT_EVENTS.MAGNET_READY, {
        detail: { magnetUri }
      })
    );
  }

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
    if (files && files.length > 0) {
      void this.#processIncomingFiles(files);
      return;
    }
    // Paste INTO the field: let the native paste land and the input handler
    // auto-start. Everywhere else: react ONLY to text recognised as a magnet
    // (people paste all sorts of things — silence otherwise) by routing it
    // through the field + form, so the user sees what was accepted.
    if (event.target === this.#magnetInput) {
      return;
    }
    const text = (event.clipboardData?.getData("text") ?? "").trim();
    if (Torrent.MAGNET_RE.test(text)) {
      event.preventDefault();
      this.#magnetInput.value = text;
      this.#form.requestSubmit();
    }
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
    void this.#loadFromUrl();
  }

  async #loadFromUrl() {
    const params = new URLSearchParams(location.search);

    // Magnet link in the URL: ?magnet=<encoded magnet URI>. Routed through
    // the field + form like every other magnet entry point (the user sees
    // what arrived; garbage gets the inline validity message).
    const magnet = (params.get("magnet") ?? "").trim();
    if (magnet.length > 0) {
      params.delete("magnet");
      const search = params.toString();
      history.replaceState(null, "", search ? `?${search}` : location.pathname);
      this.#magnetInput.value = magnet;
      this.#form.requestSubmit();
      return;
    }

    const b64 = params.get("torrent");
    if (!b64) {
      return;
    }

    // Remove the parameter from the URL immediately, before any async work.
    params.delete("torrent");
    const newSearch = params.toString();
    history.replaceState(null, "", newSearch ? `?${newSearch}` : location.pathname);

    let bytes;
    try {
      const binary = atob(b64);
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
    } catch {
      document.dispatchEvent(
        new CustomEvent(ERROR_EVENTS.SHOW, {
          detail: { title: "Error", description: "Could not decode torrent from URL.", backEvent: APP_EVENTS.RESET_TO_PICKER }
        })
      );
      return;
    }

    const file = new File([bytes], "from-url.torrent", { type: "application/x-bittorrent" });
    await this.#processIncomingFiles([file]);
  }

  #setupElements() {
    this.#dialog = document.querySelector(Torrent.SELECTOR.dialog);
    this.#form = document.querySelector(Torrent.SELECTOR.form);
    this.#input = document.querySelector(Torrent.SELECTOR.input);
    this.#magnetInput = document.querySelector(Torrent.SELECTOR.magnetInput);
    this.#demoButton = document.querySelector(Torrent.SELECTOR.demoButton);

    if (!this.#dialog || !this.#form || !this.#input || !this.#magnetInput || !this.#demoButton) {
      throw new Error(Torrent.MESSAGES.missingDomNodes);
    }

    // iOS don't allow to select torrent file by with accept=".torrent,application/x-bittorrent"
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (isIOS) {
      this.#input.removeAttribute('accept');
    }
  }

  #setupEventHandlers() {
    this.#form.addEventListener("submit", this.#onFormSubmit);
    this.#magnetInput.addEventListener("input", this.#onMagnetInput);
    this.#demoButton.addEventListener("click", this.#onDemoClick);
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
            description: Torrent.MESSAGES.wrongFileType,
            backEvent: APP_EVENTS.RESET_TO_PICKER
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
            description: Torrent.MESSAGES.parseFailed,
            backEvent: APP_EVENTS.RESET_TO_PICKER
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
