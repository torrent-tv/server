import { test } from "node:test";
import assert from "node:assert/strict";
import { describeFailure, isViewerFacing, VIEWER_FAILURE_MESSAGES, viewerError } from "../public/domain/viewer-failure.js";
import { NoCapacityError, OutputUnavailableError } from "../public/domain/proxy-outcome.js";
import { waitForMediaReady } from "../public/domain/media-ready.js";

test("a message written for the viewer is shown as it is, with its own Retry", () => {
  const failure = describeFailure(viewerError("No video file found in this torrent."));
  assert.deepEqual(failure, { description: "No video file found in this torrent.", canRetry: false, logDetail: "" });
  assert.equal(describeFailure(viewerError("Try again.", { canRetry: true })).canRetry, true);
});

test("a message written for the log never reaches the viewer, and the log keeps it", () => {
  const error = Object.assign(new Error("Transcode session request failed (500)"), { canRetry: true });
  const failure = describeFailure(error);
  assert.equal(failure.description, VIEWER_FAILURE_MESSAGES.retryable);
  assert.equal(failure.canRetry, true);
  assert.match(failure.logDetail, /Transcode session request failed \(500\)/);
  assert.equal(describeFailure(new Error("Data channel request timed out.")).description, VIEWER_FAILURE_MESSAGES.final);
});

test("the proxy's last refusal goes to the log and never to the viewer", () => {
  const refusal = "segment 53 is ranked 100 of 100: nothing is making it";
  const plain = describeFailure(new Error("Data channel request timed out."), { proxyRefusal: refusal });
  assert.doesNotMatch(plain.description, /ranked/);
  assert.match(plain.logDetail, /the proxy last said: segment 53/);
  const written = describeFailure(viewerError("Connection lost.", { canRetry: true }), { proxyRefusal: refusal });
  assert.equal(written.description, "Connection lost.");
  assert.equal(written.logDetail, `the proxy last said: ${refusal}`);
});

test("the caller's decision about Retry outranks the error's own", () => {
  assert.equal(describeFailure(viewerError("Stopped.", { canRetry: true }), { canRetry: false }).canRetry, false);
  const failure = describeFailure(new Error("seek request failed"), { canRetry: true });
  assert.equal(failure.description, VIEWER_FAILURE_MESSAGES.retryable);
});

test("what is not an Error, or has no words, gets the plain statement", () => {
  assert.equal(describeFailure("boom").description, VIEWER_FAILURE_MESSAGES.final);
  assert.equal(describeFailure(undefined).logDetail, "no message");
  assert.equal(isViewerFacing(viewerError("   ")), false);
  assert.equal(isViewerFacing({ viewerFacing: true, message: "not an Error" }), false);
});

test("the proxy's answers about the viewer's output speak to the viewer", () => {
  assert.equal(isViewerFacing(new OutputUnavailableError({ figures: { linkMbps: 2, totalMbps: 8 } }, 720)), true);
  assert.equal(isViewerFacing(new NoCapacityError({})), true);
});

test("the browser refusing a file is said in the caller's words", async () => {
  const media = new EventTarget();
  Object.assign(media, { error: { code: 4 }, readyState: 0 });
  await assert.rejects(
    waitForMediaReady(media, { unsupportedMessage: "Selected video file format is not supported by the browser." }),
    (error) => isViewerFacing(error) && error.message === "Selected video file format is not supported by the browser."
  );
});
