/**
 * @file TMDB images, fetched for the page through this server.
 *
 * Only TMDB's own images are fetched, by a size from a fixed list and a file
 * name of the shape TMDB gives its images — never an address the browser
 * supplies. The answer is limited in time and bytes, must be an image, and is
 * passed on with the caching headers TMDB set for it: TMDB states a long
 * `max-age` for an image path, and this server adds nothing it cannot confirm
 * (`immutable` is not added).
 *
 * Nothing is kept in this process: repeated requests are meant to be answered
 * by Cloudflare's cache in front of the server, and whether they are is
 * checked after release rather than assumed.
 */

import { readBoundedBody } from "./bounded-body.js";
import { MetadataUnavailableError } from "./RequestGate.js";

const IMAGE_ROOT = "https://image.tmdb.org/t/p";

/** Sizes the page asks for. */
export const IMAGE_SIZES = new Set(["w185", "w300", "w342", "w500", "w780", "w1280", "original"]);

/** A TMDB image file name. */
export const IMAGE_FILE = /^[A-Za-z0-9]{8,64}\.(?:jpg|png)$/;

/** Largest image read, in bytes. */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

/** How long one image may take. */
const IMAGE_BUDGET_MS = 5_000;

/** Headers passed on from TMDB's answer. */
const PASSED_HEADERS = ["cache-control", "etag", "last-modified", "expires"];

export class ImageFetcher {
  /** @type {import("./RequestGate.js").RequestGate} */
  #gate;

  /** @type {typeof fetch} */
  #fetch;

  /** @type {() => number} */
  #now;

  /**
   * @param {object} params
   * @param {import("./RequestGate.js").RequestGate} params.gate
   * @param {typeof fetch} [params.fetch]
   * @param {() => number} [params.now]
   */
  constructor({ gate, fetch = globalThis.fetch, now = Date.now }) {
    this.#gate = gate;
    this.#fetch = fetch;
    this.#now = now;
  }

  /**
   * @param {string} size - One of {@link IMAGE_SIZES}.
   * @param {string} file - Matching {@link IMAGE_FILE}.
   * @param {{ ifNoneMatch?: string, ifModifiedSince?: string }} conditions
   * @returns {Promise<{ status: number, headers: Record<string, string>, body: Buffer | null }>}
   */
  async fetch(size, file, { ifNoneMatch, ifModifiedSince } = {}) {
    if (!IMAGE_SIZES.has(size) || !IMAGE_FILE.test(file)) {
      throw new MetadataUnavailableError("not an image this server serves");
    }
    const deadlineAt = this.#now() + IMAGE_BUDGET_MS;
    return this.#gate.run(async () => {
      const headers = { Accept: "image/jpeg, image/png" };
      if (ifNoneMatch) {
        headers["If-None-Match"] = ifNoneMatch;
      }
      if (ifModifiedSince) {
        headers["If-Modified-Since"] = ifModifiedSince;
      }
      let response;
      try {
        response = await this.#fetch(`${IMAGE_ROOT}/${size}/${file}`, {
          headers,
          signal: AbortSignal.timeout(Math.max(1, deadlineAt - this.#now()))
        });
      } catch (error) {
        throw new MetadataUnavailableError(`the image did not arrive (${error?.name ?? "error"})`);
      }
      const passed = {};
      for (const name of PASSED_HEADERS) {
        const value = response.headers.get(name);
        if (value) {
          passed[name] = value;
        }
      }
      if (response.status === 304) {
        await response.body?.cancel().catch(() => {});
        return { status: 304, headers: passed, body: null };
      }
      const type = response.headers.get("content-type") ?? "";
      if (!response.ok || !/^image\/(?:jpeg|png)\b/.test(type)) {
        await response.body?.cancel().catch(() => {});
        throw new MetadataUnavailableError(`the image source answered ${response.status} ${type}`);
      }
      const body = await readBoundedBody(response, MAX_IMAGE_BYTES);
      return { status: 200, headers: { ...passed, "content-type": type }, body };
    }, { deadlineAt });
  }
}
