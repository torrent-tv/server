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
