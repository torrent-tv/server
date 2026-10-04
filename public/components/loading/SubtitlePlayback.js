import { appendCues, parseVttCues, removeCues } from "../../domain/vtt-cues.js";
import { ProviderSubtitles } from "./ProviderSubtitles.js";
import { providerSubtitleLabel } from "../../domain/provider-subtitles.js";
import { subtitleMenuItems, subtitleToggleKey } from "../../domain/subtitle-menu.js";
import { readCoverage, describeCoverage } from "../../domain/subtitle-coverage.js";
import {
  buildSubtitleLabel,
  containerDefaultSubtitleIndex
} from "../../domain/subtitle-utils.js";
import { trackIdentity, sameTrackIdentity, findTrackByIdentity } from "../../domain/track-memory.js";
import { trackLanguageTag, trackLanguageCode, languageName } from "../../domain/track-language.js";

import { MEDIA_INFO_EVENTS, PLAYER_EVENTS } from "../../shared/events.js";

const EMBEDDED_SUBTITLE_TIMEOUT_MS = 10 * 60_000;
const SUBTITLE_POLL_INTERVAL_MS = 5_000;
const TRACK_READY_STATE_LOADED = 2;
const TRACK_READY_STATE_ERROR = 3;
const TRACK_ARM_TIMEOUT_MS = 5_000;

/**
 * Where a file beside the picture lies, for a log line.
 *
 * The proxy states the folders relative to the torrent root and the file's own
 * name; a path is those joined, and there is no second place that joins them.
 *
 * @param {{ folders?: string[], name?: string }} sidecar
 * @returns {string}
 */
function subtitlePath(sidecar) {
  const folders = Array.isArray(sidecar?.folders) ? sidecar.folders : [];
  const name = typeof sidecar?.name === "string" ? sidecar.name : "";
  return [...folders, name].filter((part) => part.length > 0).join("/");
}

