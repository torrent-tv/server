/**
 * @file Receive forwarded browser console logs and write them to the server
 * log, so they are readable with `docker logs` / `ssh do` without copy-pasting
 * eruda output off a phone.
 *
 * Strictly a debugging aid: best-effort, size-capped, no storage. Each line is
 * prefixed with the client's device/browser tag and short session id.
 */

const MAX_LINES = 50;
const MAX_MSG_LEN = 2000;
const MAX_TAG_LEN = 40;
const MAX_SID_LEN = 16;
const MAX_SIGNAL_SID_LEN = 36;

/**
 * @param {unknown} value
 * @param {number} maxLen
 * @returns {string}
 */
function safeString(value, maxLen) {
  const s = typeof value === "string" ? value : "";
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

/**
 * Replace control characters (newlines, escapes, etc.) with spaces so a
 * forwarded line cannot inject fake log lines or terminal escape sequences.
 *
 * @param {string} s
 * @returns {string}
 */
function sanitizeLine(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    out += code < 0x20 || code === 0x7f ? " " : s[i];
  }
  return out;
}

/**
 * POST /api/client-logs
 *
 * Body: { sessionId, tag, userAgent, signalSessionId, lines: [{ level, ts, msg }] }
 *
 * `signalSessionId` is the WebRTC signalling session id — the same id the
 * proxy prints as `[webrtc] Session <id>` — so a proxy-side session id greps
 * straight to this client's lines. Absent until the page opens a WebRTC
 * session (and it changes on reconnect).
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @returns {Promise<void>}
 */
export async function handleApiClientLogsPost(req, reply) {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const tag = safeString(body.tag, MAX_TAG_LEN) || "Unknown/Unknown";
  const sessionId = safeString(body.sessionId, MAX_SID_LEN) || "????????";
  const signalSessionId = safeString(body.signalSessionId, MAX_SIGNAL_SID_LEN);
  const lines = Array.isArray(body.lines) ? body.lines.slice(0, MAX_LINES) : [];

  const prefix = signalSessionId
    ? `[client ${sanitizeLine(tag)} ${sanitizeLine(sessionId)} sig=${sanitizeLine(signalSessionId)}]`
    : `[client ${sanitizeLine(tag)} ${sanitizeLine(sessionId)}]`;
  for (const line of lines) {
    const entry = line && typeof line === "object" ? line : {};
    const level = safeString(entry.level, 8) || "log";
    const ts = safeString(entry.ts, 16);
    const msg = sanitizeLine(safeString(entry.msg, MAX_MSG_LEN));
    console.log(`${prefix} ${ts} ${level}: ${msg}`);
  }

  return reply.code(204).send();
}
