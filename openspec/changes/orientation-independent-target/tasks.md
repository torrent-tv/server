# Tasks: Orientation-independent transcode target

## 1. Client (this change)

- [x] 1.1 `#buildVideoTargetConfig` sizes the target from viewport long/short
      edge (orientation-independent, landscape-provisioned)
- [x] 1.2 Keep DPR, 0.95 factor, even-dimension rounding, and the proxy-side
      source cap (no upscale)
- [x] 1.3 Syntax + module-load verified in preview

## 2. Release

- [ ] 2.1 CHANGELOG + server patch (0.8.43)
- [ ] 2.2 Field: start a transcoded title in portrait, rotate to landscape,
      confirm no rebuffer/restart and the encode already fills landscape

## 3. Next (budget stage — separate, `proxy/transcode-quality` parts 2-4)

- [ ] 3.1 Budget treats this target as the resolution ceiling and scales down
      for CPU; orientation never triggers a resolution change on its own
