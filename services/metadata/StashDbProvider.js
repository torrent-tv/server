/**
 * @file StashDB (a stash-box server) as a metadata source for adult releases.
 *
 * Asked only when the page states the category "adult". The exact question is
 * the OpenSubtitles hash of the file (findScenesBySceneFingerprints); the
 * release name is searched with searchScene, and a scene is reported only
 * when exactly one result's title is contained in the release name and, where
 * the release states a year, the years agree. Anything else is not shown.
 */

import { CATEGORY, EVIDENCE, MetadataProvider, STAGE } from "./MetadataProvider.js";
import { RequestGate, MetadataUnavailableError } from "./RequestGate.js";
import { MetadataCache } from "./MetadataCache.js";
import { providerFailure, registerDiagnosticSecret } from "./provider-diagnostics.js";
import { normalizeTitle } from "./title.js";
import { requestJson, wordsOf, yearOf } from "./adult-http.js";

const ENDPOINT = "https://stashdb.org/graphql";

const SCENE = "id title details release_date images { url } studio { name } performers { performer { name } }";

const BY_FINGERPRINT = `query($f:[[FingerprintQueryInput!]!]!){ findScenesBySceneFingerprints(fingerprints:$f){ ${SCENE} } }`;
const BY_TERM = `query($t:String!){ searchScene(term:$t, limit:5){ ${SCENE} } }`;

/**
 * A StashDB scene reduced to the common fields.
 *
 * @param {object} scene
 * @returns {Record<string, unknown>}
 */
export function stashdbFields(scene) {
  return {
    kind: "movie",
    title: scene.title || undefined,
    year: yearOf(scene.release_date),
    overview: scene.details || undefined,
    poster: scene.images?.length ? `/api/metadata/cover/stashdb/${scene.id}` : undefined,
    studio: scene.studio?.name || undefined,
    performers: (scene.performers ?? []).map(entry => entry?.performer?.name).filter(Boolean).slice(0, 20),
    adult: true
  };
}

export class StashDbProvider extends MetadataProvider {
  #fetch;
  #gate;
  #key;
  #cache;

  /**
   * @param {object} params
   * @param {string} params.key - The API key; never logged.
   */
  constructor({ key, fetch = globalThis.fetch, gate = new RequestGate({ concurrency: 2, perSecond: 2, queueLimit: 8 }), cache } = {}) {
    super({ name: "stashdb", stage: STAGE.primary, takes: [EVIDENCE.fingerprint, EVIDENCE.names], category: CATEGORY.adult });
    this.#key = key;
    registerDiagnosticSecret(key);
    this.#fetch = fetch;
    this.#gate = gate;
    this.#cache = cache ?? new MetadataCache({ budgetBytes: 1024 * 1024, maxEntryBytes: 128 * 1024 });
  }

  fields(record) {
    return stashdbFields(record);
  }

  async identify(request) {
    try {
      const hash = request.fingerprint?.hash;
      if (typeof hash === "string" && /^[0-9a-f]{16}$/u.test(hash)) {
        const data = await this.#query(BY_FINGERPRINT, { f: [[{ hash, algorithm: "OSHASH" }]] });
        const scenes = (data?.findScenesBySceneFingerprints ?? []).flat().filter(scene => scene?.id);
        const unique = [...new Map(scenes.map(scene => [scene.id, scene])).values()];
        if (unique.length === 1) return this.#identified(unique[0]);
        if (unique.length > 1) return { status: "ambiguous" };
      }
      const found = new Map();
      for (const name of (request.names ?? []).slice(0, 4)) {
        const words = wordsOf(name);
        if (!words) continue;
        const data = await this.#query(BY_TERM, { t: words });
        const reading = normalizeTitle(words);
        const years = [...words.matchAll(/\b(?:19|20)\d{2}\b/gu)].map(match => Number(match[0]));
        for (const scene of data?.searchScene ?? []) {
          const title = normalizeTitle(scene?.title);
          const year = yearOf(scene?.release_date);
          if (scene?.id && title && reading.includes(title) && (years.length === 0 || year === undefined || years.includes(year))) found.set(scene.id, scene);
        }
      }
      if (found.size === 1) return this.#identified([...found.values()][0]);
      return { status: found.size > 1 ? "ambiguous" : "not-found" };
    } catch (error) {
      if (error instanceof MetadataUnavailableError) { providerFailure("stashdb", "identify", error); return { status: "unavailable" }; }
      throw error;
    }
  }

  /**
   * The address of the cover image of a scene, asked of the database.
   *
   * @param {string} id
   * @returns {Promise<string | null>}
   */
  async coverUrl(id) {
    try {
      const data = await this.#query("query($id:ID!){ findScene(id:$id){ images { url width height } } }", { id });
      const images = data?.findScene?.images ?? [];
      const widest = images.reduce((best, image) => ((image?.width ?? 0) > (best?.width ?? 0) ? image : best), images[0]);
      return widest?.url ?? null;
    } catch (error) {
      if (error instanceof MetadataUnavailableError) { providerFailure("stashdb", "cover", error); return null; }
      throw error;
    }
  }

  #identified(scene) {
    const work = { source: "stashdb", id: scene.id, kind: "movie", title: scene.title, year: yearOf(scene.release_date) ?? null, adult: true };
    return { status: "identified", work, records: { stashdb: scene } };
  }

  async #query(query, variables) {
    const key = JSON.stringify([query, variables]);
    const cached = await this.#cache.get(key);
    if (cached) return cached;
    const body = await requestJson({
      fetch: this.#fetch, gate: this.#gate, label: "StashDB", url: ENDPOINT,
      init: { method: "POST", headers: { "Content-Type": "application/json", ApiKey: this.#key }, body: JSON.stringify({ query, variables }) }
    });
    if (body?.errors || !body?.data) {
      const cause = new Error("StashDB answered with errors");
      cause.providerMessage = JSON.stringify(body?.errors ?? []);
      throw new MetadataUnavailableError("StashDB answered with errors", { cause });
    }
    await this.#cache.set(key, body.data, 60 * 60 * 1000);
    return body.data;
  }
}
