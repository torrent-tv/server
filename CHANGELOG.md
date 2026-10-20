## 0.54.0

- **Fix**: Remove section-type labels from chapter rows and close the list after a chapter is selected.
- **New**: Show nested chapters as expandable groups, highlight the most specific current chapter, and distinguish the control with a numbered-list icon.

## 0.53.1

- **Fix**: Hide the chapter control until the selected file has navigable chapters.

## 0.53.0

- **New**: Mark playback sections on the timeline and show their titles on hover or keyboard focus.

## 0.52.5

- **Fix**: Keep early playback trace events outside the ordinary log queue until they can be replayed to the proxy.

## 0.52.4

- **Fix**: Preserve up to 5,000 playback process events until the proxy connection opens, including connections that open without a reconnect callback.

## 0.52.3

- **Chore**: Persist opt-in playback process events through the client log to the proxy, replaying the queued events when an existing connection opens (#ttv-185).

## 0.52.2

- **Chore**: Persist opt-in playback process events through the client log to the proxy, including events emitted before its connection opens (#ttv-185).

Warning: truncated output (original token count: 80973)
Total output lines: 1858

## 0.52.1

- **Fix**: Bound chapter snapshot requests and show failed discovery as unavailable instead of leaving the panel in its reading state.

## 0.52.0

- **New**: Navigate the selected file's chapters from the player side panel, which now switches between the playlist and chapter list.

## 0.51.2

- **Fix**: Keep a diagnostic wait active when playback preparation resets its previous requests (#ttv-185).

## 0.51.1

- **Fix**: Add opt-in playback wait observations with stable action identities across retries, operation boundaries and confirmation of advancing frames with decoded audio (#ttv-185).

## 0.51.0

- **New**: Fetch selected-file chapter snapshots after playback begins and distinguish unsupported proxies from missing sources (torrent-tv/meta#110).

## 0.50.33

- **Chore**: Update dependencies: knip 6.42.0 → 6.42.1; 5 package(s) changed in the lock file.

## 0.50.32

- **Fix**: Show the proxy's active first-segment forecast while preparation is in progress (#ttv-185).
- **Fix**: Build the server from the matching Alpine cache mirror when ECR Public's data quota is exceeded (#ttv-185).

## 0.50.31

- **Chore**: Update dependencies: knip 6.41.0 → 6.42.0; 24 package(s) changed in the lock file.

## 0.50.30

- **Fix**: Record separate cold-start phase durations and time from startup completion to the first audio-ready presented frame for the proxy's wait model (#ttv-185).

## 0.50.29

- **Fix**: Send the elapsed time from the original playback action with source estimates so later forecasts remain a time left, not a new full-wait countdown (#ttv-185).

## 0.50.28

- **Fix**: Keep the total-wait estimate instead of a local readiness delay, and do not show zero before the first presented frame (#ttv-185).

## 0.50.27

- **Fix**: Send the pre-session client-link rate and sample age with the early source wait estimates (#ttv-185).

## 0.50.26

- **Fix**: Start first-frame wait measurements at the file selection or magnet submission, before local torrent parsing.
- **Fix**: Attempt to reconnect after the proxy transport is lost while the viewer is at the file picker.

## 0.50.25

- **Fix**: Keep the open proxy transport when returning to the file picker, so another selection does not add a new connection delay to its countdown.

## 0.50.24

- **Fix**: Start a single-file wait at the original open action and a multi-file wait at file selection; use the proxy's preloaded file-list estimate, refine it with live source statistics, and preserve one countdown through playback planning.
- **Fix**: Show wait estimates to hundredths of a second below one minute and milliseconds below one second; refresh the countdown within four percent of its current wait and log each estimate with the first presented video frame for per-run accuracy checks.
- **Chore**: Capture the media, video and audio ranges held when the first frame is presented; learn its wait only when the required audio range covers that frame.

## 0.50.23

- **Fix**: Show wait estimates to tenths of a second below 10 seconds and milliseconds below one second; log each displayed estimate and the first presented video frame with elapsed time for per-run accuracy checks.
- **Fix**: Repeated copies of the same proxy timing measurement no longer restart the displayed playback countdown.
- **Chore**: Capture the media, video and audio ranges held when the first frame is presented, so accuracy checks can verify required audio readiness.

## 0.50.22

- **Chore**: Update dependencies: 1 package(s) changed in the lock file.

## 0.50.21

- **Chore**: Update dependencies: 1 package(s) changed in the lock file.

## 0.50.20

- **Fix**: Send control requests over a separate WebRTC connection when supported by the proxy, so video transfers, speed samples, subtitle files and covers cannot occupy its SCTP queue. Reconnect control independently without replaying sent actions or releasing a viewer still receiving media. Keep legacy proxies compatible and report delivery separately for each connection.

## 0.50.19

- **Fix**: After a seek the page asks the proxy again as soon as the media at the new position has arrived, instead of only when the forecast's delay or the 1.5 s cadence comes round. Back to an already made position on Home Assistant the media arrived at 22.01 and the picture started at 24.07, after a question asked at 23.52 (r69, #ttv-178).

## 0.50.18

- **Perf**: While playback waits to start, the page reports its buffer and asks the proxy again as soon as a piece has arrived, instead of on its next 1.5 s ask. The piece a start waits for is one the page appends, and the answer that let it start came up to 1.5 s after it: after a seek on Home Assistant the last piece reached the page at 07:19:56.1 and the start was allowed at the next ask, 07:19:57.4 (r68, #ttv-178).

## 0.50.17

- **Chore**: The page logs the arrival of a seek's acknowledgement and of every start forecast with its request id, so the time each answer stood in the connection can be read beside the proxy's line for the same request (#ttv-178).

## 0.50.16

- **Chore**: Update dependencies: 1 package(s) changed in the lock file.

## 0.50.15

- **Fix**: The player stops the buffer poll when the picture starts moving. Starting the decoded-frames report returned before the poll was stopped, so the poll and the buffer event it sends ran every 500 ms for the whole of playback (#ttv-178).

## 0.50.14

- **Fix**: After a seek the held picture asks the proxy's forecast again when the forecast says the position may be ready, if that comes before the 1.5 s cadence; what releases the picture is still the answer to that question. Asked only at the cadence, the hold ended up to 1.5 s after the stated delay: 2.5 s and 1.0 s at two seeks of r30 on Home Assistant (#ttv-178).

## 0.50.13

- **Fix**: The page's long-frame timing keeps each long frame as the browser reports it and says it with the minute's totals, instead of formatting and logging a line inside the observer's callback, which runs on the page's main thread: on Home Assistant that callback was itself a long frame of 284 ms (#ttv-178).

## 0.50.12

- **Chore**: Update dependencies: @fastify/helmet 13.1.2 → 13.2.0; 1 package(s) changed in the lock file.

## 0.50.11

- **Fix**: The report a transcoded viewing sends carries the viewing it was made in, as a direct one already did, so a report made before a seek and answered after it no longer puts the viewer back where they stood (proxy 2.98.4, #ttv-178).

## 0.50.10

- **Fix**: After a seek the picture is held, as the first start is, until the proxy forecasts it can play on from the new position; the frame arriving no longer starts it on its own. On Home Assistant a seek back started with 4 s buffered while the picture was being made slower than real time, and stood 3.35 s fourteen seconds later. A later seek takes the hold over and the earlier one's answer releases nothing; the viewer's own pause is kept; a proxy that states no forecast releases it at once, as before (#ttv-178).
- **Chore**: The page times the parts of two calls a long frame named on Home Assistant — the address update (reading the address, building the magnet and the state, writing history) and the network report (its log line, its body, the synchronous part of its send) — and matches every long frame the browser reports to the calls that ran inside its interval, by time. Once a minute it states the totals per part and of the long frames (#ttv-178).

## 0.50.9

- **Chore**: Update dependencies: fastify 5.12.5 → 5.12.7; 3 package(s) changed in the lock file.

## 0.50.8

- **Chore**: Update dependencies: 1 package(s) changed in the lock file.

## 0.50.7

- **Fix**: The subtitle menu is brought to each publication by item key instead of being re-created: with a subtitle provider's 330 offers in it, every text-track change re-created 339 items and stood the page for 620–780 ms, eight times in a row while a film opened (#ttv-178).

## 0.50.6

- **Chore**: A play or pause request is logged with its origin — the system's media controls (`media-session`), the play button, a tap on the picture or a key — since a pause nobody remembers making was reported only as the viewer's (#ttv-178).

## 0.50.5

- **Fix**: Hovering the subtitles button shows its "Subtitles" tooltip instead of an empty one — only its arrow was drawn (#ttv-187).

## 0.50.4

- **Chore**: Update dependencies: 17 package(s) changed in the lock file.

## 0.50.3

- **Chore**: Update dependencies: @fastify/static 10.1.5 → 10.1.6, @fastify/websocket 11.3.3 → 11.3.4; 6 package(s) changed in the lock file, 1 removed.

## 0.50.2

- **Fix**: The address carries the episode number of the open file: a matched episode is the provider's record (`{ number, name }`), and 0.49.0 read it as a bare number, so `episode` was never written (#ttv-172).

## 0.50.1

- **Fix**: The tunnel round trip is measured with a probe message the proxy echoes (`rtt-probe` → `rtt-echo`); the WebSocket ping frame used in 0.50.0 never came back over Cloudflare and nginx, so every proxy reported no round trip (#ttv-36).

## 0.50.0

- **New**: The server chooses the proxy: `POST /api/proxy-clients/choose { infoHash, tried, onlyIds, current }` answers one proxy from the table each proxy keeps current over its tunnel (load, room for one more encode, the films it holds), preferring one that holds the film and has room; a page that cannot connect asks again naming the proxy and the error. Nothing is asked of a proxy while a viewer waits, and which films a proxy holds is no longer sent to every page: `/api/proxy-clients/health` answers from the table without them (#ttv-36).
- **New**: The connection taken as the page opens uses the film the address names, and a page moves to another proxy only when that one holds the film and has room while the one in hand does not (#ttv-36).

## 0.49.0

- **New**: Identification chooses among works of one title by score instead of the newest year: a work that contradicts the release (a film for episodes, a work later than the torrent's creation date, an episode beyond the season) is set aside, and the rest are scored by title, stated year, runtime, episode count and audio language; AniList's single anime match moves the choice onto the TMDB work it agrees with (#ttv-172).
- **New**: The page address and the share link carry the identified work (`type`, `id`, `kind`, `category`, `season`, `episode`); a refresh or a shared link looks the record up instead of searching, and `season` with `episode` open the matching file when the address has no `fileIndex` (#ttv-172).
- **Chore**: `METADATA_RUNTIME_TOLERANCE_SECONDS` is removed; a runtime is compared by ratio with no allowance (#ttv-172).

## 0.48.12

- **Fix**: Send the page log to the proxy again while its connection is open: 0.48.11 sent every line to the server, and a reconnect now takes the lines back to the proxy (#ttv-77).

## 0.48.11

- **Fix**: Stop sending the page log to a proxy connection that has closed; the server takes the lines until a new connection opens, instead of one failure line every two seconds for as long as the page stays open (#ttv-77).

## 0.48.10

- **Chore**: Update dependencies: @fastify/helmet 13.1.1 → 13.1.2, knip 6.40.0 → 6.41.0; 26 package(s) changed in the lock file.

## 0.48.9

- **Fix**: Keep the playback estimate unknown until the proxy confirms readiness or provides a positive delay (#ttv-160).

## 0.48.8

- **Chore**: Update dependencies: @fastify/cors 11.3.0 → 11.3.1; 1 package(s) changed in the lock file.

## 0.48.7

- **Fix**: The error screen tells the viewer what happened to playback and what they can do, never a message written for the log. Only an error written for the viewer is shown as it is; any other — a status code, a timed-out request, a reason the proxy stated in its own terms — is shown as "Something went wrong while preparing this video. Press Retry to try again." (or, without Retry, "This video couldn't be played. Choose another file or torrent.") and its own text goes to the log together with the last refusal the proxy stated. A lost connection now says Retry continues from where the viewer was, and an empty pool says "No video source is available right now" (torrent-tv/meta#73).

## 0.48.6

- **Fix**: A soundtrack chosen while the proxy had just dropped the playback session is no longer discarded. The menu used to return to the previous track and the rebuilt session kept it; the session is now rebuilt with the chosen track. The message "That soundtrack is not ready yet" is removed: the proxy answers a track request only once the piece at the viewer's position exists, so a track that is not ready cannot be reported (torrent-tv/meta#68).

## 0.48.5

- **Fix**: A file opens on its first usable soundtrack when track 0, or the one chosen in an earlier episode, is marked unusable by the file (Matroska `FlagEnabled` 0, MP4 `track_enabled` cleared). Such a track was already left out of the menu, and was still played (torrent-tv/meta#49).

## 0.48.4

- **Chore**: Update dependencies: knip 6.39.0 → 6.40.0; 1 package(s) changed in the lock file.

## 0.48.3

- **Fix**: Subtitles found by a provider search are added to the menu in one publication instead of one per offer. The player rebuilds the whole menu on each publication, so a search answering 112 subtitles held the page for seconds while a film was opening (torrent-tv/meta#8).

## 0.48.2

- **Fix**: A film whose file says to show a subtitle track no longer opens without it. Subtitles now start with the playback plan instead of after playback, the track the file opens with — its `FlagDefault`, or the viewer's choice carried from the previous episode — is reported to the proxy while the cushion fills, and the start waits until the proxy says that track has been read where the viewer stands. The wait ends with the cues or with the proxy's refusal to read the track; a proxy that does not state it is not waited on. The waiting overlay names it: "The subtitles this film opens with are being read" (torrent-tv/meta#8).

## 0.48.1

- **Fix**: What a file states about its work is kept for the next viewer also when its work was already identified by name: the page sends it to `POST /api/metadata/container` (torrent-tv/meta#139).

## 0.48.0

- **New**: What an opened file states about its work — read by the proxy from the file's own tags — is used in identification: its titles are further names to search, a stated season or episode makes the release a series, a stated episode title is matched against the series' episodes, and an `IMDB`, `TMDB` or `TVDB` id replaces the search with a lookup. It fills an empty episode title, year and description, and the file's own cover is shown where there is no poster; nothing already shown is replaced (torrent-tv/meta#139).
- **New**: The server keeps what a file states by the torrent's infohash and the file's index, so the next viewer of the same file is identified with it from the first request (torrent-tv/meta#139).

## 0.47.4

- **Fix**: A scene found by ThePornDB showed no cover: the cover was taken from the scene's `image`, the address of the studio's own site, which the cover route does not fetch from. It is now the scene's background or poster on the database's own hosts (torrent-tv/meta#135).

## 0.47.3

- **Fix**: A terminal proxy output failure ends playback preparation with its reported cause, including before media metadata has arrived. The page no longer keeps waiting for an output that cannot be produced.

## 0.47.2

- **Fix**: The cover of an identified adult scene reaches the work as its `poster`; the order of sources for that field named TMDB only, so a scene found by ThePornDB or StashDB had no poster (torrent-tv/meta#135).

## 0.47.1

- **Fix**: The hash of a release's only picture is asked of the proxy as soon as the proxy has said what is in the release, not when the plan of playback is ready; on a cold torrent that took minutes, and identification by the hash came after the viewer had stopped waiting (torrent-tv/meta#135).

## 0.47.0

- **New**: A work from ThePornDB or StashDB carries its cover as `poster`, served by `GET /api/metadata/cover/:source/:id`. The route asks the database for the address of the image and fetches it only from `stashdb.org` and `theporndb.net`, over https, as an image of at most 8 MB; the page never supplies an address (torrent-tv/meta#135).

## 0.46.0

- **New**: The page tells the metadata service what a torrent states and what the proxy measured. A `.torrent` from an adult-only tracker (its `comment` or its trackers; `pornolab.net`) sends `category: "adult"` with every identification request; for the open file the page asks the proxy for the OpenSubtitles hash (`/api/sources/:key/files/:i/fingerprint`) and, when the release is still not identified, asks again once with it as `fingerprint`. A proxy that does not know the route answers `404` and nothing is sent (torrent-tv/meta#135).

## 0.45.0

- **Change**: The order of questions to the metadata databases is stated in `MetadataRegistry`. The hash of the file (`fingerprint`) is asked first, of every source that takes it. Then the names, in the databases of the kind the request states (`category: "adult"` asks the adult ones first, otherwise the film and anime ones). The other kind is asked by name only after the anime source too, and only when nothing was found at all; so a release the film and anime databases do not know is looked up in ThePornDB and StashDB without any category, and several candidates are an answer that does not lead to the other kind (torrent-tv/meta#135).

## 0.44.1

- **Fix**: Opening failures remain attached to the current playback attempt. Resetting source preferences no longer makes an active failure appear stale and leave the loading screen waiting indefinitely; cancelled and replaced attempts still cannot report an error for the new source.

## 0.44.0

- **New**: Adult releases can be identified. `POST /api/metadata/identify` takes `category: "adult"` and `fingerprint: { hash, size }` (the OpenSubtitles hash of the file); for that category ThePornDB and StashDB are asked, first by the hash, then by the release name, and a scene is reported only when exactly one fits. The general databases (TMDB, AniList) are not asked for that category, and the adult ones are not asked for any other. The work carries `studio`, `performers` and `adult`. Artwork is not shown yet (torrent-tv/meta#135).
- **Chore**: Secrets are read from environment variables only: `TMDB_READ_TOKEN`, `OPENSUBTITLES_API_KEY`, `JIMAKU_API_KEY`, `STASHDB_API_KEY`, `THEPORNDB_API_KEY`. The `*_FILE` variables are gone; the pipeline delivers the GitHub secrets to the environment (torrent-tv/meta#143).
## 0.43.2

- **Fix**: Playback preparation no longer displays the proxy's warmup percentage as completed browser buffering. An empty browser buffer shows that preparation is still pending.

## 0.43.1

- **Fix**: The player's poster stays until playback has started instead of going when the first frame is decoded. A viewer whose playback was still preparing (or never started) lost the poster as soon as the first segments arrived and saw a first frame or black with a waiting indicator (field 2026-10-06, torrent-tv/meta#144).

## 0.43.0

- **Fix**: Shared torrent links wait for module initialization before announcing their source, so a first page load cannot lose the playback request while another component is still loading.

- **Fix**: During opening, viewer reports retain the chosen destination until preparation finishes. A media element temporarily at zero after reading metadata cannot move source preparation and playback readiness back to the beginning.

- **Fix**: Source registration requires the proxy's map playback contract before preparation. A page assigned to an older proxy reports that it needs an update instead of silently using unsupported preparation requests.

- **Fix**: Resetting source controls during opening preserves the waiting indicator derived from the current application state.

- **Fix**: Playback readiness reports the applied timestamp offset from each actual SourceBuffer together with its held ranges. A demuxer event cannot overwrite a separate audio clock or retain a clock from an earlier buffer.

- **Fix**: Embedded subtitle tracks appear without waiting for external subtitle documents to download.

- **Fix**: Legacy media playlist opening waits without a production deadline and stops on terminal proxy refusals instead of offering automatic output restart.

- **Fix**: New proxies declare pushed subtitle delivery, avoiding repeated pending-document pulls. Changing the file cancels subtitle requests and obsolete source registration cannot restore an earlier file's tracks. Older proxies retain their existing pending-response behavior.

- **Fix**: Subtitle menu choices report the selected source file and track to the proxy, including an explicit off state, independently of subtitle document delivery.

- **Fix**: Direct playback sends source viewer reports, preserves explicit pause when assigning a URL and cancels pending reports when replaced. Seek generations prevent older reports from restoring a previous position.

- **Fix**: A newer quality request, file preparation or stop cancels the previous quality wait, including waiting for the browser buffer. Quality preparation preserves explicit error codes and retry classification instead of reporting every failure as unavailable readiness.
- **Fix**: Playback plans and audio or quality preparation wait on source and output events without polling or elapsed deadlines. Cancelled requests release their subscriptions; terminal refusals preserve their retry classification.
- **Fix**: Automatic reconnection and manual retry share serialized preparation. Reconnection preserves the current player buffer, a newer file selection cancels recovery, and explicit terminal refusals stop repeated recovery attempts.
- **Fix**: Preparing a direct stream preserves pause intent. Metadata and decoded-frame readiness are observed without elapsed-time refusals; cancellation releases pending waits. History, expired-session recovery and audio-session rebuilding share serialized preparation.
- **Fix**: Only explicit play and pause requests change viewer intent. Internal pauses and playback events preserve that intent, including during initial preparation and track changes, and explicit requests are reported immediately to the proxy.
- **Fix**: Selecting an episode during preparation cancels the previous preparation and starts the latest selection after its cleanup. Playback cancellation does not get reported as an autoplay permission refusal.
- **Fix**: HLS startup and custom media loads have no production deadline. Automatic HLS error recovery cannot select another proxy output or silently accept a different level after repeated failures.
- **Fix**: HLS cannot remove and renumber levels after an output is selected. Its picture-size and dropped-frame caps are disabled; level-controller contracts are checked against the installed library.
- **Fix**: Proxy requests wait for their result, explicit cancellation, or connection loss without a playback request deadline or an X-Hold-Ms budget.
- **Fix**: The file picker respects the proxy's exclusion of samples and release-group promos.
- **Fix**: Cancelling a browser data-channel request also cancels its proxy-side HTTP wait instead of only discarding the browser's pending response.

## 0.42.1

- **Chore**: The sources of film metadata share one interface, `MetadataProvider`, like the sources of subtitles: TMDB, AniList and the media container are providers held by `MetadataRegistry`, which replaces `AnimeMetadata`. A source states what evidence it takes, preference between sources is stated per field in `normalize-work.js`, and the media container is both a source of fields and evidence for the others. The answers of the metadata routes do not change (torrent-tv/meta#137).

## 0.42.0

- **New**: The player's poster fades in over 0.3 s once its image has loaded and fades out when the first frame is decoded, instead of appearing and disappearing at once. It no longer returns over the film when the window is resized during a seek, and the fade is skipped under `prefers-reduced-motion` (torrent-tv/meta#138).

## 0.41.1

- **Fix**: With two slots, the slot that starts to serve removes only its own earlier copies of the page. It removed every copy but its own and the one served before, so when both slots started together the first to serve deleted the copy the other was still writing, and once that one took over nginx's `current` pointed at nothing; the site answered only because the server serves the page itself when nginx finds no file (field 2026-10-05, the first start of both slots). The new link is also made inside `releases/`, which the other slot's start does not empty (torrent-tv/meta#94).

## 0.41.0

- **New**: The server can run in two slots and hand over at a release, so a page that opens or connects to a proxy during a release finds a server and the full list of proxies. The new instance (`SERVER_SLOT`, its peer named by `SERVER_PEER`) asks the serving one to hand over; the serving one stops accepting tunnels and asks every proxy that follows moves to open a second connection, which nginx sends to the new instance; when each of them has arrived, the new instance serves and the old one stops accepting pages, finishes the signalling already under way — until its newest signalling socket is as old as the page's connect deadline — and stands by. An instance that does not serve answers 503 so nginx uses the other slot; `/healthz` names the slot and its state. Without `SERVER_PEER` the server serves alone, as before (torrent-tv/meta#94).
- **New**: A proxy is registered from its tunnel connection when it sends its name with it, because during a release its separate registration request may reach the other instance (torrent-tv/meta#94).
- **New**: With two slots the page is copied into a release directory of its own on the shared volume and nginx serves `current`, which the instance that starts to serve repoints in one step; the previous release is kept for pages loaded just before the switch. Without `SERVER_SLOT` the page is copied into the volume root as before (torrent-tv/meta#94).
- **Fix**: Only the serving instance holds the disk cache open, so the two slots never write its SQLite file at once (torrent-tv/meta#94).
- **Fix**: A page never waits longer than 30 s for one WebRTC connection to open, whatever a caller asks; the server relies on that deadline when it hands over (torrent-tv/meta#94).

## 0.40.0

- **New**: `GET /health` states the free space of the filesystem holding the server cache and the reserve the cache keeps there, as `disk: { freeBytes, reserveBytes }` (`null` without a cache directory). On the droplet that filesystem also holds Docker's images; infra checks after every deployment and every day that the next server image still fits, since a full disk once stopped releases from rolling out without anyone noticing (torrent-tv/meta#71).

## 0.39.5

- **Fix**: A viewing opened from a magnet link — the demo film and every shared link — now tells the proxy which torrent it is watching, so the browser log file the proxy keeps is named after that torrent. Only a viewing opened from a `.torrent` file did, and on the addon host on 2026-10-05 146 of 147 files ended in `-no-torrent-yet` (torrent-tv/meta#123).

## 0.39.4

- **Fix**: The image takes node from Alpine's own `nodejs` package, as the add-on does, instead of copying the official image's binary: one way of getting node, and 135 MB instead of 197 MB on the HA host. The binary was chosen for being three patch releases newer, and none of those three is a security release; 24.18.1, which Alpine ships, is the last one (torrent-tv/meta#98).

## 0.39.3

- **Fix**: The image holds only what the server runs: the server, its routes and services, `public/`, the entrypoint, the licence and the production dependencies. It carried the whole repository — `.claude/`, `AGENTS.md`, the changelog, `docs/`, `openspec/`, the tests and the lint configuration — and the official image's npm, yarn and corepack; the runtime is now Alpine with node copied from that image. Built on the HA host it is 197 MB against 223 MB (torrent-tv/meta#98).
- **Fix**: The site no longer publishes the developers' notes in `public/components/**/README.md` and the file only Chrome DevTools asks for: `public/` is copied into the volume nginx serves, and both reached it, answering 200. The entrypoint also emptied that volume with `*`, which leaves names starting with a dot in place, so a file removed from the image under such a name stayed on the site; it now empties it with `find` (torrent-tv/meta#98).

## 0.39.2

- **Fix**: The page's log no longer loses lines when a send fails. A batch nobody accepted goes back into the queue and leaves with the next send; a batch is kept under the 64 KiB the browser allows a `keepalive` request and `sendBeacon`, which a batch of long lines exceeded and the browser refused; the whole queue is sent each time rather than 50 lines every two seconds; and what was lost and every refused send, by route and cause, are written into the log as one `[client-logger] since …` line. Each line the server prints names the page's send as `batch=<n>`, the same number the proxy prints (torrent-tv/meta#77).

## 0.39.1

- **Chore**: The page no longer asks the browser for viewport and pixel density client hints. Nothing read them: the page measures the viewport itself, in every browser.

## 0.39.0

- **New**: The page asks the browser for client hints of the viewport and pixel density (`Sec-CH-Viewport-Width`, `Sec-CH-Viewport-Height`, `Sec-CH-DPR`). Browsers that implement them state these on every later request; the others send nothing.
- **Fix**: The system media controls receive the chosen poster in every size it is large enough for (185 to 780 pixels wide), so the system takes the one its slot and pixel density need; only the 185-pixel one was offered, which a dense screen enlarges.

## 0.38.0

- **New**: The picture shown while an episode loads, and the poster in the system's media controls (lock screen, media window), is a random one of the work's images that suit the place: the orientation needed and a size large enough for it. Language and rating no longer decide it. One load keeps one picture; choosing another episode or release chooses again.

## 0.37.12

- **Fix**: The waiting notice's poll no longer leaves an unhandled rejection when a failure ends playback while it waits: a read aborted by the session being torn down is not reported, and any other failed read is said once.

## 0.37.11

- **Fix**: While the player rebuilds its media source, the proxy is told the position it is rebuilt at. The emptied element reads zero and the report fell back to the last seek made, so the proxy heard the viewer was at 60 s and stuck 74 s behind its buffer while they were at 80 s.

## 0.37.10

- **Fix**: A media source that ends under the player — Chrome ends it when an append cannot be parsed, while the element itself holds no error — is rebuilt at the position where it ended instead of offering a restart at once. It takes the same steps as a failed element: a rebuild at the position first, a restart only when the same fragment fails again after it. Correction to 0.37.9: that release did not cover this case, because the element held no error.
- **Fix**: Loading continues after the player rebuilds its media source. Every new source attached asked for the playlist again, and asking stops loading, so a recovered player stayed black at zero.

## 0.37.9

- **Fix**: An hls.js error caused by a failed media element is handled by the element's recovery. When hls.js noticed the failure first — a `SourceBuffer` refusing an append to an ended source — the page offered a restart at once instead of rebuilding the source at the position, so one failure had two different answers depending on which side reported it.

## 0.37.8

- **Fix**: Send canonical numeric IMDb IDs to OpenSubtitles to avoid redirects for older titles.

## 0.37.7

- **Fix**: Discover movie subtitles by confirmed IMDb identities when provider records lack TMDB mappings.

- **Fix**: Refine title-qualified candidates by duration after alternative-title discovery.

## 0.37.6

- **Fix**: A failure of the media element is no longer read as the viewer pausing. The pause the element makes after its `error` is recorded as the element's own; an hls.js player rebuilds its media source at the position where the element failed, shows the waiting notice while it does, and starts the picture again unless the viewer had stopped it. A second failure at the same fragment after that rebuild, or a failure on native HLS or a directly played file, offers a restart with the reason. The element's error code and message are logged with the fragment it failed in.
- **Fix**: The player's own moves of the playhead — a jump over a hole and the restore after a media source rebuild — are recognised when the element starts seeking and are not reported to the proxy as the viewer's seek.
- **Fix**: The end of a stall carries the viewer's own decision instead of `!video.paused`, so a picture the browser or this page stopped is started again when its frame arrives.

## 0.37.5

- **Chore**: Update dependencies: 2 package(s) changed in the lock file.

## 0.37.4

- **Fix**: Apply measured duration and the latest-year selection policy to ambiguous alternative-title matches as well as main titles. Distinguish First Blood from Rambo III despite the latter sharing its Rambo First Blood alias in TMDB.

## 0.37.3

- **Fix**: Reset audio, subtitle, playlist and share controls, artwork and source preferences when a torrent closes or is replaced. Owning classes clear their source state and invalidate pending work while preserving subtitle preferences between episodes of the same torrent.

- **Fix**: Preserve provider HTTP messages, original transport and parsing errors and their causes in bounded, redacted diagnostic logs correlated with API requests and browser sessions. Record subtitle search outcomes and metadata selection reasons without logging credentials or download URLs.
- **Fix**: Honour the default TMDB rate-limit pause when an HTTP 429 response omits `Retry-After`.

- **Fix**: Continue movie and anime identification through alternative titles, episode names and transliteration regardless of missing or differing years. Use measured source duration to distinguish otherwise ambiguous titles, preserve catalogue IMDb IDs, and discard superseded metadata responses.

## 0.37.2

- **Fix**: Use canonical OpenSubtitles search URLs, omitting the default page and sorting parameters to avoid API redirects while keeping credentials restricted to their origin.

## 0.37.1

- **Fix**: Cancel pending provider subtitle discovery when metadata withdraws the work or episode match.

## 0.37.0

- **New**: Discover OpenSubtitles and Jimaku subtitle variants from established catalogue identities. Offer embedded tracks first, torrent subtitle files second, and provider variants last; fetch provider files only when selected, preserving playback and rejecting late responses after a file switch. Providers have a shared base class, separate API clients, bounded request queues, response-directed rate pauses and download quota handling.
- **New**: Persist TMDB, AniList, subtitle searches and selected WebVTT files in one independently bounded server disk cache. Evict the least recently accessed records, retain TMDB work details for seven days, reserve disk space, and perform SQLite operations outside the signalling thread. Cache errors never become claims that a work or subtitle is absent.

## 0.36.18

- **Fix**: A connection that stays open and stops delivering is noticed when its next delivery is overdue, not after 60 s of silence. The proxy sends a numbered probe every half second; the gaps between consecutive probe numbers give this connection's own rhythm (mean plus four mean deviations, the gains of RFC 6298 adapted to heartbeat gaps), and a silence longer than that with requests waiting, and nothing received but not yet handled, is a stall. On 2026-09-28 the 60 s bound equalled the viewer's 60 s cushion, and the picture stopped the second the wedge was declared.
- **Fix**: A stalled connection is replaced only once a second connection to the same proxy has proved itself: the viewer is named on it, the session on screen answers there, and the soundtrack is recorded again there. If the old connection delivers first, the second is closed and the viewer stays where they were. Requests still waiting on the replaced connection are answered at once as replaced, and the player asks for those segments again on the new one. After 60 s of unbroken silence the connection is declared lost and the reconnect ladder rebuilds as before.
- **Fix**: Every reconnect restates the soundtrack before the player loads anything. The proxy forgets a viewer when their last connection closes, and served the sound of a viewer it did not know as a copy; on 2026-09-28 that put a different soundtrack under the same address after a reconnect, the player ended its audio stream, and the picture stood still for an hour. A soundtrack the proxy does not confirm as recorded counts as a failed attempt.

## 0.36.17

- **Fix**: The link the page measures when it connects reaches the proxy in the first report. The measurement ran at once, but the reporter started each session with an empty sample window, so every report said nothing about the link until segments had been delivered — 17 s of `link=?` in the field on 2026-10-03, after the probe had carried 2 MiB at 30-37 Mbit/s. The measured figure is now kept as the link's last known speed.

## 0.36.16

- **Chore**: Update dependencies: @fastify/websocket 11.3.2 → 11.3.3; 1 package(s) changed in the lock file.

## 0.36.15

- **Chore**: A release is now rolled out by writing the image version and digest into torrent-tv/infra, which doco-cd applies on the droplet; the release waits until the site serves the new version. Watchtower no longer updates the server.

## 0.36.14

- **Chore**: Update dependencies: @fastify/cors 11.2.0 → 11.3.0, @fastify/helmet 13.0.2 → 13.1.1, @fastify/static 10.1.2 → 10.1.5, @fastify/websocket 11.2.0 → 11.3.2, hls.js 1.6.16 → 1.7.3, media-chrome 4.19.2 → 4.19.3, ws 8.21.1 → 8.22.0, @biomejs/biome 2.5.7 → 2.5.15, knip 6.32.0 → 6.39.0; 73 package(s) changed in the lock file, 4 removed.
- **Fix**: Four failure paths in the page that said nothing now say so: a failed seek is written to the client log with whether a retry is offered, an unreadable buffer limit is logged as a warning while the network report still goes, and the two cases where an empty answer is the reading (the buffered ranges of a removed source buffer, a subtitle metadata note that is not JSON) state why.

## 0.36.13

- **Fix**: Describe a proxy capacity refusal without incorrectly blaming another viewer.

## 0.36.12

- **Fix**: The subtitle menu identifies each track by a key this page keeps, not by its label and language. media-chrome's captions menu found a track again by both; once a track's label changed — "Unknown" becoming a language — its item matched no track, and choosing it turned nothing on. Two tracks with one label each matched the other's item, and choosing one showed both. The menu is now drawn by the player from keyed items, a label change redraws the item without losing the choice, identical labels get an ordinal, and "Off" is an item of its own.
- **Fix**: The subtitles key `c` uses this page's own choice — the track chosen last, or the one the file opens with — instead of media-chrome's language preference. It is ignored while typing and while the player refuses its keys.
- **Fix**: The film's audio language is no longer used as a subtitle language. Subtitles usually translate the sound, so that language was the least likely one, and an English track was labelled "Japanese".
- **New**: Cues carry the number the proxy gave them; a cue the proxy takes back is removed from its track, even while the track is disabled.

## 0.36.11

- **Fix**: Restore shared-link episodes by their file identity when the proxy returns a reordered file list.

## 0.36.10

- **Fix**: Record the selected episode and its requested position before playback preparation. Preserve that intent during old media events and refresh; playlist selections start at zero and shared links do not apply a second late seek.
- **Fix**: Show the waiting step, current download/track-processing facts and total time until playback in three rows. Preserve concurrent download facts, count down the proxy forecast in local elapsed time and report missing measurements or stalled service without an estimating placeholder.

## 0.36.9

- **Fix**: A refusal names the part of the video that has no figure — its picture, its soundtrack or both — and offers another soundtrack only when the file has one; no refusal suggests a lower quality, which the page does not offer, and only a load too large suggests a faster connection.
- **Fix**: Preparing a switch of soundtrack states whether this browser plays THAT track (`transcode=0|1`), so the proxy decides how the new track is produced instead of reusing the previous track's mode, and the log says when the proxy sends a soundtrack re-encoded that the page asked to copy.

## 0.36.8

- **New**: Resolve release properties through a configurable rule registry with explicit dependencies, unchanged parser outputs, candidate provenance, rejection reasons and unresolved alternatives.
- **Fix**: Preserve uncertainty when a possible episode overlaps conflicting year evidence; accept explicitly marked episodes and large anime episode numbers without an arbitrary upper bound.

## 0.36.7

- **Fix**: Try complete reverse-transliterated Russian title spellings before broad word discovery, preserving missing soft signs and identifying an unambiguous yearless title without unrelated word results exhausting the candidate budget.

## 0.36.6

- **Fix**: Retain release years after season markers and identify Russian transliterated titles through bounded Cyrillic discovery with full catalog-title verification; missing years no longer disable this fallback, while known years and ambiguous matches remain checked.
- **New**: Parse release names with GuessIt and Anitomy, return both source readings with normalized technical hints and disagreements, and exclude technical release tails from episode-title evidence.

## 0.36.5

- **Fix**: Treat the native seeking event generated by a timeline request as the same action, even when the browser rounds the selected time.

## 0.36.4

- **Fix**: Capture timeline seek requests before video metadata is available, acknowledge the selected position with the proxy before restarting HLS, and retain it through allocation, recovery, and URL reloads.
- **Fix**: Abort outstanding WebRTC segment requests when seeking or replacing playback; discard superseded responses and prebuffer work.

## 0.36.3

- **Fix**: Hide the playlist button and prevent opening the playlist when fewer than two video files are available; close an open playlist when switching to a single-video release.

## 0.36.2

- **New**: After TMDB and AniList return no identity, discover bounded title-word candidates and verify the entire release title against Russian catalog transliteration with an exact year. Reject ambiguous, incomplete, and conflicting evidence.
- **New**: Retry an unidentified release once with explicit metadata from subtitles already loaded for playback; ignore generic series subtitle titles and dialogue.

## 0.36.1

- **New**: Add About with provider credits, release titles in the playlist and page title, and English episode labels when only release numbers are known.
- **New**: Query AniList for anime hints, TMDB anime records, and releases absent from TMDB; require exact titles and years, retain TMDB episode matching, and keep a single named season expanded.
- **New**: Select portrait or landscape work artwork for the player, size it for device pixel density, and center insufficient originals without enlargement.

## 0.36.0

- **New**: When no main or original title matches and the names state a year, a release is also compared with TMDB's alternative titles of the first five results the year admits, which hold the transliterated and romanized spellings: `Trudno byt' bogom` for "Hard to Be a God", `Hauru no Ugoku Shiro` for "Howl's Moving Castle". The comparison is exact equality, and two works matching are ambiguous. A series still unidentified then goes on to its episode names, which can also choose between two works the alternative titles both matched.

## 0.35.0

- **New**: A series whose release name shortens its title (`Poirot.1989-2013` for "Agatha Christie's Poirot") is identified by its episodes when no title matches: among the first five results a stated year admits, the one whose season carries at least two, and at least half, of the files' episode titles exactly. The page sends those titles with its identification of a series.

## 0.34.1

- **Fix**: Render the audio-track button as an outline icon and give its hover tooltip a label.
- **Fix**: Keep the exit button reachable while the playlist slides open, retaining synchronized player control hiding.

## 0.34.0

- **New**: The page asks the metadata service what a release is as soon as it is chosen, and shows the answer when the proxy has said what is in it: numbered episode titles in the playlist ("2. Murder in the Mews", season names on season folders), the episode's still or the work's image in the player while a file loads, and the title in the system media controls. Only exact matches are shown; anything else keeps the release's own names. A series whose provider record lacks the seasons its files name is not shown, and one picture of a release not known to be one work is identified only when its name states a year. An answer for a replaced choice of release is dropped, and nothing on the playback path waits for any of it.

## 0.33.1

- **Fix**: An episode number the provider's season does not have now stops matching by number for the whole season, as a title pointing elsewhere already did. Measured on Firefly: the release numbers fourteen episodes in production order, TMDB lists eleven in broadcast order, and numbers 1-11 were named with the wrong episodes; those files now keep their own names.
- **Fix**: A search result without a date is never taken as the work. `The Continental 1 - LostFilm.TV` had matched a dateless `The Continental` instead of the series it is, none of whose episodes existed there.
- **New**: `requireYear` on `POST /api/metadata/identify`: identify only when a name states a year. Used for one picture of a release not known to be one work, where a performer's folder name had matched a film of the same name.

## 0.33.0

- **New**: Film metadata through this server, from TMDB: `POST /api/metadata/identify` (which work a release is, from its names), `POST /api/metadata/episodes` (which episode of one season each file is) and `GET /api/metadata/image/:size/:file` (TMDB images with TMDB's own caching headers). A work is reported only when every search completed and exactly one title matched exactly; ties, incomplete searches and too many result pages are reported as such. Load on TMDB is bounded by one gate (4 at once, 10 per second, 32 waiting), requests by a 4 s deadline, answers by byte limits while they are read; searches, works and seasons are cached in memory under an 8 MB serialized budget for at most 24 hours, and refusals are never cached. The token is read from the file named by `TMDB_READ_TOKEN_FILE`; without it every answer is `unavailable`. Names and file lists are neither stored nor logged.

## 0.32.1

- **Fix**: Preserve an unavailable proxy playback delay as unknown instead of displaying zero seconds until playback.

## 0.32.0

- **New**: Group a torrent's episodes by folder in the playlist, each season in a collapsible `<details>` section; the section holding the playing episode opens by itself.
- **Fix**: Show text in the player in a sans-serif face; it fell back to the browser's default serif font.

## 0.31.8

- **Fix**: Report each HLS track's applied timestamp origin so the integral forecast compares prepared media with the actual browser timeline.

## 0.31.7

- **Fix**: Use the existing complete session-creation deadline for its transport request, so a bounded keyframe wait can return before the browser cancels it.

## 0.31.6

- **Fix**: Send the initial browser link measurement and buffer ceiling with a transcode-session request so the proxy can forecast readiness before regular reporting starts.
- **Fix**: Report separate video and audio buffer intervals, including future ranges after a hole, to the proxy's integral playback forecast.
- **Fix**: Do not describe a temporarily missing forecast as an incompatible proxy protocol.

## 0.31.5

- **Fix**: Refresh stale link measurements during startup waiting, report their actual age, and cancel startup probes when the viewing session closes.

## 0.31.4

- **Fix**: Forward the browser's buffer ceiling into viewer reports so the proxy readiness model receives its required client-capacity input and can produce a start estimate.

## 0.31.3

- **Fix**: Report the same playable-buffer depth used by the browser's startup wait, including small initial timestamp offsets, so the proxy readiness model receives the actual client cushion.

## 0.31.2

- **Fix**: Use the proxy's versioned playback forecast as the sole startup release rule and remove the duplicate client-side readiness calculation.
- **Fix**: Show the proxy's remaining-wait estimate and explain when a proxy does not yet return the required forecast.

## 0.31.1

- **Fix**: Refresh sidecar audio track labels and properties after their container header becomes available, while preserving the active track indices and HLS rendition count.

## 0.31.0

- **Fix**: Keep playback paused until the measured arrival rate and buffered media can cover the entire remaining video without a stall. Below-realtime streams can start after buffering the projected whole-film deficit; long waits remain waits, and a buffer ceiling that cannot cover the deficit no longer releases playback.
- **Fix**: Associate each HLS buffer-ceiling report with its playback attempt, so a late report from an earlier attempt cannot change the active readiness gate.

## 0.30.9

- **Fix**: Start playback once the browser fills its lower, device-accepted buffer ceiling after refusing a deeper cushion, instead of waiting for a refill rate that cannot be measured while the buffer is full.

## 0.30.8

- **Fix**: Keep playback waiting until the measured media rate can sustain realtime playback, or the browser already holds the entire remaining video. A long forecast does not trigger a timeout or an early start.

## 0.30.7

- **Chore**: Record the skipped fragment, gap size, and separate audio/video buffer ranges when HLS jumps over a buffered hole, so the track and boundary behind a visible discontinuity can be identified.

## 0.30.6

- **Fix**: Preserve LF line endings for shell scripts and Dockerfiles on Windows checkouts, so the Alpine entrypoint starts correctly.

## 0.30.5

- **Fix**: Keep the loading screen visible until the measured browser buffer meets the real-time readiness rule. Slow but progressing downloads or encodes no longer start playback after a fixed timeout; the estimate and readiness gate now use the same sustained-rate condition, and unknown estimates are shown as `Estimating…`.

## 0.30.4

- **New**: Use explicit resolution and codec hints from the selected filename to prefer proxies that report capacity for that media. The file's probed metadata remains authoritative.

## 0.30.3

- **Fix**: Resolve selected torrent files by their original metadata index after sorting the display list, so playback uses the intended video file.

## 0.30.2

- **Chore**: Update Fastify and its transitive dependencies to releases that clear the current npm advisories.
- **Chore**: Remove an unused track identity import and document the expected fallback for invalid language tags.

## 0.30.1

- **Fix**: Remove stale proxy registry records after their tunnel has stayed closed for 24 hours; brief disconnects retain the record and its reachability result.

## 0.30.0

- **Fix**: Preserve `sidecarSubtitles` from the proxy playback plan in the browser session. The loading component now receives the proxy's matched subtitle files and can load them beside the selected video; older proxies without the field still produce an empty list.

## 0.29.0

- **Chore**: While a seek is unresolved, the browser log records each buffered fragment's track, sequence number and playlist interval beside the current time, ready state and audio/video buffer ranges. This distinguishes a short append from a delayed response (`public/domain/hls-player.js`, `FRAG_BUFFERED`).
- **New**: A proxy that refuses an output with `no-capacity` is checked against the rest of the pool before video starts. Proxies without reported encoding headroom are left out when another reports room; when every proxy is full, the page retains the candidates and the output opening decides. If another proxy reports that it can serve the file, the page reconnects and prepares the file there before showing video; each refused proxy is excluded for that opening attempt.
- **New**: `NoCapacityError` preserves the proxy's reason and figures for the log and exposes a retryable machine refusal to the loading flow (`public/domain/proxy-outcome.js`).

- **Fix**: An answer of the proxy about a viewer's output (`output-unavailable`, `assignment-lost`) is acted on only when it belongs to the viewing on screen: the output its request addressed must be the one the page plays, and the viewing its request was stamped with must be the current one. It used to reach one list for the whole page with neither, so an answer to a request made before a seek, or for the file played before this one, could seek and reload the video now playing. After the new viewing is reported, the reload is made only if the same output is still playing (`public/domain/proxy-outcome.js`, `outcomeBelongsTo`).

- **New**: THE QUALITY IS ALWAYS THE AUTOMATIC CHOICE (roadmap item 98). The quality menu and the settings menu behind the "..." button are gone; the viewer's report says `qualityMode: "auto"` on every report, because a proxy treats a page that says nothing as one that picked its size by hand. A copy of the source is re-encoded only when this browser cannot play its codec — never to make the picture smaller.
- **New**: The audio track button sits on the control bar beside the captions button, and opens its own menu (`player__audio-button`, `player__audio-menu`). It stays hidden until a file has more than one track.
- **New**: THE PICTURE AS THE VIEWER SEES IT bounds the height of a re-encoded output (`public/domain/visible-picture.js`). Measured from the `<video>` element's size, the video's proportions and the computed `object-fit` and `object-position`, in physical pixels (`devicePixelContentBoxSize`, otherwise `devicePixelRatio`); followed by a `ResizeObserver` on the element and a `matchMedia` query on the pixel density; sent when the output is opened (`visiblePicture`) and in the report the moment it changes. It replaces a box made of the window's long and short edges times the pixel ratio times a chosen 0.95, which on an upright phone asked for a picture about three times taller than the one shown. The proxy chooses the rung (proxy 2.87.0).
- **New**: A move between outputs the proxy asks for is made when the rung is ready — the piece the player asks for next is closed on it — and, unless the proxy says the viewer's buffer would run dry first (`requestedUrgent`), once the viewer holds the cushion this file needs (`minimumBufferSeconds`). A move the proxy stops asking for is dropped.
- **Chore**: The player's own light and dark theme is removed (`player.css`, `playlist.css`): the controls, the peer pill and the share menu use media-chrome's own default colours.
- **New**: A request over the data channel tells the proxy how long this page will wait for it (`X-Hold-Ms`: the request's deadline less the last measured round trip), so a held request is answered while somebody is still waiting. The proxy used to hold for a figure of its own that equalled the page's, and its "retry" arrived after the page had given up (proxy 2.87.0).
- **New**: The viewer's report says which rung the player is playing (`playingHeight`), and is sent the moment hls.js has switched. The proxy used to infer the rung from which rung's segments were requested, which is the player fetching rather than the picture having moved (proxy 2.87.0).
- **New**: `test/net-report-quality-mode.test.js` — the mode is always `auto`; the playing height and the visible picture are sent as stated, and left out when the page cannot say. `test/visible-picture.test.js` — the measurement, per `object-fit`, position, orientation and pixel source.
- **New**: Each request the page makes carries the viewing it was made in (`generation`, raised on the viewer's own seek before anything is sent), so the proxy answers a repeat by what answered it the first time and refuses a request for a viewing already left (proxy 2.87.0).
- **New**: THE PAGE ANSWERS WHEN NOTHING FITS THE VIEWER'S CONNECTION. The proxy no longer hands over a stream it knows the viewer's link cannot carry; it answers `output-unavailable` with the figures (proxy 2.87.0). A move to such a rung is not made and the viewer keeps what is playing; a film that cannot be opened at all says so, with Retry (`public/domain/proxy-outcome.js`).
- **New**: A part of the film the proxy can no longer give as it did (`assignment-lost`: the output that answered it has gone and nothing proven to match its header can stand in) is answered by starting a new viewing where the picture is: the page raises its viewing, and the player loads the stream again so it fetches its headers anew (`hls-player.js`, `reloadAt`). The same request is never repeated against the old viewing, which the proxy would answer the same way for ever.
- **New**: A quality the proxy admitted only by an estimate of what it sends (`servingVerdict: "estimated to fit"`) is logged as such.
- **New**: `test/proxy-outcome.test.js` — outcomes read from the proxy's answers, delivered to listeners, and described to the viewer in terms of their connection.

## 0.28.0

- **Fix**: THE PAGE'S REPORT ABOUT ITSELF NO LONGER DEPENDS ON HAVING MEASURED ITS LINK. Where the viewer is, how much film they hold, whether the picture is moving, whether they are blocked on us, whether the tab is on screen — all of it rode inside a report that was skipped whenever no lin…50973 tokens truncated… pause" while the target data is still loading keeps the indicator visible. (The spinner already clears on file switch, and on the picker/loading/error screens.)

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

