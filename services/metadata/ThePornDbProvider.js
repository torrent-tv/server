/**
 * @file ThePornDB as a metadata source for adult releases.
 *
 * Asked only when the page states the category "adult" (see CATEGORY). Two
 * questions, the exact one first: the OpenSubtitles hash of the file, then the
 * release name. A scene is reported only when the database returns exactly one,
 * so a name that fits several is not shown as any of them.
 */

import { CATEGORY, EVIDENCE, MetadataProvider, STAGE } from "./MetadataProvider.js";
import { RequestGate, MetadataUnavailableError } from "./RequestGate.js";
import { MetadataCache } from "./MetadataCache.js";
import { providerFailure, registerDiagnosticSecret } from "./provider-diagnostics.js";
import { requestJson, yearOf } from "./adult-http.js";

const BASE = "https://api.theporndb.net";

/**
 * The address of the cover of a scene on the database's own hosts. Not `image`:
 * that is the page of the studio, which this server does not fetch from. The
 * wide background suits the player; the poster is the fallback.
 *
 * @param {object | undefined} scene
 * @returns {string | null}
 */
function coverOf(scene) {
  return scene?.background?.large || scene?.background?.full || scene?.posters?.large || scene?.poster || null;
}

/**
 * A ThePornDB scene reduced to the common fields.
 *
 * @param {object} scene
 * @returns {Record<string, unknown>}
 */
function theporndbFields(scene) {
  return {
    kind: "movie",
    title: scene.title || undefined,
    year: yearOf(scene.date),
    overview: scene.description || undefined,
    poster: coverOf(scene) ? `/api/metadata/cover/theporndb/${scene.id}` : undefined,
    studio: scene.site?.name || scene.site?.parent?.name || undefined,
    performers: (scene.performers ?? []).map(performer => performer?.name).filter(Boolean).slice(0, 20),
    adult: true
  };
}

export class ThePornDbProvider extends MetadataProvider {
  #fetch;
  #gate;
  #key;
  #cache;

  /**
   * @param {object} params
   * @param {string} params.key - The API key; never logged.
   */
  constructor({ key, fetch = globalThis.fetch, gate = new RequestGate({ concurrency: 2, perSecond: 2, queueLimit: 8 }), cache } = {}) {
    super({ name: "theporndb", stage: STAGE.primary, takes: [EVIDENCE.fingerprint, EVIDENCE.names], category: CATEGORY.adult });
    this.#key = key;
    registerDiagnosticSecret(key);
    this.#fetch = fetch;
    this.#gate = gate;
    this.#cache = cache ?? new MetadataCache({ budgetBytes: 1024 * 1024, maxEntryBytes: 128 * 1024 });
  }

  fields(record) {
    return theporndbFields(record);
  }

  async identify(request) {
    try {
      const hash = request.fingerprint?.hash;
      if (typeof hash === "string" && /^[0-9a-f]{16}$/u.test(hash)) {
        const scenes = await this.#scenes(new URLSearchParams({ hash, hashType: "OSHASH", per_page: "5" }));
        if (scenes.length === 1) return this.#identified(scenes[0]);
        if (scenes.length > 1) return { status: "ambiguous" };
      }
      const found = new Map();
      for (const name of (request.names ?? []).slice(0, 4)) {
        for (const scene of await this.#scenes(new URLSearchParams({ parse: name, per_page: "5" }))) found.set(scene.id, scene);
      }
      if (found.size === 1) return this.#identified([...found.values()][0]);
      return { status: found.size > 1 ? "ambiguous" : "not-found" };
    } catch (error) {
      if (error instanceof MetadataUnavailableError) { providerFailure("theporndb", "identify", error); return { status: "unavailable" }; }
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
      const body = await requestJson({
        fetch: this.#fetch, gate: this.#gate, label: "ThePornDB", url: `${BASE}/scenes/${id}`,
        init: { headers: { Authorization: `Bearer ${this.#key}`, Accept: "application/json" } }
      });
      return coverOf(body?.data);
    } catch (error) {
      if (error instanceof MetadataUnavailableError) { providerFailure("theporndb", "cover", error); return null; }
      throw error;
    }
  }

  #identified(scene) {
    const work = { source: "theporndb", id: scene.id, kind: "movie", title: scene.title, year: yearOf(scene.date) ?? null, adult: true };
    return { status: "identified", work, records: { theporndb: scene } };
  }

  async #scenes(query) {
    const url = `${BASE}/scenes?${query}`;
    const cached = await this.#cache.get(url);
    if (cached) return cached;
    const body = await requestJson({
      fetch: this.#fetch, gate: this.#gate, label: "ThePornDB", url,
      init: { headers: { Authorization: `Bearer ${this.#key}`, Accept: "application/json" } }
    });
    if (!Array.isArray(body?.data)) throw new MetadataUnavailableError("ThePornDB returned invalid data");
    const scenes = body.data.filter(scene => scene && typeof scene.id === "string");
    await this.#cache.set(url, scenes, 60 * 60 * 1000);
    return scenes;
  }
}
