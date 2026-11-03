/** Bound a proxy snapshot's age at the browser using same-request clock spans. */
export function progressSnapshotAgeRange({ requestStartedAt, responseReceivedAt, requestReceivedAtProxy,
  snapshotAtProxy, responsePreparedAtProxy, requestClockEpoch, snapshotClockEpoch }) {
  return requestSnapshotAgeRange({ requestStartedAt, responseReceivedAt, requestReceivedAtProxy,
    snapshotStartedAtProxy: snapshotAtProxy, snapshotCompletedAtProxy: snapshotAtProxy, responsePreparedAtProxy,
    requestClockEpoch, snapshotClockEpoch });
}

/** Bound a browser-owned capture at response time on the same browser clock. */
export function browserCaptureAgeRange({ requestStartedAt, responseReceivedAt, clockEpoch,
  captureClockEpoch, captureStartedAt, captureCompletedAt }) {
  if (![requestStartedAt, responseReceivedAt, clockEpoch, captureClockEpoch, captureStartedAt,
    captureCompletedAt].every(Number.isFinite) || responseReceivedAt < requestStartedAt ||
      clockEpoch !== captureClockEpoch || captureCompletedAt < captureStartedAt ||
      captureCompletedAt > responseReceivedAt) return null;
  return {
    minimumAgeMs: responseReceivedAt - captureCompletedAt,
    maximumAgeMs: responseReceivedAt - captureStartedAt,
    measuredAtBrowser: responseReceivedAt
  };
}

/** Bound a proxy-owned input through this request's asymmetric transit bounds. */
export function proxyInputAgeRange({ requestStartedAt, responseReceivedAt, requestReceivedAtProxy,
  responsePreparedAtProxy, requestClockEpoch, captureClockEpoch, captureStartedAt, captureCompletedAt }) {
  if (![requestStartedAt, responseReceivedAt, requestReceivedAtProxy, responsePreparedAtProxy,
    requestClockEpoch, captureClockEpoch, captureStartedAt, captureCompletedAt].every(Number.isFinite) ||
      responseReceivedAt < requestStartedAt || responsePreparedAtProxy < requestReceivedAtProxy ||
      requestClockEpoch !== captureClockEpoch || captureCompletedAt < captureStartedAt ||
      captureCompletedAt > responsePreparedAtProxy) return null;
  const roundTripMs = responseReceivedAt - requestStartedAt;
  const minimumAgeMs = responsePreparedAtProxy - captureCompletedAt;
  const maximumAgeMs = roundTripMs - (captureStartedAt - requestReceivedAtProxy);
  if (minimumAgeMs < 0 || maximumAgeMs < minimumAgeMs) return null;
  return { minimumAgeMs, maximumAgeMs, measuredAtBrowser: responseReceivedAt };
}

/** Bound the age of work sampled somewhere inside a proxy-clocked request interval. */
export function requestSnapshotAgeRange({ requestStartedAt, responseReceivedAt, requestReceivedAtProxy,
  snapshotStartedAtProxy, snapshotCompletedAtProxy, responsePreparedAtProxy, requestClockEpoch, snapshotClockEpoch }) {
  if (![requestStartedAt, responseReceivedAt, requestReceivedAtProxy, snapshotStartedAtProxy,
    snapshotCompletedAtProxy, responsePreparedAtProxy].every(Number.isFinite) || responseReceivedAt < requestStartedAt ||
      snapshotStartedAtProxy < requestReceivedAtProxy || snapshotCompletedAtProxy < snapshotStartedAtProxy ||
      responsePreparedAtProxy < snapshotCompletedAtProxy ||
      Number.isFinite(requestClockEpoch) && Number.isFinite(snapshotClockEpoch) && requestClockEpoch !== snapshotClockEpoch) return null;

  const roundTripMs = responseReceivedAt - requestStartedAt;
  const minimumAgeMs = responsePreparedAtProxy - snapshotCompletedAtProxy;
  const maximumAgeMs = roundTripMs - (snapshotStartedAtProxy - requestReceivedAtProxy);
  if (maximumAgeMs < minimumAgeMs) return null;
  return { minimumAgeMs, maximumAgeMs, measuredAtBrowser: responseReceivedAt };
}
