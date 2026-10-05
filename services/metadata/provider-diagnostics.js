import { AsyncLocalStorage } from "node:async_hooks";
import { readBoundedBody } from "./bounded-body.js";

const contexts = new AsyncLocalStorage();
const secrets = new Set();

export function registerDiagnosticSecret(value) {
  if (typeof value === "string" && value.length) secrets.add(value);
}

function safeText(value) {
  let text = String(value ?? "");
  for (const secret of secrets) text = text.replaceAll(secret, "[redacted]");
  return text.replace(/https?:\/\/[^\s"<>]+/giu, "[URL omitted]")
    .replace(/\b(?:Bearer|Basic)\s+\S+/giu, "[authorization omitted]")
    .replace(/((?:api[_-]?key|token|authorization|password)\s*[:=]\s*)[^\s,;]+/giu, "$1[redacted]")
    .slice(0, 2048);
}

export function errorDetails(error) {
  const result = [];
  const seen = new Set();
  for (let current = error; current && !seen.has(current) && result.length < 4; current = current.cause) {
    seen.add(current);
    result.push({ name: safeText(current.name || "Error"), message: safeText(current.message ?? current),
      ...(current.code ? { code: safeText(current.code) } : {}),
      ...(current.httpStatus ? { httpStatus: current.httpStatus } : {}),
      ...(current.providerMessage ? { providerMessage: safeText(current.providerMessage) } : {}) });
  }
  return result;
}

export function providerFailure(provider, operation, error) {
  console.warn(`[provider] ${JSON.stringify({ ...contexts.getStore(), provider, operation, errors: errorDetails(error) })}`);
}

export function providerOutcome(provider, operation, details) {
  console.log(`[provider] ${JSON.stringify({ ...contexts.getStore(), provider, operation, ...details })}`);
}

export function withProviderContext(req, task) {
  const session = req.headers?.["x-client-session"];
  return contexts.run({ requestId: safeText(req.id),
    ...(typeof session === "string" && /^[A-Za-z0-9-]{1,80}$/u.test(session) ? { sessionId: session } : {}) }, task);
}

/** Read bounded provider diagnostics without retaining request headers or URLs. */
export async function providerResponseError(response) {
  const error = new Error(`provider answered HTTP ${response.status}`);
  error.httpStatus = response.status;
  try {
    const text = (await readBoundedBody(response, 8192)).toString("utf8");
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    error.providerMessage = body ? [body.status_message, body.message, typeof body.error === "string" ? body.error : null,
      ...(Array.isArray(body.errors) ? body.errors.map(item => item?.message ?? item) : [])].filter(Boolean).join("; ") : text;
    if (body?.reset_time_utc) error.resetAt = Date.parse(body.reset_time_utc);
  } catch (cause) { error.cause = cause; }
  return error;
}
