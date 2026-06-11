/**
 * @file Browser → server log forwarder.
 *
 * Mobile Safari makes copying eruda/console logs off an iPhone painful. This
 * module tees every `console.*` call (and uncaught errors) to the server over
 * plain HTTPS, so the logs show up in the server container log (readable with
 * `docker logs` / `ssh do`) — no copy-paste, and it works even when the WebRTC
 * data channel never connects (the failures we most want to see).
 *
 * Each line is tagged with a device/browser label (e.g. `iPhone/Safari`,
 * `Windows/Chrome`) and a short per-page session id so logs from different
 * clients are distinguishable in the shared server log.
 *
 * Strictly best-effort: never throws, never blocks, caps its buffer, and uses
 * the ORIGINAL console methods for its own internal errors so a failed POST
 * can never re-enter the patched console and loop.
 */

const ENDPOINT = "/api/client-logs";
const FLUSH_INTERVAL_MS = 2000;
const MAX_BUFFER = 500; // ring buffer cap; oldest dropped past this
const MAX_BATCH = 50; // lines per POST
const MAX_MSG_LEN = 2000; // per-line cap (server also caps)

// Keep original references so internal failures never re-enter the patched
// console (which would loop back into the buffer / POST).
const original = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  debug: console.debug.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};

/** @type {Array<{ level: string, ts: string, msg: string }>} */
const buffer = [];

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
    return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  }
}

const tag = deviceBrowserTag(typeof navigator === "object" ? navigator.userAgent : "");
const userAgent = typeof navigator === "object" && typeof navigator.userAgent === "string" ? navigator.userAgent : "";
const sessionId = makeSessionId();

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
    return String(arg);
  }
}

/**
 * Append a formatted line to the ring buffer.
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
    buffer.push({ level, ts: new Date().toISOString().slice(11, 23), msg });
    if (buffer.length > MAX_BUFFER) {
      buffer.splice(0, buffer.length - MAX_BUFFER);
    }
  } catch {
    // Never let logging capture break the app.
  }
}

/**
 * Send up to one batch of buffered lines to the server.
 *
 * @param {boolean} [useBeacon] - Use `sendBeacon` (for page unload).
 * @returns {void}
 */
function flush(useBeacon = false) {
  if (buffer.length === 0) {
    return;
  }
  const lines = buffer.splice(0, MAX_BATCH);
  const body = JSON.stringify({ sessionId, tag, userAgent, lines });
  try {
    if (useBeacon && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }));
      return;
    }
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true
    }).catch(() => {
      // Best-effort: drop on failure (do NOT console.* here — would loop).
    });
  } catch {
    // Swallow — forwarding logs must never throw.
  }
}

/**
 * Patch a console method so it still logs locally and also buffers the line.
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
  window.__ttvClientLogger = { sessionId, tag };

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

  // Announce the session once so the server log shows which client this is.
  record("info", [`[client-logger] session=${sessionId} tag=${tag} ua=${userAgent}`]);
}

install();
