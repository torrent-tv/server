/** Observe loaded media without starting playback or assigning a time limit. */
export function waitForMediaReady(media, { signal, requirePicture = true, unsupportedMessage } = {}) {
  return new Promise((resolve, reject) => {
    const events = ["loadedmetadata", "loadeddata", "canplay", "error"];
    const cleanup = () => {
      for (const event of events) media.removeEventListener(event, check);
      signal?.removeEventListener("abort", abort);
    };
    const finish = (error) => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(signal?.reason instanceof Error ? signal.reason :
      new DOMException("Media preparation cancelled", "AbortError"));
    const check = () => {
      if (signal?.aborted) return abort();
      if (media.error) {
        if (media.error.code === 1) return abort();
        if (media.error.code === 2) {
          return finish(Object.assign(new Error("Media connection failed"), { canRetry: true }));
        }
        return finish(new Error(unsupportedMessage));
      }
      if (media.readyState < 1) return;
      if (!requirePicture) return finish();
      if (!(media.videoWidth > 0 && media.videoHeight > 0)) {
        return finish(new Error(unsupportedMessage));
      }
      // HAVE_CURRENT_DATA proves a decoded frame while playback remains paused.
      if (media.readyState >= 2) finish();
    };
    for (const event of events) media.addEventListener(event, check);
    signal?.addEventListener("abort", abort, { once: true });
    check();
  });
}
