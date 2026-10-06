import { APP_EVENTS, LOADING_EVENTS, MEDIA_INFO_EVENTS } from "../../shared/events.js";
import { subtitleEvidenceOf } from "../../domain/subtitle-evidence.js";
import { requestHeaders } from "../../shared/request-headers.js";
import {
  METADATA_LANGUAGE,
  boundedNames,
  containerEpisode,
  containerEvidence,
  pictureIdentification,
  releaseIdentification,
  seasonFiles,
  seasonOf,
  seasonsAgree,
  shapeOf
} from "../../domain/media-info.js";

/**
 * WHAT A RELEASE IS, asked of the metadata service and published for whoever
 * shows it.
 *
 * Owns the requests and nothing else: the playlist, the player and the media
 * session read `MEDIA_INFO:CHANGED` and decide what to show. Three rules make
 * it safe to run beside playback:
 *
 *  - **an answer belongs to the choice it was asked for.** Every choice of a
 *    release gets its own number and its own `AbortController`; choosing again
 *    cancels what the last choice asked, and an answer that arrives for an
 *    older choice is dropped. A new choice publishes `null` at once, so no view
 *    keeps showing the last release's poster over the next one;
 *  - **nothing waits for it.** Every request is fire-and-forget from the
 *    pipeline's side; a failure or no answer leaves the release's own names;
 *  - **what a file states about its work only adds** (meta#139). The proxy
 *    reads it from the opened file's edges, typically a minute after the name
 *    was shown. It fills what is empty — an episode title, a year, a
 *    description, a cover where there is no poster — and asks again only when
 *    the names did not establish the work. A title, an episode title or a
 *    picture already shown is never replaced; a contradiction is logged;
 *  - **the first answer is only a preparation.** What is known when a release
 *    is chosen — the `.torrent` file's name, a magnet's `dn` — is sent at once,
 *    so the service has searched by the time the proxy says what is in the
 *    release. It is not shown: the release is identified from everything known
 *    once the contents arrive, and whether the pictures are one work at all is
 *    the proxy's statement, which does not exist before then.
 */
export class MediaInfoController {
  #releaseRequest = null;
  #releaseStatus = null;
  #subtitleEvidence = null;
  #subtitleRetried = false;
  #selection = 0;
  #releaseSequence = 0;
  #durations = new Map();
  #durationRetried = false;

  /** What the torrent says it is (`"adult"`), or `null`. */
  #category = null;

  /** The OpenSubtitles hash of each file the proxy has answered for. @type {Map<number, { hash: string, size: number }>} */
  #fingerprints = new Map();

  /** Files whose identification was asked again once their hash arrived. @type {Set<number>} */
  #fingerprintRetried = new Set();

  /** What each file states about its work, from the proxy or kept by the server. @type {Map<number, object>} */
  #containers = new Map();

  /** The `blob:` address of each file's own cover, revoked with the choice. @type {Map<number, { url: string, type: string }>} */
  #covers = new Map();

  /** Files whose identification was asked again once their container metadata arrived. @type {Set<number>} */
  #containerRetried = new Set();

  /** @type {AbortController | null} */
  #abort = null;

  /** @type {string[]} */
  #selectionNames = [];

  /** @type {{ items?: object[], shape?: string, name?: string } | null} */
  #contents = null;

  /** @type {Map<number, object>} */
  #filesByIndex = new Map();

  /** @type {Map<number, object>} */
  #itemsByIndex = new Map();

  /** @type {object | null} */
  #work = null;

  /** @type {Record<string, string>} */
  #seasons = {};

  /** @type {Record<string, object>} */
  #episodes = {};

  /** @type {Record<string, object>} */
  #pictures = {};

  /** Seasons asked for in this choice. @type {Set<number>} */
  #askedSeasons = new Set();

  /** Pictures asked for one by one in this choice. @type {Set<number>} */
  #askedPictures = new Set();

  /** Files wanted before the work was known. @type {Set<number>} */
  #wanted = new Set();

