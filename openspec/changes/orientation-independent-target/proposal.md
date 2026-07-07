# Proposal: Orientation-independent transcode target (resolution ceiling)

## Why

The transcode target resolution was computed from the current on-screen size
of the `<video>` element. On a phone that is orientation-dependent, and worse:
a landscape (16:9) clip is letterboxed in portrait, so the video box is
*smaller* there. A viewer who starts in portrait — the common case — and then
rotates to landscape gets an encode provisioned for the small portrait box and
never upgraded, because rotation does not re-issue the target and re-issuing it
would force a cold ffmpeg restart (the same stall seen on seeks).

The fix is to size the target for the LARGER (landscape) orientation from the
start, so it is valid for both and rotation never needs more pixels — no
restart, no under-provisioning.

## What Changes

- `#buildVideoTargetConfig` sizes the target from the viewport's **long and
  short edges** (`max`/`min` of `innerWidth`/`innerHeight`) instead of the
  current width/height or the letterboxed `<video>` box. The result is
  identical in both orientations and provisions for landscape.
- DPR, the 0.95 factor, and even-dimension rounding are unchanged. The proxy
  still caps the box to the source size (`min` with `iw`/`ih`,
  `force_original_aspect_ratio=decrease`) — never upscales.
- This target is defined as the **resolution ceiling** for the realtime
  budget: the budget scales DOWN from it for CPU; orientation itself never
  changes the encode resolution, so no orientation listener / restart is
  needed.

## Capabilities

### Modified Capabilities

- Extends the transcode pipeline's target-resolution behaviour (client side).

## Impact

- `public/components/loading/loading.js` — `#buildVideoTargetConfig` only.
- Client-only; server release, no proxy/addon dependency.
- Foundation for the realtime budget (`proxy/transcode-quality` parts 2-4) and
  manual quality.
