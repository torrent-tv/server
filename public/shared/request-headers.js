/** Correlate API diagnostics with the existing browser log session. */
export function requestHeaders() {
  const sessionId = globalThis.window?.__ttvClientLogger?.sessionId;
  return { "Content-Type": "application/json", ...(sessionId ? { "X-Client-Session": sessionId } : {}) };
}
