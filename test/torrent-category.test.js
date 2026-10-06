import test from "node:test";
import assert from "node:assert/strict";
import { categoryOfTorrent } from "../public/domain/torrent-category.js";

test("a torrent from an adult-only tracker says adult, by its release page or its tracker", () => {
  assert.equal(categoryOfTorrent({ comment: "https://pornolab.net/forum/viewtopic.php?t=3270353" }), "adult");
  assert.equal(categoryOfTorrent({ comment: "see https://PORNOLAB.net/forum/x" }), "adult");
  assert.equal(categoryOfTorrent({ announce: "http://tracker.pornolab.net:2710/abc/announce" }), "adult");
  assert.equal(categoryOfTorrent({ announceList: ["udp://open.tracker.example:80", "http://post.pornolab.net/announce"] }), "adult");
});

test("a general tracker or no statement says nothing", () => {
  assert.equal(categoryOfTorrent({ comment: "http://rutor.info/torrent/123" }), null);
  assert.equal(categoryOfTorrent({ comment: "LostFilm.TV(c)" }), null);
  assert.equal(categoryOfTorrent({ comment: "https://notpornolab.net/x" }), null);
  assert.equal(categoryOfTorrent({}), null);
  assert.equal(categoryOfTorrent(null), null);
});
