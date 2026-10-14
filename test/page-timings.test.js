import test from "node:test";
import assert from "node:assert/strict";
import { noteFrame, startPageTimings, timed } from "../public/domain/page-timings.js";

// The page's calls set against its long frames, by time (torrent-tv/meta#178).

test("a long frame names the timed calls inside its own interval, and only those", (t) => {
  const lines = [];
  let clock = 1000;
  t.mock.method(performance, "now", () => clock);
  const stop = startPageTimings(line => lines.push(line), undefined);
  t.after(stop);
  timed("url-state:write", () => { clock += 40; });          // 1000-1040
  clock = 2000;
  timed("net-report:fetch", () => { clock += 300; });        // 2000-2300
  noteFrame({ startTime: 1990, duration: 400, blockingDuration: 350,
    scripts: [{ duration: 351, sourceFunctionName: "send", sourceURL: "https://x/domain/net-report.js", invoker: "TimerHandler:setInterval" }] });
  // Kept as it arrives, said with the minute: nothing is formatted or logged
  // inside the observer's callback.
  assert.equal(lines.filter(line => line.includes("long frame")).length, 0);
  clock = 61_500;
  timed("url-state:read", () => { clock += 1; });
  const frame = lines.find(line => line.includes("long frame"));
  assert.match(frame, /long frame 400ms \(blocking 350ms\)/);
  assert.match(frame, /TimerHandler:setInterval:send@net-report\.js 351ms/);
  assert.match(frame, /timed calls inside \[net-report:fetch 300ms\]/);
  assert.doesNotMatch(frame, /url-state:write/, "a call that ended before the frame began is not in it");
});

test("the totals are said once a minute, whether or not a frame was long", (t) => {
  const lines = [];
  let clock = 100_000;
  t.mock.method(performance, "now", () => clock);
  const stop = startPageTimings(line => lines.push(line), undefined);
  t.after(stop);
  for (let second = 0; second <= 61; second += 1) {
    clock = second * 1000 + 100_000;
    timed("url-state:read", () => { clock += 2; });
  }
  const minute = lines.filter(line => line.includes(" in ") && line.includes("url-state:read"));
  assert.equal(minute.length, 1);
  assert.match(minute[0], /url-state:read \d+× \d+ms max 2ms/);
  assert.match(minute[0], /long frames \d+/);
});
