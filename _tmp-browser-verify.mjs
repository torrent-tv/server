// Drive the real site over CDP: open a torrent, watch the loading text, wait
// for playback, then SEEK far and observe whether playback actually resumes.
// This is the check that the segment-level tests cannot make.
import http from "node:http";
import fs from "node:fs";
import { WebSocket } from "ws";

const CDP = "http://127.0.0.1:9222";
const SITE = process.env.SITE ?? "https://webauth.courses";
const MAGNET = process.env.MAGNET ?? "";
const OUT = process.env.OUT ?? "C:\\Users\\ANTONN~1\\AppData\\Local\\Temp\\claude\\ttv-shots";
fs.mkdirSync(OUT, { recursive: true });

const getJson = (path) => new Promise((resolve, reject) => {
  http.get(`${CDP}${path}`, (res) => {
    let body = "";
    res.on("data", (c) => { body += c; });
    res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
  }).on("error", reject);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Session {
  #ws; #id = 0; #pending = new Map();
  async open(wsUrl) {
    this.#ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
    await new Promise((res, rej) => { this.#ws.once("open", res); this.#ws.once("error", rej); });
    this.#ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      const entry = this.#pending.get(msg.id);
      if (entry) { this.#pending.delete(msg.id); msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result); }
    });
  }
  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.#pending.delete(id)) reject(new Error(`${method} timed out`)); }, 60_000);
    });
  }
  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
    return r.result?.value;
  }
  async shot(name) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    const file = `${OUT}\\${name}.png`;
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    return file;
  }
  close() { this.#ws?.close(); }
}

/** Everything the viewer can see about playback state, in one shot. */
const STATE_EXPR = `(() => {
  const v = document.querySelector('#player__video');
  const loadingText = document.querySelector('#loading__status')?.textContent?.trim() ?? '';
  const pill = document.querySelector('#player__buffering-peers')?.textContent?.trim() ?? '';
  const bufferingShown = !document.querySelector('#player__buffering')?.hidden;
  const errorText = document.querySelector('#error__description')?.textContent?.trim() ?? '';
  const errorShown = !!document.querySelector('#error')?.open;
  let buffered = 0;
  if (v) { for (let i = 0; i < v.buffered.length; i++) {
    if (v.buffered.start(i) <= v.currentTime + 0.25 && v.currentTime < v.buffered.end(i)) buffered = v.buffered.end(i) - v.currentTime;
  } }
  return {
    currentTime: v ? +v.currentTime.toFixed(2) : null,
    duration: v && isFinite(v.duration) ? +v.duration.toFixed(1) : null,
    paused: v ? v.paused : null,
    readyState: v ? v.readyState : null,
    buffered: +buffered.toFixed(2),
    loadingText, pill, bufferingShown, errorText, errorShown
  };
})()`;

const log = (...a) => console.log(...a);

const targets = await getJson("/json/list");
const page = targets.find((t) => t.type === "page");
const s = new Session();
await s.open(page.webSocketDebuggerUrl);
await s.send("Page.enable");
await s.send("Runtime.enable");

log(`navigating to ${SITE}`);
await s.send("Page.navigate", { url: SITE });
await sleep(6000);
log("version:", await s.evaluate("window.env && window.env.version"));
await s.shot("01-loaded");

if (!MAGNET) { log("no MAGNET given — stopping after load"); s.close(); process.exit(0); }

// Feed the magnet exactly the way a user pasting a link does.
log("submitting magnet");
await s.evaluate(`(() => {
  const input = document.querySelector('#torrent__magnet');
  if (!input) return 'no input found';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(MAGNET)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const btn = document.querySelector('#torrent__submit');
  if (btn) { btn.click(); return 'clicked submit'; }
  return 'no submit button';
})()`);

// Watch the loading screen: this is where the reported text defects lived.
for (let i = 1; i <= 30; i++) {
  await sleep(5000);
  const st = await s.evaluate(STATE_EXPR);
  log(`t+${i * 5}s`, JSON.stringify(st));
  if (i % 3 === 0) await s.shot(`02-loading-${String(i).padStart(2, "0")}`);
  if (st.errorShown) { await s.shot("03-error"); log("ERROR SCREEN:", st.errorText); break; }
  if (st.currentTime !== null && st.currentTime > 0.5 && !st.paused) { await s.shot("03-playing"); log("PLAYING"); break; }
}

const before = await s.evaluate(STATE_EXPR);
log("state before seek:", JSON.stringify(before));

if (before.duration && before.duration > 120) {
  const target = Math.floor(before.duration * 0.55);
  log(`SEEKING to ${target}s (the case that used to freeze forever)`);
  await s.evaluate(`(() => { document.querySelector('#player__video').currentTime = ${target}; return true; })()`);
  for (let i = 1; i <= 24; i++) {
    await sleep(5000);
    const st = await s.evaluate(STATE_EXPR);
    log(`seek+${i * 5}s`, JSON.stringify(st));
    if (i % 2 === 0) await s.shot(`04-seek-${String(i).padStart(2, "0")}`);
    if (st.currentTime > target + 1 && !st.paused) { await s.shot("05-resumed"); log("PLAYBACK RESUMED AFTER SEEK"); break; }
  }
  log("final:", JSON.stringify(await s.evaluate(STATE_EXPR)));
} else {
  log("duration unknown/too short — skipping seek");
}

s.close();
