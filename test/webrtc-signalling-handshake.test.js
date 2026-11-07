import test from "node:test";
import assert from "node:assert/strict";
import { WebRtcProxy } from "../public/domain/webrtc-proxy.js";

// The browser's signalling handshake, observed through the media peer and the
// control peer of one WebRtcProxy. Only fakes: no network, no real peer.
const flush = () => new Promise(resolve => setImmediate(resolve));

const PUBLIC = "candidate:1 1 udp 1 203.0.113.7 4000 typ srflx";
const PRIVATE = "candidate:2 1 udp 1 192.168.1.20 4001 typ host";
const LINK_LOCAL_V6 = "candidate:3 1 udp 1 fe80::1 4002 typ host";
const OFFER_SDP = "v=0\r\na=sctp-init:abc123\r\nm=application\r\na=sctp-port:5000\r\n";

function harness(t, { allowPrivate = true, localPort = null } = {}) {
  const peers = [];
  const sockets = [];
  class Channel extends EventTarget {
    readyState = "connecting";
    constructor(label) { super(); this.label = label; }
    send() {}
    close() { this.readyState = "closed"; }
  }
  class Peer extends EventTarget {
    channels = [];
    candidates = [];
    connectionState = "new";
    constructor() { super(); peers.push(this); }
    createDataChannel(label) { const channel = new Channel(label); this.channels.push(channel); return channel; }
    async createOffer() { return { type: "offer", sdp: OFFER_SDP }; }
    async setLocalDescription(description) { this.local = description; }
    async setRemoteDescription(description) { this.remote = description; }
    async addIceCandidate(candidate) { this.candidates.push(candidate); }
    async getStats() { return new Map(); }
    close() { this.connectionState = "closed"; }
  }
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    sent = [];
    closed = 0;
    constructor(url) { super(); this.url = url; sockets.push(this); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    receive(message) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
    close() { this.closed++; this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  t.mock.method(console, "debug", () => {});
  const globals = { RTCPeerConnection: Peer, WebSocket: Socket,
    location: { protocol: "https:", host: "test.invalid" }, window: globalThis };
  const previous = {};
  for (const [key, value] of Object.entries(globals)) { previous[key] = globalThis[key]; globalThis[key] = value; }
  const proxy = new WebRtcProxy("fake-proxy", localPort, allowPrivate);
  const ready = proxy.connect();
  ready.catch(() => {});
  t.after(() => {
    proxy.close();
    for (const [key, value] of Object.entries(previous)) globalThis[key] = value;
  });
  return { proxy, peers, sockets, ready };
}

/** Media peer up to its offer; control peer (second socket) up to its offer. */
async function startMedia(t, options) {
  const state = harness(t, options);
  state.sockets[0].receive({ type: "session", sessionId: "media-session" });
  await flush();
  return state;
}

async function startControl(t, options) {
  const state = await startMedia(t, options);
  state.sockets[0].receive({ type: "answer", sdp: "media-answer", separateControl: 2 });
  await flush();
  state.sockets[1].receive({ type: "session", sessionId: "control-session" });
  await flush();
  const offer = state.sockets[1].sent.find(message => message.type === "offer");
  return { ...state, connectionId: offer?.connectionId };
}

const offerOf = socket => socket.sent.find(message => message.type === "offer");

test("media peer opens /ws/browser-signal and sends no offer before the session arrives", async t => {
  const { sockets, peers } = harness(t);
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, "wss://test.invalid/ws/browser-signal");
  await flush();
  assert.equal(sockets[0].sent.length, 0);
  assert.equal(peers.length, 0);
  sockets[0].receive({ type: "session", sessionId: "media-session" });
  await flush();
  assert.equal(peers.length, 1);
  assert.equal(offerOf(sockets[0]).proxyId, "fake-proxy");
});

test("media offer drops a=sctp-init from the copy sent but keeps it locally", async t => {
  const { sockets, peers } = await startMedia(t);
  const offer = offerOf(sockets[0]);
  assert.ok(offer.sdp.includes("a=sctp-port:5000"));
  assert.equal(offer.sdp.includes("sctp-init"), false);
  assert.ok(peers[0].local.sdp.includes("a=sctp-init:abc123"));
});

test("media answer is applied as the remote description", async t => {
  const { sockets, peers } = await startMedia(t);
  sockets[0].receive({ type: "answer", sdp: "media-answer" });
  await flush();
  assert.deepEqual(peers[0].remote, { type: "answer", sdp: "media-answer" });
});

test("media candidates wait for the answer and are then applied in order", async t => {
  const { sockets, peers } = await startMedia(t);
  sockets[0].receive({ type: "candidate", candidate: PUBLIC, mid: "0" });
  sockets[0].receive({ type: "candidate", candidate: PRIVATE });
  await flush();
  assert.deepEqual(peers[0].candidates, []);
  sockets[0].receive({ type: "answer", sdp: "media-answer" });
  await flush();
  assert.deepEqual(peers[0].candidates, [
    { candidate: PUBLIC, sdpMid: "0", sdpMLineIndex: 0 },
    { candidate: PRIVATE, sdpMid: "0", sdpMLineIndex: 0 }
  ]);
  sockets[0].receive({ type: "candidate", candidate: PUBLIC, mid: "1" });
  await flush();
  assert.equal(peers[0].candidates.at(-1).sdpMid, "1");
});

test("media public-only attempt drops local candidates before and after the answer", async t => {
  const { sockets, peers } = await startMedia(t, { allowPrivate: false });
  sockets[0].receive({ type: "candidate", candidate: PRIVATE });
  sockets[0].receive({ type: "candidate", candidate: PUBLIC });
  sockets[0].receive({ type: "answer", sdp: "media-answer" });
  await flush();
  sockets[0].receive({ type: "candidate", candidate: LINK_LOCAL_V6 });
  sockets[0].receive({ type: "candidate", candidate: "candidate:4 1 udp 1 10.1.2.3 4003 typ host" });
  await flush();
  assert.deepEqual(peers[0].candidates.map(c => c.candidate), [PUBLIC]);
});

test("media public-only attempt still records the proxy's LAN address for the permission probe", async t => {
  const { sockets, proxy } = await startMedia(t, { allowPrivate: false, localPort: 9090 });
  assert.equal(proxy.lanProbeUrl, null);
  sockets[0].receive({ type: "candidate", candidate: PRIVATE });
  await flush();
  assert.equal(proxy.lanProbeUrl, "http://192.168.1.20:9090/healthz");
});

test("media local candidates are applied when private candidates are allowed", async t => {
  const { sockets, peers } = await startMedia(t, { allowPrivate: true });
  sockets[0].receive({ type: "answer", sdp: "media-answer" });
  sockets[0].receive({ type: "candidate", candidate: PRIVATE });
  sockets[0].receive({ type: "candidate", candidate: LINK_LOCAL_V6 });
  await flush();
  assert.deepEqual(peers[0].candidates.map(c => c.candidate), [PRIVATE, LINK_LOCAL_V6]);
});

test("media local candidates are sent to the proxy with its id", async t => {
  const { sockets, peers } = await startMedia(t);
  const event = new Event("icecandidate");
  event.candidate = { candidate: PUBLIC, sdpMid: null };
  peers[0].dispatchEvent(event);
  assert.deepEqual(sockets[0].sent.at(-1), { type: "candidate", proxyId: "fake-proxy", candidate: PUBLIC, mid: "0" });
});

test("control peer opens its own /ws/browser-signal socket and waits for its own session", async t => {
  const { sockets, peers } = await startMedia(t);
  sockets[0].receive({ type: "answer", sdp: "media-answer", separateControl: 2 });
  await flush();
  assert.equal(sockets.length, 2);
  assert.equal(sockets[1].url, "wss://test.invalid/ws/browser-signal");
  assert.equal(peers.length, 2);
  assert.equal(sockets[1].sent.length, 0, "no offer before the control session");
  sockets[1].receive({ type: "session", sessionId: "control-session" });
  await flush();
  const offer = offerOf(sockets[1]);
  assert.equal(offer.proxyId, "fake-proxy");
  assert.ok(offer.connectionId);
  assert.equal(offerOf(sockets[0]).connectionId, undefined);
});

test("control offer drops a=sctp-init from the copy sent but keeps it locally", async t => {
  const { sockets, peers } = await startControl(t);
  assert.equal(offerOf(sockets[1]).sdp.includes("sctp-init"), false);
  assert.ok(offerOf(sockets[1]).sdp.includes("a=sctp-port:5000"));
  assert.ok(peers[1].local.sdp.includes("a=sctp-init:abc123"));
});

test("control answer is applied only when it carries the connection id of the offer", async t => {
  const { sockets, peers, connectionId } = await startControl(t);
  sockets[1].receive({ type: "answer", sdp: "stranger", connectionId: "other" });
  sockets[1].receive({ type: "answer", sdp: "no-id" });
  await flush();
  assert.equal(peers[1].remote, undefined);
  sockets[1].receive({ type: "answer", sdp: "control-answer", connectionId });
  await flush();
  assert.deepEqual(peers[1].remote, { type: "answer", sdp: "control-answer" });
  assert.equal(peers[0].remote.sdp, "media-answer");
});

test("control candidates wait for the control answer and are then applied", async t => {
  const { sockets, peers, connectionId } = await startControl(t);
  sockets[1].receive({ type: "candidate", connectionId, candidate: PUBLIC, mid: "0" });
  sockets[1].receive({ type: "candidate", connectionId, candidate: PRIVATE });
  sockets[1].receive({ type: "candidate", connectionId: "other", candidate: "candidate:9 1 udp 1 203.0.113.9 1 typ host" });
  await flush();
  assert.deepEqual(peers[1].candidates, []);
  sockets[1].receive({ type: "answer", sdp: "control-answer", connectionId });
  await flush();
  assert.deepEqual(peers[1].candidates, [
    { candidate: PUBLIC, sdpMid: "0", sdpMLineIndex: 0 },
    { candidate: PRIVATE, sdpMid: "0", sdpMLineIndex: 0 }
  ]);
  sockets[1].receive({ type: "candidate", connectionId, candidate: PUBLIC, mid: "1" });
  await flush();
  assert.equal(peers[1].candidates.at(-1).sdpMid, "1");
});

test("control public-only attempt drops local candidates exactly as media does", async t => {
  const { sockets, peers, connectionId } = await startControl(t, { allowPrivate: false });
  sockets[1].receive({ type: "candidate", connectionId, candidate: PRIVATE });
  sockets[1].receive({ type: "candidate", connectionId, candidate: PUBLIC });
  sockets[1].receive({ type: "answer", sdp: "control-answer", connectionId });
  await flush();
  sockets[1].receive({ type: "candidate", connectionId, candidate: LINK_LOCAL_V6 });
  await flush();
  assert.deepEqual(peers[1].candidates.map(c => c.candidate), [PUBLIC]);
});

test("control local candidates are applied when private candidates are allowed", async t => {
  const { sockets, peers, connectionId } = await startControl(t, { allowPrivate: true });
  sockets[1].receive({ type: "answer", sdp: "control-answer", connectionId });
  sockets[1].receive({ type: "candidate", connectionId, candidate: PRIVATE });
  await flush();
  assert.deepEqual(peers[1].candidates.map(c => c.candidate), [PRIVATE]);
});

test("control local candidates are sent with the proxy id and the connection id", async t => {
  const { sockets, peers, connectionId } = await startControl(t);
  const event = new Event("icecandidate");
  event.candidate = { candidate: PUBLIC, sdpMid: "0" };
  peers[1].dispatchEvent(event);
  assert.deepEqual(sockets[1].sent.at(-1),
    { type: "candidate", candidate: PUBLIC, mid: "0", connectionId, proxyId: "fake-proxy" });
  assert.equal(sockets[0].sent.some(message => message.type === "candidate"), false);
});

test("the control socket and the media socket are independent of each other", async t => {
  const { sockets, peers, connectionId } = await startControl(t);
  sockets[0].receive({ type: "candidate", candidate: PUBLIC });
  sockets[1].receive({ type: "candidate", connectionId, candidate: PUBLIC });
  await flush();
  assert.equal(peers[0].candidates.length, 1, "media gets its own candidate only");
  assert.deepEqual(peers[1].candidates, [], "control candidate still waits for its own answer");
  assert.equal(peers[1].remote, undefined);
  assert.equal(sockets[1].closed, 0);
  assert.equal(sockets[0].closed, 0);
});
