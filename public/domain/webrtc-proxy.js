/**
 * @file WebRTC data channel transport to a proxy.
 *
 * Establishes a peer-to-peer connection through the server's signalling
 * endpoint (`/ws/browser-signal`) and exposes a fetch-like API so that all
 * proxy calls — API requests and HLS video segments — travel over the data
 * channel without passing through the server.
 *
 * ## Connection flow
 *
 * 1. `connect()` opens a signalling WebSocket to the server.
 * 2. The server responds with `{ type: "session", sessionId }`.
 * 3. The browser creates an `RTCPeerConnection` with an ordered data channel,
 *    generates an SDP offer, and sends it through the WebSocket.
 * 4. The server forwards the offer to the proxy via the proxy tunnel.
 * 5. The proxy generates an SDP answer; the server forwards it back.
 * 6. ICE candidates are exchanged the same way until the P2P path is found.
 * 7. Capability version 2 adds a control-only peer through its own signalling
 *    socket. `connect()` resolves when both required channels are open.
 * 8. `fetch()` routes media and control separately; `ping()` uses control.
 */

import { CONNECT_TIMEOUT_MS } from "./connect-deadline.js";
import { waitTrace } from "./wait-trace.js";
import { ControlConnection } from "./transport/control-connection.js";
import {
  deliveryDueWithinMs,
  emptyArrivalEstimate,
  noteProbeGap,
  silenceVerdict
} from "./transport/delivery-deadline.js";

/**
 * A minimal `Response`-like object assembled from data channel chunks.
 *
 * @typedef {Object} DataChannelResponse
 * @property {boolean} ok     - `true` when `status` is in the 2xx range.
 * @property {number}  status - HTTP status code forwarded from the proxy.
 * @property {{ get: (name: string) => string | null }} headers
 *   Header accessor; names are lower-cased.
 * @property {() => Promise<ArrayBuffer>} arrayBuffer
 * @property {() => Promise<string>}      text
 * @property {() => Promise<any>}         json
 */

/**
 * A pending fetch or ping entry tracked in `#pending`.
 *
 * @typedef {Object} PendingEntry
 * @property {(result: any) => void}   resolve
 * @property {(error: Error) => void}  reject
 * @property {Uint8Array[]}  chunks  - Accumulated response body byte chunks.
 * @property {number}    status  - HTTP status received in `response-start`.
 * @property {object}    headers - Headers received in `response-start`.
 */

/** Reused decoder for ASCII requestIds in binary response frames. */
// How often the browser writes its transport counters to the log. The proxy
// samples its own on the same cadence, so the two lines can be subtracted.
const TRANSPORT_SAMPLE_MS = 5_000;
/**
 * How often this side reports what it has seen back to the proxy.
 *
 * The proxy numbers a probe every half second on every channel; this echo is
 * what turns those numbers into a reading, because it travels browser to proxy
 * — the direction that goes on working through a delivery freeze (measured
 * 2026-08-24: requests arrived and were answered for 88 minutes while nothing
 * came back the other way). Same period as the probe, so the proxy's gap
 * measurement is never stale by more than one interval.
 */
const PROBE_ECHO_MS = 500;
/** How often the event loop is asked how late it is running. */
const LOOP_LAG_PROBE_MS = 200;

const ASCII_DECODER = new TextDecoder();

/**
 * Decode a base64 string to bytes (legacy JSON body path only).
 *
 * @param {string} b64
 * @returns {Uint8Array}
 */
function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** @type {Array<{ urls: string }>} */
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const TRANSPORT_SILENCE_WINDOW_MS = 60_000;
const PING_TIMEOUT_MS = 5_000;

// Chunked request bodies. A request whose body exceeds the threshold is sent
// as a `request-start` announcement + binary body frames (the response-frame
// layout), so a large body (e.g. a multi-season .torrent source registration)
// is never one oversized data-channel message. Small/bodyless requests keep
// the single-message form. The proxy reassembles the frames (see the proxy's
// data-channel-handler); bodies are measured in UTF-8 bytes, not string length.
const REQUEST_CHUNK_BYTES = 64 * 1024;
const REQUEST_CHUNK_THRESHOLD_BYTES = 128 * 1024;
const REQUEST_BUFFERED_HIGH_BYTES = 1 * 1024 * 1024; // pause sending above this

// The answers a held picture waits for: a seek's acknowledgement and the
// start forecast. Each is logged on arrival with its request id.
const HELD_ANSWER_PATH = /\/api\/transcode-sessions\/[^/?]+\/(?:progress|seek)(?:\?|$)/u;
const MEDIA_TRANSFER_PATH = /\/transcode\//u;
const REQUEST_BUFFERED_LOW_BYTES = 256 * 1024; // resume once drained to this
const REQUEST_BUFFER_DRAIN_TIMEOUT_MS = 5_000; // fallback so a missed drain event cannot deadlock

/** Bulk responses must not share the association reserved for control answers. */
function isBulkPath(path, method) {
  return path.startsWith("/transcode/") || path.startsWith("/stream") || path === "/media" ||
    path === "/api/link-probe" || path === "/api/delivery-sink" ||
    (method === "GET" && path === "/api/subtitles") ||
    (path.startsWith("/api/sources/") && path.endsWith("/cover"));
}

export class WebRtcProxy {
  /** @type {string} */
  #proxyId;
  /** @type {number | null} HTTP port of the proxy's LAN server (for #lanProbeUrl). */
  #proxyLocalPort;
  /** @type {boolean} Whether the proxy's LOCAL-address candidates are used (see constructor). */
  #allowPrivateCandidates;
  /** @type {string | null} `http://<proxy-lan-ip>:<port>/healthz` once a private candidate was seen. */
  #lanProbeUrl = null;
  /** @type {RTCPeerConnection | null} */
  #pc = null;
  /** @type {RTCDataChannel | null} */
  #channel = null;
  /** Handle of the transport-counter sampler; see #startTransportSampling. */
  #transportSampler = null;

  /**
   * Reliable control messages. Capability version 2 puts this channel on an
   * independent SCTP association: different streams on one association still
   * share its send buffer and congestion window (r69, torrent-tv/meta#189).
   * Legacy proxies retain their second channel on the media association.
   */
  #controlChannel = null;
  #controlLink = null;
  #controlNegotiated = false;
  #controlCounters = {};
  #controlTransportIn = null;
  /**
   * Who is watching over this connection: the page's own consumer id.
   *
   * Held here so it can be re-announced whenever a control channel opens —
   * which happens again on every rung of the reconnect ladder, since a
   * reconnect builds a new peer connection under a player that never stopped.
   * The name is the PAGE's and not this connection's, so one person stays one
   * person across a transport swap.
   *
   * @type {string}
   */
  #viewerName = "";
  /**
   * The last round trip measured to this proxy, in milliseconds, or null
   * before any ping has answered. What a held request's answer takes to come
   * back, and therefore how much earlier than this page's own deadline the
   * proxy has to answer it.
   *
   * @type {number | null}
   */
  #lastRoundTripMs = null;
  /**
   * A third channel, opened UNORDERED and with no retransmission.
   *
   * It carries nothing but the proxy's numbered probes, and it exists to answer
   * one question no counter on either side can answer alone. SCTP orders and
   * retransmits per STREAM: a probe that keeps arriving here while the ordered
   * channels have gone silent means a retransmission is stuck in one of them,
   * and a probe that stops here too means the association stopped transmitting
   * — a receive window shut, or the sender halted. Both ordered channels froze
   * together in the 2026-08-24 episode, which already points at the second, and
   * this is what settles it.
   *
   * Null on a proxy that only accepts what it is offered — nothing depends on
   * it, so an old proxy simply yields one fewer reading.
   *
   * @type {RTCDataChannel | null}
   */
  #fastChannel = null;
  /**
   * The highest probe number seen on each channel, by label.
   * @type {Map<string, number>}
   */
  #probeSeen = new Map();

