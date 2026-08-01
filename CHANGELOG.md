## 0.8.89

- **Fix**: "estimating…" is gone — a time is now always shown. It was displayed whenever the browser's buffer had not measurably moved yet, which is exactly the moment the viewer most wants a number: right after a seek, and on the first open before any media exists (field logs: `etaSeconds=null` for minutes at a stretch while the transcode was running at 8x). The estimate now falls through a ladder of real measurements, each a coarser view of the same quantity — (1) the buffer's own measured fill rate, (2) the proxy's production rate (ffmpeg's realtime multiplier) capped by what the measured link can carry (`outputMbps` vs the client's own net-report sample), (3) the download stage (bytes still missing ÷ torrent speed), (4) a deliberately conservative realtime floor when literally nothing has reported yet. Verified against the exact field numbers that previously produced no estimate: all now yield sensible times (a post-seek stall reads 16 s, link-limited; a download-only first open reads 5 s).
- **Fix**: The first-open screen and the seek overlay now show the same information, as intended when they were unified. Both stages are always described — supply (peers / speed / bytes still needed) AND playback readiness (percent of the required cushion / seconds of media still needed) — one per line, with the single end-to-end time last. Previously the readiness line REPLACED the supply line the moment a transcode session existed, so the two screens legitimately showed different things for the same state; the pre-buffer tail additionally passed no download stats at all, so its supply line was always missing.
- **Fix**: Wording — "43 seconds until playback" rather than "~00:43 to playback".

## 0.8.88

- **Fix**: The buffering/loading text could still read "100% • starting now" for up to ~10 more seconds than the player actually needed — a second bug in the same area as 0.8.87's buffer-based rework. `#computeUnifiedEta`'s displayed cushion percent/ETA divided by a FIXED 15 s target, while the actual gate that reveals the player (`#waitForPrebuffer`) uses an ADAPTIVE target (6-25 s) derived from the measured production+delivery margin over realtime — under a weak margin the real gate needs up to 25 s, so the display could claim "ready" 10 s before the real gate agreed. Both now share one function (`#adaptiveCushionTarget`) and one fill-rate measurement (`#trackBufferFillRate`), so the number shown and the gate that reveals the player can no longer disagree about what "ready" means at the same instant. `#waitForPrebuffer`'s own status text (previously a separate, bare "Buffering... 9 / 15 s" line, bypassing all the formatting/percent/ETA work done for the rest of the loading flow) now polls the same live transcode progress the mid-playback buffering pill polls and renders it through the same formatter — first-open, this pre-buffer tail, and a later seek now show byte-identical text for the same underlying state, not three independent approximations.
- **Fix**: Durations were abbreviated ("2m 30s") instead of spelled out; now "2 minutes 30 seconds", "1 hour 5 minutes", singular/plural handled ("1 second", "2 seconds").
- **Fix**: The stage description and the "time to playback" figure were joined with " • "; now a line break, matching how the loading screen's own multi-line status already separated them (the buffering pill's CSS gained `white-space: pre-line` to actually render it — it had none, so a literal newline was previously collapsing into a space there).

## 0.8.87

- **Fix**: The loading/buffering text claimed things that were not true. Field-reported: "Transcoding — 100% • starting now" shown for minutes on a player that never started, and "Transcoding — 0% • starting now" (0% and "starting now" at the same time). Both percentages came from the PROXY's encode progress, which sits upstream of where playback is actually decided — after a seek ffmpeg had produced 110 s of content, a legitimate "100%" by that measure, while the browser's buffer sat at 0.0 s because the segments were being rejected on arrival (the underlying defect is fixed in proxy 2.9.54). A progress figure taken upstream of the failure point can always disagree with what the viewer sees; one taken at the buffer cannot. Progress and the estimate are now both measured at the browser's own buffer: percent = buffered-ahead / target, "still needed" = the remaining seconds of media, and the time estimate = that remainder divided by the MEASURED rate at which the buffer is filling (the end-to-end rate of the whole pipeline, so it prices in every bottleneck at once, including ones no single stage can see). Before any media exists — the first open — the time still required to download what has to arrive is used as a sound lower bound instead. When nothing measurable is available the text reads "estimating…"; "starting now" is now only ever printed for a buffer that has genuinely reached the target.
- **Fix**: Durations were shown in clock notation with no units — "~00:08" for an eight-second wait, which reads as a timeline position rather than a wait. Now "8s", "2m 30s", "1h 5m"; minutes are always paired with their seconds and never given as a fraction.
- **Fix**: The encoder speed was printed as "0.00757x realtime" — five decimals, against an explicit one-decimal rule, and a meaningless number besides: ffmpeg's `speed` is a cumulative average over the run, so the first samples after a (re)start reflect process start-up rather than encoding (that same 0.00757x sample also produced a "~32:56 to playback" estimate for a 15 s cushion). The multiplier is now withheld entirely until the run has produced enough content for the average to mean anything, and then shown to one decimal.
- **Fix**: Opening a torrent and resuming after a seek now show the same information, built by the same code — the same metrics and the same single end-to-end "time until playback" figure. The initial loading screen previously computed its own narrower "time to next phase", which answered a different question and could disagree with what the seek overlay reported for the same session.

## 0.8.86

- **Fix**: The buffering pill's percent/seconds could still appear frozen even with proxy 2.9.53's `processedSeconds` fix in place — a second, independent client-side bug. `#showBuffering()` had no guard against being re-entered while its own `poll()` was still in flight (e.g. a seek-settle debounce firing, then a later `stalled` event re-arming its own debounce a few seconds after — two real, separate events from the same scrub): each call started its own `poll()` with no ordering guarantee against the other, so a slower, now-stale response could land AFTER and overwrite a fresher one's DOM write, making the displayed number appear to freeze or jump backward even though the underlying data was updating correctly. Added `#bufferingEpoch`, bumped on every `#showBuffering()`/`#clearBuffering()` call and captured per-`poll()`; a response only reaches the DOM while its epoch is still current. Verified against the field symptom, and against a live proxy 2.9.53 session (real AVI file, forced video re-encode, real seek): `processedSeconds`/`percent` now both confirmed monotonically increasing post-seek (320→330→350→364→380→390 over 12s at a matching ~3.3-3.9x encode speed) with this race no longer able to hide it.

## 0.8.85

- **Fix**: The INITIAL loading screen (before playback has ever started — "Preparing first segment...") still showed its own separate first-4-second-segment percent instead of the cushion percent/remaining-seconds the mid-playback buffering pill switched to in 0.8.81-0.8.83 — field-reported gap: the pill's rework was never migrated to this screen, so the same session could show two different, disagreeing percent figures depending on whether the viewer was on the initial load or a later re-buffer. `#renderTranscodeProgress` now calls the same `#computeUnifiedEta` + `#formatTranscodeStageText` the pill uses, so both surfaces always show identical figures for the same underlying progress. Requires proxy 2.9.53 for the figures to also be numerically correct on re-encoded (video-transcode) sessions specifically — see that proxy release for the root cause (a timeline mismatch in `processedSeconds` that made the transcode percent read as stuck near 0% for a long stretch during/after a seek, independent of this display-unification fix).

## 0.8.84

- **Fix**: A WebRTC transport that died WHILE a file was still loading (before playback ever started) surfaced as a hard, non-retryable error — field-diagnosed from iPhone sessions where ICE connected then died ~6 s later. Root cause: `#onTransportLost`'s automatic reconnect ladder deliberately bails out while a loading flow is in flight (`#isProcessing`), on the assumption the loading flow's own failure path handles it — but that path just let the resulting "Data channel closed." / "Data channel is not open." rejection (from source registration or the playback-plan poll) propagate as a plain fatal error, `canRetry` defaulting to false. Both call sites now recognize a transport-closed error and convert it into the same retryable, resume-armed stall already used for data starvation, with an accurate "Connection to the proxy was lost." message — Retry re-enters the loading flow and acquires a fresh proxy (`#acquireTransport` never reuses a dead one).

## 0.8.83

- **Fix**: The buffering pill's transcode-stage detail still leaked a whole-file figure ("2:16:49 of file left") alongside the near-term cushion percent/ETA — confusing even when labeled, since it answers a different question than "how long until playback." Replaced it with `cushionRemainingSeconds` — content-seconds still needed to finish the SAME near-term resume cushion the percent and the unified ETA already target (e.g. "9s left to encode"), not a wall-clock whole-file duration. Every figure in this line (percent, seconds-to-encode, ETA) now answers exactly one question — "how long until I can watch" — with nothing about the rest of the file.

## 0.8.82

