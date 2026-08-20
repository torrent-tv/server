import test from "node:test";
import assert from "node:assert/strict";

import { containerDefaultSubtitleIndex } from "../public/domain/subtitle-utils.js";

const track = (index, extra = {}) => ({ index, textBased: true, isDefault: false, ...extra });

test("a container that marks exactly one of several tracks has chosen it", () => {
  const chosen = containerDefaultSubtitleIndex([
    track(0),
    track(1, { isDefault: true }),
    track(2)
  ]);
  assert.equal(chosen, 1);
});

test("a container that marks every track has chosen nothing", () => {
  // This is what an MKV whose muxer wrote no FlagDefault at all looks like by
  // the time it reaches the browser: the element defaults to 1, so ffmpeg
  // prints "(default)" against every track. Silence must not read as a choice.
  const chosen = containerDefaultSubtitleIndex([
    track(0, { isDefault: true }),
    track(1, { isDefault: true }),
    track(2, { isDefault: true }),
    track(3, { isDefault: true })
  ]);
  assert.equal(chosen, null);
});

test("a container that marks none of several tracks has chosen nothing", () => {
  assert.equal(containerDefaultSubtitleIndex([track(0), track(1)]), null);
});

test("a single track is never turned on by itself", () => {
  // With one track the mark carries no information — it is set whether or not
  // anybody meant it — so it cannot be read as the container choosing.
  assert.equal(containerDefaultSubtitleIndex([track(0, { isDefault: true })]), null);
});

test("image-based tracks are not eligible and do not count towards the choice", () => {
  // A PGS track cannot become WebVTT, so it is never offered; it must not make
  // a lone text track look like one of several either.
  const chosen = containerDefaultSubtitleIndex([
    track(0, { isDefault: true }),
    { index: 1, textBased: false, isDefault: true }
  ]);
  assert.equal(chosen, null);
});

test("the marked track is named by its own index, not its position", () => {
  const chosen = containerDefaultSubtitleIndex([
    track(7),
    track(9, { isDefault: true })
  ]);
  assert.equal(chosen, 9);
});

test("nothing at all is answered with nothing", () => {
  assert.equal(containerDefaultSubtitleIndex([]), null);
  assert.equal(containerDefaultSubtitleIndex(undefined), null);
});

test("a flag the file actually wrote is believed, even on a single track", () => {
  // With `declaresDefault` the ambiguity is gone: this file wrote the flag, for
  // this track, deliberately. The old rule refused a lone track because a
  // Matroska track is marked whether or not anybody meant it.
  const chosen = containerDefaultSubtitleIndex([
    { index: 0, textBased: true, isDefault: true, declaresDefault: true }
  ]);
  assert.equal(chosen, 0);
});

test("a file that wrote the flag on nothing shows nothing, though every track is marked", () => {
  // What ffmpeg's banner reports for such a file is `(default)` on all of them,
  // which is why this case used to be indistinguishable from a real choice.
  const chosen = containerDefaultSubtitleIndex([
    { index: 0, textBased: true, isDefault: true, declaresDefault: false },
    { index: 1, textBased: true, isDefault: true, declaresDefault: false }
  ]);
  assert.equal(chosen, null);
});

test("among the tracks a file wrote flags for, exactly one marked is the choice", () => {
  const chosen = containerDefaultSubtitleIndex([
    { index: 0, textBased: true, isDefault: false, declaresDefault: true },
    { index: 1, textBased: true, isDefault: true, declaresDefault: true },
    { index: 2, textBased: true, isDefault: true, declaresDefault: false }
  ]);
  assert.equal(chosen, 1);
});

test("several tracks marked by the file is not a choice between them", () => {
  const chosen = containerDefaultSubtitleIndex([
    { index: 0, textBased: true, isDefault: true, declaresDefault: true },
    { index: 1, textBased: true, isDefault: true, declaresDefault: true }
  ]);
  assert.equal(chosen, null);
});

test("a container that could not be read falls back to what the banner supports", () => {
  const chosen = containerDefaultSubtitleIndex([
    { index: 0, textBased: true, isDefault: true },
    { index: 1, textBased: true, isDefault: false }
  ]);
  assert.equal(chosen, 0);
});
