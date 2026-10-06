/**
 * @file What one file of a torrent states about its work, kept by the torrent's
 * infohash and the file's index (torrent-tv/meta#136, #139).
 *
 * Reading it costs the first viewer a wait: the proxy reads it from the file's
 * edges once they arrive, a median of 51 s after the torrent is opened on a cold
 * swarm. Kept here, it is paid once per torrent: the next viewer of the same
 * file, on any proxy, is identified with it from the first request, and a pack's
 * files are identified with what earlier viewers' proxies read from them.
 *
 * It holds public facts of a file and nothing about who asked: the key is the
 * file, the value is what its bytes state. A file's bytes do not change, so a
 * record is replaced only when a proxy reads it again; it leaves when the
 * cache's budget needs the room.
 */

import { readContainerFacts } from "./ContainerMetadata.js";

/** How long a record is kept when nothing needs its room. A stated limit. */
const RECORD_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** A BitTorrent v1 infohash (40 hex digits) or a v2 one (64). */
const INFO_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/**
 * The file a request names, or `null` when it names none that can be kept.
 *
 * @param {unknown} source
 * @returns {{ infoHash: string, fileIndex: number } | null}
 */
export function fileOf(source) {
  if (!source || typeof source !== "object") return null;
  const infoHash = typeof source.infoHash === "string" ? source.infoHash.toLowerCase() : "";
  const { fileIndex } = source;
  return INFO_HASH.test(infoHash) && Number.isInteger(fileIndex) && fileIndex >= 0 && fileIndex <= 1_000_000 ? { infoHash, fileIndex } : null;
}

export class ContainerRecords {
  /** @type {{ get: (key: string) => unknown, set: (key: string, value: unknown, ttlMs: number) => unknown }} */
  #cache;

  /** @param {{ cache: { get: (key: string) => unknown, set: (key: string, value: unknown, ttlMs: number) => unknown } }} params */
  constructor({ cache }) {
    this.#cache = cache;
  }

  /**
   * What the file states, as kept; `undefined` when nothing is kept for it.
   *
   * @param {{ infoHash: string, fileIndex: number }} file
   * @returns {Promise<object | undefined>}
   */
  async get({ infoHash, fileIndex }) {
    try {
      return readContainerFacts(await this.#cache.get(`${infoHash}:${fileIndex}`)) ?? undefined;
    } catch (error) {
      // A record that cannot be read is a record not kept: identification goes on without it.
      console.warn(`[metadata] container record could not be read: ${error?.message ?? error}`);
      return undefined;
    }
  }

  /**
   * Keep what the file states, in the checked shape only.
   *
   * @param {{ infoHash: string, fileIndex: number }} file
   * @param {unknown} container
   * @returns {Promise<void>}
   */
  async set({ infoHash, fileIndex }, container) {
    const facts = readContainerFacts(container);
    if (!facts) return;
    try {
      await this.#cache.set(`${infoHash}:${fileIndex}`, facts, RECORD_TTL_MS);
    } catch (error) {
      // Not keeping it costs the next viewer a wait, not this one an answer.
      console.warn(`[metadata] container record could not be kept: ${error?.message ?? error}`);
    }
  }
}
