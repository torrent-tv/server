import { waitForMediaReady } from "../../domain/media-ready.js";
import { createHlsPlayer } from "../../domain/hls-player.js";
import { SeekPosition } from "../../domain/seek-position.js";
import { openingAudioTrack } from "../../domain/audio-opening.js";
import { PlaybackTasks } from "../../domain/playback-tasks.js";
import { shouldReportWaiting } from "../../domain/waiting-signal.js";
import { APP_EVENT, APP_STATE, isWaiting } from "../../domain/app-state.js";
import { StateDerivedView } from "../../shared/state-derived-view.js";
import {
  consumePauseCause,
  noteElementFailed,
  noteElementRecovered,
  viewerHasStopped,
  PAUSE_CAUSE,
  pauseWithoutIntent
} from "../../domain/playback-intent.js";
import { describeMediaFailure } from "../../domain/media-failure.js";
import { measureLink, reportNow } from "../../domain/net-report.js";
import { onProxyOutcome, outcomeBelongsTo } from "../../domain/proxy-outcome.js";
import { describeFailure, viewerError } from "../../domain/viewer-failure.js";
import { lastProxyRefusal } from "../../domain/proxy-refusal.js";
import { VisiblePictureWatch } from "../../domain/visible-picture.js";
import { PROXY_EVENTS, WAITING_EVENTS } from "../../shared/events.js";
import { StageTimeline } from "../../domain/stage-timeline.js";
import { getDebugState } from "../../shared/debug-state.js";
import { TorrentSession } from "../../domain/torrent-session.js";
import { ProxySelector } from "../proxy-selector/proxy-selector.js";
import { ProxyTransport } from "../../domain/proxy-transport.js";
import { createWebRtcHlsLoader } from "../../domain/webrtc-hls-loader.js";
import { queryLocalNetworkPermission, probeLocalNetwork } from "../../domain/local-network-permission.js";
import { APP_EVENTS, ERROR_EVENTS, LOADING_EVENTS, MEDIA_INFO_EVENTS, PLAYER_EVENTS, SESSION_EVENTS, signalApp } from "../../shared/events.js";
import {
  buildUrlSearch,
  decideHistoryWrite,
  decideNavigation,
  isAdvanceToNext,
  fileOpenState,
  playbackStateToRecord,
  readUrlState,
  resumePositionFor,
  sameRecord
} from "../../domain/url-state.js";
import { addressRecord } from "../../domain/media-info.js";
import {
  magnetNamesATracker,
  mediaFilesFrom,
  normalizeRemoteFileList,
  statesWhatIsInTheTorrent
} from "../../domain/torrent-parser.js";
import { WaitingModel } from "../../domain/waiting-model.js";
import { bufferedAheadSeconds, bufferedEndSeconds } from "../../domain/buffer-metrics.js";
import { trackLanguageTag, trackLanguageCode, languageName } from "../../domain/track-language.js";
import { SubtitlePlayback } from "./SubtitlePlayback.js";
import { subtitleStartHold } from "../../domain/subtitle-start.js";
import { mediaInfoHintFromFilename } from "../../domain/release-hints.js";
import { categoryOfTorrent } from "../../domain/torrent-category.js";

/**
 * One attempt to connect a proxy, and everyone waiting on it.
 *
 * @typedef {object} TransportAcquisition
 * @property {Promise<import("../../domain/proxy-transport.js").ProxyTransport>} promise
 * @property {Set<(proxyName: string) => void>} listeners - Each waiting
 *   caller's progress callback.
 * @property {string | null} announced - The proxy named to them, once one has
 *   been chosen. Replayed to a caller that joins after the announcement.
 */

// Auto-reconnect after a mid-playback connection loss (see the auto-reconnect
// OpenSpec change). Attempts 1..2 retry the SAME proxy (seamless swap under
// the live player); attempt 3 falls back to a full re-selection + rebuild.
const RECONNECT_SAME_PROXY_ATTEMPTS = 2;
const RECONNECT_TOTAL_ATTEMPTS = 3;
const RECONNECT_CONNECT_TIMEOUT_MS = 10_000;
const RECONNECT_BACKOFF_MS = 2_000; // pause before attempt 2
const RECONNECT_STABLE_RESET_MS = 30_000; // healthy playback resets the cycle count
const RECONNECT_MAX_CYCLES = 3; // consecutive loss→recover cycles before giving up

/**
 * How many channels a soundtrack carries, in the words a viewer uses for them.
 *
 * @param {number | null | undefined} channels
 * @returns {string}
 */
function channelLayoutName(channels) {
  const count = Number(channels);
  if (!Number.isFinite(count) || count <= 0) {
    return "";
  }
  if (count === 1) {
    return "mono";
  }
  if (count === 2) {
    return "stereo";
  }
  if (count === 6) {
    return "5.1";
  }
  if (count === 8) {
    return "7.1";
  }
  return `${count} channels`;
}

/**
 * Human label for one soundtrack: its language, who made it, and what it is.
 *
 * Three things, and each has one source that is allowed to answer it:
 *
 * - the LANGUAGE is the container's own where the file states it, and where it
 *   does not — which is usual for a dub shipped as a separate file — the folder
 *   the release put it in (`Rus Sound/`);
 * - the RELEASER is a bracketed group in that file's own path which the picture
 *   does NOT also carry. A dub named exactly like the video says nothing about
 *   its author, and naming the video's release group there would be inventing
 *   one;
 * - the TYPE is what the container declares about the track's role —
 *   commentary, audio description, the original language — read from the flags
 *   RFC 9559 defines for exactly this and which ffmpeg's banner does not carry.
 *
 * @param {{ index: number, language?: string, languageBcp47?: string, title?: string,
 *   kind?: string, folders?: string[], fileName?: string, channels?: number | null,
 *   isCommentary?: boolean, isVisualImpaired?: boolean, isOriginal?: boolean }} track
 * @param {string} [videoName] - The picture's file name, for the releaser rule.
 * @returns {string}
 */
function buildTrackLabel(track, videoName = "") {
  const parts = [];
  // Read by the PROXY, by the grammar that also paired this file with this
  // picture. Reading the same path again here is how one name came to have
  // two answers.
  const naming = track?.naming ?? { code: null, name: null, releaser: null };
  const code = trackLanguageCode(trackLanguageTag(track) || "") || naming.code || "";
  if (code) {
    try {
      parts.push(languageName(code) || code);
    } catch {
      // silent-ok: a browser without a display name for this language tag says
      // so by refusing; the tag itself is then the best label there is.
      parts.push(code);
    }
  } else if (naming.name) {
    parts.push(naming.name);
  }
  if (typeof track.title === "string" && track.title.trim().length > 0) {
    parts.push(track.title.trim());
  } else if (naming.releaser) {
    parts.push(naming.releaser);
  }
  if (parts.length === 0) {
    parts.push(`Track ${Number(track.index) + 1}`);
  }
  const marks = [];
  if (track?.isCommentary === true) {
    marks.push("commentary");
  }
  if (track?.isVisualImpaired === true) {
    marks.push("audio description");
  }
  // Only where the track is not the only one that could be original — saying it
  // of a single-track file tells the viewer nothing they can act on.
  if (track?.isOriginal === true && !track?.isCommentary) {
    marks.push("original");
  }
  const layout = channelLayoutName(track?.channels);
  if (layout) {
    marks.push(layout);
  }
  const base = parts.join(" — ");
  return marks.length > 0 ? `${base} · ${marks.join(" · ")}` : base;
}
import { trackIdentity, findTrackByIdentity } from "../../domain/track-memory.js";

/**
 * What a soundtrack IS, in the terms a choice of it survives an episode switch
 * in: the language and whoever made it.
 *
 * Read from the same two sources `buildTrackLabel` shows the viewer, and in the
 * same order — so what is remembered is what they picked by, and not some other
 * reading of the same track.
 *
 * @param {object} track - One entry of the plan's audio list.
 * @param {string} [videoName] - The picture's file name, for the releaser rule.
 * @returns {{ code: string, releaser: string | null } | null}
 */
function audioTrackIdentity(track, videoName = "") {
  // Read by the PROXY, by the grammar that also paired this file with this
  // picture. Reading the same path again here is how one name came to have
  // two answers.
  const naming = track?.naming ?? { code: null, releaser: null };
  const title = typeof track?.title === "string" ? track.title.trim() : "";
  return trackIdentity({
    code: trackLanguageCode(trackLanguageTag(track) || "") || naming.code || "",
    releaser: title.length > 0 ? title : naming.releaser
  });
}

/**
 * Loading view.
 *
 * Responsibilities:
 * - Show progress/status while processing torrent playback pipeline.
 * - Execute playback preparation pipeline on `LOADING:PROCESS_PLAYBACK`.
 * - Hide itself when player or error views are shown.
 */
export class Loading extends StateDerivedView {
  static SELECTOR = {
    actionButton: "#loading__action",
    // The overlay's own text line — the one the seek case already used. There
    // is one waiting interface, so there is one place its words go.
  };

  static MESSAGES = {
    missingDomNodes: "Loading component DOM nodes are missing.",
    readingTorrentFile: (fileName) => fileName,
    readingMetadata: "Reading torrent metadata...",
    selectingProxy: "Selecting proxy...",
    connectingToProxy: "Connecting to proxy...",
    fetchingMetadata: "Fetching file metadata...",
    checkingCompatibility: "Checking playback compatibility...",
    preparingHls: "Preparing HLS transcode...",
    preparingHlsAudio: "Audio codec requires transcode. Preparing HLS...",
    preparingHlsVideo: "Video codec requires transcode. Preparing HLS...",
    startingDirectPlayback: "Starting direct playback...",
    probingDirectPlayback: "Verifying direct playback before transcoding...",
    noVideoFile: "No video file found in this torrent.",
    torrentContentsNotStated:
      "This proxy could not say what is in this torrent. Try again — another proxy may answer.",
    noProxyAndNoWebseed: "No proxy is available and this torrent has no webseed video source.",
    alreadyProcessing: "Already processing another .torrent file.",
    selectedFileNotFound: "Selected video file was not found in torrent metadata.",
    selectedFileUnsupported: "Selected video file format is not supported by the browser.",
    fallingBackToTranscode: "Direct playback unsupported. Falling back to on-the-fly transcode...",
    fallingBackToVideoTranscode: "Video track unsupported. Falling back to on-the-fly video transcode...",
    playerNotReady: "Player is not ready.",
    startingTorrentProcessing: "Starting torrent processing...",
    switchingToSelectedFile: "Starting selected video...",
    chooseVideoFile: "Choose a video file from playlist.",
    headerDownloadStalled:
      "Torrent isn't downloading — no peers reachable for this file. Try again later or pick another source.",
    // The player itself has died and cannot be revived in place. Says what to
    // do rather than what broke: the viewer can only start it again, and
    // starting again does work — the position is remembered.
    playerCannotContinue:
      "The video player stopped and can't continue. Press Retry to start it again from where you were.",
    // Said instead of opening a session that will stall. The proxy answers what
    // it can sustain for this file at every height, including copying the
    // picture, which costs it no encoder at all; when nothing is left there is
    // no quality that would work and starting anyway produces a slideshow —
    // and takes the swarm and the processor from whoever is already watching.
    // Retry is offered because the answer changes: it is measured against the
    // machine as it is now, and a machine frees up.
    proxyCannotKeepUp:
      "This proxy doesn't currently have enough capacity to prepare this video. "
      + "Press Retry in a moment, or pick a different proxy or file.",
    // Shown with the picture STOPPED while the chosen soundtrack is prepared.
    // The alternative is letting the film run on in a language the viewer does
    // not understand and leaving them to seek back afterwards, which is a worse
    // thing to do to them than a wait they can see the reason for.
    audioPreparing: "Preparing the soundtrack you chose…",
    connectionLost: "Connection to the video source was lost. Press Retry to continue from where you were.",
    reconnecting: "Reconnecting...",
    waitingForNetwork: "Waiting for the network to come back…",
    switchingAudio: "Switching audio track...",
    // Says what was observed and nothing else. It used to name the local
    // network as the cause, and on 2026-08-09 it did so while ICE was complete
    // over global IPv6, the send queue was empty and progress polls were being
    // answered in 9-43 ms — the one thing known to be in order. The real fault
    // was on the proxy, and this message cost real time on the way to finding
    // it. A message must not name a cause it has not established.
    lanPermissionExplainer:
      "The video source is a device on your own network. Your browser asks for permission before a website may talk to it — press Allow and confirm the browser's question.",
    lanPermissionWaiting: "Waiting for the browser's local network permission...",
    lanPermissionDenied:
      "Local network access is blocked for this site, so the video source on your network cannot be reached. Enable \"Local network\" in the browser's site settings (the icon next to the address), then press Check again.",
    lanAllowButton: "Allow",
    lanCheckAgainButton: "Check again",
    fetchingMagnetMetadata: "Fetching torrent metadata from the swarm...",
    // Two different situations, and the difference is in the link itself.
    //
    // A magnet may carry the trackers of the torrent it came from (`tr=`), and
    // then failing to find anyone means the swarm really is empty or
    // unreachable. A magnet pasted from elsewhere often carries NONE, and then
    // nothing was ever asked of a tracker: only the distributed hash table
    // could look, and for a swarm that lives on a tracker it finds nobody. The
    // old message said "no peers reachable" for both, which names a consequence
    // and hides the one thing the viewer could act on. Established 2026-08-20:
    // this app's own share links carry every tracker of the original file, and
    // with them the same film reached 52-67 seeders.
    magnetMetadataFailed:
      "Could not fetch metadata for this magnet link — no peers reachable. Try again later.",
    magnetMetadataFailedNoTrackers:
      "This magnet link names no tracker, so only the distributed hash table could look for the swarm — and it found nobody. The link is incomplete rather than the file being dead: a link that carries its trackers, or the original .torrent file, will usually work."
  };



  /** The last figure shown, and when — so the countdown can only go down. */
  /**
   * Whether this file has ever actually played. Distinguishes the first open —
   * where OUR prebuffer gate decides when the player is revealed — from a
   * later wait, where the player resumes by itself as soon as it has anything.
   * `#isProcessing` was used for this and is not the same thing: it is still
   * false for the first ticks of a cold open, which took those ticks down the
   * resume path and showed a 2 s target where 15 s was going to be enforced.
   */
  #hasPlayedOnce = false;
  /** When the address bar last received the playback position. */
  #urlPositionWrittenAt = 0;
  /** A rebuild after the proxy lost the session is in flight. */
  #rebuildingSession = false;
  /** A Back/Forward navigation is being carried out; see #onHistoryNavigate. */
  #navigatingHistory = false;
  /** What the metadata component last published (`MEDIA_INFO:CHANGED`), or `null`. */
  #mediaInfo = null;
  /** The pictures the proxy said the open torrent holds, with their episode markers. */
  #contentsItems = [];
  /** Said once per player: a torn-down element's zero is not a position. */
  #torndownPositionReported = false;
  /** The loading screen stepped aside for the playlist drawer. */
  #playlistOpenedFromLoading = false;

  /**
   * Which choice of release this is, for the metadata component: its answers
   * are dropped when they arrive for a choice that has been replaced.
   */
  #mediaSelection = 0;

  /** `selection:fileIndex` of the files whose hash was asked of the proxy. @type {Set<string>} */
  #fingerprintsAsked = new Set();

  /** Files whose container metadata was asked for, by `selection:fileIndex`. */
  #containerAsked = new Set();
  #actionButton;
  #videoElement = null;
  #session;
  #proxySelector;
  #hlsPlayer;
  #isProcessing = false;
  #diagnosticsAttached = false;
  #directPlaybackUnsupportedCache = new Set();
  #directPlaybackHints = new Map();
  /** @type {import("../../domain/webrtc-proxy.js").WebRtcProxy | null} */
  #proxy = null;
  /**
   * Proxies that answered they could sustain the file being opened, or null.
   *
   * Set only after one has refused it. The next transport is chosen from these
   * alone — the ordinary score cannot express "and it must be able to serve
   * THIS file", because a viewer is given a proxy before the file is known.
   *
   * @type {string[] | null}
   */
  #restrictProxiesTo = null;
  /** Proxies already refused for the file in the current opening attempt. @type {Set<string>} */
  #refusedProxiesForThisOpen = new Set();

  /**
   * The description of the file being opened that the rest of the pool
   * answers by arithmetic, as the proxy's plan carried it. Kept for the one
   * moment it is needed after the plan: the output being opened is refused
   * for want of a place on that machine, and the pool is asked before anything
   * plays (roadmap item 97, step 14).
   *
   * @type {object | null}
   */
  #mediaInfoForOffer = null;
  /** @type {import("../../domain/proxy-transport.js").ProxyTransport | null} */
  #transport = null;
  /**
   * The connect currently in flight, and everyone waiting on it. Null when no
   * connect is running. See {@link #acquireTransport}.
   *
   * @type {TransportAcquisition | null}
   */
  #transportAcquisition = null;
  /** @type {number} Index of the file currently playing (-1 = none). */
  #activeFileIndex = -1;
  /** @type {number} Invalidates late sidecar metadata responses after a file switch. */
  #audioMetadataRefreshSeq = 0;
  /**
   * Snapshot taken at the moment the proxy connection was lost, consumed by
   * the Retry action. Captured BEFORE the error flow runs, because the error
   * screen's #stopPlayback() clears `session.current`.
   *
   * @type {{ fileIndex: number, positionSeconds: number, sessionCurrent: object } | null}
   */
  #resumeState = null;
  /**
   * Descriptor of the last successfully connected proxy, so the auto-reconnect
   * flow can rebuild the SAME connection (same candidate policy → no permission
   * question on the same-proxy path). Refreshed by #adoptProxy on every
   * successful connect.
   *
   * @type {{ proxyId: string, proxyLocalPort: number | null, allowPrivateCandidates: boolean } | null}
   */
  #lastProxyDescriptor = null;
  /**
   * Count of consecutive loss→recover cycles. Reset to 0 after playback
   * survives {@link RECONNECT_STABLE_RESET_MS}. Guards against an endless
   * reconnect loop when playback keeps dying immediately after recovery.
   *
   * @type {number}
   */
  #reconnectCycles = 0;
  /** @type {ReturnType<typeof setTimeout> | null} Pending cycle-count reset timer. */
  #stableTimer = null;
  /**
   * A second connection being raised beside one whose delivery has stopped,
   * and the connection it is for. Null when none is.
   *
   * @type {{ from: import("../../domain/webrtc-proxy.js").WebRtcProxy, cancelled: boolean, startedAt: number } | null}
   */
  #rotation = null;
  /**
   * Cooperative cancellation for the in-flight loading flow. Checked at the
   * await boundaries via #throwIfCancelled(); the thrown AbortError rides the
   * existing silent abort-error handling, which also guarantees a cancelled
   * flow can never reach its PLAYBACK_READY dispatch.
   *
   * @type {boolean}
   */
  #cancelRequested = false;
  /**
   * Monotonic id of the current playback attempt. Bumped when a new attempt
   * starts and when the flow is cancelled, so a late failure from a superseded
   * or cancelled attempt (e.g. a data-channel request that rejects after the
   * user moved on) is recognised as stale and never shows the error screen over
   * whatever is playing now. See #failPlayback.
   *
   * @type {number}
   */
  #playbackEpoch = 0;
  #playbackTasks = new PlaybackTasks();
  /**
   * The element as it was when the current wait was noticed, or null when no
   * check is pending. What is compared against it decides whether the viewer is
   * told anything — see `shouldReportWaiting`.
   *
   * @type {{ positionSeconds: number, seeking: boolean, readyState: number } | null}
   */
  #waitingSampledAt = null;
  /** @type {number} Viewer-chosen audio track (type-relative; 0 = default). */
  #selectedAudioTrackIndex = 0;
  /** @type {{ code: string, releaser: string | null } | null} */
  #rememberedAudio = null;
  /** @type {Array<object>} Audio tracks from the active playback plan. */
  #audioTracks = [];
  #subtitlePlayback;
  /** @type {number} The height of the rung the player is playing, as hls.js last switched to (0 = not known yet). */
  #playingHeight = 0;
  // The height an automatic move is being made to right now, so a request
  // restated in every progress report (polled about every 1.5 s) is acted on
  // once rather than started afresh while the first move is still warming.
  #autoQualityRequestHeight = 0;
  /**
   * @type {number} Which quality pick is the current one. Warming a rung waits
   * on the proxy, so picks made close together finish in the order the rungs
   * happen to be ready — not the order they were made.
   */
  #qualityPickSeq = 0;
  #qualityPreparation = null;
  /**
   * The cushion this file needs before a switch between outputs is made, in
   * seconds, as the proxy last said (`minimumBufferSeconds`). Null until said.
   * @type {number | null}
   */
  #minimumBufferSeconds = null;
  /** Follows the picture as the viewer sees it (roadmap item 98). @type {VisiblePictureWatch | null} */
  #visiblePictureWatch = null;
  /** On what the proxy judged the output this viewer is given. @type {object | null} */
  #servingVerdict = null;
  /** Stops listening to the proxy's answers about this viewer's output, for the player it served. @type {(() => void) | null} */
  #stopOutcomes = null;
  /** A new viewing is being started after an address could no longer be given. @type {boolean} */
  #recoveringAssignment = false;
  /**
   * Which audio pick is the viewer's latest. Preparing a track takes seconds,
   * and only one plays — so a later pick cancels an earlier one rather than
   * queueing behind it.
   */
  #audioPickSeq = 0;
  #audioPreparation = null;
  /**
   * Which pick the picture is being held for, or null when it is not held. A
   * hold outlives the pick that took it — a second choice made during one
   * inherits it rather than ending it — so the two numbers are kept apart.
   *
   * @type {number | null}
   */
  #audioHoldPick = null;
  /** Whether the current stream's video is re-encoded rather than copied. */
  #videoIsReencoded = false;
  /** @type {number} Source coded width/height from the proxy plan (0 = unknown / not proxy-served). */
  #sourceVideoWidth = 0;
  #sourceVideoHeight = 0;
  /**
   * Cold-start phase marks (performance.now()) for the proxy-served flow, used
   * to log one summary line on a successful start. Set at the top of the
   * proxy branch of #switchToVideoFile; cleared when the summary is logged.
   *
   * @type {{ t0: number, t1?: number, t2?: number, t3?: number } | null}
   */
  #coldStart = null;
  /**
   * True once the player view is revealed and playback is live, so buffer-empty
   * events are treated as mid-playback data starvation (buffering notice) rather
   * than the normal pre-buffer fill. Cleared when loading/error/stop take over.
   *
   * @type {boolean}
   */
  #playbackLive = false;

  /** Pending seek-intent report timer (see #reportSeekIntent). */
  #seekReportTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} Debounce before showing the buffering notice. */
  #bufferingTimer = null;
  /** @type {boolean} Whether the mid-playback buffering notice is currently shown. */
  #bufferingShown = false;
  /** @type {ReturnType<typeof setInterval> | null} Periodic stats poll while buffering (peers/speed/amount-left). */
  #bufferingPollTimer = null;
  /**
   * Most recent torrent stats (peers / speed / bytes still needed), kept so
   * every surface that answers "how long until I can watch" can show the
   * supply stage — not just the one that happens to be polling right now.
   * Null until the first poll lands.
   *
   * @type {{ numPeers?: number, downloadSpeed?: number, resumeNeededBytes?: number | null, resumeDownloadedBytes?: number | null } | null}
   */
  #lastDownloadStats = null;
  /**
   * Bumped on every #showBuffering() call (a fresh buffering episode) and on
   * #clearBuffering(). A re-entrant #showBuffering() (e.g. a seek-settle
   * debounce firing, then a `stalled` event re-arming its own debounce before
   * the first one's poll() has resolved — both real events from the SAME
   * scrub, observed field-side ~3s apart) starts a SECOND overlapping poll()
   * with no ordering guarantee against the first; whichever network response
   * lands last wins the DOM write regardless of which was actually more
   * recent. Each poll() captures the epoch at its own #showBuffering() call
   * and only writes to the DOM while it is still current, so a slow, stale
   * response can never overwrite a fresher one — this is what "the percent
   * looked frozen" traced back to (field-reported 2026-08-01).
   *
   * @type {number}
   */
  #bufferingEpoch = 0;
  /**
   * When the picture stopped, and how long it has stood still in total on this
   * source.
   *
   * The same rule that decides whether to show the spinner decides what counts
   * here — `shouldReportWaiting`, which asks whether the PICTURE MOVED — so the
   * figure is the interruption the viewer actually saw, not every `waiting`
   * event the element fired. It is the one number that says whether a deeper
   * cushion did the thing it exists for; before it, the only evidence was
   * somebody remembering how a session felt (roadmap item 4).
   *
   * @type {number | null}
   */
  #stallStartedAt = null;
  #stallTotalMs = 0;
  #stallCount = 0;
  /**
   * Byte offset the resume window is pinned to for the CURRENT buffering
   * episode. Captured from the proxy's first poll response and sent back on
   * every subsequent poll of the SAME episode, so the proxy computes "bytes
   * needed" against a fixed target instead of the live read position — which
   * slides forward as playback/encoding progresses and would otherwise make
   * the number jump up mid-poll. Null = no episode in progress / not yet
   * captured. Reset at the start of each new episode (#showBuffering) and
   * cleared when it ends (#clearBuffering).
   * @type {number | null}
   */
  #bufferingResumeAnchorByteStart = null;

  /**
   * Whether the source's stats have already been reported as unreadable. The
   * poll behind them runs about once a second for as long as the viewer waits,
   * so the condition is said on its edge and not on every tick.
   *
   * @type {boolean}
   */
  #statsUnreadable = false;

  /** Same, for the transcode-progress polls. */
  #progressPollFailing = false;

  /** Same, for the metadata poll under the waiting interface. */
  #metadataPollFailing = false;
  /**
   * Playback position (seconds) from a shared `&currentTime=` link, applied once
   * the player is revealed and the media is seekable, then cleared. Named to
   * match `video.currentTime` — the same name across every layer. Null = none.
   * @type {number | null}
   */
  #pendingCurrentTime = null;
  #openingFileIndex = null;
  #seekPosition = new SeekPosition();
  #seekEventPosition = null;

