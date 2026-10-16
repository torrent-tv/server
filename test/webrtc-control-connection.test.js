import test from "node:test";
import assert from "node:assert/strict";
import { WebRtcProxy } from "../public/domain/webrtc-proxy.js";

const flush = () => new Promise(resolve => setImmediate(resolve));

function setup(t) {
  t.mock.method(console, "debug", () => {});
  const peers = [];
  const sockets = [];
  class Channel extends EventTarget {
    readyState = "connecting";
    sent = [];
    bufferedAmount = 0;
    constructor(label) { super(); this.label = label; }
    send(raw) {
      if (this.readyState !== "open") throw new Error("Fake channel is closed");
      this.sent.push(typeof raw === "string" ? JSON.parse(raw) : raw);
    }
    open() { this.readyState = "open"; this.dispatchEvent(new Event("open")); }
    receive(message) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
    close() {
      if (this.readyState === "closed") return;
      this.readyState = "closed";
      this.dispatchEvent(new Event("close"));
    }
    answer(requestId) {
      this.receive({ type: "response-start", requestId, status: 200 });
      this.receive({ type: "response-chunk", requestId, data: btoa("ok"), done: true });
    }
  }
  class Peer extends EventTarget {
    channels = [];
    candidates = [];
    connectionState = "new";
    iceConnectionState = "new";
    closed = 0;
    constructor() { super(); peers.push(this); }
    createDataChannel(label) { const channel = new Channel(label); this.channels.push(channel); return channel; }
    async createOffer() { return { type: "offer", sdp: "a=sctp-init:test\r\nother\r\n" }; }
    async setLocalDescription(description) { this.local = description; }
    async setRemoteDescription(description) { this.remote = description; }
    async addIceCandidate(candidate) { this.candidates.push(candidate); }
    async getStats() { return new Map(); }
    close() {
      if (this.closed) return;
      this.closed++;
      this.connectionState = "closed";
      for (const channel of this.channels) channel.close();
      this.dispatchEvent(new Event("connectionstatechange"));
    }
    connected() { this.connectionState = "connected"; this.dispatchEvent(new Event("connectionstatechange")); }
  }
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    sent = [];
    constructor() { super(); sockets.push(this); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    receive(message) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
  }
  const globals = { RTCPeerConnection: Peer, WebSocket: Socket,
    location: { protocol: "https:", host: "test.invalid" }, window: globalThis };
  const previousGlobals = {};
  for (const [key, value] of Object.entries(globals)) {
    previousGlobals[key] = globalThis[key];
    globalThis[key] = value;
  }
  const proxy = new WebRtcProxy("fake-proxy");
  t.after(() => {
    proxy.close();
    for (const [key, value] of Object.entries(previousGlobals)) globalThis[key] = value;
  });
  return { proxy, peers, sockets };
}

async function connect(t, separateControl = true) {
  const state = setup(t);
  const ready = state.proxy.connect();
  state.sockets[0].receive({ type: "session", sessionId: "session" });
  await flush();
  state.sockets[0].receive({ type: "answer", sdp: "media-answer", separateControl: separateControl ? 2 : undefined });
  await flush();
  if (separateControl) {
    state.sockets[1].receive({ type: "session", sessionId: "control-session" });
    await flush();
  }
  state.peers[0].connected();
  const media = state.peers[0].channels.find(channel => channel.label === "proxy");
  media.open();
  const control = separateControl ? state.peers[1].channels[0]
    : state.peers[0].channels.find(channel => channel.label === "proxy-control");
  if (separateControl) {
    const connectionId = state.sockets[1].sent.find(message => message.type === "offer" && message.connectionId).connectionId;
    state.sockets[1].receive({ type: "candidate", connectionId, candidate: "candidate:test 1 udp 1 203.0.113.1 1000 typ host", mid: "0" });
    await flush();
    assert.deepEqual(state.peers[1].candidates, [], "control candidates wait for their own answer");
    state.sockets[1].receive({ type: "answer", sdp: "control-answer", connectionId });
    await flush();
    assert.equal(state.peers[1].remote.sdp, "control-answer");
    assert.equal(state.peers[1].candidates.length, 1);
    assert.deepEqual(state.peers[0].candidates, [], "control candidates never reach the media peer");
  }
  control.open();
  await ready;
  return { ...state, media, control };
}

