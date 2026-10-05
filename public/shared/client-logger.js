/**
 * @file Browser → server log forwarder.
 *
 * Mobile Safari makes copying eruda/console logs off an iPhone painful. This
 * module tees every `console.*` call (and uncaught errors) to the server over
 * plain HTTPS, so the logs show up in the server's log — on the droplet
 * `/var/log/torrent-tv/client.log` (`infra` README, "Logs") — no copy-paste,
 * and it works even when the WebRTC data channel never connects (the failures
 * we most want to see). Once a data channel is up the lines go to the proxy
 * instead (`proxy/docs/logs.md`).
 *
 * Each line is tagged with a device/browser label (e.g. `iPhone/Safari`,
 * `Windows/Chrome`) and a short per-page session id so logs from different
 * clients are distinguishable in the shared server log.
 *
 * Strictly best-effort: never throws, never blocks, caps its queue, and uses
 * the ORIGINAL console methods for its own internal errors so a failed POST
 * can never re-enter the patched console and loop. A batch nobody accepted goes
 * back into the queue, and what was lost is written into the log itself
 * (`log-queue.js`).
 */

import { LogQueue, MAX_BATCH_BYTES } from "./log-queue.js";

const ENDPOINT = "/api/client-logs";
const FLUSH_INTERVAL_MS = 2000;
const MAX_BUFFER = 500; // queue cap; oldest dropped past this, and counted
const MAX_MSG_LEN = 2000; // per-line cap (server also caps)

// Keep original references so internal failures never re-enter the patched
// console (which would loop back into the queue / POST).
const original = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  debug: console.debug.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};

/**
 * The WebRTC signalling session id the page is currently using, as assigned by
 * the server and logged by the proxy as `[webrtc] Session <id>`. Set via
 * `window.__ttvClientLogger.setSignalSession(id)` from the WebRTC transport;
 * attached to every batch so a proxy-side session id greps straight to this
 * client's lines. A reconnect replaces it (its own log line marks the switch).
 * @type {string}
 */
let currentSignalSession = "";

/**
 * Derive a short "device/browser" tag from the user-agent.
 *
 * @param {string} ua
 * @returns {string}
 */