- **Chore**: Temporary diagnostic logging for `#computeUnifiedEta` — every computation logs its raw inputs (processed/start-position seconds, parsed encode speed, output bitrate, client link Mbps) and result (`cushionPercent`, `etaSeconds`) via `console.debug`, tagged `[eta]`. Already reaches the server log through the existing client-logger forwarder (no device access needed to inspect a field report) — added to verify a "0% while nowhere near ready" report empirically instead of by re-reading the formula.

## 0.8.81

- **Fix**: The buffering pill's transcode-stage percent could read as nonsense — e.g. "Transcoding — 0% (22:39 left) • starting now" — because the percent was the WHOLE-FILE percent, which sits at "0%" for minutes on a long file even once the near-term resume cushion is long satisfied (e.g. a fast copy-mode transcode can produce many MINUTES of output in under a second, so the unified ETA correctly reads "starting now" while the whole-file percent, denominated over hours, still rounds to "0%"). The percent shown next to the unified ETA is now `cushionPercent` — progress toward the SAME near-term cushion the ETA targets — so the two numbers can never visually disagree again; the whole-file remaining time is still shown, now explicitly labeled "of file left" to avoid being read as "time until playback."

## 0.8.80

- **New**: The unified "time until playback" estimate now also shows on the INITIAL loading screen (first open, before playback has ever started), not just the mid-playback buffering overlay — both "Fetching file metadata..." (download-stage) and "Preparing first segment... / Starting transcoder..." (transcode-stage) now show the same `#computeUnifiedEtaSeconds` figure instead of their own narrower, separately-computed ETAs (the metadata phase's header-download-only estimate, the transcode phase's first-segment-only estimate) — one canonical formula everywhere a "how long until I can watch" figure is shown.
- **New**: Unified "time until playback can resume" estimate in the buffering pill, combining all three pipeline stages that can each independently gate it — download (bytes remaining in the resume window at the current torrent speed), transcode (content-seconds needed for the near-term resume cushion at ffmpeg's own realtime speed multiplier), and delivery (the same cushion at the proxy→client link's own throughput relative to the stream's output bitrate, using the client's own already-measured net-report sample — no new round trip). The three are pipelined, so the true bottleneck is whichever is currently slowest: the result is the max of whichever stages are actually measurable right now, shown as `~mm:ss to playback` appended to whichever per-stage line is active. Per-stage "left"/time figures that answered a narrower or duplicate question were dropped in favor of this single estimate (the per-stage lines now show magnitudes only — bytes left, percent, speed). Requires proxy 2.9.49+ for the delivery stage (falls back to download+transcode only on older proxies).

## 0.8.79

- **New**: A distinct transcode-stage buffering display. Once a transcode session exists for the active file, the buffering pill switches from the download metric (peers/speed/bytes-left, no longer the meaningful number once ffmpeg is actively producing segments) to `Transcoding — 42% (01:20 left, 2.4x realtime)` — freshly re-fetched every poll (1.5s), so the percentage stays live rather than freezing. Falls back to the download display when there is no active transcode session yet (or it failed), and omits the speed/time details when ffmpeg has not reported them yet (`N/A`). Uses the proxy's existing `/api/transcode-sessions/:id/progress` endpoint (no proxy change needed).
- **Fix**: The "left to download" figure in the buffering pill could jump UP mid-poll instead of counting down, because it tracked the proxy's LIVE (moving) read position — the window slides forward as the file is read/transcoded further, and could slide into a fresh, never-downloaded piece, making the figure jump even though nothing regressed. The client now captures the proxy's resume-window anchor on the first poll of a buffering episode and pins it for every subsequent poll of that same episode (`&resumeAnchorByteStart=`), so the figure only ever decreases as real download progress happens. Requires proxy 2.9.48+ (older proxies simply echo back the live position each time, same as before).

## 0.8.78

- **New**: While buffering/seeking, the pill now shows how much is left to download before playback resumes and the time to get it — `peers: N • <speed>/s • <amount> left • ~<time>` — instead of only the peer count. The amount comes from the proxy's resume window: the bytes still to download in the 16 MB window ahead of the file's current read position, counted byte-accurately (partial pieces) so it moves smoothly rather than jumping by a whole piece. Falls back to seconds-buffered if the proxy does not report it (needs proxy 2.9.46+).

## 0.8.77

- **New**: The buffering/seeking pill now shows more than the peer count. While the video is stalled it polls live stats (~1.5 s) and displays `peers: N • <download speed>/s` plus a time-to-resume estimate — `starts in ~Ns`, computed from how fast the buffer is filling toward the cushion playback needs — or `Ns buffered` when the buffer is not growing. Previously it showed only a one-shot peer count.

## 0.8.74

- **Fix**: The peer-count pill under the buffering spinner no longer shifts the spinner when it appears or disappears. It now stays in the layout — toggled with `visibility` (its line reserved with a non-breaking space) instead of being removed with `display:none` — so the centered spinner holds its position.

## 0.8.73

- **Fix**: The "To next phase" line on the loading screen now shows only the ETA, not a percent — the header/index is a handful of whole pieces, so the percent jumped 0 → 50 → 100 and read as broken. (The progress bar underneath is unchanged.)
- **Fix**: Custom control-bar buttons (share, close, playlist) are no longer rendered black/invisible in the light theme. They read their background from media-chrome's `--media-control-background` (a fixed dark value that leaks in from the surrounding `<media-control-bar>`), which won over the theme-aware fallback; they now use our own `--media-secondary-color` directly, so the plate follows the light/dark theme like the rest of the player.
- **Fix**: Error-screen action buttons that wrap onto a second row (e.g. Retry / Back to episodes / New Torrent on a narrow phone) are now spaced vertically the same 1rem as the horizontal gap between buttons — previously the wrapped row sat flush against the row above it.
- **Fix**: Opening a share link with a resume position (`?…&currentTime=<sec>`) now shows a SINGLE loading screen and starts playback directly at that position, instead of loading from the start, revealing the player, and only then seeking — which restarted the transcode at the target and produced a second loading screen. The resume position is now passed to hls.js as `startPosition`, so the proxy's server-side seek produces the segment at that offset and the pre-buffer fills there before the player is revealed. The post-reveal one-shot seek is consumed on the transcode path so it never runs a second time.

## 0.8.70

- **Fix**: The buffering/seeking spinner now appears on iPhone in the on-page (non-fullscreen) player when scrubbing while PAUSED into not-yet-downloaded data — previously the frame just froze with no indication. The spinner was shown only when `readyState < 3`, but iOS native HLS keeps `readyState` optimistically high during a paused seek, so it never triggered. It now also shows while a seek is in progress (`video.seeking`), which is reliable across browsers. Additionally, pausing/resuming DURING an unfinished seek no longer hides the spinner — it stays until the seek actually completes (`seeked`), so "start seek → pause → play → pause" while the target data is still loading keeps the indicator visible. (The spinner already clears on file switch, and on the picker/loading/error screens.)

## 0.8.69

