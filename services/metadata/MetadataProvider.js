/**
 * @file What every source of film metadata implements, so the registry can hold
 * a list of them the way the subtitle service holds its providers.
 *
 * A source takes part in two ways, and one class may do both:
 *
 *  1. **It identifies and describes a work.** `identify` answers for a request
 *     and returns the raw records it found, keyed by the name of the source. The
 *     records are reduced to the common fields by {@link MetadataProvider#fields}
 *     and combined by `mergeRecords` in `normalize-work.js`, which states per
 *     field which source comes first.
 *  2. **It is evidence for the others.** `evidenceFrom` turns what the request
 *     already holds into names, ids and episode numbers that the other sources
 *     are asked with; an id replaces a search with a lookup.
 *
 * What a source takes is stated by `takes` through the kinds in {@link EVIDENCE};
 * the registry never asks a source about evidence it does not take.
 */

/** The kinds of evidence a request can carry. */
export const EVIDENCE = Object.freeze({
  /** Names of the release and its files: `request.names`. */
  names: "names",
  /** The release name read into title, year and tags: `request.release`. */
  release: "release",
  /** A hash of the bytes of the file with its size: `request.fingerprint`. */
  fingerprint: "fingerprint",
  /** What the media container states about itself: `request.container`. */
  container: "container",
  /** Ids of the work in other databases: `request.externalIds`. */
  externalIds: "externalIds"
});

/**
 * What kind of database a source is. It decides the order of questions by name
 * (see `MetadataRegistry`): the kind a request states comes first, the other
 * kind is asked only when nothing was found. It never stops a source being
 * asked: an exact question (the hash of the file) is asked of every source that
 * takes it, and a name that the general databases cannot place may still be a
 * scene in an adult one.
 */
export const CATEGORY = Object.freeze({
  /** The media container: evidence for the others, asked of nobody. */
  any: "any",
  /** Films, series and anime. */
  general: "general",
  /** Adult scenes and films. */
  adult: "adult"
});

/** Which stage of the registry a source answers in. */
export const STAGE = Object.freeze({
  /** Asked first, from the request alone. */
  primary: 1,
  /** Asked after the primary sources, with their answer in hand. */
  supplement: 2,
  /** Never asked to identify; only supplies evidence and a record. */
  evidence: 3
});

/**
 * The evidence kinds present in a request.
 *
 * @param {object} request
 * @returns {Set<string>}
 */
function evidenceOf(request) {
  const present = new Set();
  if (Array.isArray(request?.names) && request.names.length > 0) present.add(EVIDENCE.names);
  if (request?.release) present.add(EVIDENCE.release);
  if (request?.fingerprint) present.add(EVIDENCE.fingerprint);
  if (request?.container) present.add(EVIDENCE.container);
  if (request?.externalIds && Object.keys(request.externalIds).length > 0) present.add(EVIDENCE.externalIds);
  return present;
}

export class MetadataProvider {
  /** @type {string} */
  name;

  /** @type {number} */
  stage;

  /** @type {ReadonlySet<string>} */
  takes;

  /** @type {string} */
  category;

  /**
   * @param {object} params
   * @param {string} params.name - The key of the records of this source.
   * @param {number} params.stage - One of {@link STAGE}.
   * @param {string[]} params.takes - Kinds of {@link EVIDENCE} this source accepts.
   * @param {string} [params.category] - One of {@link CATEGORY}.
   */
  constructor({ name, stage, takes, category = CATEGORY.any }) {
    this.name = name;
    this.stage = stage;
    this.takes = new Set(takes);
    this.category = category;
  }

  /** Whether the request holds evidence that this source takes. */
  accepts(request) {
    const present = evidenceOf(request);
    return [...this.takes].some((kind) => present.has(kind));
  }

  /**
   * Identify the work.
   *
   * @param {object} _request
   * @param {{ prior?: object, again?: (request: object) => Promise<object> }} [_context] - `prior`
   *   is the answer so far; `again` asks the primary sources a new question.
   * @returns {Promise<{ status: string, records?: Record<string, object> }>}
   */
  async identify(_request, _context) {
    throw new Error("MetadataProvider.identify must be implemented");
  }

  /**
   * Identify the work by its id in another database (`request.externalIds`):
   * a lookup, not a search. `null` when this source cannot look one up, or the
   * request holds no id it reads.
   *
   * @param {object} _request
   * @returns {Promise<{ status: string, records?: Record<string, object> } | null>}
   */
  async identifyById(_request) {
    return null;
  }

  /**
   * One last bounded attempt when every source found nothing. `null` when this
   * source has none.
   *
   * @param {object} _request
   * @returns {Promise<{ status: string, records?: Record<string, object> } | null>}
   */
  async lastResort(_request) {
    return null;
  }

  /** Whether this source wants to look again once the work is known. */
  interestedIn(_names, _work) {
    return false;
  }

  /** Whether this source answers `episodes`. */
  get supportsEpisodes() {
    return false;
  }

  /** @returns {Promise<object>} */
  async episodes(_request) {
    throw new Error("MetadataProvider.episodes must be implemented");
  }

  /**
   * Evidence this source derives from the request for the other sources:
   * `names`, `externalIds`, `season`, `episode`, `episodeTitle`, `kindHint`,
   * and — only where the request states none — `episodeEvidence`. `null` for
   * none.
   *
   * @param {object} _request
   * @returns {object | null}
   */
  evidenceFrom(_request) {
    return null;
  }

  /**
   * A record this source adds to an identified work without identifying it.
   * `null` for none.
   *
   * @param {object} _request
   * @returns {object | null}
   */
  contribute(_request) {
    return null;
  }

  /**
   * One raw record reduced to the common fields (see `normalize-work.js`). A
   * field the record does not state is `undefined`; one it states as absent is
   * `null`.
   *
   * @param {object} _record
   * @returns {Record<string, unknown>}
   */
  fields(_record) {
    throw new Error("MetadataProvider.fields must be implemented");
  }
}