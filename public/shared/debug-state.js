export function getDebugState() {
  const root = /** @type {typeof globalThis & { __TORRENT_TV_DEBUG__?: object }} */ (globalThis);
  if (!root.__TORRENT_TV_DEBUG__ || typeof root.__TORRENT_TV_DEBUG__ !== "object") {
    root.__TORRENT_TV_DEBUG__ = {
      proxies: {
        fetchedAt: "",
        clients: [],
        scored: [],
        selectedBaseUrl: ""
      },
      torrent: {
        fileName: "",
        name: "",
        infoHashHex: "",
        isMultiFile: false,
        files: [],
        media: {
          video: [],
          audio: [],
          subtitles: []
        }
      }
    };
  }
  return root.__TORRENT_TV_DEBUG__;
}
