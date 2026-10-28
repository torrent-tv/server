import assert from "node:assert/strict";
import test from "node:test";

import { AppendService, observeHlsAppendService } from "../public/domain/append-service.js";
import { FragmentService, observeHlsFragmentService } from "../public/domain/fragment-service.js";

class Events {
  listeners = new Map();

  on(name, listener) {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  off(name, listener) {
    this.listeners.get(name)?.delete(listener);
  }

  emit(name, data) {
    for (const listener of this.listeners.get(name) ?? []) listener(name, data);
  }
}

test("append service sums bytes and acknowledged service time by stream and data kind", () => {
  const service = new AppendService();
  const instance = new Events();
  let at = 10;
  observeHlsAppendService(instance, { BUFFER_CODECS: "codecs", BUFFER_APPENDING: "appending", BUFFER_APPENDED: "appended",
    DESTROYING: "destroying" }, service, () => at);

  const initData = new Uint8Array(12);
  instance.emit("codecs", { tracks: { main: { initSegment: initData } } });
  instance.emit("appending", { id: "main", frag: { sn: 0 }, data: initData });
  at = 13;
  instance.emit("appended", { id: "main" });
  instance.emit("appending", { type: "audio", frag: { sn: 4 }, data: new Uint8Array(8) });
  at = 17;
  instance.emit("appended", { type: "audio" });

  assert.deepEqual(service.snapshot(at), {
    video: { init: { bytes: 12, elapsedMs: 3, operations: 1,
      samples: [{ bytes: 12, elapsedMs: 3, ageMs: 4, fragmentId: ":::0::", fragmentSequence: 0, partIndex: null,
        fragmentStartSeconds: null }] },
      media: { bytes: 0, elapsedMs: 0, operations: 0, samples: [] } },
    audio: { init: { bytes: 0, elapsedMs: 0, operations: 0, samples: [] },
      media: { bytes: 8, elapsedMs: 4, operations: 1,
        samples: [{ bytes: 8, elapsedMs: 4, ageMs: 0, fragmentId: ":::4::", fragmentSequence: 4, partIndex: null,
          fragmentStartSeconds: null }] } }
  });
  assert.deepEqual(service.snapshot(at + 30_001).video.init.samples, [],
    "completed operations leave the recent-sample window while cumulative totals remain");
});

test("invalid and unfinished append work is not turned into a service rate", () => {
  const service = new AppendService();
  assert.equal(service.record({ track: "video", kind: "media", bytes: 20, elapsedMs: 0, completedAt: 10 }), false);
  assert.equal(service.record({ track: "video", kind: "media", bytes: Number.MAX_SAFE_INTEGER, elapsedMs: 1,
    completedAt: 10 }), true);
  assert.equal(service.record({ track: "video", kind: "media", bytes: 1, elapsedMs: 1, completedAt: 11 }), false);
  assert.equal(service.snapshot().video.media.bytes, Number.MAX_SAFE_INTEGER);
  const instance = new Events();
  observeHlsAppendService(instance, { BUFFER_APPENDING: "appending", BUFFER_APPENDED: "appended",
    DESTROYING: "destroying" }, service, () => 10);
  instance.emit("appending", { type: "video", frag: { sn: 2 }, data: new Uint8Array(20) });
  instance.emit("destroying", {});
  instance.emit("appended", { type: "video" });
  assert.deepEqual(service.snapshot(10).video.media,
    { bytes: Number.MAX_SAFE_INTEGER, elapsedMs: 1, operations: 1,
      samples: [{ bytes: Number.MAX_SAFE_INTEGER, elapsedMs: 1, ageMs: 0, fragmentId: null,
        fragmentSequence: null, partIndex: null, fragmentStartSeconds: null }] });
});

test("fragment load-to-parse samples retain their track, bytes, age and identity", () => {
  const service = new FragmentService();
  const instance = new Events();
  let at = 10;
  observeHlsFragmentService(instance, { FRAG_LOADED: "loaded", FRAG_PARSED: "parsed", FRAG_BUFFERED: "buffered",
    DESTROYING: "destroying" }, service, () => at);

  const frag = { type: "main", cc: 0, level: 2, sn: 7, start: 0,
    stats: { loading: { start: 8, first: 9, end: 14 }, parsing: { start: 12, end: 20 },
      buffering: { start: 27, end: 29 } } };
  instance.emit("loaded", { frag,
    payload: new Uint8Array(64) });
  at = 25;
  instance.emit("parsed", { frag });
  at = 30;
  instance.emit("buffered", { frag });

  assert.deepEqual(service.snapshot(at), {
    video: { init: { bytes: 0, elapsedMs: 0, operations: 0, samples: [] },
      media: { bytes: 64, elapsedMs: 15, operations: 1,
        samples: [{ bytes: 64, elapsedMs: 15, ageMs: 5, fragmentId: "main:0:2:7:0:", fragmentSequence: 7,
          partIndex: null, fragmentStartSeconds: 0,
          parseElapsedMs: 8, bufferingElapsedMs: 2, bufferingAgeMs: 1,
          eventAgesMs: { loadStart: 22, loadFirstByte: 21, loadEnd: 16, parseStart: 18, parseEnd: 10,
            bufferingStart: 3, bufferingEnd: 1 } }] } },
    audio: { init: { bytes: 0, elapsedMs: 0, operations: 0, samples: [] },
      media: { bytes: 0, elapsedMs: 0, operations: 0, samples: [] } }
  });
  assert.deepEqual(service.snapshot(at + 30_001).video.media.samples, []);
});

test("parse and append samples share the fragment identity used to join their service", () => {
  const append = new AppendService();
  const fragment = new FragmentService();
  const instance = new Events();
  let at = 10;
  const events = { BUFFER_CODECS: "codecs", BUFFER_APPENDING: "appending", BUFFER_APPENDED: "appended",
    FRAG_LOADED: "loaded", FRAG_PARSED: "parsed", DESTROYING: "destroying" };
  observeHlsAppendService(instance, events, append, () => at);
  observeHlsFragmentService(instance, events, fragment, () => at);
  const frag = { type: "main", cc: 0, level: 2, sn: 7, start: 0 };
  const initData = new Uint8Array(16);
  instance.emit("codecs", { tracks: { main: { initSegment: initData } } });

  instance.emit("loaded", { frag, payload: new Uint8Array(64) });
  at = 20;
  instance.emit("parsed", { frag });
  instance.emit("appending", { type: "video", parent: "main", frag, data: initData });
  at = 22;
  instance.emit("appended", { type: "video", parent: "main", frag });
  instance.emit("appending", { type: "video", parent: "main", frag, data: new Uint8Array(48) });
  at = 25;
  instance.emit("appended", { type: "video", parent: "main", frag });

  const appendId = append.snapshot(at).video.media.samples[0].fragmentId;
  const fragmentId = fragment.snapshot(at).video.media.samples[0].fragmentId;
  assert.equal(appendId, fragmentId);
});

test("different parts of one media fragment keep distinct service identities", () => {
  const service = new FragmentService();
  const instance = new Events();
  let at = 10;
  observeHlsFragmentService(instance, { FRAG_LOADED: "loaded", FRAG_PARSED: "parsed" }, service, () => at);
  const frag = { type: "main", cc: 0, level: 2, sn: 7, start: 0 };
  for (const index of [0, 1]) {
    instance.emit("loaded", { frag, part: { index }, payload: new Uint8Array(32) });
    at += 5;
    instance.emit("parsed", { frag, part: { index } });
  }

  const samples = service.snapshot(at).video.media.samples;
  assert.equal(samples.length, 2);
  assert.notEqual(samples[0].fragmentId, samples[1].fragmentId);
});
