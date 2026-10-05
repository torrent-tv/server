/**
 * @file The viewer's report: the quality is always the automatic choice, which
 * rung the player is playing, and the picture as the viewer sees it.
 *
 * The page has no manual quality (roadmap item 98), and a proxy treats a page
 * that says nothing about the mode as one that picked its size by hand — so
 * the mode is said on every report.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { reportNow, startNetReporter, stopNetReporter } from "../public/domain/net-report.js";

function capture(extra) {
  let body = null;
  startNetReporter({
    transport: {
      fetch: (_path, options) => {
        body = JSON.parse(options.body);
        return Promise.resolve();
      }
    },
    sessionId: "aaaaaaaabbbbcccc",
    getBufferedAheadSec: () => 0,
    ...extra
  });
  reportNow();
  stopNetReporter();
  return body;
}

test("source reports use the selected file route and are cancelled when replaced", () => {
  let request;
  startNetReporter({ transport: { fetch: (path, options) => {
    request = { path, options };
    return Promise.resolve();
  } }, reportPath: "/api/sources/source/files/7/viewer", consumerId: "person",
  getBufferedAheadSec: () => 8, getPositionSeconds: () => 123,
  getPlaying: () => false, getWaiting: () => false });
  reportNow();
  assert.equal(request.path, "/api/sources/source/files/7/viewer");
  assert.equal(JSON.parse(request.options.body).positionSeconds, 123);
  assert.equal(JSON.parse(request.options.body).waiting, false);
  assert.equal(request.options.signal.aborted, false);
  stopNetReporter();
  assert.equal(request.options.signal.aborted, true);
});

test("every report says the quality is the automatic choice", () => {
  assert.equal(capture({}).qualityMode, "auto");
});

test("the report carries the picture as the viewer sees it", () => {
  assert.deepEqual(capture({ getVisiblePicture: () => ({ width: 1280, height: 720 }) }).visiblePicture, {
    width: 1280,
    height: 720
  });
});

test("a picture that cannot be measured yet is left out", () => {
  assert.equal("visiblePicture" in capture({ getVisiblePicture: () => null }), false);
  assert.equal("visiblePicture" in capture({ getVisiblePicture: () => ({ width: 0, height: 720 }) }), false);
  assert.equal("visiblePicture" in capture({}), false);
});

function capturePlaying(getPlayingHeight) {
  let body = null;
  startNetReporter({
    transport: {
      fetch: (_path, options) => {
        body = JSON.parse(options.body);
        return Promise.resolve();
      }
    },
    sessionId: "aaaaaaaabbbbcccc",
    getBufferedAheadSec: () => 0,
    getPlayingHeight
  });
  reportNow();
  stopNetReporter();
  return body;
}

test("the report carries the height of the rung the player is playing", () => {
  // The proxy used to infer the rung from which segments were requested, which
  // is the player fetching, not the picture having moved.
  assert.equal(capturePlaying(() => 540).playingHeight, 540);
});

test("a page that does not know the rung yet leaves the height out", () => {
  assert.equal("playingHeight" in capturePlaying(() => 0), false);
  assert.equal("playingHeight" in capturePlaying(undefined), false);
  assert.equal("playingHeight" in capturePlaying(() => Number.NaN), false);
});
