import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PlaybackTasks } from "../public/domain/playback-tasks.js";
import { waitForMediaReady } from "../public/domain/media-ready.js";
import { describeFailure, VIEWER_FAILURE_MESSAGES, viewerError } from "../public/domain/viewer-failure.js";

// Execute the production lifecycle methods without constructing a browser,
// transport or media player. The source's private fields remain private.
const source = readFileSync(new URL("../public/components/loading/loading.js", import.meta.url), "utf8");
function method(name) {
  const start = source.indexOf(`  ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf("\n  }", start) + 4);
}

function loading(events, logged = []) {
  const create = new Function("PlaybackTasks", "document", "CustomEvent", "LOADING_EVENTS", "PLAYER_EVENTS", "waitForMediaReady", "describeFailure", "lastProxyRefusal", "logged", `return class {
    #playbackEpoch = 0;
    #playbackTasks = new PlaybackTasks();
    #cancelRequested = false;
    #openingFileIndex; #browserBufferLimitSeconds; #hasPlayedOnce;
    #qualityPreparation; #audioPreparation;
    #audioMetadataRefreshSeq = 0;
    #activeFileIndex; #resumeState; #selectedAudioTrackIndex; #rememberedAudio;
    #playingHeight; #sourceVideoWidth; #sourceVideoHeight; #audioTracks;
    #waitingModel = { reset() {} };
    #refusedProxiesForThisOpen = new Set();
    #session = { abortPendingRequests() {}, fetchActiveTranscodeProgress: async () =>
      ({ state: "failed", error: "source-input-exceeds-memory-capacity" }) };
    #hlsPlayer = { clear() {} };
    #subtitlePlayback = { clear() {}, reset() {} };
    #logEvt(line) { logged.push(line); }
    #progressPollFailing = false;
    #renderTranscodeProgress(progress) { this.#assertTranscodeProgress(progress); }
    ${["#runPlaybackTask", "#beginPlaybackAttempt", "#resetSourceState", "#failWith", "#failPlayback", "#isAbortError",
      "#assertTranscodeProgress", "#startTranscodeProgressPoll"].map(method).join("\n")}
    start(run) { return this.#runPlaybackTask(async () => { this.#resetSourceState(); await run(); }); }
    waitForFailedOutput() { return this.start(async () => {
      const controller = new AbortController();
      const stop = this.#startTranscodeProgressPoll(error => controller.abort(error));
      const media = Object.assign(new EventTarget(), { readyState: 0, error: null });
      try { await waitForMediaReady(media, { signal: controller.signal }); }
      finally { stop(); }
    }); }
  }`);
  return new (create(PlaybackTasks, { dispatchEvent: event => { events.push(event); } },
    CustomEvent, { PLAYBACK_FAILED: "failed" }, {}, waitForMediaReady, describeFailure, () => "", logged))();
}

test("source initialization cannot discard the current opening failure as stale", async () => {
  const events = [];
  const component = loading(events);
  await component.start(() => { throw viewerError("No video file found in this torrent."); });
  assert.deepEqual(events.filter(event => event.type === "failed").map(event => event.detail), [
    { description: "No video file found in this torrent.", canRetry: false }
  ]);
});

test("a superseded opening failure stays cancelled while its replacement reports its own failure", async () => {
  const events = [];
  const component = loading(events);
  let reject;
  const first = component.start(() => new Promise((_, fail) => { reject = fail; }));
  await Promise.resolve();
  await Promise.resolve();
  const second = component.start(() => { throw viewerError("Current source unavailable"); });
  reject(viewerError("Previous source unavailable"));
  await Promise.all([first, second]);
  assert.deepEqual(events.filter(event => event.type === "failed").map(event => event.detail.description), [
    "Current source unavailable"
  ]);
});

test("a failed output ends opening before the media element has metadata", async () => {
  const events = [];
  const logged = [];
  await loading(events, logged).waitForFailedOutput();
  // The proxy's reason is stated in its own terms: the viewer is told what
  // happened to playback, and the log keeps the reason (torrent-tv/meta#73).
  assert.deepEqual(events.filter(event => event.type === "failed").map(event => event.detail.description), [
    VIEWER_FAILURE_MESSAGES.final
  ]);
  assert.ok(logged.some(line => line.includes("source-input-exceeds-memory-capacity")), logged.join(" | "));
});
