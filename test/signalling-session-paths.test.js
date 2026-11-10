import test from "node:test";
import assert from "node:assert/strict";
import { WebRtcProxy } from "../public/domain/webrtc-proxy.js";
import { ControlConnection } from "../public/domain/transport/control-connection.js";
import { SignallingSession } from "../public/domain/transport/signalling-session.js";

// The untaken paths of the shared signalling session: a message before the
// session, a socket that is not open, a socket that closes mid-offer, and the
// retired `onAnswered` hook. Only fakes: no network, no real peer, no torrent.
// Tests named [S1]..[S3] pin behaviour that already holds; the others carry
// `todo` until the code is written.
const flush = () => new Promise(resolve => setImmediate(resolve));
const SDP = "v=0\r\na=sctp-init:abc\r\nm=application\r\n";
const PUBLIC = "candidate:1 1 udp 1 203.0.113.7 4000 typ srflx";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Installs fake browser globals for one test; returns the fakes it created. */
function browser(t) {
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
    async createOffer() { return { type: "offer", sdp: SDP }; }
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
    constructor(url) { super(); this.url = url; sockets.push(this); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    receive(message) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
    /** The network drops: the socket is closed and says so. */
    drop() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
    close() { if (this.readyState !== 3) this.drop(); }
  }
  t.mock.method(console, "debug", () => {});
  const globals = { RTCPeerConnection: Peer, WebSocket: Socket,
    location: { protocol: "https:", host: "test.invalid" }, window: globalThis };
  const previous = {};
  for (const [key, value] of Object.entries(globals)) { previous[key] = globalThis[key]; globalThis[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(previous)) globalThis[key] = value; });
  return { peers, sockets, Peer };
}

/** A SignallingSession over the fakes, with every hook recorded. */
function session(t, { peer, extra = {} } = {}) {
  const fakes = browser(t);
  const calls = { createPeer: [], failures: [], ends: [], traces: [], accepted: [], socketClosed: 0 };
  const pcFor = peer ?? (() => new fakes.Peer());
  const sessionObject = new SignallingSession({
    proxyId: "fake-proxy",
    createPeer: id => { calls.createPeer.push(id); return pcFor(id); },
    acceptCandidate: candidate => { calls.accepted.push(candidate); return true; },
    trace: step => {
      calls.traces.push(step);
      if (step === "offer") return result => calls.ends.push(result);
      return undefined;
    },
    onFail: error => calls.failures.push(error),
    onSocketClosed: () => { calls.socketClosed++; },
    ...extra
  });
  sessionObject.open();
  t.after(() => sessionObject.close());
  return { ...fakes, session: sessionObject, calls, socket: fakes.sockets[0] };
}

function settledFlag(promise) {
  const flag = { settled: false };
  promise.then(() => { flag.settled = true; }, () => { flag.settled = true; });
  return flag;
}

function mediaPeer(t, options = {}) {
  const fakes = browser(t);
  const proxy = new WebRtcProxy("fake-proxy", null, true);
  const ready = proxy.connect();
  ready.catch(() => {});
  t.after(() => proxy.close());
  return { ...fakes, proxy, ready, ...options };
}

function controlPeer(t) {
  const fakes = browser(t);
  const closed = [];
  const control = new ControlConnection({
    proxyId: "fake-proxy",
    iceServers: [],
    silenceWindowMs: 1000,
    pending: () => 0,
    acceptCandidate: () => true,
    onMessage: () => {},
    onOpen: () => {},
    onClosed: (channel, error, opened) => closed.push({ error, opened })
  });
  const ready = control.open();
  ready.catch(() => {});
  t.after(() => control.close());
  return { ...fakes, control, ready, closed, socket: fakes.sockets[0], peer: fakes.peers[0],
    connectionId: control.connectionId };
}

const offerOf = socket => socket.sent.find(message => message.type === "offer");

// ---- S1: a message other than `session` before `session` is ignored ----