  constructor() {
    document.addEventListener(MEDIA_INFO_EVENTS.SUBTITLE_EVIDENCE, this.#onSubtitleEvidence);
    document.addEventListener(MEDIA_INFO_EVENTS.PROBED, this.#onProbed);
    document.addEventListener(MEDIA_INFO_EVENTS.FINGERPRINT, this.#onFingerprint);
    document.addEventListener(MEDIA_INFO_EVENTS.CONTAINER, this.#onContainer);
    document.addEventListener(MEDIA_INFO_EVENTS.CONTAINER_COVER, this.#onContainerCover);
    document.addEventListener(MEDIA_INFO_EVENTS.SELECTED, this.#onSelected);
    document.addEventListener(MEDIA_INFO_EVENTS.CONTENTS, this.#onContents);
    document.addEventListener(MEDIA_INFO_EVENTS.WANT_FILES, this.#onWantFiles);
    document.addEventListener(LOADING_EVENTS.FILE_CHOSEN, this.#onActiveFile);
    document.addEventListener(APP_EVENTS.RESET_TO_PICKER, this.#onReset);
  }

  /** @param {Event} event */
  #onSelected = (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    this.#begin(Number(detail?.selection));
    this.#category = detail?.category === "adult" ? "adult" : null;
    const names = boundedNames(Array.isArray(detail?.names) ? detail.names : []);
    if (names.length > 0) {
      // Preparation only; see the class comment.
      void this.#post("/api/metadata/identify", { names, kindHint: null, language: METADATA_LANGUAGE, ...this.#evidence() });
    }
    this.#selectionNames = names;
  };

  /** @param {Event} event */
  #onSubtitleEvidence = (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    if (!this.#releaseRequest || !this.#filesByIndex.has(detail?.fileIndex) || this.#work || this.#subtitleRetried) return;
    const evidence = subtitleEvidenceOf(detail?.vtt, this.#releaseRequest.kindHint);
    if (!evidence) return;
    const previous = this.#subtitleEvidence ?? { titles: [], years: [] };
    this.#subtitleEvidence = {
      titles: [...new Set([...previous.titles, ...evidence.titles])].slice(0, 4),
      years: [...new Set([...previous.years, ...evidence.years])].slice(0, 4)
    };
    this.#retryWithSubtitles();
  };

  #retryWithSubtitles() {
    if (this.#releaseStatus !== "not-found" || !this.#subtitleEvidence || this.#subtitleRetried) return;
    this.#subtitleRetried = true;
    void this.#identifyRelease(this.#selection, { ...this.#releaseRequest, subtitleEvidence: this.#subtitleEvidence });
  }

  #onProbed = event => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    if (detail?.selection !== this.#selection || !this.#filesByIndex.has(detail?.fileIndex) ||
        !Number.isFinite(detail?.durationSeconds) || detail.durationSeconds <= 0) return;
    this.#durations.set(detail.fileIndex, detail.durationSeconds);
    this.#retryWithDuration();
  };

  /**
   * What identification is told besides names: the category the torrent states
   * and, for one file, its hash, what it states about its work, and which file
   * it is — by which the server keeps what the file states for the next viewer.
   * All are optional and absent unless known.
   *
   * @param {number} [fileIndex]
   */
  #evidence(fileIndex) {
    const fingerprint = fileIndex === undefined ? undefined : this.#fingerprints.get(fileIndex);
    const container = fileIndex === undefined ? null : containerEvidence(this.#containers.get(fileIndex));
    const infoHash = typeof this.#contents?.infoHash === "string" ? this.#contents.infoHash.toLowerCase() : "";
    const source = fileIndex !== undefined && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(infoHash) ? { infoHash, fileIndex } : null;
    return {
      ...(this.#category ? { category: this.#category } : {}),
      ...(fingerprint ? { fingerprint } : {}),
      ...(container ? { container } : {}),
      ...(source ? { source } : {})
    };
  }

  /** What the opened file states about its work arrived from the proxy. */
  #onContainer = (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    const fileIndex = detail?.fileIndex;
    if (detail?.selection !== this.#selection || !Number.isInteger(fileIndex) || !this.#filesByIndex.has(fileIndex) ||
        !detail.container || typeof detail.container !== "object") return;
    this.#keepContainer(fileIndex, detail.container);
    if (this.#containerRetried.has(fileIndex)) return;
    this.#containerRetried.add(fileIndex);
    // Asked again only where the names did not establish the work; asked with
    // what the file states, the server also keeps it for the next viewer.
    if (shapeOf(this.#contents) === "undetermined") {
      if (this.#pictures[String(fileIndex)]) return;
      this.#askedPictures.delete(fileIndex);
      void this.#identifyPicture(this.#selection, fileIndex);
      return;
    }
    if (!this.#releaseRequest || this.#work || !this.#itemsByIndex.has(fileIndex)) return;
    void this.#identifyRelease(this.#selection, this.#releaseRequest);
  };

  /** The cover a file carries arrived: it is shown only where no poster is. */
  #onContainerCover = (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    const fileIndex = detail?.fileIndex;
    if (detail?.selection !== this.#selection || !Number.isInteger(fileIndex) || !(detail.cover instanceof Blob) || this.#covers.has(fileIndex)) return;
    this.#covers.set(fileIndex, { url: URL.createObjectURL(detail.cover), type: detail.cover.type || "image/jpeg" });
    this.#publish();
  };

  /**
   * Keep what a file states about its work, fill its episode title where no
   * provider named the episode, and log where it contradicts what is shown.
   *
   * @param {number} fileIndex
   * @param {object} container
   */
  #keepContainer(fileIndex, container) {
    this.#containers.set(fileIndex, container);
    const key = String(fileIndex);
    const stated = containerEpisode(container, this.#itemsByIndex.get(fileIndex)?.episode);
    const shown = this.#episodes[key];
    if (stated && !shown) this.#episodes[key] = stated;
    else if (stated && shown) this.#noteContradiction(fileIndex, shown, stated);
    const work = this.#work?.normalized ?? this.#work;
    if (work && Number.isInteger(work.year) && Number.isInteger(container.year) && work.year !== container.year) {
      console.info(`[media-info] file ${fileIndex} states the year ${container.year}, the work shown has ${work.year}`);
    }
    this.#publish();
  }

  /**
   * Two statements of one file's episode that disagree: the one shown stays.
   *
   * @param {number} fileIndex
   * @param {{ source?: string, episodes: Array<{ number: number, name: string }> }} shown
   * @param {{ source?: string, episodes: Array<{ number: number, name: string }> }} other
   */
  #noteContradiction(fileIndex, shown, other) {
    const number = (match) => match.episodes.map((episode) => episode.number).join("-");
    const name = (match) => match.episodes.map((episode) => episode.name).join(" / ").trim().toLowerCase();
    const fields = [number(shown) !== number(other) ? "number" : null, name(shown) !== name(other) ? "title" : null].filter(Boolean);
    if (fields.length > 0) {
      console.info(`[media-info] file ${fileIndex}: ${other.source ?? "provider"} states another episode ${fields.join(" and ")} than the ${shown.source ?? "provider"}'s shown`);
    }
  }

  /** The hash of a file arrived: ask again for a release or picture that is still not identified. */
  #onFingerprint = (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    const fileIndex = detail?.fileIndex;
    if (detail?.selection !== this.#selection || !Number.isInteger(fileIndex) || !this.#filesByIndex.has(fileIndex)) return;
    this.#fingerprints.set(fileIndex, detail.fingerprint);
    if (this.#fingerprintRetried.has(fileIndex)) return;
    this.#fingerprintRetried.add(fileIndex);
    if (shapeOf(this.#contents) === "undetermined") {
      if (this.#pictures[String(fileIndex)]) return;
      this.#askedPictures.delete(fileIndex);
      void this.#identifyPicture(this.#selection, fileIndex);
      return;
    }
    const [item] = this.#contents?.items ?? [];
    if (!this.#releaseRequest || this.#work || item?.fileIndex !== fileIndex) return;
    void this.#identifyRelease(this.#selection, this.#releaseRequest);
  };

  #retryWithDuration() {
    const heuristic = (this.#work?.sources?.tmdb ?? this.#work)?.identification === "latest-year";
    if (!this.#releaseRequest || (this.#work && !heuristic) || this.#durationRetried || shapeOf(this.#contents) !== "single" ||
        !(heuristic || ["ambiguous", "undetermined", "unavailable", "not-found"].includes(this.#releaseStatus))) return;
    const [item] = this.#contents.items ?? [];
    const durationSeconds = this.#durations.get(item?.fileIndex);
    if (!durationSeconds || item?.episode) return;
    this.#durationRetried = true;
    void this.#identifyRelease(this.#selection, { ...this.#releaseRequest, durationSeconds });
  }

  #onContents = (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    if (Number(detail?.selection) !== this.#selection) {
      return;
    }
    this.#contents = detail?.contents ?? null;
    const files = Array.isArray(detail?.files) ? detail.files : [];
    this.#filesByIndex = new Map(files.map((file) => [file.index, file]));
    const items = Array.isArray(this.#contents?.items) ? this.#contents.items : [];
    this.#itemsByIndex = new Map(items.map((item) => [item.fileIndex, item]));
    const request = releaseIdentification({
      selectionNames: this.#selectionNames,
      contents: this.#contents ?? {},
      filesByIndex: this.#filesByIndex
    });
    this.#publish();
    if (request) {
      this.#releaseRequest = request;
      void this.#identifyRelease(this.#selection, request);
    }
  };

  /** @param {Event} event */
  #onWantFiles = (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    for (const fileIndex of Array.isArray(detail?.fileIndexes) ? detail.fileIndexes : []) {
      this.#want(Number(fileIndex));
    }
  };

  /** @param {Event} event */
  #onActiveFile = (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    const fileIndex = Number(detail?.fileIndex);
    if (!Number.isInteger(fileIndex) || fileIndex < 0 || !this.#contents) {
      return;
    }
    if (shapeOf(this.#contents) === "undetermined") {
      void this.#identifyPicture(this.#selection, fileIndex);
      return;
    }
    this.#want(fileIndex);
  };

  #onReset = () => {
    this.#begin(this.#selection + 1);
  };

  /**
   * Start a new choice: cancel the last one's requests and forget its answers.
   *
   * @param {number} selection
   */
  #begin(selection) {
    this.#abort?.abort();
    this.#abort = new AbortController();
    this.#selection = Number.isInteger(selection) ? selection : this.#selection + 1;
    this.#selectionNames = [];
    this.#releaseRequest = null;
    this.#releaseStatus = null;
    this.#subtitleEvidence = null;
    this.#subtitleRetried = false;
    this.#releaseSequence += 1;
    this.#durations = new Map();
    this.#durationRetried = false;
    this.#category = null;
    this.#fingerprints = new Map();
    this.#fingerprintRetried = new Set();
    this.#containers = new Map();
    for (const { url } of this.#covers.values()) URL.revokeObjectURL(url);
    this.#covers = new Map();
    this.#containerRetried = new Set();
    this.#contents = null;
    this.#filesByIndex = new Map();
    this.#itemsByIndex = new Map();
    this.#work = null;
    this.#seasons = {};
    this.#episodes = {};
    this.#pictures = {};
    this.#askedSeasons = new Set();
    this.#askedPictures = new Set();
    this.#wanted = new Set();
    document.dispatchEvent(new CustomEvent(MEDIA_INFO_EVENTS.CHANGED, { detail: null }));
  }

  /**
   * @param {number} selection
   * @param {{ names: string[], kindHint: "tv" | "movie" | null }} request
   */
  async #identifyRelease(selection, request) {
    const sequence = ++this.#releaseSequence;
    const [firstItem] = this.#contents?.items ?? [];
    const single = shapeOf(this.#contents) === "single" ? firstItem?.fileIndex : undefined;
    // A series is one work: what any of its episodes states (the series' own
    // title, its season) is evidence for all of them.
    const stating = single ?? [...this.#containers.keys()].find((index) => this.#itemsByIndex.has(index)) ?? firstItem?.fileIndex;
    const answer = await this.#post("/api/metadata/identify", { ...request, language: METADATA_LANGUAGE, ...this.#evidence(stating) });
    if (selection !== this.#selection || sequence !== this.#releaseSequence) return;
    this.#takeKept(stating, answer);
    this.#releaseStatus = answer?.status ?? null;
    if (answer?.status !== "identified") {
      this.#retryWithDuration();
      this.#retryWithSubtitles();
      return;
    }
    // A series that the service identifies as a film is a contradiction, not
    // an answer: the proxy has already stated the pictures are episodes.
    const work = answer.work?.normalized ?? answer.work;
    if (shapeOf(this.#contents) === "series" && !["series", "tv"].includes(work?.kind)) {
      return;
    }
    // Nor is a series that lacks the seasons the files name.
    if (["series", "tv"].includes(work?.kind) && (answer.work?.sources?.tmdb || work?.tmdbId) && !seasonsAgree([...this.#itemsByIndex.values()], work)) {
      return;
    }
    this.#work = answer.work;
    this.#publish();
    this.#retryWithDuration();
    for (const fileIndex of this.#wanted) {
      this.#askSeasonOf(fileIndex);
    }
  }

  /**
   * What the server kept from an earlier reading of a file, when this page has
   * none of its own yet: a pack's file is identified with what an earlier
   * viewer's proxy read from it, and its episode title fills in the same way.
   *
   * @param {number | undefined} fileIndex
   * @param {{ container?: object | null } | null} answer
   */
  #takeKept(fileIndex, answer) {
    if (!Number.isInteger(fileIndex) || !answer?.container || this.#containers.has(fileIndex)) return;
    this.#keepContainer(fileIndex, answer.container);
  }

  /**
   * @param {number} selection
   * @param {number} fileIndex
   */
  async #identifyPicture(selection, fileIndex) {
    if (this.#askedPictures.has(fileIndex)) {
      return;
    }
    this.#askedPictures.add(fileIndex);
    const request = pictureIdentification(this.#filesByIndex.get(fileIndex), this.#itemsByIndex.get(fileIndex));
    if (request.names.length === 0) {
      return;
    }
    const answer = await this.#post("/api/metadata/identify", { ...request, language: METADATA_LANGUAGE, ...this.#evidence(fileIndex) });
    if (selection !== this.#selection) return;
    this.#takeKept(fileIndex, answer);
    if (answer?.status !== "identified") {
      return;
    }
    this.#pictures[String(fileIndex)] = answer.work;
    this.#publish();
  }

  /**
   * @param {number} fileIndex
   */
  #want(fileIndex) {
    if (!Number.isInteger(fileIndex)) {
      return;
    }
    if (!this.#work) {
      this.#wanted.add(fileIndex);
      return;
    }
    this.#askSeasonOf(fileIndex);
  }

  /**
   * Ask for the season a file is in — once per season, with every file of it.
   *
   * @param {number} fileIndex
   */
  #askSeasonOf(fileIndex) {
    const work = this.#work?.normalized ?? this.#work;
    const tmdbId = this.#work?.sources?.tmdb?.tmdbId ?? work?.tmdbId;
    if (!["series", "tv"].includes(work?.kind) || !Number.isInteger(tmdbId)) {
      return;
    }
    const season = seasonOf(this.#itemsByIndex.get(fileIndex)?.episode, work);
    if (season === null || this.#askedSeasons.has(season)) {
      return;
    }
    this.#askedSeasons.add(season);
    const items = [...this.#itemsByIndex.values()];
    const files = seasonFiles(items, work, season);
    if (files.length === 0) {
      return;
    }
    void this.#matchSeason(this.#selection, { ...work, tmdbId }, season, files);
  }

  /**
   * @param {number} selection
   * @param {object} work
   * @param {number} season
   * @param {object[]} files
   */
  async #matchSeason(selection, work, season, files) {
    const answer = await this.#post("/api/metadata/episodes", {
      tmdbId: work.tmdbId,
      season,
      language: METADATA_LANGUAGE,
      files
    });
    if (selection !== this.#selection || answer?.status !== "matched-season") {
      return;
    }
    this.#seasons[String(season)] = answer.season?.name ?? "";
    for (const match of answer.files ?? []) {
      if (match.status === "matched") {
        const found = { source: "tmdb", season, episodes: match.episodes, part: match.part ?? null };
        // An episode title the file stated and the page already shows stays.
        if (this.#episodes[match.key]?.source === "container") this.#noteContradiction(Number(match.key), this.#episodes[match.key], found);
        else this.#episodes[match.key] = found;
      }
    }
    this.#publish();
  }

  #publish() {
    document.dispatchEvent(
      new CustomEvent(MEDIA_INFO_EVENTS.CHANGED, {
        detail: {
          selection: this.#selection,
          work: this.#work,
          seasons: { ...this.#seasons },
          episodes: { ...this.#episodes },
          pictures: { ...this.#pictures },
          containers: Object.fromEntries([...new Set([...this.#containers.keys(), ...this.#covers.keys()])].map((index) => [index, {
            ...(this.#containers.get(index) ?? {}),
            ...(this.#covers.has(index) ? { coverUrl: this.#covers.get(index).url, coverType: this.#covers.get(index).type } : {})
          }])),
          markers: Object.fromEntries([...this.#itemsByIndex].map(([index, item]) => [index, item.episode])),
          files: Object.fromEntries(this.#filesByIndex),
          releaseName: this.#contents?.name ?? this.#selectionNames[0] ?? ""
        }
      })
    );
  }

  /**
   * One request to the metadata service. Any failure is an absent answer.
   *
   * @param {string} path
   * @param {object} body
   * @returns {Promise<any>}
   */
  async #post(path, body) {
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: requestHeaders(),
        body: JSON.stringify(body),
        signal: this.#abort?.signal
      });
      return response.ok ? await response.json() : null;
    } catch {
      // silent-ok: film metadata is decoration over playback. A failed or
      // cancelled request leaves the release's own names on screen, which is
      // exactly what the page showed before this existed.
      return null;
    }
  }
}

function bootstrapMediaInfo() {
  new MediaInfoController();
}

if (document.readyState !== "loading") {
  bootstrapMediaInfo();
} else {
  document.addEventListener("DOMContentLoaded", bootstrapMediaInfo, { once: true });
}
