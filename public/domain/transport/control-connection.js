import { CONNECT_TIMEOUT_MS } from "../connect-deadline.js";
import { SignallingSession } from "./signalling-session.js";
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
  get signalSessionId() { return this.#current?.signalling.sessionId ?? null; }

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
    try {
      pc = new RTCPeerConnection({ iceServers: this.#options.iceServers });
      channel = pc.createDataChannel("proxy-control", { ordered: true });
      channel.binaryType = "arraybuffer";
    } catch (error) {
      channel?.close();
      pc?.close();
      return Promise.reject(error);
    }
    let resolve;
    let rejectReady;
    const ready = new Promise((yes, no) => { resolve = yes; rejectReady = no; });
    const current = {
      id: crypto.randomUUID(), pc, channel, signalling: null, ready, resolve, reject: rejectReady,
      opened: false, timer: null, deliveryTimer: null,
      estimate: emptyArrivalEstimate(), probe: null, arrivalAt: performance.now(), handled: 0,
      stalled: false, candidateRefusals: 0
    };
    const reject = (error) => this.#reject(current, error);
    // Signalling can disappear during a server release after the data channel
    // is established. Keep that channel; its next replacement gets a new socket.
    current.signalling = new SignallingSession({
      proxyId: this.#options.proxyId,
      connectionId: current.id,
      createPeer: sessionId => {
        console.debug(`[ice-control] session=${sessionId} connectionId=${current.id}`);
        return pc;
      },
      acceptCandidate: candidate => this.#options.acceptCandidate(candidate),
      onCandidateRefused: error => {
        // Cap the diagnostic and omit the candidate's private address.
        if (++current.candidateRefusals <= 3) console.debug(`[ice-control] candidate refused (${error.name})`);
      },
      onUnreadable: reject,
      onFail: reject,
      onSocketClosed: () => { if (!current.opened) reject(new Error("Control signalling closed before connection.")); },
      onSocketError: () => { if (!current.opened) reject(new Error("Control signalling failed.")); }
    });
    try {
      current.signalling.open();
    } catch (error) {
      channel.close();
      pc.close();
      return Promise.reject(error);
    }
    this.#current = current;
    current.timer = setTimeout(() => reject(new Error("Control connection timed out.")), CONNECT_TIMEOUT_MS);
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
      if (this.#current !== current || !event.candidate) return;
      if (!current.signalling.sendCandidate(event.candidate) && !current.opened) {
        reject(new Error("Control signalling is not open."));
      }
    });
    return ready;
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
    current.signalling.close();
    current.channel.close();
    current.pc.close();
    this.#options.onClosed(current.channel, error, current.opened);
  }

  close() {
    this.#closed = true;
    if (this.#current) this.#reject(this.#current, new DOMException("Control connection closed.", "AbortError"));
  }
}
