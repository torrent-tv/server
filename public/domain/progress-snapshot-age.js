/** Bound a proxy snapshot's age at the browser using same-request clock spans. */
export function progressSnapshotAgeRange({ requestStartedAt, responseReceivedAt, requestReceivedAtProxy,
  snapshotAtProxy, responsePreparedAtProxy }) {
  return requestSnapshotAgeRange({ requestStartedAt, responseReceivedAt, requestReceivedAtProxy,
    snapshotStartedAtProxy: snapshotAtProxy, snapshotCompletedAtProxy: snapshotAtProxy, responsePreparedAtProxy });
}

/** Bound the age of work sampled somewhere inside a proxy-clocked request interval. */
export function requestSnapshotAgeRange({ requestStartedAt, responseReceivedAt, requestReceivedAtProxy,
  snapshotStartedAtProxy, snapshotCompletedAtProxy, responsePreparedAtProxy }) {
  if (![requestStartedAt, responseReceivedAt, requestReceivedAtProxy, snapshotStartedAtProxy,
    snapshotCompletedAtProxy, responsePreparedAtProxy].every(Number.isFinite) || responseReceivedAt < requestStartedAt ||
      snapshotStartedAtProxy < requestReceivedAtProxy || snapshotCompletedAtProxy < snapshotStartedAtProxy ||
      responsePreparedAtProxy < snapshotCompletedAtProxy) return null;

  const roundTripMs = responseReceivedAt - requestStartedAt;
  const minimumAgeMs = responsePreparedAtProxy - snapshotCompletedAtProxy;
  const maximumAgeMs = roundTripMs - (snapshotStartedAtProxy - requestReceivedAtProxy);
  if (maximumAgeMs < minimumAgeMs) return null;
  return { minimumAgeMs, maximumAgeMs, measuredAtBrowser: responseReceivedAt };
}
