/**
 * @file The viewer's report says whether the size on screen was picked by hand.
 *
 * A size picked from the menu is served exactly; the automatic choice may be
 * served by an output of the same quality or better that the proxy has made.
 * The proxy can tell them apart only if the page says.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { reportNow, startNetReporter, stopNetReporter } from "../public/domain/net-report.js";

function captureReport(getQualityMode) {
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
    getQualityMode
  });
  reportNow();
  stopNetReporter();
  return body;
}

test("the report carries the mode the page states", () => {
  assert.equal(captureReport(() => "auto").qualityMode, "auto");
  assert.equal(captureReport(() => "manual").qualityMode, "manual");
});

test("a page that cannot say leaves the mode out rather than guessing", () => {
  assert.equal("qualityMode" in captureReport(undefined), false);
  assert.equal("qualityMode" in captureReport(() => "sometimes"), false);
});