  /**
   * When the highest probe on each channel arrived here, by this machine's
   * clock.
   *
   * Sent back with the report. Proxies from 2.89.9 on no longer read it: they
   * judge delivery by the age of the newest probe seen, because the one-way
   * time of a probe that arrived says nothing about one that did not. Older
   * proxies in the pool still turn it into a one-way delay, so it keeps being
   * sent.
   *
   * @type {Map<string, number>}
   */
  #probeSeenAt = new Map();
  /** Handle of the echo timer; see #startProbeEcho. */
  #probeEchoTimer = null;
  /**
   * The longest a single channel-message handler has run since the last report.
   * A page that stops draining the channel is one of the two candidate causes
   * of a delivery freeze, and this is what would show it.
   */
  #handlerMaxMs = 0;
  /** Event-loop lag, measured by a timer that knows when it should have fired. */
  #loopLagMs = 0;
  /** Handle of the loop-lag probe. */
  #loopLagTimer = null;
  /** When the loop-lag probe was due to fire next. */
  #loopLagExpectedAt = null;
  /**
   * Per-channel receive counters from the last `getStats` sample.
   * @type {Record<string, { messages: number | null, bytes: number | null }>}
   */
  #lastChannelCounters = {};
  /** Transport bytes received at the last sample, so the trend is available here too. */
  #lastTransportIn = null;
  /**
   * When anything last arrived on any channel of this connection, by
   * `performance.now()`. A message of any kind ends a silence.
   */
  #lastArrivalAt = 0;
  /** Messages handled here, on every channel, compared with what the transport says it received. */
  #messagesHandled = 0;
  /**
   * The rhythm of this connection's deliveries: gaps between consecutive probe
   * NUMBERS, each number counted once whichever channel brought it first. See
   * `transport/delivery-deadline.js`.
   */
  #arrivalEstimate = emptyArrivalEstimate();
  /** The newest probe number counted into the estimate, and when it arrived. @type {{ seq: number, at: number } | null} */
  #lastCountedProbe = null;
  /** The one pending check of this connection's silence. */
  #deliveryCheck = null;
  /** True from a stall being called until the next message arrives. */
  #stalled = false;
  /** @type {WebSocket | null} */
  #ws = null;
  /**
   * How many remote candidates this connection has refused. Only the count is
   * kept: the lines themselves are capped, because one bad `sdpMid` refuses
   * every candidate that follows.
   */
  #candidateRefusals = 0;
  /** How many refusals are written before only the count is kept. */
  static #MAX_CANDIDATE_REFUSAL_LINES = 3;
  /**
   * Pending fetch and ping entries keyed by requestId (or `ping:{id}`).
   * @type {Map<string, PendingEntry>}
   */
  #pending = new Map();
  /**
   * ICE candidates received before the remote description was set.
   * Drained immediately after setRemoteDescription completes.
   * @type {Array<{candidate: string, sdpMid: string, sdpMLineIndex: number}>}
   */
  #pendingCandidates = [];
  /** @type {boolean} */
  #remoteDescriptionSet = false;
  /** @type {boolean} True once the data channel opened successfully. */
  #connected = false;
  #connectSettler = null;
  /** @type {boolean} True when close() was called by the app itself. */
  #closedByUser = false;
  /** @type {boolean} Guards onConnectionLost against double-firing. */
  #lostFired = false;
  /** @type {string | null} Signalling session id assigned by the server (== the proxy's `[webrtc] Session <id>`). */
  #signalSessionId = null;
  #traceContext = null;
  #traceSignalEnd = null;
  #traceSessionEnd = null;
  #traceOfferEnd = null;
  #traceAnswerEnd = null;
  #traceGatherEnd = null;
  #traceMediaEnd = null;
  #traceControlEnd = null;
  #traceJoinEnd = null;

  /**
   * Called once when an ESTABLISHED connection is lost (data channel closed
   * or the peer connection failed) and the loss was not initiated by our own
   * close(). Assign a handler to react to mid-playback proxy loss.
   *
   * @type {(() => void) | null}
   */
  onConnectionLost = null;

  /**
   * Called once when this connection's next delivery is overdue while requests
   * are waiting — the moment to raise a second connection beside it. Not a
   * loss: the connection is kept, because the silence may end (the proxy's own
   * thread was blocked for 21 s on 2026-10-01 while the association was fine).
   *
   * @type {(() => void) | null}
   */
  onDeliveryStalled = null;

  /**
   * Called once when a message arrives after a stall was called.
   *
   * @type {(() => void) | null}
   */
  onDeliveryResumed = null;

  /**
   * Called on every unsolicited `subtitle-cues` push from the proxy — new
   * cues for one track, found off the proxy's own download rather than in
   * answer to a request this side made. Assign a handler to receive them.
   *
   * @type {((event: { fileIndex: number, trackIndex: number, cues: object[], language: string,
   *   detectedLanguage: { code: string, name: string } | null, withdrawn: Array<number | string>,
   *   cursor: number | null }) => void) | null}
   */
  onSubtitleCues = null;
  onChaptersChanged = null;