function isAbortError(error) {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

/** Owns subtitle tracks, fetched files, cue delivery, and the viewer's choice. */
export class SubtitlePlayback {
  #getVideoElement;
  #getTransport;
  #getFiles;
  #registerSourceOnProxy;
  #getAbortSignal;
  #getConsumerId;
  #logEvent;
  #subtitleFiles = [];
  #planTracks = { subtitles: [], sidecarSubtitles: [] };
  /**
   * Every track the subtitle menu offers, by the key its item carries — for
   * the life of the track, whatever its label becomes. `planIndex` is its index
   * among the plan's subtitle tracks, null for a subtitle FILE.
   *
   * @type {Map<string, { textTrack: TextTrack, planIndex: number | null }>}
   */
  #menuEntries = new Map();
  /** @type {string | null} The key the viewer chose last in this file. */
  #lastChosenKey = null;
  /**
   * The cues each track holds, by the found-order number the proxy gave them,
   * so a cue it takes back can be removed while the track is disabled.
   *
   * @type {Map<TextTrack, Map<string, VTTCue>>}
   */
  #cuesById = new Map();
  /** @type {string[]} Blob URLs created for active subtitle tracks; revoked on cleanup. */
  #subtitleBlobUrls = [];
  /**
   * The `TextTrack` each embedded subtitle track owns, by its index in the
   * source. A `<track>` element created here has no `src`, so it cannot be
   * found again by URL, and the element order is not the source's track order
   * once external subtitle files are attached alongside.
   *
   * @type {Map<number, TextTrack>}
   */
  #embeddedTextTracks = new Map();
  /**
   * The `<track>` ELEMENT each embedded subtitle track owns, by the same index.
   * Kept beside the `TextTrack` above because a label can only be changed on the
   * element — `TextTrack.label` is read-only — and the label does change: a
   * track whose language nothing states is labelled Unknown until enough of it
   * has downloaded for the reading to mean anything (`#refineSubtitleLabel`).
   *
   * @type {Map<number, HTMLTrackElement>}
   */
  #embeddedTrackElements = new Map();
  /**
   * The tracks whose language the CONTAINER states. Their labels are never
   * moved by anything read off the text: what the file says about itself was
   * written by the person who made it, and a reading of the cues is a guess.
   *
   * @type {Set<number>}
   */
  #namedSubtitleTracks = new Set();
  /**
   * Which set of subtitle tracks is the current one. Incremented whenever the
   * tracks are cleared — a new file, a new torrent — so that a seed fetch
   * still in flight from the previous set can tell that everything it holds is
   * stale and leave the shared state alone.
   *
   * The `<video>` element survives a file switch, and so do its listeners and
   * any pending timer; without this a seed for the previous episode wrote its
   * read position over the current one's, under the same track index.
   *
   * @type {number}
   */
  #subtitleEpoch = 0;
  /**
   * What the text-track listener needs to follow a track the viewer turns on:
   * the transport, the source and the file being watched RIGHT NOW.
   *
   * Held as a field rather than captured by the listener, because the listener
   * outlives any one file — it belongs to the `<video>` element — and a
   * captured `fileIndex` would have it asking for the previous episode's
   * subtitles.
   *
   * @type {{ transport: object, sourceKey: string, fileIndex: number } | null}
   */
  #subtitleContext = null;
  /**
   * The same for subtitles, with one more state: `{ off: true }`, the viewer
   * having turned them off. Off has to be remembered as a choice of its own,
   * or the next episode's container default would put subtitles back on
   * somebody who has just said they do not want them.
   *
   * @type {{ code: string, releaser: string | null } | { off: true } | null}
   */
  #rememberedSubtitle = null;
  /**
   * What each text track IS, kept beside the track itself because the change
   * event names the tracks and nothing else. Weak, so a track element removed
   * with its episode takes its entry with it.
   *
   * @type {WeakMap<TextTrack, { code: string, releaser: string | null } | null>}
   */
  #subtitleIdentities = new WeakMap();
  /**
   * Which track this component last put at `showing`, so that a change to
   * anything else is known to be the VIEWER's and not the echo of our own
   * write. `null` means we last left every track off.
   *
   * @type {TextTrack | null}
   */
  #subtitleShowingWeApplied = null;
  /** @type {boolean} Whether the text-track `change` listener is registered. */
  #subtitleModesWatched = false;
  /**
   * How far each embedded track has been read, in the proxy's found-order
   * count, by the track's index in the source. Sent back as `?since=` when the
   * page has to ask again — after a reconnect, which loses the subscription the
   * pushes ride on — so the answer carries only what this page does not have.
   *
   * @type {Map<number, number>}
   */
  #subtitleCursors = new Map();
  /**
   * When each track RAN OUT — the moment it was first seen holding nothing at
   * or after the position being played. That is the wait the viewer feels, and
   * it is not the same as how long the track has been switched on: a track
   * turned on twenty minutes ago and starved two seconds ago has waited two
   * seconds.
   *
   * @type {Map<TextTrack, number>}
   */
  #subtitleStarvedAt = new Map();
  /**
   * The cues each track already holds, by what they are — see `appendCues`.
   * `track.cues` cannot serve: it reads null while the mode is `disabled`,
   * which is most of the time for most tracks.
   *
   * @type {Map<TextTrack, Set<string>>}
   */
  #subtitleCueKeys = new Map();
  /** @type {boolean} Whether a re-subscription is already in flight. */
  #subtitleResubscribing = false;
  /**
   * The plan indices whose track element has finished its own load and can be
   * given cues without losing them — see `#armThenFeed`.
   *
   * @type {Set<number>}
   */
  #subtitleArmed = new Set();
  /**
   * Cues pushed for a track that is still being armed, by plan index. A push
   * carries what the proxy has just READ and never repeats it, so dropping one
   * would lose those lines for the session.
   *
   * @type {Map<number, object[][]>}
   */
  #pendingCues = new Map();
  /**
   * The last coverage signature printed for each track, so a reading that says
   * nothing new is not printed again.
   *
   * @type {Map<TextTrack, string>}
   */
  #subtitleReported = new Map();
  /**
   * The once-a-second coverage reading, running only while a showing track has
   * no cue for the position being played.
   *
   * @type {ReturnType<typeof setInterval> | null}
   */
  #subtitleCoverageTimer = null;
  #providers;
  #providerEntries = new Map();
  #providerStatuses = [];
  #providerAbort = null;
  #providerSelection = 0;
  constructor({ getVideoElement, getTransport, getFiles, registerSourceOnProxy, getAbortSignal, getConsumerId, logEvent }) {
    this.#getVideoElement = getVideoElement;
    this.#getTransport = getTransport;
    this.#getFiles = getFiles;
    this.#registerSourceOnProxy = registerSourceOnProxy;
    this.#getAbortSignal = getAbortSignal;
    this.#getConsumerId = getConsumerId;
    this.#logEvent = logEvent;
    this.#providers = new ProviderSubtitles((items, statuses) => this.#offerProviders(items, statuses));
  }

  setTorrentSubtitleFiles(files) {
    this.#subtitleFiles = Array.isArray(files) ? files : [];
  }

  setPlan({ subtitleTracks = [], sidecarSubtitles = [] } = {}) {
    this.#planTracks = { subtitles: subtitleTracks, sidecarSubtitles };
  }

  /**
   * Remove all subtitle `<track>` elements from the video element and revoke
   * any Blob URLs that were created for them.
   */
  clear() {
    this.#providers.clear();
    this.#providerAbort?.abort();
    this.#providerSelection++;
    this.#providerEntries.clear();
    this.#providerStatuses = [];
    for (const url of this.#subtitleBlobUrls) {
      URL.revokeObjectURL(url);
    }
    this.#subtitleBlobUrls = [];
    // The tracks are going, so what was read of them goes with them. A seed
    // fetch still in flight belongs to the epoch being left behind: it checks
    // the epoch on its next step and leaves, touching none of the state the
    // next set of tracks is already using. A push arriving late for it is
    // dropped the same way, by `#onSubtitleCuesPush`'s own fileIndex check.
    //
    // The listener on the text tracks is deliberately NOT removed: it belongs
    // to the `<video>` element, which survives a file switch, and it reads the
    // current file from `#subtitleContext` rather than from a closure.
    this.#subtitleEpoch += 1;
    this.#menuEntries.clear();
    this.#lastChosenKey = null;
    this.#cuesById.clear();
    this.#embeddedTextTracks.clear();
    this.#embeddedTrackElements.clear();
    this.#namedSubtitleTracks.clear();
    // What WE last showed belonged to the file being left. Carrying it into the
    // next one would make the first change event there — where nothing is
    // showing yet — read as the viewer turning subtitles off, and wipe the very
    // choice this is meant to carry. The remembered choice itself is NOT reset:
    // that is the point of it.
    this.#subtitleShowingWeApplied = null;
    this.#subtitleContext = null;
    this.#subtitleCursors.clear();
    this.#subtitleStarvedAt.clear();
    this.#subtitleCueKeys.clear();
    this.#subtitleArmed.clear();
    this.#pendingCues.clear();
    this.#subtitleReported.clear();
    this.#subtitleResubscribing = false;
    this.#stopSubtitleCoverageWatch();
    if (this.#getVideoElement() instanceof HTMLVideoElement) {
      for (const track of Array.from(this.#getVideoElement().querySelectorAll("track"))) {
        track.remove();
      }
    }
    this.#publishMenu();
  }

  /**
   * Turn on the track a menu item names, and every other one off; "" turns
   * them all off.
   *
   * The `change` this causes is read by `#rememberSubtitleChoice` as the
   * viewer's own choice, which it is.
   *
   * @param {string} key
   * @returns {void}
   */
  select(key) {
    if (typeof key === "string" && key.includes(":status:")) { this.#providers.retry(); return; }
    const selection = ++this.#providerSelection;
    this.#providerAbort?.abort();
    const provider = this.#providerEntries.get(key);
    if (provider && !provider.loaded) {
      const abort = new AbortController();
      this.#providerAbort = abort;
      void this.#loadProvider(key, provider, selection, abort);
      return;
    }
    const chosen = typeof key === "string" && this.#menuEntries.has(key) ? key : "";
    if (chosen) {
      this.#lastChosenKey = chosen;
    }
    if (!chosen) this.#rememberedSubtitle = { off: true };
    for (const [entryKey, entry] of this.#menuEntries) {
      const wanted = entryKey === chosen ? "showing" : "disabled";
      if (entry.textTrack.mode !== wanted) {
        entry.textTrack.mode = wanted;
      }
    }
    this.#logEvent(chosen ? `subtitles: the viewer chose ${chosen}` : "subtitles: the viewer turned them off");
    this.#publishMenu();
    this.#reportSubtitleCoverage("menu choice");
  }

  /**
   * The subtitles key: off if anything is showing, otherwise on — the track
   * chosen last in this file, else the one this file would open with, else the
   * first.
   *
   * @returns {void}
   */
  toggle() {
    let preferredKey = null;
    for (const [key, entry] of this.#menuEntries) {
      if (this.#subtitleShouldShow(entry.textTrack, entry.planIndex)) {
        preferredKey = key;
        break;
      }
    }
    this.select(subtitleToggleKey({
      entries: this.#menuEntriesNow(),
      lastChosenKey: this.#lastChosenKey,
      preferredKey
    }));
  }

  /**
   * Offer one more track in the menu.
   *
   * @param {string} key
   * @param {TextTrack} textTrack
   * @param {number | null} planIndex
   * @returns {void}
   */
  #addMenuEntry(key, textTrack, planIndex) {
    this.#menuEntries.set(key, { textTrack, planIndex });
    this.#publishMenu();
  }

  /** @returns {Array<{ key: string, label: string, showing: boolean }>} */
  #menuEntriesNow() {
    const rank = key => key.includes(":embedded:") ? 0 : key.includes(":sidecar:") ? 1 : 2;
    return [...this.#menuEntries].sort(([a], [b]) => rank(a) - rank(b)).map(([key, entry]) => ({
      key,
      label: entry.textTrack.label,
      showing: entry.textTrack.mode === "showing"
    }));
  }

  /**
   * Tell the player what the menu holds now. Said whenever a track is added
   * or removed, a label changes, or a mode does — the menu is drawn from this
   * and from nothing else.
   *
   * @returns {void}
   */
  #publishMenu() {
    document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.SET_SUBTITLE_TRACKS, {
      detail: { items: [...subtitleMenuItems(this.#menuEntriesNow()), ...this.#providerStatuses] }
    }));
  }

  /**
   * @param {TextTrack} track
   * @returns {Map<string, VTTCue>}
   */
  #cueIdsOf(track) {
    let ids = this.#cuesById.get(track);
    if (!ids) {
      ids = new Map();
      this.#cuesById.set(track, ids);
    }
    return ids;
  }

  /**
   * Find subtitle files that match `fileIndex`, download each one through the
   * proxy transport, convert to WebVTT, and attach as `<track>` elements on the
   * video element.
   *
   * Fire-and-forget — call with `void … .catch(…)`.  Silently skips individual
   * subtitle files that fail to load; throws only on AbortError.
   *
   * No-op when:
   * - No proxy transport is available (webseed-only playback).
   * - No subtitle files were parsed for this torrent.
   * - No subtitle files match the selected video.
   *
   * @param {number} fileIndex
   * @returns {Promise<void>}
   */
  async loadForVideo(fileIndex) {
    this.clear();
    this.#providers.start(fileIndex);

    const transport = this.#getTransport();
    if (!transport) {
      return; // webseed-only — no proxy to fetch subtitles from
    }
    if (!(this.#getVideoElement() instanceof HTMLVideoElement)) {
      return;
    }

    let sourceKey;
    try {
      sourceKey = await this.#registerSourceOnProxy(transport);
    } catch (e) {
      console.warn("[torrent-tv][subtitles] could not obtain sourceKey:", e);
      return;
    }

    this.#loadEmbeddedSubtitles(fileIndex, transport, sourceKey);
    await this.#loadExternalSubtitles(fileIndex, transport, sourceKey);
  }

  #offerProviders(items, statuses) {
    const video = this.#getVideoElement();
    if (!(video instanceof HTMLVideoElement)) return;
    for (const entry of this.#providerEntries.values()) {
      // A metadata refinement may start a new query. Keep a selected provider
      // track until the viewer changes it, but remove unselected old offers.
      if (entry.element.track.mode === "showing") continue;
      entry.element.remove();
      this.#menuEntries.delete(entry.key);
      this.#providerEntries.delete(entry.key);
    }
    const epoch = this.#subtitleEpoch;
    for (const item of items) {
      const key = `${epoch}:provider:${item.provider}:${item.id}`;
      if (this.#providerEntries.has(key)) continue;
      const element = document.createElement("track");
      element.kind = "subtitles";
      element.label = providerSubtitleLabel(item);
      element.srclang = item.language;
      video.appendChild(element);
      element.track.mode = "disabled";
      this.#providerEntries.set(key, { key, item, element, loaded: false });
      this.#addMenuEntry(key, element.track, null);
      // Provider variants without a confirmed translation identity must not
      // impersonate an embedded track of the same language on the next episode.
      this.#subtitleIdentities.set(element.track, null);
    }
    this.#providerStatuses = statuses.filter(p => ["unavailable", "partial", "ambiguous"].includes(p.status)).map(p => ({
      key: `${epoch}:status:${p.provider}`, text: `${p.provider}: ${p.status === "partial" ? "showing partial results" : "search unavailable — retry"}`, checked: false, disabled: p.status === "partial"
    }));
    this.#watchSubtitleModes();
    this.#publishMenu();
  }

  async #loadProvider(key, entry, selection, abort) {
    const epoch = this.#subtitleEpoch;
    const label = providerSubtitleLabel(entry.item);
    entry.element.label = `${label} (loading)`;
    this.#publishMenu();
    try {
      const vtt = await this.#providers.load(entry.item, abort.signal);
      if (epoch !== this.#subtitleEpoch || selection !== this.#providerSelection || abort.signal.aborted || this.#providerEntries.get(key) !== entry) return;
      const url = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
      this.#subtitleBlobUrls.push(url);
      await new Promise((resolve, reject) => {
        const element = entry.element;
        const finish = error => {
          clearTimeout(timer);
          element.removeEventListener("load", onLoad);
          element.removeEventListener("error", onError);
          abort.signal.removeEventListener("abort", onAbort);
          error ? reject(error) : resolve();
        };
        const onLoad = () => finish();
        const onError = () => finish(new Error("subtitle track could not load"));
        const onAbort = () => finish(new Error("subtitle selection cancelled"));
        const timer = setTimeout(onError, 5000);
        element.addEventListener("load", onLoad, { once: true });
        element.addEventListener("error", onError, { once: true });
        abort.signal.addEventListener("abort", onAbort, { once: true });
        element.src = url;
        element.track.mode = "hidden";
      });
      if (epoch !== this.#subtitleEpoch || selection !== this.#providerSelection || abort.signal.aborted || this.#providerEntries.get(key) !== entry) return;
      entry.loaded = true;
      entry.element.label = label;
      this.select(key);
    } catch (error) {
      if (epoch !== this.#subtitleEpoch) return;
      entry.element.label = abort.signal.aborted ? label : `${label} (unavailable)`;
      if (!abort.signal.aborted) console.warn("[subtitles] selected provider file unavailable", error);
      this.#publishMenu();
    }
  }

  /**
   * Read the proxy's detected language from a subtitle response's
   * `X-Subtitle-Language` / `X-Subtitle-Language-Name` headers.
   *
   * @param {{ headers: { get: (name: string) => string | null } }} response
   * @returns {{ code: string, name: string } | null}
   */
  #languageFromHeader(response) {
    const code = response.headers.get("x-subtitle-language");
    if (!code) {
      return null;
    }
    const rawName = response.headers.get("x-subtitle-language-name");
    let name = "";
    if (rawName) {
      try {
        name = decodeURIComponent(rawName);
      } catch {
        // silent-ok: a name that is not valid percent-encoding is used as it
        // stands — which is what the tracker or the viewer actually supplied.
        name = rawName;
      }
    }
    return { code, name: name || languageName(code) || code };
  }

  /** English display name for a language code, or "" when unavailable. */

  /**
   * External subtitle FILES from the torrent (matched to the video by name).
   *
   * @returns {Promise<boolean>} Whether at least one track was attached.
   */
  async #loadExternalSubtitles(fileIndex, transport, sourceKey) {
    if (this.#subtitleFiles.length === 0) {
      return false;
    }
    const files = this.#getFiles();
    if (!Array.isArray(files)) {
      return false;
    }
    const videoFile = files[fileIndex];
    if (!videoFile) {
      return false;
    }

    // Paired by the proxy, in the torrent layer, where "the file next to this
    // one" is a notion that exists at all. This side reads none of it: it used
    // to pair again with a rule of its own, and the two answers differed.
    const matched = this.#planTracks.sidecarSubtitles ?? [];
    if (matched.length === 0) {
      return false;
    }

    let added = false;
    // The set of tracks these belong to — see `#loadEmbeddedSubtitles`, which
    // carries the reason. Each file here costs a fetch, so this loop is
    // suspended across a file switch just as that one is.
    const epoch = this.#subtitleEpoch;
    for (const sub of matched) {
      if (epoch !== this.#subtitleEpoch) {
        return added;
      }
      try {
        // The proxy converts (.srt/.ass → WebVTT), decodes the file's encoding
        // (UTF-8/Windows-1251) and detects the language from the full text,
        // returning it in X-Subtitle-Language. The browser no longer converts.
        const response = await transport.fetch(
          `/api/subtitles?sourceKey=${encodeURIComponent(sourceKey)}&fileIndex=${sub.fileIndex}`,
          { signal: this.#getAbortSignal(), timeoutMs: EMBEDDED_SUBTITLE_TIMEOUT_MS }
        );
        if (!response.ok) {
          console.warn(
            `[torrent-tv][subtitles] fetch failed (${response.status}) for`,
            subtitlePath(sub)
          );
          continue;
        }

        const vtt = await response.text();
        if (epoch !== this.#subtitleEpoch) {
          return added;
        }
        if (!vtt || !vtt.startsWith("WEBVTT")) {
          continue;
        }

        document.dispatchEvent(new CustomEvent(MEDIA_INFO_EVENTS.SUBTITLE_EVIDENCE, { detail: { fileIndex, vtt: vtt.slice(0, 16384) } }));
        const blob = new Blob([vtt], { type: "text/vtt" });
        const blobUrl = URL.createObjectURL(blob);
        this.#subtitleBlobUrls.push(blobUrl);

        // Language priority: explicit code in the filename (author intent) →
        // proxy content detection (franc) → und. The film's audio language is
        // NOT a source: subtitles are usually a translation of the sound, so
        // its language is the least likely one for them, and a label taken
        // from it was a guess shown as a fact ("Japanese" on an English track,
        // field 2026-10-01).
        //
        // The first of the three is read by the proxy now, by the same grammar
        // that decided this file belongs to this picture. Nothing is re-read
        // here: a label built from a second reading of the same name is how the
        // two sides came to disagree.
        const info = {
          code: sub.naming?.code ?? "und",
          name: sub.naming?.name ?? null,
          group: sub.naming?.releaser ?? null,
          isForced: sub.naming?.isForced === true,
          isHearingImpaired: sub.naming?.isHearingImpaired === true
        };
        if (info.code === "und") {
          const detected = this.#languageFromHeader(response);
          if (detected) {
            info.code = detected.code;
            info.name = detected.name;
          }
        }
        const label = buildSubtitleLabel(info);

        const track = document.createElement("track");
        track.kind = "subtitles";
        track.label = label;
        track.srclang = info.code;
        track.src = blobUrl;
        // No `default`. A subtitle FILE lying beside the video says nothing
        // about whether the viewer wants subtitles — only the container can say
        // that, and it is read in `#applySubtitleModes`. This element does have
        // a `src`, so unlike an embedded track the browser really would turn it
        // on by itself, which is half of what put three languages on screen at
        // once (field 2026-08-20).
        this.#getVideoElement().appendChild(track);
        // What this track IS, for carrying a choice of it to the next episode.
        this.#subtitleIdentities.set(track.track, trackIdentity({ code: info.code, releaser: info.group }));
        this.#addMenuEntry(`${epoch}:sidecar:${sub.fileIndex}`, track.track, null);
        // A subtitle FILE is never the container's choice, so `null` — and the
        // mode reading is registered here too, because a video with only
        // external files never reaches the embedded loader at all.
        this.#watchSubtitleModes();
        this.#applySubtitleMode(track.track, null, epoch);
        added = true;
        console.debug(
          `[torrent-tv][subtitles] loaded "${label}" (${info.code}) from`,
          subtitlePath(sub)
        );
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          throw e;
        }
        console.warn(
          "[torrent-tv][subtitles] error loading",
          subtitlePath(sub),
          e
        );
      }
    }
    return added;
  }

  /**
   * Embedded TEXT subtitle tracks (inside the MKV/MP4). Every declared track
   * gets its `<track>` element and its place in `#embeddedTextTracks`
   * immediately, in one pass — the container already says how many there are
   * and what language each claims, so none of that needs a round trip.
   *
   * Cues come later and by three routes, all of them through `#deliverCues`
   * and none of them before the element has been ARMED (`#armThenFeed`, which
   * carries the reason): a one-off seed per track for whatever the proxy has
   * already read; pushes as the proxy reads more (`#onSubtitleCuesPush`),
   * never polled for; and a re-subscription after a reconnect, which asks only
   * for what this page missed.
   */
  #loadEmbeddedSubtitles(fileIndex, transport, sourceKey) {
    // `isEnabled` is FlagEnabled read from the container: "Set to 1 if the track
    // is usable." ffmpeg keeps such a track and numbers it, so it still holds
    // its place in `0:s:N` — it is simply never offered.
    const tracks = (this.#planTracks?.subtitles ?? []).filter(
      (t) => t?.textBased === true && t?.isEnabled !== false
    );
    if (tracks.length === 0) {
      return;
    }
    // The set of tracks this loader belongs to. A seed fetch below may still
    // be in flight when a viewer picks another episode; without this it would
    // resolve into the new file's `#embeddedTextTracks` under the old track
    // index, or set `#subtitleContext` back to the file just left.
    const epoch = this.#subtitleEpoch;
    this.#subtitleContext = { transport, sourceKey, fileIndex };
    this.#watchSubtitleModes();

    for (const track of tracks) {
      const el = document.createElement("track");
      el.kind = "subtitles";
      const fallbackLang = trackLanguageCode(trackLanguageTag(track));
      el.label = buildSubtitleLabel({
        code: fallbackLang || "und",
        name: languageName(fallbackLang) || "Unknown",
        group: typeof track.title === "string" && track.title.trim() ? track.title.trim() : null,
        isForced: track.isForced === true,
        isHearingImpaired: track.isHearingImpaired === true
      });
      el.srclang = fallbackLang || "und";
      this.#getVideoElement().appendChild(el);
      this.#embeddedTextTracks.set(track.index, el.track);
      this.#embeddedTrackElements.set(track.index, el);
      this.#addMenuEntry(`${epoch}:embedded:${track.index}`, el.track, track.index);
      // What this track IS, for carrying a choice of it to the next episode.
      // Corrected in `#refineSubtitleLabel` if the container said nothing and
      // the cues answer later.
      this.#subtitleIdentities.set(el.track, trackIdentity({
        code: fallbackLang,
        releaser: typeof track.title === "string" && track.title.trim() ? track.title.trim() : null
      }));
      if (fallbackLang && fallbackLang !== "und") {
        this.#namedSubtitleTracks.add(track.index);
      }

      void this.#armThenFeed({ track, el, fileIndex, transport, sourceKey, epoch });
    }
  }

  /**
   * Make a track element safe to add cues to, then start feeding it.
   *
   * **This is what made subtitles appear "some time later"**, measured
   * 2026-08-27 (`research/subtitle-delay-2026-08-26.md`). A `<track>` element
   * runs its own load algorithm the first time its mode leaves `disabled` —
   * which is the exact moment the viewer switches the track on. The element had
   * no `src`, so that load FAILED, and a failed load empties the cue list: the
   * field session held 90 cues spanning the playhead at the instant of the
   * switch and 3 cues four seconds later, all of them from pushes that arrived
   * afterwards. From then on the track only ever holds what the walk finds
   * ahead of the viewer, so nothing is ever drawn where they are.
   * Reproduced in Chrome, five cues added to each of two tracks: an element
   * with no `src` read `cues=5` before the switch and `cues=0` one task after
   * it (`readyState=3`), while a track carrying an empty but valid WebVTT
   * document kept all five across that switch and a second one.
   *
   * So the element is given a document: `WEBVTT` and nothing else. The load
   * succeeds once, the readiness state settles at loaded, the algorithm never
   * runs again, and cues added afterwards stay. It is started here rather than
   * on the viewer's click, by putting the mode at `hidden` — which draws
   * nothing — so the one load happens while the file is being opened.
   *
   * Why not `video.addTextTrack`, which owns no element and has no load
   * algorithm at all: a track made that way cannot be taken OUT of
   * `video.textTracks` — there is no removal API — so every episode switch
   * would leave its tracks in the captions menu for as long as the page lives.
   * A `<track>` element is removable, and its label can still be corrected once
   * the language is detected; both matter here.
   *
   * @param {{ track: object, el: HTMLTrackElement, fileIndex: number, transport: object, sourceKey: string, epoch: number }} params
   * @returns {Promise<void>}
   */
  async #armThenFeed({ track, el, fileIndex, transport, sourceKey, epoch }) {
    await this.#armTrackElement(el);
    if (epoch !== this.#subtitleEpoch) {
      return;
    }
    this.#subtitleArmed.add(track.index);
    // Only now: `#applySubtitleMode` may put this track at `showing`, and until
    // the load has settled that is the very thing that empties it.
    this.#applySubtitleMode(el.track, track.index, epoch);
    this.#flushPendingCues(track.index, el.track);
    await this.#seedEmbeddedTrack({ track, el, fileIndex, transport, sourceKey, epoch });
  }

  /**
   * Give one track element an empty WebVTT document and wait for it to load.
   *
   * @param {HTMLTrackElement} el
   * @returns {Promise<void>} Resolves when the load has settled either way.
   */
  #armTrackElement(el) {
    const blobUrl = URL.createObjectURL(new Blob(["WEBVTT\n\n"], { type: "text/vtt" }));
    this.#subtitleBlobUrls.push(blobUrl);
    el.src = blobUrl;
    // The load algorithm does not start while the mode is `disabled`, and
    // `hidden` renders nothing — so this arms the element without putting
    // anything on screen.
    el.track.mode = "hidden";
    return new Promise((resolve) => {
      if (el.readyState === TRACK_READY_STATE_LOADED || el.readyState === TRACK_READY_STATE_ERROR) {
        resolve();
        return;
      }
      const settle = () => {
        el.removeEventListener("load", settle);
        el.removeEventListener("error", settle);
        window.clearTimeout(timer);
        resolve();
      };
      // A watchdog, not a measurement: the document is a few bytes already in
      // memory, so this cannot legitimately take any time at all. If the event
      // never comes, feeding the track is a better failure than never showing
      // a subtitle again.
      const timer = window.setTimeout(settle, TRACK_ARM_TIMEOUT_MS);
      el.addEventListener("load", settle);
      el.addEventListener("error", settle);
    });
  }

  /**
   * Add the cues that arrived while a track was still being armed.
   *
   * @param {number} planIndex
   * @param {TextTrack} textTrack
   * @returns {void}
   */
  #flushPendingCues(planIndex, textTrack) {
    const waiting = this.#pendingCues.get(planIndex);
    if (!waiting || waiting.length === 0) {
      return;
    }
    this.#pendingCues.delete(planIndex);
    let added = 0;
    for (const cues of waiting) {
      added += appendCues(textTrack, cues, this.#cueKeysOf(textTrack), this.#cueIdsOf(textTrack)).added;
    }
    console.debug(
      `[torrent-tv][subtitles] track ${planIndex}: +${added} cue(s) held while the track was being armed`
    );
    // This can be the largest batch of the session, and it lands at the moment
    // the track becomes usable — which is exactly when the reading is worth
    // taking.
    this.#reportSubtitleCoverage(`armed track ${planIndex}`);
  }

  /**
   * Put cues into a track — or hold them if its element has not finished its
   * own load, which would empty the list from under them.
   *
   * Every route in goes through here: the seed, the push, and the
   * re-subscription after a reconnect. The last one is why it exists as one
   * function rather than a check inside the push handler — a reconnect landing
   * inside the arm window would otherwise write straight into a track whose
   * load is still in flight, and cues lost that way cannot be recovered: their
   * keys stay in the record of what the track holds, so nothing would ever
   * deliver them again.
   *
   * @param {number} planIndex
   * @param {TextTrack} textTrack
   * @param {object[]} cues
   * @returns {{ added: number, held: boolean }}
   */
  #deliverCues(planIndex, textTrack, cues) {
    if (!Array.isArray(cues) || cues.length === 0) {
      return { added: 0, held: false };
    }
    if (!this.#subtitleArmed.has(planIndex)) {
      const waiting = this.#pendingCues.get(planIndex) ?? [];
      waiting.push(cues);
      this.#pendingCues.set(planIndex, waiting);
      return { added: 0, held: true };
    }
    return { ...appendCues(textTrack, cues, this.#cueKeysOf(textTrack), this.#cueIdsOf(textTrack)), held: false };
  }

  /**
   * Keep the furthest found-order position this page has been told about. A
   * seed's answer and a push can arrive in either order, and a cursor that went
   * backwards would have the next re-subscription ask for cues already held.
   *
   * @param {number} planIndex
   * @param {number} cursor
   * @returns {void}
   */
  #rememberCursor(planIndex, cursor) {
    const known = this.#subtitleCursors.get(planIndex);
    if (!Number.isInteger(known) || cursor > known) {
      this.#subtitleCursors.set(planIndex, cursor);
    }
  }

  /**
   * Fetch whatever cues the proxy has already read for one track, once. Not
   * followed up on: everything after this comes from `#onSubtitleCuesPush`.
   * Kept separate from `#loadEmbeddedSubtitles` so every track's element
   * exists before any of these resolve, in whatever order they do.
   *
   * @param {{ track: object, el: HTMLElement, fileIndex: number, transport: object, sourceKey: string, epoch: number }} params
   * @returns {Promise<void>}
   */
  async #seedEmbeddedTrack({ track, el, fileIndex, transport, sourceKey, epoch, since = null }) {
    try {
      // The proxy prepares an embedded track in the background and answers
      // 202 until it is ready — the fallback extraction path, for a container
      // this side cannot read cluster-by-cluster, makes ffmpeg read the whole
      // film. Measured 2026-08-19, one track produced 3040 bytes over 752
      // seconds; asking again is free, the answer is kept once it exists.
      // Everything this page does not already hold. `since` is HANDED IN, never
      // read here: a push landing between the element being created and its
      // load settling would otherwise move the cursor forward before the first
      // seed had asked anything, and the seed would then skip every cue the
      // proxy read before that push — the whole opening stretch of the track,
      // silently. On a first seed it is null; on a re-subscription after a
      // reconnect it is where this page left off, so only what arrived while
      // the channel was gone comes back.
      // The consumer id is what subscribes this VIEWER to pushed cues for this
      // file. The proxy used to infer the subscriber from the channel the
      // request arrived on, which meant a reconnect silently lost subtitles for
      // the rest of the session; named here, the subscription outlives the
      // channel.
      const url = `/api/subtitles?sourceKey=${encodeURIComponent(sourceKey)}` +
        `&fileIndex=${fileIndex}&trackIndex=${track.index}` +
        `&consumerId=${encodeURIComponent(this.#getConsumerId())}` +
        (Number.isInteger(since) ? `&since=${since}` : "");
      let response = await transport.fetch(url, {
        signal: this.#getAbortSignal(),
        timeoutMs: EMBEDDED_SUBTITLE_TIMEOUT_MS
      });
      while (response.status === 202) {
        await new Promise((resolve) => { window.setTimeout(resolve, SUBTITLE_POLL_INTERVAL_MS); });
        if (this.#getAbortSignal().aborted || epoch !== this.#subtitleEpoch) {
          return;
        }
        response = await transport.fetch(url, {
          signal: this.#getAbortSignal(),
          timeoutMs: EMBEDDED_SUBTITLE_TIMEOUT_MS
        });
      }
      if (epoch !== this.#subtitleEpoch) {
        return;
      }
      if (!response.ok) {
        console.warn(`[torrent-tv][subtitles] embedded track ${track.index} seed fetch failed (${response.status})`);
        return;
      }
      const vtt = await response.text();
      if (epoch !== this.#subtitleEpoch || !vtt || !vtt.startsWith("WEBVTT")) {
        return;
      }

      // Refine the label if the container said nothing and the text was read
      // as a language. Nothing else is a source: see `#loadExternalSubtitles`.
      const fallbackLang = trackLanguageCode(trackLanguageTag(track));
      if (!fallbackLang || fallbackLang === "und") {
        const detected = this.#languageFromHeader(response);
        if (detected?.code && detected.code !== "und") {
          el.label = buildSubtitleLabel({
            code: detected.code,
            name: detected.name || languageName(detected.code) || "Unknown",
            group: typeof track.title === "string" && track.title.trim() ? track.title.trim() : null,
            isForced: track.isForced === true,
            isHearingImpaired: track.isHearingImpaired === true
          });
          el.srclang = detected.code;
          this.#publishMenu();
        }
      }

      const cursor = Number.parseInt(response.headers.get("x-subtitle-cursor") ?? "", 10);
      if (Number.isInteger(cursor)) {
        this.#rememberCursor(track.index, cursor);
      }
      const added = this.#deliverCues(track.index, el.track, parseVttCues(vtt));
      console.debug(
        `[torrent-tv][subtitles] embedded track seeded "${el.label}" with ${added.added} cue(s) ` +
        `(track ${track.index}, cursor ${Number.isInteger(cursor) ? cursor : "none"}, ` +
        `clusters ${response.headers.get("x-subtitle-covered-clusters") ?? "?"}/` +
        `${response.headers.get("x-subtitle-indexed-clusters") ?? "?"})`
      );
      this.#reportSubtitleCoverage(`seed of track ${track.index}`);
    } catch (e) {
      if (isAbortError(e)) {
        return;
      }
      console.warn(`[torrent-tv][subtitles] embedded track ${track.index} seed failed:`, e);
    }
  }

  /**
   * Move a track's label onto the language its CUES turn out to be in.
   *
   * Why this exists at all: a track whose container states no language cannot be
   * read at the start of a session. The proxy delivers whatever cues have been
   * downloaded, and a handful of lines is not a sample of a language — measured
   * 2026-09-02, franc needs 650 characters of Russian before its answer stops
   * walking between Bulgarian, Serbian and Russian, and the proxy's detector now
   * refuses to answer below the figure measured for whichever language it is
   * about to name. So at the start the honest label is Unknown, and the answer
   * arrives later, as the film downloads
   * (`research/franc-boundary-2026-09-02.md`).
   *
   * Only a label that came from a GUESS is moved. A language the container
   * itself stated is a statement by the person who made the file and outranks
   * anything read off the text; `#namedSubtitleTracks` is what remembers which
   * is which.
   *
   * @param {number} trackIndex
   * @param {{ code: string, name: string } | null | undefined} detected
   * @returns {void}
   */
  #refineSubtitleLabel(trackIndex, detected) {
    if (!detected?.code || this.#namedSubtitleTracks.has(trackIndex)) {
      return;
    }
    const element = this.#embeddedTrackElements.get(trackIndex);
    if (!element) {
      return;
    }
    const track = (this.#planTracks?.subtitles ?? []).find((entry) => entry.index === trackIndex);
    const label = buildSubtitleLabel({
      code: detected.code,
      name: detected.name || languageName(detected.code) || "Unknown",
      group: typeof track?.title === "string" && track.title.trim() ? track.title.trim() : null,
      isForced: track?.isForced === true,
      isHearingImpaired: track?.isHearingImpaired === true
    });
    if (element.label === label) {
      return;
    }
    console.debug(
      `[torrent-tv][subtitles] track ${trackIndex} reads as ${detected.code}; ` +
      `"${element.label}" becomes "${label}"`
    );
    element.label = label;
    element.srclang = detected.code;
    // The menu names this track by its key, so its item keeps working; only
    // the words on it change.
    this.#publishMenu();
    // The identity follows the label. A track that opened as Unknown and is now
    // known to be Russian must be findable as Russian in the next episode —
    // otherwise a viewer who chose it while it was still Unknown carries a
    // choice that can never match anything.
    this.#subtitleIdentities.set(element.track, trackIdentity({
      code: detected.code,
      releaser: typeof track?.title === "string" && track.title.trim() ? track.title.trim() : null
    }));
  }

  /**
   * A track's new cues, pushed by the proxy the moment it read them off its
   * own download — the sole ongoing delivery path; nothing on this side asks
   * again. Applies to whichever track is named, `mode` included: a track the
   * viewer has not turned on yet still gets its cues, so turning it on later
   * shows them at once instead of waiting for a fetch.
   *
   * @param {{ fileIndex: number, trackIndex: number, cues: object[], language: string,
   *   detectedLanguage?: { code: string, name: string } | null, cursor?: number }} event
   * @returns {void}
   */
  onCues(event) {
    console.debug(
      `[torrent-tv][subtitles] push received: file=${event.fileIndex} track=${event.trackIndex} ` +
      `${Array.isArray(event.cues) ? event.cues.length : "?"} cue(s) ` +
      `(context file=${this.#subtitleContext?.fileIndex ?? "none"}, ` +
      `knownTrack=${this.#embeddedTextTracks.has(event.trackIndex)})`
    );
    if (!this.#subtitleContext || this.#subtitleContext.fileIndex !== event.fileIndex) {
      return; // a push for a file that is no longer the one open
    }
    this.#refineSubtitleLabel(event.trackIndex, event.detectedLanguage);
    // Cues the proxy has taken back: read from a stretch that turned out not to
    // be a cluster. Named by the found-order number each cue was sent with.
    if (Array.isArray(event.withdrawn) && event.withdrawn.length > 0) {
      const withdrawnFrom = this.#embeddedTextTracks.get(event.trackIndex);
      if (withdrawnFrom) {
        const removed = removeCues(withdrawnFrom, event.withdrawn, this.#cueKeysOf(withdrawnFrom), this.#cueIdsOf(withdrawnFrom));
        console.debug(`[torrent-tv][subtitles] track ${event.trackIndex}: ${removed} cue(s) taken back by the proxy`);
      }
    }
    // Before anything else: a batch whose cues all fell away as empty still
    // moves the proxy's count forward, and a cursor left behind would have this
    // page ask for those same seqs again after every reconnect.
    if (Number.isFinite(event.cursor)) {
      this.#rememberCursor(event.trackIndex, event.cursor);
    }
    const textTrack = this.#embeddedTextTracks.get(event.trackIndex);
    if (!textTrack || !Array.isArray(event.cues) || event.cues.length === 0) {
      return;
    }
    const added = this.#deliverCues(event.trackIndex, textTrack, event.cues);
    if (added.held) {
      return; // still being armed; these are added the moment it is
    }
    if (added.added > 0) {
      // Against the position being played, because that is the only thing that
      // decides whether these cues are of any use yet: a batch covering the
      // stretch the viewer passed two minutes ago and a batch covering the next
      // line of dialogue are the same event without this comparison.
      const now = this.#getVideoElement() instanceof HTMLVideoElement ? this.#getVideoElement().currentTime : 0;
      const first = event.cues[0]?.startSeconds ?? 0;
      const last = event.cues[event.cues.length - 1]?.endSeconds ?? first;
      console.debug(
        `[torrent-tv][subtitles] track ${event.trackIndex}: +${added.added} cue(s) pushed, ` +
        `covering ${first.toFixed(1)}-${last.toFixed(1)}s, playhead ${now.toFixed(1)}s ` +
        `(${(first - now).toFixed(1)}s ahead of it)`
      );
      this.#reportSubtitleCoverage(`push for track ${event.trackIndex}`);
    }
  }

  /**
   * What each track the viewer has turned ON can actually draw at the position
   * being played, and — when it can draw nothing — how far away its nearest cue
   * is and how long the viewer has been waiting.
   *
   * This is the reading the 2026-08-26 report had no answer from. The chain has
   * three places a cue can be late in — the download that has not reached the
   * cluster, the push that did not arrive or landed on another track, and the
   * player that holds the cue and draws nothing — and every log line so far
   * belonged to one of them alone. Comparing what the track HOLDS against
   * `currentTime` separates all three from one occurrence: a cue that covers
   * the playhead and nothing on screen is the player's; no cue and no push is
   * the download's; a push whose cues sit behind the playhead is its own answer.
   *
   * @param {string} cause - What prompted the reading, for the log.
   * @returns {void}
   */
  #reportSubtitleCoverage(cause) {
    const tracks = this.#getVideoElement()?.textTracks;
    if (!tracks || !(this.#getVideoElement() instanceof HTMLVideoElement)) {
      return;
    }
    const now = this.#getVideoElement().currentTime;
    let starved = false;
    for (const track of tracks) {
      if (track.mode !== "showing") {
        this.#subtitleStarvedAt.delete(track);
        this.#subtitleReported.delete(track);
        continue;
      }
      const coverage = readCoverage(track.cues, now);
      if (coverage.unsupplied && !this.#subtitleStarvedAt.has(track)) {
        this.#subtitleStarvedAt.set(track, performance.now());
      }
      const startedAt = this.#subtitleStarvedAt.get(track);
      const waited = startedAt === undefined ? null : (performance.now() - startedAt) / 1000;
      // Print when what the track HOLDS or the verdict has changed, not on
      // every tick of the clock. A film's opening minutes hold no dialogue at
      // all, so a line per second there would say the same thing a hundred
      // times and bury the occurrence it exists to record; every arrival of
      // cues reports itself anyway, through its own cause.
      const said = this.#subtitleReported.get(track);
      if (said !== coverage.signature) {
        this.#subtitleReported.set(track, coverage.signature);
        console.debug(
          describeCoverage(cause, track.label || track.language || "?", coverage, now, waited)
        );
      }
      if (!coverage.unsupplied) {
        this.#subtitleStarvedAt.delete(track);
      }
      if (coverage.unsupplied) {
        starved = true;
      }
    }
    if (starved) {
      this.#startSubtitleCoverageWatch();
    } else {
      this.#stopSubtitleCoverageWatch();
    }
  }

  /**
   * The record of what one track already holds, made on first use.
   *
   * @param {TextTrack} track
   * @returns {Set<string>}
   */
  #cueKeysOf(track) {
    let keys = this.#subtitleCueKeys.get(track);
    if (!keys) {
      keys = new Set();
      this.#subtitleCueKeys.set(track, keys);
    }
    return keys;
  }

  /**
   * Repeat the coverage reading every second while a showing track has nothing
   * to draw, so the moment its first usable cue arrives is timed rather than
   * inferred. Stops itself as soon as every showing track covers the playhead.
   *
   * @returns {void}
   */
  #startSubtitleCoverageWatch() {
    if (this.#subtitleCoverageTimer !== null) {
      return;
    }
    this.#subtitleCoverageTimer = window.setInterval(() => {
      this.#reportSubtitleCoverage("nothing where the viewer is");
    }, 1000);
  }

  /** @returns {void} */
  #stopSubtitleCoverageWatch() {
    if (this.#subtitleCoverageTimer === null) {
      return;
    }
    window.clearInterval(this.#subtitleCoverageTimer);
    this.#subtitleCoverageTimer = null;
  }

  /**
   * Ask for each embedded track again, from where this page left off.
   *
   * The proxy pushes cues to the CHANNELS subscribed to a file, and it drops a
   * channel from that list the moment it closes. The only thing that subscribes
   * is a request for that file's subtitles, which is made once when the file is
   * opened — so a reconnect that swaps the connection under a live player left
   * the page permanently unsubscribed: cues already delivered kept showing,
   * nothing further ever arrived, and no line said so. Each request here both
   * carries the cues missed while the channel was gone and puts the new channel
   * back on the list.
   *
   * @returns {void}
   */
  onTransportReconnected() {
    const context = this.#subtitleContext;
    if (!context || this.#embeddedTextTracks.size === 0 || this.#subtitleResubscribing) {
      return;
    }
    const tracks = (this.#planTracks?.subtitles ?? []).filter(
      (track) => track?.textBased === true && track?.isEnabled !== false
    );
    if (tracks.length === 0) {
      return;
    }
    console.debug(
      `[torrent-tv][subtitles] re-subscribing ${tracks.length} embedded track(s) after a reconnect`
    );
    // One at a time: two reconnects close together would otherwise ask twice
    // from the same cursor. What comes back cannot double a cue in any case —
    // every append is judged against what the track already holds — but two
    // answers to the same question are bytes and a walk for nothing.
    this.#subtitleResubscribing = true;
    const epoch = this.#subtitleEpoch;
    const asked = [];
    for (const track of tracks) {
      const element = this.#trackElementFor(track.index);
      // A track still being armed has its own first seed coming, and that one
      // asks from the beginning; a second request now would ask from a cursor
      // this page has not yet caught up to.
      if (!element || !this.#subtitleArmed.has(track.index)) {
        continue;
      }
      asked.push(this.#seedEmbeddedTrack({
        track,
        el: element,
        fileIndex: context.fileIndex,
        // The transport OBJECT survives a seamless reconnect — the connection
        // inside it is replaced — so either reads the new channel; the current
        // one is named first all the same.
        transport: this.#getTransport() ?? context.transport,
        sourceKey: context.sourceKey,
        epoch,
        // Where this page left off. Absent for a track that has never been told
        // one — then the request asks for everything, which is what a page
        // holding nothing wants.
        since: this.#subtitleCursors.get(track.index) ?? null
      }));
    }
    void Promise.allSettled(asked).then(() => {
      this.#subtitleResubscribing = false;
    });
  }

  /**
   * The `<track>` element carrying one source track index, found through the
   * `TextTrack` it owns. Every element's `src` is the same empty document, and
   * none carries an attribute naming the index, so the map built when they were
   * created is the only link between the two.
   *
   * @param {number} trackIndex
   * @returns {HTMLTrackElement | null}
   */
  #trackElementFor(trackIndex) {
    const textTrack = this.#embeddedTextTracks.get(trackIndex);
    if (!textTrack || !(this.#getVideoElement() instanceof HTMLVideoElement)) {
      return null;
    }
    for (const element of this.#getVideoElement().querySelectorAll("track")) {
      if (element.track === textTrack) {
        return element;
      }
    }
    return null;
  }

  /**
   * Watch what the viewer has turned on, and say so.
   *
   * Two jobs, and they belong together because both are answers to the same
   * unread quantity — the `mode` of each text track, which nothing on either
   * side has ever recorded:
   *
   * 1. It prints every track's mode whenever any of them changes. Field
   *    2026-08-20: several languages were on screen at once while the captions
   *    menu said off, and neither log could say which tracks the browser
   *    thought were showing. Our own code never assigns `mode`, a `<track>`
   *    without a `src` stays `disabled` even when it carries `default`
   *    (measured in Chromium), and media-chrome's automatic selection is off
   *    here — so the cause is something none of the three, and it cannot be
   *    named without this reading.
   * 2. That is all it does now — cues arrive by push (`#onSubtitleCuesPush`)
   *    regardless of `mode`, so there is nothing left to start or stop here.
   *
   * Registered ONCE for the life of the `<video>` element, not once per file:
   * the element survives an episode switch, and a listener per file would both
   * accumulate and — worse — answer with the file it was created for. Which
   * file is current is read from `#subtitleContext` at the moment the listener
   * runs. `change` fires on the list, not per track.
   *
   * @returns {void}
   */
  /**
   * Say which subtitle track is on, instead of leaving it to be decided by
   * whatever the browser makes of four tracks appearing one after another.
   *
   * The rule, stated by the user 2026-08-20: **the container decides, and if
   * the container says nothing, nothing is shown.** A Matroska track carries
   * `FlagDefault`, which is what "this is the one to show" means for a film;
   * an external subtitle FILE sitting beside the video carries no such thing,
   * so it is never turned on by itself. A viewer who wants subtitles asks for
   * them in the menu, and from then on this does not interfere.
   *
   * **Only ever the track just inserted, and never any other.** This is the
   * whole of what keeps a viewer's choice from being undone, and the first
   * version of this got it wrong by sweeping every track on each insertion:
   * tracks do not arrive together, they arrive as the proxy finishes extracting
   * each one, which was measured at 55, 193 and 752 seconds apart on one film.
   * A viewer who turns subtitles on at 70 s would have had them turned off
   * again at 193 s, and again at 752 s. So each track's mode is decided once,
   * when it appears, and nothing here reads or writes any other track.
   *
   * Applied twice for that one track — now and on the next task — because the
   * browser's own automatic selection is a QUEUED task and may run after this
   * one. After that the track is left alone for ever.
   *
   * Why this is needed at all: with four tracks the field showed three of them
   * drawn at once over the picture while the menu said "off" (2026-08-20,
   * screenshot). Reading the browser's rules did not explain it — a `<track>`
   * without a `src` stays `disabled` even when it carries `default`, measured
   * in Chromium — so the mode is no longer left to be inferred.
   *
   * @param {TextTrack} textTrack - The track that has just been appended.
   * @param {number | null} planIndex - Its index among the plan's subtitle
   *   tracks, or null for a subtitle FILE, which the container never chooses.
   * @param {number} epoch - The set of tracks this one belongs to; a track from
   *   a previous file must not be given a mode in the current one.
   * @returns {void}
   */
  #applySubtitleMode(textTrack, planIndex, epoch) {
    const show = this.#subtitleShouldShow(textTrack, planIndex);
    const wanted = show ? "showing" : "disabled";
    if (show) {
      this.#subtitleShowingWeApplied = textTrack;
    }
    const apply = () => {
      if (epoch !== this.#subtitleEpoch) {
        return;
      }
      if (textTrack.mode !== wanted) {
        textTrack.mode = wanted;
      }
    };
    apply();
    window.setTimeout(apply, 0);
  }

  /**
   * Whether THIS track is the one to draw for this file.
   *
   * Two rules, in order, and the second is the one that has always been here:
   *
   * 1. **What the viewer chose in the previous episode**, where this file
   *    carries its exact counterpart — the same language from the same team.
   *    Turning subtitles OFF is such a choice too, and outranks any default.
   * 2. **What the container says**, where the viewer has chosen nothing yet or
   *    where nothing in this file answers what they chose. That second case is
   *    deliberate and was settled with the user: no near matches, no ranked
   *    alternatives — the file's own default plays, exactly as it does when the
   *    first episode is opened.
   *
   * @param {TextTrack} textTrack
   * @param {number | null} planIndex - Its index among the plan's subtitle
   *   tracks, or null for a subtitle FILE.
   * @returns {boolean}
   */
  #subtitleShouldShow(textTrack, planIndex) {
    const remembered = this.#rememberedSubtitle;
    if (remembered?.off === true) {
      return false;
    }
    if (remembered && findTrackByIdentity(this.#subtitleCandidateIdentities(), remembered) >= 0) {
      return sameTrackIdentity(this.#subtitleIdentities.get(textTrack) ?? null, remembered);
    }
    const chosenIndex = containerDefaultSubtitleIndex(this.#planTracks?.subtitles ?? []);
    return planIndex !== null && planIndex === chosenIndex;
  }

  /**
   * What every subtitle track this file can offer IS, in one list.
   *
   * Needed whole rather than one at a time, because a remembered choice with no
   * counterpart here must fall back to the container's default — and that
   * cannot be told from a single track. Tracks are attached over time (a
   * sidecar costs a fetch), so the list is built from what the file DECLARES,
   * which is known before any of them is attached.
   *
   * @returns {Array<{ code: string, releaser: string | null } | null>}
   */
  #subtitleCandidateIdentities() {
    const identities = (this.#planTracks?.subtitles ?? [])
      .filter((track) => track?.textBased === true && track?.isEnabled !== false)
      .map((track) => {
        const title = typeof track.title === "string" ? track.title.trim() : "";
        return trackIdentity({
          code: trackLanguageCode(trackLanguageTag(track) || ""),
          releaser: title.length > 0 ? title : null
        });
      });
    // The files beside the picture, as the proxy paired and read them.
    for (const sub of this.#planTracks.sidecarSubtitles ?? []) {
      identities.push(trackIdentity({
        code: sub.naming?.code ?? "und",
        releaser: sub.naming?.releaser ?? null
      }));
    }
    return identities;
  }

  /**
   * Note what the viewer has just chosen, so the next episode opens with it.
   *
   * Called from the text-track change listener, which cannot tell WHO made the
   * change — so our own last write is compared against, and only a difference
   * counts as the viewer's. Without that the default this component applies on
   * every new file would immediately overwrite the very choice it is meant to
   * honour.
   *
   * @param {TextTrackList} tracks
   * @returns {void}
   */
  #rememberSubtitleChoice(tracks) {
    let showing = null;
    for (const track of tracks) {
      if (track.mode === "showing") {
        showing = track;
        break;
      }
    }
    if (showing === this.#subtitleShowingWeApplied) {
      return;
    }
    this.#subtitleShowingWeApplied = showing;
    this.#rememberedSubtitle = showing === null
      ? { off: true }
      : this.#subtitleIdentities.get(showing) ?? null;
    this.#logEvent(
      this.#rememberedSubtitle?.off === true
        ? "subtitles turned off — the next episode will open without them"
        : `subtitles ${JSON.stringify(this.#rememberedSubtitle)} remembered for the next episode`
    );
  }

  #watchSubtitleModes() {
    const tracks = this.#getVideoElement()?.textTracks;
    if (!tracks || this.#subtitleModesWatched === true) {
      return;
    }
    this.#subtitleModesWatched = true;
    const onChange = () => {
      const described = [];
      for (const track of tracks) {
        described.push(`"${track.label || track.language || "?"}"=${track.mode}`);
      }
      console.debug(`[torrent-tv][subtitles] modes ${described.join(" ")}`);
      this.#publishMenu();
      // A change this component did not make is the viewer's, and it is what
      // the next episode opens with.
      this.#rememberSubtitleChoice(tracks);
      // What a track just switched on can draw at this position — see
      // `#reportSubtitleCoverage`.
      this.#reportSubtitleCoverage("mode change");
    };
    tracks.addEventListener("change", onChange);
  }


}
