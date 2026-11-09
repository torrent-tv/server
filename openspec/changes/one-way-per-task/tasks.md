# Tasks: Solve each recurring task one way (server and page)

Parent: torrent-tv/meta#279. Sub-issues in `Ready`, Priority order; ticked
when `Done`. Cross-repository and tooling sub-issues are listed in
`proxy/openspec/changes/one-way-per-task/tasks.md`.

## 1. Behaviour differs between copies

- [ ] 1.1 #288 Remove the retired wait estimate and progress bar from the page
- [x] 1.2 #289 Read the proxy's playback forecast with one rule at start and after a seek (after #288)
- [ ] 1.3 #290 Report picker input errors the way the magnet field does

## 2. Converge

- [ ] 2.1 #297 Decide which tracks to transcode in one page function; remove the unused HTTP transport (after #289)
- [ ] 2.2 #298 Open a .torrent and a magnet through one flow with one magnet parser (after #297)
- [ ] 2.3 #299 Read proxy answers, pending polls and cancellation one way (after proxy #296, #298)
- [ ] 2.4 #312 One WebRTC signalling session
- [ ] 2.5 #313 Contract literals once; one proxy registration path (after #299, #312, proxy #281)
- [ ] 2.6 #314 Shared view helpers and player colour tokens (after #298)
- [ ] 2.7 #315 Shared DOM, fetch and signalling fakes in tests (after #289, #299)