  /** Fire onConnectionLost once, only for losses of an established connection. */
  #fireConnectionLost() {
    if (!this.#connected || this.#closedByUser || this.#lostFired) {
      return;
    }
    this.#lostFired = true;
    const error = new Error("Proxy connection lost.");
    error.code = "TRANSPORT_LOST";
    for (const entry of this.#pending.values()) {
      entry.reject(error);
    }
    this.#pending.clear();
    this.#controlLink?.close();
    try {
      this.onConnectionLost?.();
    } catch (error) {
      console.warn("[webrtc-proxy] onConnectionLost handler failed:", error);
    }
  }

  /**
   * @param {string} proxyId
   * @param {number | null} [proxyLocalPort] - HTTP port of the proxy's LAN
   *   server (from the health API baseUrl). Used to build {@link lanProbeUrl}.
   * @param {boolean} [allowPrivateCandidates=true] - When false, the proxy's
   *   LOCAL-address candidates (192.168.x etc.) are dropped, so the browser
   *   never touches the local network and never asks for the local-network
   *   permission. Same-LAN viewers then connect through the router's public
   *   address (hairpin) when it supports that; the caller retries with
   *   `true` (after obtaining the permission) when it does not.
   */
  constructor(proxyId, proxyLocalPort = null, allowPrivateCandidates = true) {
    this.#proxyId = proxyId;
    this.#proxyLocalPort = proxyLocalPort ?? null;
    this.#allowPrivateCandidates = allowPrivateCandidates !== false;
  }

  /** @returns {boolean} */
  get isOpen() {
    return this.#channel?.readyState === "open";
  }

  /**
   * The proxy id this connection targets. Exposed so the app can rebuild the
   * same connection on reconnect (see the auto-reconnect flow).
   * @returns {string}
   */
  get proxyId() {
    return this.#proxyId;
  }

  /**
   * The proxy's LAN HTTP port (or null). Part of the reconnect descriptor.
   * @returns {number | null}
   */
  get proxyLocalPort() {
    return this.#proxyLocalPort;
  }

  /**
   * The signalling session id the proxy knows this connection by.
   *
   * Exposed so the log forwarder can be told about the connection that is
   * actually CARRYING the session rather than about every connection that ever
   * reached "connected" — see {@link setSignalSession}'s caller.
   *
   * @returns {string | null}
   */
  get signalSessionId() {
    return this.#signalSessionId;
  }

  /**
   * Whether this connection was built allowing the proxy's local-address
   * candidates. Reused on reconnect so the same candidate policy (and thus no
   * permission question on the same-proxy path) is applied.
   * @returns {boolean}
   */
  get allowsPrivateCandidates() {
    return this.#allowPrivateCandidates;
  }

  /**
   * `http://<proxy-lan-ip>:<port>/healthz` — the URL whose fetch (with
   * `targetAddressSpace: "local"`) makes the browser ask for the local-network
   * permission. Null until a private candidate has been seen.
   *
   * @returns {string | null}
   */
  get lanProbeUrl() {
    return this.#lanProbeUrl;
  }

  /**
   * Open the signalling WebSocket, complete the SDP handshake, and wait for
   * the data channel to become open.
   *
   * @param {number} [timeoutMs=CONNECT_TIMEOUT_MS]
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<void>}
   */
  async connect(timeoutMs = CONNECT_TIMEOUT_MS, { signal } = {}) {
    if (signal?.aborted) throw new DOMException("Proxy connection was cancelled.", "AbortError");
    this.#traceContext = waitTrace.contextForOperation("A2");
    const finishConnect = waitTrace.open("A2.connection-attempt", { proxyId: this.#proxyId }, this.#traceContext);
    this.#traceSessionEnd = waitTrace.open("A2.2.websocket-session", {
      process: "A2.2.1", proxyId: this.#proxyId
    }, this.#traceContext);
    const wsUrl = `${location.protocol.replace("http", "ws")}//${location.host}/ws/browser-signal`;
    try {
      this.#ws = new WebSocket(wsUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#traceSessionEnd?.({ outcome: "error", error: message });
      this.#traceSessionEnd = null;
      finishConnect({ outcome: "error", error: message });
      throw error;
    }

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        settle(new Error("WebRTC connection timed out."));
        this.close();
        // Never longer than CONNECT_TIMEOUT_MS: the server counts on it when it
        // hands over (connect-deadline.js).
      }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, CONNECT_TIMEOUT_MS) : CONNECT_TIMEOUT_MS);

      // Store settler so the data channel open / error events can resolve/reject the outer promise.
      let settled = false;
      const settle = (err) => {
        if (settled) return;
        const traceResult = { outcome: err ? "error" : "ready", error: err?.message };
        this.#traceSignalEnd?.(traceResult);
        this.#traceSessionEnd?.(traceResult);
        this.#traceOfferEnd?.(traceResult);
        this.#traceAnswerEnd?.(traceResult);
        this.#traceGatherEnd?.(traceResult);
        this.#traceMediaEnd?.(traceResult);
        this.#traceControlEnd?.(traceResult);
        this.#traceJoinEnd?.(traceResult);
        this.#traceSignalEnd = this.#traceSessionEnd = this.#traceOfferEnd = this.#traceAnswerEnd =
          this.#traceGatherEnd = this.#traceMediaEnd = this.#traceControlEnd = this.#traceJoinEnd = null;
        finishConnect({ outcome: err ? "error" : "connected", error: err?.message });
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        this.#connectSettler = null;
        if (err) reject(err); else resolve();
      };
      const aborted = () => this.close();
      this.#connectSettler = settle;
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) { aborted(); return; }

      this.#ws.addEventListener("message", (event) => {
        this.#onSignalMessage(event.data, settle);
      });

      this.#ws.addEventListener("error", () => {
        settle(new Error("WebSocket error during WebRTC signalling."));
      });

      this.#ws.addEventListener("close", () => {
        if (!settled) {
          settle(new Error("WebSocket closed before data channel was established."));
        }
      });
    });
  }

  /**
   * Handle a single message arriving on the signalling WebSocket.
   *
   * @param {string} raw
   * @param {(err?: Error) => void} settle
   */
  async #onSignalMessage(raw, settle) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (error) {
      // A signalling message that cannot be read is a step of the connect that
      // silently did not happen, and the viewer meets it later as "no proxy
      // answered". Say what arrived — truncated, because a malformed frame can
      // be any size at all.
      console.warn(
        `[torrent-tv][signal] a signalling message could not be parsed (${error instanceof Error ? error.message : String(error)}): ` +
        `${String(raw).slice(0, 200)}`
      );
      return;
    }

    if (this.#closedByUser) return;
    if (msg.type === "session") {
      this.#traceSessionEnd?.({ outcome: "session-received", connection: msg.sessionId });
      this.#traceSessionEnd = null;
      this.#traceSignalEnd = waitTrace.open("A2.2.signalling", { connection: msg.sessionId }, this.#traceContext);
      // Record the session id and hand it to the log forwarder so browser logs
      // can be joined to the proxy's `[webrtc] Session <id>` lines.
      //
      // Announced here AND again when the connection is adopted as the
      // transport, last writer wins. Here, because the forwarder stamps whole
      // batches every two seconds and the connect itself takes seconds — the
      // signalling, ICE, DTLS and local-network phase is the part most often
      // being diagnosed, and a connect that FAILS never reaches adoption at
      // all, so leaving it to adoption alone left exactly those lines
      // unstamped. Again at adoption, because with more than one connection
      // this one may not be the one that carries the session.
      this.#signalSessionId = typeof msg.sessionId === "string" ? msg.sessionId : null;
      if (this.#signalSessionId) {
        console.debug(`[ice] signalling session ${this.#signalSessionId}`);
        try {
          window.__ttvClientLogger?.setSignalSession?.(this.#signalSessionId);
        } catch {
          // silent-ok: the log forwarder is a debugging aid, and signalling must
          // not fail because a diagnostic could not be tagged. Nothing is
          // abandoned here — the session continues either way.
        }
      }
      try {
        await this.#createPeerConnection(msg.sessionId, settle);
      } catch (err) {
        settle(err instanceof Error ? err : new Error(String(err)));
      }
      return;
    }

    if (msg.type === "answer" && this.#pc) {
      this.#traceAnswerEnd = waitTrace.open("A2.2.remote-description", {
        process: "A2.2.3", connection: this.#signalSessionId
      }, this.#traceContext);
      try {
        waitTrace.event("A2.media-answer", { connection: this.#signalSessionId }, this.#traceContext);
        const pc = this.#pc;
        await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
        this.#traceAnswerEnd?.({ outcome: "applied" });
        this.#traceAnswerEnd = null;
        if (this.#closedByUser || this.#pc !== pc) return;
        this.#remoteDescriptionSet = true;
        // Drain buffered candidates so ICE checking can start.
        for (const c of this.#pendingCandidates) {
          const finishCandidate = waitTrace.open("A2.2.remote-candidate-application", {
            process: "A2.2.4", connection: this.#signalSessionId, disposition: "buffered"
          }, this.#traceContext);
          try {
            await pc.addIceCandidate(c);
            finishCandidate({ outcome: "applied" });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            finishCandidate({ outcome: "rejected", error: message });
            console.debug(`[torrent-tv][ice] buffered remote candidate refused (${message})`);
          }
        }
        if (this.#closedByUser || this.#pc !== pc) return;
        this.#pendingCandidates = [];
        waitTrace.event("A2.media-answer-applied", { connection: this.#signalSessionId }, this.#traceContext);
        this.#traceSignalEnd?.({ outcome: "answer-applied" });
        this.#traceSignalEnd = null;
        this.#traceJoinEnd = waitTrace.open("A2.J.ready-join", { connection: this.#signalSessionId }, this.#traceContext);
        if (msg.separateControl === 2) {
          this.#openSeparateControl(settle);
        } else if (!this.#controlChannel) {
          this.#openLegacyControl();
        }
        this.#controlNegotiated = true;
        this.#settleConnected(settle);
      } catch (err) {
        this.#traceAnswerEnd?.({ outcome: "error", error: String(err?.message ?? err) });
        this.#traceAnswerEnd = null;
        settle(err instanceof Error ? err : new Error(String(err)));
      }
      return;
    }

    if (msg.type === "candidate" && this.#pc) {
      const c = {
        candidate: msg.candidate,
        sdpMid: msg.mid ?? "0",
        sdpMLineIndex: 0
      };
      console.debug(`[ice] remote ${WebRtcProxy.#describeCandidate(c.candidate)}`);
      waitTrace.event("A2.2.remote-candidate-received", { process: "A2.2.4", connection: this.#signalSessionId,
        disposition: this.#remoteDescriptionSet ? "apply" : "buffer" }, this.#traceContext);
      // Track the proxy's LAN address (for the local-network permission probe)
      // and, in public-only mode, drop local-address candidates so the browser
      // never touches the local network — and never asks for the permission.
      const ip = WebRtcProxy.#extractCandidateIp(c.candidate);
      if (ip && WebRtcProxy.#isLocalAddress(ip)) {
        if (this.#lanProbeUrl === null && this.#proxyLocalPort && WebRtcProxy.#isPrivateIpv4(ip)) {
          this.#lanProbeUrl = `http://${ip}:${this.#proxyLocalPort}/healthz`;
        }
        if (!this.#allowPrivateCandidates) {
          console.debug("[ice] remote local candidate skipped (public-only attempt)");
          return;
        }
      }
      if (!this.#remoteDescriptionSet) {
        // Buffer until the answer is applied.
        this.#pendingCandidates.push(c);
        return;
      }
      const finishCandidate = waitTrace.open("A2.2.remote-candidate-application", {
        process: "A2.2.4", connection: this.#signalSessionId, disposition: "trickled"
      }, this.#traceContext);
      try {
        await this.#pc.addIceCandidate(c);
        finishCandidate({ outcome: "applied" });
      } catch (error) {
        finishCandidate({ outcome: "rejected", error: String(error?.message ?? error) });
        // Usually stale or duplicate — but that is a guess, and a candidate
        // refused for some other reason is a path to the proxy that was never
        // tried. Name what was refused instead of asserting why.
        //
        // Through the same privacy-safe summary every other candidate line
        // uses: the raw string carries the proxy owner's home IP and port, and
        // these lines are forwarded to the server and kept in its log. In a
        // pool of strangers' machines that is not ours to record.
        //
        // A refusal is rarely alone — a mismatched mid or a closed connection
        // refuses every candidate that follows, and with predicted ports there
        // can be eighteen of them — so only the first few are written, and the
        // rest are counted. The forwarder's buffer is 500 lines; a burst that
        // fills it discards the lines saying why the connect failed.
        this.#candidateRefusals += 1;
        if (this.#candidateRefusals <= WebRtcProxy.#MAX_CANDIDATE_REFUSAL_LINES) {
          console.debug(
            `[torrent-tv][ice] candidate refused (${error instanceof Error ? error.message : String(error)}): ` +
            `${WebRtcProxy.#describeCandidate(c.candidate)}`
          );
        } else if (this.#candidateRefusals === WebRtcProxy.#MAX_CANDIDATE_REFUSAL_LINES + 1) {
          console.debug("[torrent-tv][ice] further candidate refusals on this connection are not being written");
        }
      }
    }
  }

  /**
   * Create the RTCPeerConnection, attach the data channel, and send the offer.
   *
   * @param {string} _sessionId - Assigned by the server (unused in browser, included for clarity).
   * @param {(err?: Error) => void} settle
   */
  async #createPeerConnection(_sessionId, settle) {
    this.#traceMediaEnd = waitTrace.open("A2.2m.media-transport", { connection: this.#signalSessionId }, this.#traceContext);
    this.#traceGatherEnd = waitTrace.open("A2.2.ice-gathering", {
      process: "A2.2.5", connection: this.#signalSessionId
    }, this.#traceContext);
    this.#pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.#channel = this.#pc.createDataChannel("proxy", { ordered: true });

    // The unordered, non-retransmitting channel. It carries probes only, so a
    // failure to open it costs one reading and nothing else.
    try {
      this.#fastChannel = this.#pc.createDataChannel("proxy-fast", {
        ordered: false,
        maxRetransmits: 0
      });
      this.#fastChannel.binaryType = "arraybuffer";
      this.#fastChannel.addEventListener("message", (event) => {
        this.#onChannelMessage(event.data, "proxy-fast");
      });
      this.#fastChannel.addEventListener("close", () => {
        this.#fastChannel = null;
      });
      this.#fastChannel.addEventListener("error", () => {
        this.#fastChannel = null;
      });
    } catch (error) {
      console.debug(
        `[dc] the unordered probe channel could not be created (${error instanceof Error ? error.message : String(error)})`
      );
      this.#fastChannel = null;
    }
    // Response bodies arrive as binary frames; receive them as ArrayBuffer
    // rather than Blob so they can be parsed synchronously.
    this.#channel.binaryType = "arraybuffer";
    // Low-water mark for the chunked-request backpressure loop (see fetch()).
    this.#channel.bufferedAmountLowThreshold = REQUEST_BUFFERED_LOW_BYTES;

    this.#channel.addEventListener("open", () => {
      waitTrace.event("A2.media-open", { connection: this.#signalSessionId }, this.#traceContext);
      this.#traceMediaEnd?.({ outcome: "open" });
      this.#traceMediaEnd = null;
      // A silence is counted from the moment there was something to deliver on.
      this.#lastArrivalAt = performance.now();
      this.#announceViewer();
      this.#settleConnected(settle);
    });

    this.#channel.addEventListener("error", (event) => {
      settle(new Error(`Data channel error: ${event.message ?? "unknown"}`));
    });

    this.#channel.addEventListener("message", (event) => {
      this.#onChannelMessage(event.data, "proxy");
    });

    this.#channel.addEventListener("close", () => {
      this.#fireConnectionLost();
    });

    this.#pc.addEventListener("icecandidate", (event) => {
      console.debug(`[ice] local ${WebRtcProxy.#describeCandidate(event.candidate?.candidate)}`);
      waitTrace.event("A2.2.local-candidate", { connection: this.#signalSessionId,
        disposition: event.candidate ? "sent" : "complete" }, this.#traceContext);
      if (!event.candidate) {
        this.#traceGatherEnd?.({ outcome: "complete" });
        this.#traceGatherEnd = null;
      }
      if (event.candidate && this.#ws?.readyState === WebSocket.OPEN) {
        this.#ws.send(JSON.stringify({
          type: "candidate",
          proxyId: this.#proxyId,
          candidate: event.candidate.candidate,
          mid: event.candidate.sdpMid ?? "0"
        }));
      }
    });

    // Diagnostics (temporary): ICE state transitions + the selected pair, so a
    // failed connection in the field shows which candidate types were tried and
    // whether the Local Network Access gate is the blocker.
    this.#pc.addEventListener("iceconnectionstatechange", () => {
      console.debug(`[ice] iceConnectionState=${this.#pc?.iceConnectionState}`);
    });
    this.#pc.addEventListener("icegatheringstatechange", () => {
      console.debug(`[ice] iceGatheringState=${this.#pc?.iceGatheringState}`);
      waitTrace.event("A2.2.ice-gathering-state", { connection: this.#signalSessionId,
        state: this.#pc?.iceGatheringState }, this.#traceContext);
      if (this.#pc?.iceGatheringState === "complete") {
        this.#traceGatherEnd?.({ outcome: "complete" });
        this.#traceGatherEnd = null;
      }
    });

    this.#pc.addEventListener("connectionstatechange", () => {
      const state = this.#pc?.connectionState;
      console.debug(`[ice] connectionState=${state}`);
      if (state === "connected" || state === "failed") {
        void this.#logSelectedPair();
        this.#startTransportSampling();
      }
      if (state === "failed") {
        settle(new Error("WebRTC connection failed."));
        this.#fireConnectionLost();
      }
    });

    this.#traceOfferEnd = waitTrace.open("A2.2.offer-create-and-send", {
      process: "A2.2.2", connection: this.#signalSessionId
    }, this.#traceContext);
    let offer;
    try {
      offer = await this.#pc.createOffer();
      await this.#pc.setLocalDescription(offer);

    // Strip `a=sctp-init` from the COPY of the offer sent to the proxy.
    // Chromium 152+ embeds its SCTP INIT in the SDP (zero-RTT association).
    // libdatachannel does not understand the attribute and ECHOES it verbatim
    // in its answer — the browser then believes the (bogus, self-mirrored)
    // zero-RTT association is established, no SCTP ever hits the wire, and the
    // channel dies ~5 s after DTLS (confirmed via tcpdump + SDP capture).
    // Without the attribute in the answer the browser falls back to the
    // classic in-band INIT handshake, which works. Local description keeps it.
      const sdpForProxy = offer.sdp.replace(/a=sctp-init:[^\r\n]*\r\n/g, "");

      this.#ws?.send(JSON.stringify({ type: "offer", proxyId: this.#proxyId, sdp: sdpForProxy }));
      this.#traceOfferEnd?.({ outcome: "sent" });
      this.#traceOfferEnd = null;
    } catch (error) {
      this.#traceOfferEnd?.({ outcome: "error", error: String(error?.message ?? error) });
      this.#traceOfferEnd = null;
      throw error;
    }
  }

  #settleConnected(settle) {
    if (!this.#controlNegotiated) return;
    if (this.#channel?.readyState !== "open") return;
    if (this.#controlLink && this.#controlChannel?.readyState !== "open") return;
    if (!this.#connected) {
      this.#traceJoinEnd?.({ outcome: "ready", mediaOpen: true, controlReady: true });
      this.#traceJoinEnd = null;
      waitTrace.event("A2.both-open", { process: "A2.J", phase: "end", connection: this.#signalSessionId }, this.#traceContext);
    }
    this.#connected = true;
    settle();
  }

  #openLegacyControl() {
    this.#traceControlEnd = waitTrace.open("A2.2c.control-transport", { connection: this.#signalSessionId,
      mode: "legacy" }, this.#traceContext);
    const channel = this.#pc.createDataChannel("proxy-control", { ordered: true });
    this.#controlChannel = channel;
    channel.binaryType = "arraybuffer";
    channel.addEventListener("message", event => this.#onChannelMessage(event.data, "proxy-control"));
    channel.addEventListener("open", () => {
      this.#traceControlEnd?.({ outcome: "open" });
      this.#traceControlEnd = null;
      this.#announceViewer();
    });
    const closed = () => {
      this.#rejectChannel(channel, new Error("Control data channel closed."));
      if (this.#controlChannel === channel) this.#controlChannel = null;
    };
    channel.addEventListener("close", closed);
    channel.addEventListener("error", closed);
  }

  #openSeparateControl(settle) {
    if (this.#controlLink) return;
    this.#traceControlEnd = waitTrace.open("A2.2c.control-transport", { connection: this.#signalSessionId,
      mode: "separate" }, this.#traceContext);
    waitTrace.event("A2.control-start", { connection: this.#signalSessionId }, this.#traceContext);
    this.#controlLink = new ControlConnection({
      proxyId: this.#proxyId,
      iceServers: ICE_SERVERS,
      silenceWindowMs: TRANSPORT_SILENCE_WINDOW_MS,
      pending: channel => this.#pendingOn(channel),
      acceptCandidate: candidate => {
        console.debug(`[ice-control] remote ${WebRtcProxy.#describeCandidate(candidate.candidate)}`);
        const ip = WebRtcProxy.#extractCandidateIp(candidate.candidate);
        return this.#allowPrivateCandidates || !ip || !WebRtcProxy.#isLocalAddress(ip);
      },
      onMessage: raw => this.#onChannelMessage(raw, "proxy-control"),
      onOpen: channel => {
        waitTrace.event("A2.control-open", { connection: this.#signalSessionId }, this.#traceContext);
        this.#traceControlEnd?.({ outcome: "open" });
        this.#traceControlEnd = null;
        this.#controlChannel = channel;
        this.#announceViewer();
        this.#settleConnected(settle);
      },
      onClosed: (channel, error, opened) => {
        this.#rejectChannel(channel, error);
        if (this.#controlChannel === channel) this.#controlChannel = null;
        this.#probeSeen.delete("proxy-control");
        this.#probeSeenAt.delete("proxy-control");
        this.#controlCounters = {};
        this.#controlTransportIn = null;
        // Rebuild control independently. Requests already sent are rejected,
        // never replayed; a later request can retry connection establishment.
        if (opened && !this.#closedByUser && !this.#lostFired && this.isOpen) {
          void this.#controlLink.open().catch(err => {
            if (!this.#closedByUser && !this.#lostFired) console.warn("[dc-control] reconnect failed:", err);
          });
        }
      }
    });
    void this.#controlLink.open().then(() => this.#settleConnected(settle), error => settle(error));
  }

  #pendingOn(channel) {
    let count = 0;
    for (const entry of this.#pending.values()) if (entry.channel === channel) count++;
    return count;
  }

  #mediaPending() {
    return this.#controlLink ? this.#pendingOn(this.#channel) : this.#pending.size;
  }

  #rejectChannel(channel, error) {
    for (const [id, entry] of this.#pending) {
      if (entry.channel === channel) {
        this.#pending.delete(id);
        entry.reject(error);
      }
    }
  }

  /**
   * Handle an incoming data channel message.
   *
   * @param {string} raw
   */
  #onChannelMessage(raw, label = "proxy") {
    // How long this side spends handling one message. A page that has stopped
    // draining the channel is one of the two candidate causes of a delivery
    // freeze, and the proxy cannot see it at all; this is the reading that can.
    const handlerStartedAt = performance.now();
    if (this.#controlLink && label === "proxy-control") {
      this.#dispatchChannelMessage(raw, label);
      return;
    }
    // A delivery, whatever it carries: it ends any silence.
    this.#messagesHandled += 1;
    this.#lastArrivalAt = handlerStartedAt;
    if (this.#stalled) {
      this.#stalled = false;
      console.debug(`[dc-stall] delivery resumed on ${label} at=${new Date().toISOString()}`);
      try {
        this.onDeliveryResumed?.();
      } catch (error) {
        console.warn("[webrtc-proxy] onDeliveryResumed handler failed:", error);
      }
    }
    try {
      this.#dispatchChannelMessage(raw, label);
    } finally {
      const elapsed = performance.now() - handlerStartedAt;
      if (elapsed > this.#handlerMaxMs) {
        this.#handlerMaxMs = elapsed;
      }
      this.#armDeliveryCheck();
    }
  }

  /**
   * Count one probe number into this connection's rhythm, once, whichever
   * channel brought it first.
   *
   * @param {number} seq
   * @returns {void}
   */
  #countProbe(seq) {
    const at = performance.now();
    const previous = this.#lastCountedProbe;
    if (previous !== null && seq <= previous.seq) {
      return;
    }
    if (previous !== null) {
      this.#arrivalEstimate = noteProbeGap(this.#arrivalEstimate, at - previous.at);
    }
    this.#lastCountedProbe = { seq, at };
  }

  /**
   * Make sure one check of this connection's silence is pending, due when the
   * next delivery is overdue — or, once a stall has been called, when the
   * silence reaches the bound a request is given.
   *
   * Armed after every message and whenever a request starts waiting: a check
   * armed only by arrivals would never run after the last one. A check that
   * runs early, because something arrived after it was armed, only arms the
   * next one.
   *
   * @returns {void}
   */
  #armDeliveryCheck() {
    if (this.#deliveryCheck !== null || !this.#connected || this.#closedByUser) {
      return;
    }
    if (this.#mediaPending() === 0 && !this.#stalled) {
      return;
    }
    const silentMs = performance.now() - this.#lastArrivalAt;
    let waitMs;
    if (this.#stalled) {
      waitMs = TRANSPORT_SILENCE_WINDOW_MS - silentMs;
    } else {
      const due = deliveryDueWithinMs(this.#arrivalEstimate);
      if (due === null) {
        // No rhythm yet: the next probe arms this again.
        return;
      }
      waitMs = due - silentMs;
    }
    this.#deliveryCheck = setTimeout(() => {
      this.#deliveryCheck = null;
      void this.#checkDelivery();
    }, Math.max(0, waitMs) + 1);
  }

  /**
   * Read the silence, after asking the transport whether messages are already
   * received and only waiting to be handled — a timer that fires late finds
   * exactly those, and they are deliveries.
   *
   * @returns {Promise<void>}
   */
  async #checkDelivery() {
    if (!this.isOpen || this.#closedByUser) {
      return;
    }
    let received = null;
    try {
      const stats = await this.#pc?.getStats();
      stats?.forEach((report) => {
        if (report.type === "data-channel" && Number.isFinite(report.messagesReceived)) {
          received = (received ?? 0) + report.messagesReceived;
        }
      });
    } catch {
      // silent-ok: without the counter the check stands on the silence alone.
    }
    if (!this.isOpen || this.#closedByUser) {
      return;
    }
    const silentMs = performance.now() - this.#lastArrivalAt;
    const due = deliveryDueWithinMs(this.#arrivalEstimate);
    const verdict = silenceVerdict({
      silentMs,
      dueWithinMs: due,
      outstanding: this.#mediaPending(),
      channelOpen: this.isOpen,
      messagesWaiting: received !== null && received > this.#messagesHandled,
      stalledAlready: this.#stalled,
      requestTimeoutMs: TRANSPORT_SILENCE_WINDOW_MS
    });
    if (verdict.state === "lost") {
      console.warn(`[dc-stall] ${verdict.reason}; declaring the connection lost at=${new Date().toISOString()}`);
      this.#fireConnectionLost();
      return;
    }
    if (verdict.state === "stalled" && !this.#stalled) {
      this.#stalled = true;
      console.warn(
        `[dc-stall] ${verdict.reason}; ` +
          `state=${this.#pc?.connectionState} ice=${this.#pc?.iceConnectionState} ` +
          `probes=[${[...this.#probeSeen.entries()].map(([name, seq]) => `${name}:${seq}`).join(" ")}] ` +
          `received=${received ?? "?"} handled=${this.#messagesHandled} at=${new Date().toISOString()}`
      );
      try {
        this.onDeliveryStalled?.();
      } catch (error) {
        console.warn("[webrtc-proxy] onDeliveryStalled handler failed:", error);
      }
    }
    this.#armDeliveryCheck();
  }

  /**
   * Close this connection because another has taken its place.
   *
   * Every request still waiting on it is answered at once with
   * `TransportReplacedError` instead of sitting out its own timeout: a request
   * sent on a connection that stopped delivering will never be answered, and the
   * requests after the replacement go to the new one. A late answer on this
   * connection finds nothing to answer — its waits are gone.
   *
   * @returns {void}
   */
  retire() {
    const error = new Error("Data channel replaced by another connection.");
    error.name = "TransportReplacedError";
    const waiting = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of waiting) {
      entry.reject(error);
    }
    this.close();
  }

  /**
   * Handle an incoming data channel message.
   *
   * @param {string | ArrayBuffer} raw
   * @param {string} label - The channel it arrived on.
   */
  #dispatchChannelMessage(raw, label) {
    // Binary messages carry response body frames (see wire protocol). Control
    // messages (response-start/-error, pong) arrive as JSON strings.
    if (raw instanceof ArrayBuffer) {
      this.#onResponseBinaryChunk(new Uint8Array(raw));
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (error) {
      // Same rule as the signalling channel above: a frame dropped here is a
      // response nobody will ever match to its request, and the request then
      // waits out its whole timeout with no explanation.
      console.warn(
        `[torrent-tv][dc] a data-channel message could not be parsed (${error instanceof Error ? error.message : String(error)}): ` +
        `${String(raw).slice(0, 200)}`
      );
      return;
    }

    // Unsolicited — not a reply to any request this side made, so it is
    // dispatched before the requestId lookup below (which would find nothing
    // and drop it).
    if (msg.type === "chapters-changed") {
      try { this.onChaptersChanged?.(msg); } catch (error) { console.warn("[webrtc-proxy] chapter notification failed:", error); }
      return;
    }
    if (msg.type === "subtitle-cues") {
      try {
        this.onSubtitleCues?.({
          fileIndex: msg.fileIndex,
          trackIndex: msg.trackIndex,
          cues: Array.isArray(msg.cues) ? msg.cues : [],
          language: msg.language ?? "",
          detectedLanguage: msg.detectedLanguage ?? null,
          withdrawn: Array.isArray(msg.withdrawn) ? msg.withdrawn : [],
          cursor: Number.isFinite(msg.cursor) ? msg.cursor : null
        });
      } catch (error) {
        console.warn("[webrtc-proxy] onSubtitleCues handler failed:", error);
      }
      return;
    }

    // A numbered probe from the proxy. Recorded per channel; the echo timer
    // reports the highest number seen on each, and the gap between what the
    // proxy sent and what arrived here is what names the fault.
    if (msg.type === "probe") {
      if (Number.isInteger(msg.seq)) {
        if (!this.#controlLink || label !== "proxy-control") this.#countProbe(msg.seq);
        const previous = this.#probeSeen.get(label);
        if (previous === undefined || msg.seq > previous) {
          this.#probeSeen.set(label, msg.seq);
          // WHEN it arrived, on this machine's clock. With the time the proxy
          // stamped into the probe, this is the second of the four timestamps
          // that separate the two directions: without it the proxy can only
          // measure how old the newest probe it has HEARD ABOUT is, which
          // includes this page's own reporting cadence and the way back.
          this.#probeSeenAt.set(label, Date.now());
        }
      }
      return;
    }

    // Ping/pong RTT measurement.
    if (msg.type === "pong") {
      const entry = this.#pending.get(`ping:${msg.id}`);
      if (entry) {
        this.#pending.delete(`ping:${msg.id}`);
        entry.resolve(null);
      }
      return;
    }

    const entry = this.#pending.get(msg.requestId);
    if (!entry) return;

    if (msg.type === "response-start") {
      entry.status = msg.status ?? 200;
      entry.headers = msg.headers ?? {};
      return;
    }

    if (msg.type === "response-chunk") {
      // Legacy base64+JSON body path. Kept for backward compatibility with an
      // older proxy that has not yet switched to binary frames. Decode to bytes
      // immediately so chunks are uniformly Uint8Array regardless of transport.
      if (msg.data) {
        entry.firstByteAt ??= performance.now();
        entry.chunks.push(base64ToBytes(msg.data));
      }
      if (msg.done) {
        this.#pending.delete(msg.requestId);
        const finishedAt = performance.now();
        const waitMs = typeof entry.startedAt === "number"
          ? (entry.firstByteAt ?? finishedAt) - entry.startedAt
          : null;
        const transferMs = typeof entry.startedAt === "number"
          ? finishedAt - (entry.firstByteAt ?? finishedAt)
          : null;
        const totalBytes = entry.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        this.#logDataChannelLoad(entry, msg.requestId, totalBytes, waitMs, transferMs);
        // Split the same way as the binary path. Without it this path answered
        // "no timing", and the loader's fallback is the whole round trip — the
        // figure that counts an encoder's wait as the viewer's link speed.
        entry.resolve(this.#buildResponse(entry.status, entry.headers, entry.chunks, {
          waitMs,
          transferMs
        }));
      }
      return;
    }

    if (msg.type === "response-error") {
      this.#pending.delete(msg.requestId);
      entry.reject(new Error(msg.error ?? "Proxy data channel error."));
    }
  }

  /**
   * Handle a binary response body frame.
   * Layout: [flags(1)][idLen(1)][requestId(ASCII)][payload].
   *
   * @param {Uint8Array} bytes
   */
  #onResponseBinaryChunk(bytes) {
    if (bytes.length < 2) return;
    const flags = bytes[0];
    const idLen = bytes[1];
    if (bytes.length < 2 + idLen) return;
    const requestId = ASCII_DECODER.decode(bytes.subarray(2, 2 + idLen));
    const payload = bytes.subarray(2 + idLen);

    const entry = this.#pending.get(requestId);
    if (!entry) return;

    if (payload.length > 0) {
      // First body byte: everything before it is the proxy producing/reading
      // the response, everything after is transfer. Without the split a slow
      // response cannot be attributed to either side.
      if (entry.firstByteAt === undefined) {
        entry.firstByteAt = performance.now();
      }
      entry.chunks.push(payload);
    }
    if ((flags & 1) === 1) {
      this.#pending.delete(requestId);
      const finishedAt = performance.now();
      const totalBytes = entry.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const waitMs = typeof entry.startedAt === "number"
        ? (entry.firstByteAt ?? finishedAt) - entry.startedAt
        : null;
      const transferMs = typeof entry.startedAt === "number"
        ? finishedAt - (entry.firstByteAt ?? finishedAt)
        : null;
      this.#logDataChannelLoad(entry, requestId, totalBytes, waitMs, transferMs);
      entry.resolve(this.#buildResponse(entry.status, entry.headers, entry.chunks, { waitMs, transferMs }));
    }
  }

  #logDataChannelLoad(entry, requestId, totalBytes, waitMs, transferMs) {
    if (waitMs === null || transferMs === null) return;
    if (HELD_ANSWER_PATH.test(entry.path ?? "") || MEDIA_TRANSFER_PATH.test(entry.path ?? "")) {
      console.debug(`[dc-load] ${entry.path} requestId=${requestId} bytes=${totalBytes} ` +
        `waitMs=${waitMs.toFixed(0)} transferMs=${transferMs.toFixed(0)}`);
    } else if (totalBytes > 65536) {
      const mbps = transferMs > 0 ? (totalBytes * 8) / (transferMs * 1000) : 0;
      console.debug(`[dc-load] ${entry.path ?? "?"} requestId=${requestId} bytes=${totalBytes} ` +
        `waitMs=${waitMs.toFixed(0)} transferMs=${transferMs.toFixed(0)} ` +
        `chunks=${entry.chunks.length} rate=${mbps.toFixed(1)}Mbps`);
    }
  }

  /**
   * Assemble body byte chunks into a minimal Response-like object.
   *
   * Carries the two halves of the round trip. They must not be added together
   * and called a network measurement: `waitMs` is the proxy producing the
   * response — an encoder that has not reached this segment yet — and only
   * `transferMs` says anything about the link. Measured 2026-08-14: a segment
   * took 22 161 ms of which 21 951 ms was the proxy holding the file, and the
   * viewer's link was reported at 0.11 Mbit/s having just moved 8 MB at 38.
   *
   * @param {number} status
   * @param {object} headers
   * @param {Uint8Array[]} chunks
   * @param {{ waitMs: number | null, transferMs: number | null }} [timing]
   */
  #buildResponse(status, headers, chunks, timing) {
    const assemble = () => {
      const total = chunks.reduce((n, p) => n + p.length, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const p of chunks) { out.set(p, offset); offset += p.length; }
      return out;
    };

    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      waitMs: timing?.waitMs ?? null,
      transferMs: timing?.transferMs ?? null,
      arrayBuffer: async () => assemble().buffer,
      text: async () => new TextDecoder().decode(assemble()),
      json: async () => JSON.parse(new TextDecoder().decode(assemble()))
    };
  }

  /**
   * Send a request over the data channel and return a `Response`-like object.
   *
   * @param {string} path - Absolute path on the proxy, e.g. `"/api/sources"`.
   * @param {{ method?: string, headers?: object, body?: string | null, signal?: AbortSignal }} [options]
   *   Requests wait for a response, cancellation or connection loss. A healthy
   *   connection may legitimately wait while its proxy prepares media.
   * @returns {Promise<DataChannelResponse>}
   */
  async fetch(path, options = {}) {
    if (!this.isOpen) {
      return Promise.reject(new Error("Data channel is not open."));
    }

    const requestId = crypto.randomUUID();
    const url = new URL(path, "http://proxy");
    const signal = options.signal instanceof AbortSignal ? options.signal : null;
    const method = (options.method ?? "GET").toUpperCase();
    // Route large request bodies by their encoded size, not character count.
    const payload = options.body != null ? new TextEncoder().encode(options.body) : null;
    const largeBody = payload && payload.length > REQUEST_CHUNK_THRESHOLD_BYTES;
    const isMedia = isBulkPath(url.pathname, method) || largeBody;
    if (!isMedia && this.#controlLink) await this.#controlLink.wait(signal);
    if (!this.isOpen) throw new Error("Data channel is not open.");
    const channel = isMedia ? this.#channel : this.#controlChannelFor();

    // Keep settlement available if channel.send() throws.
    let pendingResolve;
    let pendingReject;
    const responsePromise = new Promise((resolve, reject) => {
      pendingResolve = resolve;
      pendingReject = reject;
    });

    // Remove the abort listener whichever event settles the request.
    let onAbort = null;
    const cleanup = () => {
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
        onAbort = null;
      }
    };

    // An already-aborted signal: reject without ever touching the channel.
    if (signal && signal.aborted) {
      const err = new Error("Data channel request aborted.");
      err.name = "AbortError";
      pendingReject(err);
      return responsePromise;
    }

    this.#pending.set(requestId, {
      resolve: (result) => { cleanup(); pendingResolve(result); },
      reject: (err) => { cleanup(); pendingReject(err); },
      chunks: [],
      status: 200,
      headers: {},
      // For the [dc-load] timing line: when the request left, and what it was
      // for. `firstByteAt` is filled when the first body byte arrives.
      startedAt: performance.now(),
      path,
      firstByteAt: undefined,
      channel
    });
    // Somebody is waiting now: a silence from here on means something.
    this.#armDeliveryCheck();

    if (signal) {
      onAbort = () => {
        this.#pending.delete(requestId);
        cleanup();
        try {
          channel.send(JSON.stringify({ type: "request-cancel", requestId }));
        } catch {
          // silent-ok: a closed connection already ends its outstanding proxy requests.
        }
        const err = new Error("Data channel request aborted.");
        err.name = "AbortError";
        pendingReject(err);
      };
      signal.addEventListener("abort", onAbort);
    }

    const reqPath = url.pathname;
    const query = url.search.slice(1);
    const headers = { ...(options.headers ?? {}) };

    if (!payload || payload.length <= REQUEST_CHUNK_THRESHOLD_BYTES) {
      // Legacy single message: small or bodyless requests, one send.
      try {
        channel.send(JSON.stringify({
          type: "request",
          requestId,
          method,
          path: reqPath,
          query,
          headers,
          body: options.body ?? null
        }));
        if (channel === this.#controlChannel) this.#controlLink?.noteRequest();
      } catch (err) {
        // channel.send() can throw if the channel transitions to closing/closed
        // between the isOpen check and the send.  Remove the pending entry, cancel
        // its listener, and convert to a rejected promise so callers always receive a
        // Promise, never a synchronous exception.
        this.#pending.delete(requestId);
        cleanup();
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
      return responsePromise;
    }

    // Large body: announce it, then stream binary frames with backpressure.
    // Errors reject through the pending entry (the response arrives normally).
    const frames = Math.ceil(payload.length / REQUEST_CHUNK_BYTES);
    console.debug(`[dc] request chunked ${method} ${reqPath} body=${payload.length}B frames=${frames}`);
    void this.#sendChunkedRequest({ requestId, method, path: reqPath, query, headers, payload, signal });

    return responsePromise;
  }

  /**
   * Which channel a request goes down.
   *
   * Media paths use the original association. Other requests use independent
   * control when supported; fetch waits for it to reconnect rather than sending
   * control back through a media queue. Only legacy proxies use that fallback.
   *
   * @returns {RTCDataChannel}
   */
  #controlChannelFor() {
    if (this.#controlLink) return this.#controlChannel;
    if (this.#controlChannel?.readyState !== "open") {
      return this.#channel;
    }
    return this.#controlChannel;
  }

  /**
   * Stream a large request body to the proxy as binary frames after a
   * `request-start` announcement (see fetch()). Applies backpressure via the
   * channel's buffered amount. On an aborted signal, sends one abort frame so
   * the proxy drops its partial state immediately (the signal listener in
   * fetch() rejects the promise). Send failures reject through the pending
   * entry.
   *
   * @param {{ requestId: string, method: string, path: string, query: string, headers: object, payload: Uint8Array, signal: AbortSignal | null }} params
   * @returns {Promise<void>}
   */
  async #sendChunkedRequest({ requestId, method, path, query, headers, payload, signal }) {
    const sendAbort = () => {
      try {
        this.#channel?.send(WebRtcProxy.#buildBodyFrame(2, requestId, null));
      } catch {
        // silent-ok: the abort frame tells the proxy to stop work we no longer
        // want, and a channel that has gone has stopped it anyway. Nothing is
        // left to say and nothing left to do.
      }
    };
    try {
      this.#channel.send(JSON.stringify({
        type: "request-start",
        requestId,
        method,
        path,
        query,
        headers,
        bodyBytes: payload.length
      }));
      for (let offset = 0; offset < payload.length; offset += REQUEST_CHUNK_BYTES) {
        if (signal?.aborted) {
          sendAbort();
          return;
        }
        await this.#waitForRequestBufferDrain();
        if (signal?.aborted) {
          sendAbort();
          return;
        }
        const end = Math.min(offset + REQUEST_CHUNK_BYTES, payload.length);
        const done = end >= payload.length;
        this.#channel.send(WebRtcProxy.#buildBodyFrame(done ? 1 : 0, requestId, payload.subarray(offset, end)));
      }
    } catch (err) {
      // Send failed mid-body (channel closing, etc.). Reject the pending entry
      // if it is still around (a channel-close may already have cleared it).
      const entry = this.#pending.get(requestId);
      if (entry) {
        this.#pending.delete(requestId);
        entry.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  /**
   * Resolve once the channel's outgoing buffer drains below the low-water
   * mark, so the chunked-body loop does not balloon the SCTP send buffer.
   * Resolves immediately when already below the high-water mark; a timeout
   * fallback guards against a missed `bufferedamountlow` event.
   *
   * @returns {Promise<void>}
   */
  #waitForRequestBufferDrain() {
    const channel = this.#channel;
    return new Promise((resolve) => {
      if (!channel || channel.bufferedAmount <= REQUEST_BUFFERED_HIGH_BYTES) {
        resolve();
        return;
      }
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        channel.removeEventListener("bufferedamountlow", done);
        resolve();
      };
      const timer = setTimeout(done, REQUEST_BUFFER_DRAIN_TIMEOUT_MS);
      channel.addEventListener("bufferedamountlow", done);
    });
  }

  /**
   * Build a request-body frame: `[flags(1)][idLen(1)][requestId(ASCII)][payload]`.
   * Mirrors the response-frame layout the proxy already uses; flags bit 0 =
   * done (last frame), bit 1 = aborted.
   *
   * @param {number} flags
   * @param {string} requestId
   * @param {Uint8Array | null} chunk
   * @returns {ArrayBuffer}
   */
  static #buildBodyFrame(flags, requestId, chunk) {
    const idBytes = new TextEncoder().encode(requestId);
    const payloadLen = chunk ? chunk.length : 0;
    const frame = new Uint8Array(2 + idBytes.length + payloadLen);
    frame[0] = flags;
    frame[1] = idBytes.length;
    frame.set(idBytes, 2);
    if (payloadLen > 0) {
      frame.set(chunk, 2 + idBytes.length);
    }
    return frame.buffer;
  }

  /**
   * Measure the round-trip time to the proxy over the data channel.
   *
   * @returns {Promise<number>} RTT in milliseconds.
   */
  async ping() {
    const endTrace = waitTrace.open("A2.3.ping", {}, this.#traceContext);
    if (!this.isOpen) {
      const error = new Error("Data channel is not open.");
      endTrace({ outcome: "error", error: error.message });
      throw error;
    }
    try {
      if (this.#controlLink) await this.#controlLink.wait();
      if (!this.isOpen) throw new Error("Data channel is not open.");
      const channel = this.#controlChannelFor();

    const id = crypto.randomUUID();
    const sentAt = performance.now();

    const rttPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(`ping:${id}`);
        reject(new Error("Ping timed out."));
      }, PING_TIMEOUT_MS);

      this.#pending.set(`ping:${id}`, {
        resolve: () => {
          clearTimeout(timer);
          const roundTripMs = Math.round(performance.now() - sentAt);
          this.#lastRoundTripMs = roundTripMs;
          resolve(roundTripMs);
        },
        reject: (err) => { clearTimeout(timer); reject(err); },
        chunks: [],
        status: 0,
        headers: {},
        channel
      });
    });

      try {
        channel.send(JSON.stringify({ type: "ping", id }));
        if (channel === this.#controlChannel) this.#controlLink?.noteRequest();
      } catch (error) {
        const entry = this.#pending.get(`ping:${id}`);
        this.#pending.delete(`ping:${id}`);
        entry?.reject(error);
      }
      const rtt = await rttPromise;
      endTrace({ outcome: "pong", rttMs: rtt });
      return rtt;
    } catch (error) {
      endTrace({ outcome: error?.name === "AbortError" ? "cancelled" : "error",
        error: String(error?.message ?? error) });
      throw error;
    }
  }

  /**
   * Name the person watching over this connection.
   *
   * Called once by whoever owns the page's consumer id, and remembered, so that
   * every control channel opened afterwards — including the ones the reconnect
   * ladder opens under a player that never stopped — says the same name again.
   *
   * @param {string} consumerId
   * @returns {void}
   */
  identifyViewer(consumerId) {
    if (typeof consumerId !== "string" || consumerId.length === 0) {
      return;
    }
    if (this.#viewerName === consumerId) {
      return;
    }
    this.#viewerName = consumerId;
    this.#announceViewer();
  }

  /**
   * Send the name, if there is one and there is somewhere to send it.
   *
   * Silent when the control channel is not open: the open handler sends it, so
   * announcing before the channel exists is not a loss.
   *
   * @returns {void}
   */
  #announceViewer() {
    if (!this.#viewerName) return;
    // The existing presence relation permits multiple live connections for one
    // viewer. Name both associations; only losing the last releases the viewer.
    const channels = this.#controlLink ? [this.#channel, this.#controlChannel] : [this.#controlChannel];
    for (const channel of channels) {
      if (channel?.readyState !== "open") continue;
      try {
        channel.send(JSON.stringify({ type: "viewer", consumerId: this.#viewerName }));
      } catch (error) {
        console.debug(`[dc] could not name the viewer: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Extract the host address from a raw ICE candidate string.
   * Handles both "candidate:..." and "a=candidate:..." prefixes.
   * Format: <prefix> <component> <transport> <priority> <address> <port> typ <type>
   *
   * @param {string} candidate
   * @returns {string | null}
   */
  static #extractCandidateIp(candidate) {
    const parts = candidate.split(" ");
    return parts.length >= 6 ? parts[4] : null;
  }

  /**
   * Return true for private IPv4 addresses (RFC 1918). Used to classify a
   * candidate's scope in the diagnostic log.
   *
   * @param {string} ip
   * @returns {boolean}
   */
  static #isPrivateIpv4(ip) {
    return /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(ip);
  }

  /**
   * Return true for any LOCAL (non-internet-routable) address: private IPv4,
   * IPv4 link-local, IPv6 ULA (fc00::/7), IPv6 link-local (fe80::/10), and
   * loopback. Chromium's local-network permission applies to these; global
   * IPv4/IPv6 addresses pass without it.
   *
   * @param {string} ip
   * @returns {boolean}
   */
  static #isLocalAddress(ip) {
    if (ip.includes(":")) {
      return /^(f[cd]|fe[89ab])/i.test(ip) || ip === "::1";
    }
    return WebRtcProxy.#isPrivateIpv4(ip) || ip.startsWith("169.254.") || ip.startsWith("127.");
  }

  /**
   * Compact, privacy-safe summary of an ICE candidate for diagnostics:
   * `type/protocol/scope` (no raw IP). Scope = v4-private | v4-public | v6.
   *
   * @param {string | undefined | null} candidateStr
   * @returns {string}
   */
  static #describeCandidate(candidateStr) {
    if (typeof candidateStr !== "string" || candidateStr.length === 0) {
      return "(end-of-candidates)";
    }
    const typ = candidateStr.match(/ typ (\w+)/)?.[1] ?? "?";
    const parts = candidateStr.split(" ");
    const proto = parts.length >= 3 ? parts[2] : "?";
    const ip = WebRtcProxy.#extractCandidateIp(candidateStr);
    let scope = "?";
    if (ip) {
      scope = ip.includes(":") ? "v6" : WebRtcProxy.#isPrivateIpv4(ip) ? "v4-private" : "v4-public";
    }
    return `${typ}/${proto}/${scope}`;
  }

  /**
   * Log the nominated/succeeded ICE candidate pair (types + protocols) once the
   * connection settles, so the winning path (or the absence of one) is visible
   * in the field logs. Diagnostics only.
   *
   * @returns {Promise<void>}
   */
  async #logSelectedPair() {
    if (!this.#pc) {
      return;
    }
    try {
      const stats = await this.#pc.getStats();
      const byId = new Map();
      stats.forEach((r) => byId.set(r.id, r));
      let logged = false;
      stats.forEach((r) => {
        if (r.type === "candidate-pair" && (r.nominated || r.state === "succeeded")) {
          const l = byId.get(r.localCandidateId);
          const rem = byId.get(r.remoteCandidateId);
          console.debug(
            `[ice] pair state=${r.state} nominated=${r.nominated} ` +
              `local=${l?.candidateType ?? "?"}/${l?.protocol ?? "?"} ` +
              `remote=${rem?.candidateType ?? "?"}/${rem?.protocol ?? "?"}`
          );
          logged = true;
        }
      });
      if (!logged) {
        console.debug("[ice] no nominated/succeeded candidate pair");
      }
    } catch (e) {
      console.debug(`[ice] getStats failed: ${e instanceof Error ? e.name : e}`);
    }
  }

  /**
   * Write the transport's own counters to the log, for as long as the
   * connection lives.
   *
   * This side had none. The proxy could say how much it handed to its
   * transport; nothing said how much arrived here, and without both numbers a
   * loss cannot be placed. Field 2026-08-06: the proxy reported a 9.26 MB
   * segment fully sent at 274 Mbit/s with an empty send queue, the browser
   * never saw it, and everything sent afterwards vanished the same way while
   * requests in the other direction kept working. Whether those bytes reached
   * this machine at all decides between three quite different faults — lost on
   * the path, never actually transmitted, or received but not delivered by
   * SCTP — and only this counter can tell them apart.
   *
   * @returns {void}
   */
  #startTransportSampling() {
    this.#stopTransportSampling();
    this.#startProbeEcho();
    let previous = null;
    this.#transportSampler = window.setInterval(() => {
      if (!this.#pc) {
        return;
      }
      const controlPc = this.#controlLink?.peer;
      if (controlPc) void controlPc.getStats().then(stats => {
        if (this.#controlLink?.peer !== controlPc) return;
        let transport = null;
        const channels = {};
        stats.forEach(report => {
          if (report.type === "transport") transport = report;
          if (report.type === "data-channel") channels[report.label ?? "?"] = {
            messages: report.messagesReceived ?? null, bytes: report.bytesReceived ?? null
          };
        });
        this.#controlCounters = channels;
        this.#controlTransportIn = transport?.bytesReceived ?? null;
        console.debug(`[dc-control-transport] session=${this.#controlLink.signalSessionId} connectionId=${this.#controlLink.connectionId} ` +
          `received=${this.#controlTransportIn ?? "?"} sent=${transport?.bytesSent ?? "?"} ` +
          `state=${controlPc.connectionState} channels=${JSON.stringify(channels)} at=${new Date().toISOString()}`);
      }).catch(() => {});
      void this.#pc.getStats().then((stats) => {
        let transport = null;
        let pair = null;
        let channel = null;
        /** @type {Record<string, { messages: number | null, bytes: number | null }>} */
        const channels = {};
        stats.forEach((report) => {
          if (report.type === "transport") {
            transport = report;
          } else if (report.type === "candidate-pair" && (report.nominated || report.state === "succeeded")) {
            pair = report;
          } else if (report.type === "data-channel") {
            // Every channel, not just the media one. Two of the three are
            // ordered and one is not, and the whole point of the comparison is
            // lost if only one is counted.
            channels[report.label ?? "?"] = {
              messages: report.messagesReceived ?? null,
              bytes: report.bytesReceived ?? null
            };
            if (report.label === "proxy") {
              channel = report;
            }
          }
        });
        const received = transport?.bytesReceived ?? pair?.bytesReceived ?? null;
        const sent = transport?.bytesSent ?? pair?.bytesSent ?? null;
        const delta = previous !== null && received !== null ? received - previous : null;
        previous = received;
        this.#lastTransportIn = received;
        this.#lastChannelCounters = channels;
        const perChannel = Object.entries(channels)
          .map(([name, counters]) => `${name}=${counters.messages ?? "?"}msg/${counters.bytes ?? "?"}B`)
          .join(" ");
        console.debug(
          `[dc-transport] received=${received ?? "?"}${delta === null ? "" : ` (+${delta})`} ` +
            `sent=${sent ?? "?"} chMsgs=${channel?.messagesReceived ?? "?"} ` +
            `chBytes=${channel?.bytesReceived ?? "?"} state=${this.#pc.connectionState} ` +
            `ice=${this.#pc.iceConnectionState} rtt=${
              pair?.currentRoundTripTime === undefined
                ? "?"
                : Math.round(pair.currentRoundTripTime * 1000)
            }ms pair=${pair?.state ?? "?"} ` +
            // Everything below is the receiving end's own account of itself:
            // the two candidate causes of a freeze differ here and nowhere else.
            `visibility=${typeof document === "undefined" ? "?" : document.visibilityState} ` +
            `loopLag=${Math.round(this.#loopLagMs)}ms handlerMax=${Math.round(this.#handlerMaxMs * 10) / 10}ms ` +
            `pending=${this.#pending.size} probes=[${[...this.#probeSeen.entries()].map(([name, seq]) => `${name}:${seq}`).join(" ")}] ` +
            `${perChannel} at=${new Date().toISOString()}`
        );
      }).catch(() => {});
    }, TRANSPORT_SAMPLE_MS);
  }

  /**
   * Report to the proxy what has arrived here, twice a second.
   *
   * Two things travel: the highest probe number seen on each channel, which is
   * what the proxy turns into a per-channel gap, and what this side can see of
   * its own receiving — whether the tab is hidden, how late the event loop is
   * running, how long the channel's own message handler took, and the counters
   * the transport keeps. The last group is what separates "the sender stopped"
   * from "this page stopped draining and the window closed", which is the
   * question the field episodes could not answer because only the sender was
   * ever read.
   *
   * @returns {void}
   */
  #startProbeEcho() {
    this.#stopProbeEcho();
    this.#loopLagTimer = window.setInterval(() => {
      const expectedAt = this.#loopLagExpectedAt;
      const now = performance.now();
      if (typeof expectedAt === "number") {
        const lag = now - expectedAt;
        this.#loopLagMs = lag > 0 ? lag : 0;
      }
      this.#loopLagExpectedAt = now + LOOP_LAG_PROBE_MS;
    }, LOOP_LAG_PROBE_MS);

    this.#probeEchoTimer = window.setInterval(() => {
      const mediaChannel =
        this.#channel?.readyState === "open"
          ? this.#channel
          : !this.#controlLink && this.#controlChannel?.readyState === "open"
            ? this.#controlChannel
            : null;
      const handlerMaxMs = Math.round(this.#handlerMaxMs * 10) / 10;
      this.#handlerMaxMs = 0;
      const reports = this.#controlLink
        ? [[mediaChannel, false], [this.#controlChannel, true]]
        : [[mediaChannel, false]];
      for (const [channel, control] of reports) {
        if (channel?.readyState !== "open") continue;
        const belongs = ([label]) => !this.#controlLink || (label === "proxy-control") === control;
        try {
          channel.send(
            JSON.stringify({
              type: "probe-echo",
              seen: Object.fromEntries([...this.#probeSeen].filter(belongs)),
              // Both timestamps use this machine's clock; the proxy estimates
              // the offset rather than assuming the clocks agree.
              seenAt: Object.fromEntries([...this.#probeSeenAt].filter(belongs)),
              sentAt: Date.now(),
              report: {
                visibility: typeof document === "undefined" ? "?" : document.visibilityState,
                loopLagMs: Math.round(this.#loopLagMs),
                handlerMaxMs,
                transportBytesReceived: control ? this.#controlTransportIn : this.#lastTransportIn,
                channels: control ? this.#controlCounters : this.#lastChannelCounters,
                pending: this.#controlLink ? this.#pendingOn(channel) : this.#pending.size
              }
            })
          );
        } catch {
          // silent-ok: a closed channel stops reporting; the proxy observes that silence.
        }
      }
    }, PROBE_ECHO_MS);
  }

  /** @returns {void} */
  #stopProbeEcho() {
    if (this.#probeEchoTimer !== null) {
      window.clearInterval(this.#probeEchoTimer);
      this.#probeEchoTimer = null;
    }
    if (this.#loopLagTimer !== null) {
      window.clearInterval(this.#loopLagTimer);
      this.#loopLagTimer = null;
    }
  }

  /** @returns {void} */
  #stopTransportSampling() {
    this.#stopProbeEcho();
    if (this.#transportSampler !== null) {
      window.clearInterval(this.#transportSampler);
      this.#transportSampler = null;
    }
  }

  /**
   * Close the data channel, peer connection, and signalling WebSocket.
   */
  close() {
    // Deliberate close — must not be reported as a lost connection.
    this.#closedByUser = true;
    if (this.#deliveryCheck !== null) {
      clearTimeout(this.#deliveryCheck);
      this.#deliveryCheck = null;
    }
    this.#connectSettler?.(new DOMException("Proxy connection was cancelled.", "AbortError"));
    for (const entry of this.#pending.values()) {
      entry.reject(new DOMException("Proxy connection closed.", "AbortError"));
    }
    this.#pending.clear();
    this.#ws?.close();
    this.#controlLink?.close();
    this.#controlChannel?.close();
    this.#controlChannel = null;
    this.#fastChannel?.close();
    this.#fastChannel = null;
    this.#stopTransportSampling();
    this.#channel?.close();
    this.#pc?.close();
    this.#ws = null;
    this.#channel = null;
    this.#pc = null;
  }
}
