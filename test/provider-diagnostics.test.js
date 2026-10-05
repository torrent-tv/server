import test from "node:test";
import assert from "node:assert/strict";
import { errorDetails, providerResponseError, registerDiagnosticSecret, providerFailure, withProviderContext } from "../services/metadata/provider-diagnostics.js";
import { MetadataUnavailableError, RequestGate } from "../services/metadata/RequestGate.js";
import { TmdbSource } from "../services/metadata/TmdbSource.js";
import { ProviderHttp } from "../services/subtitles/ProviderHttp.js";

test("diagnostics preserve original transport cause and redact credentials and URLs", () => {
  registerDiagnosticSecret("test-secret-value");
  const cause = Object.assign(new Error("connect timeout test-secret-value https://download.example/file?token=private"), { code: "UND_ERR_CONNECT_TIMEOUT" });
  const error = new MetadataUnavailableError("provider did not answer", { cause });
  const details = errorDetails(error);
  assert.equal(details[1].code, "UND_ERR_CONNECT_TIMEOUT");
  assert.match(details[1].message, /connect timeout/);
  assert.ok(!JSON.stringify(details).includes("test-secret-value"));
  assert.ok(!JSON.stringify(details).includes("token=private"));
});

test("provider HTTP errors retain exact messages and quota reset time", async () => {
  const response = Response.json({ message: "Download limit reached", reset_time_utc: "2026-10-06T00:00:00Z" }, { status: 406 });
  const error = await providerResponseError(response);
  assert.equal(error.httpStatus, 406);
  assert.equal(error.providerMessage, "Download limit reached");
  assert.equal(error.resetAt, Date.parse("2026-10-06T00:00:00Z"));
});

test("TMDB retains fetch and HTTP failure causes", async () => {
  const gate = { run: task => task() };
  const cause = new TypeError("fetch failed", { cause: Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }) });
  const offline = new TmdbSource({ token: "test-token", gate, fetch: async () => { throw cause; } });
  await assert.rejects(offline.search("movie", "Title", "en-US", 1, { deadlineAt: Date.now() + 1000 }), error => error.cause === cause);
  const refused = new TmdbSource({ token: "test-token", gate, fetch: async () => Response.json({ status_message: "Invalid API key" }, { status: 401 }) });
  await assert.rejects(refused.search("movie", "Title", "en-US", 1, { deadlineAt: Date.now() + 1000 }), error => error.cause.providerMessage === "Invalid API key");
});

test("subtitle HTTP errors keep quota status for the provider and exact text for logs", async () => {
  const http = new ProviderHttp({ origin: "https://provider.example", headers: { "Api-Key": "test-key" },
    fetch: async () => Response.json({ message: "Daily quota exhausted", reset_time_utc: "2026-10-06T00:00:00Z" }, { status: 406 }) });
  await assert.rejects(http.json("/download", { file_id: 1 }), error => error.httpStatus === 406 && error.cause.providerMessage === "Daily quota exhausted" && error.resetAt > 0);
});

test("request contexts remain separate across concurrent provider failures", async () => {
  const lines = [];
  const original = console.warn;
  console.warn = line => lines.push(JSON.parse(line.slice("[provider] ".length)));
  try {
    await Promise.all(["first", "second"].map(id => withProviderContext({ id, headers: { "x-client-session": id } }, async () => {
      await Promise.resolve();
      providerFailure("tmdb", "search", new Error("unavailable"));
    })));
  } finally { console.warn = original; }
  assert.deepEqual(lines.map(line => [line.requestId, line.sessionId]), [["first", "first"], ["second", "second"]]);
});

test("TMDB applies its default rate pause when Retry-After is missing", async () => {
  let calls = 0;
  const now = Date.now();
  const gate = new RequestGate({ concurrency: 1, perSecond: Infinity, queueLimit: 8 });
  const source = new TmdbSource({ token: "test-token", gate, fetch: async () => {
    calls++;
    return Response.json({ status_message: "Too many requests" }, { status: 429 });
  } });
  await assert.rejects(source.search("movie", "Title", "en-US", 1, { deadlineAt: now + 1000 }), MetadataUnavailableError);
  assert.equal(calls, 1);
  assert.ok(gate.pausedUntil >= now + 10_000);
});
