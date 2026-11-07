import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../public/components/loading/loading.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
function method(name) {
  const start = source.indexOf(`  ${name}`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf("\n  }\n", start) + 4);
}
// The page's wait-estimate helpers are in the page while it still has them and
// gone after it stops: take the real ones when present so this test runs the
// same on either side, and does not name them.
const pageHelpers = [...source.matchAll(/^function \w*[wW]aitEstimate\w*\(.*?^}$/gms)].map(match => match[0]).join("\n");
const publishMethod = method("#publishTranscodeMeasurements(progress) {");
const holdMethod = method("async #holdSeekUntilReady(seq, epoch, reportedAt) {");

function publisher(events) {
  const Component = new Function("document", "CustomEvent", "PROXY_EVENTS", `
    ${pageHelpers}
    return class {
      #lastDownloadStats = { downloadSpeed: 120 };
      ${publishMethod}
      publish(progress) { this.#publishTranscodeMeasurements(progress); }
    };
  `);
  const Generated = Component({ dispatchEvent: event => events.push(event) },
    class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    { MEASURED: "measured" });
  return new Generated();
}

test("seek readiness is published to the waiting overlay with the supply row", () => {
  const events = [];
  const playbackReadiness = { version: 1, ready: false, reason: "minimum-safe-delay", delaySeconds: 8.5 };
  const progress = { playbackReadiness };
  publisher(events).publish(progress);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "measured");
  assert.equal(events[0].detail.downloadStats.downloadSpeed, 120);
  assert.equal(events[0].detail.playbackReadiness, playbackReadiness);
  assert.equal(events[0].detail.transcodeProgress, progress);
});

test("a progress answer without readiness publishes none", () => {
  const events = [];
  publisher(events).publish({ state: "running" });

  assert.equal(events[0].detail.playbackReadiness, null);
});

test("each seek-hold progress answer is sent through the waiting overlay event", () => {
  assert.match(holdMethod, /waitTrace\.run\("S2\.5\.publish-transcode-readings",[\s\S]*this\.#publishTranscodeMeasurements\(progress\)/);
});