function deviceBrowserTag(ua) {
  const s = typeof ua === "string" ? ua : "";

  let device = "Unknown";
  if (/iPhone/.test(s)) device = "iPhone";
  else if (/iPad/.test(s)) device = "iPad";
  else if (/iPod/.test(s)) device = "iPod";
  else if (/Android/.test(s)) device = "Android";
  else if (/Windows/.test(s)) device = "Windows";
  else if (/Macintosh|Mac OS X/.test(s)) device = "Mac";
  else if (/Linux/.test(s)) device = "Linux";

  // Order matters: iOS in-app browsers (CriOS/FxiOS/EdgiOS) and Edge (Edg)
  // must be checked before Chrome/Safari, which their UA strings also contain.
  let browser = "Unknown";
  if (/EdgiOS\//.test(s) || /Edg\//.test(s)) browser = "Edge";
  else if (/CriOS\//.test(s)) browser = "Chrome";
  else if (/FxiOS\//.test(s) || /Firefox\//.test(s)) browser = "Firefox";
  else if (/SamsungBrowser\//.test(s)) browser = "Samsung";
  else if (/Chrome\//.test(s)) browser = "Chrome";
  else if (/Safari\//.test(s)) browser = "Safari";

  return `${device}/${browser}`;
}

/**
 * Short random session id, stable for this page load.
 *
 * @returns {string}
 */
function makeSessionId() {
  try {
    const a = new Uint8Array(4);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    // silent-ok: a session id only has to be unique enough to group one page's
    // lines; the fallback produces one, so nothing is abandoned.
    return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  }
}

const tag = deviceBrowserTag(typeof navigator === "object" ? navigator.userAgent : "");
const userAgent = typeof navigator === "object" && typeof navigator.userAgent === "string" ? navigator.userAgent : "";
const sessionId = makeSessionId();

/** When this page's session began, so its two log halves join by name. */
const startedAt = new Date().toISOString();
/** What is being watched, once a torrent has been chosen. */
let film = { name: "", infoHash: "" };
/**
 * Where batches go when the page has a proxy.
 *
 * The proxy writes them beside its OWN log, on the host's durable disk. The
 * registry server writes them to its standard output, which every release of
 * it destroys — and both halves of a failure are needed to explain one.
 *
 * @type {((body: string) => Promise<unknown>) | null}
 */
let proxySink = null;

/**
 * Render a single console argument as a string.
 *
 * @param {unknown} arg
 * @returns {string}
 */
function renderArg(arg) {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack ? `${arg.message}\n${arg.stack}` : arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    // silent-ok: rendering a log argument that will not serialise is what the
    // fallback is FOR, and complaining about it would be a log line about
    // logging.
    return String(arg);
  }
}

/**
 * The lines not yet delivered. A batch's body carries `seq`, the number of the
 * send it went out in, which both receivers print: a number missing on both
 * sides is a batch nobody took, and one present on both is a batch the proxy
 * took but could not acknowledge, sent to the server as well.
 */
const queue = new LogQueue({
  capacity: MAX_BUFFER,
  frame: (lines, seq) => JSON.stringify({
    sessionId, tag, userAgent, signalSessionId: currentSignalSession, seq, lines,
    startedAt, torrentName: film.name, infoHash: film.infoHash
  })
});

/**
 * Bytes of `keepalive` bodies this page has in flight. The browser refuses a
 * `keepalive` request that would take the page past 64 KiB of them, so a batch
 * that would is sent as an ordinary request instead: it then does not outlive
 * the page, which only the unload path needs, and that path has `sendBeacon`.
 * The page's other `keepalive` requests share the browser's quota and are not
 * counted here; a refusal they cause is counted as a failure and retried.
 */
let keepaliveBytesInFlight = 0;

/**
 * Append a formatted line to the queue.
 *
 * @param {string} level
 * @param {unknown[]} args
 * @returns {void}
 */
function record(level, args) {
  try {
    let msg = args.map(renderArg).join(" ");
    if (msg.length > MAX_MSG_LEN) {
      msg = `${msg.slice(0, MAX_MSG_LEN)}…`;
    }
    queue.push({ level, ts: new Date().toISOString().slice(11, 23), msg });
  } catch {
    // silent-ok: capturing a line must never break the app it is describing,
    // and there is nowhere to report a failure of the reporting itself —
    // console.* here would recurse into this very function.
  }
}

/**
 * Send every queued line, in batches the receivers and the browser accept.
 *
 * @param {boolean} [useBeacon] - Use `sendBeacon` (the page is being hidden or
 *   left).
 * @returns {void}
 */
function flush(useBeacon = false) {
  try {
    queue.reportLosses();
    const beacon = useBeacon && typeof navigator.sendBeacon === "function";
    for (let batch = queue.take(); batch !== null; batch = queue.take()) {
      if (beacon) {
        // A data channel cannot be used from a page that is going away, so
        // this reaches the server only. A refusal leaves the lines queued for a
        // page that turns out to stay, and stops here: everything after it
        // would be refused by the same quota.
        if (!navigator.sendBeacon(ENDPOINT, new Blob([batch.body], { type: "application/json" }))) {
          queue.noteFailure("beacon", "refused by the browser");
          queue.giveBack(batch);
          return;
        }
        queue.delivered(batch);
        continue;
      }
      if (proxySink) {
        sendToProxy(proxySink, batch);
      } else {
        sendToServer(batch);
      }
    }
  } catch {
    // silent-ok: this IS the forwarder, so it has no channel of its own to
    // complain through; the lines of a batch that never left are lost with it.
  }
}

/**
 * The proxy, which keeps the lines beside its own. A batch it refuses or never
 * answers goes to the server: the moments when the proxy cannot be reached are
 * exactly the ones worth having. A wedged connection still carries the batch
 * TO the proxy and only loses the answer, so after its timeout such a batch is
 * on both sides under the same `seq`.
 *
 * @param {(body: string) => Promise<unknown>} sink
 * @param {import("./log-queue.js").LogBatch} batch
 * @returns {void}
 */
function sendToProxy(sink, batch) {
  void Promise.resolve()
    .then(() => sink(batch.body))
    .then((response) => {
      if (response && typeof response === "object" && "ok" in response && !response.ok) {
        throw new Error(`HTTP ${/** @type {{ status?: number }} */ (response).status ?? "?"}`);
      }
      queue.delivered(batch);
    })
    .catch((error) => {
      queue.noteFailure("proxy", error);
      sendToServer(batch);
    });
}

/**
 * The registry server: where a page with no proxy, or a failed proxy, is heard.
 * A batch it does not accept goes back into the queue.
 *
 * @param {import("./log-queue.js").LogBatch} batch
 * @returns {void}
 */
function sendToServer(batch) {
  const keepalive = keepaliveBytesInFlight + batch.bytes <= MAX_BATCH_BYTES;
  if (keepalive) {
    keepaliveBytesInFlight += batch.bytes;
  }
  void Promise.resolve()
    .then(() => fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: batch.body,
      keepalive
    }))
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      queue.delivered(batch);
    })
    .catch((error) => {
      // Not console.* here: that would queue a line about this very failure
      // for ever. The count goes into the next report instead.
      queue.noteFailure("server", error);
      queue.giveBack(batch);
    })
    .finally(() => {
      if (keepalive) {
        keepaliveBytesInFlight -= batch.bytes;
      }
    });
}

/**
 * Patch a console method so it still logs locally and also queues the line.
 *
 * @param {"log"|"info"|"debug"|"warn"|"error"} level
 * @returns {void}
 */
function patch(level) {
  console[level] = (...args) => {
    original[level](...args);
    record(level, args);
  };
}

/**
 * Install the forwarder. Idempotent.
 *
 * @returns {void}
 */
function install() {
  if (window.__ttvClientLogger) {
    return;
  }
  window.__ttvClientLogger = {
    sessionId,
    tag,
    /**
     * Record the WebRTC signalling session id so subsequent batches carry it.
     * Called by the WebRTC transport when the server assigns a session (and
     * again on each reconnect). A no-op for empty/non-string ids.
     *
     * @param {unknown} id
     * @returns {void}
     */
    /**
     * Send batches through the proxy from now on, or stop doing so.
     *
     * @param {((body: string) => Promise<unknown>) | null} sink
     * @returns {void}
     */
    setProxySink(sink) {
      proxySink = typeof sink === "function" ? sink : null;
    },
    /**
     * Name what is being watched, so the log file says which film it is.
     *
     * @param {{ name?: string, infoHash?: string }} chosen
     * @returns {void}
     */
    setFilm(chosen) {
      film = {
        name: typeof chosen?.name === "string" ? chosen.name : "",
        infoHash: typeof chosen?.infoHash === "string" ? chosen.infoHash : ""
      };
    },
    setSignalSession(id) {
      if (typeof id !== "string" || id.length === 0 || id === currentSignalSession) {
        return;
      }
      currentSignalSession = id.slice(0, 36);
      record("info", [`[client-logger] signal-session=${currentSignalSession}`]);
    }
  };

  patch("log");
  patch("info");
  patch("debug");
  patch("warn");
  patch("error");

  window.addEventListener("error", (event) => {
    record("error", [`[window.onerror] ${event.message} @ ${event.filename}:${event.lineno}:${event.colno}`]);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event && event.reason;
    record("error", [`[unhandledrejection] ${reason instanceof Error ? reason.stack || reason.message : renderArg(reason)}`]);
  });

  const timer = setInterval(() => flush(false), FLUSH_INTERVAL_MS);
  if (typeof timer === "object" && typeof timer.unref === "function") {
    timer.unref();
  }

  // Flush promptly when the page is backgrounded or closed (mobile tab switch,
  // navigation) so the last lines before a failure are not lost.
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush(true);
  });
  window.addEventListener("pagehide", () => flush(true));

  // Announce the session once so the server log shows which client this is,
  // with the context that shapes playback: app version, viewport (drives the
  // transcode target), and coarse connection type.
  const version = typeof window === "object" && window.env && window.env.version ? window.env.version : "?";
  const viewport = typeof window === "object" ? `${window.innerWidth}x${window.innerHeight}` : "?";
  const net =
    typeof navigator === "object" && navigator.connection && navigator.connection.effectiveType
      ? navigator.connection.effectiveType
      : "?";
  record("info", [
    `[client-logger] session=${sessionId} tag=${tag} ver=${version} vp=${viewport} net=${net} ua=${userAgent}`
  ]);
}

install();

