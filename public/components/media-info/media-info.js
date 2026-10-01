import { APP_EVENTS, LOADING_EVENTS, MEDIA_INFO_EVENTS } from "../../shared/events.js";
import { subtitleEvidenceOf } from "../../domain/subtitle-evidence.js";
import {
  METADATA_LANGUAGE,
  boundedNames,
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
    const names = boundedNames(Array.isArray(detail?.names) ? detail.names : []);
    if (names.length > 0) {
      // Preparation only; see the class comment.
      void this.#post("/api/metadata/identify", { names, kindHint: null, language: METADATA_LANGUAGE });
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
    const answer = await this.#post("/api/metadata/identify", { ...request, language: METADATA_LANGUAGE });
    if (selection !== this.#selection) return;
    this.#releaseStatus = answer?.status ?? null;
    if (answer?.status !== "identified") {
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
    for (const fileIndex of this.#wanted) {
      this.#askSeasonOf(fileIndex);
    }
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
    const answer = await this.#post("/api/metadata/identify", { ...request, language: METADATA_LANGUAGE });
    if (selection !== this.#selection || answer?.status !== "identified") {
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
        this.#episodes[match.key] = { source: "tmdb", season, episodes: match.episodes, part: match.part ?? null };
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
        headers: { "Content-Type": "application/json" },
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
