// The forecasts the start and the seek must read alike (torrent-tv/meta#289,
// AC-2), with the verdict each one gets. A stale answer is a seek-only row: the
// start has no seek to compare its question with.
export const readinessTable = [
  { name: "null forecast", readiness: null, verdict: "wait" },
  { name: "absent forecast", readiness: undefined, verdict: "wait" },
  { name: "version 0 forecast that says ready", readiness: { version: 0, ready: true, reason: "trajectory-safe-now" }, verdict: "wait" },
  { name: "version 1 ready", readiness: { version: 1, ready: true, reason: "trajectory-safe-now", delaySeconds: 0, reserveSeconds: 6 }, verdict: "release" },
  { name: "version 1 not ready", readiness: { version: 1, ready: false, reason: "minimum-safe-delay", delaySeconds: 0.4 }, verdict: "wait" },
  { name: "timestamp gap", readiness: { version: 1, ready: false, reason: "media-continuity-unavailable" }, verdict: "fail" }
];
