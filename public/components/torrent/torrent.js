import { APP_EVENTS, ERROR_EVENTS, TORRENT_EVENTS } from "../../shared/events.js";
import { parseTorrentBytes } from "../../domain/torrent-parser.js";
import { APP_VIEW, viewForState } from "../../domain/app-state.js";
import { StateDerivedView } from "../../shared/state-derived-view.js";

/**
 * Torrent input view.
 *
 * Responsibilities:
 * - Validate selected files.
 * - Emit a process event for the first valid .torrent file.
 * - Hide itself when loading, player, or error views are shown.
 */
export class Torrent extends StateDerivedView {
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
   * Playback position (seconds) parsed from a shared `?…&currentTime=<sec>`
   * URL, consumed by the next source dispatch so the receiver seeks there once
   * playback starts. Null when the URL carried no `currentTime`. Named to match
   * `video.currentTime` — the same name is used across every layer. See
   * #loadFromUrl.
   * @type {number | null}
   */
  #pendingCurrentTime = null;

  /**
   * File index parsed from a shared `?…&fileIndex=<n>` URL — which file of a
   * multi-file torrent to open — consumed by the next source dispatch. Null
   * when the URL carried no `fileIndex`. See #loadFromUrl.
   * @type {number | null}
   */
  #pendingFileIndex = null;

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
    // Consume any pending position/file from a shared URL (one-shot).
    const currentTime = this.#pendingCurrentTime;
    const fileIndex = this.#pendingFileIndex;
    this.#pendingCurrentTime = null;
    this.#pendingFileIndex = null;
    document.dispatchEvent(
      new CustomEvent(TORRENT_EVENTS.MAGNET_READY, {
        detail: { magnetUri, currentTime, fileIndex }
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

  constructor() {
    super((state) => viewForState(state) === APP_VIEW.PICKER);
    this.#setupElements();
    this.#setupEventHandlers();
    this.visible = true;
    // Defer URL-source loading to the next macrotask so every other component
    // (torrent-tv, loading, player) has finished bootstrapping and registered
    // its event listeners first. Otherwise the MAGNET_READY / FILE_DETAILS_READY
    // dispatched from #loadFromUrl can fire before anyone listens, and a shared
    // link opens the picker instead of starting playback.
    setTimeout(() => { void this.#loadFromUrl(); }, 0);
  }

  async #loadFromUrl() {
    const params = new URLSearchParams(location.search);

    // Optional playback position (`&currentTime=<seconds>`) and file index
    // (`&fileIndex=<n>`) from a shared link, consumed by the next source
    // dispatch so the receiver opens the right file and seeks there.
    //
    // NEITHER IS DELETED FROM THE ADDRESS. They are state, exactly as the
    // magnet is — the note below records why the magnet stopped being wiped,
    // and the same reasoning was never applied to these two. Deleting them left
    // a window between the load and the first playhead write in which the
    // address named a torrent and nothing else: a refresh landing there found
    // no file to open and showed the playlist instead of resuming, and with a
    // single-file torrent it still demanded a choice. Reported from the field
    // 2026-08-09. The writer replaces these values as playback proceeds, so
    // keeping them costs nothing and closes the window.
    const currentTimeRaw = Number.parseInt(params.get("currentTime") ?? "", 10);
    this.#pendingCurrentTime = Number.isFinite(currentTimeRaw) && currentTimeRaw > 0 ? currentTimeRaw : null;

    const fileIndexRaw = Number.parseInt(params.get("fileIndex") ?? "", 10);
    this.#pendingFileIndex = Number.isFinite(fileIndexRaw) && fileIndexRaw >= 0 ? fileIndexRaw : null;

    // Magnet link in the URL: ?magnet=<encoded magnet URI>. Routed through
    // the field + form like every other magnet entry point (the user sees
    // what arrived; garbage gets the inline validity message).
    const magnet = (params.get("magnet") ?? "").trim();
    if (magnet.length > 0) {
      // The address is NOT wiped any more. It used to be, because the magnet
      // was treated as a one-shot input from a shared link — but the address
      // now carries the application's state, and blanking it meant a refresh
      // showed an empty address bar until playback started and put the magnet
      // back. Anything done in that window — a second refresh, a bookmark —
      // lost the torrent entirely.
      this.#magnetInput.value = magnet;
      this.#form.requestSubmit();
      return;
    }

    const torrentBase64 = params.get("torrent");
    if (!torrentBase64) {
      return;
    }

    // Remove the parameter from the URL immediately, before any async work.
    params.delete("torrent");
    const newSearch = params.toString();
    history.replaceState(null, "", newSearch ? `?${newSearch}` : location.pathname);

    let bytes;
    try {
      const binary = atob(torrentBase64);
      bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index);
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
      // Consume any pending position/file from a shared URL (one-shot).
      const currentTime = this.#pendingCurrentTime;
      const fileIndex = this.#pendingFileIndex;
      this.#pendingCurrentTime = null;
      this.#pendingFileIndex = null;
      this.visible = false;
      document.dispatchEvent(
        new CustomEvent(TORRENT_EVENTS.FILE_DETAILS_READY, {
          detail: {
            file: torrentFile,
            torrentBytes,
            meta,
            mediaFiles,
            currentTime,
            fileIndex
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