test("control answers arrive while media is outstanding, using the same proxy and distinct peers", async t => {
  const { proxy, media, control, peers, sockets } = await connect(t);
  assert.equal(peers.length, 2);
  const offers = sockets.flatMap(socket => socket.sent).filter(message => message.type === "offer");
  assert.ok(offers.every(offer => offer.proxyId === "fake-proxy" && !offer.sdp.includes("sctp-init")));
  assert.equal(offers[0].connectionId, undefined);
  assert.ok(offers[1].connectionId);
  proxy.identifyViewer("viewer");
  assert.ok(media.sent.some(message => message.type === "viewer" && message.consumerId === "viewer"));
  assert.ok(control.sent.some(message => message.type === "viewer" && message.consumerId === "viewer"));
  const film = proxy.fetch("/transcode/output/seg0.m4s");
  const forecast = proxy.fetch("/api/viewers/viewer/forecast");
  await flush();
  assert.equal(media.sent.at(-1).path, "/transcode/output/seg0.m4s");
  assert.equal(control.sent.at(-1).path, "/api/viewers/viewer/forecast");
  control.answer(control.sent.at(-1).requestId);
  assert.equal(await (await forecast).text(), "ok");
  media.answer(media.sent.at(-1).requestId);
  assert.equal(await (await film).text(), "ok");
});

test("control loss rejects its requests, preserves media and reconnects without replaying actions", async t => {
  const { proxy, peers, sockets, media, control } = await connect(t);
  const film = proxy.fetch("/stream");
  const seek = proxy.fetch("/api/viewers/viewer/seek", { method: "POST" });
  const refused = assert.rejects(seek, /Control data channel closed/);
  await flush();
  const oldId = sockets[1].sent.find(message => message.connectionId)?.connectionId;
  control.close();
  await refused;
  await flush();
  assert.equal(peers[0].closed, 0);
  assert.equal(peers.length, 3);
  assert.equal(media.readyState, "open");
  const replacement = peers[2].channels[0];
  sockets[2].receive({ type: "session", sessionId: "replacement-control-session" });
  sockets[2].receive({ type: "candidate", connectionId: oldId, candidate: "late", mid: "0" });
  await flush();
  assert.deepEqual(peers[2].candidates, []);
  replacement.open();
  await flush();
  assert.equal(replacement.sent.some(message => message.type === "request"), false);
  const next = proxy.fetch("/healthz");
  await flush();
  replacement.answer(replacement.sent.at(-1).requestId);
  await next;
  media.answer(media.sent.find(message => message.type === "request").requestId);
  await film;
});

test("an old proxy keeps a control channel on its one peer", async t => {
  const { proxy, peers, control } = await connect(t, false);
  assert.equal(peers.length, 1);
  const response = proxy.fetch("/healthz");
  control.answer(control.sent.at(-1).requestId);
  await response;
});

test("large request bodies and their cancellation stay on the media association", async t => {
  const { proxy, media, control } = await connect(t);
  const abort = new AbortController();
  const request = proxy.fetch("/api/sources", { method: "POST", body: "x".repeat(140_000), signal: abort.signal });
  const refused = assert.rejects(request, { name: "AbortError" });
  await flush();
  const start = media.sent.find(message => message.type === "request-start");
  assert.ok(start);
  assert.equal(control.sent.some(message => message.type === "request-start"), false);
  abort.abort();
  await refused;
  assert.ok(media.sent.some(message => message.type === "request-cancel" && message.requestId === start.requestId));
});

test("speed samples, subtitle files and covers use media while subtitle selection uses control", async t => {
  const { proxy, media, control } = await connect(t);
  for (const path of ["/api/link-probe?bytes=2097152", "/api/delivery-sink?bytes=8388608",
    "/api/subtitles?sourceKey=file&fileIndex=0", "/api/sources/file/files/0/cover", "/media?fileIndex=0"]) {
    const response = proxy.fetch(path);
    const request = media.sent.at(-1);
    assert.equal(request.type, "request");
    assert.equal(request.path, new URL(path, "http://test").pathname);
    media.answer(request.requestId);
    await response;
  }
  const selected = proxy.fetch("/api/subtitles", { method: "POST", body: "{}" });
  await flush();
  assert.equal(control.sent.at(-1).path, "/api/subtitles");
  control.answer(control.sent.at(-1).requestId);
  await selected;
});

