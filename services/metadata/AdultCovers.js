/**
 * @file The cover of an adult scene, fetched for the page through this server.
 *
 * The page never gets an address of another site: it asks for the cover of a
 * scene by the source and the scene's id, this server asks that source for the
 * address of the image, and the image is fetched only from the hosts the two
 * databases serve their covers from. The answer is bounded in time and bytes,
 * must be an image, and is passed on with a day of caching.
 */

import { readBoundedBody } from "./bounded-body.js";
import { MetadataUnavailableError } from "./RequestGate.js";

/** A scene id of either database. */
const SCENE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Hosts a cover may be fetched from. */
const COVER_HOSTS = [/^stashdb\.org$/u, /^(?:[a-z0-9-]+\.)*theporndb\.net$/u];

/** Largest cover read, in bytes. */
const MAX_COVER_BYTES = 8 * 1024 * 1024;

/** How long one cover may take, in milliseconds. */
const COVER_BUDGET_MS = 6_000;

/** What a cover is cached for, in seconds. */
const COVER_MAX_AGE = 86_400;

export class AdultCovers {
  /** @type {Map<string, { coverUrl: (id: string) => Promise<string | null> }>} */
  #sources;
  #fetch;

  /**
   * @param {object} params
   * @param {Array<{ name: string, coverUrl: (id: string) => Promise<string | null> }>} params.providers
   * @param {typeof fetch} [params.fetch]
   */
  constructor({ providers, fetch = globalThis.fetch }) {
    this.#sources = new Map(providers.map((provider) => [provider.name, provider]));
    this.#fetch = fetch;
  }

  /**
   * @param {string} source - `theporndb` or `stashdb`.
   * @param {string} id
   * @returns {Promise<{ status: number, headers: Record<string, string>, body: Buffer } | null>} `null` for no such cover.
   * @throws {MetadataUnavailableError}
   */
  async fetch(source, id) {
    const provider = this.#sources.get(source);
    if (!provider || !SCENE_ID.test(id)) return null;
    const address = await provider.coverUrl(id);
    if (!address) return null;
    const url = new URL(address);
    if (url.protocol !== "https:" || !COVER_HOSTS.some((pattern) => pattern.test(url.hostname))) return null;
    let response;
    try {
      response = await this.#fetch(url, { signal: AbortSignal.timeout(COVER_BUDGET_MS), redirect: "error" });
    } catch (cause) {
      throw new MetadataUnavailableError("the cover did not arrive", { cause });
    }
    if (!response.ok) throw new MetadataUnavailableError(`the cover host answered ${response.status}`);
    const type = response.headers.get("content-type") ?? "";
    if (!/^image\/(?:jpeg|png|webp)\b/u.test(type)) throw new MetadataUnavailableError("the cover is not an image");
    const body = await readBoundedBody(response, MAX_COVER_BYTES);
    return { status: 200, headers: { "content-type": type, "cache-control": `public, max-age=${COVER_MAX_AGE}` }, body };
  }
}