test("[S1] media peer ignores an answer, a candidate and an unknown message that arrive before the session", async t => {
  const { sockets, peers, ready } = mediaPeer(t);
  const flag = settledFlag(ready);
  sockets[0].receive({ type: "answer", sdp: "early-answer", separateControl: 2 });
  sockets[0].receive({ type: "candidate", candidate: PUBLIC, mid: "0" });
  sockets[0].receive({ type: "ice-restart" });
  await flush();
  assert.equal(sockets.length, 1, "an early answer opened no control socket");
  assert.equal(peers.length, 0, "no peer was created");
  assert.deepEqual(sockets[0].sent, []);
  assert.equal(flag.settled, false, "the connect is still waiting for its session");
});

test("[S1] media handshake proceeds once the session arrives after early messages", async t => {
  const { sockets, peers } = mediaPeer(t);
  sockets[0].receive({ type: "answer", sdp: "early-answer" });
  sockets[0].receive({ type: "candidate", candidate: PUBLIC, mid: "0" });
  await flush();
  sockets[0].receive({ type: "session", sessionId: "media-session" });
  await flush();
  assert.equal(peers.length, 1);
  assert.equal(offerOf(sockets[0]).proxyId, "fake-proxy");
  assert.equal(peers[0].remote, undefined, "the early answer was not applied");
  sockets[0].receive({ type: "answer", sdp: "media-answer" });
  await flush();
  assert.deepEqual(peers[0].remote, { type: "answer", sdp: "media-answer" });
  assert.deepEqual(peers[0].candidates, [], "the early candidate was not kept");
});

test("[S1] control peer ignores an answer and a candidate that arrive before the session", async t => {
  const { socket, peer, closed, connectionId } = controlPeer(t);
  socket.receive({ type: "answer", sdp: "early-answer", connectionId });
  socket.receive({ type: "candidate", candidate: PUBLIC, mid: "0", connectionId });
  await flush();
  assert.equal(peer.remote, undefined);
  assert.deepEqual(peer.candidates, []);
  assert.deepEqual(socket.sent, []);
  assert.deepEqual(closed, [], "the connection was not failed");
});

test("[S1] control handshake proceeds once the session arrives after early messages", async t => {
  const { socket, peer, closed, connectionId } = controlPeer(t);
  socket.receive({ type: "answer", sdp: "early-answer", connectionId });
  socket.receive({ type: "candidate", candidate: PUBLIC, mid: "0", connectionId });
  await flush();
  socket.receive({ type: "session", sessionId: "control-session" });
  await flush();
  assert.equal(offerOf(socket).connectionId, connectionId);
  assert.equal(peer.remote, undefined, "the early answer was not applied");
  socket.receive({ type: "answer", sdp: "control-answer", connectionId });
  await flush();
  assert.deepEqual(peer.remote, { type: "answer", sdp: "control-answer" });
  assert.deepEqual(peer.candidates, [], "the early candidate was not kept");
  assert.deepEqual(closed, []);
});

// ---- S2: no OPEN socket when the offer is sent fails the connect at once ----

test("[S2] a session that finds its socket not open reports one failure and sends nothing", async t => {
  const { socket, calls } = session(t);
  socket.readyState = 0;
  socket.receive({ type: "session", sessionId: "s1" });
  await flush();
  assert.equal(calls.failures.length, 1);
  assert.match(calls.failures[0].message, /not open/i);
  assert.deepEqual(socket.sent, []);
});

test("[S2] media connect fails at once when its socket is not open at the offer", { timeout: 5000 }, async t => {
  const { sockets, ready } = mediaPeer(t);
  sockets[0].readyState = 0;
  sockets[0].receive({ type: "session", sessionId: "media-session" });
  await assert.rejects(ready, /not open/i);
  assert.deepEqual(sockets[0].sent, []);
});

