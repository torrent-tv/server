/**
 * @file The metadata components, built once at startup.
 *
 * The limits are stated here, in one place, because each is a policy rather
 * than a measurement: they keep this server's load on TMDB far below the
 * "somewhere in the 40 requests per second range" TMDB describes, whatever
 * browsers send.
 */

import { AniListProvider } from "./AniListProvider.js";
import { ContainerMetadata } from "./ContainerMetadata.js";
import { ImageFetcher } from "./ImageFetcher.js";
import { MetadataCache } from "./MetadataCache.js";
import { MetadataRegistry } from "./MetadataRegistry.js";
import { MetadataService } from "./MetadataService.js";
import { RequestGate } from "./RequestGate.js";
import { SharedFetches } from "./SharedFetches.js";
import { StashDbProvider } from "./StashDbProvider.js";
import { ThePornDbProvider } from "./ThePornDbProvider.js";
import { TmdbProvider } from "./TmdbProvider.js";
import { TmdbSource } from "./TmdbSource.js";

/**
 * @param {{ token?: string | null }} params
 * @returns {{ service: MetadataRegistry, images: ImageFetcher }}
 */
export function createMetadata({ token = null, theporndbKey = null, stashdbKey = null, cache, animeCache }) {
  console.log(token ? "[metadata] TMDB token present; film metadata is on" : "[metadata] TMDB_READ_TOKEN is not set; film metadata is off");
  const apiGate = new RequestGate({ concurrency: 4, perSecond: 10, queueLimit: 32 });
  const source = token ? new TmdbSource({ token, gate: apiGate }) : null;
  const service = new MetadataService({
    source,
    runtimeToleranceSeconds: process.env.METADATA_RUNTIME_TOLERANCE_SECONDS === undefined ? undefined : Number(process.env.METADATA_RUNTIME_TOLERANCE_SECONDS),
    // 8 MB of serialized data. Measured 2026-09-30 on Node 24, filling a cache
    // of this budget with entries of the shape kept here: 13.4 MB of heap and
    // 30.5 MB of process growth for searches (4169 entries), 16.8 MB and
    // 38.9 MB for seasons (8536 entries) — on a droplet with 393 MB available.
    cache: cache ?? new MetadataCache({ budgetBytes: 8 * 1024 * 1024, maxEntryBytes: 256 * 1024 }),
    fetches: new SharedFetches({ waiterLimit: 256 })
  });
  // Images do not count against the API's rate: they come from TMDB's image
  // host, which states no such limit. Concurrency and the queue still bound them.
  const images = new ImageFetcher({ gate: new RequestGate({ concurrency: 4, perSecond: Infinity, queueLimit: 32 }) });
  // The adult databases are asked only when a request states the category adult
  // (CATEGORY in MetadataProvider.js); the general ones are not asked then.
  const adult = [
    theporndbKey ? new ThePornDbProvider({ key: theporndbKey }) : null,
    stashdbKey ? new StashDbProvider({ key: stashdbKey }) : null
  ].filter(Boolean);
  console.log(`[metadata] adult databases: ${adult.map(provider => provider.name).join(", ") || "none"}`);
  const providers = [...adult, new TmdbProvider(service), new AniListProvider({ cache: animeCache }), new ContainerMetadata()];
  return { service: new MetadataRegistry({ providers }), images };
}