test("initial connection waits for control and cancellation closes both peers", async t => {
  const { proxy, peers, sockets } = setup(t);
  let settled = false;
  const ready = proxy.connect();
  const refused = assert.rejects(ready, { name: "AbortError" }).then(() => { settled = true; });
  sockets[0].receive({ type: "session", sessionId: "session" });
  await flush();
  sockets[0].receive({ type: "answer", sdp: "media-answer", separateControl: 2 });
  await flush();
  peers[0].channels[0].open();
  await flush();
  assert.equal(settled, false);
  proxy.close();
  await refused;
  assert.deepEqual(peers.map(peer => peer.closed), [1, 1]);
});

test("cancelling control preparation sends no request and does not interrupt media", async t => {
  const { proxy, peers, control } = await connect(t);
  control.close();
  await flush();
  const abort = new AbortController();
  const request = proxy.fetch("/healthz", { signal: abort.signal });
  abort.abort();
  await assert.rejects(request, { name: "AbortError" });
  peers[2].channels[0].open();
  assert.equal(peers[2].channels[0].sent.some(message => message.type === "request"), false);
  assert.equal(peers[0].closed, 0);
});

test("lost signalling does not stop playback and control recovery gets a fresh signalling session", async t => {
  const { proxy, peers, sockets, media, control } = await connect(t);
  sockets[0].close();
  sockets[1].close();
  assert.equal(control.readyState, "open");
  assert.equal(media.readyState, "open");
  control.close();
  await flush();
  assert.equal(sockets.length, 3);
  sockets[2].receive({ type: "session", sessionId: "after-server-release" });
  await flush();
  assert.equal(sockets[2].sent.find(message => message.type === "offer").proxyId, "fake-proxy");
  peers[2].channels[0].open();
  const response = proxy.fetch("/healthz");
  await flush();
  peers[2].channels[0].answer(peers[2].channels[0].sent.at(-1).requestId);
  await response;
  assert.equal(peers[0].closed, 0);
});

test("control probes cannot conceal stopped media delivery", async t => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { proxy, media, control } = await connect(t);
  let stalled = 0;
  proxy.onDeliveryStalled = () => { stalled++; };
  media.receive({ type: "probe", seq: 1 });
  now = 500;
  t.mock.timers.tick(500);
  media.receive({ type: "probe", seq: 2 });
  const request = proxy.fetch("/stream");
  const refused = assert.rejects(request, { name: "AbortError" });
  for (let seq = 1; seq <= 8; seq++) {
    now += 500;
    t.mock.timers.tick(500);
    control.receive({ type: "probe", seq });
    await flush();
  }
  assert.equal(stalled, 1);
  proxy.close();
  await refused;
});

test("silent control is replaced without losing a media connection that still delivers", async t => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { proxy, peers, media, control } = await connect(t);
  control.receive({ type: "probe", seq: 1 });
  now = 500;
  t.mock.timers.tick(500);
  control.receive({ type: "probe", seq: 2 });
  const request = proxy.fetch("/healthz");
  const refused = assert.rejects(request, /Control delivery lost/);
  await flush();
  now = 2500;
  media.receive({ type: "probe", seq: 1 });
  t.mock.timers.tick(2000);
  await flush();
  now = 61_000;
  media.receive({ type: "probe", seq: 2 });
  t.mock.timers.tick(58_500);
  await flush();
  await refused;
  assert.equal(peers[0].closed, 0);
  assert.equal(peers.length, 3);
});

test("probe reports contain only the counters and probes of their own association", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { peers, media, control } = await connect(t);
  for (const [index, label, bytes] of [[0, "proxy", 120], [1, "proxy-control", 20]]) {
    t.mock.method(peers[index], "getStats", async () => new Map([
      ["transport", { type: "transport", bytesReceived: bytes }],
      ["channel", { type: "data-channel", label, messagesReceived: 2, bytesReceived: bytes }]
    ]));
  }
  media.receive({ type: "probe", seq: 11 });
  control.receive({ type: "probe", seq: 22 });
  t.mock.timers.tick(5000);
  await flush();
  t.mock.timers.tick(500);
  const report = channel => channel.sent.filter(message => message.type === "probe-echo").at(-1);
  assert.deepEqual(report(media).seen, { proxy: 11 });
  assert.deepEqual(report(control).seen, { "proxy-control": 22 });
  assert.deepEqual(Object.keys(report(media).report.channels), ["proxy"]);
  assert.deepEqual(Object.keys(report(control).report.channels), ["proxy-control"]);
  assert.equal(report(media).report.transportBytesReceived, 120);
  assert.equal(report(control).report.transportBytesReceived, 20);
});
