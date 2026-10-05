import assert from "node:assert/strict";
import test from "node:test";
import { TorrentSession } from "../public/domain/torrent-session.js";
import { noteViewerStopped, viewerHasStopped } from "../public/domain/playback-intent.js";

test("assigning a direct URL preserves an explicit pause and does not start playback", async () => {
  const previous = globalThis.HTMLVideoElement;
  class Video {
    paused = true;
    load() { this.loaded = true; }
    play() { throw new Error("Playback requires viewer intent"); }
  }
  globalThis.HTMLVideoElement = Video;
  try {
    const video = new Video();
    noteViewerStopped(video, true);
    await TorrentSession.prototype.playFromUrl.call(new TorrentSession(), video, "https://proxy/stream");
    assert.equal(video.src, "https://proxy/stream");
    assert.equal(video.loaded, true);
    assert.equal(viewerHasStopped(video), true);
  } finally {
    if (previous === undefined) delete globalThis.HTMLVideoElement;
    else globalThis.HTMLVideoElement = previous;
  }
});
