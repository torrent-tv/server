## 0.1.0

- **New**: WebRTC signalling server — replaced direct HTTP proxy registration with a WebSocket tunnel endpoint. The server brokers SDP offer/answer and ICE candidates between browser and proxy; all video data flows directly over the WebRTC data channel.
- **New**: `npm run patch / minor / major` scripts — bump the package version, build and push a versioned Docker image (`ghcr.io/torrent-tv/server:<version>` + `:latest`), and push git tags in one command.
