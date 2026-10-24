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
import { containerEpisode, statesEpisode } from "../public/domain/media-info.js";

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
