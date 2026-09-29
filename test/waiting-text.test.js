import assert from "node:assert/strict";
import test from "node:test";
import { formatWaitingText } from "../public/domain/waiting-text.js";

test("an unknown readiness estimate is shown as estimating", () => {
  assert.equal(formatWaitingText({}), "Estimating…");
});

test("a zero estimate remains visible only as a measured duration", () => {
  assert.equal(formatWaitingText({ etaSeconds: 0 }), "0 seconds until playback");
});

test("a proxy without the readiness forecast is identified", () => {
  assert.match(
    formatWaitingText({ readinessUnavailable: true }),
    /This proxy needs an update before playback can start/
  );
});