test("[S2] control connect fails at once, once, when its socket is not open at the offer", { timeout: 5000 }, async t => {
  const { socket, ready, closed } = controlPeer(t);
  socket.readyState = 0;
  socket.receive({ type: "session", sessionId: "control-session" });
  await assert.rejects(ready, /not open/i);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].opened, false);
  assert.deepEqual(socket.sent, []);
});

// ---- S3: the offer span is ended on every exit path ----

test("[S3] a sent offer ends its span once, as sent", async t => {
  const { socket, calls } = session(t);
  socket.receive({ type: "session", sessionId: "s1" });
  await flush();
  assert.ok(offerOf(socket));
  assert.deepEqual(calls.ends.map(end => end.outcome), ["sent"]);
});

test("[S3] an offer that cannot be created ends its span once, as an error, and fails once", async t => {
  const { socket, calls } = session(t, {
    peer: () => ({ createOffer: async () => { throw new Error("no offer"); } })
  });
  socket.receive({ type: "session", sessionId: "s1" });
  await flush();
  assert.deepEqual(calls.ends.map(end => end.outcome), ["error"]);
  assert.equal(calls.failures.length, 1);
});

test("[S3] a socket that closes while the offer is created ends its span once", async t => {
  const gate = deferred();
  const { socket, calls } = session(t, { peer: () => ({ createOffer: () => gate.promise, setLocalDescription: async () => {} }) });
  socket.receive({ type: "session", sessionId: "s1" });
  await flush();
  socket.drop();
  gate.resolve({ type: "offer", sdp: SDP });
  await flush();
  assert.equal(calls.ends.length, 1);
});

test("a socket whose close the owner answers by closing the session ends the offer span once, while the offer is created",
  { todo: "S3" }, async t => {
    const gate = deferred();
    let owner;
    const { socket, calls, session: opened } = session(t, {
      peer: () => ({ createOffer: () => gate.promise, setLocalDescription: async () => {} }),
      extra: { onSocketClosed: () => owner.close() }
    });
    owner = opened;
    socket.receive({ type: "session", sessionId: "s1" });
    await flush();
    socket.drop();
    gate.resolve({ type: "offer", sdp: SDP });
    await flush();
    assert.equal(calls.ends.length, 1);
  });

test("a socket whose close the owner answers by closing the session ends the offer span once, while the local description is set",
  { todo: "S3" }, async t => {
    const gate = deferred();
    let owner;
    const { socket, calls, session: opened } = session(t, {
      peer: () => ({ createOffer: async () => ({ type: "offer", sdp: SDP }), setLocalDescription: () => gate.promise }),
      extra: { onSocketClosed: () => owner.close() }
    });
    owner = opened;
    socket.receive({ type: "session", sessionId: "s1" });
    await flush();
    socket.drop();
    gate.resolve();
    await flush();
    assert.equal(calls.ends.length, 1);
  });

test("a session closed by its owner while the offer is created ends the offer span once",
  { todo: "S3" }, async t => {
    const gate = deferred();
    const { socket, calls, session: opened } = session(t, {
      peer: () => ({ createOffer: () => gate.promise, setLocalDescription: async () => {} })
    });
    socket.receive({ type: "session", sessionId: "s1" });
    await flush();
    opened.close();
    gate.resolve({ type: "offer", sdp: SDP });
    await flush();
    assert.equal(calls.ends.length, 1);
  });

// ---- S4: the retired `onAnswered` hook is not accepted ----

test("the session does not call an onAnswered option when the answer is applied",
  { todo: "S4" }, async t => {
    const answered = [];
    const { socket, peers } = session(t, { extra: { onAnswered: message => answered.push(message) } });
    socket.receive({ type: "session", sessionId: "s1" });
    await flush();
    socket.receive({ type: "answer", sdp: "the-answer" });
    await flush();
    assert.deepEqual(peers[0].remote, { type: "answer", sdp: "the-answer" });
    assert.deepEqual(answered, []);
  });
