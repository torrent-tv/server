/**
 * @file A wrong first card is corrected by what the file states and measures
 * (torrent-tv/meta#176), from the two releases the owner reported:
 *
 *  - `Moana.2026.720p.rus.LostFilm.TV.mp4` states TV-show items with season 0,
 *    episode 0 and the film's own title as the episode's, which made it an
 *    episode: only series were searched and the tab read "Specials";
 *  - `Frankenstein.rus.LostFilm.TV.avi` is first identified from its name as
 *    the 2004 series and corrected by its measured duration seconds later; the
 *    picture chosen for the first work stayed, and an address written in those
 *    seconds kept the series after a refresh.
 *
 * No request leaves this machine.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { ContainerMetadata } from "../services/metadata/ContainerMetadata.js";
import { containerEpisode, statesEpisode, workIdentity } from "../public/domain/media-info.js";
import { MEDIA_INFO_EVENTS, PLAYER_EVENTS } from "../public/shared/events.js";

/** What the proxy read from the Moana MP4 and the server kept (meta research/session-logs-2026-10-24-ttv176). */
const MOANA = { title: "Моана", seriesTitle: "Моана", itemYear: 2026, season: 0, episode: 0, episodeTitle: "Моана" };

test("a film whose TV-show items repeat its own title with no number is not an episode", () => {
  assert.equal(statesEpisode(MOANA), false);
  const provider = new ContainerMetadata();
  const evidence = provider.evidenceFrom({ container: MOANA });
  assert.equal(evidence.kindHint, undefined, "films are searched too");
  assert.deepEqual(evidence.statedYears, [2026]);
  assert.equal(provider.fields(MOANA).kind, undefined);
  assert.equal(provider.fields(MOANA).year, 2026);
  assert.equal(containerEpisode(MOANA, null), null, "no season 0 episode, so no \"Specials\"");
});

test("an episode stays an episode", () => {
  assert.equal(statesEpisode({ seriesTitle: "Аватар", season: 1, episode: 1, episodeTitle: "Аанг" }), true);
  assert.equal(statesEpisode({ seriesTitle: "Firefly", season: 1, episode: 1, episodeTitle: "Firefly" }), true, "a number above zero decides");
  assert.equal(statesEpisode({ seriesTitle: "Аватар", season: 0, episode: 0, episodeTitle: "Аанг" }), true, "a title of its own decides");
  assert.equal(statesEpisode({ episodeTitle: "Аанг" }), true);
  assert.equal(statesEpisode({ title: "Кошмар на улице Вязов", seriesTitle: "Кошмар на улице Вязов", season: 0, episode: 0 }), false);
  assert.equal(statesEpisode(null), false);
});

test("the shown work's identity changes with the record and only with it", () => {
  const series = { work: { kind: "series", sources: { tmdb: { kind: "tv", tmdbId: 40165 } }, normalized: { title: "Frankenstein", year: 2004 } } };
  const film = { work: { kind: "movie", sources: { tmdb: { kind: "movie", tmdbId: 1062722 } }, normalized: { title: "Frankenstein", year: 2025 } } };
  assert.equal(workIdentity(series, 0), "tmdb:tv:40165");
  assert.equal(workIdentity(film, 0), "tmdb:movie:1062722");
  assert.equal(workIdentity({ ...film, episodes: { 0: { season: 1, episodes: [{ number: 1 }] } } }, 0), "tmdb:movie:1062722");
  assert.equal(workIdentity({ work: { normalized: { title: "Scene", year: 2020 } } }, 0), "title:Scene:2020");
  assert.equal(workIdentity({ work: null }, 0), null);
});

test("the system media controls choose a poster again only for another work", async () => {
  const previous = new Map(["document", "navigator", "MediaMetadata"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const document = new EventTarget();
  document.readyState = "loading";
  const session = { metadata: null, setActionHandler() {} };
  try {
    Object.defineProperty(globalThis, "document", { configurable: true, value: document });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaSession: session } });
    Object.defineProperty(globalThis, "MediaMetadata", { configurable: true, value: class { constructor(init) { Object.assign(this, init); } } });
    const { MediaSessionBridge } = await import("../public/components/media-session/media-session.js");
    new MediaSessionBridge();
    const send = (type, detail) => document.dispatchEvent(new CustomEvent(type, { detail }));
    send(PLAYER_EVENTS.SET_MEDIA_FILES, { video: [{ index: 0, name: "Frankenstein.rus.LostFilm.TV.avi" }] });
    send(PLAYER_EVENTS.SET_ACTIVE_MEDIA_FILE, { fileIndex: 0 });
    const work = (tmdbId, kind, poster) => ({ selection: 1, work: { sources: { tmdb: { kind, tmdbId } },
      normalized: { title: "Frankenstein", poster, images: [] } } });
    send(MEDIA_INFO_EVENTS.CHANGED, work(40165, "tv", "seriesposter.jpg"));
    assert.match(session.metadata.artwork[0].src, /seriesposter\.jpg$/u);
    send(MEDIA_INFO_EVENTS.CHANGED, work(1062722, "movie", "filmposter.jpg"));
    assert.match(session.metadata.artwork[0].src, /filmposter\.jpg$/u, "the corrected work's poster replaces the first one");
    send(MEDIA_INFO_EVENTS.CHANGED, work(1062722, "movie", "otherposter.jpg"));
    assert.match(session.metadata.artwork[0].src, /filmposter\.jpg$/u, "the same work keeps the poster already shown");
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
