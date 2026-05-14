function isNativeHlsSupported(videoElement) {
  return videoElement.canPlayType("application/vnd.apple.mpegurl") !== "";
}

export function createHlsPlayer(onLog) {
  let hlsInstance = null;

  return {
    clear() {
      if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
      }
    },
    async play(videoElement, manifestUrl) {
      this.clear();

      const HlsClass = globalThis.Hls;
      // Prefer hls.js where available (Chrome/Firefox). Native HLS fallback is for Safari.
      if (HlsClass && typeof HlsClass.isSupported === "function" && HlsClass.isSupported()) {
        const instance = new HlsClass();
        hlsInstance = instance;
        instance.attachMedia(videoElement);
        instance.on(HlsClass.Events.MEDIA_ATTACHED, () => {
          instance.loadSource(manifestUrl);
        });
        instance.on(HlsClass.Events.ERROR, (_event, data) => {
          const details = typeof data?.details === "string" ? data.details : "unknown";
          onLog(`HLS error: ${details}`);
        });

        await new Promise((resolve, reject) => {
          const timeoutId = window.setTimeout(() => {
            instance.off(HlsClass.Events.MANIFEST_PARSED, onManifestParsed);
            instance.off(HlsClass.Events.ERROR, onError);
            reject(new Error("HLS manifest parsing timed out."));
          }, 10_000);

          const onManifestParsed = () => {
            window.clearTimeout(timeoutId);
            instance.off(HlsClass.Events.MANIFEST_PARSED, onManifestParsed);
            instance.off(HlsClass.Events.ERROR, onError);
            resolve();
          };
          const onError = (_event, data) => {
            if (!data?.fatal) {
              return;
            }
            window.clearTimeout(timeoutId);
            instance.off(HlsClass.Events.MANIFEST_PARSED, onManifestParsed);
            instance.off(HlsClass.Events.ERROR, onError);
            const details = typeof data?.details === "string" ? data.details : "unknown";
            reject(new Error(`Fatal HLS error: ${details}`));
          };
          instance.on(HlsClass.Events.MANIFEST_PARSED, onManifestParsed);
          instance.on(HlsClass.Events.ERROR, onError);
        });

        await videoElement.play();
        return;
      }

      if (!isNativeHlsSupported(videoElement)) {
        throw new Error("HLS is not supported by this browser.");
      }

      videoElement.pause();
      videoElement.src = manifestUrl;
      videoElement.load();
      await videoElement.play();
    }
  };
}
