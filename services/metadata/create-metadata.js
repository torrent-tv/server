import { AnimeMetadata } from "./AnimeMetadata.js";
/**
 * @file The metadata components, built once at startup.
 *
 * The limits are stated here, in one place, because each is a policy rather
 * than a measurement: they keep this server's load on TMDB far below the
 * "somewhere in the 40 requests per second range" TMDB describes, whatever
 * browsers send.
 */

import { readFileSync } from "node:fs";
import { ImageFetcher } from "./ImageFetcher.js";
import { MetadataCache } from "./MetadataCache.js";
import { MetadataService } from "./MetadataService.js";
import { RequestGate } from "./RequestGate.js";
import { SharedFetches } from "./SharedFetches.js";
import { TmdbSource } from "./TmdbSource.js";

/**
 * The TMDB token from its file, or `null` with the reason logged. The token
 * itself is never logged.
 *
 * @param {string | undefined} path
 * @returns {string | null}
 */
function readToken(path) {
  if (!path) {
    console.log("[metadata] TMDB_READ_TOKEN_FILE is not set; film metadata is off");
    return null;
  }
  try {
    const token = readFileSync(path, "utf8").trim();
    if (token.length === 0) {
      console.log(`[metadata] ${path} is empty; film metadata is off`);
      return null;
    }
    console.log("[metadata] TMDB token loaded; film metadata is on");
    return token;
  } catch (error) {
    console.log(`[metadata] ${path} cannot be read (${error?.code ?? error?.message}); film metadata is off`);
    return null;
  }
}

/**
 * @param {{ tokenFile?: string }} params
 * @returns {{ service: MetadataService, images: ImageFetcher }}
 */
export function createMetadata({ tokenFile }) {
  const token = readToken(tokenFile);
  const apiGate = new RequestGate({ concurrency: 4, perSecond: 10, queueLimit: 32 });
  const source = token ? new TmdbSource({ token, gate: apiGate }) : null;
  const service = new MetadataService({
    source,
    // 8 MB of serialized data. Measured 2026-09-30 on Node 24, filling a cache
    // of this budget with entries of the shape kept here: 13.4 MB of heap and
    // 30.5 MB of process growth for searches (4169 entries), 16.8 MB and
    // 38.9 MB for seasons (8536 entries) — on a droplet with 393 MB available.
    cache: new MetadataCache({ budgetBytes: 8 * 1024 * 1024, maxEntryBytes: 256 * 1024 }),
    fetches: new SharedFetches({ waiterLimit: 256 })
  });
  // Images do not count against the API's rate: they come from TMDB's image
  // host, which states no such limit. Concurrency and the queue still bound them.
  const images = new ImageFetcher({ gate: new RequestGate({ concurrency: 4, perSecond: Infinity, queueLimit: 32 }) });
  return { service: new AnimeMetadata(service), images };
}
