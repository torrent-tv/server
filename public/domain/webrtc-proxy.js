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
 * 7. Once the data channel opens, `connect()` resolves.
 * 8. All subsequent communication uses `fetch()` / `ping()` on the channel.
 */

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
/**
 * How long the media channel may deliver nothing, while requests are waiting on
 * it and the connection reports itself healthy, before this is a wedge.
 *
 * Fifteen seconds is far longer than any segment takes to arrive on a working
 * link (measured: 6-11 MB in well under a second on the LAN, tens of seconds at
 * the worst cellular rates) and far shorter than the 48 and 88 minute episodes
 * it exists to catch. It only starts a READING, never a recovery, so a false
 * positive costs one test connection and a log line.
 */
const DELIVERY_WEDGE_AFTER_MS = 15_000;
/** How many bytes the second association is asked to carry to prove itself. */
const SECOND_ASSOCIATION_BYTES = 4 * 1024 * 1024;

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
const CONNECT_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 60_000;
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
const REQUEST_BUFFERED_LOW_BYTES = 256 * 1024; // resume once drained to this
const REQUEST_BUFFER_DRAIN_TIMEOUT_MS = 5_000; // fallback so a missed drain event cannot deadlock

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
   * A second channel carrying only small control messages.
   *
   * One channel used to carry both. SCTP delivers an ordered stream in order,
   * so a 300-byte seek written after an 8 MB segment waits for that segment to
   * finish going out. On a fast link that costs nothing — measured on the LAN
   * 2026-08-05, control responses left in 1-4 ms while 6-11 MB segments were
   * being pushed and the send buffer never accumulated — but on the 1-5.8
   * Mbit/s measured on cellular one segment takes 11-64 s to push, and the
   * proxy would learn about a seek that much later. That is the same failure
   * the supersede fix (proxy 2.9.89) exists to prevent, one layer down.
   *
   * Null until it opens, and it may never open: a browser meets proxies older
   * than itself, and those accept one channel only. Everything falls back to
   * {@link #channel} in that case, which is exactly today's behaviour.
   *
   * Reasoning, measurements and the staging: research/control-channel-2026-08-05.md
   */
  #controlChannel = null;
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
  /** Messages delivered to this page on the media channel at the last sample. */
  #lastChannelMessages = null;
  /** When the media channel last delivered a message, or 0 while none is expected. */
  #lastDeliveryAt = 0;
  /** True while a wedge is being reported, so the second-association test runs once per episode. */
  #wedgeReported = false;
  /** True while this connection IS the second-association test, so a test cannot spawn a test. */
  #isDiagnosticProbe = false;
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
  /** @type {boolean} True when close() was called by the app itself. */
  #closedByUser = false;
  /** @type {boolean} Guards onConnectionLost against double-firing. */
  #lostFired = false;
  /** @type {string | null} Signalling session id assigned by the server (== the proxy's `[webrtc] Session <id>`). */
  #signalSessionId = null;

  /**
   * Called once when an ESTABLISHED connection is lost (data channel closed
   * or the peer connection failed) and the loss was not initiated by our own
   * close(). Assign a handler to react to mid-playback proxy loss.
   *
   * @type {(() => void) | null}
   */
  onConnectionLost = null;

  /**
   * Called on every unsolicited `subtitle-cues` push from the proxy — new
   * cues for one track, found off the proxy's own download rather than in
   * answer to a request this side made. Assign a handler to receive them.
   *
   * @type {((event: { fileIndex: number, trackIndex: number, cues: object[], language: string, cursor: number | null }) => void) | null}
   */
  onSubtitleCues = null;

  /** Fire onConnectionLost once, only for losses of an established connection. */
  #fireConnectionLost() {
    if (!this.#connected || this.#closedByUser || this.#lostFired) {
      return;
    }
    this.#lostFired = true;
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
   * @returns {Promise<void>}
   */
  async connect(timeoutMs = CONNECT_TIMEOUT_MS) {
    const wsUrl = `${location.protocol.replace("http", "ws")}//${location.host}/ws/browser-signal`;
    this.#ws = new WebSocket(wsUrl);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#ws?.close();
        reject(new Error("WebRTC connection timed out."));
      }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : CONNECT_TIMEOUT_MS);

      // Store settler so the data channel open / error events can resolve/reject the outer promise.
      let settled = false;
      const settle = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve();
      };

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

    if (msg.type === "session") {
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
      try {
        await this.#pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
        this.#remoteDescriptionSet = true;
        // Drain buffered candidates so ICE checking can start.
        for (const c of this.#pendingCandidates) {
          await this.#pc.addIceCandidate(c).catch(() => {});
        }
        this.#pendingCandidates = [];
      } catch (err) {
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
      try {
        await this.#pc.addIceCandidate(c);
      } catch (error) {
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
    this.#pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.#channel = this.#pc.createDataChannel("proxy", { ordered: true });
    // Reliable and ordered like the other one: an unreliable control channel
    // could drop a seek, and a dropped seek is worse than a late one.
    this.#controlChannel = this.#pc.createDataChannel("proxy-control", { ordered: true });
    this.#controlChannel.binaryType = "arraybuffer";
    this.#controlChannel.addEventListener("message", (event) => {
      this.#onChannelMessage(event.data, "proxy-control");
    });
    this.#controlChannel.addEventListener("error", () => {
      // Never fatal: the request simply goes down the media channel instead.
      console.debug("[dc] control channel error — falling back to the single channel");
      this.#controlChannel = null;
    });
    this.#controlChannel.addEventListener("close", () => {
      this.#controlChannel = null;
    });

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
      this.#connected = true;
      settle();
    });

    this.#channel.addEventListener("error", (event) => {
      settle(new Error(`Data channel error: ${event.message ?? "unknown"}`));
    });

    this.#channel.addEventListener("message", (event) => {
      this.#onChannelMessage(event.data, "proxy");
    });

    this.#channel.addEventListener("close", () => {
      for (const entry of this.#pending.values()) {
        entry.reject(new Error("Data channel closed."));
      }
      this.#pending.clear();
      this.#fireConnectionLost();
    });

    this.#pc.addEventListener("icecandidate", (event) => {
      console.debug(`[ice] local ${WebRtcProxy.#describeCandidate(event.candidate?.candidate)}`);
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

    const offer = await this.#pc.createOffer();
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
    try {
      this.#dispatchChannelMessage(raw, label);
    } finally {
      const elapsed = performance.now() - handlerStartedAt;
      if (elapsed > this.#handlerMaxMs) {
        this.#handlerMaxMs = elapsed;
      }
    }
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
    if (msg.type === "subtitle-cues") {
      try {
        this.onSubtitleCues?.({
          fileIndex: msg.fileIndex,
          trackIndex: msg.trackIndex,
          cues: Array.isArray(msg.cues) ? msg.cues : [],
          language: msg.language ?? "",
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
        const previous = this.#probeSeen.get(label);
        if (previous === undefined || msg.seq > previous) {
          this.#probeSeen.set(label, msg.seq);
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
        // Split the same way as the binary path. Without it this path answered
        // "no timing", and the loader's fallback is the whole round trip — the
        // figure that counts an encoder's wait as the viewer's link speed.
        entry.resolve(this.#buildResponse(entry.status, entry.headers, entry.chunks, {
          waitMs: typeof entry.startedAt === "number" ? (entry.firstByteAt ?? finishedAt) - entry.startedAt : null,
          transferMs: typeof entry.startedAt === "number" ? finishedAt - (entry.firstByteAt ?? finishedAt) : null
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
      // Only worth reporting for real payloads; status-only replies are noise.
      if (totalBytes > 65536 && waitMs !== null && transferMs !== null) {
        const mbps = transferMs > 0 ? (totalBytes * 8) / (transferMs * 1000) : 0;
        console.debug(
          `[dc-recv] ${entry.path ?? "?"} bytes=${totalBytes} ` +
            `waitMs=${waitMs.toFixed(0)} transferMs=${transferMs.toFixed(0)} ` +
            `chunks=${entry.chunks.length} rate=${mbps.toFixed(1)}Mbps`
        );
      }
      entry.resolve(this.#buildResponse(entry.status, entry.headers, entry.chunks, { waitMs, transferMs }));
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
   * @param {{ method?: string, headers?: object, body?: string | null, signal?: AbortSignal, timeoutMs?: number }} [options]
   *   Fetch options.  When `signal` aborts, the pending request is dropped and
   *   the promise rejects immediately with an `AbortError` (so a cancelled or
   *   superseded flow does not sit until `timeoutMs`, then reject and surface a
   *   stale error). `timeoutMs` (default `REQUEST_TIMEOUT_MS`) still bounds a
   *   channel that never responds; long-running responses (e.g.
   *   embedded-subtitle extraction) pass a larger value.
   * @returns {Promise<DataChannelResponse>}
   */
  fetch(path, options = {}) {
    if (!this.isOpen) {
      return Promise.reject(new Error("Data channel is not open."));
    }

    const requestId = crypto.randomUUID();
    const url = new URL(path, "http://proxy");
    const timeoutMs =
      Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : REQUEST_TIMEOUT_MS;
    const signal = options.signal instanceof AbortSignal ? options.signal : null;

    // Hoist resolve/reject so we can cancel the timeout if channel.send() throws.
    let pendingResolve;
    let pendingReject;
    const responsePromise = new Promise((resolve, reject) => {
      pendingResolve = resolve;
      pendingReject = reject;
    });

    // Tear down the timer and the abort listener exactly once, whichever path
    // (response / timeout / abort / send-throw) settles the promise first.
    let timer = null;
    let onAbort = null;
    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
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

    timer = setTimeout(() => {
      this.#pending.delete(requestId);
      cleanup();
      pendingReject(new Error("Data channel request timed out."));
    }, timeoutMs);

    this.#pending.set(requestId, {
      resolve: (result) => { cleanup(); pendingResolve(result); },
      reject: (err) => { cleanup(); pendingReject(err); },
      chunks: [],
      status: 200,
      headers: {},
      // For the [dc-recv] timing line: when the request left, and what it was
      // for. `firstByteAt` is filled when the first body byte arrives.
      startedAt: performance.now(),
      path,
      firstByteAt: undefined
    });

    if (signal) {
      onAbort = () => {
        this.#pending.delete(requestId);
        cleanup();
        const err = new Error("Data channel request aborted.");
        err.name = "AbortError";
        pendingReject(err);
      };
      signal.addEventListener("abort", onAbort);
    }

    const method = options.method ?? "GET";
    const reqPath = url.pathname;
    const query = url.search.slice(1);
    const headers = options.headers ?? {};
    // Measure the body in UTF-8 bytes (what the proxy reassembles), not string
    // length — a body may contain multi-byte characters.
    const payload = options.body != null ? new TextEncoder().encode(options.body) : null;

    if (!payload || payload.length <= REQUEST_CHUNK_THRESHOLD_BYTES) {
      // Legacy single message: small or bodyless requests, one send.
      try {
        this.#channelFor(reqPath).send(JSON.stringify({
          type: "request",
          requestId,
          method,
          path: reqPath,
          query,
          headers,
          body: options.body ?? null
        }));
      } catch (err) {
        // channel.send() can throw if the channel transitions to closing/closed
        // between the isOpen check and the send.  Remove the pending entry, cancel
        // the timer, and convert to a rejected promise so callers always receive a
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
   * Media bodies keep the original channel; everything else — seek, session
   * create and release, progress, stats, the link report — goes down the
   * control channel when it is open. SCTP delivers one stream in order, so a
   * 300-byte seek written after an 8 MB segment waits for that segment to
   * finish; on the 1-5.8 Mbit/s measured on cellular that is 11-64 s, and the
   * proxy learns about the seek that much later.
   *
   * Falls back to the single channel whenever the control one is not open,
   * which is what happens against a proxy older than this browser.
   *
   * @param {string} requestPath
   * @returns {RTCDataChannel}
   */
  #channelFor(requestPath) {
    const isMedia = requestPath.startsWith("/transcode/") || requestPath.startsWith("/stream");
    if (isMedia || this.#controlChannel?.readyState !== "open") {
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
  ping() {
    if (!this.isOpen) {
      return Promise.reject(new Error("Data channel is not open."));
    }

    const id = crypto.randomUUID();
    const sentAt = performance.now();

    const rttPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(`ping:${id}`);
        reject(new Error("Ping timed out."));
      }, PING_TIMEOUT_MS);

      this.#pending.set(`ping:${id}`, {
        resolve: () => { clearTimeout(timer); resolve(Math.round(performance.now() - sentAt)); },
        reject: (err) => { clearTimeout(timer); reject(err); },
        chunks: [],
        status: 0,
        headers: {}
      });
    });

    this.#channel.send(JSON.stringify({ type: "ping", id }));
    return rttPromise;
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
        this.#considerWedge(channel?.messagesReceived ?? null);
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
      const channel =
        this.#channel?.readyState === "open"
          ? this.#channel
          : this.#controlChannel?.readyState === "open"
            ? this.#controlChannel
            : null;
      if (!channel) {
        return;
      }
      const handlerMaxMs = Math.round(this.#handlerMaxMs * 10) / 10;
      this.#handlerMaxMs = 0;
      try {
        channel.send(
          JSON.stringify({
            type: "probe-echo",
            seen: Object.fromEntries(this.#probeSeen),
            report: {
              visibility: typeof document === "undefined" ? "?" : document.visibilityState,
              loopLagMs: Math.round(this.#loopLagMs),
              handlerMaxMs,
              transportBytesReceived: this.#lastTransportIn,
              channels: this.#lastChannelCounters,
              pending: this.#pending.size
            }
          })
        );
      } catch {
        // silent-ok: a channel that will not take a 200-byte message is itself
        // the answer, and the proxy reads it — the echo simply stops arriving.
      }
    }, PROBE_ECHO_MS);
  }

  /**
   * Decide whether this connection has stopped delivering, and if so, take the
   * one reading that cannot be taken afterwards.
   *
   * The state being looked for is precise: requests are outstanding, the peer
   * connection reports itself connected, and not one complete message has been
   * handed to this page since the last sample. That is the field signature —
   * every layer reporting success while nothing arrives.
   *
   * What it then does is NOT a recovery. It raises a SECOND association to the
   * same proxy and asks it to carry a few megabytes. If they arrive, the fault
   * is held in the wedged association's own state, and rotating connections
   * would cure it; if the second association stalls the same way, the fault is
   * in the path or at this end, and rotating would not. Nothing else separates
   * those two, and neither can be established once the session is gone.
   *
   * @param {number | null} messagesReceived
   * @returns {void}
   */
  #considerWedge(messagesReceived) {
    if (this.#isDiagnosticProbe) {
      return;
    }
    const now = Date.now();
    const delivered =
      messagesReceived === null ||
      this.#lastChannelMessages === null ||
      messagesReceived > this.#lastChannelMessages;
    this.#lastChannelMessages = messagesReceived;
    if (delivered || this.#pending.size === 0) {
      this.#lastDeliveryAt = now;
      this.#wedgeReported = false;
      return;
    }
    if (this.#lastDeliveryAt === 0) {
      this.#lastDeliveryAt = now;
      return;
    }
    const stalledMs = now - this.#lastDeliveryAt;
    if (stalledMs < DELIVERY_WEDGE_AFTER_MS || this.#wedgeReported) {
      return;
    }
    this.#wedgeReported = true;
    console.warn(
      `[dc-wedge] nothing delivered for ${stalledMs}ms with ${this.#pending.size} request(s) waiting; ` +
      `state=${this.#pc?.connectionState} ice=${this.#pc?.iceConnectionState} ` +
      `probes=[${[...this.#probeSeen.entries()].map(([name, seq]) => `${name}:${seq}`).join(" ")}] ` +
      `at=${new Date(now).toISOString()}`
    );
    void this.#runSecondAssociationTest();
  }

  /**
   * Raise a second association to the same proxy and try to carry bytes over it.
   *
   * Best-effort and self-contained: it never touches this connection, never
   * becomes the transport, and closes itself whatever happens. The only output
   * is the log line.
   *
   * @returns {Promise<void>}
   */
  async #runSecondAssociationTest() {
    const startedAt = performance.now();
    let probe = null;
    try {
      probe = new WebRtcProxy(this.#proxyId, this.#proxyLocalPort, this.#allowPrivateCandidates);
      probe.#isDiagnosticProbe = true;
      await probe.connect();
      const connectedMs = Math.round(performance.now() - startedAt);
      const response = await probe.fetch(`/api/delivery-sink?bytes=${SECOND_ASSOCIATION_BYTES}`);
      const body = await response.arrayBuffer();
      const totalMs = Math.round(performance.now() - startedAt);
      console.warn(
        `[dc-wedge] second association carried ${body.byteLength}B of ${SECOND_ASSOCIATION_BYTES} ` +
        `status=${response.status} connect=${connectedMs}ms total=${totalMs}ms — ` +
        `${body.byteLength === SECOND_ASSOCIATION_BYTES
          ? "the fault is held in the wedged association"
          : "a fresh association fails too: the path or this end"}`
      );
    } catch (error) {
      console.warn(
        `[dc-wedge] second association failed after ${Math.round(performance.now() - startedAt)}ms: ` +
        `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`
      );
    } finally {
      try {
        probe?.close();
      } catch {
        // silent-ok: closing a connection that never opened changes nothing and
        // leaves nothing undone.
      }
    }
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
    this.#ws?.close();
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
