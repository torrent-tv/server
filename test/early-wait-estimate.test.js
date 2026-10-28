import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../public/components/loading/loading.js", import.meta.url), "utf8");

test("the browser does not request or send the retired partial wait estimate", () => {
  assert.doesNotMatch(source, /#requestEarlyWaitEstimate|waitElapsedMs|#addWaitElapsed/);
});
