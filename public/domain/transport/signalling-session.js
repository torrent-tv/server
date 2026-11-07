/**
 * @file The browser's side of one WebRTC signalling handshake.
 *
 * One session owns one signalling socket: it waits for the server's `session`
 * message, sends the offer, applies the answer, and buffers remote candidates
 * until the answer is in. The media peer and the control peer each run their
 * own session, so their sockets never depend on each other.
 *
 * A peer supplies what differs between them:
 * - `createPeer(sessionId)` returns the RTCPeerConnection to negotiate;
 * - `acceptCandidate(candidate, disposition)` is its remote-candidate filter;
 * - `trace(step, info)` records a step and may return a function that ends it;
 * - `onAnswered(message)` runs once the answer and the buffered candidates are applied.
 */

export class SignallingSession {
  #options;
  #socket = null;
  #pc = null;
  #closed = false;
  #remoteSet = false;
  #candidates = [];
  #sessionId = null;

  /**
   * @param {{
   *   proxyId: string,
   *   connectionId?: string,
   *   createPeer: (sessionId: string) => RTCPeerConnection,
   *   acceptCandidate: (candidate: object, disposition: "apply" | "buffer") => boolean,
   *   trace?: (step: string, info?: object) => ((result: object) => void) | void,
   *   onAnswered?: (message: object) => void,
   *   onCandidateRefused?: (error: unknown, candidate: object, disposition: "buffered" | "trickled") => void,
   *   onUnreadable?: (error: unknown, raw: unknown) => void,
   *   onFail: (error: Error) => void,
   *   onSocketClosed?: () => void,
   *   onSocketError?: () => void
   * }} options `connectionId`, when given, is sent with every message and required on every one received.
   */
  constructor(options) {
    this.#options = options;
  }

  get sessionId() { return this.#sessionId; }

  /** Open the socket. Throws when the browser refuses to create it. */
  open() {
    const socket = new WebSocket(`${location.protocol.replace("http", "ws")}//${location.host}/ws/browser-signal`);
    this.#socket = socket;
    socket.addEventListener("message", event => { void this.#onMessage(event.data); });
    socket.addEventListener("close", () => this.#options.onSocketClosed?.());
    socket.addEventListener("error", () => this.#options.onSocketError?.());
  }

  /** Send a local candidate; false when the socket is not open, which is not an error for a late candidate. */
  sendCandidate(candidate) {
    if (this.#socket?.readyState !== WebSocket.OPEN) return false;
    this.#send({ type: "candidate", candidate: candidate.candidate, mid: candidate.sdpMid ?? "0" });
    return true;
  }

  close() {
    this.#closed = true;
    this.#socket?.close();
    this.#socket = null;
  }

  #send(message) {
    if (this.#socket?.readyState !== WebSocket.OPEN) throw new Error("Signalling is not open.");
    const { connectionId, proxyId } = this.#options;
    this.#socket.send(JSON.stringify({ ...message, ...(connectionId && { connectionId }), proxyId }));
  }

  #fail(error) {
    this.#options.onFail(error instanceof Error ? error : new Error(String(error)));
  }

  async #onMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch (error) {
      // silent-ok: the peer's onUnreadable hook reports it.
      this.#options.onUnreadable?.(error, raw);
      return;
    }
    if (this.#closed) return;
    if (message.type === "session") {
      if (this.#sessionId !== null) return;
      this.#sessionId = message.sessionId;
      try {
        this.#pc = this.#options.createPeer(message.sessionId);
        await this.#sendOffer(this.#pc);
      } catch (error) {
        // silent-ok: the failure goes to the peer's onFail hook.
        this.#fail(error);
      }
      return;
    }
    if (!this.#pc) return;
    if (this.#options.connectionId && message.connectionId !== this.#options.connectionId) return;
    if (message.type === "answer") await this.#applyAnswer(message);
    else if (message.type === "candidate") await this.#onCandidate(message);
  }

  async #sendOffer(pc) {
    const end = this.#options.trace?.("offer");
    try {
      const offer = await pc.createOffer();
      if (this.#closed) return;
      await pc.setLocalDescription(offer);
      if (this.#closed) return;
      // Chromium 152+ puts its SCTP INIT in the offer (zero-RTT association).
      // libdatachannel does not know the attribute and echoes it in its answer,
      // so the browser believes an association exists that never touched the
      // wire and the channel dies seconds after DTLS. Without it in the copy we
      // send, the browser falls back to the in-band handshake. The local
      // description keeps it.
      this.#send({ type: "offer", sdp: offer.sdp.replace(/a=sctp-init:[^\r\n]*\r\n/g, "") });
      end?.({ outcome: "sent" });
    } catch (error) {
      end?.({ outcome: "error", error: String(error?.message ?? error) });
      throw error;
    }
  }

  async #applyAnswer(message) {
    const pc = this.#pc;
    let end = this.#options.trace?.("answer");
    try {
      await pc.setRemoteDescription({ type: "answer", sdp: message.sdp });
      end?.({ outcome: "applied" });
      end = null;
      if (this.#closed) return;
      this.#remoteSet = true;
      for (const candidate of this.#candidates) await this.#applyCandidate(candidate, "buffered");
      if (this.#closed) return;
      this.#candidates = [];
      this.#options.onAnswered?.(message);
    } catch (error) {
      end?.({ outcome: "error", error: String(error?.message ?? error) });
      // silent-ok: the failure goes to the peer's onFail hook.
      this.#fail(error);
    }
  }

  async #onCandidate(message) {
    if (typeof message.candidate !== "string") return;
    const candidate = { candidate: message.candidate, sdpMid: message.mid ?? "0", sdpMLineIndex: 0 };
    if (!this.#options.acceptCandidate(candidate, this.#remoteSet ? "apply" : "buffer")) return;
    if (this.#remoteSet) await this.#applyCandidate(candidate, "trickled");
    else this.#candidates.push(candidate);
  }

  async #applyCandidate(candidate, disposition) {
    if (this.#closed) return;
    const end = this.#options.trace?.("candidate", { disposition });
    try {
      await this.#pc.addIceCandidate(candidate);
      end?.({ outcome: "applied" });
    } catch (error) {
      end?.({ outcome: "rejected", error: String(error?.message ?? error) });
      // silent-ok: the peer's onCandidateRefused hook logs it; one refused candidate does not invalidate the other paths.
      this.#options.onCandidateRefused?.(error, candidate, disposition);
    }
  }
}
