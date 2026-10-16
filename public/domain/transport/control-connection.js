import { CONNECT_TIMEOUT_MS } from "../connect-deadline.js";
import { deliveryDueWithinMs, emptyArrivalEstimate, noteProbeGap, silenceVerdict } from "./delivery-deadline.js";

/** A control-only SCTP association with independently renewable signalling. */
export class ControlConnection {
  #current = null;
  #closed = false;
  #options;

  constructor(options) {
    this.#options = options;
  }

  get channel() { return this.#current?.channel ?? null; }
  get peer() { return this.#current?.pc ?? null; }
  get connectionId() { return this.#current?.id ?? null; }
  get signalSessionId() { return this.#current?.sessionId ?? null; }

  wait(signal) {
    if (signal?.aborted) return Promise.reject(new DOMException("Control wait cancelled.", "AbortError"));
    const ready = this.open();
    if (!signal) return ready;
    return new Promise((resolve, reject) => {
      const aborted = () => reject(new DOMException("Control wait cancelled.", "AbortError"));
      signal.addEventListener("abort", aborted, { once: true });
      ready.then(channel => {
        signal.removeEventListener("abort", aborted);
        resolve(channel);
      }, error => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      });
    });
  }

  open() {
    if (this.#closed) return Promise.reject(new DOMException("Control connection closed.", "AbortError"));
    if (this.#current) return this.#current.ready;
    let pc;
    let channel;
    let ws;
    try {
      pc = new RTCPeerConnection({ iceServers: this.#options.iceServers });
      channel = pc.createDataChannel("proxy-control", { ordered: true });
      channel.binaryType = "arraybuffer";
      ws = new WebSocket(`${location.protocol.replace("http", "ws")}//${location.host}/ws/browser-signal`);
    } catch (error) {
      channel?.close();
      pc?.close();
      return Promise.reject(error);
    }
    let resolve;
    let rejectReady;
    const ready = new Promise((yes, no) => { resolve = yes; rejectReady = no; });
    const current = {
      id: crypto.randomUUID(), pc, channel, ws, ready, resolve, reject: rejectReady, sessionId: null,
      opened: false, remoteSet: false, candidates: [], timer: null, deliveryTimer: null,
      estimate: emptyArrivalEstimate(), probe: null, arrivalAt: performance.now(), handled: 0,
      stalled: false, candidateRefusals: 0
    };
    this.#current = current;
    const reject = (error) => this.#reject(current, error);
    current.timer = setTimeout(() => reject(new Error("Control connection timed out.")), CONNECT_TIMEOUT_MS);
    ws.addEventListener("message", event => {
      if (this.#current !== current) return;
      try {
        const signal = JSON.parse(event.data);
        if (signal.type === "session") {
          if (current.sessionId !== null) return;
          current.sessionId = signal.sessionId;
          console.debug(`[ice-control] session=${signal.sessionId} connectionId=${current.id}`);
          void this.#sendOffer(current);
        } else {
          void this.handleSignal(signal);
        }
      } catch (error) { reject(error); }
    });
    // Signalling can disappear during a server release after the data channel
    // is established. Keep that channel; its next replacement gets a new socket.
    ws.addEventListener("close", () => {
      if (!current.opened) reject(new Error("Control signalling closed before connection."));
    });
    ws.addEventListener("error", () => {
      if (!current.opened) reject(new Error("Control signalling failed."));
    });
    channel.addEventListener("open", () => {
      if (this.#current !== current) return;
      clearTimeout(current.timer);
      current.opened = true;
      this.#options.onOpen(channel);
      resolve(channel);
    });
    channel.addEventListener("message", event => {
      if (this.#current !== current) return;
      const at = performance.now();
      current.arrivalAt = at;
      current.handled++;
      current.stalled = false;
      if (typeof event.data === "string") {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "probe" && Number.isFinite(message.seq) &&
              (current.probe === null || message.seq > current.probe.seq)) {
            if (current.probe !== null) current.estimate = noteProbeGap(current.estimate, at - current.probe.at);
            current.probe = { seq: message.seq, at };
          }
        } catch {
          // silent-ok: the common response reader reports malformed messages.
        }
      }
      this.#options.onMessage(event.data);
      this.noteRequest();
    });
    channel.addEventListener("close", () => reject(new Error("Control data channel closed.")));
    channel.addEventListener("error", () => reject(new Error("Control data channel failed.")));
    pc.addEventListener("connectionstatechange", () => {
      console.debug(`[ice-control] ${current.id} state=${pc.connectionState}`);
      if (pc.connectionState === "failed" || pc.connectionState === "closed") reject(new Error("Control peer connection failed."));
    });
    pc.addEventListener("icecandidate", event => {
      if (this.#current === current && event.candidate) {
        try {
          this.#sendSignal(current, { type: "candidate",
            candidate: event.candidate.candidate, mid: event.candidate.sdpMid ?? "0" });
        } catch (error) { if (!current.opened) reject(error); }
      }
    });
    return ready;
  }

  #sendSignal(current, signal) {
    if (current.ws.readyState !== WebSocket.OPEN) throw new Error("Control signalling is not open.");
    current.ws.send(JSON.stringify({ ...signal, connectionId: current.id, proxyId: this.#options.proxyId }));
  }

  async #sendOffer(current) {
    try {
      const pc = current.pc;
      const offer = await pc.createOffer();
      if (this.#current !== current) return;
      await pc.setLocalDescription(offer);
      if (this.#current !== current) return;
      // Apply the same Chromium zero-RTT compatibility rule as the media offer.
      const sdp = offer.sdp.replace(/a=sctp-init:[^\r\n]*\r\n/g, "");
      this.#sendSignal(current, { type: "offer", sdp });
    } catch (error) { this.#reject(current, error); }
  }

  async #addCandidate(current, candidate) {
    if (this.#current !== current) return;
    try {
      await current.pc.addIceCandidate(candidate);
    } catch (error) {
      // A refused candidate does not invalidate other working paths. Cap the
      // diagnostic and omit the candidate's private address.
      if (++current.candidateRefusals <= 3) console.debug(`[ice-control] candidate refused (${error.name})`);
    }
  }

  async handleSignal(signal) {
    const current = this.#current;
    if (!current || signal.connectionId !== current.id) return;
    try {
      if (signal.type === "answer") {
        await current.pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
        if (this.#current !== current) return;
        current.remoteSet = true;
        for (const candidate of current.candidates.splice(0)) await this.#addCandidate(current, candidate);
      } else if (signal.type === "candidate") {
        if (typeof signal.candidate !== "string") return;
        const candidate = { candidate: signal.candidate, sdpMid: signal.mid ?? "0", sdpMLineIndex: 0 };
        if (!this.#options.acceptCandidate(candidate)) return;
        if (current.remoteSet) await this.#addCandidate(current, candidate);
        else current.candidates.push(candidate);
      }
    } catch (error) {
      this.#reject(current, error);
    }
  }

  /** Keep silence detection separate from the association carrying the film. */
  noteRequest() {
    const current = this.#current;
    if (!current?.opened || current.deliveryTimer !== null ||
        (this.#options.pending(current.channel) === 0 && !current.stalled)) return;
    const due = deliveryDueWithinMs(current.estimate);
    if (due === null) return;
    const wait = (current.stalled ? this.#options.silenceWindowMs : due) - (performance.now() - current.arrivalAt);
    current.deliveryTimer = setTimeout(() => {
      current.deliveryTimer = null;
      void this.#checkDelivery(current);
    }, Math.max(0, wait) + 1);
  }

  async #checkDelivery(current) {
    if (this.#current !== current) return;
    let received = null;
    try {
      const stats = await current.pc.getStats();
      stats.forEach(report => {
        if (report.type === "data-channel" && Number.isFinite(report.messagesReceived)) {
          received = (received ?? 0) + report.messagesReceived;
        }
      });
    } catch {
      // silent-ok: without a receive counter the verdict uses observed arrivals.
    }
    if (this.#current !== current) return;
    const verdict = silenceVerdict({
      silentMs: performance.now() - current.arrivalAt,
      dueWithinMs: deliveryDueWithinMs(current.estimate),
      outstanding: this.#options.pending(current.channel),
      channelOpen: current.channel.readyState === "open",
      messagesWaiting: received !== null && received > current.handled,
      stalledAlready: current.stalled,
      requestTimeoutMs: this.#options.silenceWindowMs
    });
    if (verdict.state === "lost") {
      this.#reject(current, new Error(`Control delivery lost: ${verdict.reason}`));
      return;
    }
    current.stalled = verdict.state === "stalled";
    this.noteRequest();
  }

  #reject(current, error) {
    if (this.#current !== current) return;
    this.#current = null;
    clearTimeout(current.timer);
    clearTimeout(current.deliveryTimer);
    current.reject(error);
    current.ws.close();
    current.channel.close();
    current.pc.close();
    this.#options.onClosed(current.channel, error, current.opened);
  }

  close() {
    this.#closed = true;
    if (this.#current) this.#reject(this.#current, new DOMException("Control connection closed.", "AbortError"));
  }
}
