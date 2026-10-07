import test from "node:test";
import assert from "node:assert/strict";

import {
  embeddedStartTrackIndex,
  subtitleStartChoice,
  subtitleStartHold
} from "../public/domain/subtitle-start.js";
import { formatWaitingText } from "../public/domain/waiting-text.js";

const track = (index, extra = {}) => ({ index, textBased: true, isDefault: false, ...extra });

test("the track the container marks is the one the file opens with", () => {
  const tracks = [track(0, { language: "eng" }), track(1, { language: "rus", isDefault: true })];
  assert.deepEqual(subtitleStartChoice({ tracks }), { planIndex: 1 });
  assert.equal(embeddedStartTrackIndex({ tracks }), 1);
});

test("a default the file itself marks unusable is not waited for", () => {
  const tracks = [track(0), track(1, { isDefault: true, isEnabled: false })];
  assert.equal(embeddedStartTrackIndex({ tracks }), null);
});

test("subtitles turned off in the previous episode open nothing", () => {
  const tracks = [track(0), track(1, { isDefault: true })];
  assert.deepEqual(subtitleStartChoice({ tracks, remembered: { off: true } }), { off: true });
  assert.equal(embeddedStartTrackIndex({ tracks, remembered: { off: true } }), null);
});

test("the previous episode's choice outranks the container's default when this file carries it", () => {
  const tracks = [track(0, { language: "eng", isDefault: true }), track(1, { language: "rus" }), track(2)];
  const remembered = { code: "ru", releaser: null };
  assert.equal(embeddedStartTrackIndex({ tracks, remembered }), 1);
});

test("a remembered subtitle FILE is not an embedded track to wait for", () => {
  const tracks = [track(0, { language: "eng", isDefault: true }), track(1)];
  const sidecars = [{ naming: { code: "ru", releaser: "Team" } }];
  const remembered = { code: "ru", releaser: "team" };
  assert.ok("identity" in subtitleStartChoice({ tracks, sidecars, remembered }));
  assert.equal(embeddedStartTrackIndex({ tracks, sidecars, remembered }), null);
});

test("a remembered choice with no counterpart here falls back to the container", () => {
  const tracks = [track(0, { language: "eng" }), track(1, { language: "rus", isDefault: true })];
  assert.equal(embeddedStartTrackIndex({ tracks, remembered: { code: "de", releaser: null } }), 1);
});

const ready = { version: 1, ready: true, subtitles: { fileIndex: 0, trackIndex: 1, ready: true } };

test("the start waits while the page's report of the track is still on its way", () => {
  assert.equal(subtitleStartHold({ state: "reporting" }, ready, 10), "subtitles-pending");
});

test("a forecast requested before the report was answered cannot have weighed it", () => {
  const start = { state: "reported", reportedAt: 100 };
  assert.equal(subtitleStartHold(start, ready, 99), "subtitles-pending");
  assert.equal(subtitleStartHold(start, ready, 100), null);
});

test("nothing to report, or a report the proxy refused, holds nothing", () => {
  assert.equal(subtitleStartHold({ state: "none" }, ready, 0), null);
  assert.equal(subtitleStartHold({ state: "refused" }, ready, 0), null);
});

test("a proxy that predates the term is named as such and does not hold the start", () => {
  const start = { state: "reported", reportedAt: 100 };
  assert.equal(subtitleStartHold(start, { version: 1, ready: true }, 200), "proxy-unaware");
});

test("the overlay says what the start is waiting for", () => {
  assert.match(formatWaitingText({ readinessReason: "subtitles-pending" }), /subtitles this film opens with/);
});
