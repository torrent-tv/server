/**
 * @file What the page makes of the proxy's answers about THIS viewer's output
 * — roadmap item 97, step 11.
 *
 * `output-unavailable`: nothing the proxy holds or could make is admitted by
 * the viewer's link, and the viewer is told why in terms of their connection.
 * `assignment-lost`: a part they were given can no longer be given again, and
 * the page starts a new viewing. Both reach the page through one channel, told
 * by the loader before the player hears of the failure.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  describeUnavailable,
  NoCapacityError,
  noteProxyOutcome,
  onProxyOutcome,
  OutputUnavailableError,
  outcomeBelongsTo,
  outcomeOf,
  viewingOfPath
} from "../public/domain/proxy-outcome.js";

test("an outcome names the output and the viewing its request was sent in", () => {
  const outcome = outcomeOf(
    { outcome: "assignment-lost", reason: "gone" },
    "/transcode/abc%2Fd/v/720/segment-00005.mp4?consumer=c1&generation=3"
  );
  assert.equal(outcome.outputId, "abc/d");
  assert.equal(outcome.generation, 3);
  assert.deepEqual(viewingOfPath("/api/transcode-sessions/x/progress"), { outputId: "", generation: null });
  assert.equal(viewingOfPath("/transcode/x/init.mp4?generation=abc").generation, null, "not a number states nothing");
});

test("an outcome of an earlier viewing of the same output is not this viewing's", () => {
  const outcome = outcomeOf({ outcome: "assignment-lost" }, "/transcode/s1/v/720/segment-00005.mp4?generation=2");
  const verdict = outcomeBelongsTo(outcome, { sessionId: "s1", generation: 3 });
  assert.equal(verdict.belongs, false);
  assert.match(verdict.reason, /viewing 2/);
});

test("an outcome about the file played before this one is not this viewing's", () => {
  const outcome = outcomeOf({ outcome: "assignment-lost" }, "/transcode/old/v/720/segment-00005.mp4?generation=3");
  assert.equal(outcomeBelongsTo(outcome, { sessionId: "new", generation: 3 }).belongs, false);
  assert.equal(outcomeBelongsTo(outcome, { sessionId: null, generation: 3 }).belongs, false, "nothing is playing");
});

test("an outcome of the viewing on screen is acted on, stamped or not", () => {
  const stamped = outcomeOf({ outcome: "output-unavailable" }, "/transcode/s1/v/480/init.mp4?generation=4");
  assert.equal(outcomeBelongsTo(stamped, { sessionId: "s1", generation: 4 }).belongs, true);
  const unstamped = outcomeOf({ outcome: "output-unavailable" }, "/transcode/s1/v/480/init.mp4");
  assert.equal(
    outcomeBelongsTo(unstamped, { sessionId: "s1", generation: 9 }).belongs,
    true,
    "a request with no generation has one viewing"
  );
});

test("a generation ahead of the page's is not the page's", () => {
  const outcome = outcomeOf({ outcome: "assignment-lost" }, "/transcode/s1/v/720/segment-00005.mp4?generation=5");
  assert.equal(outcomeBelongsTo(outcome, { sessionId: "s1", generation: 4 }).belongs, false);
});

test("only the two outcomes the proxy states are read as outcomes", () => {
  assert.deepEqual(
    outcomeOf({ outcome: "assignment-lost", reason: "gone" }, "/transcode/x/v/720/segment-00005.mp4"),
    {
      outcome: "assignment-lost",
      reason: "gone",
      figures: null,
      path: "/transcode/x/v/720/segment-00005.mp4",
      outputId: "x",
      generation: null
    }
  );
  assert.equal(outcomeOf({ outcome: "output-unavailable", figures: { verdict: "does not fit" } }, "/p").figures.verdict, "does not fit");
  assert.equal(outcomeOf({ error: "Superseded by a seek." }, "/p"), null, "a plain refusal is not an outcome");
  assert.equal(outcomeOf(null, "/p"), null);
});

test("an outcome reaches every listener, and a listener that stopped hears nothing", () => {
  const heard = [];
  const stop = onProxyOutcome((outcome) => heard.push(outcome.outcome));
  noteProxyOutcome({ outcome: "assignment-lost", reason: "", figures: null, path: "/p" });
  stop();
  noteProxyOutcome({ outcome: "output-unavailable", reason: "", figures: null, path: "/p" });
  assert.deepEqual(heard, ["assignment-lost"]);
});

test("the viewer is told what the stream needs against what their link can give it", () => {
  const text = describeUnavailable({ figures: { verdict: "does not fit", linkMbps: 3, linkSafety: 0.8, totalMbps: 3.768 } }, 720);
  assert.match(text, /720p needs about 3\.8 Mbit\/s/);
  assert.match(text, /carries about 2\.4 Mbit\/s/, "the share a stream may use, which is what was compared");
});

test("an output with no bound is described as such, not as a number it never had", () => {
  const text = describeUnavailable({ figures: { verdict: "no safe bound", linkMbps: 50, totalMbps: null } }, 1080);
  assert.match(text, /can't be confirmed to fit/);
});

test("a soundtrack with no figure is named, and another one is offered only when the file has one", () => {
  const figures = { verdict: "no safe bound", linkMbps: 80.6, videoClass: "estimated", audioClass: "unknown", totalMbps: null };

  const withOthers = describeUnavailable({ figures: { ...figures, soundtracks: 2 } });
  assert.match(withOthers, /how much this soundtrack would send/);
  assert.match(withOthers, /Choose another soundtrack/);

  const alone = describeUnavailable({ figures: { ...figures, soundtracks: 1 } });
  assert.doesNotMatch(alone, /another soundtrack/, "no advice the viewer cannot follow");
});

test("a picture with no figure is named, and both are named when neither has one", () => {
  const picture = describeUnavailable({ figures: { verdict: "no safe bound", videoClass: "unknown", audioClass: "known" } });
  assert.match(picture, /how much its picture would send/);
  const both = describeUnavailable({ figures: { verdict: "no safe bound", videoClass: "unknown", audioClass: "unknown", soundtracks: 3 } });
  assert.match(both, /its picture or its soundtrack/);
});

test("no refusal suggests a lower quality, which the page does not offer, and only a load too large suggests a faster link", () => {
  const texts = [
    describeUnavailable({ figures: { verdict: "does not fit", linkMbps: 3, linkSafety: 0.8, totalMbps: 3.768 } }),
    describeUnavailable({ figures: { verdict: "no safe bound", audioClass: "unknown" } }),
    describeUnavailable({ figures: null })
  ];
  for (const text of texts) {
    assert.doesNotMatch(text, /lower quality/);
  }
  assert.match(texts[0], /faster connection/);
  assert.doesNotMatch(texts[1], /faster connection/, "a faster link cannot measure what nothing states");
});

test("the error the loading flow shows already speaks to the viewer, and offers Retry", () => {
  const error = new OutputUnavailableError({ reason: "proxy wording", figures: { verdict: "does not fit", linkMbps: 3, linkSafety: 0.8, totalMbps: 3.768 } });
  assert.doesNotMatch(error.message, /proxy wording/, "the proxy's own words stay in the log");
  assert.equal(error.reason, "proxy wording");
  assert.equal(error.canRetry, true, "a link changes, so the answer can");
});

test("no-capacity is a retryable machine refusal with its figures kept for the log", () => {
  const figures = { speedX: 0.82, outputKey: "source:0:720" };
  const error = new NoCapacityError({ reason: "no measured room", figures });

  assert.equal(error.name, "NoCapacityError");
  assert.equal(error.outcome, "no-capacity");
  assert.equal(error.reason, "no measured room");
  assert.equal(error.figures, figures);
  assert.equal(error.canRetry, true);
  assert.match(error.message, /enough capacity/);
  // The refusal is about this machine; it does not know who else is on it.
  assert.doesNotMatch(error.message, /viewer/);
});
