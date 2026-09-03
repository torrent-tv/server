/**
 * @file Carrying a choice of track from one episode to the next.
 *
 * The rule, settled with the user 2026-09-03: what is remembered is the pair
 * «language + releaser»; where the next episode has no exact counterpart, its
 * own default plays, exactly as opening the first episode does. So these checks
 * are as much about what does NOT match as about what does — a near miss is an
 * answer of -1 and not a second-best.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { trackIdentity, sameTrackIdentity, findTrackByIdentity } from "../public/domain/track-memory.js";

test("an identity is the language and the team, with case and spaces dropped", () => {
  assert.deepEqual(
    trackIdentity({ code: "RU", releaser: "  Stan WarHammer & Nesitach " }),
    { code: "ru", releaser: "stan warhammer & nesitach" }
  );
});

test("a track with no team keeps a null there rather than an empty string", () => {
  assert.deepEqual(trackIdentity({ code: "en", releaser: "" }), { code: "en", releaser: null });
  assert.deepEqual(trackIdentity({ code: "en" }), { code: "en", releaser: null });
});

test("a track whose language is unknown is not a choice that can be carried", () => {
  // The next episode's unknown track is a different track, not the same one.
  assert.equal(trackIdentity({ code: "und", releaser: "X" }), null);
  assert.equal(trackIdentity({ code: "", releaser: "X" }), null);
  assert.equal(trackIdentity({}), null);
});

test("the same team writing its name differently still matches", () => {
  const first = trackIdentity({ code: "ru", releaser: "Stan WarHammer & Nesitach" });
  const second = trackIdentity({ code: "ru", releaser: "stan warhammer & nesitach" });
  assert.equal(sameTrackIdentity(first, second), true);
});

test("no team matches no team, and never matches some team", () => {
  const embedded = trackIdentity({ code: "ru" });
  const fromATeam = trackIdentity({ code: "ru", releaser: "AniLibria" });
  assert.equal(sameTrackIdentity(embedded, trackIdentity({ code: "ru" })), true);
  assert.equal(sameTrackIdentity(embedded, fromATeam), false);
  assert.equal(sameTrackIdentity(fromATeam, embedded), false);
});

test("a different language from the same team is not the same choice", () => {
  assert.equal(
    sameTrackIdentity(
      trackIdentity({ code: "ru", releaser: "AniLibria" }),
      trackIdentity({ code: "en", releaser: "AniLibria" })
    ),
    false
  );
});

test("the remembered choice names its entry in the next episode's list", () => {
  const episodeTwo = [
    trackIdentity({ code: "ja" }),
    trackIdentity({ code: "ru", releaser: "Stan WarHammer & Nesitach" }),
    trackIdentity({ code: "en" })
  ];
  const wanted = trackIdentity({ code: "ru", releaser: "Stan WarHammer & Nesitach" });
  assert.equal(findTrackByIdentity(episodeTwo, wanted), 1);
});

test("an episode without the chosen team answers -1, which means «let the file decide»", () => {
  const episodeTwo = [
    trackIdentity({ code: "ja" }),
    trackIdentity({ code: "ru", releaser: "Another Team" }),
    trackIdentity({ code: "en" })
  ];
  const wanted = trackIdentity({ code: "ru", releaser: "Stan WarHammer & Nesitach" });
  assert.equal(findTrackByIdentity(episodeTwo, wanted), -1);
});

test("a list holding candidates with no identity of their own is walked safely", () => {
  const episodeTwo = [null, trackIdentity({ code: "ru" }), null];
  assert.equal(findTrackByIdentity(episodeTwo, trackIdentity({ code: "ru" })), 1);
  assert.equal(findTrackByIdentity(episodeTwo, null), -1);
  assert.equal(findTrackByIdentity(null, trackIdentity({ code: "ru" })), -1);
});
