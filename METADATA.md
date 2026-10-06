# Media metadata

`POST /api/metadata/identify` returns `work` only for an established identity.
The work contains two separate sections:

1. `sources`: provider records keyed by `tmdb` and `anilist`. A missing provider
   key means that provider has not established a matching record.
2. `normalized`: presentation fields (`kind`, `title`, `originalTitle`, `year`,
   `isAnime`, `overview`, `images`, `seasons`) and their `provenance`.

Normalized kinds are `movie` and `series`. Unknown anime classification is
`null`. Provider records are not overwritten by other providers. Images name
their provider, file, dimensions and role. TMDB remains the artwork and episode
title source. An AniList-only identity has no invented TMDB artwork or seasons.

The browser's metadata state keeps `markers` from the proxy independently of
`episodes` matched against TMDB. Labels use release numbers; titles are used
only after episode matching. A mismatch never changes the release numbering.

## Sources and their interface

Every source extends `MetadataProvider` (`services/metadata/`), the way the
subtitle sources extend `SubtitleProvider`, and `MetadataRegistry` holds the
list. A source states the evidence it takes (`names`, `release`, `fingerprint`,
`container`, `externalIds`) and the stage it answers in: primary (TMDB), supplementary
(AniList, asked with the answer so far) or evidence only (the media container).
The registry never asks a source about evidence it does not take.

1. Each source keeps its own record. `fields(record)` reduces it to the common
   format of `normalize-work.js`; a field the record does not state is
   `undefined`, so the next source supplies it.
2. Preference is stated per field in `FIELD_PRIORITY`, not per source, and the
   `provenance` of the answer names the source of each field.
3. The media container (`ContainerMetadata`) is a source and evidence at once.
   The proxy reads it from the opened file — Matroska `Tags`, `Info/Title`,
   chapters and the `cover.*` attachment, the MP4 iTunes item list and
   QuickTime keys, AVI `LIST INFO` — only from the first and last piece of the
   file, which opening it fetches anyway (proxy
   `GET /api/sources/:key/files/:i/container-metadata`). The proxy is trusted;
   the shape of every value is still checked and bounded, because the bytes of
   a file are not.
   1. As a source: its title (when it is not a release name), year and
      description enter normalization after the databases. Genres stay in its
      record: LostFilm states `Drama` for nearly every work.
   2. As evidence: every title it states is another name to search — a release
      name is read like one, which is how it adds a year the file name lacks; a
      stated season or episode makes the request a series (`kindHint: "tv"`),
      and a stated episode title is matched against the series' episodes when
      the release itself states none.
   3. An `IMDB`, `TMDB` (`movie/<id>`, `tv/<id>`) or `TVDB` id replaces the
      search with a lookup: TMDB's work for a TMDB id, TMDB "Find by ID" for the
      others (`MetadataService.identifyById`). An id that names no work or more
      than one leaves the search by name to decide.
4. What a file states is kept by the torrent's infohash and the file's index
   (`ContainerRecords`, the disk cache's `container` namespace). The page sends
   `source: { infoHash, fileIndex }` with every identification of one file; with
   `container` the record is kept, without it the kept record is used and
   returned as `container`. Reading it costs the first viewer about a minute; the
   next viewer of the file, on any proxy, has it from the first request.
5. On the page (`media-info.js`) it only adds: the name's reading is shown at
   once; what the file states fills an empty episode title, year, description
   and — where no poster is — the cover the file carries (a `blob:` address of
   bytes from the proxy, never stored); identification is asked again only when
   the names did not establish the work; a title, an episode title or a picture
   already shown is never replaced, and a contradiction is logged.

## Provider selection

1. Always query AniList when a release name has an anime hint, including anime,
   OVA, ONA or one of the supported fansub group names.
2. Without such a hint, query it when TMDB returns `not-found` or identifies a
   work carrying the `anime` keyword. An unavailable or ambiguous TMDB search
   is not treated as a missing work.
3. AniList identification requires an exact normalized main or alternative
   title, the stated year and compatible format. Alternative titles containing
   a year are parsed by the same release-name reader. Incomplete searches and
   multiple matches are not selected.
4. A confirmed AniList identity may supply its canonical names for another
   TMDB search. It does not infer TMDB episode ordering or seasons.

AniList uses public GraphQL without credentials: one concurrent request, starts
spaced at 0.45 per second, eight queued searches, a four-second fetch timeout,
128 KB answers, a one-megabyte search cache with one-hour expiry and shared
in-flight searches. Rate refusals pause requests; failures preserve TMDB data.
No provider request blocks playback.

## Artwork

Portrait players prefer a work poster; landscape players prefer a work
backdrop. Episode stills and the other orientation are fallbacks. TMDB image
dimensions select the smallest sufficient rendition for the player dimensions
and device pixel ratio. When the original is insufficient, it is centered,
fitted within the player and displayed at no more than one image pixel per
device pixel. Video rendering itself is unchanged.

## Supplied anime examples, checked 2026-10-01

Reading `.torrent` names and file lists does not start a torrent.

1. Drifters: TMDB `tv/68103`, AniList `21123`; file episode numbers were already
   parsed by the proxy.
2. Koukaku Kidoutai (2026): AniList `177699`, matched by its year-bearing synonym;
   canonical titles then identify TMDB `tv/255358`.
3. Howl's Moving Castle: TMDB `movie/4935`.
4. Nausicaa: TMDB `movie/81`; TMDB's English title is currently "Warriors of the
   Wind", which is retained rather than silently replaced.
5. Princessa.Mononoke.1997: neither provider establishes that spelling. The
   release's name remains visible. No hand-written title substitution is added.

The checks combine the new AniList adapter with the deployed TMDB service.
New TMDB image dimensions and keywords are verified using controlled provider
answers; they require the updated server before being available in production.

## Russian transliteration fallback

Only after ordinary TMDB and AniList identification returns `not-found`, search at most three distinct Latin title words (five or more letters), using the existing cache and provider gate. Require exactly one stated year and a matching kind. Check at most five candidates against complete Russian catalog titles using bounded transliteration variants. Capped searches, unavailable checks, and multiple identities cannot select a work. This is not fuzzy title matching.

`subtitleEvidence?: { titles: string[], years: number[] }` accepts at most four bounded titles and years. Evidence comes from explicit ASS/SSA header fields preserved by the proxy in `NOTE TORRENT-TV-METADATA`. Already-loaded sidecars may trigger one retry after `not-found`; generic `Title` is usable only for a film. Dialogue, subtitle language, and author/update dates do not identify a work. No extra subtitle download is requested. Missing header metadata adds no evidence.
