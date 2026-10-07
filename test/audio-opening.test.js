import assert from "node:assert/strict";
import test from "node:test";
import { openingAudioTrack } from "../public/domain/audio-opening.js";

test("a usable soundtrack asked for is the one opened", () => {
  assert.equal(openingAudioTrack([{ index: 0 }, { index: 1 }], 1), 1);
});

test("a soundtrack the file marks unusable is replaced by the first usable one (torrent-tv/meta#49)", () => {
  const tracks = [{ index: 0, isEnabled: false }, { index: 1, isEnabled: true }, { index: 2 }];
  assert.equal(openingAudioTrack(tracks, 0), 1);
});

test("where no soundtrack is usable the number asked for stands", () => {
  assert.equal(openingAudioTrack([{ index: 0, isEnabled: false }], 0), 0);
  assert.equal(openingAudioTrack([], 0), 0);
});