  #onMediaSeekRequest = (event) => {
    const controller = document.getElementById("player__controller");
    if (!event.composedPath().includes(controller) || !Number.isFinite(event.detail)) return;
    void this.#moveToPosition(event.detail);
  };

  async #moveToPosition(position) {
    if (!Number.isFinite(position) || position < 0) return;
    if (this.#seekReportTimer !== null) clearTimeout(this.#seekReportTimer);
    this.#seekReportTimer = null;
    this.#pendingCurrentTime = this.#isProcessing && !this.#hlsPlayer.isActive() ? position : null;
    this.#seekEventPosition = position;
    this.#writeHistory("replace", { ...readUrlState(location.search), currentTime: position });
    this.#waitingModel.reset();
    this.#logEvt(`seek intent → ${position.toFixed(1)}s`);
    const epoch = this.#playbackEpoch;
    try {
      await this.#seekPosition.move(position, {
      stopLoad: () => this.#hlsPlayer.stopLoad(),
      reportSeek: (target) => this.#session.reportSeek(target),
      startLoad: (target) => this.#hlsPlayer.seekTo(target, this.#videoElement)
      });
    } catch (error) {
      if (epoch !== this.#playbackEpoch) return;
      const description = error instanceof Error ? error.message : String(error);
      this.#logEvt(`seek failed: ${description}`);
      const canRetry = this.#activeFileIndex >= 0;
      this.#logEvt(`seek to ${position}s failed (retry ${canRetry ? "offered" : "impossible"}): ${description}`);
      if (canRetry) this.#armRetryableStall(this.#activeFileIndex);
      this.#failWith(epoch, error, { canRetry });
    }
  }
  /**
   * The position a resume asked for, held until playback actually begins so the
   * two can be compared. Null when this start is not a resume.
   *
   * @type {number | null}
   */
  #resumeAskedFor = null;
  /**
   * File index from a shared `&fileIndex=` link — which file of a multi-file
   * torrent to open — consumed when the source's file list is known. Null = none.
   * @type {number | null}
   */
  #pendingFileIndex = null;

  /** @param {CustomEvent} event */
  #onShow = (event) => {
    const payload = event instanceof CustomEvent ? event.detail : null;
    this.#logEvt(`loading content set cause=LOADING:SHOW`);
    // Content and pipeline state only — whether this view is on screen follows
    // from the application state (`#onAppStateChanged`). This event now means
    // "a build is starting", which is what the machine reads it as.
    // The loading view is back in front — playback is no longer live; drop any
    // mid-playback buffering notice so it cannot leak onto the next state.
    this.#playbackLive = false;
    this.#clearBuffering();
    // Cleared with it: otherwise the next stream's first stall compares against
    // the last stream's answer and is never reported to the machine.
    this.#bufferingSignalled = false;
    if (typeof payload?.fileName === "string") {
      this.setFileName(payload.fileName);
    }
    if (typeof payload?.status === "string") {
      this.setStatus(payload.status);
    }
    if (typeof payload?.progress === "number") {
      this.setProgress(payload.progress);
    }
  };

  /** @param {CustomEvent} event */
  #onSetFileName = (event) => {
    const payload = event instanceof CustomEvent ? event.detail : null;
    this.setFileName(typeof payload?.value === "string" ? payload.value : "");
  };

  /** @param {CustomEvent} event */
  #onSetStatus = (event) => {
    const payload = event instanceof CustomEvent ? event.detail : null;
    this.setStatus(typeof payload?.value === "string" ? payload.value : "");
  };

  /** @param {CustomEvent} event */
  #onSetProgress = (event) => {
    const payload = event instanceof CustomEvent ? event.detail : null;
    const value = typeof payload?.value === "number" ? payload.value : 0;
    this.setProgress(value);
  };

  /** @param {CustomEvent} event */
  #onProcessPlayback = (event) => {
    const payload = event instanceof CustomEvent ? event.detail : null;
    this.#runPlaybackTask(() => this.#processPlayback(payload));
  };

  /** @param {CustomEvent} event */
  #onPlayerReady = (event) => {
    const payload = event instanceof CustomEvent ? event.detail : null;
    const videoElement = payload?.videoElement;
    if (videoElement instanceof HTMLVideoElement) {
      this.#videoElement = videoElement;
      this.#attachPlaybackDiagnostics(videoElement);
      this.#watchVisiblePicture(videoElement);
    }
  };

  /**
   * [evt] TEMPORARY: timestamped playback diagnostics (seek/stall/play) for
   * correlating the browser timeline with the proxy's segment/restart logs.
   *
   * @param {HTMLVideoElement} videoElement
   * @returns {void}
   */
  #attachPlaybackDiagnostics(videoElement) {
    if (this.#diagnosticsAttached) {
      return;
    }
    this.#diagnosticsAttached = true;
    const log = (name) => {
      // UTC HH:MM:SS.mmm — same timezone as the proxy logger, so browser and
      // proxy logs line up exactly when correlating them.
      const t = new Date().toISOString().slice(11, 23);
      console.debug(
        `[evt] ${t} ${name} currentTime=${videoElement.currentTime.toFixed(1)} ` +
          `bufferedAhead=${bufferedAheadSeconds(videoElement).toFixed(1)}s`
      );
    };
    for (const name of ["seeking", "seeked", "waiting", "playing", "pause", "ended", "stalled", "error"]) {
      videoElement.addEventListener(name, () => {
        log(name);
        const pauseCause = name === "pause" ? consumePauseCause(videoElement) : null;
        if (name === "error") this.#onMediaElementFailed(videoElement);
        this.#onPlaybackEventForBuffering(name, pauseCause);
        // Explicit controls own viewer intent; recovery preserves that decision.
        if (name === "playing") {
          noteElementRecovered(videoElement);
        }
        this.#reportSeekIntent(name, videoElement);
        // Whether the picture is moving is a fact the proxy orders its work by:
        // a viewer who has stopped consumes nothing, so nothing in front of them
        // falls due and the work goes to whoever is watching. Sent the moment it
        // changes, like a seek — waiting up to ten seconds for the next periodic
        // report would leave the proxy working for somebody who is not watching.
        //
        // `waiting` is in this list because a picture starved of data has
        // stopped without being paused, and the proxy carries a viewer's
        // position forward by the clock between reports: unsaid, a frozen
        // player goes on "moving" for up to ten seconds of film it never
        // played.
        if (name === "pause" || name === "playing" || name === "ended" || name === "waiting") {
          reportNow();
        }
        // The moments where the position has definitely changed and settled.
        if (name === "seeked" || name === "pause" || name === "playing") {
          this.#reflectStateInUrl();
        }
      });
    }
    document.addEventListener(APP_EVENTS.SIGNAL, (event) => {
      if (event.detail?.event === APP_EVENT.PAUSED_BY_VIEWER || event.detail?.event === APP_EVENT.RESUMED) reportNow();
    });
    // While playing, the position moves continuously and the address bar has to
    // follow it, or a bookmark taken mid-film reopens at the last discrete
    // event. `timeupdate` fires about four times a second, which is far too
    // often to write history — Safari begins throttling around a hundred calls
    // in thirty seconds — so it is written at most once every
    // URL_POSITION_INTERVAL_MS. At that rate it is six calls per thirty
    // seconds, an order of magnitude under any browser's limit, and cheap
    // enough on a phone.
    videoElement.addEventListener("timeupdate", () => {
      const now = Date.now();
      if (now - this.#urlPositionWrittenAt < URL_POSITION_INTERVAL_MS) {
        return;
      }
      this.#urlPositionWrittenAt = now;
      this.#reflectStateInUrl();
    });
    // Leaving, or being sent to the background, is the last chance to record
    // where the viewer got to. `pagehide` and `visibilitychange` are the pair
    // that fire reliably on iOS, where `beforeunload` is ignored.
    // Entering or leaving picture-in-picture is a change of who is watching:
    // the tab may be hidden while the viewer watches the picture floating over
    // something else. Said at once, like a pause, because a hidden tab has its
    // timers throttled and the periodic report may be a long way off.
    for (const name of ["enterpictureinpicture", "leavepictureinpicture"]) {
      videoElement.addEventListener(name, () => reportNow());
    }
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        this.#reflectStateInUrl();
      }
      // WHETHER THIS PAGE IS ON SCREEN, said the moment it changes. A hidden tab
      // asks for nothing and looked exactly like a viewer holding a full
      // cushion; sent on the change, because once hidden the browser throttles
      // the timer that would otherwise carry it — measured 800 ms of event-loop
      // lag in the field, against a ten-second reporting interval.
      reportNow();
    });
    window.addEventListener("pagehide", () => this.#reflectStateInUrl());
    document.addEventListener(SESSION_EVENTS.GONE, () => { void this.#rebuildGoneSession(); });
    document.addEventListener(SESSION_EVENTS.PROGRESS, (event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      this.#noteEffectiveQuality(detail);
    });
    // Leaving for the picker has to reach the address bar too. Nothing else
    // does it: every other write is driven by an event of the <video> element,
    // and by this point there is no longer anything playing.
    // Leaving for the picker is the one moment the address is cleared: the
    // viewer said so. Every other path that finds no source — a failure, a
    // teardown — leaves the address alone, because it is what Retry and a
    // reload read the position from.
    document.addEventListener(APP_EVENTS.RESET_TO_PICKER, () => {
      if (location.search.length > 0) {
        this.#writeHistory("push", { magnet: "", fileIndex: -1, currentTime: 0 });
      }
    });
    window.addEventListener("popstate", () => { void this.#onHistoryNavigate(); });
    // Periodic bottleneck classification while playing. Distinguishes, from
    // client-visible symptoms, whether playback is limited by the client's own
    // decode (dropped frames while the buffer holds) or by something upstream
    // (buffer draining — proxy CPU / proxy download / delivery, split later by
    // the budget using the proxy's own speed/download signals). Logged as
    // [bottleneck]; the client logger forwards it to the server log for field
    // analysis.
    let prevAhead = bufferedAheadSeconds(videoElement);
    let prevDropped = 0;
    let prevTotal = 0;
    window.setInterval(() => {
      if (videoElement.paused || videoElement.ended || videoElement.readyState < 2) {
        return;
      }
      const t = new Date().toISOString().slice(11, 23);
      const ahead = bufferedAheadSeconds(videoElement);
      const aheadDelta = ahead - prevAhead;
      prevAhead = ahead;

      // Dropped-frame ratio over this window (decode can't keep up).
      let droppedRatio = 0;
      let windowFrames = 0;
      let windowDropped = 0;
      if (typeof videoElement.getVideoPlaybackQuality === "function") {
        const q = videoElement.getVideoPlaybackQuality();
        windowFrames = Math.max(0, q.totalVideoFrames - prevTotal);
        windowDropped = Math.max(0, q.droppedVideoFrames - prevDropped);
        prevTotal = q.totalVideoFrames;
        prevDropped = q.droppedVideoFrames;
        droppedRatio = windowFrames > 0 ? windowDropped / windowFrames : 0;
      }

      // Classify. Buffer draining toward empty = upstream-limited; heavy frame
      // drops with a held buffer = client decode-limited.
      const draining = aheadDelta < -1 && ahead < 8;
      const decodeStruggling = droppedRatio > 0.05 && windowFrames > 10;
      let bottleneck;
      if (decodeStruggling && draining) {
        bottleneck = "client-decode+upstream";
      } else if (decodeStruggling) {
        bottleneck = "client-decode";
      } else if (draining) {
        bottleneck = "upstream"; // proxy CPU / download / delivery — split by the budget
      } else {
        bottleneck = "ok";
      }
      console.debug(
        `[bottleneck] ${t} ${bottleneck} bufferedAhead=${ahead.toFixed(1)}s ` +
          `delta=${aheadDelta.toFixed(1)}s dropped=${windowDropped}/${windowFrames} ` +
          `(${(droppedRatio * 100).toFixed(1)}%)`
      );
    }, 10_000);
  }

  /**
   * Tell the proxy where the viewer seeked, so it can move the encoder there.
   *
   * Debounced on `seeking`: a scrub emits a continuous stream of `seeking`
   * events (one per pointer move — a single drag produced dozens, measured),
   * and only the position it settles on matters. `SEEK_REPORT_DEBOUNCE_MS`
   * after the last one, that position is sent.
   *
   * This is the sole source of seek intent. The proxy cannot infer it: one seek
   * leaves ~25 concurrent segment requests outstanding across a wide span, so
   * any rule over them picks noise (field 2026-08-02: nine encoder restarts in
   * a minute, ~70 s to complete one seek).
   *
   * @param {string} name - The <video> event name.
   * @param {HTMLVideoElement} videoElement
   * @returns {void}
   */
  #reportSeekIntent(name, videoElement) {
    if (name === "seeked" || name === "playing") this.#seekEventPosition = null;
    if (name !== "seeking") {
      return;
    }
    // The control assignment generates this native event. Browsers may round
    // currentTime, so event ownership must not depend on numeric equality.
    if (this.#seekEventPosition !== null) {
      this.#seekEventPosition = null;
      return;
    }
    // OUR OWN MOVE IS NOT SOMEBODY'S DECISION.
    //
    // hls.js moves `currentTime` when a fragment lands with a gap before it,
    // and a rebuild of the media source puts the element back where it was;
    // the element fires `seeking` exactly as it does for a person dragging the
    // time bar. Reported as a seek, that moves the priority map and through it
    // every encoder — for every viewer of that film, not only this one. Field
    // 2026-09-06: eight seek requests against one action by a person, the
    // other seven all following a jump over a hole this proxy had itself
    // created. A rebuild reported as a seek would also stop the load that is
    // putting the picture back.
    //
    // Asked now, while `currentTime` still names where the move goes: after
    // the debounce a rebuilt picture may already be playing on from there.
    // The position is still updated by the ordinary reports; what is withheld
    // is the claim that somebody chose to go there.
    const ownMove = this.#hlsPlayer?.wasOwnMove?.(videoElement.currentTime) ?? null;
    if (ownMove !== null) {
      this.#logEvt(`${ownMove} (${videoElement.currentTime.toFixed(1)}s) — not reported as a seek`);
      return;
    }
    if (this.#seekReportTimer !== null) {
      clearTimeout(this.#seekReportTimer);
    }
    this.#seekReportTimer = window.setTimeout(() => {
      this.#seekReportTimer = null;
      const position = videoElement.currentTime;
      if (!Number.isFinite(position)) {
        return;
      }
      // The control's explicit request already owns this position. Native
      // controls and media-session seeks still enter through this fallback.
      void this.#moveToPosition(position);
    }, SEEK_REPORT_DEBOUNCE_MS);
  }

  /**
   * Pass the player's own "this fragment is nowhere near my buffer" reading on
   * to the proxy, which is the only side that can say what it means.
   *
   * @param {{ sn: number, track?: string, fragStartSec: number, bufferEndSec: number, currentTimeSec: number }} report
   * @returns {void}
   */
  #reportFragmentFar(report) {
    void this.#session?.reportFragmentFar(report);
  }

  /**
   * Map a raw <video> event to the mid-playback buffering notice. A stall or a
   * seek (`waiting`/`stalled`/`seeking`) schedules the notice after a short
   * debounce; a resume or a stop (`playing`/`seeked`/`pause`/`ended`) clears
   * it. `seeking` is included so a seek into not-yet-downloaded data shows the
   * spinner even while paused (scrubbing on a paused player). A failure of the
   * element, and the pause it makes, clear nothing: the frame is still wanted.
   *
   * @param {string} name
   * @param {string | null} [pauseCause] - Who caused a `pause` (`PAUSE_CAUSE`).
   * @returns {void}
   */
  #onPlaybackEventForBuffering(name, pauseCause = null) {
    if (name === "waiting" || name === "stalled" || name === "seeking") {
      this.#scheduleBufferingCheck();
      return;
    }
    // `seeked` = the seek genuinely completed (data arrived); `ended` is
    // terminal. `error` is not: a failed element is either being rebuilt or
    // handed to the restart, and whichever of the two runs decides what is
    // shown (`#onMediaElementFailed`).
    if (name === "seeked" || name === "ended") {
      this.#clearBuffering();
      return;
    }
    // The pause a failing element makes is not the picture becoming
    // available: the frame is still wanted and is not there.
    if (name === "pause" && pauseCause === PAUSE_CAUSE.ELEMENT) {
      return;
    }
    // A pause/resume toggled WHILE a seek is still pending must NOT hide the
    // spinner — the target data has not arrived yet (start seek → pause → play →
    // pause with the seek unfinished keeps it visible). Clear only when no seek
    // is in progress.
    if (name === "playing") {
      // Where a resume ASKED to start against where it actually started. The
      // two are not the same and the difference was invisible: reported
      // 2026-08-06 as "about five seconds earlier than where I stopped", of
      // which the address's two-second write interval and its rounding down
      // explain three, and nothing in the log accounted for the rest. Written
      // once per resume, on the edge, and only when a position was asked for.
      if (this.#resumeAskedFor !== null) {
        const startedAt = this.#videoElement instanceof HTMLVideoElement
          ? this.#videoElement.currentTime
          : 0;
        this.#logEvt(
          `resume asked for ${this.#resumeAskedFor.toFixed(2)}s, playback began at ` +
          `${startedAt.toFixed(2)}s (${(startedAt - this.#resumeAskedFor).toFixed(2)}s)`
        );
        this.#resumeAskedFor = null;
      }
      // From here on the player gates its own resumes; our prebuffer cushion
      // applies only to the first reveal. Cleared with the rest of the
      // per-attempt state in #beginPlaybackAttempt.
      this.#hasPlayedOnce = true;
    }
    if (name === "playing" || name === "pause") {
      const video = this.#videoElement;
      if (!(video instanceof HTMLVideoElement) || !video.seeking) {
        this.#clearBuffering();
      }
    }
  }

  /**
   * After a short debounce, show the buffering notice only if playback is still
   * genuinely starved — lacking enough buffered data to proceed. A paused player
   * is NOT excluded (a paused seek into not-yet-downloaded data must show the
   * spinner); an ended/errored one is. The debounce keeps a normal sub-second
   * wait or an instant in-buffer seek from flashing the notice.
   *
   * @returns {void}
   */
  /**
   * The three facts about the element the waiting rule is decided from, or null
   * when there is no element to read.
   *
   * @returns {{ positionSeconds: number, seeking: boolean, readyState: number } | null}
   */
  #sampleWaiting() {
    const video = this.#videoElement;
    if (!(video instanceof HTMLVideoElement)) {
      return null;
    }
    return {
      positionSeconds: video.currentTime,
      seeking: video.seeking === true,
      readyState: video.readyState
    };
  }

  #scheduleBufferingCheck() {
    if (!this.#playbackLive || this.#bufferingTimer !== null) {
      return;
    }
    // What the element looks like NOW, to be compared against what it looks
    // like after the debounce. A picture that has moved in between is running,
    // and a wait beside a running picture belongs to something else being
    // refilled — the audio track the viewer just changed. See
    // `shouldReportWaiting`, which holds the whole rule.
    const sampled = this.#sampleWaiting();
    if (sampled !== null) {
      this.#waitingSampledAt = sampled;
    }
    this.#bufferingTimer = window.setTimeout(() => {
      this.#bufferingTimer = null;
      const video = this.#videoElement;
      if (!(video instanceof HTMLVideoElement) || video.ended || video.error) {
        return;
      }
      // Show when a seek is STILL in progress after the debounce — the target
      // data has not arrived. `video.seeking` (true from `seeking` until
      // `seeked`) is reliable across browsers INCLUDING iOS native HLS, where
      // `readyState` can stay optimistically high during a paused scrub, so the
      // readyState check alone missed the iPhone non-fullscreen paused-seek case.
      // Otherwise fall back to genuine buffer starvation (readyState below
      // HAVE_FUTURE_DATA).
      const now = this.#sampleWaiting();
      const before = this.#waitingSampledAt;
      this.#waitingSampledAt = null;
      if (now === null || before === null) {
        return;
      }
      if (shouldReportWaiting(before, now)) {
        void this.#showBuffering();
      }
    }, 250);
  }

  /**
   * Show the spinner immediately, then add the live peer count below it so a
   * stalled viewer sees the torrent is still downloading (few peers) rather
   * than a frozen player.
   *
   * @returns {Promise<void>}
   */
  async #showBuffering() {
    const epoch = ++this.#bufferingEpoch;
    if (this.#stallStartedAt === null) {
      this.#stallStartedAt = Date.now();
    }
    this.#bufferingShown = true;
    this.#bufferingResumeAnchorByteStart = null; // fresh episode — re-pin on the first poll
    this.#dispatchBuffering(true, ""); // spinner only until the first stats arrive
    // Poll live stats while buffering. Two DISTINCT stages, shown one at a time:
    // while there is no active transcode session yet, show download progress
    // (peers/speed/bytes-left); once a transcode session exists for the file
    // (the download-phase byte target has effectively been met and encoding has
    // started), show ITS progress instead — a downloaded-bytes count is no
    // longer the meaningful number once ffmpeg is actively producing segments.
    // Stopped by #clearBuffering. Guarded by `epoch` (see #bufferingEpoch) so a
    // re-entrant #showBuffering() call's poll can never have its DOM write
    // clobbered by a slower, now-stale response from an earlier one.
    const poll = async () => {
      let downloadStats = null;
      let transcodeProgress = null;
      try {
        [downloadStats, transcodeProgress] = await Promise.all([
          this.#fetchBufferingStats(),
          this.#session.fetchActiveTranscodeProgress()
        ]);
      } catch (error) {
        // Aborted when the session is torn down under the wait — a failure
        // that ends playback does exactly that — and then there is nothing
        // left to read. Any other failure is said once, on the edge, as the
        // pre-buffer wait does: this poll runs every 1.5 s.
        if (error?.name === "AbortError" || epoch !== this.#bufferingEpoch) {
          return;
        }
        if (!this.#progressPollFailing) {
          this.#progressPollFailing = true;
          console.warn(
            `[torrent-tv] the transcode progress stopped being readable: ` +
            `${error instanceof Error ? error.message : String(error)}`
          );
        }
        return;
      }
      if (downloadStats) {
        this.#lastDownloadStats = downloadStats;
      }
      this.#noteEffectiveQuality(transcodeProgress);
      // Publish what the proxy said, exactly as it said it. Who needs a figure
      // out of this works it out for themselves — the overlay from its own
      // model, this component from its own. Handing round conclusions is how
      // one of them came to be told what to display.
      document.dispatchEvent(new CustomEvent(PROXY_EVENTS.MEASURED, {
        detail: { downloadStats, transcodeProgress }
      }));
    };
    await poll();
    if (this.#bufferingShown && epoch === this.#bufferingEpoch && this.#bufferingPollTimer === null) {
      this.#bufferingPollTimer = window.setInterval(() => { void poll(); }, 1500);
    }
  }







  /**
   * How long the bytes still missing will take, given that the swarm is still
   * speeding up.
   *
   * Dividing what is left by the speed RIGHT NOW is only right once the speed
   * has settled. A cold torrent does not start at its final rate — measured
   * 2026-08-04 on one session: 74 KB/s, then 1264, 2635, 3587, 3987 at two
   * second intervals — so an estimate taken during the climb divides by a
   * number the rest of the transfer will never see again. Every measured error
   * was in the same direction, and the largest of them at the moment the viewer
   * is most likely to be looking:
   *
   *   | when            | shown | real |
   *   |-----------------|-------|------|
   *   | 4.7 s to go     |  35 s | 4.7 s|
   *   | 2.5 s to go     | 8.5 s | 2.5 s|
   *   | 6.2 s to go     |  19 s | 6.2 s|
   *
   * So the climb is part of the estimate. With a rate `v` rising at `a` per
   * second, `R` bytes take the `t` that solves `R = v·t + a·t²/2`. On the three
   * cases above this gives 10.4 s, 4.8 s and 6.6 s — the last almost exact, the
   * others still high but no longer wrong by a factor of seven.
   *
   * When the rate has levelled off `a` is zero and this is exactly `R / v`
   * again, so a settled connection is unaffected.
   *
   * @param {number} remainingBytes
   * @param {number} speedNow - Bytes per second, as the proxy reports it.
   * @returns {number} Seconds.
   */

  /**
   * Let the estimate be revised upward again. Called when the thing being
   * waited for CHANGES — a seek, another file, a fresh attempt — because the
   * previous countdown was about something else.
   *
   * @returns {void}
   */






  /**
   * Cancel a pending buffering check + the stats poll, and hide the notice if
   * it is showing.
   *
   * @returns {void}
   */
  #clearBuffering() {
    this.#bufferingEpoch += 1; // invalidate any in-flight poll() from this or a prior episode
    if (this.#bufferingTimer !== null) {
      clearTimeout(this.#bufferingTimer);
      this.#bufferingTimer = null;
    }
    if (this.#bufferingPollTimer !== null) {
      clearInterval(this.#bufferingPollTimer);
      this.#bufferingPollTimer = null;
    }
    if (this.#bufferingShown) {
      this.#bufferingShown = false;
      this.#dispatchBuffering(false);
    }
    if (this.#stallStartedAt !== null) {
      const lastedMs = Date.now() - this.#stallStartedAt;
      this.#stallStartedAt = null;
      this.#stallTotalMs += lastedMs;
      this.#stallCount += 1;
      this.#logEvt(
        `picture stood still ${(lastedMs / 1000).toFixed(1)}s ` +
          `(${this.#stallCount} time(s), ${(this.#stallTotalMs / 1000).toFixed(1)}s total on this source)`
      );
    }
    this.#bufferingResumeAnchorByteStart = null;
  }

  /**
   * Hold the picture while a soundtrack the viewer chose is made ready.
   *
   * The whole of it is one signal. Everything a hold looks like — the picture
   * stopped, the waiting overlay on screen, the play control refusing input —
   * is an output of the state and belongs to the views that derive it; this
   * says only that the viewer asked for a change, which is the fact the machine
   * needs. The pause is issued by the player as one of OURS, so the viewer's
   * own last decision survives the wait and is what decides where it ends.
   *
   * The stall counter is deliberately untouched. It measures interruptions the
   * supply caused, which is what the cushion is judged by; a wait the viewer
   * asked for by changing language is not one of those, and counting it would
   * corrupt the only measurement that says whether playback is smooth.
   *
   * @param {number} pick - Which pick owns the hold, so a later one inherits it
   *   rather than the earlier one releasing what it no longer owns.
   * @returns {void}
   */
  #holdForAudio(pick) {
    this.#audioHoldPick = pick;
    signalApp(APP_EVENT.SWITCH_REQUESTED);
    this.setStatus(Loading.MESSAGES.audioPreparing);
  }

  /**
   * Let the picture go again, however the change ended — applied, refused, or
   * abandoned because the viewer picked something else meanwhile.
   *
   * Two guards, and each answers a case that happens. A pick that is no longer
   * the latest releases nothing: the hold has passed to the pick that came
   * after it, and ending it here would start the picture in the middle of a
   * wait somebody is still in. And a hold that was never taken — a pick refused
   * before it began, or the viewer choosing the track already playing — is
   * released all the same when this pick is the latest, because that choice is
   * exactly how a viewer changes their mind back.
   *
   * @param {number} pick
   * @returns {void}
   */
  #releaseAudioHold(pick) {
    if (this.#audioPickSeq !== pick || this.#audioHoldPick === null) {
      return;
    }
    this.#audioHoldPick = null;
    signalApp(APP_EVENT.SWITCH_FINISHED);
  }

  /**
   * @param {boolean} active
   * @param {string} [text] - Pre-formatted pill text (empty until stats arrive).
   * @returns {void}
   */
  #dispatchBuffering(active, text = "") {
    document.dispatchEvent(
      new CustomEvent(PLAYER_EVENTS.SET_BUFFERING, {
        detail: { active, text }
      })
    );
    // The same fact, told to the state machine. This function already decides
    // exactly the predicate STALLED is defined by — a frame is wanted and is
    // not available — so the machine reads it here rather than working it out
    // a second time somewhere else.
    //
    // Only while a stream exists: before that the wait is the cold open, which
    // is OPENING and is already true. And only on a CHANGE, because this is
    // called again on every stats poll just to refresh the pill's text.
    if (!this.#playbackLive || active === this.#bufferingSignalled) {
      return;
    }
    this.#bufferingSignalled = active;
    // The viewer's own decision, not `!video.paused`: the element is also
    // paused when we stopped it or when it stopped itself after failing, and
    // read that way a picture rebuilt after a failure landed in PAUSED with
    // nobody to start it.
    signalApp(active ? APP_EVENT.FRAME_BLOCKED : APP_EVENT.FRAME_AVAILABLE, {
      viewerWantsPlayback: this.#viewerWantsPlayback()
    });
  }

  /**
   * Live stats for the active file (peers + download speed). Reuses the cached
   * sourceKey (no re-registration), so it is a single cheap stats fetch.
   * Returns null on any failure — the pill then stays with just the spinner.
   *
   * Pins the resume window to a fixed byte offset for the duration of one
   * buffering episode: sends back `#bufferingResumeAnchorByteStart` once it has
   * been captured from an earlier poll of the SAME episode, so the proxy
   * computes "bytes needed" against a fixed target instead of the live read
   * position (see the field's doc comment).
   *
   * @returns {Promise<{ numPeers: number, downloadSpeed: number } | null>}
   */
  async #fetchBufferingStats() {
    try {
      if (!this.#transport || this.#activeFileIndex < 0) {
        return null;
      }
      const sourceKey = await this.#session.registerSourceOnProxy(this.#transport);
      const anchorParam = this.#bufferingResumeAnchorByteStart !== null
        // Pinned no longer. The anchor freezes the point the window is measured
        // ahead of, which is right for a stable progress denominator and wrong
        // for "how much is still needed before the picture can move": within
        // seconds it describes a stretch already passed. Field 2026-08-09 —
        // "16.0 MB left" stood unchanged across three phases at 4.2 MB/s, a
        // rate that would clear 16 MB in four seconds. Measured against the
        // live read position it answers the question actually being asked.
        ? ""
        : "";
      const response = await this.#transport.fetch(
        `/api/sources/${encodeURIComponent(sourceKey)}/stats?fileIndex=${this.#activeFileIndex}${anchorParam}`,
        { cache: "no-store" }
      );
      if (!response.ok) {
        return null;
      }
      const stats = await response.json();
      // Capture the anchor ONCE per episode (first successful poll) — later
      // polls keep sending that same value above, so we must not overwrite it
      // with a newer live position on every response.
      if (this.#bufferingResumeAnchorByteStart === null && typeof stats?.resumeAnchorByteStart === "number") {
        this.#bufferingResumeAnchorByteStart = stats.resumeAnchorByteStart;
      }
      // Readable again: a later failure is a new condition and is worth one
      // more line.
      this.#statsUnreadable = false;
      return {
        numPeers: typeof stats?.numPeers === "number" ? stats.numPeers : 0,
        downloadSpeed: typeof stats?.downloadSpeed === "number" ? stats.downloadSpeed : 0,
        resumeNeededBytes: typeof stats?.resumeNeededBytes === "number" ? stats.resumeNeededBytes : null,
        resumeDownloadedBytes: typeof stats?.resumeDownloadedBytes === "number" ? stats.resumeDownloadedBytes : null
      };
    } catch (error) {
      // The peer count and the download speed are what the waiting interface
      // shows while nothing else is known. Losing them leaves the viewer
      // watching a spinner with no figures at all, and the reason was never
      // recorded — so it is now, once per run of the condition rather than on
      // every poll.
      if (!this.#statsUnreadable) {
        this.#statsUnreadable = true;
        console.warn(
          `[torrent-tv] the source's stats cannot be read: ` +
          `${error instanceof Error ? error.message : String(error)}`
        );
      }
      return null;
    }
  }

  /**
   * The waiting view is on screen exactly while a wanted frame is missing —
   * a cold open or a stall — and off screen otherwise. Derived from the state;
   * see `domain/app-state.js`.
   *
   * @param {string} state
   * @param {boolean} belongsOnScreen
   */
  applyAppState(state, belongsOnScreen) {
    super.applyAppState(state, belongsOnScreen);
    if (state === APP_STATE.ADVANCING && !this.#playbackLive) {
      this.#logEvt("playback is live");
      // Playback is live now — buffer-empty events mean data starvation, not
      // the pre-buffer fill, so the mid-playback buffering notice applies.
      this.#playbackLive = true;
      this.#applyPendingResume();
    }
    // Nothing used to end this: the polls are stopped by whoever started them,
    // and a failure leaves by another door. Field 2026-09-03, after the app had
    // already declared the session unrecoverable and released it, this component
    // went on polling a dead session every 1.5 s and feeding the readings to a
    // model that had just been reset — which started a FRESH countdown from 28 s
    // down to zero over a session that no longer existed, and would have gone on
    // for as long as the page stayed open. The state says the wait is over; that
    // is the one place the answer belongs.
    //
    // PAUSED is not the end of a wait — the viewer stopped the picture, the
    // pipeline did not — which is the same exception the overlay makes.
    if (!isWaiting(state) && state !== APP_STATE.PAUSED) {
      this.#clearBuffering();
      this.#waitingModel.reset();
    }
  }

  /**
   * Seek to the shared-link resume position once, when the player is revealed.
   * Waits for the media to become seekable (duration known — the synthetic VOD
   * playlist provides it) if it is not ready yet. One-shot.
   *
   * @returns {void}
   */
  #applyPendingResume() {
    if (this.#isProcessing || this.#openingFileIndex !== null) return;
    const currentTime = this.#pendingCurrentTime;
    if (currentTime == null || !(this.#videoElement instanceof HTMLVideoElement)) {
      return;
    }
    this.#pendingCurrentTime = null;
    const video = this.#videoElement;
    const epoch = this.#playbackEpoch;
    const seek = () => {
      if (epoch !== this.#playbackEpoch) return;
      if (Number.isFinite(video.duration) && video.duration > 0) {
        try {
          video.currentTime = Math.min(currentTime, video.duration - 1);
          this.#logEvt(`resume seek to ${currentTime}s`);
        } catch (error) {
          // The viewer asked to continue where they stopped, and this is the
          // line that puts them there. Refused, playback starts from the
          // beginning instead — which is exactly the complaint that made this
          // path exist — so the refusal is named rather than swallowed.
          console.warn(
            `[torrent-tv] could not resume at ${currentTime}s: ` +
            `${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    };
    if (Number.isFinite(video.duration) && video.duration > 0) {
      seek();
    } else {
      video.addEventListener("loadedmetadata", seek, { once: true });
    }
  }

  /** @param {CustomEvent} event */
  #onSelectMediaFile = (event) => {
    const payload = event instanceof CustomEvent ? event.detail : null;
    const fileIndex = Number(payload?.fileIndex);
    if (!Number.isInteger(fileIndex)) {
      return;
    }
    if (!this.#session.current) {
      return;
    }
    document.dispatchEvent(
      new CustomEvent(LOADING_EVENTS.SHOW, {
        detail: {
          status: Loading.MESSAGES.switchingToSelectedFile,
          progress: 0
        }
      })
    );
    this.#runPlaybackTask(() => {
      this.#pendingCurrentTime = 0;
      this.#selectedAudioTrackIndex = 0;
      this.#playingHeight = 0;
      return this.#switchToVideoFile(fileIndex);
    });
  };

  /** @param {CustomEvent} event */
  #onProcessMagnet = (event) => {
    const magnetUri = event instanceof CustomEvent ? event.detail?.magnetUri : "";
    const currentTime = event instanceof CustomEvent ? (event.detail?.currentTime ?? null) : null;
    const fileIndex = event instanceof CustomEvent ? (event.detail?.fileIndex ?? null) : null;
    this.#runPlaybackTask(() => this.#processMagnetPlayback(magnetUri, currentTime, fileIndex));
  };

  #runPlaybackTask(run, { preservePlayer = false } = {}) {
    let epoch = this.#playbackEpoch;
    return this.#playbackTasks.replace(async () => {
      epoch = this.#beginPlaybackAttempt();
      this.#cancelRequested = false;
      await run();
    }, () => {
      this.#cancelRequested = true;
      this.#playbackEpoch += 1;
      this.#qualityPreparation?.abort();
      this.#audioPreparation?.abort();
      this.#session.abortPendingRequests();
      if (!preservePlayer) {
        this.#hlsPlayer.clear();
        this.#subtitlePlayback.clear();
      }
    }).catch((error) => {
      if (this.#isAbortError(error)) return;
      const message = error instanceof Error ? error.message : String(error);
      console.error("[torrent-tv] playback failed:", message, error);
      this.#failWith(epoch, error);
    });
  }

  #onErrorShow = () => {
    // For a multi-file torrent keep the parsed source so the error screen's
    // "Back to episodes" → pick another episode re-enters the loading flow;
    // otherwise `session.current` is null and #onSelectMediaFile bails out,
    // leaving an empty player.
    this.#stopPlayback({ keepSource: this.#videoFileCount() > 1 });
  };

  #onPageHide = () => {
    this.#stopPlayback({ preferBeacon: true, reason: "pagehide" });
  };

  #onBeforeUnload = () => {
    this.#stopPlayback({ preferBeacon: true, reason: "beforeunload" });
  };

  /**
   * The last thing said to the machine about whether a frame is missing, so a
   * poll that only refreshes the pill's text does not repeat it.
   *
   * @type {boolean}
   */
  #bufferingSignalled = false;

  /**
   * The one place the figures are worked out. The overlay has its own for what
   * it shows; this one answers the pipeline's own question — whether there is
   * enough buffered to let the picture start. Same class, so the two can never
   * disagree about what "enough" means.
   *
   * @type {WaitingModel}
   */
  #waitingModel = new WaitingModel();

  /**
   * The buffer reading published by the component that owns the element.
   *
   * One reading, so the gate and the overlay cannot answer the same question
   * differently. Measuring it here as well is what let the overlay say the
   * cushion was met while the gate went on waiting.
   *
   * @type {number | null}
   */
  #lastBufferedAhead = null;

  /** @type {number | null} */
  #browserBufferLimitSeconds = null;

  /**
   * Everything the waiting overlay is allowed to say something about, in one
   * object. Two writers used to share that line — the pipeline's stage string
   * and the buffering formatter — so the same wait read one way while opening
   * and another once it stalled, and there was no single place to look to find
   * out why. Measurements accumulate here; the words are made from them in one
   * function, `formatWaitingText`.
   *
   * @type {import("../../domain/waiting-text.js").WaitingMeasurements}
   */
  #waiting = {};

  /**
   * Which tracks the proxy is re-encoding for this session. Copied tracks cost
   * nothing and have no encoder to describe, so a session that copies both
   * contributes no encoder line at all.
   *
   * @type {{ video: boolean, audio: boolean }}
   */
  #encodingTracks = { video: false, audio: false };

  /**
   * The stages of the wait in progress. Every step the viewer is shown opens
   * one, so closing it logs how long that step took and how far that was from
   * what was predicted — for the connect, which used to be a single opaque
   * label over a health poll, an ICE exchange and a liveness check, and for a
   * seek, which used to show a number of seconds with no name at all.
   *
   * @type {StageTimeline}
   */
  #stages = new StageTimeline({ log: (message) => this.#logEvt(message) });

  /**
   * Whether the viewer wants the picture to move — read from the element, which
   * owns the fact. Sent with a stream that has just become usable so a rebuild
   * finishing under a pause does not start playing at someone who stopped it.
   *
   * @returns {boolean}
   */
  #viewerWantsPlayback() {
    return !viewerHasStopped(this.#videoElement);
  }

  #onAppReset = () => {
    this.#stopPlayback();
    this.#resetSourceState();
    this.setProgress(0);
    this.setStatus("");
    this.setFileName("Waiting for a .torrent file...");
    this.#directPlaybackUnsupportedCache.clear();
  };

  /** Forget source preferences and publish empty source facts to their owners. */
  #resetSourceState() {
    this.#audioMetadataRefreshSeq += 1;
    this.#activeFileIndex = -1;
    this.#resumeState = null;
    this.#selectedAudioTrackIndex = 0;
    this.#rememberedAudio = null;
    this.#playingHeight = 0;
    this.#sourceVideoWidth = 0;
    this.#sourceVideoHeight = 0;
    this.#audioTracks = [];
    this.#subtitlePlayback.reset();
    document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.SET_AUDIO_TRACKS, { detail: { tracks: [], activeIndex: 0 } }));
    document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.SET_MEDIA_FILES, { detail: { video: [] } }));
    document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.SET_SHARE_LINK, { detail: { url: "" } }));
  }

  #stopPlayback(options = {}) {
    this.#qualityPreparation?.abort();
    this.#audioPreparation?.abort();
    this.#playbackTasks.invalidate();
    this.#cancelRequested = true;
    this.#playbackEpoch += 1;
    this.#seekPosition.reset();
    this.#seekEventPosition = null;
    this.#audioMetadataRefreshSeq += 1;
    this.#isProcessing = false;
    this.#openingFileIndex = null;
    this.#playbackLive = false;
    this.#clearBuffering();
    // Cleared with it: otherwise the next stream's first stall compares against
    // the last stream's answer and is never reported to the machine.
    this.#bufferingSignalled = false;
    this.#session.clear({
      preferBeacon: options?.preferBeacon === true,
      reason: typeof options?.reason === "string" ? options.reason : "",
      keepSource: options?.keepSource === true
    });
    this.#hlsPlayer.clear();
    this.#subtitlePlayback.clear();
    // Before the proxy is torn down, so a connect that finishes a moment later
    // cannot put a live one back on a component that has just let go of it.
    this.#abandonTransportAcquisition();
    if (this.#proxy) {
      this.#proxy.close();
      this.#proxy = null;
      this.#transport = null;
    }
    if (this.#videoElement instanceof HTMLVideoElement) {
      pauseWithoutIntent(this.#videoElement);
      this.#videoElement.removeAttribute("src");
      this.#videoElement.load();
    }
  };

  constructor() {
    // OPENING only, NOT `isWaiting`. This view is a MODAL dialog: shown for a
    // stall it covers the video and the whole control bar, and being modal it
    // makes them inert, so a viewer who seeks into missing data cannot pause,
    // scrub back or play until the data arrives. A stall is answered by the
    // small overlay inside the player instead. Collapsing the two waiting
    // interfaces into one is roadmap item 8; until then they stay separate and
    // this one keeps the job it can do without trapping anyone.
    super((state) => state === APP_STATE.OPENING);
    this.#actionButton = document.querySelector(Loading.SELECTOR.actionButton);

    if (!this.#actionButton) {
      throw new Error(Loading.MESSAGES.missingDomNodes);
    }

    this.#session = new TorrentSession(() => undefined);
    this.#subtitlePlayback = new SubtitlePlayback({
      getVideoElement: () => this.#videoElement,
      getTransport: () => this.#transport,
      getFiles: () => this.#session.current?.files,
      registerSourceOnProxy: (transport) => this.#session.registerSourceOnProxy(transport),
      getAbortSignal: () => this.#session.abortController.signal,
      getConsumerId: () => this.#session.consumerId,
      logEvent: (message) => this.#logEvt(message)
    });
    this.#proxySelector = new ProxySelector();
    this.#hlsPlayer = createHlsPlayer((message) => {
      console.debug("[torrent-tv][hls]", message);
      this.setStatus(message);
    });
    this.#loadDirectPlaybackHints();
    this.#setupEventHandlers();
    this.#connectEarly();
    document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.REQUEST_READY));
  }

  /**
   * TAKE A PROXY THE MOMENT THE PAGE OPENS, before anything has been chosen.
   *
   * Everything a viewer does needs one — the list of what is in a torrent as
   * much as the video itself — and choosing one and connecting to it is seconds
   * of round trips that used to begin only after a file had been picked. Begun
   * here, it runs while the person is finding their torrent, and by the time
   * they drop it the connection is usually already there.
   *
   * Deliberately silent. It says nothing on screen, because nobody is waiting
   * for it yet, and it swallows its failure: the real attempt is made by
   * whatever the viewer does next, which reports for itself. `#acquireTransport`
   * is joinable, so that attempt joins this one rather than starting a second.
   *
   * @returns {void}
   */
  #connectEarly() {
    void this.#acquireTransport().catch(() => undefined);
  }

  #setupEventHandlers() {
    document.addEventListener(LOADING_EVENTS.SHOW, this.#onShow);
    document.addEventListener(LOADING_EVENTS.SET_FILE_NAME, this.#onSetFileName);
    document.addEventListener(LOADING_EVENTS.SET_STATUS, this.#onSetStatus);
    document.addEventListener(LOADING_EVENTS.SET_PROGRESS, this.#onSetProgress);
    document.addEventListener(LOADING_EVENTS.PROCESS_PLAYBACK, this.#onProcessPlayback);
    document.addEventListener(LOADING_EVENTS.PROCESS_MAGNET, this.#onProcessMagnet);
    document.addEventListener(MEDIA_INFO_EVENTS.CHANGED, this.#onMediaInfoChanged);
    document.addEventListener(PLAYER_EVENTS.SELECT_MEDIA_FILE, this.#onSelectMediaFile);
    document.addEventListener(PLAYER_EVENTS.SELECT_AUDIO_TRACK, this.#onSelectAudioTrack);
    // The subtitle menu and its key belong to the player view; the tracks they
    // act on belong to the subtitle component, which is the only thing here
    // that changes a track's mode.
    document.addEventListener(PLAYER_EVENTS.SELECT_SUBTITLE_TRACK, (event) => {
      this.#subtitlePlayback.select(event instanceof CustomEvent ? String(event.detail?.key ?? "") : "");
    });
    document.addEventListener(PLAYER_EVENTS.TOGGLE_SUBTITLES, () => this.#subtitlePlayback.toggle());
    document.addEventListener(APP_EVENTS.RETRY_PLAYBACK, this.#onRetryPlayback);
    document.addEventListener(PLAYER_EVENTS.READY, this.#onPlayerReady);
    document.addEventListener("mediaseekrequest", this.#onMediaSeekRequest, true);
    document.addEventListener(ERROR_EVENTS.SHOW, this.#onErrorShow);
    document.addEventListener(APP_EVENTS.RESET_TO_PICKER, this.#onAppReset);
    document.addEventListener(PLAYER_EVENTS.BUFFER, (event) => {
      const ahead = event instanceof CustomEvent ? event.detail?.bufferedAhead : null;
      this.#lastBufferedAhead = typeof ahead === "number" && Number.isFinite(ahead) ? ahead : null;
    });
    document.addEventListener(PLAYER_EVENTS.BUFFER_CEILING, (event) => {
      const ceiling = event instanceof CustomEvent ? event.detail?.ceilingSeconds : null;
      const attemptId = event instanceof CustomEvent ? event.detail?.attemptId : null;
      if (attemptId !== this.#playbackEpoch) {
        return;
      }
      this.#browserBufferLimitSeconds = typeof ceiling === "number" && Number.isFinite(ceiling) && ceiling > 0
        ? ceiling
        : null;
    });
    window.addEventListener("pagehide", this.#onPageHide);
    window.addEventListener("beforeunload", this.#onBeforeUnload);
    document.addEventListener(PLAYER_EVENTS.CLOSE_PLAYLIST, this.#onPlaylistClosed);
  }

  /**
   * Throw a silent AbortError when the user cancelled the in-flight flow.
   * Called at the await boundaries of the loading pipeline.
   */
  #throwIfCancelled(epoch = this.#playbackEpoch) {
    if (!this.#cancelRequested && epoch === this.#playbackEpoch) {
      return;
    }
    const error = new Error("Loading cancelled by the user.");
    error.name = "AbortError";
    throw error;
  }

  /**
   * Mark the start of a new playback attempt and return its epoch. The caller
   * passes this epoch to #failPlayback so a failure that arrives after the
   * attempt was superseded/cancelled is ignored.
   *
   * @returns {number}
   */
  #beginPlaybackAttempt() {
    this.#playbackEpoch += 1;
    this.#openingFileIndex = null;
    this.#browserBufferLimitSeconds = null;
    this.#hasPlayedOnce = false;
    this.#waitingModel.reset();
    this.#refusedProxiesForThisOpen.clear();
    return this.#playbackEpoch;
  }

  /**
   * Surface a playback failure — but only if `epoch` is still the current
   * attempt. A late rejection from a superseded or cancelled attempt is logged
   * and dropped, so it never replaces live playback with the error screen.
   *
   * @param {number} epoch
   * @param {{ description: string, canRetry?: boolean }} detail
   * @returns {void}
   */
  /**
   * Fail playback with an error: the viewer is shown what is written for them,
   * and everything else about the failure goes to the log
   * (`describeFailure`, torrent-tv/meta#73).
   *
   * @param {number} epoch
   * @param {unknown} error
   * @param {{ canRetry?: boolean }} [options] - Overrides the error's own
   *   `canRetry` when the caller decides it.
   * @returns {void}
   */
  #failWith(epoch, error, { canRetry } = {}) {
    const failure = describeFailure(error, { canRetry, proxyRefusal: lastProxyRefusal() });
    if (failure.logDetail) this.#logEvt(`playback failure, not shown to the viewer: ${failure.logDetail}`);
    this.#failPlayback(epoch, { description: failure.description, canRetry: failure.canRetry });
  }

  #failPlayback(epoch, detail) {
    if (epoch !== this.#playbackEpoch) {
      this.#logEvt(`stale playback failure ignored (epoch ${epoch}≠${this.#playbackEpoch}): ${detail?.description ?? ""}`);
      return;
    }
    document.dispatchEvent(new CustomEvent(LOADING_EVENTS.PLAYBACK_FAILED, { detail }));
  }

  /**
   * User-initiated cancel of the loading flow. Tears the attempt down
   * (pending requests, transcode session, player state) but KEEPS
   * `session.current` and the transport, so a multi-file torrent returns to
   * a usable playlist and the next selection reuses the open data channel.
   */
  /**
   * Open the playlist without abandoning the load.
   *
   * A load can take a long time for reasons the viewer cannot influence — a
   * torrent with no seeders is the honest example — and until now the only way
   * out was Cancel, which throws away the whole session and returns to the
   * picker. Switching to another episode is usually what the viewer actually
   * wants, and it needs neither of those things: the playlist's own selection
   * handler supersedes the attempt in flight.
   *
   * @returns {void}
   */
  #onPlaylistClick = () => {
    this.#logEvt("playlist opened from the loading screen");
    // This dialog is modal, so nothing outside it can be clicked while it is
    // open. It steps aside for the drawer and comes back if the drawer is
    // closed without a choice being made — and if a choice IS made, the new
    // attempt shows it again itself.
    this.#playlistOpenedFromLoading = true;
    this.visible = false;
    document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.OPEN_PLAYLIST));
  };

  /**
   * The playlist drawer closed. If it was opened from here and the load is
   * still the one that opened it, take the screen back.
   *
   * @returns {void}
   */
  #onPlaylistClosed = () => {
    if (!this.#playlistOpenedFromLoading) {
      return;
    }
    this.#playlistOpenedFromLoading = false;
    if (this.#isProcessing) {
      this.visible = true;
    }
  };

  /**
   * Show or hide the way out of a long load. Only worth offering when there is
   * somewhere else to go.
   *
   * @param {boolean} visible
   * @returns {void}
   */
  #setPlaylistButtonVisible(visible) {
    // The player's own playlist button is on screen throughout, so the waiting
    // interface does not carry a second one.
  }

  #onCancelClick = () => {
    this.#qualityPreparation?.abort();
    this.#audioPreparation?.abort();
    this.#playbackTasks.invalidate();
    this.#logEvt("loading cancelled by user");
    this.#cancelRequested = true;
    // A connect in flight is part of this attempt and dies with it. Left in
    // place it would be handed to whoever asks next, and fail them with this
    // cancellation.
    this.#abandonTransportAcquisition();
    // Supersede the current attempt so its now-aborted requests, when they
    // reject, are recognised as stale and cannot surface an error screen.
    this.#playbackEpoch += 1;
    this.#session.abortPendingRequests();
    this.#session.releaseActiveTranscodeSessions({ reason: "cancel" });
    this.#hlsPlayer.clear();
    this.#subtitlePlayback.clear();
    if (this.#videoElement instanceof HTMLVideoElement) {
      pauseWithoutIntent(this.#videoElement);
      this.#videoElement.removeAttribute("src");
      this.#videoElement.load();
    }
    const videoCount = this.#session.current?.media?.video?.length ?? 0;
    if (videoCount > 1) {
      this.visible = false;
      document.dispatchEvent(new CustomEvent(APP_EVENTS.BACK_TO_PLAYLIST));
      return;
    }
    document.dispatchEvent(new CustomEvent(APP_EVENTS.RESET_TO_PICKER));
  };

  /**
   * Nothing. The waiting interface lives inside the player now, and whether it
   * is on screen is a function of the state, applied by `Player` from
   * `isWaiting`. This component owns what that interface SAYS and never whether
   * it is shown — which is the whole point of deriving outputs from the state.
   *
   * Kept as a no-op so the call sites that used to hide a dialog by hand are
   * harmless rather than having to be found and unpicked one by one.
   *
   * @param {boolean} _value
   */
  set visible(_value) {}

  /** @param {string} value */
  /**
   * Nothing on screen. The overlay carries one line of text and it says what is
   * happening, not which file it is happening to — the file is named in the
   * playlist and in the address bar, and repeating it here cost the status its
   * own line.
   *
   * @param {string} _value
   */
  setFileName(_value) {}

  /** @param {string} value */
  setStatus(value) {
    document.dispatchEvent(
      new CustomEvent(WAITING_EVENTS.STEP, { detail: { value: typeof value === "string" ? value : "" } })
    );
  }

  /**
   * Nothing. The progress bar is gone: a bar promises a known fraction of a
   * known whole, and what the viewer waits for is a time, which is stated in
   * words beside it. Kept as an accepted call so the pipeline's many progress
   * reports need no unpicking.
   *
   * @param {number} _value
   */
  setProgress(_value) {}

  /**
   * Set the progress bar from a single phase's own 0–100% progress, mapped onto
   * that phase's third of the bar. The pre-playback pipeline has three equal
   * phases: 0 = download (metadata/header), 1 = transcode first segment,
   * 2 = buffering. So each phase fills its 33.33% band.
   *
   * @param {0 | 1 | 2} phaseIndex
   * @param {number} phasePercent - Progress within the phase, 0–100.
   * @returns {void}
   */
  #setPhaseProgress(phaseIndex, phasePercent) {
    const span = 100 / 3;
    const pct = Number.isFinite(phasePercent) ? Math.max(0, Math.min(100, phasePercent)) : 0;
    this.#logEvt(`progress phase=${phaseIndex} within=${pct.toFixed(1)}%`);
    this.setProgress(phaseIndex * span + (pct / 100) * span);
  }

  /**
   * @param {{ file?: File, torrentBytes?: Uint8Array, meta?: object } | null} payload
   * @returns {Promise<void>}
   */
  async #processPlayback(payload) {
    const file = payload?.file;
    const torrentBytes = payload?.torrentBytes;
    const meta = payload?.meta;
    if (!(file instanceof File) || !(torrentBytes instanceof Uint8Array) || !meta || typeof meta !== "object") {
      return;
    }
    if (!(this.#videoElement instanceof HTMLVideoElement)) {
      throw new Error(Loading.MESSAGES.playerNotReady);
    }
    if (this.#isProcessing) {
      throw viewerError(Loading.MESSAGES.alreadyProcessing);
    }

    // A fresh torrent invalidates any pending resume state, cancellation and
    // track selection.
    this.#resetSourceState();
    this.#cancelRequested = false;
    // Shared-link position/file, applied once the player is shown / files known.
    this.#pendingCurrentTime = Number.isFinite(payload?.currentTime) ? payload.currentTime : null;
    this.#pendingFileIndex = Number.isFinite(payload?.fileIndex) ? payload.fileIndex : null;
    this.#isProcessing = true;

    try {
      this.#hlsPlayer.clear();
      this.#subtitlePlayback.clear();
      this.#session.clear();
      const parsed = this.#session.openParsedTorrentDetails({
        fileName: file.name,
        torrentBytes,
        meta
      });
      const addressed = this.#addressedRecord();
      this.#recordSourceIntent();
      const mediaSelection = this.#announceMediaSelection([file.name, parsed.name], categoryOfTorrent(meta), {
        createdAt: Number.isInteger(parsed.createdAt) ? parsed.createdAt : null,
        ...addressed
      });

      this.visible = true;
      this.setFileName(Loading.MESSAGES.readingTorrentFile(file.name));
      this.setStatus(Loading.MESSAGES.startingTorrentProcessing);
      this.setProgress(0);
      this.setStatus(Loading.MESSAGES.readingMetadata);

      // WHAT IS IN THIS TORRENT COMES FROM THE PROXY, for a dropped `.torrent`
      // exactly as for a magnet. The bytes of the file say what the trackers
      // and the web seeds are, which nothing else can see; which files carry a
      // picture, and what belongs to each of them, is one answer and it is
      // given there.
      //
      // It costs a connection before the list of episodes appears, and that
      // connection is being opened from the moment this page loads — see
      // `#connectEarly` — so by the time a file has been dropped it is usually
      // already there.
      await this.#acquireTransport();
      this.#throwIfCancelled();
      // The film is known now and the torrent has not been handed to anybody
      // yet: the last moment at which changing proxy is still cheap.
      await this.#useProxyThatHoldsTheFilm();
      this.#throwIfCancelled();
      const transport = await this.#acquireTransport();
      if (!transport) {
        throw viewerError(Loading.MESSAGES.noProxyAndNoWebseed);
      }
      const sourceKey = await this.#session.registerSourceOnProxy(transport);
      const contents = await this.#askWhatIsInTheTorrent(transport, sourceKey, () => {
        this.setStatus(Loading.MESSAGES.readingMetadata);
      });
      const files = normalizeRemoteFileList(
        typeof contents?.name === "string" && contents.name.length > 0 ? contents.name : parsed.name,
        contents?.files
      );
      if (files.length > 0) {
        parsed.files = files;
        parsed.isMultiFile = files.length > 1;
      }
      this.#announceMediaContents(mediaSelection, contents, parsed.files, transport, sourceKey);
      this.#nameTheFilmInTheLog(parsed.name, parsed.infoHashHex);
      const mediaFiles = mediaFilesFrom(parsed.files, contents?.items);
      this.#subtitlePlayback.setTorrentSubtitleFiles(mediaFiles.subtitles);
      const debugState = getDebugState();
      debugState.torrent = {
        fileName: file.name,
        name: typeof parsed.name === "string" ? parsed.name : "",
        infoHashHex: typeof parsed.infoHashHex === "string" ? parsed.infoHashHex : "",
        isMultiFile: Boolean(parsed.isMultiFile),
        files: Array.isArray(parsed.files)
          ? parsed.files.map((entry) => ({
              index: entry.index,
              name: entry.name,
              path: entry.path,
              relativePath: entry.relativePath,
              isVideo: Boolean(entry.isVideo),
              length: entry.length
            }))
          : [],
        media: {
          video: mediaFiles.video,
          audio: mediaFiles.audio,
          subtitles: mediaFiles.subtitles
        }
      };

      document.dispatchEvent(
        new CustomEvent(PLAYER_EVENTS.SET_MEDIA_FILES, {
          detail: mediaFiles
        })
      );
      this.#setPlaylistButtonVisible(mediaFiles.video.length > 1);

      const videoCount = mediaFiles.video.length;
      if (videoCount <= 0) {
        throw viewerError(Loading.MESSAGES.noVideoFile);
      }
      // Start the torrent NOW, before the viewer has picked an episode. None of
      // what a cold torrent must do first depends on which file is wanted:
      // announce to the trackers, connect to peers, be unchoked by them. On a
      // single-video torrent the file is known already, so the two pieces at
      // its edges — the ones the codec probe reads — are fetched too. Measured
      // 2026-08-04 on a cold 7.4 GB torrent: 6.7 s of the 10.3 s before
      // playback was exactly that, and all of it happened after the file was
      // chosen. Reading a list of episodes takes about as long.
      this.#warmSourceInBackground(videoCount === 1 ? mediaFiles.video[0].index : null);
      const sharedVideoFileIndex = this.#sharedVideoFileIndex();
      if (videoCount === 1) {
        const videoFileIndex = mediaFiles.video[0].index;
        await this.#playVideoFile(videoFileIndex);
      } else if (sharedVideoFileIndex != null) {
        // A shared link targeted a specific file of a multi-file torrent — open
        // it directly instead of the playlist.
        this.#pendingFileIndex = null;
        await this.#playVideoFile(sharedVideoFileIndex);
      } else {
        this.setStatus(Loading.MESSAGES.chooseVideoFile);
        this.setProgress(100);
        document.dispatchEvent(new CustomEvent(LOADING_EVENTS.PLAYBACK_READY, {
          detail: { viewerWantsPlayback: this.#viewerWantsPlayback() }
        }));
        document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.OPEN_PLAYLIST));
        return;
      }

      this.setProgress(100);
      document.dispatchEvent(new CustomEvent(LOADING_EVENTS.PLAYBACK_READY, {
          detail: { viewerWantsPlayback: this.#viewerWantsPlayback() }
        }));
    } finally {
      this.#isProcessing = false;
      if (this.#playbackLive) this.#applyPendingResume();
    }
  }

  /**
   * Get the proxy working on this torrent while the viewer is still choosing.
   *
   * Never awaited and never allowed to fail loudly: everything it does, the
   * ordinary playback path does again for itself, and both steps are cached, so
   * the worst case of a failure here is the behaviour we had before. It is
   * bound to the current attempt, so a torrent abandoned mid-choice cannot have
   * a late warm-up land on top of the next one.
   *
   * @param {number | null} fileIndex - The file to fetch the edges of, when the
   *   torrent holds exactly one video. Null for a pack: warming twenty
   *   episodes' edges would spend the pool owner's bandwidth on nineteen files
   *   nobody opened.
   * @returns {void}
   */
  /**
   * Where this file would start if it were opened now, WITHOUT consuming the
   * field that holds it.
   *
   * Two callers need the same answer at two different moments: the warm-up, as
   * soon as a file is chosen, and the pipeline, when it builds the session. The
   * pipeline clears the field afterwards; the warm-up must not, or the position
   * would be lost before anything used it.
   *
   * @param {number} fileIndex
   * @returns {{ fromField: number | null, fromUrl: number, position: number | null }}
   */
  #resumePositionFor(fileIndex) {
    const fromField = this.#pendingCurrentTime;
    const fromUrl = resumePositionFor(readUrlState(location.search), fileIndex);
    return {
      fromField,
      fromUrl,
      position: fromField != null && fromField >= 0 ? fromField : (fromUrl > 0 ? fromUrl : null)
    };
  }

  /**
   * A release was chosen: tell the metadata component what is known of it, so
   * its search runs while the proxy is being asked what is inside. Nothing here
   * waits for the answer.
   *
   * @param {string[]} names - The `.torrent` file's name and the torrent's own,
   *   or a magnet's `dn`.
   * @param {"adult" | null} [category] - What the torrent says it is, when it says.
   * @param {{ createdAt?: number | null, record?: object | null, recordFileIndex?: number }} [known] - When
   *   the torrent was made (a `.torrent` file states it), and the work the
   *   address already names for one of its files.
   * @returns {number} This choice's number, for the contents that follow.
   */
  #announceMediaSelection(names, category = null, known = {}) {
    this.#mediaSelection += 1;
    document.dispatchEvent(
      new CustomEvent(MEDIA_INFO_EVENTS.SELECTED, {
        detail: { selection: this.#mediaSelection, names, category, ...known }
      })
    );
    return this.#mediaSelection;
  }

  /**
   * The work the address names for the source being opened, before anything
   * rewrites the address: a refresh or a shared link asks for that record
   * instead of searching again.
   *
   * @returns {{ record?: object, recordFileIndex?: number }}
   */
  #addressedRecord() {
    const addressed = readUrlState(location.search);
    return addressed.record && addressed.magnet === this.#currentMagnetUri()
      ? { record: addressed.record, recordFileIndex: addressed.fileIndex }
      : {};
  }

  /**
   * What the metadata component published. Kept to write the work of the
   * active file into the address and the share link.
   *
   * @param {Event} event
   */
  #onMediaInfoChanged = (event) => {
    this.#mediaInfo = event instanceof CustomEvent ? event.detail ?? null : null;
    this.#reflectRecordInUrl();
  };

  /**
   * Write the work the active file is into the address, replacing — not
   * adding — the entry: it describes the same thing watched. A record the
   * address already holds is kept until the service names one, so a refresh
   * does not lose it while the answer is on its way.
   */
  #reflectRecordInUrl() {
    if (this.#navigatingHistory || this.#activeFileIndex < 0) {
      return;
    }
    const record = addressRecord(this.#mediaInfo, this.#activeFileIndex);
    if (!record) {
      return;
    }
    const current = readUrlState(location.search);
    if (current.magnet !== this.#currentMagnetUri() || current.fileIndex !== this.#activeFileIndex || sameRecord(current.record, record)) {
      return;
    }
    this.#writeHistory("replace", { ...current, record });
    document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.SET_SHARE_LINK, { detail: { url: this.#buildShareUrl() } }));
  }

  /**
   * Tell this page's log which torrent is being watched, so the log file the
   * proxy keeps is named after it.
   *
   * Called by both ways a torrent arrives. Only the `.torrent` file path used
   * to call it, so every viewing opened from a magnet link — the demo film and
   * every shared link — left a file named `no-torrent-yet` on the proxy.
   *
   * @param {unknown} name
   * @param {unknown} infoHash
   * @returns {void}
   */
  #nameTheFilmInTheLog(name, infoHash) {
    window.__ttvClientLogger?.setFilm?.({
      name: typeof name === "string" ? name : "",
      infoHash: typeof infoHash === "string" ? infoHash : ""
    });
  }

  /**
   * Ask the proxy for the OpenSubtitles hash of a file and pass it on: release
   * databases name an exact release by it. Asked again while the two edges of
   * the file have not arrived (`202`); it ends when they have, when the file has
   * none (`404`, or a proxy that does not know the route), or when another
   * release is chosen. Nothing waits for it.
   *
   * @param {number} selection
   * @param {number} fileIndex
   * @param {object} transport
   * @param {string | null} sourceKey
   */
  async #announceFingerprint(selection, fileIndex, transport, sourceKey) {
    if (!sourceKey || !Number.isInteger(fileIndex)) return;
    const asked = `${selection}:${fileIndex}`;
    if (this.#fingerprintsAsked.has(asked)) return;
    this.#fingerprintsAsked.add(asked);
    try {
      for (;;) {
        if (selection !== this.#mediaSelection) return;
        const response = await transport.fetch(
          `/api/sources/${encodeURIComponent(sourceKey)}/files/${fileIndex}/fingerprint`,
          { signal: this.#session.abortController.signal, timeoutMs: 0 }
        );
        if (selection !== this.#mediaSelection) return;
        if (response.status === 200) {
          const fingerprint = await response.json();
          if (/^[0-9a-f]{16}$/u.test(fingerprint?.hash) && Number.isInteger(fingerprint?.size)) {
            document.dispatchEvent(new CustomEvent(MEDIA_INFO_EVENTS.FINGERPRINT, {
              detail: { selection, fileIndex, fingerprint: { hash: fingerprint.hash, size: fingerprint.size } }
            }));
          }
          return;
        }
        if (response.status !== 202) return;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    } catch (error) {
      if (!this.#isAbortError(error)) this.#logEvt(`file hash unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Ask the proxy what a file states about its work — and, when it carries a
   * cover inside it, for the cover — and pass both on. The proxy reads them
   * only from the edges of the file, which opening it fetches anyway, so this
   * asks the swarm for nothing; it answers `202` until those edges are here,
   * and `404` from a file that states nothing or a proxy that does not know the
   * route. Nothing waits for it. Only the opened file is asked about: the heads
   * of a pack's other files are not fetched for the picker.
   *
   * @param {number} selection
   * @param {number} fileIndex
   * @param {object} transport
   * @param {string | null} sourceKey
   */
  async #announceContainerMetadata(selection, fileIndex, transport, sourceKey) {
    if (!sourceKey || !Number.isInteger(fileIndex)) return;
    const asked = `${selection}:${fileIndex}`;
    if (this.#containerAsked.has(asked)) return;
    this.#containerAsked.add(asked);
    const ask = async (path) => {
      for (;;) {
        if (selection !== this.#mediaSelection) return null;
        const response = await transport.fetch(`/api/sources/${encodeURIComponent(sourceKey)}/files/${fileIndex}/${path}`,
          { signal: this.#session.abortController.signal, timeoutMs: 0 });
        if (selection !== this.#mediaSelection) return null;
        if (response.status !== 202) return response.status === 200 ? response : null;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    };
    try {
      const response = await ask("container-metadata");
      const container = response ? await response.json() : null;
      if (!container || typeof container !== "object") return;
      document.dispatchEvent(new CustomEvent(MEDIA_INFO_EVENTS.CONTAINER, { detail: { selection, fileIndex, container } }));
      if (!container.cover) return;
      const image = await ask("cover");
      if (!image) return;
      const type = image.headers.get("content-type") ?? container.cover.type ?? "image/jpeg";
      const cover = new Blob([await image.arrayBuffer()], { type });
      document.dispatchEvent(new CustomEvent(MEDIA_INFO_EVENTS.CONTAINER_COVER, { detail: { selection, fileIndex, cover } }));
    } catch (error) {
      if (!this.#isAbortError(error)) this.#logEvt(`container metadata unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * The proxy said what is in the release: pass it on for identification.
   *
   * @param {number} selection
   * @param {object} contents - The proxy's answer.
   * @param {object[]} files - The same list as the rest of this page reads it.
   */
  #announceMediaContents(selection, contents, files, transport, sourceKey) {
    this.#contentsItems = Array.isArray(contents?.items) ? contents.items : [];
    document.dispatchEvent(
      new CustomEvent(MEDIA_INFO_EVENTS.CONTENTS, {
        detail: { selection, contents, files }
      })
    );
    // A release of one picture is that picture: its hash is wanted now, not when
    // the plan of playback is ready, which on a cold torrent takes minutes. A
    // pack's file is asked when it is opened.
    const items = Array.isArray(contents?.items) ? contents.items : [];
    if (items.length === 1) {
      void this.#announceFingerprint(selection, items[0].fileIndex, transport, sourceKey);
      void this.#announceContainerMetadata(selection, items[0].fileIndex, transport, sourceKey);
    }
  }

  /**
   * ASK THE PROXY WHAT IS IN THIS TORRENT, and take its answer as the truth.
   *
   * Which files carry a picture, and which soundtracks and subtitle files
   * belong to each of them, is decided there and nowhere else. This page used
   * to decide it as well — a list of extensions in the torrent parser and a
   * second, shorter pair inside the picker — and the three answers had already
   * diverged: measured 2026-09-12, `.dat` was offered here as video and not
   * counted there, which also decides whether a sidecar whose name matches
   * nothing can belong to the only video present.
   *
   * The answer comes back `pending` while a magnet's metadata is still being
   * fetched, so a single request never races the transport timeout and a
   * slow-to-appear source keeps trying. There is no wall-clock deadline: the
   * loading screen says what it is waiting for until it arrives or the viewer
   * cancels.
   *
   * @param {object} transport
   * @param {string} sourceKey
   * @param {() => void} [whileWaiting] - Called before each further attempt.
   * @returns {Promise<{ name?: string, infoHash?: string, files?: object[], items: object[] }>}
   * @throws {Error} When the answer carries no statement of what is in the torrent.
   */
  async #askWhatIsInTheTorrent(transport, sourceKey, whileWaiting) {
    for (;;) {
      this.#throwIfCancelled();
      const response = await transport.fetch(
        `/api/sources/${encodeURIComponent(sourceKey)}/files?consumerId=${encodeURIComponent(this.#session.consumerId)}`,
        { signal: this.#session.abortController.signal, timeoutMs: 0 }
      );
      this.#throwIfCancelled();
      if (response.ok) {
        const body = await response.json();
        if (!body?.pending) {
          // A STATEMENT, or nothing — the difference is `statesWhatIsInTheTorrent`
          // and is explained there. Retryable, because the next attempt may be
          // answered by another proxy.
          if (!statesWhatIsInTheTorrent(body)) {
            throw viewerError(Loading.MESSAGES.torrentContentsNotStated, { canRetry: true });
          }
          return body;
        }
      } else {
        const error = new Error(`Torrent file list request failed (${response.status}).`);
        error.canRetry = response.status >= 500;
        throw error;
      }
      whileWaiting?.();
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  #warmSourceInBackground(fileIndex, positionSeconds = 0) {
    const epoch = this.#playbackEpoch;
    void (async () => {
      try {
        const transport = await this.#acquireTransport();
        // The ordinary way this ends: the viewer picked a file while the warm-up
        // was still connecting, so a newer attempt owns the pipeline. Said out
        // loud because the silence otherwise reads as a proxy that ignored the
        // request — and the two are indistinguishable in the log.
        if (epoch !== this.#playbackEpoch) {
          this.#logEvt(`warm-up abandoned before registering: a newer attempt began (file ${fileIndex ?? "-"})`);
          return;
        }
        const sourceKey = await this.#session.registerSourceOnProxy(transport);
        if (epoch !== this.#playbackEpoch) {
          this.#logEvt(`warm-up abandoned after registering: a newer attempt began (file ${fileIndex ?? "-"})`);
          return;
        }
        this.#logEvt(`source ${sourceKey} registered for viewer-owned preparation`);
      } catch (error) {
        if (this.#isAbortError(error)) {
          // Abandoned work says so. An aborted warm-up is ordinary — the viewer
          // moved on before the swarm answered — but a warm-up that never
          // happened and never explained itself reads afterwards as a proxy
          // that ignored the request.
          this.#logEvt("warm-up abandoned: the attempt was cancelled");
          return;
        }
        this.#logEvt(`warm-up skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }

  /**
   * @param {{ video?: Array<object>, audio?: Array<object>, subtitles?: Array<object> } | undefined} mediaFiles
   * @param {Array<object>} parsedFiles
   * @returns {{ video: Array<object>, audio: Array<object>, subtitles: Array<object> }}
   */
  /**
   * Magnet flow: the file list is unknown locally — register the magnet on a
   * proxy, wait for the swarm metadata (`/api/sources/:key/files`), then
   * continue exactly like the parsed-torrent flow.
   *
   * @param {string} magnetUri
   * @returns {Promise<void>}
   */
  async #processMagnetPlayback(magnetUri, currentTime = null, fileIndex = null) {
    if (typeof magnetUri !== "string" || magnetUri.trim().length === 0) {
      return;
    }
    if (!(this.#videoElement instanceof HTMLVideoElement)) {
      throw new Error(Loading.MESSAGES.playerNotReady);
    }
    if (this.#isProcessing) {
      throw viewerError(Loading.MESSAGES.alreadyProcessing);
    }

    // A fresh source invalidates any pending resume state, cancellation and
    // track selection (same as the parsed-torrent flow).
    this.#resetSourceState();
    this.#cancelRequested = false;
    // Shared-link position/file, applied once the player is shown / files known.
    this.#pendingCurrentTime = Number.isFinite(currentTime) ? currentTime : null;
    this.#pendingFileIndex = Number.isFinite(fileIndex) ? fileIndex : null;
    this.#isProcessing = true;

    try {
      this.#hlsPlayer.clear();
      this.#subtitlePlayback.clear();
      this.#session.clear();
      const current = this.#session.openMagnetDetails({ magnetUri });
      const addressed = this.#addressedRecord();
      this.#recordSourceIntent();

      // Display name from the magnet's dn parameter until metadata arrives.
      let displayName = "Magnet link";
      try {
        const dn = new URLSearchParams(magnetUri.slice(magnetUri.indexOf("?") + 1)).get("dn");
        if (dn && dn.trim().length > 0) {
          displayName = dn.trim();
        }
      } catch {
        // silent-ok: a magnet whose query will not parse carries no display
        // name, and the fallback is already in place.
      }

      this.visible = true;
      this.setFileName(displayName);
      this.setProgress(0);
      this.setStatus(Loading.MESSAGES.fetchingMagnetMetadata);
      const mediaSelection = this.#announceMediaSelection(displayName === "Magnet link" ? [] : [displayName], null, addressed);

      const transport = await this.#acquireTransport();
      this.#throwIfCancelled();
      if (!transport) {
        throw viewerError(Loading.MESSAGES.noProxyAndNoWebseed);
      }
      const sourceKey = await this.#session.registerSourceOnProxy(transport);
      this.#throwIfCancelled();

      const contents = await this.#askWhatIsInTheTorrent(transport, sourceKey, () => {
        this.setStatus(Loading.MESSAGES.fetchingMagnetMetadata);
      });

      const name =
        typeof contents?.name === "string" && contents.name.length > 0 ? contents.name : displayName;
      const files = normalizeRemoteFileList(name, contents?.files);
      if (files.length === 0) {
        throw viewerError(this.#magnetFailureMessage(magnetUri));
      }

      current.name = name;
      current.files = files;
      current.isMultiFile = files.length > 1;
      this.setFileName(name);
      this.#announceMediaContents(mediaSelection, contents, files, transport, sourceKey);
      this.#nameTheFilmInTheLog(name, contents?.infoHash);

      const mediaFiles = mediaFilesFrom(files, contents?.items);
      this.#subtitlePlayback.setTorrentSubtitleFiles(mediaFiles.subtitles);
      document.dispatchEvent(
        new CustomEvent(PLAYER_EVENTS.SET_MEDIA_FILES, {
          detail: mediaFiles
        })
      );
      this.#setPlaylistButtonVisible(mediaFiles.video.length > 1);

      const videoCount = mediaFiles.video.length;
      if (videoCount <= 0) {
        throw viewerError(Loading.MESSAGES.noVideoFile);
      }
      // Start the torrent NOW, before the viewer has picked an episode. None of
      // what a cold torrent must do first depends on which file is wanted:
      // announce to the trackers, connect to peers, be unchoked by them. On a
      // single-video torrent the file is known already, so the two pieces at
      // its edges — the ones the codec probe reads — are fetched too. Measured
      // 2026-08-04 on a cold 7.4 GB torrent: 6.7 s of the 10.3 s before
      // playback was exactly that, and all of it happened after the file was
      // chosen. Reading a list of episodes takes about as long.
      this.#warmSourceInBackground(videoCount === 1 ? mediaFiles.video[0].index : null);
      const sharedVideoFileIndex = this.#sharedVideoFileIndex();
      if (videoCount === 1) {
        const videoFileIndex = mediaFiles.video[0].index;
        await this.#playVideoFile(videoFileIndex);
      } else if (sharedVideoFileIndex != null) {
        // A shared link targeted a specific file of a multi-file torrent — open
        // it directly instead of the playlist.
        this.#pendingFileIndex = null;
        await this.#playVideoFile(sharedVideoFileIndex);
      } else {
        this.setStatus(Loading.MESSAGES.chooseVideoFile);
        this.setProgress(100);
        document.dispatchEvent(new CustomEvent(LOADING_EVENTS.PLAYBACK_READY, {
          detail: { viewerWantsPlayback: this.#viewerWantsPlayback() }
        }));
        document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.OPEN_PLAYLIST));
        return;
      }

      this.setProgress(100);
      document.dispatchEvent(new CustomEvent(LOADING_EVENTS.PLAYBACK_READY, {
          detail: { viewerWantsPlayback: this.#viewerWantsPlayback() }
        }));
    } finally {
      this.#isProcessing = false;
      if (this.#playbackLive) this.#applyPendingResume();
    }
  }

  /**
   * Why fetching a magnet's metadata came to nothing, said as far as it is
   * known rather than as the consequence the viewer already saw.
   *
   * @param {string} magnetUri
   * @returns {string}
   */
  #magnetFailureMessage(magnetUri) {
    return magnetNamesATracker(magnetUri)
      ? Loading.MESSAGES.magnetMetadataFailed
      : Loading.MESSAGES.magnetMetadataFailedNoTrackers;
  }

  /**
   * Number of video files in the current source. Used to decide whether an
   * error should preserve the parsed source (so the playlist stays usable) —
   * matches the criterion the error screen uses to offer "Back to episodes".
   *
   * @returns {number}
   */
  #videoFileCount() {
    const files = this.#session.current?.files;
    if (!Array.isArray(files)) {
      return 0;
    }
    return files.filter((entry) => entry?.isVideo === true).length;
  }

  /**
   * Reconstruct a shareable URL for the current source. Always a `?magnet=…`
   * link: for a magnet source the original URI; for a `.torrent`-file source a
   * magnet BUILT from the infohash (+ name + trackers) — NOT the whole torrent
   * file base64-embedded, which produced multi-KB URLs that browsers truncate
   * past their length limit. The recipient's proxy fetches metadata from the
   * swarm/DHT, the same path a normal magnet already uses. Empty when there is
   * no current source or no infohash to build from.
   *
   * (Position-resume is a future extension, ties to the cross-device handoff
   * roadmap item.)
   *
   * @returns {string}
   */
  /**
   * Keep the address bar describing what is on screen: which torrent, which
   * file, and where in it.
   *
   * The requirement it serves is exactly one sentence long — a bookmark must
   * reopen the same file of the same torrent at the same moment, with no extra
   * steps — and it decides the shape. The magnet is long and full of characters
   * that cannot sit in a path segment, so these are query parameters, the same
   * three the share link already builds and `torrent.js` already parses on
   * load.
   *
   * `replaceState`, never `push`: the position changes constantly, and pushing
   * would bury the viewer's real history under hundreds of entries of the same
   * film. The cost is one synchronous call at the rate below.
   *
   * Silent when there is nothing to describe — no source, no infohash, or the
   * player has not started — so the address bar is never half-written.
   *
   * @returns {void}
   */
  /**
   * Build a new transcode session for the file already on screen, continuing
   * from where the viewer was.
   *
   * A session can vanish under a player that is otherwise fine: the proxy
   * disposes it after the browser has been away, or the proxy restarts. Every
   * request then answers 404, and the player has no way to interpret that — it
   * polled a dead id indefinitely behind a spinner (field 2026-08-06, eleven
   * minutes of it). Nothing needs to be fetched again to recover: the source
   * and the file are in memory and the position is on the video element, so
   * the honest response to "your session is gone" is to make another one.
   *
   * Only ever one rebuild at a time, and never during the loading flow, which
   * owns its own failure path.
   *
   * @returns {Promise<void>}
   */
  async #rebuildGoneSession() {
    if (this.#rebuildingSession || this.#isProcessing) {
      return;
    }
    const fileIndex = this.#activeFileIndex;
    if (!Number.isInteger(fileIndex) || fileIndex < 0) {
      return;
    }
    const video = this.#videoElement;
    const position = video instanceof HTMLVideoElement ? video.currentTime : 0;
    this.#rebuildingSession = true;
    this.#logEvt(`session gone — rebuilding at ${position.toFixed(1)}s`);
    try {
      await this.#runPlaybackTask(async () => {
        this.#pendingCurrentTime = position > 0 ? position : null;
        await this.#switchToVideoFile(fileIndex);
      });
    } catch (error) {
      this.#logEvt(`session rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.#rebuildingSession = false;
    }
  }

  /**
   * Go where the Back or Forward button just pointed.
   *
   * The browser restores an address and nothing else — everything the
   * application held in memory belongs to the state being left — so the address
   * is the whole instruction. {@link decideNavigation} turns it into the
   * cheapest correct action for where we already are: another torrent has to be
   * loaded, another file of the SAME torrent only opened, the same file only
   * seeked, and a difference of a second is not a navigation at all.
   *
   * Nothing here writes history. The rule that decides push-or-replace already
   * makes that safe — after a restore the address names the state, so a write
   * replaces — but a `timeupdate` from the file being left can arrive
   * mid-transition, when the address and the player disagree, and that one
   * WOULD push. Hence the flag.
   *
   * @returns {Promise<void>}
   */
  async #onHistoryNavigate() {
    const target = readUrlState(location.search);
    const video = this.#videoElement;
    const current = {
      magnet: this.#currentMagnetUri(),
      fileIndex: this.#activeFileIndex >= 0 ? this.#activeFileIndex : -1,
      currentTime: video instanceof HTMLVideoElement ? Math.floor(video.currentTime) : 0
    };
    const { action, fileIndex, currentTime } = decideNavigation(current, target);
    if (action === "none") {
      return;
    }
    this.#logEvt(`history → ${action} file=${fileIndex} at=${currentTime}s`);
    this.#navigatingHistory = true;
    try {
      if (action === "seek") {
        if (video instanceof HTMLVideoElement) {
          video.currentTime = currentTime;
        }
        return;
      }
      if (action === "picker") {
        document.dispatchEvent(new CustomEvent(APP_EVENTS.RESET_TO_PICKER));
        return;
      }
      if (action === "playlist") {
        document.dispatchEvent(new CustomEvent(APP_EVENTS.BACK_TO_PLAYLIST));
        return;
      }
      if (action === "load-source") {
        // The whole source again, with the file and position the entry names —
        // the same path a shared link takes, which already accepts both.
        document.dispatchEvent(new CustomEvent(LOADING_EVENTS.PROCESS_MAGNET, {
          detail: {
            magnetUri: target.magnet,
            fileIndex: fileIndex >= 0 ? fileIndex : null,
            currentTime: currentTime > 0 ? currentTime : null
          }
        }));
        return;
      }
      // open-file: the torrent is already loaded, so only the file changes.
      document.dispatchEvent(new CustomEvent(LOADING_EVENTS.SHOW, {
        detail: { status: Loading.MESSAGES.switchingToSelectedFile, progress: 0 }
      }));
      await this.#runPlaybackTask(async () => {
        this.#pendingCurrentTime = currentTime;
        await this.#switchToVideoFile(fileIndex);
      });
    } catch (error) {
      this.#logEvt(`history navigation failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.#navigatingHistory = false;
    }
  }

  #reflectStateInUrl() {
    if (this.#navigatingHistory) {
      return;
    }
    const magnet = this.#currentMagnetUri();
    if (magnet.length === 0) {
      // Nothing to say. The address is cleared only when the viewer DELIBERATELY
      // leaves — see the RESET_TO_PICKER handler — never merely because the
      // source is momentarily absent. A failure clears the session too, and
      // wiping the address then threw away the one record of what was being
      // watched and where: after a router reboot the error screen's Retry had
      // nothing to return to (reported 2026-08-06).
      return;
    }
    const video = this.#videoElement;
    const current = readUrlState(location.search);
    // Not `video.currentTime` outright: a torn-down element reports zero
    // through the very events that record a position, and a zero written here
    // removes the parameter altogether — the viewer's refresh then starts the
    // film from the beginning. `positionToRecord` decides what the element's
    // reading is worth.
    const next = playbackStateToRecord(current, {
      magnet,
      fileIndex: this.#activeFileIndex >= 0 ? this.#activeFileIndex : -1,
      opening: this.#isProcessing || this.#openingFileIndex !== null,
      element: video instanceof HTMLVideoElement ? video : null
    });
    if (
      video instanceof HTMLVideoElement &&
      video.readyState === 0 &&
      current.currentTime > 0 &&
      !this.#torndownPositionReported
    ) {
      this.#torndownPositionReported = true;
      this.#logEvt(
        `the player holds nothing (readyState=0); keeping ${current.currentTime}s in the address ` +
        "rather than the zero it reports"
      );
    }
    this.#writePlaybackState(current, next);
  }

  #writePlaybackState(current, next) {
    const how = decideHistoryWrite(current, next);
    // Moving on to the next episode means this one is finished, so the entry
    // being left loses its position and Back opens it from the start. Reading
    // the intention from the DESTINATION avoids having to decide how near the
    // end counts as the end — credits run for different lengths in every
    // release, and most people skip them, so no threshold could be right.
    if (
      how === "push" &&
      current.magnet === next.magnet &&
      isAdvanceToNext(current.fileIndex, next.fileIndex, this.#videoFileIndexes())
    ) {
      this.#writeHistory("replace", { ...current, currentTime: 0 });
    }
    this.#writeHistory(how, next);
  }

  #recordSourceIntent() {
    if (this.#navigatingHistory) return;
    const current = readUrlState(location.search);
    const magnet = this.#currentMagnetUri();
    const fileIndex = this.#pendingFileIndex ?? -1;
    this.#writePlaybackState(current, {
      magnet,
      fileIndex,
      currentTime: this.#pendingCurrentTime ?? 0,
      // The work the address names stays with the file it was written for.
      ...(current.record && current.magnet === magnet && current.fileIndex === fileIndex ? { record: current.record } : {})
    });
  }

  /**
   * @param {"push" | "replace"} how
   * @param {{ magnet: string, fileIndex: number, currentTime: number }} state
   * @returns {void}
   */
  #writeHistory(how, state) {
    if (how === "none") {
      return;
    }
    const url = `${location.origin}${location.pathname}${buildUrlSearch(state)}`;
    try {
      if (how === "push") {
        history.pushState(null, "", url);
      } else {
        history.replaceState(null, "", url);
      }
    } catch {
      // silent-ok: a browser that refuses (rate limit, sandboxed frame) keeps the address
      // it had; nothing about playback depends on this.
    }
  }

  /**
   * The magnet for whatever is loaded, or "" when there is nothing to name.
   *
   * @returns {string}
   */
  #currentMagnetUri() {
    const current = this.#session.current;
    if (current?.sourceType === "magnet") {
      return typeof current.sourceValue === "string" ? current.sourceValue : "";
    }
    if (current?.sourceType === "torrent") {
      return this.#buildMagnetFromCurrent(current);
    }
    return "";
  }

  /**
   * Indexes of the playable files, in the order the playlist shows them — what
   * "the next one" means to a viewer, which is not the next index in a pack
   * that also carries subtitles, samples and artwork.
   *
   * @returns {number[]}
   */
  #videoFileIndexes() {
    const files = this.#session.current?.files;
    if (!Array.isArray(files)) {
      return [];
    }
    const indexes = [];
    for (let index = 0; index < files.length; index += 1) {
      if (files[index]?.isVideo === true) {
        indexes.push(index);
      }
    }
    return indexes;
  }

  #buildShareUrl() {
    const current = this.#session.current;
    const base = `${location.origin}${location.pathname}`;
    let magnetUri = "";
    if (current?.sourceType === "magnet") {
      magnetUri = typeof current.sourceValue === "string" ? current.sourceValue : "";
    } else if (current?.sourceType === "torrent") {
      magnetUri = this.#buildMagnetFromCurrent(current);
    }
    if (magnetUri.length === 0) {
      return "";
    }
    let url = `${base}?magnet=${encodeURIComponent(magnetUri)}`;
    // For a multi-file torrent, carry which file is playing so the recipient
    // opens the same one directly instead of the playlist (`fileIndex` — the
    // same name the receiver parses; see torrent.js #loadFromUrl).
    if (this.#activeFileIndex >= 0 && this.#videoFileCount() > 1) {
      url += `&fileIndex=${this.#activeFileIndex}`;
    }
    // Which work it is, so the recipient's page looks the record up instead
    // of searching (torrent-tv/meta#172).
    const record = this.#activeFileIndex >= 0 ? addressRecord(this.#mediaInfo, this.#activeFileIndex) : null;
    if (record) {
      url += buildUrlSearch({ magnet: "m", fileIndex: -1, currentTime: 0, record }).replace(/^\?magnet=m/u, "");
    }
    return url;
  }

  /**
   * The shared-link file index (`#pendingFileIndex`) when it points to a valid
   * video file of the current source, else null. Lets a shared link open a
   * specific file of a multi-file torrent directly instead of the playlist.
   *
   * @returns {number | null}
   */
  #sharedVideoFileIndex() {
    const fileIndex = this.#pendingFileIndex ?? this.#addressedEpisodeFileIndex();
    if (fileIndex == null) {
      return null;
    }
    const file = this.#session.current?.files?.find((entry) => entry.index === fileIndex);
    return file?.isVideo === true ? fileIndex : null;
  }

  /**
   * The file an address with no `fileIndex` names by its episode: the one
   * picture whose marker carries that episode number (and that season, where
   * the file states one). `null` unless exactly one does.
   *
   * @returns {number | null}
   */
  #addressedEpisodeFileIndex() {
    const { record } = readUrlState(location.search);
    if (!Number.isInteger(record?.episode)) {
      return null;
    }
    const matches = this.#contentsItems.filter((item) => {
      const marker = item?.episode;
      return Array.isArray(marker?.episodes) && marker.episodes.includes(record.episode) &&
        (!Number.isInteger(record.season) || !Number.isInteger(marker.season) || marker.season === record.season);
    });
    return matches.length === 1 ? matches[0].fileIndex : null;
  }

  /**
   * Build a magnet URI from the parsed torrent details of the current source:
   * `magnet:?xt=urn:btih:<hash>&dn=<name>&tr=<tracker>…`. Keeps the link short
   * (the swarm/DHT supplies the metadata) instead of embedding the whole file.
   *
   * @param {{ infoHashHex?: string, name?: string, announce?: string, announceList?: unknown }} current
   * @returns {string} Magnet URI, or "" when the infohash is unavailable.
   */
  #buildMagnetFromCurrent(current) {
    const hash = typeof current?.infoHashHex === "string" ? current.infoHashHex.trim() : "";
    if (!/^[0-9a-f]{40}$/i.test(hash)) {
      return "";
    }
    const parts = [`magnet:?xt=urn:btih:${hash.toLowerCase()}`];
    if (typeof current.name === "string" && current.name.trim().length > 0) {
      parts.push(`dn=${encodeURIComponent(current.name.trim())}`);
    }
    const trackers = new Set();
    const addTracker = (candidate) => {
      const trackerString = this.#toTrackerString(candidate);
      if (trackerString && /^(https?|udp|wss?):\/\//i.test(trackerString)) {
        trackers.add(trackerString);
      }
    };
    addTracker(current.announce);
    if (Array.isArray(current.announceList)) {
      for (const tier of current.announceList) {
        if (Array.isArray(tier)) {
          tier.forEach(addTracker);
        } else {
          addTracker(tier);
        }
      }
    }
    for (const tracker of trackers) {
      parts.push(`tr=${encodeURIComponent(tracker)}`);
    }
    return parts.join("&");
  }

  /**
   * Coerce a tracker value to a string. The bencode parser may leave
   * announce-list entries as raw byte arrays; decode those as UTF-8.
   *
   * @param {unknown} value
   * @returns {string}
   */
  #toTrackerString(value) {
    if (typeof value === "string") {
      return value.trim();
    }
    if (value instanceof Uint8Array) {
      try {
        return new TextDecoder().decode(value).trim();
      } catch {
        // silent-ok: bytes that are not text carry no name, and "" is that
        // answer rather than a failure to report.
        return "";
      }
    }
    if (Array.isArray(value) && value.every((byte) => Number.isInteger(byte))) {
      try {
        return new TextDecoder().decode(Uint8Array.from(value)).trim();
      } catch {
        // silent-ok: a byte array that is not text carries no name either.
        return "";
      }
    }
    return "";
  }

  /**
   * A data-channel request that timed out (as opposed to a closed channel or a
   * genuine protocol error). Transient: the request can be retried while the
   * connection stays up — used to keep waiting on a slow torrent instead of
   * failing.
   *
   * @param {unknown} error
   * @returns {boolean}
   */
  #isTransientRequestTimeout(error) {
    return error instanceof Error && /request timed out/i.test(error.message);
  }

  /**
   * A transport-level failure — the WebRTC data channel closed while a
   * loading request was in flight — as opposed to a content/logic error.
   * Field-diagnosed: ICE connects, then the channel dies ~6s later while
   * source registration or the playback-plan request is still in flight.
   * `#onTransportLost`'s automatic reconnect ladder deliberately bails out
   * while a loading flow is running (`#isProcessing`), on the assumption that
   * the loading flow's own failure path handles it — this is that path. Not
   * permanent: a retry acquires a FRESH proxy (`#acquireTransport` never
   * reuses a dead one), so callers should treat it like the data-starvation
   * stall (retryable), not a dead end.
   *
   * @param {unknown} error
   * @returns {boolean}
   */
  #isTransportClosedError(error) {
    return error instanceof Error && /channel closed|channel is not open/i.test(error.message);
  }

  /**
   * Build a retryable loading-stage error and arm a resume so the error
   * screen offers a Retry that restarts this file from the beginning. Used
   * for failure modes that are not permanent — data starvation (few peers)
   * and a mid-loading transport loss (see #isTransportClosedError) — so
   * neither dead-ends the viewer.
   *
   * @param {number} fileIndex
   * @param {string} [message] - Defaults to the data-starvation stall message.
   * @returns {Error}
   */
  #armRetryableStall(fileIndex, message = Loading.MESSAGES.headerDownloadStalled) {
    if (this.#session.current) {
      // Where the viewer actually was. Zero was written here regardless, so
      // Retry after a lost connection started the film from the beginning —
      // reported 2026-08-06 after a router reboot forty minutes in. The
      // position is on the video element until the player is torn down, and
      // the address bar holds it afterwards, so one of the two always knows.
      const video = this.#videoElement;
      const playing = video instanceof HTMLVideoElement ? Math.floor(video.currentTime) : 0;
      const remembered = readUrlState(location.search).currentTime;
      this.#resumeState = {
        fileIndex,
        positionSeconds: playing > 0 ? playing : Math.max(0, remembered),
        sessionCurrent: this.#session.current
      };
    }
    return viewerError(message, { canRetry: true });
  }


  /**
   * @param {number} fileIndex
   * @returns {Promise<void>}
   */
  async #switchToVideoFile(fileIndex) {
    if (!(this.#videoElement instanceof HTMLVideoElement)) {
      throw new Error(Loading.MESSAGES.playerNotReady);
    }
    this.#cancelRequested = false;
    this.#isProcessing = true;
    try {
      this.#hlsPlayer.clear();
      this.#subtitlePlayback.clear();
      // The same <video> element serves every file, and it keeps the position
      // the last one was left at. Attaching a new stream to it therefore
      // resumed the NEW episode wherever the PREVIOUS one had got to — a
      // viewer who switched forty minutes into episode one began episode two
      // forty minutes in. Only when nothing has asked for a position: a resume
      // from the address, from Retry or from Back sets one before getting here,
      // and that is exactly the case this must not overwrite.
      if (!(this.#pendingCurrentTime > 0) && this.#videoElement.currentTime > 0) {
        this.#videoElement.currentTime = 0;
      }
      // Release the previous file's transcode session so the proxy stops its
      // ffmpeg immediately. Otherwise switching episodes leaves the old encode
      // running in parallel with the new one, splitting the (ARM) CPU and
      // dropping both below realtime → stalls.
      this.#session.releaseActiveTranscodeSessions({ reason: "switch-file" });
      this.setStatus(Loading.MESSAGES.switchingToSelectedFile);
      await this.#playVideoFile(fileIndex);
      this.setProgress(100);
      document.dispatchEvent(new CustomEvent(LOADING_EVENTS.PLAYBACK_READY, {
          detail: { viewerWantsPlayback: this.#viewerWantsPlayback() }
        }));
    } finally {
      this.#isProcessing = false;
      if (this.#playbackLive) this.#applyPendingResume();
    }
  }

  /**
   * @param {number} fileIndex
   * @returns {Promise<void>}
   */
  async #playVideoFile(fileIndex) {
    if (!Number.isInteger(fileIndex) || fileIndex < 0) {
      throw viewerError(Loading.MESSAGES.noVideoFile);
    }
    const current = this.#session.current;
    const file = Array.isArray(current?.files)
      ? current.files.find((entry) => entry?.index === fileIndex) ?? null
      : null;
    if (!file || file.isVideo !== true) {
      throw viewerError(Loading.MESSAGES.selectedFileNotFound);
    }
    this.#openingFileIndex = fileIndex;
    const address = readUrlState(location.search);
    const intent = fileOpenState(address, this.#currentMagnetUri(), fileIndex, this.#pendingCurrentTime);
    if (!this.#navigatingHistory) this.#writePlaybackState(address, intent);
    this.#audioMetadataRefreshSeq += 1;
    // Reset the source resolution; it is set again only when the proxy plan
    // provides it below. This gates the quality menu to proxy-served streams
    // (a direct webseed play, which cannot be transcoded, leaves it 0 → no menu).
    this.#sourceVideoWidth = 0;
    this.#sourceVideoHeight = 0;
    // The cushion a switch waits for belongs to the file it was said for.
    this.#minimumBufferSeconds = null;
    // The stall tally belongs to the source it was measured on. Carried over,
    // it would say a fresh file had already been standing still.
    this.#stallStartedAt = null;
    this.#stallTotalMs = 0;
    this.#stallCount = 0;
    // Which file is being LOADED, before anything is ready — so what the page
    // shows while waiting (the episode's picture) is this file's, not the last.
    document.dispatchEvent(new CustomEvent(LOADING_EVENTS.FILE_CHOSEN, { detail: { fileIndex } }));

    const hasWebseed = Array.isArray(current?.webSeeds) && current.webSeeds.length > 0;

    if (!hasWebseed) {
      await this.#preferProxyFromFilename(fileIndex);
      this.#throwIfCancelled();
    }

    if (hasWebseed) {
      this.setStatus(Loading.MESSAGES.startingDirectPlayback);
      this.setProgress(70);
      await this.#session.streamFileToVideo(fileIndex, this.#videoElement);
      try {
        await this.#ensureVideoReady();
        this.#setActiveMediaFile(fileIndex);
      } catch (error) {
        if (!this.#isUnsupportedError(error)) {
          throw error;
        }
        this.setStatus(Loading.MESSAGES.fallingBackToTranscode);
        try {
          await this.#playWithProxyTranscode(fileIndex, { transcodeAudio: false });
          this.#setActiveMediaFile(fileIndex);
        } catch (transcodeError) {
          if (!this.#isUnsupportedError(transcodeError)) {
            throw transcodeError;
          }
          this.setStatus(Loading.MESSAGES.fallingBackToVideoTranscode);
          await this.#playWithProxyTranscode(fileIndex, { transcodeVideo: true, transcodeAudio: false });
          this.#setActiveMediaFile(fileIndex);
        }
      }
      this.#startSubtitlesForVideo(fileIndex);
      return;
    }

    this.setStatus(Loading.MESSAGES.selectingProxy);
    const metadataSelection = this.#mediaSelection;
    this.#setPhaseProgress(0, 10); // phase 0 (download) — small floor before stats arrive
    // Cold-start timing (proxy-served flow): t0 = entry, filled through the
    // phases and logged once on a successful prebuffer.
    this.#coldStart = { t0: performance.now() };
    // Honest status split: the pick is instant; the time is the WebRTC connect.
    // Relabel to "Connecting to proxy" once the selector starts the connect.
    const transport = await this.#acquireTransport({
      onConnecting: () => this.setStatus(Loading.MESSAGES.connectingToProxy)
    });
    this.#throwIfCancelled();
    if (!transport) {
      throw viewerError(Loading.MESSAGES.noProxyAndNoWebseed);
    }
    this.#coldStart.t1 = performance.now();
    // The connection is made, so stop saying it is being made. Nothing cleared
    // this step before, and the next one was published much later — so the
    // overlay read "Connecting to proxy…" while showing peers and a download
    // rate, which can only come FROM a proxy that is already connected. A step
    // that has finished must be replaced at the moment it finishes.
    this.setStatus(Loading.MESSAGES.fetchingMetadata);

    // Register the torrent source early so we can poll live stats while
    // the proxy pre-fetches file metadata (MOOV atom / EBML headers).
    // prepareProxyPlaybackPlan will reuse the cached sourceKey.
    this.setStatus(Loading.MESSAGES.fetchingMetadata);
    this.#setPhaseProgress(0, 20); // phase 0 floor; header download % (stats poll) drives the rest
    let earlySourceKey;
    try {
      earlySourceKey = await this.#session.registerSourceOnProxy(transport);
    } catch (registerError) {
      // See #isTransportClosedError: a transport death here must not become a
      // dead-end fatal error either — same treatment as the plan-poll loop
      // below.
      if (this.#isTransportClosedError(registerError)) {
        throw this.#armRetryableStall(fileIndex, Loading.MESSAGES.connectionLost);
      }
      throw registerError;
    }
    const stopStatsPoll = this.#startTorrentStatsPoll(transport, earlySourceKey, fileIndex);

    let prepared;
    // Warm the file that was actually chosen. The warm-up above runs while the
    // viewer is still reading the list, so it can only name a file when the
    // torrent holds exactly one — on a twelve-episode release it sends none, and
    // everything that warm-up does for a CHOSEN file therefore never ran: field
    // 2026-08-31, both calls answered "file not chosen yet", and the soundtrack
    // beside the picture had nothing downloaded when the viewer asked for it,
    // so the first switch to it timed out. Fire-and-forget, so the plan below is
    // not held up by it.
    this.#warmSourceInBackground(fileIndex, this.#resumePositionFor(fileIndex).position ?? 0);
    try {
      this.#throwIfCancelled();
      try {
        prepared = await this.#session.prepareProxyPlaybackPlan(fileIndex, transport, {
          positionSeconds: this.#resumePositionFor(fileIndex).position ?? 0,
          wantsToPlay: !viewerHasStopped(this.#videoElement)
        });
      } catch (planError) {
        if (this.#isTransportClosedError(planError)) {
          this.#logEvt("transport closed while preparing source declarations");
          throw this.#armRetryableStall(fileIndex, Loading.MESSAGES.connectionLost);
        }
        throw planError;
      }
    } finally {
      stopStatsPoll();
    }

    this.#coldStart.t2 = performance.now();
    this.#throwIfCancelled();
    if (Number.isFinite(prepared.durationSeconds) && prepared.durationSeconds > 0) {
      document.dispatchEvent(new CustomEvent(MEDIA_INFO_EVENTS.PROBED, {
        detail: {
          selection: metadataSelection,
          fileIndex,
          durationSeconds: prepared.durationSeconds,
          // What language the audio is in, against a work's original language.
          audioLanguages: [...new Set((Array.isArray(prepared.audioTracks) ? prepared.audioTracks : [])
            .map((track) => trackLanguageCode(trackLanguageTag(track) || ""))
            .filter((code) => /^[a-z]{2,3}$/u.test(code) && code !== "und"))]
        }
      }));
    }
    void this.#announceFingerprint(metadataSelection, fileIndex, transport, earlySourceKey);
    void this.#announceContainerMetadata(metadataSelection, fileIndex, transport, earlySourceKey);
    this.setStatus(Loading.MESSAGES.checkingCompatibility);
    this.#setPhaseProgress(0, 100); // header probed → phase 0 (download) complete

    // Track inventory of the active file (drives the audio menu and the
    // embedded-subtitle loading).
    this.#audioTracks = Array.isArray(prepared.audioTracks) ? prepared.audioTracks : [];
    const audioMetadataRefreshSeq = ++this.#audioMetadataRefreshSeq;
    if (prepared.audioTracksPending) {
      void this.#refreshAudioTrackMetadata({
        fileIndex,
        sourceKey: prepared.sourceKey,
        transport,
        sequence: audioMetadataRefreshSeq
      });
    }
    this.#subtitlePlayback.setPlan({
      subtitleTracks: Array.isArray(prepared.subtitleTracks) ? prepared.subtitleTracks : [],
      // The files BESIDE this picture that belong to it, paired and read by the
      // proxy. This browser used to pair them again, with a looser rule, and
      // read their names with a stricter one — two answers about the same file,
      // compared nowhere. Measured 2026-09-04 over 115 real torrents: of 1249
      // video files the two pairings differed on ten, and every difference
      // reached the viewer, because the proxy warms what IT paired while this
      // side offered what IT paired. A track offered but never warmed waits for
      // its first piece off the swarm.
      sidecarSubtitles: Array.isArray(prepared.sidecarSubtitles) ? prepared.sidecarSubtitles : [],
    });
    // Subtitles start with the plan, not after playback. The track the file
    // opens with is reported to the proxy now, so its cues are read while the
    // cushion fills, and the start of playback waits for them
    // (`#waitForPrebuffer`). Started after playback, as this was, the opening
    // played without the subtitles the file says to show (torrent-tv/meta#8).
    this.#startSubtitlesForVideo(fileIndex);
    // Source coded resolution — drives the manual quality menu.
    this.#sourceVideoWidth = Number.isFinite(prepared.videoWidth) ? prepared.videoWidth : 0;
    this.#sourceVideoHeight = Number.isFinite(prepared.videoHeight) ? prepared.videoHeight : 0;
    if (this.#selectedAudioTrackIndex >= this.#audioTracks.length) {
      this.#selectedAudioTrackIndex = 0;
    }
    this.#applyRememberedAudioTrack(prepared);
    // Neither track 0 nor the one remembered from an earlier episode is played
    // where the file marks it unusable (torrent-tv/meta#49).
    const opening = openingAudioTrack(this.#audioTracks, this.#selectedAudioTrackIndex);
    if (opening !== this.#selectedAudioTrackIndex) {
      this.#logEvt(`audio track ${this.#selectedAudioTrackIndex} is marked unusable; opening on ${opening}`);
      this.#selectedAudioTrackIndex = opening;
    }

    // The codec of the track that will actually be PLAYED, not of the file's
    // first one. They are the same track until a viewer chooses another, and can
    // differ entirely once a release ships its dub as a separate file: a picture
    // whose own sound is AAC beside an AC-3 dub, where deciding from the picture
    // would copy AC-3 into a browser that cannot decode it. The plan states a
    // codec per track; the file-level one remains the answer when it does not.
    const chosenAudioTrack = (this.#audioTracks).find(
      (track) => track?.index === this.#selectedAudioTrackIndex
    );
    const chosenAudioCodec =
      typeof chosenAudioTrack?.codec === "string" && chosenAudioTrack.codec.length > 0
        ? chosenAudioTrack.codec
        : prepared.audioCodec;
    const codecSupport = await this.#predictCodecSupport({
      audioCodec: chosenAudioCodec,
      videoCodec: prepared.videoCodec
    });
    // Decide per stream, independently: transcode the video track only if the
    // browser cannot decode the video codec, and the audio track only if it
    // cannot decode the audio codec.  The proxy's advisory `mode` is NOT used
    // to force audio transcoding — we transcode strictly what is unsupported.
    //
    // A copy of the source is never re-encoded here because it is taller than
    // the picture on screen (roadmap item 98): only a codec this browser cannot
    // play makes the page ask for a re-encode, and a link that cannot carry the
    // copy is the proxy's to answer.
    const shouldTranscodeVideo = codecSupport.videoSupported === false;
    const shouldTranscodeAudio = codecSupport.audioSupported === false;
    // Refused before a session exists, because a session made here would stall.
    // `cannotServe` is the proxy's own answer that it cannot sustain this file
    // at ANY height — not even by copying the picture, which needs no encoder.
    // Retryable, not fatal: the answer is measured against the machine as it is
    // at this moment.
    if (typeof prepared.cannotServe === "string" && prepared.cannotServe.length > 0) {
      this.#debug("proxy cannot serve this file", { fileIndex, why: prepared.cannotServe });
      // Before giving up: ask the rest of the pool the same question. They can
      // answer it because the description travels with the refusal — the
      // expensive half, finding out what this file IS, was paid once here, and
      // everyone else answers by arithmetic against their own startup
      // benchmarks without adding the torrent or fetching a byte. This is where
      // the ordering is repaired: a viewer is given a proxy BEFORE the file is
      // known, by a score that reads processor load and free memory, neither of
      // which can answer a question about a particular source.
      if (this.#proxy?.proxyId) {
        this.#refusedProxiesForThisOpen.add(this.#proxy.proxyId);
      }
      const elsewhere = (await this.#proxiesThatCanServe(prepared.mediaInfoForOffer))
        .filter((id) => !this.#refusedProxiesForThisOpen.has(id));
      if (elsewhere.length > 0) {
        this.#debug("retrying the file on another proxy that can serve it", {
          fileIndex,
          candidates: elsewhere
        });
        this.#restrictProxiesToPool(elsewhere);
        return await this.#playVideoFile(fileIndex);
      }
      throw this.#armRetryableStall(fileIndex, Loading.MESSAGES.proxyCannotKeepUp);
    }
    // Cleared once a proxy has accepted the file: a refusal is about one file
    // on one machine at one moment, and holding the pool narrow afterwards
    // would send every later file to the same few.
    this.#restrictProxiesTo = null;
    this.#mediaInfoForOffer = prepared.mediaInfoForOffer ?? null;
    // The plan is what the torrent and the probe together produced: from here
    // the pre-roll is our own session work, and the stage line separates the
    // two rather than reporting one span nobody can act on.
    this.#debug("playback decision", {
      fileIndex,
      container: prepared.container,
      audioCodec: prepared.audioCodec,
      // What the CHOSEN track is, which is what the decision was made on. Equal
      // to the line above until the viewer picks another track, or the release
      // ships its sound in a file of its own.
      chosenAudioCodec,
      chosenAudioTrackIndex: this.#selectedAudioTrackIndex,
      videoCodec: prepared.videoCodec,
      audioSupported: codecSupport.audioSupported,
      videoSupported: codecSupport.videoSupported,
      plannerMode: prepared.mode,
      shouldTranscodeVideo,
      shouldTranscodeAudio,
      transport: transport.isHttp ? "http" : "webrtc"
    });
    const directRetryKey = this.#buildDirectRetryCacheKey(fileIndex, prepared);
    const directHintKey = this.#buildDirectPlaybackHintKey(prepared);
    const directHint = this.#getDirectPlaybackHint(directHintKey);

    // A non-default audio track can only be delivered by the proxy selecting it
    // — direct play always carries the container's default track, and a track
    // that lives in a file of its own is not in the container being played at
    // all. Either way this attempt cannot be a direct one.
    const forceAudioRemux = this.#selectedAudioTrackIndex > 0;

    // Direct URL probing only works for HTTP transports — WebRTC uses fake URLs.
    // A forced quality must go through the transcode path, so skip every
    // direct-play shortcut when it is set.
    const canProbeDirectUrl = transport.isHttp && !forceAudioRemux;

    if (
      canProbeDirectUrl &&
      shouldTranscodeVideo &&
      !shouldTranscodeAudio &&
      !this.#directPlaybackUnsupportedCache.has(directRetryKey) &&
      directHint !== "unsupported"
    ) {
      const directSucceeded = await this.#tryPlayDirectUrl(prepared.directUrl, {
        statusMessage: Loading.MESSAGES.probingDirectPlayback,
        progress: 58
      });
      if (directSucceeded) {
        this.#setDirectPlaybackHint(directHintKey, true);
        this.#directPlaybackUnsupportedCache.delete(directRetryKey);
        this.#setActiveMediaFile(fileIndex);
        return;
      }
      this.#setDirectPlaybackHint(directHintKey, false);
      this.#directPlaybackUnsupportedCache.add(directRetryKey);
    }

    if (shouldTranscodeAudio || shouldTranscodeVideo || forceAudioRemux) {
      if (
        canProbeDirectUrl &&
        shouldTranscodeAudio &&
        !this.#directPlaybackUnsupportedCache.has(directRetryKey) &&
        directHint !== "unsupported"
      ) {
        const directSucceeded = await this.#tryPlayDirectUrl(prepared.directUrl, {
          statusMessage: Loading.MESSAGES.probingDirectPlayback,
          progress: 58
        });
        if (directSucceeded) {
          this.#setDirectPlaybackHint(directHintKey, true);
          this.#directPlaybackUnsupportedCache.delete(directRetryKey);
          this.#setActiveMediaFile(fileIndex);
          return;
        }
        this.#setDirectPlaybackHint(directHintKey, false);
        this.#directPlaybackUnsupportedCache.add(directRetryKey);
      }

      const transcodeReason = this.#buildTranscodeReason({
        audioCodec: prepared.audioCodec,
        videoCodec: prepared.videoCodec,
        audioSupported: codecSupport.audioSupported,
        videoSupported: codecSupport.videoSupported,
        plannerMode: prepared.mode,
        shouldTranscodeAudio,
        shouldTranscodeVideo
      });
      const statusMessage = shouldTranscodeVideo
        ? Loading.MESSAGES.preparingHlsVideo
        : Loading.MESSAGES.preparingHlsAudio;
      this.setStatus(`${statusMessage}\n${transcodeReason}`);
      const transcodeAudioTrack =
        shouldTranscodeAudio || !this.#canCopyAudioCodecForHls(prepared.audioCodec);
      await this.#playWithProxyTranscode(fileIndex, {
        transport,
        sourceKey: prepared.sourceKey,
        transcodeVideo: shouldTranscodeVideo,
        transcodeAudio: transcodeAudioTrack,
        segmentFormat: this.#requiredSegmentFormat({
          audioCodec: prepared.audioCodec,
          transcodeAudio: transcodeAudioTrack
        }),
        statusMessage: `${statusMessage}\n${transcodeReason}`
      });
      this.#setActiveMediaFile(fileIndex);
      return;
    }

    if (canProbeDirectUrl) {
      const directSucceeded = await this.#tryPlayDirectUrl(prepared.directUrl, {
        statusMessage: Loading.MESSAGES.startingDirectPlayback,
        progress: 70
      });
      if (directSucceeded) {
        this.#setDirectPlaybackHint(directHintKey, true);
        this.#directPlaybackUnsupportedCache.delete(directRetryKey);
        this.#setActiveMediaFile(fileIndex);
        return;
      }
      this.#setDirectPlaybackHint(directHintKey, false);
      this.#directPlaybackUnsupportedCache.add(directRetryKey);
      this.setStatus(Loading.MESSAGES.fallingBackToTranscode);
      try {
        await this.#playWithProxyTranscode(fileIndex, {
          transport,
          sourceKey: prepared.sourceKey,
          transcodeAudio: false
        });
        this.#setActiveMediaFile(fileIndex);
      } catch (transcodeError) {
        if (!this.#isUnsupportedError(transcodeError)) {
          throw transcodeError;
        }
        this.setStatus(Loading.MESSAGES.fallingBackToVideoTranscode);
        try {
          await this.#playWithProxyTranscode(fileIndex, {
            transport,
            sourceKey: prepared.sourceKey,
            transcodeVideo: true,
            transcodeAudio: false
          });
          this.#setActiveMediaFile(fileIndex);
        } catch (fullTranscodeError) {
          if (!this.#isUnsupportedError(fullTranscodeError)) {
            throw fullTranscodeError;
          }
          this.setStatus(Loading.MESSAGES.preparingHlsVideo);
          await this.#playWithProxyTranscode(fileIndex, {
            transport,
            sourceKey: prepared.sourceKey,
            transcodeVideo: true,
            transcodeAudio: true
          });
          this.#setActiveMediaFile(fileIndex);
        }
      }
      return;
    }

    // WebRTC transport: no direct URL probing possible — go straight to HLS transcode.
    const transcodeAudioTrack =
      shouldTranscodeAudio || !this.#canCopyAudioCodecForHls(prepared.audioCodec);
    await this.#playWithProxyTranscode(fileIndex, {
      transport,
      sourceKey: prepared.sourceKey,
      transcodeVideo: shouldTranscodeVideo,
      transcodeAudio: transcodeAudioTrack,
      segmentFormat: this.#requiredSegmentFormat({
        audioCodec: prepared.audioCodec,
        transcodeAudio: transcodeAudioTrack
      })
    });
    this.#setActiveMediaFile(fileIndex);
  }

  /**
   * Return the current open transport, or connect a new proxy and create one.
   * Stores the result in `#proxy` / `#transport` for reuse within the same session.
   *
   * Two-stage connect ("prompt-free first"): the first attempt uses only the
   * proxy's PUBLIC addresses, so the browser never touches the local network
   * and never asks for the local-network permission — a same-LAN viewer then
   * connects through the router's public side when it supports looping the
   * packets back inside (most home routers do). Only when that fails does the
   * flow obtain the permission (explainer + one click that makes the browser
   * ask) and retry with the proxy's local addresses included.
   *
   * Callers that arrive while a connection is already being built JOIN it
   * rather than starting a second one. The check above only sees a FINISHED
   * connection, and two callers run concurrently by design — the background
   * warm-up starts when the torrent is opened, the playback flow when a file is
   * picked a moment later — so without this both built one. Measured
   * 2026-08-14: the proxy took two offers 7 ms apart and brought up two full
   * connections with two data channels each; one carried 5 MB, the other 1204
   * bytes and stayed open, unclosed, for the whole session.
   *
   * @param {{ onConnecting?: (proxyName: string) => void }} [options]
   * @returns {Promise<import("../../domain/proxy-transport.js").ProxyTransport>}
   */
  /**
   * Which proxies say they could sustain this file, the one that refused
   * excluded.
   *
   * Costs one round trip for the whole pool: the server asks every connected
   * proxy over the tunnel it already holds, and each answers from its own
   * startup benchmarks and the description — no torrent, no bytes, no ffmpeg.
   *
   * @param {object | null | undefined} mediaInfo
   * @returns {Promise<string[]>}
   */
  async #proxiesThatCanServe(mediaInfo, { includeCurrent = false } = {}) {
    if (!mediaInfo || typeof mediaInfo !== "object") {
      return [];
    }
    try {
      const response = await fetch("/api/proxy-clients/can-serve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mediaInfo, exclude: includeCurrent ? "" : (this.#proxy?.proxyId ?? "") })
      });
      if (!response.ok) {
        return [];
      }
      const payload = await response.json();
      return Array.isArray(payload.clients)
        ? payload.clients.map((client) => client.id).filter((id) => typeof id === "string")
        : [];
    } catch {
      // silent-ok: an unanswered question is the same as nobody being able to
      // help, and the viewer is told that instead.
      return [];
    }
  }

  async #preferProxyFromFilename(fileIndex) {
    const file = this.#session.current?.files?.find((entry) => entry?.index === fileIndex);
    const hint = mediaInfoHintFromFilename(file?.name);
    if (!hint) {
      return;
    }
    const candidates = await this.#proxiesThatCanServe(hint, { includeCurrent: true });
    // A filename is not authoritative. Use the hint only when at least one
    // proxy answers positively; otherwise the actual playback plan decides.
    if (candidates.length === 0 || candidates.includes(this.#proxy?.proxyId)) {
      return;
    }
    this.#logEvt(`filename hints ${hint.width}x${hint.height}${hint.codec ? ` ${hint.codec}` : ""}; trying a proxy that reports capacity`);
    this.#restrictProxiesToPool(candidates);
  }

  /**
   * Limit the next transport to proxies that answered they can serve this file.
   *
   * @param {string[]} proxyIds
   * @returns {void}
   */
  #restrictProxiesToPool(proxyIds) {
    this.#restrictProxiesTo = proxyIds;
    this.#abandonTransportAcquisition();
    try {
      this.#proxy?.close();
    } catch {
      // silent-ok: the refused connection is being replaced either way.
    }
    this.#proxy = null;
    this.#transport = null;
  }

  /**
   * The infohash of the film being opened, or "".
   *
   * The one name a proxy and this page share for a film: a magnet and a
   * `.torrent` describing the same content carry it identically, which is why
   * the proxy keys its sources by it too. Used to prefer a proxy that is already
   * downloading this film — see `chooseBestProxy`.
   *
   * @returns {string}
   */
  #currentInfoHash() {
    const current = this.#session?.current;
    const parsed = typeof current?.infoHashHex === "string" ? current.infoHashHex.trim() : "";
    if (/^[0-9a-f]{40}$/i.test(parsed)) {
      return parsed.toLowerCase();
    }
    // A magnet is opened before anything is parsed, and carries the hash itself.
    const magnet = current?.sourceType === "magnet" && typeof current.sourceValue === "string"
      ? /xt=urn:btih:([0-9a-z]{40})/i.exec(current.sourceValue)
      : null;
    return magnet ? magnet[1].toLowerCase() : "";
  }

  /**
   * Make sure the proxy in hand is the right one for the film about to be
   * opened, and change it if it is not.
   *
   * WHY THIS EXISTS. A proxy is taken the moment the page opens — before any
   * film has been chosen — so the choice is made with no infohash, and
   * `#acquireTransport` then returns that same connection to everyone who asks
   * afterwards. The preference for a proxy that is ALREADY downloading this
   * film therefore never applied to anybody: it is computed from the infohash,
   * and the infohash did not exist when the decision was made.
   *
   * Field 2026-09-13: two viewers opened one film 76 seconds apart and landed
   * on two different proxies, each of which downloaded and encoded it
   * separately. The second could have joined the first for the cost of an
   * encode.
   *
   * Called before the torrent is handed to a proxy, which is the last moment
   * that is still cheap: what is warmed by then is one connection, 232 ms
   * measured. After it, the torrent is added, peers are found, metadata is
   * fetched and header pieces are downloaded — and all of that is lost on a
   * change.
   *
   * @returns {Promise<void>}
   */
  async #useProxyThatHoldsTheFilm() {
    const infoHash = this.#currentInfoHash();
    if (!infoHash || !this.#proxy) {
      return;
    }
    const wanted = await this.#proxySelector.bestProxyIdFor({
      infoHash,
      onlyIds: this.#restrictProxiesTo
    });
    if (!wanted || wanted === this.#proxy.proxyId) {
      return;
    }
    this.#logEvt(`proxy ${this.#proxy.proxyId?.slice(0, 8)} is not the best for this film; moving to ${wanted.slice(0, 8)}`);
    this.#abandonTransportAcquisition();
    try {
      this.#proxy.close();
    } catch {
      // silent-ok: a connection that is already gone needs no closing, and this
      // one is being replaced either way — the failure carries no information.
    }
    this.#proxy = null;
    this.#transport = null;
  }

  async #acquireTransport({ onConnecting } = {}) {
    if (this.#transport && (!this.#proxy || this.#proxy.isOpen)) {
      return this.#transport;
    }
    const running = this.#transportAcquisition;
    if (running) {
      // Each caller still gets its own progress. The proxy is announced ONCE,
      // the moment it is chosen and before the seconds of connecting — so a
      // joiner arriving after that moment is told what was announced, rather
      // than sitting on "selecting a proxy" for the whole connect. That is the
      // common case, not the rare one: the warm-up announces nothing, and the
      // playback flow joins whenever the viewer finishes choosing an episode.
      if (typeof onConnecting === "function") {
        running.listeners.add(onConnecting);
        if (running.announced !== null) {
          try {
            onConnecting(running.announced);
          } catch {
            // silent-ok: a status line must never break the connect it
            // describes, and the connect continues either way.
          }
        }
      }
      return running.promise;
    }
    /** @type {TransportAcquisition} */
    const record = {
      promise: /** @type {any} */ (null),
      listeners: new Set(typeof onConnecting === "function" ? [onConnecting] : []),
      announced: null
    };
    record.promise = this.#connectTransport(record).then((transport) => {
      // Say who is watching, over the connection itself. The proxy can then
      // treat that connection closing as this PERSON leaving — every output
      // they were watching at once — instead of waiting out a silence that a
      // paused viewer produces just as well as a closed tab.
      transport?.identifyViewer?.(this.#session?.consumerId);
      // From here the page's own log goes to the PROXY, which keeps it beside
      // its own on a durable disk. Until now it went to the registry server's
      // standard output, which every release of it destroys — and explaining a
      // failure needs both halves.
      window.__ttvClientLogger?.setProxySink?.({
        isOpen: () => transport.isOpen,
        send: (body) => transport.fetch("/api/client-logs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body
        })
      });
      // MEASURE THE LINK NOW, while the person is still finding their film. The
      // figure used to come only from segments of the film itself, so it did
      // not exist until playback had begun — after every decision that wants
      // it. Best-effort and unawaited: nothing here waits on it.
      void measureLink(transport);
      return transport;
    }).finally(() => {
      // Only if it is still ours: an abandoned attempt was replaced long ago
      // and must not clear the connect that replaced it.
      if (this.#transportAcquisition === record) {
        this.#transportAcquisition = null;
      }
    });
    this.#transportAcquisition = record;
    return record.promise;
  }

  /**
   * Give up on the connect in flight, if any.
   *
   * The callers already waiting on it keep their promise and its rejection;
   * what stops is its claim on the component — the next request for a
   * transport starts a fresh connect, and this one may no longer adopt the
   * proxy it is building. Without this a connect begun before a cancel stayed
   * the answer given to everyone who asked afterwards, so a cancelled attempt
   * failed the NEXT one too; and one that finished after `#stopPlayback` put a
   * live proxy back on a component that had just torn one down.
   *
   * @returns {void}
   */
  #abandonTransportAcquisition() {
    // The waiters keep the promise; what they stop getting is progress. An
    // abandoned attempt still has a second half to run (the local-address
    // retry), and its status line would otherwise re-label a screen that has
    // moved on.
    this.#transportAcquisition?.listeners.clear();
    this.#transportAcquisition = null;
  }

  /**
   * Build a transport: pick a proxy, connect, adopt it. The single flight
   * behind {@link #acquireTransport} — never call it directly, or the
   * duplicate-connection it exists to prevent comes back.
   *
   * @param {TransportAcquisition} record - This attempt: who is waiting on it,
   *   and what has been announced to them. The same object the component holds
   *   while the attempt is current, so identity answers "is this still the
   *   attempt in flight".
   * @returns {Promise<import("../../domain/proxy-transport.js").ProxyTransport>}
   */
  async #connectTransport(record) {
    const onConnecting = (proxyName) => {
      record.announced = proxyName;
      for (const listener of record.listeners) {
        try {
          listener(proxyName);
        } catch {
          // silent-ok: as above — a listener that throws costs a line of text,
          // not the connection.
        }
      }
    };
    // Close stale proxy if present.
    if (this.#proxy) {
      this.#proxy.close();
      this.#proxy = null;
      this.#transport = null;
    }
    let proxy;
    try {
      // Attempt 1: public addresses only — never triggers the permission
      // question. Shorter timeout: either the public path works within
      // seconds or it never will.
      proxy = await this.#proxySelector.chooseBestProxy({
        allowPrivateCandidates: false,
        connectTimeoutMs: 12_000,
        onConnecting,
        infoHash: this.#currentInfoHash(),
        onlyIds: this.#restrictProxiesTo
      });
    } catch (publicOnlyError) {
      this.#throwIfCancelled();
      // Checked separately from cancellation: playback can be torn down
      // without a cancel (an error screen, a reset, the page going away), and
      // the local path's next step puts a permission explainer on the screen.
      // Asking for a network permission on behalf of an attempt nobody is
      // waiting for is worse than merely wasteful.
      this.#throwIfAbandoned(record);
      const lanProbeUrl =
        publicOnlyError instanceof Error && typeof publicOnlyError.lanProbeUrl === "string"
          ? publicOnlyError.lanProbeUrl
          : null;
      this.#logEvt(`public-only connect failed (${publicOnlyError?.message ?? publicOnlyError}); trying local path`);
      await this.#ensureLocalNetworkPermission(lanProbeUrl);
      this.#throwIfCancelled();
      this.#throwIfAbandoned(record);
      // Attempt 2: all addresses, permission (when the browser has such a
      // mechanism) obtained above.
      proxy = await this.#proxySelector.chooseBestProxy({
        allowPrivateCandidates: true,
        onConnecting,
        infoHash: this.#currentInfoHash(),
        onlyIds: this.#restrictProxiesTo
      });
    }
    // Adopting now would hand a live proxy to a component that has torn its
    // own down, so the connection is closed rather than left running.
    if (this.#transportAcquisition !== record) {
      proxy.close();
      this.#throwIfAbandoned(record);
    }
    return this.#adoptProxy(proxy);
  }

  /**
   * Stop a connect attempt that is no longer the one in flight.
   *
   * Thrown as an `AbortError` because that is what every call site already
   * recognises as "this attempt was superseded" and swallows without putting an
   * error screen in front of the viewer.
   *
   * @param {TransportAcquisition} record
   * @returns {void}
   */
  #throwIfAbandoned(record) {
    if (this.#transportAcquisition === record) {
      return;
    }
    const abandoned = new Error("Proxy connect abandoned.");
    abandoned.name = "AbortError";
    throw abandoned;
  }

  /**
   * Bind a freshly connected proxy as the active transport: wire the
   * connection-loss handler, remember the connection descriptor for
   * auto-reconnect, and either reuse the existing transport object (swapping
   * its inner proxy in place, so the running HLS loader / torrent-session keep
   * their reference — seamless reconnect) or create one on first connect.
   *
   * @param {import("../../domain/webrtc-proxy.js").WebRtcProxy} proxy
   * @returns {import("../../domain/proxy-transport.js").ProxyTransport}
   */
  #adoptProxy(proxy) {
    // Nothing else closes a connection this one replaces. The reconnect flow
    // adopts a fresh proxy over a dead one, where closing is a no-op; a live
    // one being replaced is the case that leaked, and a leaked connection keeps
    // its channels, its keepalives and its ICE alive on both machines for as
    // long as the page is open.
    if (this.#proxy && this.#proxy !== proxy) {
      try {
        // Retired, not merely closed: whatever is still waiting on it is
        // answered at once as replaced, so the player asks again on the new
        // connection instead of waiting out a request nobody will answer.
        this.#proxy.retire();
      } catch (error) {
        // Already gone — the point was that it is not left open. Said out loud
        // all the same: a connection that refuses to close is exactly the shape
        // of the leak this block exists to prevent, and it kept its channels,
        // its keepalives and its ICE alive on both machines when it happened.
        console.debug(
          `[torrent-tv][transport] the replaced connection would not close ` +
          `(sig=${this.#proxy?.signalSessionId ?? "-"} proxy=${this.#proxy?.proxyId ?? "-"}): ` +
          `${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    // Surface a mid-playback loss of this connection (auto-reconnect flow). A
    // close() by #stopPlayback never fires this.
    proxy.onConnectionLost = () => this.#onTransportLost();
    // A connection that stays open and stops delivering. Not a loss: a second
    // connection is raised beside it and adopted only once it has proved itself.
    proxy.onDeliveryStalled = () => this.#onDeliveryStalled(proxy);
    proxy.onDeliveryResumed = () => this.#onDeliveryResumed(proxy);
    // Subtitle cues, pushed as the proxy reads them off its own download —
    // never polled for. See #onSubtitleCuesPush.
    proxy.onSubtitleCues = (event) => this.#subtitlePlayback.onCues(event);
    // Stamp the forwarded log with the connection that is about to carry the
    // session. The connection announces itself as soon as it has an id, which
    // is what covers the connect phase; this is the correction, for the case
    // where the one that got there first is not the one being used.
    if (proxy.signalSessionId) {
      try {
        window.__ttvClientLogger?.setSignalSession?.(proxy.signalSessionId);
      } catch {
        // silent-ok: the forwarder is a debugging aid; playback must not depend
        // on a diagnostic being tagged.
      }
    }
    this.#proxy = proxy;
    if (this.#transport && !this.#transport.isHttp) {
      this.#transport.replaceWebRtcProxy(proxy);
    } else {
      this.#transport = ProxyTransport.fromWebRtc(proxy);
    }
    this.#lastProxyDescriptor = {
      proxyId: proxy.proxyId,
      proxyLocalPort: proxy.proxyLocalPort,
      allowPrivateCandidates: proxy.allowsPrivateCandidates
    };
    return this.#transport;
  }

  /**
   * Make sure the browser lets this page reach the proxy's local address.
   * No-op when the browser has no such permission mechanism (Firefox), or the
   * permission is already granted. Otherwise walks the user through it:
   * an explainer + an "Allow" button whose click performs the local request
   * that makes the browser show its own permission question; a denied state
   * shows guidance and a "Check again" button.
   *
   * @param {string | null} lanProbeUrl - `http://<proxy-lan-ip>:<port>/healthz`, when known.
   * @returns {Promise<void>}
   */
  async #ensureLocalNetworkPermission(lanProbeUrl) {
    for (;;) {
      this.#throwIfCancelled();
      const state = await queryLocalNetworkPermission();
      if (state === "unsupported" || state === "granted") {
        return;
      }
      if (state === "prompt") {
        if (!lanProbeUrl) {
          // Nothing to probe — cannot make the browser ask. Proceed; the
          // attempt itself will succeed or fail on its own.
          return;
        }
        this.setStatus(Loading.MESSAGES.lanPermissionExplainer);
        await this.#waitForActionClick(Loading.MESSAGES.lanAllowButton);
        this.#throwIfCancelled();
        this.setStatus(Loading.MESSAGES.lanPermissionWaiting);
        await probeLocalNetwork(lanProbeUrl);
        continue; // re-check the permission state
      }
      // denied — the browser will not ask again; guide to the site settings.
      this.setStatus(Loading.MESSAGES.lanPermissionDenied);
      await this.#waitForActionClick(Loading.MESSAGES.lanCheckAgainButton);
    }
  }

  /**
   * Show the loading view's action button with `label` and resolve on click.
   * The button is hidden again afterwards. Cancellation (the Cancel button)
   * is honoured: the wait ends and the caller's next #throwIfCancelled throws.
   *
   * @param {string} label
   * @returns {Promise<void>}
   */
  #waitForActionClick(label) {
    return new Promise((resolve) => {
      const button = this.#actionButton;
      button.textContent = label;
      button.hidden = false;
      const cancelPoll = setInterval(() => {
        if (this.#cancelRequested) {
          finish();
        }
      }, 250);
      const onClick = () => finish();
      const finish = () => {
        clearInterval(cancelPoll);
        button.removeEventListener("click", onClick);
        button.hidden = true;
        resolve();
      };
      button.addEventListener("click", onClick);
    });
  }

  /**
   * @param {number} fileIndex
   * @param {{ sourceKey?: string, audioCodec?: string, videoCodec?: string }} prepared
   * @returns {string}
   */
  #buildDirectRetryCacheKey(fileIndex, prepared) {
    const sourceKey = typeof prepared?.sourceKey === "string" ? prepared.sourceKey : "";
    const audioCodec = typeof prepared?.audioCodec === "string" ? prepared.audioCodec : "";
    const videoCodec = typeof prepared?.videoCodec === "string" ? prepared.videoCodec : "";
    return `${sourceKey}:${fileIndex}:${audioCodec}:${videoCodec}`;
  }

  /**
   * @param {{ audioCodec?: string, videoCodec?: string, mode?: string }} prepared
   * @returns {string}
   */
  #buildDirectPlaybackHintKey(prepared) {
    const audioCodec = typeof prepared?.audioCodec === "string" ? prepared.audioCodec : "";
    const videoCodec = typeof prepared?.videoCodec === "string" ? prepared.videoCodec : "";
    const mode = typeof prepared?.mode === "string" ? prepared.mode : "";
    return `${this.#getBrowserProfileKey()}:${audioCodec}:${videoCodec}:${mode}`;
  }

  /**
   * @returns {string}
   */
  #getBrowserProfileKey() {
    const ua = typeof navigator?.userAgent === "string" ? navigator.userAgent : "";
    const platform = typeof navigator?.platform === "string" ? navigator.platform : "unknown-platform";
    const browser = this.#extractBrowserMajor(ua);
    return `${browser}:${platform}`;
  }

  /**
   * @param {string} userAgent
   * @returns {string}
   */
  #extractBrowserMajor(userAgent) {
    const ua = typeof userAgent === "string" ? userAgent : "";
    const patterns = [
      { name: "Edge", regex: /Edg\/(\d+)/ },
      { name: "Chrome", regex: /Chrome\/(\d+)/ },
      { name: "Firefox", regex: /Firefox\/(\d+)/ },
      { name: "Safari", regex: /Version\/(\d+).+Safari/ }
    ];
    for (const pattern of patterns) {
      const match = ua.match(pattern.regex);
      if (match) {
        return `${pattern.name}-${match[1]}`;
      }
    }
    return "Unknown";
  }

  /**
   * @param {string} key
   * @returns {"supported" | "unsupported" | "unknown"}
   */
  #getDirectPlaybackHint(key) {
    const entry = this.#directPlaybackHints.get(key);
    if (!entry || typeof entry !== "object") {
      return "unknown";
    }
    if (Date.now() - entry.updatedAt > DIRECT_PLAYBACK_HINT_TTL_MS) {
      this.#directPlaybackHints.delete(key);
      this.#persistDirectPlaybackHints();
      return "unknown";
    }
    return entry.directSupported === true ? "supported" : "unsupported";
  }

  /**
   * @param {string} key
   * @param {boolean} supported
   */
  #setDirectPlaybackHint(key, supported) {
    this.#directPlaybackHints.set(key, {
      directSupported: supported,
      updatedAt: Date.now()
    });
    this.#trimDirectPlaybackHints();
    this.#persistDirectPlaybackHints();
  }

  #trimDirectPlaybackHints() {
    if (this.#directPlaybackHints.size <= DIRECT_PLAYBACK_HINTS_MAX_ENTRIES) {
      return;
    }
    const sortedEntries = Array.from(this.#directPlaybackHints.entries()).sort(
      (left, right) => left[1].updatedAt - right[1].updatedAt
    );
    const removeCount = sortedEntries.length - DIRECT_PLAYBACK_HINTS_MAX_ENTRIES;
    for (let index = 0; index < removeCount; index += 1) {
      this.#directPlaybackHints.delete(sortedEntries[index][0]);
    }
  }

  #loadDirectPlaybackHints() {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
    try {
      const raw = window.localStorage.getItem(DIRECT_PLAYBACK_HINTS_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const payload = JSON.parse(raw);
      if (!Array.isArray(payload)) {
        return;
      }
      for (const item of payload) {
        if (!Array.isArray(item) || item.length !== 2) {
          continue;
        }
        const [key, value] = item;
        if (typeof key !== "string" || !value || typeof value !== "object") {
          continue;
        }
        const updatedAt = Number(value.updatedAt);
        const directSupported = value.directSupported === true;
        if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
          continue;
        }
        this.#directPlaybackHints.set(key, { updatedAt, directSupported });
      }
      this.#trimDirectPlaybackHints();
    } catch (error) {
      // The cache is best-effort, but a cache that quietly never loads means
      // every open re-probes the codecs and nothing says why.
      console.debug(
        `[torrent-tv][codec] stored playback hints could not be read (${error instanceof Error ? error.message : String(error)}); starting from none`
      );
    }
  }

  #persistDirectPlaybackHints() {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
    try {
      const payload = JSON.stringify(Array.from(this.#directPlaybackHints.entries()));
      window.localStorage.setItem(DIRECT_PLAYBACK_HINTS_STORAGE_KEY, payload);
    } catch (error) {
      // Usually a full or refused storage (private windows refuse writes).
      // Worth a word: the effect is that codec probing never gets cheaper, and
      // that is otherwise invisible.
      console.debug(
        `[torrent-tv][codec] playback hints could not be stored (${error instanceof Error ? error.message : String(error)})`
      );
    }
  }

  /**
   * @param {string} directUrl
   * @param {{ statusMessage: string, progress: number }} options
   * @returns {Promise<boolean>}
   */
  async #tryPlayDirectUrl(directUrl, options) {
    this.setStatus(options.statusMessage);
    this.setProgress(options.progress);
    await this.#session.playFromUrl(this.#videoElement, directUrl);
    try {
      await this.#ensureVideoReady();
      return true;
    } catch (error) {
      if (!this.#isUnsupportedError(error)) {
        throw error;
      }
      return false;
    }
  }

  /** @param {number} fileIndex */
  #startSubtitlesForVideo(fileIndex) {
    void this.#subtitlePlayback.loadForVideo(fileIndex).catch((e) => {
      if (!this.#isAbortError(e)) {
        console.warn("[torrent-tv][subtitles] load failed:", e);
      }
    });
  }

  /**
   * @param {number} fileIndex
   */
  #setActiveMediaFile(fileIndex) {
    this.#activeFileIndex = Number.isInteger(fileIndex) ? fileIndex : -1;
    this.#openingFileIndex = null;
    document.dispatchEvent(
      new CustomEvent(PLAYER_EVENTS.SET_ACTIVE_MEDIA_FILE, {
        detail: { fileIndex }
      })
    );
    // A shareable link for what's playing (the address bar cleaned the source
    // param on load). Same source for every file of the torrent.
    document.dispatchEvent(
      new CustomEvent(PLAYER_EVENTS.SET_SHARE_LINK, {
        detail: { url: this.#buildShareUrl() }
      })
    );
    this.#reflectRecordInUrl();
    this.#publishAudioTracks();
  }

  /**
   * Move the player to the quality rung the proxy asked for, having first asked
   * the proxy to make one ready. The quality is always the automatic choice
   * (roadmap item 98): nothing on the page picks a rung, so every move here is
   * the proxy's.
   *
   * The rung does not exist until it is asked for: its encoder starts from
   * nothing and its first segment takes as long as it takes — 15 988 ms
   * measured on 2026-08-11. Switching first and waiting second puts that wait
   * on screen as a spinner. Asking first puts it behind the picture that is
   * still playing, and the switch happens when there is something to switch to.
   *
   * READY is the proxy's answer that the piece the player will ask for next is
   * closed on the rung — not that the whole film has been made.
   *
   * THEN THE CUSHION, for a move that is not urgent — a step up, or a move to a
   * smaller picture on screen: the switch waits until the viewer holds the
   * cushion this file needs (`minimumBufferSeconds`, stated by the proxy). A
   * move asked for because the viewer's buffer would run dry before anything
   * else could arrive is made at once: a cushion that is shrinking would be
   * waited for for ever. A file for which the proxy has stated no cushion yet
   * has none to wait for.
   *
   * @param {{ index: number, height: number }} level
   * @param {number} height
   * @param {{ urgent?: boolean }} [options]
   * @returns {Promise<void>}
   */
  async #switchQualityLevel(level, height, { urgent = false } = {}) {
    // Which pick this is. Warming waits on the proxy, so two picks in quick
    // succession are two waits that finish in whatever order the rungs happen
    // to be ready — and without this the one that finishes LAST wins, which is
    // not the one asked for last. A later request, or the proxy withdrawing
    // this one, supersedes it (`#followQualityRequest`).
    const pick = (this.#qualityPickSeq ?? 0) + 1;
    this.#qualityPickSeq = pick;
    this.#qualityPreparation?.abort();
    const preparation = new AbortController();
    this.#qualityPreparation = preparation;
    try {
    // Prepare at the PLAYHEAD, and let the run cover everything after it.
    //
    // Read from the vendored hls.js rather than guessed: `nextLevelSwitch()`
    // flushes from the start of the fragment FOLLOWING the one holding
    // `currentTime + fetchdelay`, where `fetchdelay` is
    // `fragCurrent.duration × nextLevel.maxBitrate / (1000 × fragLastKbps) + 1`
    // while playing and 0 while paused. So the landing point is the playhead
    // plus between zero and one fragment — never the end of the buffer, which
    // is what this used to send. Measured 2026-08-14: warmed at 2398.6 s, the
    // player asked for 2371.5 s with the playhead at 2370.2 s, and the proxy
    // read the 27 s difference as a seek BACKWARDS, killed the run and threw
    // away the 21.8 s that thirty seconds of warming had produced.
    //
    // `fragLastKbps` is hls.js's own internal measurement, so predicting the
    // exact landing point from here is fragile. Starting at the playhead makes
    // that unnecessary: wherever it lands is inside the run already going, and
    // the proxy answers "already within the running encode". The price is the
    // encoder producing a few segments the player already holds, which is
    // affordable exactly when the rung runs faster than realtime — which is
    // what roadmap item 1 now establishes before the rung is offered at all.
    const position = this.#videoElement instanceof HTMLVideoElement
      ? Math.max(0, this.#videoElement.currentTime)
      : 0;
    this.#logEvt(
      `quality: preparing ${height}p at the playhead ${Math.round(position)}s ` +
      `(buffered to ${Math.round(this.#videoElement instanceof HTMLVideoElement ? bufferedEndSeconds(this.#videoElement) : 0)}s) ` +
      `before switching`
    );
    const { ready, unavailable } = await this.#session.prepareQualityVariant(height, position, preparation.signal);
    if (preparation.signal.aborted || this.#qualityPickSeq !== pick) {
      this.#logEvt(`quality: ${height}p was superseded; not switching`);
      return;
    }
    // Nothing at that height suits this viewer's link. The viewer keeps what is
    // playing; nobody is waiting on a move they did not ask for, so it is said
    // in the log only.
    if (unavailable) {
      this.#logEvt(
        `quality: ${height}p is not available for this link — ${unavailable.reason} ` +
        `${JSON.stringify(unavailable.figures)}`
      );
      return;
    }
    // Not ready means not ready. Switching regardless throws away everything
    // buffered — the player flushes on a level change — and puts nothing in its
    // place: measured 2026-08-14, a 64 s cushion went to 1.1 s, the picture
    // stopped for thirteen seconds, and the rung's first segment then took
    // another 21.6 s because the encoder had been restarted by the switch
    // itself. The viewer keeps what they were watching; the proxy asks again
    // if it still wants the move.
    if (!ready) {
      this.#logEvt(`quality: ${height}p is not ready; staying on the current one rather than emptying the buffer`);
      return;
    }
    if (!urgent && !(await this.#cushionHeld(pick, height, preparation.signal))) {
      this.#logEvt(`quality: ${height}p was superseded while the cushion was filling; not switching`);
      return;
    }
    this.#logEvt(`quality: ${height}p is ready, switching${urgent ? " at once — the buffer would run dry first" : ""}`);
    if (!this.#hlsPlayer.switchLevel(level.index)) {
      this.#logEvt(`quality: the player refused the switch to ${height}p`);
    }
    } finally {
      if (this.#qualityPreparation === preparation) this.#qualityPreparation = null;
    }
  }

  /**
   * Wait until the viewer holds the cushion this file needs, or until the pick
   * is superseded.
   *
   * Driven by the element's own events — `progress` as data arrives,
   * `timeupdate` as the picture moves, `emptied` when the source goes — and
   * nothing polls.
   *
   * @param {number} pick
   * @param {number} height
   * @returns {Promise<boolean>} True when the cushion is held; false when the
   *   pick was superseded or the element let go of its source.
   */
  #cushionHeld(pick, height, signal) {
    if (signal.aborted) return Promise.resolve(false);
    const video = this.#videoElement;
    if (!(video instanceof HTMLVideoElement)) {
      return Promise.resolve(false);
    }
    const holds = () => {
      const needed = this.#minimumBufferSeconds;
      return !(Number.isFinite(needed) && needed > 0) || bufferedAheadSeconds(video) >= needed;
    };
    if (holds()) {
      return Promise.resolve(true);
    }
    this.#logEvt(
      `quality: ${height}p is ready; switching once ${this.#minimumBufferSeconds}s are held ` +
      `(holding ${bufferedAheadSeconds(video).toFixed(1)}s)`
    );
    return new Promise((resolve) => {
      let settled = false;
      const finish = (held) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", gone);
        video.removeEventListener("progress", check);
        video.removeEventListener("timeupdate", check);
        video.removeEventListener("emptied", gone);
        resolve(held);
      };
      const check = () => {
        if (this.#qualityPickSeq !== pick) {
          finish(false);
        } else if (holds()) {
          finish(true);
        }
      };
      const gone = () => finish(false);
      video.addEventListener("progress", check);
      video.addEventListener("timeupdate", check);
      video.addEventListener("emptied", gone);
      signal.addEventListener("abort", gone, { once: true });
      if (signal.aborted) gone(); else check();
    });
  }

  /**
   * The viewer picked another audio track: replay the active file through
   * the remux/transcode path with `-map 0:a:N`, preserving the position.
   *
   * @param {CustomEvent} event
   */
  #onSelectAudioTrack = async (event) => {
    // Whether the proxy prepared the track at the playhead. It answers only
    // once the piece there exists — there is no "not ready" answer — so the
    // one way this stays false is that there was no live session to prepare it
    // on, and then the track is prepared by rebuilding the session with it.
    let prepared = true;
    // What this page told the proxy about the track it moves to, kept for the
    // moment the switch is made: it is what a reconnect has to say again.
    /** @type {boolean | null} */
    let statedNeed = null;
    const detail = event instanceof CustomEvent ? event.detail : null;
    const trackIndex = Number(detail?.trackIndex);
    // Read before anything is claimed. An event that names no track is not a
    // pick, and treating it as one would cancel a wait the viewer is in.
    if (!Number.isInteger(trackIndex) || trackIndex < 0) {
      return;
    }
    // The viewer's LAST word wins. Preparing a track takes seconds, so two
    // quick picks would otherwise be applied in the order the proxy happened to
    // finish them — and the earlier one, landing last, would move the sound
    // away from what was asked for. Only one track plays, so a later pick
    // simply cancels the earlier: the proxy stops the abandoned track's encoder
    // when it is asked for the new one, and this side stops waiting for it.
    const pick = (this.#audioPickSeq ?? 0) + 1;
    this.#audioPickSeq = pick;
    this.#qualityPreparation?.abort();
    this.#audioPreparation?.abort();
    const preparation = new AbortController();
    const epoch = this.#playbackEpoch;
    this.#audioPreparation = preparation;
    // Every way out of this handler releases the hold, including the ones that
    // return before it was ever taken and the ones that throw. A hold nothing
    // releases is a picture the viewer cannot restart, so it is released in one
    // place rather than at each exit — `#releaseAudioHold` decides whether this
    // pick is still the one that owns it.
    try {
      // Choosing the track that is already playing. Ordinarily there is nothing
      // to do — but during a hold it is the viewer changing their mind back,
      // and it is what takes the picture out of the hold the earlier pick put
      // it in.
      if (trackIndex === this.#selectedAudioTrackIndex) {
        return;
      }
      if (this.#isProcessing || this.#activeFileIndex < 0 || !this.#session.current) {
        return;
      }
      // Published as its own rendition, the track is the player's to switch: it
      // fetches the other one and swaps it in without touching the picture. The
      // rebuild below is a cold start with the screen empty — measured in tens
      // of seconds on a weak host — and it is what every stream without
      // renditions still gets.
      if (this.#hlsPlayer.audioTracks().length > 1) {
        // The picture is HELD for this wait, and that is the point. Letting it
        // run on means the viewer keeps watching in a language they do not
        // understand, and then has to seek back over the part they could not
        // follow — asked for 2026-08-31, in those words. A wait they can see the
        // reason for is a smaller cost than a stretch of film they have to watch
        // twice.
        //
        // The hold is a STATE and not a pause of the element (server 0.24.2).
        // Pausing it here was read as the viewer stopping playback, so the
        // machine went to PAUSED: the overlay came off, the play button worked,
        // and the viewer resumed into the language they had just replaced — then
        // the track landed and the sound changed under them without warning.
        //
        // It is also why the track is made ready BEFORE the player is told to
        // move: changing track discards the audio the player holds, and it
        // cannot show a frame until the new track covers the playhead (measured
        // 2026-08-15, a track switched to before it was ready cost 48 s of
        // spinner).
        const video = this.#videoElement instanceof HTMLVideoElement ? this.#videoElement : null;
        const playhead = video && Number.isFinite(video.currentTime) ? video.currentTime : 0;
        this.#holdForAudio(pick);
        // What this browser needs for the track it is moving TO. The proxy
        // decides from it how the track is produced, by the rule it uses when a
        // file is opened, so a track the browser cannot play is re-encoded and
        // a track it can play is copied unless nothing states its rate.
        const needsTranscode = await this.#trackNeedsTranscode(trackIndex);
        statedNeed = needsTranscode;
        const readyAt = Date.now();
        const answer = await this.#session.prepareAudioTrack(trackIndex, playhead, needsTranscode, preparation.signal);
        if (this.#audioPickSeq !== pick) return;
        prepared = answer !== false;
        this.#logEvt(
          `audio track ${trackIndex} ${answer} after ${Date.now() - readyAt}ms at ${playhead.toFixed(1)}s`
        );
      }
      // Nothing was prepared: there was no live session to prepare the track
      // on. Switching in place would discard the audio the player holds and
      // leave the picture with nothing to play, and putting the menu back would
      // ignore the viewer's choice — so the session is rebuilt with the track
      // below (torrent-tv/meta#68).
      if (!prepared) {
        this.#logEvt(`audio track ${trackIndex}: no live session to prepare it on; rebuilding the session with it`);
      }
      if (prepared && this.#hlsPlayer.audioTracks().length > 1 && this.#hlsPlayer.switchAudioTrack(trackIndex)) {
        // What the PLAYER settled on, not what was asked for. Assigning a track
        // is a request: hls.js applies it asynchronously and can decline it or
        // choose another itself (a level switch changes group), and nothing
        // rebuilds the session here — so a menu written from the request would
        // keep asserting a track that is not playing, with nothing to correct
        // it.
        const applied = this.#hlsPlayer.currentAudioTrack();
        this.#selectedAudioTrackIndex = applied >= 0 ? applied : trackIndex;
        // A track the player settled on by itself was not the one stated.
        this.#session.noteSoundtrackStated(
          this.#selectedAudioTrackIndex,
          applied >= 0 && applied !== trackIndex ? null : statedNeed
        );
        this.#rememberAudioChoice();
        this.#logEvt(
          `audio track ${trackIndex} switched in place, without rebuilding the session` +
          (applied >= 0 && applied !== trackIndex ? ` (the player settled on ${applied})` : "")
        );
        // The picture starts again from exactly where it was held, in the new
        // language, and it is the player that starts it — releasing the hold
        // leaves the machine in the state the viewer's own last decision names.
        // Nothing of the film is skipped and nothing has to be watched twice.
        this.#publishAudioTracks();
        return;
      }
      // The session is about to be rebuilt instead, which starts at a position
      // of its own and shows the waiting view. The hold belongs to a picture
      // that is going away, so it is released before the rebuild is asked for:
      // afterwards the machine is in OPENING, where releasing it means nothing.
      this.#releaseAudioHold(pick);
      const fileIndex = this.#activeFileIndex;
      const position =
        this.#videoElement instanceof HTMLVideoElement && Number.isFinite(this.#videoElement.currentTime)
          ? this.#videoElement.currentTime
          : 0;
      this.#selectedAudioTrackIndex = trackIndex;
      this.#rememberAudioChoice();
      document.dispatchEvent(
        new CustomEvent(LOADING_EVENTS.SHOW, {
          detail: { status: Loading.MESSAGES.switchingAudio, progress: 0 }
        })
      );
      await this.#runPlaybackTask(async () => {
        this.#pendingCurrentTime = position > 0 ? position : null;
        await this.#switchToVideoFile(fileIndex);
      });
    } catch (error) {
      this.#logEvt(`audio preparation ended: ${error?.message ?? error}`);
      if (error?.name !== "AbortError" && this.#audioPickSeq === pick) {
        this.#failWith(epoch, error);
      }
    } finally {
      if (this.#audioPreparation === preparation) this.#audioPreparation = null;
      this.#releaseAudioHold(pick);
    }
  };

  /**
   * The proxy connection died after being established (not closed by us).
   * With a file playing, capture everything recovery needs BEFORE anything
   * clears the session, then start the automatic reconnect loop. While a
   * loading flow is in flight its own failure path reports instead.
   *
   * @returns {void}
   */
  #onTransportLost() {
    this.#logEvt("transport lost (data channel closed/failed)");
    // A second connection being raised beside this one is the ladder's to
    // replace now.
    if (this.#rotation) {
      this.#rotation.cancelled = true;
    }
    if (this.#isProcessing) {
      return;
    }
    const current = this.#session.current;
    if (!current || this.#activeFileIndex < 0) {
      return;
    }
    // A fresh loss invalidates any pending "playback is stable" reset, so a
    // quick relapse still counts toward the cycle guard.
    if (this.#stableTimer !== null) {
      clearTimeout(this.#stableTimer);
      this.#stableTimer = null;
    }
    const position =
      this.#videoElement instanceof HTMLVideoElement && Number.isFinite(this.#videoElement.currentTime)
        ? this.#videoElement.currentTime
        : 0;
    const resume = {
      fileIndex: this.#activeFileIndex,
      positionSeconds: position,
      sessionCurrent: current
    };
    this.#resumeState = resume;
    void this.#runPlaybackTask(async () => {
      this.#isProcessing = true;
      try { await this.#autoReconnect(resume); }
      finally { this.#isProcessing = false; }
    }, { preservePlayer: true });
  }

  /**
   * Automatic recovery ladder (see the auto-reconnect OpenSpec change):
   * - Level 1 (seamless): keep the player running from its buffer, rebuild
   *   the connection to the SAME proxy, swap the transport underneath and
   *   resume fetching — no visible interruption.
   * - Level 2 (rebuild): re-select (possibly a different proxy) and replay
   *   the file-switch flow with a server-side seek to the captured position.
   * - Level 3 (manual): the error screen with Retry, only after all attempts
   *   fail. #resumeState stays set so manual Retry still works.
   *
   * Never throws (called from an event callback); cancellation ends it
   * silently. Every attempt is logged on the [torrent-tv] channel.
   *
   * @param {{ fileIndex: number, positionSeconds: number, sessionCurrent: object }} resume
   * @returns {Promise<void>}
   */
  async #autoReconnect(resume) {
    this.#reconnectCycles += 1;
    if (this.#reconnectCycles > RECONNECT_MAX_CYCLES) {
      console.debug(`[torrent-tv] reconnect: giving up after ${RECONNECT_MAX_CYCLES} cycles`);
      this.#dispatchConnectionLost();
      return;
    }

    // Freeze fetching but keep the player and its buffer alive (Level 1). Keep
    // the transport OBJECT (swap target); only drop the dead proxy.
    try {
      this.#hlsPlayer.stopLoad();
    } catch (error) {
      // Fetching was meant to stop here while the player keeps its buffer. If
      // it did not, the player goes on requesting from a proxy that is gone —
      // which reads to the viewer as a stall with no cause.
      console.warn(
        `[torrent-tv] could not stop loading after the transport was lost: ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
    }
    try {
      this.#proxy?.close();
    } catch (error) {
      // A connection that will not close is left holding its channels; the
      // replacement then competes with it. Named, because it decides which of
      // two connections the next request goes to.
      console.warn(
        `[torrent-tv] the lost transport would not close: ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
    }
    this.#proxy = null;

    // Seamless is only possible over a live hls.js WebRTC transport with a
    // known proxy to dial back.
    let seamlessPossible =
      !!this.#lastProxyDescriptor &&
      !!this.#transport &&
      !this.#transport.isHttp &&
      this.#hlsPlayer.isActive();
    let overlayShown = false;
    const showOverlay = () => {
      if (!overlayShown) {
        document.dispatchEvent(
          new CustomEvent(LOADING_EVENTS.SHOW, {
            detail: { status: Loading.MESSAGES.reconnecting, progress: 0 }
          })
        );
        overlayShown = true;
      }
    };

    for (let attempt = 1; attempt <= RECONNECT_TOTAL_ATTEMPTS; attempt += 1) {
      if (this.#cancelRequested) {
        this.#logEvt(`reconnect abandoned before attempt ${attempt}: the viewer cancelled`);
        return;
      }
      if (attempt === 2) {
        await this.#sleep(RECONNECT_BACKOFF_MS);
      }
      if (typeof navigator === "object" && navigator.onLine === false) {
        if (overlayShown) {
          this.setStatus(Loading.MESSAGES.waitingForNetwork);
        }
        await this.#waitForOnline();
        if (this.#cancelRequested) {
          this.#logEvt(`reconnect abandoned while waiting for the network: the viewer cancelled (attempt ${attempt})`);
          return;
        }
      }
      const sameProxy = seamlessPossible && attempt <= RECONNECT_SAME_PROXY_ATTEMPTS;
      console.debug(
        `[torrent-tv] reconnect attempt ${attempt}/${RECONNECT_TOTAL_ATTEMPTS} ` +
          (sameProxy ? "(same proxy, seamless)" : "(reselect, rebuild)")
      );
      try {
        if (sameProxy) {
          const proxy = await this.#proxySelector.reconnectTo(this.#lastProxyDescriptor, {
            connectTimeoutMs: RECONNECT_CONNECT_TIMEOUT_MS,
            signal: this.#session.abortController.signal
          });
          if (this.#cancelRequested) {
            proxy.close();
            this.#throwIfCancelled();
          }
          this.#adoptProxy(proxy); // swaps the inner proxy under the live player
          // Liveness + session-exists probe over the NEW channel (routes
          // through the swapped transport). Non-null → the warm transcode
          // session is still there; resume fetching seamlessly.
          const progress = await this.#session.fetchActiveTranscodeProgress();
          this.#throwIfCancelled();
          if (progress) {
            // The proxy let go of this viewer when the old connection closed,
            // soundtrack choice included, and a viewer it does not know is sent
            // the sound as it is. Said again before the player asks for a single
            // segment; a choice that was not kept is a failed attempt, because
            // resuming would load a different soundtrack under the same address.
            const sound = await this.#session.restateSoundtrack(resume.positionSeconds, this.#transport);
            if (sound === "failed") {
              throw new Error("the soundtrack could not be restated on the new connection");
            }
            this.#logEvt(`reconnect: soundtrack ${sound}`);
            this.#hlsPlayer.startLoad();
            // The old channel took the subtitle subscription with it when it
            // closed, and nothing on this path would ever ask again.
            this.#subtitlePlayback.onTransportReconnected();
            console.debug("[torrent-tv] reconnect: seamless resume");
            this.#armStabilityTimer();
            return;
          }
          // Channel is good but the transcode session expired — rebuild
          // playback on this (already connected) proxy; no need to re-select.
          console.debug("[torrent-tv] reconnect: transcode session gone, rebuilding on the new channel");
          showOverlay();
          await this.#resumePlayback(resume);
          this.#armStabilityTimer();
          return;
        }

        // Level 2 rebuild: drop the dead transport and acquire a fresh one
        // (standard two-stage flow — may walk the permission UI), then replay
        // the file with a server-side seek.
        showOverlay();
        this.#transport = null;
        await this.#acquireTransport();
        await this.#resumePlayback(resume);
        this.#armStabilityTimer();
        return;
      } catch (error) {
        if (this.#isAbortError(error) || this.#cancelRequested) {
          // A reconnect that stops here leaves the viewer looking at whatever
          // was on screen, so it must be findable afterwards: the two reasons
          // need opposite readings — the viewer gave up, or the attempt was
          // superseded by a newer one.
          // What is KNOWN, not a verdict about why. An abort here has several
          // sources — the viewer, a newer attempt, the transport's own signal —
          // and naming one of them is how a log sends the next reader after a
          // race that never happened.
          this.#logEvt(
            `reconnect abandoned: cancelled=${this.#cancelRequested} ` +
            `error=${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`
          );
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.debug(`[torrent-tv] reconnect attempt ${attempt} failed: ${message}`);
        if (error?.canRetry === false) throw error;
      }
    }

    this.#dispatchConnectionLost();
  }

  /**
   * This connection stopped delivering while it still calls itself open.
   *
   * The connection is NOT given up here. A silence can be the association —
   * the usrsctp state of 2026-09-13, cured only by a new one — or the proxy's
   * own thread being busy, 21 s on 2026-10-01, after which the same connection
   * delivered again. From here the two cannot be told apart, so a second
   * connection is raised beside the first and adopted only once it has proved
   * it carries this viewer's session; if the first delivers again before that,
   * the second is closed.
   *
   * @param {import("../../domain/webrtc-proxy.js").WebRtcProxy} proxy
   * @returns {void}
   */
  #onDeliveryStalled(proxy) {
    if (proxy !== this.#proxy || this.#rotation) {
      return;
    }
    if (this.#isProcessing || !this.#session.current || this.#activeFileIndex < 0) {
      // A loading flow has its own failure path; the connection's last resort
      // still declares it lost if the silence lasts.
      this.#logEvt("delivery stalled during loading — left to the loading flow");
      return;
    }
    if (!this.#lastProxyDescriptor || !this.#transport || this.#transport.isHttp) {
      return;
    }
    void this.#rotateTransport(proxy);
  }

  /**
   * The connection delivered again: a second connection still being raised for
   * it is no longer needed.
   *
   * @param {import("../../domain/webrtc-proxy.js").WebRtcProxy} proxy
   * @returns {void}
   */
  #onDeliveryResumed(proxy) {
    if (this.#rotation?.from === proxy && !this.#rotation.cancelled) {
      this.#rotation.cancelled = true;
      this.#logEvt(
        `delivery resumed on the old connection after ${Math.round(performance.now() - this.#rotation.startedAt)}ms — ` +
          "the second connection is not adopted"
      );
    }
  }

  /**
   * Whether this attempt to replace a silent connection still has a purpose.
   *
   * It ends when the old connection delivers again, when the ladder took over
   * (the old one was declared lost), when the viewer stopped or switched
   * playback — any of which replaces or clears `#proxy` — and when another
   * attempt took its place.
   *
   * @param {{ from: object, cancelled: boolean }} rotation
   * @returns {boolean}
   */
  #rotationLive(rotation) {
    return this.#rotation === rotation && !rotation.cancelled && this.#proxy === rotation.from && !this.#cancelRequested;
  }

  /**
   * Raise a second connection to the same proxy beside a silent one, prove it,
   * and only then move to it.
   *
   * Proof, in order, all of it over the NEW connection before the player is
   * given it: this viewer is named on it; the session on screen answers its
   * progress there; the soundtrack this page stated is recorded again. Without
   * the last, the first segment of sound asked for there is answered for a
   * viewer the proxy does not know — as a copy — and on 2026-09-28 that ended
   * the audio stream for good.
   *
   * Attempts repeat while the silence lasts, one at a time, the ladder's own
   * pause apart. They stop when the old connection delivers again, when the
   * viewer leaves, or when the old connection is declared lost after a whole
   * request bound of silence — then the ladder rebuilds as before.
   *
   * @param {import("../../domain/webrtc-proxy.js").WebRtcProxy} from
   * @returns {Promise<void>}
   */
  async #rotateTransport(from) {
    const rotation = { from, cancelled: false, startedAt: performance.now() };
    this.#rotation = rotation;
    this.#logEvt("delivery stalled — raising a second connection beside the first");
    try {
      for (let attempt = 1; this.#rotationLive(rotation); attempt += 1) {
        if (attempt > 1) {
          await this.#sleep(RECONNECT_BACKOFF_MS);
          if (!this.#rotationLive(rotation)) {
            break;
          }
        }
        /** @type {import("../../domain/webrtc-proxy.js").WebRtcProxy | null} */
        let trial = null;
        try {
          trial = await this.#proxySelector.reconnectTo(this.#lastProxyDescriptor, {
            connectTimeoutMs: RECONNECT_CONNECT_TIMEOUT_MS
          });
          if (!this.#rotationLive(rotation)) {
            break;
          }
          trial.identifyViewer(this.#session.consumerId);
          const via = ProxyTransport.fromWebRtc(trial);
          const progress = await this.#session.fetchActiveTranscodeProgressVia(via);
          if (!progress) {
            throw new Error("the session did not answer on the second connection");
          }
          const position =
            this.#videoElement instanceof HTMLVideoElement && Number.isFinite(this.#videoElement.currentTime)
              ? this.#videoElement.currentTime
              : 0;
          const sound = await this.#session.restateSoundtrack(position, via);
          if (sound === "failed") {
            throw new Error("the soundtrack could not be restated on the second connection");
          }
          if (!this.#rotationLive(rotation)) {
            break;
          }
          this.#adoptProxy(trial);
          trial = null;
          // The old connection took the subtitle subscription with it.
          this.#subtitlePlayback.onTransportReconnected();
          this.#logEvt(
            `moved to a second connection ${Math.round(performance.now() - rotation.startedAt)}ms after delivery stopped ` +
              `(attempt ${attempt}, soundtrack ${sound})`
          );
          return;
        } catch (error) {
          if (this.#isAbortError(error)) {
            return;
          }
          this.#logEvt(
            `second connection attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`
          );
        } finally {
          // Not adopted: closing it lets the proxy forget it. The viewer stays
          // theirs on the old connection, which still carries them.
          trial?.close();
        }
      }
      this.#logEvt(
        rotation.cancelled
          ? "second connection not needed any more"
          : "second connection abandoned: playback moved on"
      );
    } finally {
      if (this.#rotation === rotation) {
        this.#rotation = null;
      }
    }
  }

  /**
   * Restore the session snapshot and replay the file-switch flow, seeking back
   * to the captured position (the seek rides the server-side seek machinery).
   * Shared by the automatic rebuild and the manual Retry so the two paths
   * cannot drift. Rejects on failure so the caller decides how to surface it.
   *
   * @param {{ fileIndex: number, positionSeconds: number, sessionCurrent: object }} resume
   * @returns {Promise<void>}
   */
  async #resumePlayback(resume) {
    this.#cancelRequested = false;
    this.#session.current = resume.sessionCurrent;
    // Announced BEFORE the load, so it travels the same path a resume from the
    // address does: hls.js begins buffering there and the proxy is told to
    // encode from there. Setting `currentTime` after the reveal instead meant
    // loading the film from the beginning, showing it, and only then seeking —
    // a second wait for something the viewer had already waited through.
    this.#pendingCurrentTime = resume.positionSeconds > 1 ? resume.positionSeconds : null;
    await this.#switchToVideoFile(resume.fileIndex);
  }

  /**
   * Show the recoverable connection-lost error screen (Level 3 fallback).
   * #resumeState is left intact so the manual Retry can still resume.
   *
   * @returns {void}
   */
  #dispatchConnectionLost() {
    document.dispatchEvent(
      new CustomEvent(LOADING_EVENTS.PLAYBACK_FAILED, {
        detail: { description: Loading.MESSAGES.connectionLost, canRetry: true }
      })
    );
  }

  /**
   * Arm the "playback has stabilised" timer: once playback survives
   * {@link RECONNECT_STABLE_RESET_MS}, reset the consecutive-cycle counter so a
   * later, unrelated loss gets the full set of attempts again.
   *
   * @returns {void}
   */
  #armStabilityTimer() {
    if (this.#stableTimer !== null) {
      clearTimeout(this.#stableTimer);
    }
    this.#stableTimer = setTimeout(() => {
      this.#reconnectCycles = 0;
      this.#stableTimer = null;
    }, RECONNECT_STABLE_RESET_MS);
  }

  /**
   * @param {number} ms
   * @returns {Promise<void>}
   */
  #sleep(ms) {
    const signal = this.#session.abortController.signal;
    return new Promise((resolve, reject) => {
      const finished = () => { signal.removeEventListener("abort", aborted); resolve(); };
      const timer = setTimeout(finished, ms);
      const aborted = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        reject(new DOMException("Playback preparation was cancelled.", "AbortError"));
      };
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
    });
  }

  /**
   * Resolve when connectivity returns; cancellation rejects the pending wait.
   *
   * @returns {Promise<void>}
   */
  #waitForOnline() {
    const signal = this.#session.abortController.signal;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error) => {
        if (done) return;
        done = true;
        window.removeEventListener("online", online);
        signal.removeEventListener("abort", aborted);
        if (error) reject(error);
        else resolve();
      };
      const online = () => finish();
      const aborted = () => finish(new DOMException("Playback preparation was cancelled.", "AbortError"));
      window.addEventListener("online", online);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted || this.#cancelRequested) aborted();
      else if (typeof navigator !== "object" || navigator.onLine !== false) online();
    });
  }

  /**
   * Retry after a lost connection (manual, from the error screen). Delegates
   * to the shared resume path; the proxy is re-selected by the normal flow.
   */
  #onRetryPlayback = () => {
    const resume = this.#resumeState;
    this.#resumeState = null;
    if (!resume || !resume.sessionCurrent) {
      return;
    }
    document.dispatchEvent(
      new CustomEvent(LOADING_EVENTS.SHOW, {
        detail: { status: Loading.MESSAGES.reconnecting, progress: 0 }
      })
    );
    // A manual retry starts a fresh connection — do not reuse the dead one.
    void this.#runPlaybackTask(async () => {
      this.#transport = null;
      await this.#resumePlayback(resume);
    });
  };

  /**
   * @param {number} fileIndex
   * @param {{
   *   transport?: import("../../domain/proxy-transport.js").ProxyTransport,
   *   sourceKey?: string,
   *   transcodeVideo?: boolean,
   *   transcodeAudio?: boolean,
   *   statusMessage?: string
   * }} [options]
   * @returns {Promise<void>}
   */
  async #playWithProxyTranscode(fileIndex, options = {}) {
    this.#throwIfCancelled();
    // Which tracks this session re-encodes. A copied track has no encoder and
    // therefore no line on the waiting overlay; both copied means no encoder
    // line at all, which is the truth about a direct-play session.
    this.#encodingTracks = {
      video: options.transcodeVideo === true,
      audio: options.transcodeAudio !== false
    };
    let transport = options.transport ?? this.#transport ?? null;
    if (!transport) {
      transport = await this.#acquireTransport();
    }
    if (!transport) {
      throw viewerError(Loading.MESSAGES.noProxyAndNoWebseed);
    }
    this.setStatus(
      typeof options.statusMessage === "string" && options.statusMessage.trim().length > 0
        ? options.statusMessage
        : Loading.MESSAGES.preparingHls
    );
    this.#setPhaseProgress(1, 0); // entering phase 1 (transcode first segment)

    // For WebRTC transport, HLS.js must route all requests through the data
    // channel. The loader takes the transport (not the raw proxy) so a seamless
    // reconnect (transport.replaceWebRtcProxy) redirects segment loads with no
    // player rebuild.
    const hlsLoader = !transport.isHttp
      ? createWebRtcHlsLoader(transport, this.#session.consumerId, () => this.#session.viewGeneration)
      : undefined;
    // What the proxy answers about THIS viewer's output other than bytes. One
    // listener per player: the previous one goes with the player it served.
    this.#stopOutcomes?.();
    this.#stopOutcomes = onProxyOutcome((outcome) => this.#onProxyOutcome(outcome));

    // Resuming: the transcode AND the pre-buffer begin AT the target position,
    // so there is a SINGLE loading at the resume point. Loading from 0 and
    // seeking after the reveal showed a second loading screen.
    //
    // BOTH sides have to be told. hls.js gets it as `startPosition`, and the
    // proxy gets it as the position to encode from — this used to rely on the
    // proxy inferring a seek from a far segment request, which it deliberately
    // no longer does: a request steers nothing, and every restart comes from a
    // position the viewer stated. With only hls.js told, a refresh at 1:17:10
    // asked for segment #446 while the encoder was told to start at #0; the
    // request was held for 45 s, answered 404, and the viewer got "no data
    // arrived from the proxy" (field 2026-08-06).
    // One-shot: consumed here so the post-reveal #applyPendingResume does not
    // seek a second time.
    // Where to begin. The field is filled by whichever path opened this file,
    // and it LOSES A RACE: measured 2026-08-06, the position arrived with an
    // event that fires after the session has been created, so this read saw
    // null, the proxy was told `start=0s`, the film loaded from the beginning,
    // and the position was then applied as an ordinary seek once the player was
    // already on screen — a cold start and an encoder restart for something
    // that was known all along.
    //
    // The address bar does not race. It is written before the load begins, it
    // survives a reload, and it is the state by design, so it is consulted
    // whenever the field is empty.
    const { fromField, fromUrl, position: resumeStartPosition } = this.#resumePositionFor(fileIndex);
    this.#seekPosition.reset(resumeStartPosition ?? 0);
    this.#pendingCurrentTime = null;
    // The address bar's position belongs to the file it was written for, and at
    // this moment it still describes the PREVIOUS one: the address is rewritten
    // from `#activeFileIndex`, which does not become this file until the load
    // finishes. Taking it regardless is why picking the next episode started it
    // wherever the last one had got to — field-reported 2026-08-11, and the
    // further into an episode the viewer was, the further into the next one it
    // began.
    const urlState = readUrlState(location.search);
    const urlIsForThisFile = urlState.fileIndex === fileIndex;
    // Said out loud because the two sides have disagreed about it twice: the
    // position reached hls.js, which duly asked for segment #127, while the
    // proxy was told to start at zero and the viewer waited 45.6 s for a
    // segment nobody was making. Whoever drops it, this line and the proxy's
    // matching `start=` name the moment between them.
    this.#logEvt(
      `starting from ${resumeStartPosition == null ? "the beginning" : `${Math.round(resumeStartPosition)}s`}` +
      ` (field=${fromField == null ? "-" : Math.round(fromField)}` +
      ` url=${fromUrl > 0 ? Math.round(fromUrl) : "-"}` +
      `${urlIsForThisFile ? "" : ` [address bar still describes file ${urlState.fileIndex}, ignored]`})`
    );
    // Held so the `playing` handler can say how far the actual start fell from
    // what was asked for.
    this.#resumeAskedFor = typeof resumeStartPosition === "number" && resumeStartPosition > 0
      ? resumeStartPosition
      : null;

    // The attempt this player belongs to. See `onUnrecoverable` below.
    const playerEpoch = this.#playbackEpoch;
    try {
      await this.#session.streamFileToVideoWithAudioTranscode(fileIndex, this.#videoElement, {
        transport,
        sourceKey: typeof options.sourceKey === "string" ? options.sourceKey : "",
        transcodeVideo: options.transcodeVideo === true,
        transcodeAudio: options.transcodeAudio === true,
        segmentFormat: typeof options.segmentFormat === "string" ? options.segmentFormat : "",
        audioTrackIndex: this.#selectedAudioTrackIndex,
        startPositionSeconds:
          typeof resumeStartPosition === "number" && resumeStartPosition > 0 ? resumeStartPosition : 0,
        getStartPositionSeconds: () => this.#seekPosition.value,
        // Metadata can exist while the element still stands at zero. During
        // opening the viewer's selected destination remains authoritative.
        getPositionSeconds: () => this.#isProcessing
          ? this.#seekPosition.value : this.#videoElement.currentTime,
        // The picture as the viewer sees it, which bounds the height of a
        // re-encoded output (roadmap item 98). Sent with the request that opens
        // the output, and restated in every report the moment it changes.
        visiblePicture: options.transcodeVideo === true ? this.#visiblePictureNow() : null,
        getVisiblePicture: () => this.#visiblePictureNow(),
        // Which rung is playing, so the proxy does not have to infer it from
        // which segments are requested.
        getPlayingHeight: () => this.#playingHeight,
        getBufferLimitSeconds: () => this.#browserBufferLimitSeconds,
        getBufferedRanges: () => this.#hlsPlayer.getBufferedRanges(this.#videoElement),
        playHls: (videoElement, manifestUrl, playOptions = {}) =>
          this.#hlsPlayer.play(videoElement, manifestUrl, {
            ...(hlsLoader ? { loader: hlsLoader } : {}),
            startPosition: this.#seekPosition.value ?? 0,
            getStartPositionSeconds: () => this.#seekPosition.value,
            onLevelSwitched: (height) => this.#onHlsLevelSwitched(height),
            onFragmentFar: (report) => this.#reportFragmentFar(report),
            // The epoch this player belongs to, captured now. Read at report time
            // it would always equal the current one, which is the same as having
            // no guard: a fault from an abandoned attempt's player would then be
            // able to kill the live one.
            onUnrecoverable: (details) => this.#onPlayerUnrecoverable(details, playerEpoch),
            onMediaRebuild: (position) => this.#onMediaRebuild(playerEpoch, position),
            ...playOptions,
            attemptId: playerEpoch
          }),
        onTranscodeProgress: (progress) => this.#renderTranscodeProgress(progress)
      });
    } catch (error) {
      // THIS MACHINE HAS NO PLACE FOR IT NOW (roadmap item 97, step 14). Found
      // when the output is opened, before a frame is shown, so the viewer is
      // moved to a proxy that says it can serve the file instead of being left
      // on one that would stall — the same question the plan's refusal asks.
      if (error?.outcome === "no-capacity") {
        this.#debug("proxy has no place for this video", { fileIndex, why: error.reason, figures: error.figures });
        if (this.#proxy?.proxyId) {
          this.#refusedProxiesForThisOpen.add(this.#proxy.proxyId);
        }
        const elsewhere = (await this.#proxiesThatCanServe(this.#mediaInfoForOffer))
          .filter((id) => !this.#refusedProxiesForThisOpen.has(id));
        if (elsewhere.length > 0) {
          this.#debug("retrying the file on another proxy that can serve it", { fileIndex, candidates: elsewhere });
          this.#restrictProxiesToPool(elsewhere);
          return await this.#playVideoFile(fileIndex);
        }
        throw this.#armRetryableStall(fileIndex, Loading.MESSAGES.proxyCannotKeepUp);
      }
      throw error;
    }
    // Transcoded HLS is always browser-compatible (proxy outputs H.264/AAC), so
    // a codec-decodability check is unnecessary. More importantly, waiting for a
    // presented frame here deadlocks on iOS because the player view is still
    // occluded by the modal loading dialog (see #ensureVideoReady).
    //
    // Keep the status moving while the FIRST segment is produced and buffered:
    // waitForHlsPlaylist returns immediately for the synthetic VOD playlist, so
    // its progress polling stops here — poll the session directly until the
    // player is ready.
    // Phase 1 — first segment production: the progress poll writes the loading
    // status ("Preparing first segment… / ETA").
    const preparation = new AbortController();
    const stopProgressPoll = this.#startTranscodeProgressPoll(error => preparation.abort(error));
    try {
      await this.#ensureVideoReady({ requireDecodedFrame: false,
        signal: AbortSignal.any([this.#session.abortController.signal, preparation.signal]) });
    } finally {
      // Stop the poll BEFORE pre-buffering, so only #waitForPrebuffer writes the
      // status during the cushion fill. Otherwise both write it (poll every ~1 s,
      // pre-buffer every 250 ms) and the text flickers between "ETA…" and
      // "Buffering…".
      stopProgressPoll();
    }
    // Phase 2 — pre-buffer: don't reveal the player until a cushion of video is
    // buffered ahead, so a transient production/delivery dip right after start
    // doesn't immediately stall. The video stays paused (player hidden) so hls.js
    // fills the buffer without draining it; #waitForPrebuffer is the only status
    // writer here.
    await this.#waitForPrebuffer(this.#videoElement, playerEpoch);
  }

  /**
   * Wait until the proxy's trajectory forecast says playback can reach the end
   * without exhausting the measured client buffer.
   *
   * @param {HTMLVideoElement} videoElement
   * @returns {Promise<void>}
   */
  async #waitForPrebuffer(videoElement, epoch = this.#playbackEpoch) {
    if (!(videoElement instanceof HTMLVideoElement)) {
      return;
    }
    // Cold-start: prebuffer entry ≈ "prepare done" (t3). t4 is a successful
    // return below.
    if (this.#coldStart) {
      this.#coldStart.t3 = performance.now();
    }
    // The player is hidden during pre-buffer, so the video MUST stay paused.
    // If it plays here it drains the buffer, so `ahead` never reaches the
    // target — the loading screen sticks while audio is heard. The player starts
    // playback when the machine reaches ADVANCING.
    if (!videoElement.paused) {
      this.#logEvt("player.pause reason=prebuffer");
      // Ours, not the viewer's — see domain/playback-intent.js. Read as the
      // viewer's, this single line ended every cold open stopped on its first
      // frame.
      pauseWithoutIntent(videoElement);
    }
    let loggedReason = "";
    // For the wedge below: what the buffer last read, and when it last grew.
    let lastAhead = -1;
    let lastGrowthAt = Date.now();
    let cachedProgress = null;
    let lastProgressFetchAt = 0;
    // When the request behind `cachedProgress` was SENT — what decides whether
    // that forecast could have weighed the subtitle reported since.
    let cachedProgressRequestedAt = -Infinity;
    let saidProxyUnaware = false;
    while (true) {
      this.#throwIfCancelled(epoch);
      if (videoElement.error) {
        return;
      }
      // Re-assert pause in case leftover play-intent resumed it.
      if (!videoElement.paused) {
        pauseWithoutIntent(videoElement);
      }
      const now = Date.now();
      if (now - lastProgressFetchAt >= 1500) {
        lastProgressFetchAt = now;
        try {
          const requestedAt = performance.now();
          cachedProgress = await this.#session.fetchActiveTranscodeProgress();
          cachedProgressRequestedAt = requestedAt;
        } catch (error) {
          // The estimate and the quality menu are built from these readings; a
          // run of failures freezes both at their last value with no sign why.
          // Said on the edge — this poll runs about once a second.
          if (!this.#progressPollFailing) {
            this.#progressPollFailing = true;
            console.warn(
              `[torrent-tv] the transcode progress stopped being readable: ` +
              `${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      }
      this.#throwIfCancelled(epoch);
      this.#assertTranscodeProgress(cachedProgress);
      // The published reading, not a fresh one of our own — see the listener.
      const ahead = this.#lastBufferedAhead ?? bufferedAheadSeconds(videoElement);
      const proxyReadiness = cachedProgress?.playbackReadiness;
      if (proxyReadiness?.reason === "media-continuity-unavailable") {
        throw new Error("Prepared media contains a timestamp gap; playback cannot start.");
      }
      // The subtitle the file opens with: the proxy decides when it has been
      // read, and this only refuses a "ready" taken before the page's own
      // report of that track reached it (`subtitleStartHold`).
      const startSubtitle = this.#subtitlePlayback.startSelection();
      const subtitleHold = proxyReadiness?.version === 1 && proxyReadiness.ready === true
        ? subtitleStartHold(startSubtitle, proxyReadiness, cachedProgressRequestedAt)
        : null;
      if (subtitleHold === "proxy-unaware" && !saidProxyUnaware) {
        saidProxyUnaware = true;
        this.#logEvt(
          `prebuffer: this proxy does not state whether subtitle track ${startSubtitle.trackIndex} ` +
            `has been read; starting without waiting for it`
        );
      }
      const holdsForSubtitles = subtitleHold === "subtitles-pending";
      const readiness = holdsForSubtitles
        ? { ...proxyReadiness, ready: false, delaySeconds: null, reason: "subtitles-pending" }
        : proxyReadiness;
      const unified = this.#waitingModel.update({
        playbackReadiness: readiness,
        bufferedAhead: ahead
      });
      if (readiness?.version === 1 && readiness.ready === true) {
        const subtitles = readiness.subtitles;
        this.#logEvt(
          `prebuffer ready delay=${Number(readiness.delaySeconds).toFixed(2)}s ` +
            `ahead=${ahead.toFixed(1)}s reserve=${Number(readiness.reserveSeconds).toFixed(1)}s ` +
            `prepared=${readiness.preparedSegments} reason=${readiness.reason} ` +
            `subtitles=${subtitles ? `${subtitles.fileIndex}:${subtitles.trackIndex ?? "file"}` : String(subtitles)} ` +
            `start=${startSubtitle.state}`
        );
        this.#logColdStart();
        return;
      }
      const reason = readiness?.version === 1
        ? String(readiness.reason ?? "forecast-unavailable")
        : "proxy-forecast-unavailable";
      if (reason !== loggedReason) {
        loggedReason = reason;
        this.#logEvt(
          `prebuffer waiting ahead=${ahead.toFixed(1)}s ` +
            `delay=${Number.isFinite(readiness?.delaySeconds) ? `${readiness.delaySeconds.toFixed(2)}s` : "unknown"} ` +
            `reason=${reason}`
        );
      }
      // The loader stops at a segment join while the element is paused, which
      // is the whole of this wait — hls.js computes the buffered run with a
      // hole tolerance of zero whenever `paused` is true, so `maxBufferHole`
      // does not reach it here. Nothing else explains a buffer that stands
      // still while segments sit finished on the proxy. Telling the loader
      // where the media really ends restarts it past the join; harmless when
      // there was no join, since that is where it was already headed.
      if (ahead > 0 && Math.abs(ahead - lastAhead) < 0.01) {
        if (Date.now() - lastGrowthAt >= PREBUFFER_NUDGE_AFTER_MS) {
          lastGrowthAt = Date.now();
          const end = bufferedEndSeconds(videoElement);
          this.#logEvt(`prebuffer stood still at ${ahead.toFixed(1)}s — pointing the loader at ${end.toFixed(1)}s`);
          this.#hlsPlayer.resumeLoadAt(end);
        }
      } else {
        lastAhead = ahead;
        lastGrowthAt = Date.now();
      }
      this.#setPhaseProgress(2, unified.cushionPercent ?? 0);
      // Renders on its own — its return value must NOT be fed back through
      // setStatus. Doing that stored the finished text as the STEP, and the
      // next render appended the supply, readiness and time rows to it: exactly
      // three rows per pass, measured 2026-08-09 growing 21 rows/771 chars to
      // 24/830 to 27/… until the line ran off the screen.
      // Published, not drawn: the overlay keeps its own model and renders from
      // these facts. This used to call the formatter directly, which is how a
      // component that no longer talks to the overlay went on computing text
      // nobody read.
      document.dispatchEvent(new CustomEvent(PROXY_EVENTS.MEASURED, {
        detail: {
          downloadStats: this.#lastDownloadStats,
          transcodeProgress: cachedProgress,
          playbackReadiness: readiness ?? null,
          bufferLimitSeconds: this.#browserBufferLimitSeconds
        }
      }));
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /**
   * Log the one-line cold-start summary for the proxy-served flow, then clear
   * the marks. No-op unless all phase marks were captured (a direct/webseed
   * start, or a partially-instrumented path, logs nothing rather than NaN).
   *
   * @returns {void}
   */
  #logColdStart() {
    const c = this.#coldStart;
    this.#coldStart = null;
    if (!c || ![c.t0, c.t1, c.t2, c.t3].every((v) => typeof v === "number")) {
      return;
    }
    const t4 = performance.now();
    this.#logEvt(
      `cold-start total=${Math.round(t4 - c.t0)}ms ` +
        `transport=${Math.round(c.t1 - c.t0)}ms plan=${Math.round(c.t2 - c.t1)}ms ` +
        `prepare=${Math.round(c.t3 - c.t2)}ms prebuffer=${Math.round(t4 - c.t3)}ms`
    );
  }

  /**
   * Emit a timestamped `[evt]` diagnostic line (UTC, same zone as the proxy
   * logger) for correlation. Temporary.
   *
   * @param {string} message
   * @returns {void}
   */
  #logEvt(message) {
    console.debug(`[evt] ${new Date().toISOString().slice(11, 23)} ${message}`);
  }


  /**
   * Poll the active transcode session's progress every second and render it,
   * until the returned stop function is called. Used to keep the loading status
   * moving while the first segment is produced/buffered after the playlist is
   * already available.
   *
   * @param {(error: Error) => void} onFailure
   * @returns {() => void} Stop function.
   */
  #startTranscodeProgressPoll(onFailure) {
    let stopped = false;
    const tick = async () => {
      while (!stopped) {
        try {
          const progress = await this.#session.fetchActiveTranscodeProgress();
          if (!stopped && progress) {
            this.#renderTranscodeProgress(progress);
          }
        } catch (error) {
          if (error?.outcome === "output-failed") {
            onFailure(error);
            return;
          }
          // Same readings, the other poll. Reported once per run of the
          // condition for the same reason.
          if (!this.#progressPollFailing) {
            this.#progressPollFailing = true;
            console.warn(
              `[torrent-tv] the transcode progress poll failed: ` +
              `${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        if (stopped) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    };
    void tick();
    return () => {
      stopped = true;
    };
  }

  /**
   * Render the proxy's playback forecast and measured buffer while transcode
   * progress is polled.
   *
   * @param {object | null} progress
   * @returns {void}
   */
  #renderTranscodeProgress(progress) {
    if (!progress || typeof progress !== "object") {
      return;
    }
    this.#assertTranscodeProgress(progress);
    const unified = this.#waitingModel.update({
      bufferedAhead: bufferedAheadSeconds(this.#videoElement),
      playbackReadiness: progress.playbackReadiness
    });
    // Phase 1 fills its third by the SAME cushion % every other surface uses.
    this.#setPhaseProgress(1, unified.cushionPercent ?? 0);

    // Proxy preparation does not measure the browser's playback buffer.
    if ((unified.cushionPercent ?? 0) <= 0) {
      this.setStatus("Preparing playback...");
    }
    document.dispatchEvent(new CustomEvent(PROXY_EVENTS.MEASURED, {
      detail: {
        downloadStats: this.#lastDownloadStats,
        transcodeProgress: progress,
        playbackReadiness: progress.playbackReadiness
      }
    }));
  }


  #assertTranscodeProgress(progress) {
    if (progress?.state !== "failed") return;
    throw Object.assign(new Error(progress.error || "The proxy could not prepare playback."), { outcome: "output-failed" });
  }

  /**
   * @param {{ requireDecodedFrame?: boolean, signal?: AbortSignal }} [options]
   *   When `requireDecodedFrame` is false, readiness is satisfied once metadata
   *   and non-zero dimensions are known, without waiting for a *presented*
   *   video frame. This is required for the HLS/transcode path on iOS: the
   *   player view is still occluded by the modal loading dialog at this point,
   *   and iOS never presents a frame for an off-screen video, so waiting for
   *   `requestVideoFrameCallback` would deadlock (player won't show until a
   *   frame is decoded; a frame won't present until the player is shown).
   *   The presented-frame wait is only needed for direct-playback probing,
   *   where it doubles as a codec-decodability check.
   * @returns {Promise<void>}
   */
  async #ensureVideoReady(options = {}) {
    const videoElement = this.#videoElement;
    if (!(videoElement instanceof HTMLVideoElement)) {
      throw new Error(Loading.MESSAGES.playerNotReady);
    }
    await waitForMediaReady(videoElement, {
      signal: options.signal ?? this.#session.abortController.signal,
      requirePicture: options?.requireDecodedFrame !== false,
      unsupportedMessage: Loading.MESSAGES.selectedFileUnsupported
    });
  }
  /**
   * @param {unknown} error
   * @returns {boolean}
   */
  #isUnsupportedError(error) {
    return error instanceof Error && error.message === Loading.MESSAGES.selectedFileUnsupported;
  }

  /**
   * @param {unknown} error
   * @returns {boolean}
   */
  #isAbortError(error) {
    if (error instanceof DOMException) {
      return error.name === "AbortError";
    }
    return error instanceof Error && error.name === "AbortError";
  }

  /**
   * Emit a debug line to the browser console.  All playback decisions,
   * fallbacks and failures are mirrored here (in addition to the on-screen
   * status) so issues can be diagnosed from the console.
   *
   * @param {string} message
   * @param {unknown} [data]
   * @returns {void}
   */
  #debug(message, data) {
    if (data === undefined) {
      console.debug(`[torrent-tv] ${message}`);
      return;
    }
    console.debug(`[torrent-tv] ${message}`, data);
  }

  /**
   * @param {{ audioCodec?: string, videoCodec?: string }} codecs
   * @returns {Promise<{ audioSupported: boolean, videoSupported: boolean }>}
   */
  async #predictCodecSupport(codecs) {
    const [audioSupported, videoSupported] = await Promise.all([
      this.#isAudioCodecLikelySupported(codecs.audioCodec),
      this.#isVideoCodecLikelySupported(codecs.videoCodec)
    ]);
    return { audioSupported, videoSupported };
  }

  /**
   * @param {string | undefined} codec
   * @returns {Promise<boolean>}
   */
  async #isAudioCodecLikelySupported(codec) {
    const normalized = typeof codec === "string" ? codec.trim().toLowerCase() : "";
    if (!normalized) {
      return true;
    }
    const mediaCapabilities = await this.#checkMediaCapabilitiesAudioSupport(normalized);
    if (mediaCapabilities != null) {
      return mediaCapabilities;
    }
    const audio = document.createElement("audio");
    const mimeCandidates = AUDIO_CODEC_MIME_CANDIDATES[normalized] ?? [];
    if (mimeCandidates.length === 0) {
      return false;
    }
    for (const mime of mimeCandidates) {
      const support = audio.canPlayType(mime);
      if (support === "probably" || support === "maybe") {
        return true;
      }
    }
    return false;
  }

  /**
   * @param {string | undefined} codec
   * @returns {Promise<boolean>}
   */
  async #isVideoCodecLikelySupported(codec) {
    const normalized = typeof codec === "string" ? codec.trim().toLowerCase() : "";
    if (!normalized) {
      // Unknown video codec: do NOT assume it is playable. Copying an
      // undecodable codec (e.g. xvid) yields a black screen, and the WebRTC
      // transport has no direct-playback probe to fall back on. Treat unknown
      // as unsupported so the video track is transcoded to H.264.
      return false;
    }
    const mediaCapabilities = await this.#checkMediaCapabilitiesVideoSupport(normalized);
    if (mediaCapabilities != null) {
      return mediaCapabilities;
    }
    const video = document.createElement("video");
    const mimeCandidates = VIDEO_CODEC_MIME_CANDIDATES[normalized] ?? [];
    if (mimeCandidates.length === 0) {
      return false;
    }
    for (const mime of mimeCandidates) {
      const support = video.canPlayType(mime);
      if (support === "probably" || support === "maybe") {
        return true;
      }
    }
    return false;
  }

  /**
   * Start polling `/api/sources/:sourceKey/stats` every 2 s and update the
   * loading status with peer count, speed, and file download progress.
   *
   * Returns a stop function — call it when the metadata wait is over.
   *
   * @param {import("../../domain/proxy-transport.js").ProxyTransport} transport
   * @param {string} sourceKey
   * @param {number} fileIndex
   * @returns {() => void} Stop polling.
   */
  #startTorrentStatsPoll(transport, sourceKey, fileIndex) {
    let stopped = false;

    const poll = async () => {
      while (!stopped) {
        try {
          const resp = await transport.fetch(
            `/api/sources/${encodeURIComponent(sourceKey)}/stats?fileIndex=${fileIndex}`,
            { cache: "no-store" }
          );
          if (!stopped && resp.ok) {
            const stats = await resp.json();
            if (!stopped) {
              this.#updateMetadataStatus(stats);
            }
          }
        } catch (error) {
          // The file's own metadata line under the waiting interface. Losing it
          // leaves that line empty for the rest of the wait.
          if (!this.#metadataPollFailing) {
            this.#metadataPollFailing = true;
            console.warn(
              `[torrent-tv] the source's metadata could not be read: ` +
              `${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        if (!stopped) {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
      }
    };

    void poll();
    return () => {
      stopped = true;
    };
  }

  /**
   * Render the "Fetching file metadata" status line with live torrent stats.
   *
   * Opening a torrent and resuming after a seek are the same wait for the
   * viewer, so they are described by the SAME line, built by the SAME code
   * ({@link #formatBufferingText}) — same metrics, same single end-to-end
   * "time until playback" figure. Previously this screen computed its own
   * narrower "time to next phase", which answered a different question and
   * could disagree with what the seek overlay showed for the same session.
   *
   * The whole-file line stays: during the initial fetch the file is genuinely
   * being downloaded from zero, and its size/progress is real, relevant
   * context that has no equivalent mid-playback.
   *
   * @param {{
   *   numPeers?: number, downloadSpeed?: number,
   *   fileProgress?: number, fileDownloaded?: number, fileLength?: number,
   *   headerBytes?: number, headerDownloadedBytes?: number
   * }} stats
   */
  #updateMetadataStatus(stats) {
    const _fileProgress = typeof stats?.fileProgress === "number" ? stats.fileProgress : null;
    const _fileDownloaded = typeof stats?.fileDownloaded === "number" ? stats.fileDownloaded : null;
    const _fileLength = typeof stats?.fileLength === "number" ? stats.fileLength : null;
    const headerBytes = typeof stats?.headerBytes === "number" ? stats.headerBytes : null;
    const headerDownloadedBytes =
      typeof stats?.headerDownloadedBytes === "number" ? stats.headerDownloadedBytes : null;

    // Until the codec probe can run, "what still has to arrive" is the file
    // header — so it plays the role the resume window plays mid-playback, and
    // feeds the shared formatter through the same fields.
    const statsForShared = {
      ...stats,
      resumeNeededBytes: headerBytes,
      resumeDownloadedBytes: headerDownloadedBytes
    };
    // Retained so the later transcode/pre-buffer screens can keep showing the
    // supply stage instead of dropping it the moment a session appears.
    this.#lastDownloadStats = statsForShared;
    // The step is a NAME. Peers, rate and what is left are measurements and
    // they reach the overlay on their own; composing them into the step here is
    // what put the word "undefined" on screen when this call stopped returning
    // text.

    if (headerBytes !== null && headerBytes > 0 && headerDownloadedBytes !== null) {
      // The bar still advances on header progress; the text does not show this
      // percent — the header is a handful of whole pieces, so it jumps
      // 0 → 50 → 100 and reads as broken.
      this.#setPhaseProgress(0, Math.max(0, Math.min(100, (headerDownloadedBytes / headerBytes) * 100)));
    }

    // How much of the WHOLE file has been downloaded is not a thing anyone is
    // waiting for: the file is read as a stream, and playback starts on a
    // cushion of seconds, not on a percentage of gigabytes. Shown beside the
    // real figures it invited exactly the wrong question — "why is it still
    // downloading if it is already transcoding" — about a number that was never
    // going to reach 100 before the picture started.

    this.setStatus(Loading.MESSAGES.fetchingMetadata);
  }



  /**
   * @param {{
   *  audioCodec: string,
   *  videoCodec: string,
   *  audioSupported: boolean,
   *  videoSupported: boolean,
   *  plannerMode: string,
   *  shouldTranscodeAudio: boolean,
   *  shouldTranscodeVideo: boolean
   * }} details
   * @returns {string}
   */
  #buildTranscodeReason(details) {
    const reasons = [];
    if (details.shouldTranscodeVideo) {
      reasons.push(
        `video codec ${this.#formatCodecName(details.videoCodec)} is not supported by this browser`
      );
    }
    if (details.shouldTranscodeAudio) {
      if (details.plannerMode === "hls") {
        reasons.push(
          `proxy planner requires HLS for audio codec ${this.#formatCodecName(details.audioCodec)}`
        );
      } else if (!details.audioSupported) {
        reasons.push(
          `audio codec ${this.#formatCodecName(details.audioCodec)} is not supported by this browser`
        );
      } else {
        reasons.push("audio transcode was requested by playback planner");
      }
    }
    if (reasons.length === 0) {
      return "Reason: transcode path selected by compatibility checks.";
    }
    return `Reason: ${reasons.join("; ")}.`;
  }

  /**
   * @param {string | undefined} codec
   * @returns {string}
   */
  #formatCodecName(codec) {
    const value = typeof codec === "string" ? codec.trim() : "";
    return value.length > 0 ? value : "unknown";
  }

  /**
   * The picture as the viewer sees it, in physical pixels, or null before it
   * can be measured.
   *
   * It replaced a box made of the window's long and short edges times the
   * pixel ratio times a chosen 0.95: a landscape film on an upright phone
   * fills the width and a strip of the height, and that box asked for a
   * picture about three times taller than the one on screen. The measurement
   * and its reasons are in `domain/visible-picture.js`.
   *
   * @returns {{ width: number, height: number } | null}
   */
  #visiblePictureNow() {
    return this.#visiblePictureWatch?.current() ?? null;
  }

  /**
   * Start following the picture as the viewer sees it. Each change is said to
   * the proxy at once rather than at the next tick of the report: it is the
   * upper bound of the height being made for them.
   *
   * @param {HTMLVideoElement} videoElement
   * @returns {void}
   */
  #watchVisiblePicture(videoElement) {
    this.#visiblePictureWatch?.stop();
    this.#visiblePictureWatch = new VisiblePictureWatch(videoElement, {
      onChange: (size) => {
        this.#logEvt(`visible picture ${size.width}x${size.height} physical pixels`);
        reportNow();
      },
      // Before the element has its metadata, the video's proportions are the
      // source's, which the plan carried.
      fallbackVideoSize: () => (this.#sourceVideoWidth > 0 && this.#sourceVideoHeight > 0
        ? { width: this.#sourceVideoWidth, height: this.#sourceVideoHeight }
        : null)
    });
    this.#visiblePictureWatch.start();
  }

  /**
   * The player finished switching variant: the rung named here is the one on
   * screen, which is not the one that was asked for until the first fragment of
   * the new variant has been appended.
   *
   * @param {number} height
   * @returns {void}
   */
  /**
   * On what the proxy judged the output it gives this viewer: `fits` against
   * their link, `estimated to fit` (an average, not a bound — admitted and not
   * confirmed), or `no measurement`. Logged when it changes.
   *
   * @param {object | null | undefined} verdict
   * @returns {void}
   */
  #noteServingVerdict(verdict) {
    const next = verdict && typeof verdict.verdict === "string" ? verdict : null;
    const before = this.#servingVerdict?.verdict ?? "";
    this.#servingVerdict = next;
    if ((next?.verdict ?? "") !== before) {
      this.#logEvt(`quality: the proxy judged this output "${next?.verdict ?? "unknown"}" ${JSON.stringify(next)}`);
    }
  }

  #onProxyOutcome(outcome) {
    // ONLY AN OUTCOME OF THE VIEWING ON SCREEN is acted on. The channel is one
    // list for the page, and an answer to a request made before a seek, or for
    // the file played before this one, can arrive after the page has moved on;
    // acted on, it would seek and reload the video now playing.
    const belongs = outcomeBelongsTo(outcome, this.#currentViewing());
    if (!belongs.belongs) {
      this.#logEvt(`playback: ${outcome.outcome} for ${outcome.path} is not this viewing's (${belongs.reason}); ignored`);
      return;
    }
    if (outcome.outcome === "assignment-lost") {
      void this.#recoverLostAssignment(outcome);
      return;
    }
    if (outcome.outcome === "output-unavailable") {
      // Met by the player itself, mid-stream — a level it moved to that the
      // proxy will not serve to this link. Said in the log with the reason; the
      // player keeps what it holds, and the viewer asked for nothing.
      const height = Number(/\/v\/(\d+)\//.exec(outcome.path)?.[1]) || 0;
      this.#logEvt(`quality: the proxy has no output for ${height || "this"}p that fits this link — ${outcome.reason}`);
    }
  }

  /**
   * The output the page is playing and the viewing it is in now.
   *
   * @returns {{ sessionId: string | null, generation: number }}
   */
  #currentViewing() {
    return {
      sessionId: this.#session?.currentTranscodeSession?.sessionId ?? null,
      generation: this.#session?.viewGeneration ?? 0
    };
  }

  /**
   * A part of the film this viewer was already given came from an output that
   * has gone, and nothing proven to match its header can stand in.
   *
   * WHAT IS DONE: a new viewing, where the picture is. The page raises its
   * generation (a seek to where it stands), so every request from now on is
   * decided afresh; and the player is made to fetch its headers again, because
   * the one it holds belongs to the output that has gone. Nothing is repeated
   * against the old viewing — the proxy would answer it the same way for ever.
   *
   * One recovery at a time: a burst of refusals for neighbouring parts is one
   * event.
   *
   * @param {{ reason: string, path: string }} outcome
   * @returns {Promise<void>}
   */
  async #recoverLostAssignment(outcome) {
    if (this.#recoveringAssignment) {
      return;
    }
    this.#recoveringAssignment = true;
    try {
      const at = this.#videoElement instanceof HTMLVideoElement
        ? Math.max(0, this.#videoElement.currentTime)
        : 0;
      this.#logEvt(
        `playback: ${outcome.path} can no longer be given as it was (${outcome.reason}); ` +
        `starting a new viewing at ${at.toFixed(1)}s`
      );
      const viewing = this.#currentViewing();
      await this.#session.reportSeek(at);
      // The seek report is awaited, and the viewer can change the file meanwhile.
      // The reload is for the output that lost the part, and for no other.
      if (this.#session?.currentTranscodeSession?.sessionId !== viewing.sessionId) {
        this.#logEvt("playback: the output changed while the new viewing was being reported; not reloading");
        return;
      }
      if (!this.#hlsPlayer.reloadAt(at)) {
        this.#logEvt("playback: no player to reload for the new viewing");
      }
    } finally {
      this.#recoveringAssignment = false;
    }
  }

  #onHlsLevelSwitched(height) {
    if (height > 0) {
      this.#logEvt(`quality: now playing ${height}p`);
      this.#playingHeight = height;
      // A switch is an event, and the proxy decides which rung's encoder is
      // this viewer's from it: said now, not at the next tick of the report.
      reportNow();
    }
  }

  /**
   * The player has reached a state it cannot come back from.
   *
   * There was no channel for this at all: hls.js's own recovery runs on fatal
   * errors, and the one that kills a session — an append refused by an ended
   * MediaSource — arrives non-fatal. So on 2026-08-14 the element sat at
   * `currentTime=0 readyState=0` behind a spinner for the rest of the session
   * while every layer reported success. A viewer looking at a dead player must
   * be told, and given the button that starts it again.
   *
   * @param {string} details - hls.js's own name for what failed.
   * @returns {void}
   */
  #onPlayerUnrecoverable(details, epoch) {
    // While the loading flow is still running it owns the failure path, and it
    // reports with the context this handler does not have. Same division as
    // `#onTransportLost`.
    if (this.#isProcessing) {
      this.#logEvt(`player cannot continue (${details}) — the loading flow will report it`);
      return;
    }
    // A file index of -1 means no load has finished yet, and Retry would then
    // ask for a file that does not exist. There is nothing useful to offer.
    if (this.#activeFileIndex < 0) {
      this.#logEvt(`player cannot continue (${details}) — no active file to restart`);
      return;
    }
    this.#logEvt(`player cannot continue (${details}) — offering a restart`);
    const error = this.#armRetryableStall(this.#activeFileIndex, Loading.MESSAGES.playerCannotContinue);
    if (epoch === this.#playbackEpoch) {
      // A rebuild that came before this may have the waiting notice up and its
      // poll running. Both end here, without telling the machine the picture
      // is back: it is not, and the failure below is what it is told.
      this.#playbackLive = false;
      this.#clearBuffering();
    }
    this.#failWith(epoch, error);
  }

  /**
   * The media element failed, whoever owns its source.
   *
   * Its own code and message are the only statement of the cause there is, so
   * they are written down first. Who acts on the failure depends on who feeds
   * the element: an hls.js player rebuilds its media source at the position
   * where it failed (`hls-player.js`, `onElementFailed`) and says so through
   * `onMediaRebuild`; native HLS and a directly played file have nothing that
   * could rebuild them, so the stream is restarted through the same offer as
   * any player that cannot continue.
   *
   * @param {HTMLVideoElement} videoElement
   * @returns {void}
   */
  #onMediaElementFailed(videoElement) {
    const failure = describeMediaFailure(videoElement.error);
    this.#logEvt(
      `media element failed: ${failure.kind} (code ${failure.code ?? "-"}) "${failure.message}" ` +
      `at ${videoElement.currentTime.toFixed(2)}s readyState=${videoElement.readyState} ` +
      `networkState=${videoElement.networkState}`
    );
    // The pause the element makes next is its own, not the viewer's.
    noteElementFailed(videoElement);
    if (!this.#hlsPlayer.isActive()) {
      this.#onPlayerUnrecoverable(`media element ${failure.kind} failure`, this.#playbackEpoch);
    }
  }

  /**
   * The player is rebuilding a failed element's source at the position where
   * it failed. A frame is wanted and is not there, which is a stall: the
   * waiting notice is shown and the machine goes to STALLED. When the picture
   * is back, the ordinary end of a stall starts it again if the viewer had not
   * stopped it — which is why that end carries the viewer's decision and not
   * `!video.paused`.
   *
   * The position it is rebuilt at becomes where the viewer is: while the new
   * source has no media the element reads zero, and the reports that say
   * where the viewer is fall back to the position last chosen, which by then
   * can be a seek made minutes earlier. Recorded, not reported as a seek —
   * nobody moved.
   *
   * @param {number} epoch - The attempt the player belongs to.
   * @param {number} position - Seconds the player is rebuilt at.
   * @returns {void}
   */
  #onMediaRebuild(epoch, position) {
    if (epoch !== this.#playbackEpoch || !this.#playbackLive) {
      return;
    }
    if (Number.isFinite(position) && position > 0) {
      this.#seekPosition.reset(position);
    }
    this.#logEvt(`player rebuilding its media source at ${Number(position).toFixed(1)}s`);
    void this.#showBuffering();
  }

  #noteEffectiveQuality(progress) {
    this.#noteServingVerdict(progress?.servingVerdict);
    const cushion = Number(progress?.minimumBufferSeconds);
    this.#minimumBufferSeconds = Number.isFinite(cushion) && cushion > 0 ? cushion : null;
    this.#followQualityRequest(progress?.requestedHeight, progress?.requestedUrgent === true);
  }

  /**
   * Move to the variant the proxy asked for.
   *
   * The proxy measures what its own machine and the viewer's link can carry,
   * and it used to act on those measurements by rewriting the SIZE of the
   * picture inside the session the player was already decoding. The init
   * segment describing that picture is fetched once, by `#EXT-X-MAP`, and can
   * never be replaced, so every fragment after such a change was decoded
   * against parameter sets for a picture that was no longer being made:
   * measured 2026-08-21, one browser reported `size=1280x720` for three and a
   * half minutes over macroblock garbage, another errored on the first
   * mismatched fragment and sat at `size=0x0` for four and a half.
   *
   * So the proxy asks instead, and the move happens the way a change of
   * variant always does — the player fetches another variant, which has its
   * own init. The quality is always automatic (roadmap item 98), so every
   * request is followed; one the proxy stops asking for is dropped.
   *
   * @param {unknown} requested
   * @param {boolean} [urgent] - The viewer's buffer would run dry before
   *   anything else could arrive, so the switch does not wait for a cushion.
   * @returns {void}
   */
  #followQualityRequest(requested, urgent = false) {
    const height = Math.round(Number(requested));
    // A move being prepared that the proxy no longer asks for is dropped: the
    // conditions it was asked under have gone back (roadmap item 98). Moving
    // the pick on is what makes the waiting switch give up.
    if (this.#autoQualityRequestHeight > 0 && height !== this.#autoQualityRequestHeight) {
      this.#logEvt(`quality: the proxy no longer asks for ${this.#autoQualityRequestHeight}p; dropping the move`);
      this.#autoQualityRequestHeight = 0;
      this.#qualityPreparation?.abort();
      this.#qualityPickSeq = (this.#qualityPickSeq ?? 0) + 1;
    }
    if (!Number.isFinite(height) || height <= 0) {
      return; // the proxy is content, or is older than this exchange
    }
    const level = this.#hlsPlayer.levels().find((candidate) => candidate.height === height);
    if (!level) {
      // Nothing to switch to: this stream has no variants, or none at that
      // height. The proxy lets the request run out on its own.
      return;
    }
    if (level.index === this.#hlsPlayer.currentLevel()) {
      return;
    }
    if (this.#autoQualityRequestHeight === height) {
      return; // already acting on this one
    }
    this.#autoQualityRequestHeight = height;
    this.#logEvt(`the proxy asks for ${height}p${urgent ? " before the buffer runs dry" : ""} — moving`);
    void this.#switchQualityLevel(level, height, { urgent })
      .catch(error => {
        if (error?.name === "AbortError") return;
        this.#logEvt(`quality: preparation failed (${error?.code ?? "unknown"}, retry=${error?.canRetry === true}): ${error?.message ?? error}`);
      })
      .finally(() => {
        if (this.#autoQualityRequestHeight === height) {
          this.#autoQualityRequestHeight = 0;
        }
      });
  }


  /**
   * Feed the player's audio menu with the active file's tracks, and which one
   * is playing.
   *
   * One place, because it is published from two moments now: when a file has
   * loaded, and after a track is switched in place through a rendition — where
   * nothing else redraws it, since the session is not rebuilt.
   *
   * @returns {void}
   */
  /**
   * Open this file on the soundtrack the viewer chose in the previous one.
   *
   * Here, and not after the session exists, because here it costs nothing: the
   * track is chosen before the codec decision is made and before the session is
   * created, so the file simply starts in the right language. Applying it later
   * would be a rendition switch, with the picture held while the proxy prepares
   * the track — which is what a viewer does when they change their mind, not
   * what they should meet on opening an episode.
   *
   * Nothing to match means nothing to do: the file's own default plays, exactly
   * as it does when the first episode is opened.
   *
   * @param {{ audioTracks?: object[] }} _prepared - The plan just read; the
   *   tracks are taken from `#audioTracks`, which it has already filled.
   * @returns {void}
   */
  #applyRememberedAudioTrack(_prepared) {
    if (!this.#rememberedAudio) {
      return;
    }
    const tracks = this.#audioTracks;
    const files = this.#session.current?.files;
    const videoFile = Array.isArray(files) && this.#activeFileIndex >= 0 ? files[this.#activeFileIndex] : null;
    const videoName = typeof videoFile?.name === "string" ? videoFile.name : "";
    const position = findTrackByIdentity(
      tracks.map((track) => audioTrackIdentity(track, videoName)),
      this.#rememberedAudio
    );
    if (position < 0) {
      this.#logEvt(
        "the soundtrack chosen earlier is not in this file — playing the one it names itself"
      );
      return;
    }
    const index = Number(tracks[position]?.index);
    if (!Number.isInteger(index) || index === this.#selectedAudioTrackIndex) {
      return;
    }
    this.#selectedAudioTrackIndex = index;
    this.#logEvt(`opening on audio track ${index}, chosen in an earlier episode`);
  }

  /**
   * Note the soundtrack the viewer has just chosen, so the next episode opens
   * with it. Called only from the menu handler, which is the viewer by
   * construction — nothing here reads a track this component selected itself.
   *
   * @returns {void}
   */
  #rememberAudioChoice() {
    const files = this.#session.current?.files;
    const videoFile = Array.isArray(files) && this.#activeFileIndex >= 0 ? files[this.#activeFileIndex] : null;
    const videoName = typeof videoFile?.name === "string" ? videoFile.name : "";
    const track = (this.#audioTracks).find(
      (candidate) => candidate?.index === this.#selectedAudioTrackIndex
    );
    const identity = track ? audioTrackIdentity(track, videoName) : null;
    if (!identity) {
      // A track whose language nothing states cannot be looked for in another
      // file. Leaving the previous memory in place would be worse than none:
      // the next episode would open on a track the viewer moved AWAY from.
      this.#rememberedAudio = null;
      return;
    }
    this.#rememberedAudio = identity;
    this.#logEvt(`audio ${JSON.stringify(identity)} remembered for the next episode`);
  }

  #publishAudioTracks() {
    // The picture's own file name, which is what tells a bracketed group naming
    // the RELEASE apart from one naming whoever made a soundtrack beside it.
    const files = this.#session.current?.files;
    const videoFile = Array.isArray(files) && this.#activeFileIndex >= 0
      ? files[this.#activeFileIndex]
      : null;
    const videoName = typeof videoFile?.name === "string" ? videoFile.name : "";
    const tracks = (this.#audioTracks)
      // A track the container marks unusable is not offered. It keeps its number
      // — every entry carries its own, and the proxy publishes a rendition for
      // it either way — so leaving it out of the menu changes what the viewer
      // sees and nothing else.
      .filter((track) => track?.isEnabled !== false)
      .map((track) => ({
        index: track.index,
        label: buildTrackLabel(track, videoName)
      }));
    document.dispatchEvent(
      new CustomEvent(PLAYER_EVENTS.SET_AUDIO_TRACKS, {
        detail: { tracks, activeIndex: this.#selectedAudioTrackIndex }
      })
    );
  }

  async #refreshAudioTrackMetadata({ fileIndex, sourceKey, transport, sequence }) {
    while (
      sequence === this.#audioMetadataRefreshSeq &&
      this.#session.current &&
      this.#proxy?.isOpen !== false
    ) {
      try {
        const refreshed = await this.#session.refreshProxyAudioTracks(fileIndex, sourceKey, transport);
        if (sequence !== this.#audioMetadataRefreshSeq) return;
        const currentByIndex = new Map(this.#audioTracks.map((track) => [track?.index, track]));
        let changed = false;
        for (const incoming of refreshed.audioTracks) {
          const current = currentByIndex.get(incoming?.index);
          if (
            !current ||
            current.fileIndex !== incoming.fileIndex ||
            current.sourceTrackIndex !== incoming.sourceTrackIndex ||
            current.kind !== incoming.kind
          ) {
            continue;
          }
          for (const field of [
            "codec", "language", "languageBcp47", "title", "isDefault", "declaresDefault",
            "isOriginal", "isCommentary", "isVisualImpaired", "isEnabled", "channels", "bitrateKbps"
          ]) {
            if (current[field] !== incoming[field]) {
              current[field] = incoming[field];
              changed = true;
            }
          }
        }
        if (changed && fileIndex === this.#activeFileIndex) {
          this.#publishAudioTracks();
          this.#logEvt("audio track labels updated from the sidecar header");
        }
        if (!refreshed.pending) return;
      } catch (error) {
        if (this.#isAbortError(error) || sequence !== this.#audioMetadataRefreshSeq) return;
        // Older proxies do not expose this endpoint. Keep playback and the
        // filename-derived labels; this metadata is optional.
        this.#logEvt(`audio track metadata refresh stopped: ${error?.message ?? error}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }


  /**
   * Whether this browser needs one soundtrack re-encoded, decided as it is for
   * the track a file is opened on: a codec it cannot decode, or one HLS cannot
   * carry to it as it stands.
   *
   * @param {number} trackIndex
   * @returns {Promise<boolean | null>} Null when the plan names no codec for
   *   the track, which leaves the proxy to assume what it needed before.
   */
  async #trackNeedsTranscode(trackIndex) {
    const track = this.#audioTracks.find((one) => one?.index === trackIndex);
    const codec = typeof track?.codec === "string" ? track.codec.trim().toLowerCase() : "";
    if (!codec) {
      return null;
    }
    const supported = await this.#isAudioCodecLikelySupported(codec);
    return !supported || !this.#canCopyAudioCodecForHls(codec);
  }

  /**
   * @param {string} codec
   * @returns {boolean}
   */
  #canCopyAudioCodecForHls(codec) {
    if (!HLS_AUDIO_COPY_COMPATIBLE_CODECS.has(codec)) {
      return false;
    }
    // Being a codec HLS can carry is not enough — it also has to survive the
    // trip into MediaSource, and that depends on the container. MP3 is the case
    // that matters: it cannot be copied into fMP4 at all, but hls.js can carry
    // it in MPEG-TS, so #requiredSegmentFormat asks the proxy for that
    // container instead of giving up on the copy.
    return canAppendCopiedAudio(codec, "fmp4") || canAppendCopiedAudio(codec, "mpegts");
  }

  /**
   * The container this browser needs for the tracks it wants copied, or `""`
   * when it has no preference and the proxy's own setting should stand.
   *
   * fMP4 is the better default and stays it: MediaSource takes Opus, FLAC, AV1
   * and VP9 inside MP4 but has no place for them in MPEG-TS, and an fMP4
   * segment reaches the decoder without hls.js having to rebuild it. The one
   * thing MPEG-TS carries that fMP4 cannot is MP3 — measured in Chromium,
   * `audio/mp4; codecs="mp4a.69"` is refused while `audio/mpeg` is accepted,
   * and hls.js falls back to exactly that buffer when it demuxes MPEG-TS. A
   * copied MP3 track in fMP4 therefore loads forever without ever playing.
   *
   * @param {{ audioCodec?: string, transcodeAudio: boolean }} plan
   * @returns {string}
   */
  #requiredSegmentFormat({ audioCodec, transcodeAudio }) {
    if (transcodeAudio) {
      // The audio is being re-encoded to AAC, which both containers carry.
      return "";
    }
    const codec = typeof audioCodec === "string" ? audioCodec.trim().toLowerCase() : "";
    if (!codec || canAppendCopiedAudio(codec, "fmp4")) {
      return "";
    }
    return canAppendCopiedAudio(codec, "mpegts") ? "mpegts" : "";
  }

  /**
   * @param {string} codec
   * @returns {Promise<boolean | null>}
   */
  async #checkMediaCapabilitiesAudioSupport(codec) {
    if (
      typeof navigator !== "object" ||
      !navigator ||
      typeof navigator.mediaCapabilities !== "object" ||
      typeof navigator.mediaCapabilities.decodingInfo !== "function"
    ) {
      return null;
    }
    const mimeCandidates = AUDIO_CODEC_MIME_CANDIDATES[codec] ?? [];
    for (const contentType of mimeCandidates) {
      try {
        const result = await navigator.mediaCapabilities.decodingInfo({
          type: "file",
          audio: {
            contentType,
            channels: "2",
            bitrate: 160000,
            samplerate: 48000
          }
        });
        if (result && typeof result.supported === "boolean") {
          return result.supported;
        }
      } catch (error) {
        // Which path decided the answer, and why the better one did not. This
        // choice decides whether a track is copied or re-encoded, i.e. whether
        // someone's home machine runs an encoder for this viewer at all — a
        // silent fall-back to `canPlayType` hides the fact that the precise
        // answer was never available.
        console.debug(
          `[torrent-tv][codec] mediaCapabilities declined to answer for audio ${contentType} ` +
          `(${error instanceof Error ? error.message : String(error)}); falling back to canPlayType`
        );
      }
    }
    return null;
  }

  /**
   * @param {string} codec
   * @returns {Promise<boolean | null>}
   */
  async #checkMediaCapabilitiesVideoSupport(codec) {
    if (
      typeof navigator !== "object" ||
      !navigator ||
      typeof navigator.mediaCapabilities !== "object" ||
      typeof navigator.mediaCapabilities.decodingInfo !== "function"
    ) {
      return null;
    }
    const mimeCandidates = VIDEO_CODEC_MIME_CANDIDATES[codec] ?? [];
    for (const contentType of mimeCandidates) {
      try {
        const result = await navigator.mediaCapabilities.decodingInfo({
          type: "file",
          video: {
            contentType,
            width: 1920,
            height: 1080,
            bitrate: 5_000_000,
            framerate: 30
          }
        });
        if (result && typeof result.supported === "boolean") {
          return result.supported;
        }
      } catch (error) {
        // Which path decided the answer, and why the better one did not. This
        // choice decides whether a track is copied or re-encoded, i.e. whether
        // someone's home machine runs an encoder for this viewer at all — a
        // silent fall-back to `canPlayType` hides the fact that the precise
        // answer was never available.
        console.debug(
          `[torrent-tv][codec] mediaCapabilities declined to answer for video ${contentType} ` +
          `(${error instanceof Error ? error.message : String(error)}); falling back to canPlayType`
        );
      }
    }
    return null;
  }
}

const AUDIO_CODEC_MIME_CANDIDATES = {
  aac: ['audio/mp4; codecs="mp4a.40.2"'],
  mp3: ['audio/mpeg; codecs="mp3"', 'audio/mpeg'],
  opus: ['audio/webm; codecs="opus"', 'audio/ogg; codecs="opus"'],
  vorbis: ['audio/webm; codecs="vorbis"', 'audio/ogg; codecs="vorbis"'],
  flac: ['audio/flac', 'audio/mp4; codecs="flac"'],
  ac3: ['audio/mp4; codecs="ac-3"'],
  eac3: ['audio/mp4; codecs="ec-3"']
};

const VIDEO_CODEC_MIME_CANDIDATES = {
  h264: ['video/mp4; codecs="avc1.42E01E"'],
  hevc: ['video/mp4; codecs="hvc1.1.6.L93.B0"', 'video/mp4; codecs="hev1.1.6.L93.B0"'],
  av1: ['video/mp4; codecs="av01.0.08M.08"', 'video/webm; codecs="av01.0.08M.08"'],
  vp9: ['video/webm; codecs="vp9"', 'video/mp4; codecs="vp09.00.10.08"'],
  vp8: ['video/webm; codecs="vp8"']
  // mpeg4 (MPEG-4 Part 2: xvid/divx) and mpeg2video are intentionally omitted:
  // mainstream browsers cannot decode them, so an empty candidate list makes
  // #isVideoCodecLikelySupported return false → the video track is transcoded
  // to H.264 instead of being copied (which would play as a black screen).
};

const HLS_AUDIO_COPY_COMPATIBLE_CODECS = new Set(["aac", "mp3", "ac3", "eac3"]);

/**
 * The MediaSource type a copied audio track ends up as, per container.
 *
 * hls.js appends everything through MediaSource, so this — not `canPlayType` —
 * is the question that decides whether a copy plays. Measured in Chromium:
 * `canPlayType('audio/mp4; codecs="mp4a.69"')` answers "probably" for a type
 * `MediaSource.isTypeSupported` refuses.
 *
 * With fMP4 the proxy's segment reaches the decoder untouched, so the codec has
 * to be one MediaSource accepts inside MP4. With MPEG-TS hls.js demuxes and
 * rebuilds the stream itself, which changes the answer in exactly one place:
 * for MP3 it gives up on MP4 and appends to a plain `audio/mpeg` buffer
 * (verified in our own `vendor/hls.min.js`).
 */
const COPIED_AUDIO_MSE_TYPES = {
  fmp4: {
    aac: 'audio/mp4; codecs="mp4a.40.2"',
    mp3: 'audio/mp4; codecs="mp4a.69"',
    ac3: 'audio/mp4; codecs="ac-3"',
    eac3: 'audio/mp4; codecs="ec-3"'
  },
  mpegts: {
    aac: 'audio/mp4; codecs="mp4a.40.2"',
    mp3: "audio/mpeg",
    // hls.js remuxes these into MP4 too, so the container buys nothing.
    ac3: 'audio/mp4; codecs="ac-3"',
    eac3: 'audio/mp4; codecs="ec-3"'
  }
};

/**
 * Whether a copied audio track can be appended when the proxy produces
 * `container`.
 *
 * @param {string} codec - Lower-case codec name from the playback plan.
 * @param {"fmp4" | "mpegts"} container
 * @returns {boolean}
 */
function canAppendCopiedAudio(codec, container) {
  const mime = COPIED_AUDIO_MSE_TYPES[container]?.[codec];
  if (!mime) {
    return false;
  }
  if (typeof MediaSource !== "function" || typeof MediaSource.isTypeSupported !== "function") {
    // No MediaSource to ask (iOS native HLS plays the playlist itself, and it
    // handles every codec HLS defines). Do not block the copy.
    return true;
  }
  const supported = MediaSource.isTypeSupported(mime);
  // Both sides of the answer, because this decision is why a track is copied
  // rather than re-encoded, and a wrong "yes" here is indistinguishable at
  // playback from a file that is simply arriving too slowly — the two need very
  // different fixes and the log could not tell them apart.
  console.debug(`[evt] codec-support audio ${codec}/${container} asked "${mime}" -> ${supported}`);
  return supported;
}
// A scrub emits `seeking` on every pointer move; only where it settles counts.
const SEEK_REPORT_DEBOUNCE_MS = 300;
// How often the playback position may be written to the address bar, so a
// bookmark taken at any moment is at most this far behind the picture.
// `timeupdate` fires about four times a second, which is far too often to
// touch history; one second is sixty writes per thirty seconds, against the
// hundred at which Safari — the strictest, and the same engine on iOS — starts
// refusing. These writes REPLACE, so however long the film, the history does
// not grow by a single entry.
const URL_POSITION_INTERVAL_MS = 1_000;
// The HLS loader can stop at a segment join while the element is paused. If the
// measured browser buffer stays unchanged, request again from its actual end.
const PREBUFFER_NUDGE_AFTER_MS = 4_000;
const DIRECT_PLAYBACK_HINTS_STORAGE_KEY = "torrent-tv-direct-playback-hints-v1";
const DIRECT_PLAYBACK_HINTS_MAX_ENTRIES = 400;
const DIRECT_PLAYBACK_HINT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function bootstrapLoading() {
  new Loading();
}

if (document.readyState !== "loading") {
  bootstrapLoading();
} else {
  document.addEventListener("DOMContentLoaded", bootstrapLoading, { once: true });
}
