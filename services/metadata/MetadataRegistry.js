/**
 * @file The list of metadata sources, and the order in which they are asked.
 *
 * The registry does for film metadata what `SubtitleService` does for
 * subtitles: it holds the providers and knows nothing of how any of them asks
 * its database. It owns the order of questions:
 *
 *  1. every source that derives evidence from the request (the container)
 *     adds its names, ids and episode numbers to the request;
 *  2. the primary sources are asked from the request alone, in this order:
 *     1. the exact question first — the hash of the file, asked of every source
 *        that takes it, whatever the category: a match is not a guess;
 *     2. then the names, the kind of database the request states first (adult
 *        when the page states the category adult, general otherwise);
 *     3. the other kind is asked by name only after the supplementary sources
 *        (anime) as well, and only when nothing was found at all — not when
 *        there were several candidates, which is an answer;
 *  3. the supplementary sources are asked with the answer so far in hand;
 *  4. when nothing was found, the primary sources get one last bounded attempt,
 *     and a work found by it is looked at again by the sources interested in it.
 *
 * The answer keeps the record of each source apart, and the common fields are
 * chosen per field by `mergeRecords`.
 */

import { CATEGORY, EVIDENCE, STAGE } from "./MetadataProvider.js";
import { mergeRecords } from "./normalize-work.js";

/** The statuses of an answer that mean no work was found yet. */
const UNRESOLVED = ["not-found", "undetermined", "unavailable"];

/** How good an answer is, to keep the best of several primary sources. */
const RANK = { identified: 4, ambiguous: 3, undetermined: 2, unavailable: 1, "not-found": 0 };

export class MetadataRegistry {
  /** @type {import("./MetadataProvider.js").MetadataProvider[]} */
  #providers;

  /** @param {{ providers: import("./MetadataProvider.js").MetadataProvider[] }} params */
  constructor({ providers }) {
    this.#providers = [...providers].sort((a, b) => a.stage - b.stage);
  }

  /** @param {number} stage */
  #at(stage) {
    return this.#providers.filter((provider) => provider.stage === stage);
  }

  /**
   * Which work these names identify.
   *
   * @param {object} request
   * @returns {Promise<{ status: string, work?: object, candidates?: object[] }>}
   */
  async identify(request) {
    const evidenced = this.#withEvidence(request);
    let result = await this.#stages(evidenced);
    if (UNRESOLVED.includes(result.status)) {
      let tried = false;
      for (const provider of this.#at(STAGE.primary)) {
        const other = await provider.lastResort(evidenced);
        if (!other) continue;
        tried = true;
        if (["identified", "ambiguous"].includes(other.status) || result.status === "not-found") result = other;
      }
      if (tried && result.status === "identified" && this.#at(STAGE.supplement).some((provider) => provider.interestedIn(evidenced.names, result.work))) {
        const enriched = await this.#stages({ ...evidenced, names: [`${result.work.title} ${result.work.year}`], kindHint: result.work.kind });
        if (enriched.status === "identified" && enriched.work?.tmdbId === result.work.tmdbId) result = enriched;
      }
    }
    const { records, ...answer } = result;
    if (answer.status !== "identified") return answer;
    return { status: "identified", work: this.#merge(records ?? {}, evidenced) };
  }

  /** The episodes of one season, from the first source that answers them. */
  async episodes(request) {
    const provider = this.#providers.find((candidate) => candidate.supportsEpisodes);
    return provider ? provider.episodes(request) : { status: "unavailable" };
  }

  /** The best answer of the primary sources, in the order stated above. */
  async #primary(request) {
    const sources = this.#at(STAGE.primary);
    const hasNames = Array.isArray(request.names) && request.names.length > 0;
    const first = request.category === "adult" ? CATEGORY.adult : CATEGORY.general;
    let result = null;
    const consider = (answer) => {
      if (!result || RANK[answer.status] > RANK[result.status]) result = answer;
      return result.status === "identified";
    };
    if (request.fingerprint) {
      for (const provider of sources.filter((candidate) => candidate.takes.has(EVIDENCE.fingerprint))) {
        if (consider(await provider.identify({ ...request, names: [] }))) return result;
      }
    }
    if (!hasNames) return result ?? { status: "not-found" };
    const byName = { ...request, fingerprint: undefined };
    const named = (kind) => sources.filter((candidate) => candidate.category === kind && candidate.takes.has(EVIDENCE.names) && candidate.accepts(byName));
    for (const provider of named(first)) {
      if (consider(await provider.identify(byName))) return result;
    }
    return result ?? { status: "not-found" };
  }

  /**
   * The databases of the other kind, by name. Asked after the supplementary
   * sources (anime), and only when nothing was found at all.
   */
  async #otherKind(request, prior) {
    if (!["not-found", "undetermined", "unavailable"].includes(prior.status) || !request.names?.length) return prior;
    const byName = { ...request, fingerprint: undefined };
    const other = request.category === "adult" ? CATEGORY.general : CATEGORY.adult;
    let result = prior;
    for (const provider of this.#at(STAGE.primary).filter((candidate) => candidate.category === other && candidate.takes.has(EVIDENCE.names) && candidate.accepts(byName))) {
      const answer = await provider.identify(byName);
      if (RANK[answer.status] > RANK[result.status]) result = answer;
      if (result.status === "identified") break;
    }
    return result;
  }

  /** The primary sources, then the supplementary ones with the answer so far. */
  async #stages(request) {
    let result = await this.#primary(request);
    for (const provider of this.#at(STAGE.supplement)) {
      if (!provider.accepts(request)) continue;
      result = await provider.identify(request, { prior: result, again: (next) => this.#primary(next) });
    }
    return this.#otherKind(request, result);
  }

  /** The request with what the sources derive from it added. */
  #withEvidence(request) {
    let next = request;
    for (const provider of this.#providers) {
      if (!provider.accepts(request)) continue;
      const evidence = provider.evidenceFrom(request);
      if (!evidence) continue;
      const added = {};
      if (evidence.names?.length) added.names = [...new Set([...(next.names ?? []), ...evidence.names])];
      if (evidence.externalIds && Object.keys(evidence.externalIds).length > 0) added.externalIds = { ...next.externalIds, ...evidence.externalIds };
      for (const key of ["season", "episode", "episodeTitle"]) if (evidence[key] !== undefined) added[key] = evidence[key];
      next = { ...next, ...added };
    }
    return next;
  }

  /** The records of the answer, and those the other sources add, as one work. */
  #merge(records, request) {
    const all = { ...records };
    for (const provider of this.#providers) {
      if (!provider.accepts(request)) continue;
      const contributed = provider.contribute(request);
      if (contributed) all[provider.name] = contributed;
    }
    const entries = [];
    for (const [source, record] of Object.entries(all)) {
      const provider = this.#providers.find((candidate) => candidate.name === source);
      if (provider) entries.push({ source, record, fields: provider.fields(record) });
    }
    return mergeRecords(entries);
  }
}