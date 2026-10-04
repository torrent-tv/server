# Provider subtitles and server cache

Task: [meta#103](https://github.com/torrent-tv/meta/issues/103).

1. `POST /api/subtitles/search` accepts `kind: movie|series`, `tmdbId` and/or
   `anilistId`. A TMDB series requires a confirmed `season` and `episode`.
   An AniList series uses `anilistEpisode` within that AniList entry. Catalogue
   numbering is not interchangeable. Combined or split TMDB episodes are not
   offered as a single provider episode.
2. Discovery returns provider status and variants with short-lived signed selection
   tokens. It does not obtain download links or consume a subtitle download.
   Search keys include every provider-specific parameter that changes the answer.
   All languages are requested; OpenSubtitles reads at most 20 pages within a
   25-second overall deadline. A bounded list stays explicitly `partial`.
3. `POST /api/subtitles/file` accepts only a server-issued selection token.
   It returns cached WebVTT or downloads and converts the selected file once,
   sharing the operation between concurrent viewers. Tokens are renewed through
   discovery after a restart or expiry. Provider download URLs are temporary and
   are not cached for OpenSubtitles. Credentials are never sent to file hosts.
4. `SubtitleProvider` is the shared base of `OpenSubtitles` and `Jimaku`.
   `ProviderHttp` applies a conservative ceiling of one request per second per
   provider, one concurrent request and at most 16 queued requests. Downloads
   precede queued searches. `429`, remaining-count headers, reset headers and
   `Retry-After` govern pauses. OpenSubtitles download exhaustion separately stops
   new downloads until the reset; cached files remain available. A paid download
   is never retried automatically after an ambiguous failure.
5. `SubtitlePlayback` remains the only owner of track modes. The menu sorts
   embedded tracks, torrent sidecars and provider variants independently of
   arrival order. Discovery never changes the selected track. A pending download
   leaves the current track showing; Off, another choice and a file switch defeat
   its late result. Provider errors appear in the subtitle menu and never change
   video playback state. Failed discovery can be retried from the menu.
6. Only standalone text files are supported: SRT, ASS/SSA and WebVTT. Jimaku ZIP,
   7z and image subtitle files and OpenSubtitles multi-CD sets are not offered as
   whole tracks. ASS positioning, drawing and full styling are not reproduced by
   the native WebVTT renderer. Unlabelled Jimaku file languages stay unknown.
   Provider variants without an established translation identity are not matched
   to an embedded track of the same language on the next episode.
7. `SERVER_CACHE_DIR` enables a shared SQLite cache in a persistent volume.
   `SERVER_CACHE_MIB` is its disk ceiling (default 1024 MiB); it is unrelated to
   torrent storage on proxies. Entries are evicted by last access across all
   namespaces. SQLite's page ceiling bounds the database; its page cache is 2 MiB.
   The temporary transaction journal needs additional space. Keep 256 MiB free
   (`SERVER_CACHE_RESERVE_MIB`) and reject new cache writes if that reserve is unavailable. Cache operations
   run in one worker; queued writes are limited to 16 MiB. Oversized entries or
   failed writes leave successful provider responses usable without caching.
8. Refresh intervals: TMDB work and alternative-title records seven days;
   TMDB nonempty searches and seasons 24 hours, empty searches one hour;
   AniList searches one hour; complete subtitle lists 24 hours, empty or explicitly
   partial lists one hour; converted files 30 days. Expired records are removed
   on access or the next write. Errors and incomplete failed requests are not
   cached as an absence. This is a cache, not a permanent mirror of a provider.
9. Without `SERVER_CACHE_DIR`, local development uses bounded memory caches.
   Runtime keys come from `OPENSUBTITLES_API_KEY` / `JIMAKU_API_KEY` or their
   `_FILE` counterparts. Production uses files in the existing host secrets
   directory. Missing keys disable only the affected provider. GitHub repository
   secrets do not automatically become container environment variables and are
   not embedded in images.

## Provider references

1. [OpenSubtitles API](https://opensubtitles.stoplight.io/docs/opensubtitles-api/)
   and [account quotas](https://opensubtitles.tawk.help/article/getting-started).
   The application key does not grant unlimited downloads; commercial tiers
   are configured in the provider account, not purchased by this application.
2. [Jimaku API](https://jimaku.cc/api/docs) and
   [OpenAPI document](https://jimaku.cc/api/openapi.json). Jimaku explicitly
   describes episode filtering as a filename guess; the menu preserves that fact.
3. [TMDB API terms](https://www.themoviedb.org/api-terms-of-use) prohibit keeping
   its data longer than six months. The implemented intervals are shorter.

No blanket redistribution licence or unlimited provider retention is assumed.
The application keeps a bounded cache of selected text files; provider account
terms and any later retention requirements still apply.
