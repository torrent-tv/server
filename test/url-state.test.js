/**
 * @file The address-bar state machine, exhaustively.
 *
 * These rules are easy to state and easy to get wrong in combination: an entry
 * per episode but not per second, a Back button that walks history instead of
 * burying it, and a position that survives a deliberate jump but not the end of
 * an episode. Each of those is one line of code and a dozen cases.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  readUrlState,
  buildUrlSearch,
  decideHistoryWrite,
  isAdvanceToNext,
  decideNavigation
} from "../public/domain/url-state.js";

const MAGNET_A = "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MAGNET_B = "magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const state = (magnet = "", fileIndex = -1, currentTime = 0) => ({ magnet, fileIndex, currentTime });

test("a query string reads back as the state it names", () => {
  assert.deepEqual(readUrlState(""), state());
  assert.deepEqual(readUrlState("?magnet=" + encodeURIComponent(MAGNET_A)), state(MAGNET_A));
  assert.deepEqual(
    readUrlState(`?magnet=${encodeURIComponent(MAGNET_A)}&fileIndex=3&currentTime=1245`),
    state(MAGNET_A, 3, 1245)
  );
  assert.deepEqual(
    readUrlState(`?magnet=${encodeURIComponent(MAGNET_A)}&fileIndex=0&currentTime=0`),
    state(MAGNET_A, 0, 0),
    "a zero position is no position"
  );
  assert.deepEqual(
    readUrlState("?fileIndex=2&currentTime=5"),
    state("", 2, 5),
    "a file index without a torrent is meaningless but must not throw"
  );
});

test("an address round-trips through build and read", () => {
  for (const original of [
    state(),
    state(MAGNET_A),
    state(MAGNET_A, 0),
    state(MAGNET_A, 12, 3600)
  ]) {
    assert.deepEqual(readUrlState(buildUrlSearch(original)), original);
  }
});

test("one entry per thing watched, never per moment of watching", () => {
  // The same file, further on — the film must not bury the viewer's history.
  assert.equal(
    decideHistoryWrite(state(MAGNET_A, 2, 100), state(MAGNET_A, 2, 105)),
    "replace"
  );
  // Another episode — Back has to return to the previous one.
  assert.equal(
    decideHistoryWrite(state(MAGNET_A, 2, 100), state(MAGNET_A, 3, 0)),
    "push"
  );
  // Another torrent.
  assert.equal(
    decideHistoryWrite(state(MAGNET_A, 2, 100), state(MAGNET_B, 0, 0)),
    "push"
  );
  // Opening the file list of the torrent that is playing, and opening a file
  // from the list, are each a move between states.
  assert.equal(decideHistoryWrite(state(MAGNET_A, 2, 100), state(MAGNET_A)), "push");
  assert.equal(decideHistoryWrite(state(MAGNET_A), state(MAGNET_A, 0)), "push");
  // From the picker to a torrent.
  assert.equal(decideHistoryWrite(state(), state(MAGNET_A)), "push");
});

test("writing the state the address already names never adds an entry", () => {
  // This is what makes Back safe: the browser restores an entry, the app writes
  // its state, and the write replaces rather than pushes.
  const restored = state(MAGNET_A, 4, 900);
  assert.equal(decideHistoryWrite(restored, restored), "replace");
  assert.equal(
    decideHistoryWrite(restored, state(MAGNET_A, 4, 902)),
    "replace",
    "the position moving on is still the same entry"
  );
});

test("moving on to the next episode means finished; jumping elsewhere does not", () => {
  const videos = [0, 1, 2, 3];
  assert.equal(isAdvanceToNext(1, 2, videos), true, "episode 2 to episode 3");
  assert.equal(isAdvanceToNext(1, 3, videos), false, "a jump forward keeps the place");
  assert.equal(isAdvanceToNext(2, 1, videos), false, "going back keeps the place");
  assert.equal(isAdvanceToNext(3, 3, videos), false, "the same file is not a move");
  assert.equal(isAdvanceToNext(3, 4, videos), false, "there is no next after the last");
});

test("the next VIDEO file, not the next file", () => {
  // A pack interleaves subtitles, samples and artwork; only playable files are
  // in the playlist the viewer sees, so "next" means next in that list.
  const videos = [2, 5, 9];
  assert.equal(isAdvanceToNext(2, 5, videos), true);
  assert.equal(isAdvanceToNext(2, 3, videos), false, "index 3 is not in the playlist");
  assert.equal(isAdvanceToNext(5, 9, videos), true);
});

test("Back and Forward take the cheapest correct route into the target state", () => {
  const playing = state(MAGNET_A, 2, 600);

  assert.deepEqual(
    decideNavigation(playing, state(MAGNET_A, 2, 600)),
    { action: "none", fileIndex: 2, currentTime: 600 },
    "already there"
  );
  assert.equal(
    decideNavigation(playing, state(MAGNET_A, 2, 601)).action,
    "none",
    "a second of drift is not a navigation"
  );
  assert.equal(
    decideNavigation(playing, state(MAGNET_A, 2, 60)).action,
    "seek",
    "the same file elsewhere only needs a seek"
  );
  assert.equal(
    decideNavigation(playing, state(MAGNET_A, 3, 0)).action,
    "open-file",
    "another file of the same torrent does not reload the torrent"
  );
  assert.equal(
    decideNavigation(playing, state(MAGNET_A)).action,
    "playlist",
    "the torrent's own entry shows its file list"
  );
  assert.equal(
    decideNavigation(playing, state(MAGNET_B, 0, 0)).action,
    "load-source",
    "another torrent has to be loaded"
  );
  assert.equal(
    decideNavigation(playing, state()).action,
    "picker",
    "no torrent means the picker"
  );
});

test("navigation from the file list, and from the picker", () => {
  const listing = state(MAGNET_A);
  assert.equal(decideNavigation(listing, state(MAGNET_A)).action, "none");
  assert.equal(decideNavigation(listing, state(MAGNET_A, 1, 0)).action, "open-file");
  assert.equal(decideNavigation(listing, state(MAGNET_B)).action, "load-source");
  assert.equal(decideNavigation(listing, state()).action, "picker");

  const picker = state();
  assert.equal(decideNavigation(picker, state()).action, "none");
  assert.equal(decideNavigation(picker, state(MAGNET_A)).action, "load-source");
  assert.equal(decideNavigation(picker, state(MAGNET_A, 2, 30)).action, "load-source");
});

test("the target's position is carried to whoever performs the action", () => {
  const decision = decideNavigation(state(MAGNET_A, 1, 10), state(MAGNET_A, 4, 1800));
  assert.equal(decision.action, "open-file");
  assert.equal(decision.fileIndex, 4);
  assert.equal(decision.currentTime, 1800, "the file has to open where the entry says");
});
