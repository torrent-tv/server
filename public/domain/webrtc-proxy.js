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
  /** @type {WebSocket | null} */
  #ws = null;
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
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "session") {
      // Record the session id and hand it to the log forwarder so browser
      // logs can be joined to the proxy's `[webrtc] Session <id>` lines.
      this.#signalSessionId = typeof msg.sessionId === "string" ? msg.sessionId : null;
      if (this.#signalSessionId) {
        console.debug(`[ice] signalling session ${this.#signalSessionId}`);
        try {
          window.__ttvClientLogger?.setSignalSession?.(this.#signalSessionId);
        } catch {
          // Log forwarder is a debugging aid — never let it break signalling.
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
      } catch {
        // Stale or duplicate candidate — safe to ignore.
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
    // Response bodies arrive as binary frames; receive them as ArrayBuffer
    // rather than Blob so they can be parsed synchronously.
    this.#channel.binaryType = "arraybuffer";

    this.#channel.addEventListener("open", () => {
      this.#connected = true;
      settle();
    });

    this.#channel.addEventListener("error", (event) => {
      settle(new Error(`Data channel error: ${event.message ?? "unknown"}`));
    });

    this.#channel.addEventListener("message", (event) => {
      this.#onChannelMessage(event.data);
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
  #onChannelMessage(raw) {
    // Binary messages carry response body frames (see wire protocol). Control
    // messages (response-start/-error, pong) arrive as JSON strings.
    if (raw instanceof ArrayBuffer) {
      this.#onResponseBinaryChunk(new Uint8Array(raw));
      return;
    }

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

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
        entry.chunks.push(base64ToBytes(msg.data));
      }
      if (msg.done) {
        this.#pending.delete(msg.requestId);
        entry.resolve(this.#buildResponse(entry.status, entry.headers, entry.chunks));
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
      entry.chunks.push(payload);
    }
    if ((flags & 1) === 1) {
      this.#pending.delete(requestId);
      entry.resolve(this.#buildResponse(entry.status, entry.headers, entry.chunks));
    }
  }

  /**
   * Assemble body byte chunks into a minimal Response-like object.
   *
   * @param {number} status
   * @param {object} headers
   * @param {Uint8Array[]} chunks
   */
  #buildResponse(status, headers, chunks) {
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
      headers: {}
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

    try {
      this.#channel.send(JSON.stringify({
        type: "request",
        requestId,
        method: options.method ?? "GET",
        path: url.pathname,
        query: url.search.slice(1),
        headers: options.headers ?? {},
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
   * Close the data channel, peer connection, and signalling WebSocket.
   */
  close() {
    // Deliberate close — must not be reported as a lost connection.
    this.#closedByUser = true;
    this.#ws?.close();
    this.#channel?.close();
    this.#pc?.close();
    this.#ws = null;
    this.#channel = null;
    this.#pc = null;
  }
}
