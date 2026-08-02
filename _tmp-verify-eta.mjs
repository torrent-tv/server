// Live verification of the prebuffer-target unification fix (server 0.8.88).
// Drives the real production site over CDP (Chrome Canary, port 9222) and
// records the loading-status text every second from a fresh (never-opened)
// torrent, so the sequence can be checked for:
//  1. starts from zero (no stale cached state)
//  2. "needed" magnitudes only decrease
//  3. the reported ETA trends down over time
//  4. the LAST reported ETA before playback roughly matches the ACTUAL wait
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
  #ws; #id = 0; #pending = new Map(); consoleMsgs = [];
  async open(wsUrl) {
    this.#ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
    await new Promise((res, rej) => { this.#ws.once("open", res); this.#ws.once("error", rej); });
    this.#ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.method === "Runtime.consoleAPICalled") {
        const args = (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
        this.consoleMsgs.push({ t: Date.now(), text: args });
      }
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
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

const STATE_EXPR = `(() => {
  const v = document.querySelector('#player__video');
  const status = document.querySelector('#loading__status')?.textContent ?? '';
  const pill = document.querySelector('#player__buffering-peers')?.textContent ?? '';
  const bufferingHidden = document.querySelector('#player__buffering')?.hidden ?? true;
  const errorOpen = !!document.querySelector('#error')?.open;
  const errorText = document.querySelector('#error__description')?.textContent ?? '';
  return JSON.stringify({
    currentTime: v ? +v.currentTime.toFixed(2) : null,
    paused: v ? v.paused : null,
    readyState: v ? v.readyState : null,
    status, pill, bufferingHidden, errorOpen, errorText
  });
})()`;

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

const targets = await getJson("/json/list");
const page = targets.find((t) => t.type === "page");
const s = new Session();
await s.open(page.webSocketDebuggerUrl);
await s.send("Page.enable");
await s.send("Runtime.enable");

log("navigating to", SITE, "(fresh load — guarantees zero cached state)");
await s.send("Page.navigate", { url: SITE });
await sleep(4000);
log("version:", await s.evaluate("window.env && window.env.version"));

if (!MAGNET) { log("no MAGNET given — stopping after load"); s.close(); process.exit(0); }

// #onMagnetInput auto-submits (and clears the field) the instant a complete
// magnet URI is recognised in the 'input' event — a separate click on
// #torrent__submit right after would race the already-started flow. Setting
// the value is the whole interaction; no click needed.
log("setting magnet value (auto-submits on complete magnet URI)");
const setResult = await s.evaluate(`(() => {
  const input = document.querySelector('#torrent__magnet');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(MAGNET)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return document.querySelector('#loading')?.open ?? false;
})()`);
log("auto-submit fired, loading dialog open:", setResult);

const startedAt = Date.now();
const history = []; // { tMs, status, pill }
let playingAt = null;

for (let i = 0; i < 240; i++) { // up to 4 minutes @ 1s resolution
  await sleep(1000);
  const raw = await s.evaluate(STATE_EXPR);
  const st = JSON.parse(raw);
  const tMs = Date.now() - startedAt;
  history.push({ tMs, status: st.status, pill: st.pill, currentTime: st.currentTime, paused: st.paused });
  if (i % 5 === 0 || st.status !== history[history.length - 2]?.status) {
    log(`t+${(tMs / 1000).toFixed(1)}s status=${JSON.stringify(st.status)} pill=${JSON.stringify(st.pill)} currentTime=${st.currentTime} paused=${st.paused}`);
  }
  if (st.errorOpen) {
    log("ERROR SCREEN:", st.errorText);
    await s.shot("verify-error");
    break;
  }
  if (st.currentTime !== null && st.currentTime > 0.3 && st.paused === false && playingAt === null) {
    playingAt = tMs;
    log(`>>> PLAYBACK STARTED at t+${(tMs / 1000).toFixed(1)}s <<<`);
    await s.shot("verify-playing");
    // Keep sampling a little longer to see the tail of the ETA history.
    await sleep(3000);
    break;
  }
}

fs.writeFileSync(`${OUT}\\verify-eta-history.json`, JSON.stringify({ history, playingAtMs: playingAt }, null, 2));
log("history written to", `${OUT}\\verify-eta-history.json`);
log("console log lines:", s.consoleMsgs.length);
fs.writeFileSync(`${OUT}\\verify-eta-console.log`, s.consoleMsgs.map((m) => `${new Date(m.t).toISOString()} ${m.text}`).join("\n"));

s.close();