- **Chore (security)**: Updated `@fastify/static` 9.x → 10.1.2, fixing a HIGH-severity advisory — authorization bypass via non-canonical URL paths and route-guard bypass via path traversal (GHSA-8pvw-jcv7-9cmj, GHSA-83w8-p2f5-377r); `npm audit` was stuck on 9.x (no backported patch). The v10 major changed the static `setHeaders` callback to receive the Fastify **reply** instead of the raw `ServerResponse`, so `res.setHeader(...)` → `reply.header(...)` (static serving would otherwise throw and serve nothing). Server audit is now clean (0 vulnerabilities). (Proxy still carries 8 high from the transitive `ip` package — no upstream fix exists for any `ip` version; npm's only "fix" is an unacceptable webtorrent downgrade, so it is left and tracked.)
- **Fix**: A shared link (`?magnet=…`) now auto-starts playback instead of landing on the picker. `#loadFromUrl` ran synchronously in the Torrent constructor, so the `MAGNET_READY` / `FILE_DETAILS_READY` it dispatched could fire before the other components (torrent-tv, loading, player) had registered their listeners — the event was lost and the shared link opened the start page. It is now deferred to the next macrotask, after every component has bootstrapped.
- **New**: Share links carry the file index (`&fileIndex=<n>`) for a multi-file torrent, so the recipient opens the SAME file directly instead of the playlist. The receiver parses `fileIndex` and plays that video file (falling back to the playlist when absent or invalid).
- **Chore**: Uniform naming for the shared playback position across every layer — URL query, events and all variables are now `currentTime` (matching `video.currentTime`, the value's source and sink), replacing the previous `t` / `resumeSeconds` / `#pendingResumeSeconds` mix. Same for the file: `fileIndex` everywhere. Also removed single-letter variables in the touched code (`b64`→`torrentBase64`, loop `i`→`index`, tracker `t`/`s`/`tr`→`candidate`/`trackerString`/`tracker`).

## 0.8.67

- **Fix**: Buffering peer-count pill no longer clips its text on mobile (the plate was shorter than the glyphs) — added block padding and a line-height. The plate is now slightly transparent and theme-aware (dark by default, light in light theme) so the video shows through.
- **Fix**: The share link for a video opened from a `.torrent` FILE is now a compact magnet instead of a multi-kilobyte URL that browsers truncate. Previously the link embedded the entire `.torrent` file base64-encoded (`?torrent=<base64>`), easily exceeding the URL length limit so the pasted/opened link was cut off and unusable. The share link now always builds a `?magnet=…` — for a `.torrent` source it constructs the magnet from the parsed infohash plus the name and trackers (`magnet:?xt=urn:btih:…&dn=…&tr=…`, ~200 chars); the receiver's proxy fetches the metadata from the swarm/DHT, the same path a normal magnet already uses. Trade-off: a magnet needs live peers/DHT to resolve, but a dead torrent could not be played from the embedded file either. (announce-list trackers left as raw bytes by the bencode parser are decoded as UTF-8.)

## 0.8.66

- **New**: Share a stream **with or without a time position**. The player's share button now opens a small menu with two choices: "Copy link from start" (the plain `?magnet=…`/`?torrent=…` link) and "Copy link at current time", which appends `&t=<seconds>` for the current playback position. When someone opens a `&t=` link, the receiver parses it, threads it through the load flow, and seeks there once the player is revealed and the media is seekable (the synthetic VOD playlist makes the full duration known immediately). Works for both magnet and uploaded-`.torrent` shares; `t` is stripped from the address bar on load like the source param. Best-effort for multi-file torrents (the link carries no file index — resume applies to the first file played). Menu is a light-dismiss popover positioned over the button.

## 0.8.65

- **New**: "Copy share link" button in the player. Copies a URL for what you are watching — `<origin>/?magnet=…` for a magnet source, `?torrent=…` for an uploaded `.torrent` — to the clipboard, to drop into a messenger. The address bar cleans the source param on load, so this reconstructs it. Built on the existing magnet-in-URL handling + the Clipboard API; the recipient lands via the normal magnet flow (any proxy). Brief "Link copied" affordance on click. (Position-resume — sharing from the current timestamp — is a follow-up that ties into the cross-device handoff item.)

## 0.8.64

- **New**: Reworked the loading/seeking indicator. Replaced media-chrome's `<media-loading-indicator>` (which did not fire for our stream) with our OWN detection: the loading component watches the video's `waiting`/`stalled`/`seeking` events and drives a `PLAYER:SET_BUFFERING` event, so the indicator now also shows on a **paused** seek (scrubbing on a paused player) into not-yet-downloaded data. The overlay is a bare, centered white spinner (the "growing arc" css-loaders l20, thin 0.3rem stroke) with a small peer-count pill below it — shown only once the count is known — instead of the previous "Buffering — downloading (peers: N)" text plate. Sits in the centered-chrome slot with `noautohide`, so it stays visible while the controls fade and renders in desktop/Android fullscreen. (iPhone fullscreen and Picture-in-Picture are the OS-native player with no page DOM — iOS shows its own native spinner there.)

## 0.8.63

- **New**: Loading/seeking is now clearly visible in every mode — on-page AND fullscreen. Added media-chrome's standard `<media-loading-indicator>`: a spinner driven by the player's own buffering state (`waiting`/`readyState`), so it shows on a seek into not-yet-downloaded data as well as on a mid-playback buffer, stays up independent of the control-bar autohide, and renders in fullscreen (fullscreen is on `media-controller`, so the overlay is intact). Previously a fullscreen seek just froze the frame with no indication, and the buffering notice vanished with the controls after 2 s even though loading continued.
- **Fix**: The "Buffering — downloading (peers: N)" notice no longer disappears with the control bar. It now carries `noautohide`, so media-chrome keeps it visible while the controls fade (it was in the autohiding `centered-chrome` layer). It sits just below the spinner as the peer-count context. (PiP is unavoidably excluded — the Picture-in-Picture window renders only raw `<video>` frames, no page DOM; the browser shows its own native buffering spinner there.)

## 0.8.62

- **Fix**: Honest loading status during proxy acquisition. "Selecting best proxy by available load metrics…" previously sat over the whole acquire step — the (instant) pick plus the WebRTC connect (ICE/STUN + DTLS + liveness ping) — overstating both the wait's cause and what is actually known (proxy bandwidth is not measured). The status now splits: a brief "Selecting proxy…" for the pick, then "Connecting to proxy…" for the round-trip connect (the selector signals the phase change via an `onConnecting` callback).
- **Fix**: A slow torrent (few peers) no longer fails as a fatal, non-retryable error at startup. While polling the playback plan, a transient "Data channel request timed out" — the proxy busy waiting on pieces, connection still healthy — is now treated as "keep waiting" instead of dropping to the error screen; the live peer/speed/progress line stays on screen the whole time. If the wall-clock budget is genuinely exhausted the error is now **retryable** (Retry restarts the file from the start), because data starvation is a supply problem, not a permanent failure.
- **Fix**: A transient fragment-load error (e.g. seeking into not-yet-downloaded torrent data, or a fragment whose transcode segment is still warming) no longer kills playback or drops the viewer to the loading screen. The hls.js fragment-load retry budget is widened (torrent-backed data can take a moment to arrive), and a fatal network/media error during live playback is now recovered in place (resume load / recoverMediaError, debounced) so hls.js re-requests and lands once the pieces arrive — the mid-playback buffering notice covers the wait.
- **New**: Mid-playback buffering notice. When the buffer drains during playback (data starvation on a slow torrent), a transient "Buffering — downloading (peers: N)" notice is shown over the video instead of a silent freeze — so the viewer sees the torrent is still downloading. It appears only after a short debounce (a normal sub-second wait does not flash it), enriches itself with the live peer count, and clears the moment playback resumes.
- **Fix**: Picking another episode from the error screen now restarts loading instead of showing an empty player. A failed session cleared the parsed torrent details (`session.current`), so after "Back to episodes" the next episode selection hit a null source and silently did nothing. The error teardown now preserves the source for a multi-file torrent (`clear({ keepSource })`) — matching the criterion the error screen already uses to offer "Back to episodes" — while still tearing down the failed stream and proxy; the re-pick reconnects a fresh proxy and re-enters the normal flow.

## 0.8.61

- **Fix**: Recognise many more video containers in a torrent, so files that were skipped with "No video file found in this torrent" now play. Added `.wmv .asf .flv .f4v .ogv .ogm .3gp .3g2 .divx .vob .mts .m2v .m2p .mxf .rm .rmvb .dat` to the video-file list (was mp4/mkv/webm/mov/m4v/avi/mpg/mpeg/ts/m2ts). The list only decides which files are offered as video; playability is already handled downstream — the proxy probes codecs and transcodes to HLS anything the browser cannot decode natively (e.g. WMV/VC-1, FLV/VP6).

## 0.8.60

- **New**: Demo button on the picker — "…or try a demo movie" starts Sintel (2010, Blender Foundation, Creative Commons — legal to stream and screenshot) through the standard magnet flow (field + form, same validation and start path). The magnet carries a webseed, so the demo starts even with few peers. Quiet link-styled tertiary action on its own line under the magnet row (no wrapper elements — the line break is the form's `::after` flex item).
- **New**: Viewer net report — the client side of adaptive bitrate (OpenSpec change `viewer-net-report`; proxy counterpart in 2.9.38). While a transcode session is active, the client posts `POST /api/transcode-sessions/:id/net-report` every ~10 s over the data channel with the rolling MEDIAN of per-segment transfer throughput (30 s window, sub-50 ms samples ignored; median so one stalled fetch cannot crater the estimate) and the player's buffered seconds ahead. The proxy's realtime budget uses this as its viewer-link downshift trigger, so a cellular viewer gets stepped down to a rung their link sustains instead of starving. Best-effort telemetry: failures ignored, reporting stops with the session; each send logs one `[torrent-tv] net-report …` line for field correlation. Requires proxy 2.9.38+ (older proxies 404 the route — harmless).

## 0.8.59

- **Fix**: Same-LAN proxy selection no longer wastes the full 12 s connect timeout before the local-network permission walkthrough appears. When the browser and proxy share a public IP (`sameNetwork`), the public-only attempt can only succeed via router hairpin — which connects within a couple of seconds or never — so its connect budget is now capped at 5 s, then the flow falls through to the permission walkthrough. Remote viewers (different networks) keep the caller's full timeout, where srflx / port-prediction genuinely needs it. Field-measured: a same-LAN session sat ~11.8 s in a doomed public-only ICE attempt before the prompt.
- **Chore**: The chunked-request path logs `[dc] request chunked <method> <path> body=<bytes>B frames=<n>` (delivered via the client-log pipeline), so a large source registration's chunking is observable in the server log without proxy-side access.

## 0.8.58

- **New**: Chunked request bodies over the data channel (OpenSpec change `chunked-request-bodies`). A request body larger than 128 KB (measured in UTF-8 bytes) — notably the source registration, whose body is the base64 `.torrent` of a multi-season pack — is now sent as a `request-start` announcement followed by 64 KB binary frames (the response-frame layout mirrored), with backpressure via the channel's buffered amount, instead of one oversized `channel.send()` that threw "message larger than max-message-size". Small and bodyless requests keep the single-message form. An AbortSignal firing mid-send stops the writer and sends one abort frame so the proxy drops its partial state at once. Requires the proxy to reassemble frames (proxy 2.9.35+); release after it.

## 0.8.57

- **Fix**: Same-LAN connections no longer dead-end on "Data channel closed" without offering the local-network permission. A bare "data channel open" is not proof the channel carries data: on a same-LAN pair the browser can nominate a local path (host ↔ peer-reflexive) even in the public-only attempt — the proxy's LAN address leaks in as a peer-reflexive candidate — and Chromium blocks the SCTP data to that local address without the Local Network permission, so the channel opens and dies within milliseconds. The proxy selector now gates on a `ping` round-trip that proves the channel actually moves bytes; a failure fails the attempt (with the LAN probe URL attached) so the public-only attempt correctly falls through to the local-network permission walkthrough and retries with local candidates, instead of surfacing a non-retryable error. (Diagnosed from a same-LAN Mac/Chrome session via the client-log pipeline.)
- **New**: Cold-start instrumentation and earlier start on a healthy margin (OpenSpec change `cold-start`). Every successful proxy-served start now logs one console summary — `[torrent-tv] cold-start total=… transport=… plan=… prepare=… prebuffer=…` — which rides the client-log pipeline (0.8.55) into the server log, so per-phase startup timings are visible in the field without screen recordings, correlated with the session ids. The prebuffer also starts sooner when delivery has SUSTAINED a healthy surplus (fill rate ≥ 1.35× realtime) over the full 10 s rate window and ≥ 10 s are buffered — cutting up to ~10 s of wall time in the healthy band. Thin-margin behaviour is unchanged (the deeper adaptive target is kept), and the full-window requirement preserves the 0.8.45 anti-stutter guarantee. The prebuffer-ready log line now reports `start=early|target`.

## 0.8.56

- **New**: Automatic reconnect after a mid-playback connection loss (OpenSpec change `auto-reconnect`). Losing the proxy data channel no longer drops the viewer onto the error screen with a manual Retry. Recovery now runs automatically in three levels: (1) **seamless** — the player keeps playing from its buffer while the connection to the SAME proxy is rebuilt in the background, the transport is swapped underneath, and fetching resumes with no visible interruption (the proxy keeps the transcode session warm for ~120 s, so the same playlist continues); (2) **rebuild** — if the same proxy is gone or its session expired, a fresh proxy is selected and the file is replayed with a server-side seek back to the exact position; (3) the **error screen with Retry** only after all automatic attempts fail. The loop is offline-aware (waits for `navigator.onLine` before spending an attempt, so a mobile network transition does not burn retries) and loop-guarded (stops after 3 consecutive loss→recover cycles; 30 s of healthy playback resets the count). Every attempt is logged on the `[torrent-tv]` channel, so the client-log pipeline (0.8.55) delivers reconnect cycles to the server log correlated with the proxy's `[webrtc] Session <id>` lines. Groundwork: the HLS loader now routes through `ProxyTransport` (with a hot-swappable inner WebRTC proxy) instead of holding the raw connection, giving a single seamless swap point.

## 0.8.55

- **New**: Field-debugging log correlation (OpenSpec change `client-log-collection`). The browser log forwarder now carries the WebRTC signalling session id — the same id the proxy prints as `[webrtc] Session <id>` — so a single grep joins the three views of one session (browser ↔ proxy ↔ server). The client records the id when the server assigns it (and again on reconnect), tags every log batch with it, and the server prints it in the per-line prefix (`[client <device>/<browser> <page-id> sig=<session-id>]`). The one-time announce line now also reports the app version, viewport size and coarse connection type (`ver=… vp=… net=…`) — the context that shapes the transcode target. Debugging aid only: best-effort, capped, no storage. (Most of the pipeline — console tee, ring buffer, batched POST + `sendBeacon`, server ingestion — already existed; this change adds the missing correlation and startup context.)

## 0.8.54

- **New**: Prompt-free-first local-network flow (OpenSpec change `local-network-flow`). The WebRTC connection first tries only the proxy's PUBLIC addresses — the browser then never touches the viewer's local network and never shows the "local network" permission question; a same-LAN viewer connects through the router's public side when the router can loop packets back inside (most home routers can). Only when that attempt fails (12 s) does the flow involve the proxy's local address: if the browser has the permission mechanism and it is not yet granted, the loading view explains why access is needed and an **Allow** button click performs the local request that makes the browser show its own question (a click also makes the question appear reliably); a previously-denied state shows guidance to the site settings plus **Check again**. Browsers without the mechanism (Firefox) retry immediately with no extra UI. The automatic on-connect permission probe is removed — the question can no longer pop up unexplained.

## 0.8.53

- **Fix**: WebRTC works again on Chromium 152+ (currently Canary; will reach stable Chrome). Chromium 152 embeds its SCTP INIT in the SDP offer (`a=sctp-init`, zero-RTT association). The proxy's libdatachannel does not understand the attribute and echoes it verbatim in its answer, so the browser believed a (bogus, self-mirrored) zero-RTT association was established — no SCTP ever hit the wire, and the channel died ~5 s after the DTLS handshake ("Data channel closed" on every attempt, same LAN or not, permission irrelevant). Diagnosed end-to-end via CDP-driven runs + tcpdump on the proxy host + SDP capture; confirmed by stripping the attribute in-page before implementing. The browser now strips `a=sctp-init` from the copy of the offer sent to the proxy; the answer then lacks it and the browser falls back to the classic in-band SCTP INIT handshake, which works. To be removed once libdatachannel handles (or at least does not echo) the attribute — upstream issue to file.

## 0.8.52

- **Fix**: Same-LAN WebRTC playback (viewer on the proxy's own network) is restored. Proxy log proved the mechanism: ICE connects over the LAN private pair, but the browser blocks WebRTC DATA (SCTP) to a private address without the Local Network permission — so the channel carries nothing and drops after ~5 s. Removing the preflight in 0.8.51 also removed the only thing that requested local-network access, so Chrome stopped even offering the permission toggle — leaving same-LAN unfixable. A preflight is back, done right: `fetch(healthz, { targetAddressSpace: "local" })`, which opts into the Local Network Access flow (not blocked as mixed content like the old plain fetch) so the browser prompts for / applies the permission, and **fire-and-forget** (never awaited → no ICE stall, unlike ≤0.8.49). Cross-network viewers still connect over the public path. Proper priming UI (explain before the prompt; guidance when denied) is the next step.

## 0.8.51

- **Chore**: Removed the Local-Network-Access / PNA preflight fetch (`GET http://<lan-ip>:9090/healthz`) entirely. It was meant to grant the browser permission before ICE tried the proxy's private candidate — but that permission gates `fetch`/WebSocket, NOT WebRTC ICE, so it almost certainly never affected the connection; and it is now blocked by mixed content regardless (grants nothing). Its only live effects were a confusing Local Network prompt and, until 0.8.50, an 8 s stall. WebRTC ICE applies the proxy's candidates directly. If a same-LAN connection turns out to genuinely need the Local Network permission, it will be handled properly (a working `targetAddressSpace` preflight + priming), not with this broken fetch. The `[ice]` diagnostics stay for now.

## 0.8.50

- **Fix**: WebRTC now connects without an 8-second stall (and the failures it caused). ICE candidate application was awaited behind the Local-Network-Access preflight fetch to the proxy's LAN address — but that fetch is blocked by mixed content (HTTPS page → plain-http LAN address) so it grants nothing and simply hangs until its 8 s timeout, during which ICE checked NO candidates (not even the public ones that actually connect). Field trace showed `iceConnectionState=checking` starting only after `PNA preflight FAILED (8015ms)`, and the late-nominated pair then dropping the data channel. Candidates are now applied immediately; the preflight stays fire-and-forget. The proper Local-Network-Access handling (working preflight via `targetAddressSpace`, permission priming for same-LAN) is a separate follow-up.

## 0.8.49

- **Chore**: WebRTC/ICE diagnostics (temporary), forwarded to the server log, to pin down the Local Network Access failure without guessing. Logs each local/remote ICE candidate as `type/protocol/scope` (host/srflx/relay, udp/tcp, v4-private/v4-public/v6 — no raw IP), the `iceConnectionState`/`iceGatheringState`/`connectionState` transitions, the PNA preflight fire + OK/FAIL + timing, and the nominated/succeeded candidate pair on connect or failure. No behaviour change.

## 0.8.48

- **Fix**: Reverted the 0.8.47 change that dropped the proxy's private ICE candidates for viewers the server did not classify as same-network — it broke genuine same-LAN playback. `sameNetwork` has false negatives (e.g. the browser reaches the server over IPv6 while the proxy's reported endpoint is IPv4, so the public IPs don't compare equal), and for a real same-LAN viewer the private host candidate is the ONLY working path — dropping it fails the WebRTC connection outright. The candidate filter is removed; a safer Local-Network-Access fix (not gated on the fragile same-network guess) will follow. The 0.8.47 error-screen buttons and dead-player guard are kept.

## 0.8.47

- **Fix**: Viewers not on the proxy's own network are no longer blocked by the browser's Local Network Access gate. The proxy advertises private host ICE candidates (e.g. `192.168.x`); for a cross-network viewer those can never connect and only trip Chrome's Local Network permission — which stalls the whole WebRTC connection until granted (seen in the field: a viewer in another city got "Data channel closed" until they manually allowed local network + reloaded). The browser now drops the proxy's private candidates unless the server reports the viewer shares the proxy's network (`sameNetwork`); the public path connects with no permission prompt. Same-network viewers keep the private candidates (their working path).
- **Fix**: The error screen no longer traps the user. "New Torrent" is now always offered, and multi-file torrents additionally get "Back to episodes" (previously exactly one button showed, so a multi-file torrent had no way to load a different torrent). "Choose File" was renamed to "Back to episodes" (it returns to the episode list, not a file picker).
- **Fix**: A stream that never delivers any data (dead transport — e.g. a WebRTC connection blocked by the Local Network gate) now surfaces a clear, actionable error instead of a dead, unresponsive player. The pre-buffer fails when its timeout elapses with nothing buffered, rather than firing PLAYBACK_READY over an element that can never play.

## 0.8.46

- **Fix**: A cancelled or superseded playback attempt can no longer kill live playback with an error screen. A data-channel request from an abandoned attempt used to sit until its 60 s timeout, then reject and surface "Data channel request timed out." over whatever had started playing since. Two guards: (1) the WebRTC data-channel `fetch` now honours its `AbortSignal` — Cancel (and any teardown) rejects in-flight requests immediately with an `AbortError`, which the flow already swallows silently; (2) each playback attempt carries an epoch, and a failure whose epoch is no longer current is logged and dropped instead of shown. (Diagnosed from the field: a request from a cancelled start rejected 60 s later and replaced a playing video with the error screen.)
- **New**: The Quality menu now appears for **any** proxy-served video whose source resolution is known — including a codec the browser can play directly. **Auto** keeps the direct copy (best quality, no transcode); picking a resolution deliberately forces a downscaling re-encode, to save bandwidth on a slow link (the case where a direct-play stream's bitrate is too high for the connection). Only downscales are offered; the source resolution is the ceiling. (Previously the menu showed only when the video was already being transcoded.)
- **Fix**: On desktop the magnet form no longer stretches wider than the description text above it — the form is capped to the same width as the abstract, so the input+button row aligns with the copy.

## 0.8.45

- **Fix**: The quality menu never appeared because the playback-plan fetch (`prepareProxyPlaybackPlan`) dropped the proxy's `videoWidth`/`videoHeight` — it rebuilt the plan object with only a fixed set of fields, so the browser always saw a source height of 0 and hid the menu (no settings gear). The plan now carries the source resolution through, so the Quality submenu (Auto + forced resolutions ≤ source) shows for transcoded video as intended (needs proxy 2.9.32). Manual-quality feature was otherwise complete in 0.8.44.
- **Fix**: No more stutter in the first ~35 s of a transcoded stream. The pre-buffer measured its fill rate over a 1.5 s window, but segments arrive in bursts every ~4–11 s on a warming/CPU-contended encoder, so a single arriving segment read as "3× realtime", collapsed the adaptive cushion to the 6 s minimum, and playback started with ~8 s that then drained (repeated stalls until the encoder caught up). The fill rate is now averaged over a 10 s window and trusted only once it spans ≥5 s of wall time — so it reflects sustained production, not a spike — and the pre-buffer timeout is raised to 45 s so a full cushion can build on a slow start. Net effect: a bit longer on the buffering screen, then smooth playback instead of ~35 s of hiccups.

## 0.8.44

- **New**: Manual quality menu in the player (OpenSpec change `transcode-quality`, part 4; needs proxy 2.9.32). When the video is being transcoded, the settings menu gains a **Quality** submenu: **Auto** (the proxy's realtime budget decides) plus forced resolutions at or below the source (`{source}p (source)`, then 1080/720/540/480/360p that fit under it). Picking a resolution re-opens the stream at that fixed size with the position preserved (same mechanism as switching audio track) and tells the proxy to encode it exactly with the budget off — so a forced resolution is constant for the whole session (no mid-stream resolution change). The menu is built from the source resolution now reported in the playback plan. The shared settings button appears when either the Audio or the Quality submenu has a choice to offer.

## 0.8.43

- **Fix**: The transcode target resolution is now orientation-independent. It is sized from the viewport's long and short edges (provisioning for landscape) instead of the current width/height, so starting in portrait — where a landscape clip is letterboxed and the video box is smaller — no longer under-provisions the encode. Rotating portrait→landscape mid-playback therefore needs no more pixels and forces no transcode restart (the same cold ffmpeg restart seen on seeks); in portrait the player just downscales. The proxy still caps this to the source size (never upscales). This target is the ceiling the upcoming realtime budget scales down from; orientation never changes the encode resolution on its own. OpenSpec change `orientation-independent-target`.

## 0.8.42

- **Chore**: Playback now classifies and logs the bottleneck (`[bottleneck]` lines, forwarded to the server log) — the foundation for the upcoming realtime transcode budget. From client-visible symptoms it distinguishes client-decode (dropped frames while the buffer holds) from an upstream limit (buffer draining — proxy CPU / download / delivery, to be split by the budget) from healthy playback, with the buffer level/trend and dropped-frame ratio in each line. Diagnostic only; no behaviour change. OpenSpec change `bottleneck-diagnosis`.

## 0.8.41

- **New**: Subtitle language is detected from content, not just the filename (needs proxy 2.9.30). External subtitle files now come already converted to WebVTT from the proxy (which also decodes UTF-8/Windows-1251 and runs n-gram detection), so the browser no longer converts them. Each track's language is chosen by priority: an explicit code in the filename or container metadata (author intent) → the proxy's content detection (distinguishes e.g. Russian from Ukrainian) → the film's audio-track language (forced-signs subs usually match the dub) → Unknown. So a `.srt` with no language code in its name now shows its real language instead of "Unknown".

## 0.8.40

- **Fix**: The playlist button no longer appears for a single-video torrent that also carries audio or subtitle files. Its visibility counted video + audio + subtitle files, but the playlist only switches between VIDEO files — a movie plus an external `.srt` (e.g. the Enola Holmes release: one `.avi` + one `.srt`) wrongly showed a playlist with nothing to switch to. It now depends on the video-file count alone.
- **Fix**: A leading UTF-8 BOM in a subtitle file is stripped during WebVTT conversion, so it no longer leaks into the first cue's identifier (common in Russian `.srt` files) or sit before a `.vtt` `WEBVTT` signature. (Investigating a "subtitles don't show" report: the Enola `.srt` is a forced-signs track whose first cue is at 1:35 — nothing was wrong, the check was at 0:47; this BOM cleanup is the one real tidy-up found.)

## 0.8.39

- **Fix**: A magnet whose swarm metadata takes a moment to arrive no longer fails on the first attempt. The browser now polls `/api/sources/:key/files` (up to 3 minutes, "Fetching torrent metadata from the swarm…" shown throughout, cancellable) instead of issuing one request that gave up the instant the metadata was not yet ready — reported in the field as a paste that errored with "no peers" and then worked on a second paste. Needs proxy 2.9.28 (returns `pending` while the fetch continues).

## 0.8.38

- **Fix**: Magnet input UX rework after field feedback. (1) A visible "Play magnet" button in one flex row with the field (Enter-only submission on mobile is hostile; the label names the action) plus `enterkeyhint="go"`. (2) Pasting or typing a COMPLETE magnet URI (hash present — a partial "magnet:?" never triggers) auto-starts the flow straight from the `input` event. (3) An invalid explicit submission shows an inline field message via the Validation API instead of ripping the user into the full error screen. (4) All entry channels — URL parameter, paste anywhere on the picker, the field itself — route through the field + form, and the field clears once the flow starts, consistent with the file input. Unrecognised pasted text is still ignored silently (people paste all sorts of things, including .torrent files, which keep priority).

## 0.8.37

- **New**: Magnet links (OpenSpec change `magnet-input`; needs proxy 2.9.26). A magnet URI now works through every channel the `.torrent` file already had: the `?magnet=` URL parameter, pasting the link anywhere on the picker, and a new text field on the picker (Enter starts it). The proxy fetches the swarm metadata (`/api/sources/:key/files`, up to 3 minutes on a cold magnet, live status shown, cancellable), the file list is normalised to the local parser's shape and the flow continues exactly like a parsed torrent — playlist, subtitles, audio tracks, cancel and retry unchanged. A dead swarm fails with an explicit no-peers message; non-magnet input gets a plain-language error.

## 0.8.36

- **New**: Audio-track menu (OpenSpec change `track-selection-ui`; pairs with proxy 2.9.26). When the active file has more than one audio track, the player's settings menu appears with an Audio submenu (labels from language + title metadata, e.g. "Russian — Дубляж"). Picking a track replays the file through the proxy with `-map 0:a:N` and resumes at the same position; direct play cannot select tracks, so a non-default choice forces the proxy path.
- **New**: Embedded subtitles. Embedded TEXT subtitle tracks (inside MKV/MP4) are extracted by the proxy as WebVTT and join the external subtitle files in the captions menu (sequential fetch after playback starts, generous timeout — extraction reads the file to the last cue). Image-based tracks (PGS/VobSub) are skipped. Against a pre-2.9.26 proxy everything degrades to the previous behaviour.

## 0.8.35

- **New**: The loading screen has a Cancel button (OpenSpec change `cancel-loading`, capability `loading-cancel`). Previously a stalled load could only be waited out or escaped by reloading the page. Cancel aborts the in-flight flow at any phase — transport acquisition, plan polling, transcode warm-up, prebuffer — silently (no error screen), releases pending requests and the transcode session, and returns to the playlist for multi-file torrents (file list stays usable; the open data channel is reused for the next selection) or to the torrent picker otherwise. A cancelled flow can never late-start playback (cooperative AbortError checkpoints at the await boundaries).

## 0.8.34

- **Chore**: All CSS sizes are relative units now — the stray `px` literals (error-button border, player control padding and icon sizes, playlist font and focus outline, and the 1024px/1440px media-query breakpoints) are converted to `rem` (identical rendering at the default 16px root; rem breakpoints additionally respect the user's browser font-size setting). Documented as a convention in the OpenSpec project context.

## 0.8.33

- **Fix**: Error-screen buttons get `margin-inline-end: 1rem` — restores the spacing between "Retry" and the navigation button that 0.8.32 removed together with the buggy adjacent-sibling margin (an end margin cannot indent a single visible button because of a hidden sibling; the trailing margin on the last button is harmless).

## 0.8.32

- **Fix**: Error-screen buttons are no longer blue on iOS. Buttons do not inherit text colour and iOS paints them system blue (the `currentColor` border followed); every view's CSS now forces `color: inherit` on its buttons, so they render the view's text colour — white text and border in the dark theme, black in the light one.
- **Fix**: Removed the between-buttons `margin-inline-start` on the error screen — the adjacent-sibling rule also counted hidden buttons, indenting a single visible button.

## 0.8.31

- **New**: Reachable-first proxy selection (OpenSpec change `connection-reliability`, capability `proxy-selection`). `/api/proxy-clients/health` now returns `reachable` (dial-back probe result, collected since 0.8.22 but never exposed) and `sameNetwork` (the browser's public IP — `CF-Connecting-IP` — equals the proxy's reported external IP) per proxy. The selector prefers candidates with `reachable || sameNetwork`; when none qualify, all candidates stay eligible — a failed inbound-TCP probe does not prove WebRTC cannot connect (hole punching), so this is a preference, never a filter. Previously a remote viewer could be handed an unreachable node and wait out a 30 s timeout while a verified-reachable one sat in the list.
- **New**: Connection-loss retry (capability `playback-recovery`). When the WebRTC data channel dies mid-playback (proxy restart, network change), the app now detects it (new `onConnectionLost` hook on the transport; deliberate closes are excluded), captures the session, file and playback position BEFORE the error flow clears them, and shows the error screen with a "Retry" button alongside the usual navigation. Retry reconnects through the normal selector (possibly to a different pool node), restarts the same file and seeks back to the captured position — instead of today's silent stall that forced a full reload from zero.

## 0.8.30

- **Fix**: The document can no longer scroll on mobile (seen after landscape/portrait rotation: the player shifted sideways and the off-screen playlist drawer became reachable). `overflow: clip` now sits on BOTH `html` and `body` — clipping the root removes the page scroller entirely, instead of relying on body→viewport overflow propagation that iOS applies unreliably — and the body height is a fixed `100dvh` (was `min-block-size`, which let the body exceed the screen while `dvh` recalculated during rotation). Scrollable views (playlist) keep their own scroll containers. Spec: new `app-shell` capability, change `lock-viewport`.
- **Chore**: Dark-theme text softened from pure white to `#e6e6e6` to avoid halation on the black background; the accent (progress bar, hover) stays pure white and now reads slightly brighter than text.

## 0.8.29

- **New**: The app views (torrent picker, loading, error) follow the OS/browser colour scheme. A shared token set (`css/theme.css`, `color-scheme: light dark` + `light-dark()`) drives all view colours: light keeps the current palette (white / black / `#c00`), dark is monochrome white-on-black (background black; black text and the red accent both become white). The player keeps its own scheme-aware tokens. Spec: `view-theming`, change `view-color-scheme`.

## 0.8.28

- **Fix**: The first row of a freshly opened playlist no longer looks selected. The drawer focuses its first button on open (keyboard accessibility) and focus shared the red fill of the currently-playing row; focus is now an inset accent outline, the red fill is reserved for hover and the playing file. The playing-file marker itself persists across errors and drawer close/open and is cleared only on return to the torrent picker (spec: `player-ui`, change `playlist-selection-state`).

## 0.8.27

- **Fix**: "Choose File" on the playback-error screen no longer opens an empty playlist. The playlist cleared its file list on every `ERROR:SHOW` (a full reset), while the error screen's "Choose File" action returns the user to that very playlist; on error the drawer now only closes and the file list survives. The list is still cleared on `APP:RESET_TO_PICKER` and replaced on new media files.
- **Fix**: Modal dialogs (torrent picker, loading, error) no longer show a focus outline (the blue frame seen on mobile) — `showModal()` focuses the dialog element and the browser drew its focus ring around it; each view's CSS now sets `outline: none` on its dialog.

## 0.8.26

- **Fix**: Pinch and double-tap zoom are disabled (viewport meta `maximum-scale=1, user-scalable=no` + `touch-action: manipulation`) — this is an app, and accidental zoom over the video hurt more than it helped. Note: iOS Safari ignores `user-scalable=no` for pinch, but `touch-action` kills the double-tap zoom there.

## 0.8.25

- **Fix**: Playlist rows are full-width, so the hover/current highlight spans the whole drawer instead of only the text.
- **Chore**: The mobile debug console (eruda) no longer loads for every visitor — it is opt-in via `?debug` (any value) or `#debug` in the URL. The dialog-follow logic (eruda moves into the open modal `<dialog>`) is kept and now also catches a dialog opened before the script finished loading.
- **New**: The player UI is now [media-chrome](https://www.media-chrome.org/) (MIT, Mux) instead of native browser controls + the bespoke hover menu. A `<media-controller>` wraps the same `<video>` element — hls.js with the WebRTC data-channel loader and the native-HLS fallback are untouched. Control bar: play, mute/volume, time, seek range, captions menu (driven by the existing external-subtitle `<track>` elements), fullscreen; a close button in the top bar returns to the torrent picker; a playlist button in the control bar (hidden for single-file torrents, as before). The old `#player__menu` overlay (hover-revealed close/playlist buttons) is removed. The playlist drawer is restyled with the shared theme tokens and now also closes on a click/tap outside it (media tap gestures are suppressed while it is open, so that click never toggles play/pause). Light/dark themes follow `prefers-color-scheme`. The settings menu ships as a hidden extension point for the future audio-track and quality menu items. media-chrome is served from `/vendor/media-chrome/` (same `node_modules` pattern as hls.js).

## 0.8.24

- **Fix**: Cold-start playback no longer fails with "Data channel request timed out" on a torrent whose peers are still connecting. The browser now **polls** the playback plan (`loading.js` loop over `prepareProxyPlaybackPlan`, up to `PLAN_WAIT_MS` = 180 s) instead of issuing one request that blocks until the transport's 60 s timeout: the proxy returns `pending` quickly while the file header downloads (proxy 2.9.24), and the `/stats` poll keeps showing live peers / speed / header % the whole time. A truly dead torrent (no peers) now fails with a clear message ("Torrent isn't downloading — no peers reachable…") instead of a generic timeout. Pairs with proxy 2.9.24; ship together.

## 0.8.23

- **New**: Browser → server log forwarding (debugging aid). `public/shared/client-logger.js` (loaded first, before the component modules) patches `console.log/info/debug/warn/error` and captures uncaught `error`/`unhandledrejection`, then batches the lines to `POST /api/client-logs` over plain HTTPS (with `sendBeacon` on page hide). The server (`routes/api/client-logs/post.js`) writes each line to the container log as `[client <device>/<browser> <sessionId>] <ts> <level>: <msg>`, readable via `docker logs` / `ssh do` — so iPhone/eruda logs no longer need copy-pasting, and logs are captured even when the WebRTC data channel never connects (the failures we most want to see). Each line is tagged with a device/browser label parsed from the UA (e.g. `iPhone/Safari`, `Windows/Chrome`) and a short per-page session id. Best-effort and capped (≤50 lines/request, ≤2000 chars/line, control chars flattened so a forwarded line can't inject fake log lines); uses original console refs internally so a failed POST can't loop.

## 0.8.22

- **New**: Dial-back reachability probe for proxies (`services/reachability-prober.js`). When a proxy reports its UPnP-mapped external endpoint over the tunnel (new `proxy-endpoint` message), the server connects to `http://<external-ip>:<port>/healthz` **from the droplet** — the same external vantage a viewer has — and records whether it is actually reachable from the internet (a router can accept a UPnP mapping that is still unreachable behind CGNAT/double-NAT, so the report alone is not trusted). Result is stored per proxy (`endpoint`/`reachable`/`lastProbedAt` on the client record) and re-checked every 5 min for connected proxies. The tunnel message handler is now bound to the originating `proxyId`. Not yet surfaced to the browser (endpoint selection is a later step).

## 0.8.19

- **New**: External subtitle support. When a torrent contains subtitle files (`.srt`, `.ass`, `.ssa`, `.vtt`, `.webvtt`) alongside video files, the player now fetches and attaches them as `<track>` elements after playback starts. Language is detected from directory names (`ENG/`, `RUS/`, `KOR/` …) and filename suffixes (`_rus_AT_Team`, `_pol_Nyan` …); the release-group name is included in the track label (e.g. "Russian (AT Team)"). SRT and VTT are loaded as-is; ASS/SSA are converted to WebVTT with formatting tags stripped. Track selection uses the browser's native subtitle controls. Subtitle tracks are cleared when switching to another video file or resetting.

## 0.8.18

- **Fix**: The progress bar no longer jumps to 15% and then drops back to ~0 (or stalls at 15%) when a torrent is selected. `#processPlayback` set a fixed `setProgress(15)` before phase 0 started; phase 0's floor (3.3%) is lower, so without the monotonic clamp the bar dropped, and with it the bar stayed pinned at 15% until the header passed ~45%. Removed the pre-phase `15%` so phase 0 owns the 0–33% band from the start.
- **Fix**: Phase 1 (transcode) now shows "Preparing first segment… %" from 0% (relaxed `segmentProcessed > 0` to `>= 0`), so the band fills from the first poll instead of only after the first encoded second.
- **Chore**: `[evt]` diagnostics for the progress bar: `setProgress` logs `progress bar=X% req=Y%` (applied vs requested, to reveal monotonic clamping) and `#setPhaseProgress` logs `progress phase=N within=X%`. Lets the "3 steps / no intermediate stages" behaviour be confirmed from logs.

## 0.8.17

- **New**: Adaptive pre-buffer cushion. Instead of a fixed 15 s, `#waitForPrebuffer` now measures the fill rate `R` (media-seconds buffered per wall-second, while the video is paused = the production+delivery rate) over a rolling 1.5 s window and sizes the cushion from the margin over realtime (`R − 1`): comfortable margin → small cushion (~6 s, start sooner), margin near zero → large cushion (capped 25 s). Falls back to 15 s until the rate is measurable, with a 30 s absolute timeout. The cap stays under hls.js `maxBufferLength` (30) and the proxy look-ahead window (~32 s) so buffering ahead never triggers a seek-restart. Adds `[evt] prebuffer target/ready/timeout` logs.

## 0.8.16

- **New**: The download (metadata) screen now shows progress and ETA toward the **next phase** instead of only the whole-file percentage. Using the proxy's `headerBytes`/`headerDownloadedBytes`, it renders `To next phase: Z% • ETA ~Ts` (how much of the header/index is downloaded before the codec probe / transcode can start). Peers, download speed and the overall file line are kept. Coarse (piece granularity) for this iteration.
- **New**: The `<progress>` bar is now divided into three equal thirds for the pre-playback phases — download (0–33%), transcode first segment (33–66%), buffering (66–100%) — and each phase fills its own third from its own 0–100% progress (`#setPhaseProgress`). The bar is also monotonic (only moves forward, except an explicit reset to 0 on a new file), so within-phase fluctuations and the warmup→first-segment transition no longer make it jump back.

## 0.8.15

- **Fix**: Loading status no longer flickers between "Preparing first segment… / ETA" and "Buffering…". Both the transcode progress poll (~1 s) and the pre-buffer wait (250 ms) were writing the loading status concurrently, so the text alternated. The progress poll now stops after `#ensureVideoReady` (first-segment phase), and only `#waitForPrebuffer` writes the status during the cushion fill (`loading.js` `#playWithProxyTranscode`).

## 0.8.14

- **Fix**: The pre-buffer no longer flickers "Buffering… N / target" while audio plays. `Loading.#waitForPrebuffer` now pauses the `<video>` for the whole pre-buffer wait (and re-asserts pause if leftover play-intent resumes it). Previously the video kept playing under the loading screen, draining the buffer faster than the ~1× transcode filled it, so `bufferedAhead` never reached the target — the loading view stuck until the timeout, updating the fluctuating counter (looked like flicker) while audio was heard. Playback now starts only when the player is revealed (`Player.#onShow`).
- **Chore**: Temporary `[evt]` diagnostics for view/playback causes: `Player` logs `view=player shown/hidden`, `player.play reason=show`, `player.pause reason=hidden`; `Loading` logs `view=loading shown/hidden cause=…` and `player.pause reason=prebuffer`; `TorrentTV` logs `transition→PLAYING/ERROR cause=…`. Correlate with the existing `<video>` event log to see exactly what shows/hides a view and what starts/stops playback.

## 0.8.13

- **Fix**: Nothing plays while the player is hidden. `Player`'s `visible` setter now pauses the `<video>` whenever the player is hidden (loading/pre-buffer screen, error, reset); playback is (re)started only in `#onShow` on reveal. Previously a hidden `<video>` (`display:none`) kept emitting audio — on a multi-file torrent the player was revealed once for the playlist (giving the element play-intent), so when a selected file's data arrived the audio played under the loading screen before the player was shown. Now audio and the first frame appear together.

## 0.8.12

- **Fix**: Audio no longer plays underneath the loading / pre-buffer screen. Playback now starts only when the player view is **revealed** (`Player` on `PLAYER:SHOW`), not eagerly inside the HLS loader. `hls-player.js` previously called `video.play()` right after the manifest parsed — so on desktop (autoplay allowed) the video played, and its audio was audible, during the ~15 s pre-buffer wait while only the buffering overlay was visible. hls.js keeps filling the buffer while paused, so the cushion still builds; now the first frame and the sound begin together when the player appears. (iOS autoplay is still blocked outside a gesture — the user taps the native control, unchanged.)
- **Chore**: Extra gap diagnostics to verify the PTS-gap fix per branch: `hls-player.js` logs each `bufferStalledError`/`bufferSeekOverHole` with a UTC timestamp, `currentTime` and the jumped `hole` size; `loading.js` adds a periodic `buffer-health` tick (every 10 s while playing) showing `currentTime`, buffered-ahead and the number of buffered ranges. Correlate with the proxy's `branch=A/B` tag to attribute any remaining glitch.

## 0.8.11

- **Chore**: Temporary `[evt]` diagnostics with **UTC** `HH:MM:SS.mmm` timestamps (same zone/format as the proxy logger, so the two logs line up exactly) to correlate the browser timeline with the proxy's logs: transcode-session **create/release** (`torrent-session.js`), `<video>` **seeking/seeked/waiting/playing/pause/ended/stalled/error** with `currentTime` and buffered-ahead (`loading.js`), and a timestamp added to the existing `[net-debug] dc-load` line (`webrtc-hls-loader.js`).

## 0.8.10

- **Fix**: Switching to another video file now releases the previous transcode session immediately (`Loading.#switchToVideoFile` calls `TorrentSession.releaseActiveTranscodeSessions`). Previously the old session kept its ffmpeg running until page unload, so switching episodes left two encodes competing for the (ARM) CPU and both dropped below realtime → stalls. Only one transcode runs per viewer now.
- **New**: Pre-buffer cushion before playback. After the first segment is ready, `Loading` now waits until ~15 s of video is buffered ahead (`#waitForPrebuffer`, with a 25 s timeout fallback and a "Buffering…" status) before revealing the player, so a transient production/delivery dip right after start no longer stalls immediately. hls.js is also configured with an explicit forward buffer (`maxBufferLength` 30 s) kept under the proxy's look-ahead window so banking ahead never triggers a seek-restart.

## 0.8.9

- **Fix**: Playlist now highlights the picked file immediately on click (`#onListClick` calls `#updateActiveHighlight`), instead of waiting for the `PLAYER:SET_ACTIVE_MEDIA_FILE` round-trip. The active-file event remains the source of truth for programmatic playback.

## 0.8.8

- **Fix**: An unknown/undetected video codec is now treated as **unsupported** (transcoded to H.264) instead of assumed playable. Copying an undecodable codec over the WebRTC transport (which has no direct-playback fallback) produced a black screen with audio only. Also removed `mpeg4` (MPEG-4 Part 2: xvid/divx) and `mpeg2video` from the natively-supported video codec list, since mainstream browsers cannot decode them — they are now always transcoded.
- **Fix**: Playlist now marks the currently playing file. `Playlist` updated the tracked index on `PLAYER:SET_ACTIVE_MEDIA_FILE` but never re-rendered, so no item was highlighted. The active file's button now gets `aria-current="true"` (styled bold/red) and the highlight is refreshed on both render and active-file changes.
- **New**: MediaSession integration (`components/media-session/media-session.js`) — wires OS-level media controls (lock screen, notification shade, hardware keys, PiP) to the existing event model: metadata follows the active file; play/pause/seek act on the shared `<video>`; previous/next track dispatch `PLAYER:SELECT_MEDIA_FILE` for the adjacent video (disabled at list edges); stop dispatches `APP:RESET_TO_PICKER`. No-op where the API is unavailable.

## 0.8.2

- **Fix**: Loading status now keeps moving until the first segment is ready, instead of freezing on a stale "Transcoding 0%". The synthetic VOD playlist is ready instantly, so `waitForHlsPlaylist` stopped polling almost immediately; `loading.js` now polls the transcode session's `/progress` (via `TorrentSession.fetchActiveTranscodeProgress`) throughout `#ensureVideoReady` and renders progress oriented to the **first segment** — "Starting transcoder… X%" during ffmpeg warmup, then "Preparing first segment… X%" with a dynamic ETA derived from the encode speed and the proxy's `segmentDurationSec`. Previously the percentage was computed against the whole-file transcode and barely moved.

## 0.8.0

- **Fix**: iOS playback no longer fails with `NotAllowedError`. The `<video>` element gains the `playsinline` attribute (inline playback by default; fullscreen still available via native controls), and `hls-player.js` now tolerates the autoplay-policy rejection (`NotAllowedError`) on both the hls.js and native-HLS `play()` paths instead of surfacing it as a fatal "format not supported" error. Playback starts when the user taps play.
- **Fix**: Static assets are served with `Cache-Control: no-cache, must-revalidate` (revalidated via ETag/If-None-Match on every request) so deploys are picked up immediately instead of being hidden by a multi-hour browser cache. Note: Cloudflare's "Browser Cache TTL" must be set to "Respect Existing Headers" for this to take effect at the edge.
- **New**: WebRTC data-channel response bodies are received as binary frames (`webrtc-proxy.js`), removing the ~33% base64 overhead and JSON decode cost. Backward compatible — the client still decodes the legacy base64 `response-chunk` format, so it works with an older proxy. Deploy the server before the proxy.
- **Chore**: Temporary `[ios-debug]` diagnostics in the playback-ready path (`loading.js`) for iOS troubleshooting; to be removed once verified. CSP relaxed (`script-src 'unsafe-eval'`, `cdn.jsdelivr.net`) to allow on-device debugging with eruda (script tag currently commented out).

## 0.5.1

- **Fix**: Error view now shows exactly one button — **"Choose File"** when the torrent has multiple video files (so the user can pick a different one without re-uploading), **"New Torrent"** in all other cases. Previously both buttons were visible simultaneously.

## 0.4.4

- **New**: Live torrent stats during metadata wait — `Loading` polls `GET /api/sources/:sourceKey/stats` every 2 s and shows peer count, download speed, and file download progress while the proxy pre-fetches the MOOV atom. The torrent source is now registered before the playback plan request so the stats endpoint is available immediately.
- **New**: Error view redesigned — two distinct action buttons replace the single "Back" button: **"New Torrent"** (always shown, resets to picker) and **"Choose File"** (shown only when the torrent has multiple video files, returns to the playlist). CSS refactored to use `.error__action` class for consistent button styling.

## 0.4.3

- **New**: Seek-to-position HLS — `torrent-session.js` attaches a debounced (600 ms) `seeking` event handler after HLS playback starts. When the user scrubs beyond the already-transcoded portion, the handler creates a new transcode session from the seek position (`startPositionSeconds`) and switches HLS.js to the new playlist URL without interrupting playback of the old stream.
- **New**: `hls-player.js` accepts `startPosition` in play options and sets `hls.startPosition` before loading the source, so HLS.js begins buffering at the correct offset.
- **New**: `playHls` callback signature extended to accept a third `playOptions` argument; `loading.js` merges it with the HLS loader config.
- **Fix**: `waitForHlsPlaylist` in `torrent-session.js` now resolves on `#EXTINF:` (first HLS segment present) instead of `#EXT-X-ENDLIST` (full transcode done). Playback starts within seconds rather than after the entire file is transcoded.

## 0.4.2

- **Fix**: HLS.js `MANIFEST_PARSED` timeout increased; fatal error handling tightened.

## 0.3.0

- **Fix**: Static files now correctly sync from image to nginx volume on every container start — `docker-entrypoint.sh` does a clean `rm -rf` of the volume contents followed by `cp -rp` from `/app/public`, guaranteeing removed files also disappear after an image update.
- **Chore**: Dockerfile — create `/app/public-volume` with `app:app` ownership before `USER app` so the entrypoint can write to the volume without root; add `ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]`.
- **Fix**: Watchtower — set `DOCKER_API_VERSION=1.45` env var in `docker-compose.prod.yml` so the Docker SDK doesn't default to API 1.25 (which the daemon rejects); add `--debug` flag for visibility.

## 0.1.1

- **Fix**: Docker volume stale static files — added `docker-entrypoint.sh` that syncs `/app/public` from the image into the shared nginx volume on every container start. Nginx now always serves fresh JS/HTML after an image update without manual volume removal.
- **Fix**: `npm run docker:build` on Windows — added `.npmrc` with `script-shell=bash` so `$npm_package_version` expands correctly in npm scripts when running under Git Bash.
- **Chore**: `infra/docker-compose.yml` volume mount moved from `/app/public` to `/app/public-volume` so the volume no longer shadows image files.
- **Chore**: `infra/prod.sh` updated to `pull` then `up --remove-orphans` for cleaner deploys.

## 0.1.0

- **New**: WebRTC signalling server — replaced direct HTTP proxy registration with a WebSocket tunnel endpoint. The server brokers SDP offer/answer and ICE candidates between browser and proxy; all video data flows directly over the WebRTC data channel.
- **New**: `npm run patch / minor / major` scripts — bump the package version, build and push a versioned Docker image (`ghcr.io/torrent-tv/server:<version>` + `:latest`), and push git tags in one command.
