## 0.8.163

- **Fix**: The time until playback moves instead of jumping. The rate it divides by was the MINIMUM over a sliding six-second window, which is conservative and also discontinuous by construction: a slow reading entering the window collapsed the divisor and the figure leapt, and the same reading ageing out of it made the figure collapse back. Measured 2026-08-11 on consecutive ticks — 22.58 s to 3.83 s, then 5.43 s to 45.87 s, with the number climbing steadily in between so the wait appeared to lengthen while the viewer watched it. The rate is now smoothed, and deliberately asymmetrically: a rate that got worse is believed almost at once, because a wait is governed by its worst stretch, and a rate that got better is believed slowly, so one lucky burst cannot promise a wait it will not deliver. Covered by a test that fails on the jump.

## 0.8.164

- **Fix**: The fill rate credits media that was actually PLAYED, read from the playhead, instead of trusting a flag. 0.8.163 credited playback consumption whenever the element was not paused — but a stalled element is not paused either, and plays nothing, so `@1.00x` came straight back on frozen buffers and turned into overestimates of 17.4 and 3.7 seconds (measured 2026-08-10). The playhead cannot be wrong about this: if it did not move, nothing was consumed, whatever the element intended. The flag is gone; each buffer reading now carries the playhead beside it, and one formula is correct while playing, while paused and while stalled.
- **Fix**: A crawling rate no longer divides a shortfall. Refusing only an exact zero let 0.0002 through, which turned a twenty-five second shortfall into thirty hours on screen — 107 095 seconds, measured the same day. Anything below a twentieth of realtime is now treated as unable to answer, and the estimate falls through to what this host has historically taken.

## 0.8.163

- **Fix**: A buffer that is not filling reads as zero rather than as 1x. The fill rate credited the media consumed by playing — correct while the picture moves, because a buffer holding steady during playback is genuinely being filled at exactly 1x — but it credited it during WAITS too, when nothing is being consumed. So a completely frozen buffer reported 1.00x, and a shortfall divided by that came back as the shortfall itself. Measured 2026-08-10: six consecutive waits, every one tagged `@1.00x-measured`, every one short — promised 15.0, 25.0, 14.9, 0.7, 0.0 and 5.9 seconds against real waits of 55.4, 47.0, 23.1, 11.0, 14.4 and 9.7. The same formula at the other end produced a single estimate of 586.9 seconds.
- **Fix**: A rate of zero no longer divides anything. It is a true statement about the link and is kept, but it cannot answer "how long", so the estimate falls through to what this host has historically taken instead of returning an absurd figure.
- **Chore**: Both are pinned by tests, including one asserting that the same three readings mean zero while waiting and 1x while playing.

## 0.8.162

- **Fix**: The time until playback estimates the event that actually starts the picture. The gate opens on the full cushion OR early, once the buffer holds a healthy amount and the rate has sustained a surplus — and the estimate was measured against the full target regardless, so it described something nobody was waiting for. Measured 2026-08-10 across six waits: three promised 25.0, 20.2 and 24.8 seconds and ended after 7.1, 1.7 and 0.6. The figure also never moved during any of them, which was honest arithmetic on an unchanging input and still the wrong answer. The gate's own thresholds are now the estimate's, in one place, so the two cannot drift apart.
- **Fix**: A shortfall is divided by the slowest rate observed recently, not the latest one. Dividing by the instantaneous rate assumes it will hold: measured the same day, a cushion 1.3 seconds short at 2.04x was promised in 1.3 seconds and took 34.6, because the rate collapsed immediately afterwards. A wait is governed by its worst stretch rather than its best. This removes the three underestimates of 11, 17 and 33 seconds in the same six.
- **Chore**: Both rules are pinned by tests, including one that fails if the early-start thresholds are changed on one side only.

## 0.8.161

- **New**: The browser checks the tracks it received against the tracks the proxy said it would send. The proxy now states its output's track set when a session is created — it knows the set exactly, because it chose it — and the player compares that statement with what its media element actually holds. Until now a lost track was noticed only by its absence: measured 2026-08-10, sixty-five seconds of playing audio with `videoWidth=0` and not one frame decoded, and nothing anywhere saying that video had been promised. The two facts are reported separately on purpose, because "no picture" alone cannot tell a file that genuinely has no video from a session that lost the track on the way, and those are opposite problems with opposite fixes.

## 0.8.160

- **Fix**: The stage decomposition reports an out-of-order stage as such instead of as a negative duration. Marks do not always fall in pipeline order — after a seek the buffer still holds media from the previous position, so "the first bytes arrived" can be observed before "the encoder produced anything". Measured backwards that read `first-bytes=-5.7s`, which is not a small negative number but a stage that did not happen in this wait. The 0.8.159 entry claimed this was already fixed; it was not, and this is the fix.

## 0.8.159

- **New**: A fragment requested far from where the viewer is standing says so, and says what preceded it. The proxy sees only a segment number, so a request for #0 is indistinguishable there from an ordinary one — it restarts the encoder at the top of the film, which is what the viewer sees as the picture jumping back to the beginning (reported 2026-08-10, with the encoder observed restarting at #0 mid-session). Whether that was a seek the viewer made or something restarting the stream behind their back can only be answered on this side, so any fragment more than thirty seconds from the playhead is now logged with the position asked for, the position the viewer is at, whether the element is seeking, and the last thing hls.js did — a media re-attach, a level reload, a buffer reset or an error.
- **Fix**: The stage decomposition no longer reports a negative duration. The mark for the first bytes reaching the buffer could precede the mark for the encoder producing anything, because after a seek the buffer still holds media from the previous position.

## 0.8.158

- **Fix**: A measured fill rate is the whole answer, not one term added to the others. It is taken at the buffer, which is the far end of the chain — the torrent, the encoder, the data channel and the browser's own decoding are all already inside that one number — so adding the stage terms on top of it adds a part to a whole. Measured 2026-08-09: an estimate of 28.7 s for a wait that lasted 1.6 s. The stage terms are still computed and still logged as evidence of where the time is expected to go; they are simply no longer summed into a figure that already contains them.
- **New**: Every wait reports how long each of its stages actually took — creating the session, producing a first segment, the first bytes reaching the buffer, and filling the cushion — beside the score of what was predicted. "Said 4 s, took 47" says nothing about where the 43 went; "predicted 4 s to produce a first segment, it took 7.5" is a defect with an address. A stage that was never reached is named as such rather than reported as zero, because the two mean different things when the question is which prediction was wrong. The viewer still sees one total.

## 0.8.157

- **Fix**: Buffer readings taken across a seek are thrown away instead of being read as a collapse in throughput. A seek discards the buffer, so a rate measured from before it to after it describes the flush and not the pipeline. Trusted as a fill rate it came out at 0.08x, and dividing the shortfall by that announced a 296-second wait for one that lasted 1.0 s; another read 719.7 s against 11.2 s. Those spikes are what drove the median error to 16-20 s on waits of 2-22 s. The history is cleared the moment the element starts seeking, before the reading that same event triggers is taken.

## 0.8.156

- **Fix**: The cushion the estimate counts down to is now the one the pre-buffer gate actually releases on. There were two figures for one decision: the model wanted a single segment, about four seconds, while the gate held out for fifteen. So the model announced "ready, nothing left to wait for" and the picture stayed still for another six to twelve seconds. Scored against what happened, 2026-08-09: `said=0.0s was=11.9s`, `said=0.0s was=5.6s`, and in the worst case `said=0.7s was=54.5s` — because with the cushion believed met, the fill term was dropped from the sum altogether and only a download term remained. The gate now asks the model for the figure instead of computing its own, so an estimate that reaches zero and a picture that starts are the same moment by construction. Covered by a test: with nothing measured both want the same fallback, and a faster fill needs less banked because the surplus over realtime is what stops it draining.
- **Fix**: The estimate is scored where it is made. The report was asked of the pipeline's model, which computes twice in a whole wait, while the model that estimates for the screen recomputes on every buffer reading — so the one question that matters went unanswered in the log.

## 0.8.155

- **Fix**: The estimate is scored against what actually happened, by the model that made it. The report was asked of the pipeline's model, which computes twice in a whole wait; the model that estimates for the SCREEN recomputes on every buffer reading and is the one holding enough samples to score. So the one question that matters — were the figures true — went unanswered in the log while the wait it described had just ended. It is now reported the moment a wait ends, from the same place the numbers came from.

## 0.8.154

- **Fix**: The time until playback is no longer computed from a rate nobody measured. When neither the buffer's fill rate nor the encoder's nor the link's had been observed, the estimate divided the shortfall by an assumed 1.0x — "the pipeline is keeping up" — and produced a confident small number out of nothing. Scored against what actually happened, 2026-08-09: `said=4.0s was=46.8s`, a median error of **21.8 s over 164 samples** of a 46.8 s wait, worst case 1.3 s promised with 45 s still to go. Not one figure the viewer was shown was borne out, which is what was reported from the field for days. The measured fill rate is used first now, because it is the end result of the whole chain and prices every bottleneck at once; then the encoder and link rates; and when nothing at all has been measured, the estimate rests on how long THIS host has historically taken to produce a first segment — a median the proxy reports from its own recent sessions. Still not a measurement of this wait, but a fact about the machine doing the work rather than an assumption about it, and displaced by a real one the moment the buffer moves. The figure is always shown, as before.

## 0.8.150

- **Fix**: A refused `play()` is no longer mistaken for the viewer pausing, and no longer swallowed by an empty catch. When the browser declines to start playback the element stays paused and raises a `pause` event, which the machine read as a decision by the viewer. Whether that is what produced the black screen reported on 2026-08-09 is NOT established — the viewer was pressing play/pause themselves at the time, which accounts for the same log — so this is a correctness fix and an instrument, not a diagnosis. A refusal is now marked as ours and written to the log with its reason.
- **Chore**: The picture itself is confirmed working from the field: `1920x1080, 197 frames, 0 dropped`. Whatever the black screen was, it was not the codec and not the decoder.

## 0.8.149

- **Fix**: "Connecting to proxy…" stops being shown after the connection is made. The step was set when the connect began and nothing replaced it until much later, so the overlay named that step while showing peers and a download rate — figures that can only come FROM a proxy already connected. A step that has finished is now replaced at the moment it finishes.
- **Fix**: "N MB left" moves. It was measured ahead of a FROZEN anchor pinned for the whole episode, which is right for a stable progress denominator and wrong for "how much is still needed before the picture can move" — within seconds it describes a stretch already passed. Field 2026-08-09: it read "16.0 MB left" unchanged across three phases at 4.2 MB/s, a rate that clears 16 MB in four seconds. It is now measured from where the reader actually is.

## 0.8.148

- **Fix**: The time until playback is measured again. The rate at which the browser's buffer fills is the only end-to-end figure there is — it prices in the torrent, the encoder, the data channel and the decoding together — and it was being measured on every reading, delivered to the model, and thrown away: the model declared the variable, printed it in the diagnostic and never assigned it. `fillRate=n/a` therefore stood in every line of every session while the buffer visibly moved (measured 2026-08-09: 35.99 s to 35.17 s over four readings, the rate never once computed). Every estimate the viewer was shown rested on the weaker terms instead, which is why none of the four figures reported from the field held.

## 0.8.147

- **New**: The browser says whether it actually decoded a picture. A track chosen to be COPIED is one we judged the browser able to play, and when that judgement is wrong the result is a black frame with working sound — indistinguishable, from every other reading we take, from data simply arriving too slowly. Those are different faults with different fixes and the log could not tell them apart. Every five seconds while the picture is meant to be moving it now records the decoded frame count, the frame size and the dropped count; time advancing with the counter at zero is reported as a warning that says what it means.
- **New**: The codec support question is logged with both halves — the exact MIME string asked about and the answer — so a wrong "yes" is visible at the moment it is given rather than inferred later from a black screen.

## 0.8.146

- **Fix**: The estimate keeps what the proxy last said between readings. The buffer is measured four times a second by the component that owns the element, and the proxy answers about once every second and a half; a reading arriving on its own reset both of the proxy's figures to nothing. The diagnostic line then alternated `proxyProcessed=4208.333` with `null` and `13823KB/s` with `0KB/s`, every other line — so half of every session's evidence described a state that never existed, and every second estimate was computed from an empty picture. Covered by a test.

## 0.8.145

- **Fix**: The time until playback stops reading zero while the picture is not moving. A floor capped every estimate at "the previous one minus the time since", and that arithmetic ends one way: once a promise has run down, `min(actual, 0)` is zero for ever. Measured 2026-08-09 across a whole wait — the diagnostic line read `fill=4.0@1.00x` while the screen read `0 seconds until playback`, with the buffer at 0.00 and not moving. The guard had been removed once already, in 0.8.109, and came back when the estimate was moved into its own model. It existed to hide jumps between estimate sources; there is one source now, so a rise means the wait genuinely got longer and saying so is the whole point. Covered by a test that fails with the floor in place.

## 0.8.144

- **Fix**: The one figure the viewer wants — how long until playback — is shown for the whole of the wait. The cushion and the estimate are measured at the browser's own buffer, and the only readings came from the media element's own events, which do not fire before it has a source. So through an entire cold open nothing was measured, and with nothing measured there was nothing honest to say. The player now takes a reading twice a second for as long as the state says the viewer is waiting, and stops the moment it does not; an element reading zero is a true reading, not a guess.
- **Fix**: An estimate is no longer stated when the cushion has not been measured. It read "0 seconds until playback" over a picture that had not started and was not about to — measured 2026-08-09 with 29 peers and 5.9 MB/s. Zero now means only what it always should have: a cushion that genuinely reached its target.
- **Fix**: The word "undefined" no longer appears in the overlay. One caller still composed the step out of measurements, and when that composition stopped returning text the result was printed as it stood. The step is a name; peers, rate and what is left are measurements and reach the overlay on their own.
- **New**: The estimate is recomputed on every buffer reading, not only when the proxy answers. It is measured at the buffer, so a new reading is the moment it changes; waiting for the poll left it a second and a half stale.

## 0.8.143

- **Fix**: The end-to-end estimate is on screen again, and from the first moment of a wait. It is measured AT THE BUFFER, and the buffer was only read when the media element raised an event of its own — which through a cold open it does not, because there is no source yet. So nothing was measured, and 0.8.141 had just made the estimate say nothing rather than say zero, which turned "wrong" into "absent". The player now takes a reading every half second for as long as the state says the viewer is waiting, and stops the moment it does not. An unattached element reading zero is a true reading.
- **Fix**: The estimate is recomputed the instant a reading arrives, not on the next proxy poll. The cushion and the time left are both measured at the buffer, so a new reading is exactly when they change; waiting for the poll left the one figure the viewer actually wants up to a second and a half stale.

## 0.8.142

- **Fix**: The step is shown again, and a seek gets one for the first time. Working the step out from the measurements — which is the only way a seek can have one, since a seek runs no pipeline step — was still being done inside the component that had stopped talking to the overlay, so it computed a name and threw it away. It now happens where the measurements are. A step the pipeline names still wins; the numbers only answer when it is silent, which tells a wait for pieces apart from a wait for the encoder.
- **Fix**: Two calls to a formatter that no longer exists would have thrown on the pre-buffer path and on the warm-up poll. They published their figures instead, which is what the overlay reads now.
- **Chore**: The dead formatter and its unused import are gone. It assembled a full set of measurements on every poll and returned them to nobody.

## 0.8.141

- **Fix**: The word "undefined" no longer appears on the waiting overlay. A step was being composed out of measurements — `${message}
${sharedLine}${fileLine}` — and the call that produced the middle piece stopped returning text when the figures moved into their own model, so the placeholder rendered literally. The step is a NAME again; peers, rate and what is left are measurements and reach the overlay by themselves.
- **Fix**: "0 seconds until playback" is gone from screens where playback was not about to start. Two separate causes, both saying a wait was over when it was not: the estimate answered zero while the cushion had never been measured at all — measured 2026-08-09 with 29 peers and 5.9 MB/s behind a stopped picture — and the row was printed even when the figure was zero. Nothing measured now yields no figure, and a zero yields no row.
- **Fix**: Peers and download rate show only while something still has to come off the swarm. The row sat through entire seeks reading "0 B left", which is the row itself saying it had nothing to report.

## 0.8.139

- **New**: The player measures its own element. How much media is buffered and how fast that is filling are facts about the media, and the component that owns the `<video>` is the one that may read them — nobody else touches `video.buffered` now. It publishes both on `PLAYER:BUFFER` as the element's own events fire.
- **New**: The proxy's poll answers are published raw on `PROXY:MEASURED`, exactly as the proxy gave them. Whoever needs a figure works it out for itself; handing round conclusions is how the overlay came to be told what to display in the first place.
- **New**: The waiting overlay holds its own model and works its own figures out from those two facts. It is no longer given a conclusion by anything.
- **Chore**: Eleven tests on `domain/buffer-metrics.js`, including the two readings that have been wrong in the field and could not be seen: a range after a gap counted as cushion, and a buffer holding steady while the picture plays — which is filling at 1x, not at 0.

## 0.8.138

- **New**: The figures behind the waiting overlay moved out of the pipeline into `domain/waiting-model.js` — a Humble Object split. A view with arithmetic in it can only be checked by looking at it; everything that decides what the numbers ARE now lives in a class with no DOM, no events and no element, so `node --test` can reach it. Two consumers, one implementation: the overlay reads the figures to show them, the pre-buffer gate reads them to decide when the picture may start, and neither computes anything itself — so they cannot disagree about what "enough buffered" means.
- **New**: `domain/buffer-metrics.js` — how much media is buffered ahead of the playhead, and how fast that is filling. Both derive from `video.buffered` and from nothing else: the proxy knows what it SENT, and the two disagree exactly when it matters. Pure functions, with the sample history held by whoever measures, so there is no state and no class.
- **Chore**: `loading.js` is 399 lines smaller and no longer holds a second copy of the buffer reading.

## 0.8.136

- **New**: The waiting overlay is its own component (`components/waiting/waiting.js`) and nobody tells it what to display. It subscribes to facts — `WAITING:MEASURED` as measurements are taken, `WAITING:STEP` when the pipeline reaches a named step — accumulates them, and rebuilds its own text. The pipeline no longer touches that element at all; it reports and forgets.
- **Fix**: The line cannot grow again. Three times now a caller took the text the overlay had just rendered and passed it back as the step, after which every later render appended its own rows to it — 53 rows and off the screen, measured 2026-08-09. Each time the call site was fixed and each time another appeared. There is no longer any way to say "display this", only "this was measured" and "this step began", so the fault has nowhere to live. The node is also rebuilt with `replaceChildren`, which removes whatever is there first, whoever put it there.
- **Fix**: A finished wait takes its measurements with it, instead of the next one opening on the last one's peers and estimate until its own first poll answers.

## 0.8.136

- **Fix**: The waiting line stops growing, and this time the shape that let it grow is gone. A second call site took the rendered text and passed it back in as the STEP, so every later render appended its own rows to it — the same fault as 0.8.132, at a different line, found by the same instrument. The render now returns nothing at all: a function that hands back what it has just drawn invites exactly this, and three occurrences is enough. Removing the return value is what makes a fourth impossible, not the fix to the call site.

## 0.8.135

- **New**: One number, always. The time until playback no longer alternates with "estimating…" and "starting now". Those were a different kind of statement wearing the same line: one admitted the formula had nothing, the other announced an event. The viewer asked how long, so they are told how long — and when the wait is nearly over that is zero seconds, which is a duration like any other. Before the first measurement there is no line rather than a word standing in for a number.
- **New**: The percentage is gone with the progress bar it came from. `Buffering — 60%` promised a fraction of a known whole, and named a step in a row that was not the step row. What it actually carried — how much media is still needed — is already said by the step and by each encoder's own line.
- **New**: Every estimate is scored against what happened. An estimate made N seconds before the picture started should have said N; each is kept with the moment it was shown, and when playback begins the log carries the count, the median error, and the first and worst estimates with the terms that produced them (`[eta-accuracy] wait=11.8s samples=32 medianErr=1.4s first: said=3.4s was=11.8s err=-8.4s [create=0.4+first=2.1+fill=0.9@2.35x] …`). The error is signed on purpose: negative means the figure was optimistic, which is the failure a viewer notices, because it promises a start that does not come. Nothing has ever checked the shown figure against reality before; now the term at fault is identifiable without replaying a session.

## 0.8.133

- **New**: The waiting overlay gives every encoder run still going its own line — which tracks of which rendition, how much it still has to make, and how fast: `Encoding 720p video and audio - 4s left, 2.6x realtime`. One run today, so one line; the shape is an array because switching quality without interrupting playback will mean several at once, and two runs sharing the same cores slow each other down — a single averaged figure would hide precisely that. A session that copies both tracks has no encoder and gets no line.
- **Fix**: A seek names what it is waiting for. The code that derived a step from the measurements sat after a `return` and had never run once, so a seek showed a number of seconds with nothing saying whether the wait was for pieces, for the encoder to be moved, or for the first segment out of it — three unrelated waits with one appearance.

## 0.8.133

- **New**: Every step of a wait is timed, and a seek's steps are named. `domain/stage-timeline.js` opens a stage whenever the viewer is shown a new step and writes one line when it closes: how long it took, and — once something predicts it — by how far the prediction was out. Every step goes through it, so the connect, which used to be one opaque `Connecting to proxy…` over a health poll, a full ICE and DTLS exchange and a liveness check, now reports where its seconds went. A seek runs no pipeline step at all, so it showed a number with nothing saying whether the wait was for pieces, for the encoder to be moved, or for the first segment out of it — three unrelated waits with one appearance. The step is now worked out from the measurements already being taken and timed like any other.

## 0.8.132

- **Fix**: The waiting line stops growing. `#waitForPrebuffer` passed the buffering formatter's return value back into `setStatus`, and since 0.8.128 that formatter renders the finished text itself — so the whole line was stored as the STEP, and the next render appended the supply, readiness and time rows to it. Exactly three rows per pass: measured 2026-08-09 going 21 rows/771 characters to 24/830 to 27/…, until the text ran off the screen. The formatter is now called for its effect, not its value. Found by the instrument added in 0.8.131, which named the field and its growth after reading the code twice had not.

## 0.8.131

- **Chore**: When the waiting line comes out longer than the formatter can produce, the log names the field carrying the excess. The formatter emits at most four rows; measured 2026-08-09 it produced 53, with the step holding a dozen repeats of the readiness and time rows — and no call site composes a step that way, so reading the code has not explained it. A `MutationObserver` established that only our own writer touches the node, which rules out the DOM and leaves the data. This reports the shape of every measurement, once per over-long render, instead of the question being reasoned about a third time.

## 0.8.130

- **Fix**: The waiting line replaces its whole contents instead of assigning its text. Measured 2026-08-09 in a private window with no cache: the line grew to 53 rows, successive renders stacked on top of one another, while the code being served had exactly one writer doing a plain `textContent` assignment — which cannot accumulate. The mechanism was not identified. `replaceChildren` removes every child the node holds whoever put them there, so the writer is authoritative over the node rather than over its text, and the outcome no longer depends on knowing who else touched it.
- **Chore**: `console.trace` is not among the levels forwarded to the server log, so a diagnostic written with it never leaves the browser. Noted here because it cost a round trip; use `warn` with an explicit stack.

## 0.8.129

- **Fix**: The failure message no longer invents a cause. "No data arrived from the proxy — allow local network access" was shown on 2026-08-09 while ICE was complete over global IPv6, nothing was queued on the data channel and progress polls were being answered in 9-43 ms: it named as the cause the one thing known to be in order, and cost real time on the way to the actual fault, which was on the proxy. It now says what was observed — the proxy took the request and sent no video — and says outright that nothing here explains why.
- **Fix**: The waiting overlay has one writer again. The player was also putting text in that line, and clearing it to a space when it thought the wait was over, so the words composed from the measurements were overwritten and the line grew until it ran off the screen. The player owns whether the overlay is up — that is a function of the state; the loading component owns what it says. The line is also given a ceiling and somewhere to wrap, because it now carries several rows rather than a short chip.

## 0.8.128

- **New**: The waiting overlay's text comes from one function. `domain/waiting-text.js` takes an object of measurements — peers, rate, bytes still needed, the cushion, the estimate — plus the step the pipeline is on, and returns every line of it. Two writers used to share that line: the pipeline's status string and the buffering formatter. So the same wait could read one way while it was opening and another once it stalled, with nowhere to look to find out why. A seek and a cold open are the same wait, so they are now the same words, made the same way. The function is pure, which is what lets a test pin it without a browser.

## 0.8.127

- **Fix**: The waiting overlay is on screen for the whole of a cold open. Whether it showed had two gates — the state, and a `SET_BUFFERING(false)` from the pipeline — and the second could hide it during the opening wait, which is when the viewer has least else to look at. Visibility now follows the state alone; the buffering event carries text and nothing more. A seek and a cold open are the same thing to the viewer and very nearly the same to the system, so they get the one interface, shown by the one rule.

## 0.8.126

- **Fix**: The waiting overlay uses the text line it already had, instead of two paragraphs of its own. 0.8.121 moved the removed dialog's file name and status into the overlay as new elements needing new styling; the overlay had a styled line all along — the one the seek case has always used. One waiting interface means one spinner and one line of words. The file name is no longer repeated there: the playlist and the address bar both name it, and repeating it cost the status its own line. `loading.css` is gone entirely.

## 0.8.125

- **Fix**: The waiting overlay's text is styled again. Every rule in `loading.css` described the dialog that 0.8.121 removed, so the file name and the status line moved into the player's overlay with no styling at all. The overlay keeps the appearance it already had for a seek; this only dresses the two lines of text that joined it.

## 0.8.124

- **Chore**: The subtitle converter the browser stopped using is gone rather than hidden. The linter's automatic fix had renamed two unused functions with a leading underscore, which silences the warning and leaves the code — so they are deleted instead, along with the five helpers that only they called. `subtitle-utils.js` loses 117 lines; the proxy converts subtitles now, and nothing here called this path.

## 0.8.123

- **Fix**: Opening anything failed at once with `applied is not defined`. Removing the progress bar in 0.8.121 took out the two lines that computed the value while leaving the line that logged it, so the first progress report of every load threw and the load was reported as a failure. Field log 2026-08-09: `IDLE -> OPENING`, then the throw 2 ms later, then `OPENING -> ERROR`.
- **Chore**: The server has a linter. It had none — which is why an undeclared name could ship at all, the same way it did in proxy 2.9.124 before that repo got one. Biome, correctness rules only, and `npm test` now runs it before the tests. Its first run found nine more: a missing `ERROR_EVENTS` import in the torrent component, four unused imports and four functions nobody calls.

## 0.8.121

- **New**: One waiting interface instead of two. A cold open and a seek into data that has not arrived ask the viewer the same question and were answered by two different screens — a full-screen modal dialog for the first, a small overlay in the player for the second. The dialog is gone; what it carried (the file name, the status line, Cancel, Playlist) now lives in the player's own overlay, which is shown whenever the state says the viewer is waiting.
- **New**: The waiting overlay carries no buttons of its own. Cancel and Playlist duplicated the player's own close and playlist controls, which are on screen throughout — one waiting interface means one set of controls too.
- **New**: The progress bar is gone with it. A bar promises a known fraction of a known whole; what is being waited for is a time, and it is already stated in words.

## 0.8.120

- **Fix**: A cold open plays by itself again. Whether the viewer wants playback was read as `!video.paused` at the one moment the pipeline itself holds the element paused — the pre-buffer gate, one line before a stream is announced ready — so every open reported "the viewer stopped it" and ended on a frozen first frame, with the starvation indicator never arming and a shared link's position never applied. A pause we cause is now marked as ours before it is issued (`domain/playback-intent.js`) and only an unmarked one counts as the viewer's.
- **Fix**: A seek into data that has not arrived no longer throws a modal dialog over the video. The full-screen waiting view is a modal, so shown for a stall it covered the picture and the whole control bar and made them inert — the viewer could not pause, scrub back or play until the data came. It is now the cold open's view only; a stall is answered by the small overlay inside the player, whose visibility comes from the state and whose text keeps arriving measured.
- **New**: The application state machine is explicit, pure and tested (`domain/app-state.js`, 30 tests). Six states, hierarchy for the edges several of them share, and outputs — which view, whether the viewer is waiting, what to tell the element — derived from the state rather than commanded on the edge. The design and the reasoning behind each state are in `research/state-machine-2026-08-08.md`.
- **New**: `CHOOSING_FILE` — a source open with nothing being built. "Back to episodes" from the error screen used to claim a build nobody had started, so the waiting view came up over the episode list carrying the failed file's name.
- **Fix**: A rebuild asked for while one is already running is applied again instead of silently doing nothing. Cancelling a multi-file torrent's load hid the waiting view by hand while the machine stayed where it was, and the next episode then built behind a blank player with no sign of anything happening.
- **Fix**: The first stall after every rebuild reached the machine. The flag recording whether a stall had been reported outlived the stream it described, so exactly one stall per rebuild was swallowed.
- **Fix**: An event the machine refuses no longer moves the extended state beside it.
- **Chore**: `knip` finds dead code (`npx knip`).

## 0.8.120

- **Fix**: A torrent starts playing by itself again. The guard that keeps a rebuild from starting playback at a viewer who had paused was reading `!video.paused` — at the one moment the pipeline itself holds the element paused, because the pre-buffer gate pauses it on purpose while the stream is built. Every cold open therefore answered "the viewer does not want playback" and stopped on its first frame. The viewer's intent is now tracked as its own fact, and pauses we cause are marked as ours (`domain/playback-intent.js`).
- **Fix**: A seek into data that has not arrived no longer covers the video with a modal dialog. Bound to "the viewer is waiting", the full-screen loading view came back on every stall — and being modal it made the video and the whole control bar inert, so the viewer could not pause, scrub back or press play until the data arrived. It is the cold open's view only; a stall is answered by the small overlay inside the player, as before.
- **Fix**: A rebuild asked for while one is already running now re-applies the outputs. The state does not change, so nothing was announced, and a view that had hidden itself — Cancel on a multi-episode torrent, the playlist stepping aside — was never told to come back: the next episode built behind a blank player with no sign of anything happening.
- **Fix**: An event the machine refuses no longer moves the extended state alongside it.
- **Fix**: The flag that stops a stall being reported twice is cleared with the stream it described, so the first stall after a rebuild is no longer swallowed.
- **New**: Seeking, starvation and a scrub while paused now move the application state, so the machine describes playback and not only the cold open. Two of its five states were unreachable before this: nothing told it a frame was wanted and missing, or that the viewer had stopped. The decision is taken where it was already being taken — the function that shows the waiting indicator — rather than worked out a second time, and it is reported on a change only.
- **New**: A stream that becomes usable says whether the viewer wants the picture to move, read from the media element which owns that fact. A rebuild finishing under a pause no longer starts playing at someone who stopped it.
- **Chore**: The four views share one base class for deriving themselves from the state (`components/state-derived-view.js`). Two of the four handlers were identical word for word. It also holds whether the view was on screen a moment ago: no view has a `visible` getter, so a subclass asking `this.visible` reads `undefined`, and that mistake had already been made in the player, where it would have stopped the video source ever being released.
- **Fix**: A failure arriving from an attempt the viewer already abandoned no longer drags them to an error screen. The machine has no edge from the picker to the error state, so the late answer is ignored where it used to be obeyed. Verified in the browser: a failure dispatched after a reset leaves the picker on screen.
- **Fix**: The screen can no longer disagree with the state. Each view now derives its own visibility from the application state instead of being commanded by whichever view appeared (`PLAYER:SHOW`, `LOADING:SHOW`, `ERROR:SHOW` each also meaning "and everyone else hide"). That is why four flows — a quality switch, an audio switch, a reconnect and a Retry — could re-show the waiting view with no transition at all, leaving the state saying one thing and the screen another with nothing able to notice. Those four now say what they are, and the state follows them.
- **Fix**: A transition the machine does not allow is refused and logged instead of throwing. It threw from inside a DOM event listener, so the rest of the handler was abandoned and its flags went on describing a state the application had left — the safety check was itself the failure.
- **New**: Seeking, starvation and a scrub while paused are one state, and a pause is a state of its own. The waiting overlay, which view is on screen, whether the controls accept input, and whether the element should be playing are all now functions of the state alone.
- **Chore**: The application state machine now exists as a pure module with tests (`public/domain/app-state.js`). States, the transition relation, the superstate hierarchy and the outputs derived from a state, with no DOM and no side effects. Derived from four rules rather than from what the code did: outputs are a function of the state alone (Moore), something becomes a state only when it changes what is legal or what is shown, an edge shared by several states is declared once on their superstate, and the relation is checked as a graph. The tests assert the properties, not just the edges: every state reachable, every state able to return to the picker, no state-and-event pair that throws, and the edges that must NOT exist. Design and the drawn graph in `research/state-machine-2026-08-08.md`.

## 0.8.119

- **Fix**: Picking another episode starts it from the beginning. One <video> element serves every file and it keeps the position the last one was left at, so attaching the new stream resumed the NEW episode wherever the PREVIOUS one had got to — switch forty minutes into episode one and episode two began forty minutes in. The element is now rewound when the file changes, and only when nothing has asked for a position: a resume from the address, from Retry or from Back sets one first, and that is the case this must not overwrite.

## 0.8.118

- **Fix**: The quality menu says what automatic quality is playing from its first render. The height came only with a progress report, polled about every second and a half, so the menu was built with a bare "Auto" and gained its height a second or two later — a viewer who opened it in that window was told nothing. When the video is copied the answer is already known before playback starts: nothing is being re-encoded, so what plays is the source's own height, which arrives with the playback plan. It is now used straight away, and a progress report only lowers it if the encoder settles on a smaller rung.

## 0.8.117

- **Fix**: Playback resumes where it left off instead of starting the film again and seeking. The position was carried in a field filled by whichever path opened the file, and it lost a race: measured 2026-08-06, it arrived with an event that fires AFTER the transcode session has been created, so the proxy was told `start=0s`, the film loaded from the beginning, and the position was applied as an ordinary seek once the player was already on screen — a full cold start and an encoder restart for something that was known all along. The address bar does not race: it is written before the load begins, it survives a reload, and it is the state by design, so it is now consulted whenever the field is empty. Both sources are named in the log line beside the figure.

## 0.8.115

- **Fix**: The estimate keeps the two figures only the proxy can measure — how long this host takes to create a session and to produce a first segment — current for the whole session. They were read once per file from the playback plan, so on a proxy that had just restarted, when neither figure existed yet, the browser kept the nulls and every later seek estimated the wait with one term of four: measured 2026-08-06, the figure reached zero after 3.5 s of an 11.8 s wait and then read "starting now" for the remaining 8.4 s. They now also arrive with the progress report, which is polled about every 1.5 s.
- **Chore**: The comment beside the address-bar write interval said two seconds where the code says one.

## 0.8.114

- **New**: Automatic quality says what it currently is — `Auto (720p)` rather than `Auto`. The proxy steps the resolution down when it cannot encode in realtime or the link cannot carry the stream, and the viewer could see the picture soften with no answer anywhere to what they were watching. The label follows a change as it happens; the menu is rebuilt only when the height actually moves, not on every poll.
- **Chore**: The keep-alive poll's answer is no longer thrown away. It runs for as long as a session is held and is the only reading of the proxy's state during steady playback — everything else polls only while the picture is stopped — so it now carries that reading to whoever needs it.

## 0.8.113

- **Chore**: The position is written to the address once a second instead of once every two. That is thirty writes per thirty seconds against the hundred at which Safari starts refusing them — three times the margin, which is enough — and it halves the part of a resume's error that comes from the write interval. These writes replace, so the history still does not grow by a single entry however long the film.
- **New**: A resume says how far it landed from where it aimed. Reported 2026-08-06 as coming back "about five seconds earlier"; the write interval and its rounding down account for two of those, and nothing in the log accounted for the rest, because the position asked for and the position playback actually began at were never compared. One line per resume, written when playback starts: `resume asked for 5964.50s, playback began at 5959.87s (-4.63s)`.

## 0.8.112

- **Fix**: Retry after a lost connection returns to where the viewer was. The position stored for it was always zero, so a router reboot forty minutes into a film meant starting the film again. It is now taken from the player, or from the address bar when the player has already been torn down — one of the two always knows. It is also announced before the load rather than applied after it, so it travels the same path as reopening a bookmark: hls.js begins buffering there and the proxy is told to encode from there, instead of loading from the beginning and seeking once the picture is already showing.
- **Fix**: A failure no longer wipes the address. Clearing it when no source is present was meant for the viewer choosing "New Torrent", but a failure clears the session too — so the address, the one remaining record of what was playing and where, was thrown away at exactly the moment Retry needed it. It is now cleared only when the viewer deliberately leaves for the picker.

## 0.8.111

- **Fix**: Reopening at a saved position failed with "no data arrived from the proxy". The position was given to hls.js and to nobody else, so the player asked for the segment at 1:17:10 while the proxy had been told to encode from the beginning; the request was held for 45 s, answered 404, and the attempt died — measured 2026-08-06, with the encoder meanwhile producing happily from zero. This used to work by accident: the proxy inferred a seek from a far segment request. It deliberately no longer does — a request steers nothing and every restart comes from a position the viewer stated — so the position now goes to the proxy as well.
- **Fix**: A refresh no longer blanks the address bar. The magnet was deleted from it on load, back when it was a one-shot input from a shared link; the address now carries the application's state, so wiping it meant an empty bar until playback started and put the magnet back — and anything done in that window, a second refresh or a bookmark, lost the torrent.

## 0.8.110

- **New**: The browser records its transport counters every five seconds — bytes received and sent by the transport itself, messages and bytes delivered by the data channel, the round-trip time and the state of the path in use. It had none: the proxy could say how much it handed to its transport, and nothing said how much arrived here, so a loss could not be placed. Field 2026-08-06: the proxy reported a 9.26 MB segment fully sent at 274 Mbit/s with an empty send queue, this side never saw it, and everything sent afterwards vanished the same way while requests in the other direction kept working. Whether those bytes reached the machine at all separates three quite different faults — lost on the path, never actually transmitted, received but not delivered by SCTP — and only this counter tells them apart. The proxy samples on the same cadence (2.9.113), so the two logs subtract.

## 0.8.109

- **Fix**: "Starting now" was shown for the whole of a wait. The guard that keeps the countdown from increasing caps each estimate at the previous one minus the time since — and once that reached zero it pinned everything after it there, because the reset was wired to a seek and to a new attempt, and neither of those is what ends an ordinary wait. Measured 2026-08-06: the sum said 3.5 s on an empty buffer and the viewer was shown 0.00, unchanged, for dozens of samples in a row. A wait that ends now releases the promise it made, so the next one starts over.

## 0.8.108

- **Fix**: Asking for a new torrent now clears the address. The writer returned early when there was no source, so "New Torrent" on the error screen left the previous `?magnet=…` in the address bar — and a reload, or a bookmark taken at that moment, reopened the very torrent that had just been abandoned. Leaving a torrent for the picker is navigation, so it earns a history entry; arriving at an already-empty address does not. Nothing else could have done this: every other write is driven by an event of the `<video>` element, and by then there is nothing playing.
- **Chore**: Writing the state the address already names is now a no-op rather than a redundant replace.

## 0.8.107

- **Fix**: Refreshing the page threw `Cannot set property startPosition of #<e> which has only a getter` and nothing played. Where to begin buffering was being assigned to the hls.js instance, where it is a getter — the writable one is the configuration handed to the constructor, and a module runs in strict mode, so the assignment throws rather than being ignored. It only ever ran on a resume, so it stayed hidden until the address bar began carrying the position on every reload and the throw became the normal case.

## 0.8.106

- **New**: Back and Forward work. The browser restores an address and nothing else, so the address is the whole instruction, and it is turned into the cheapest correct action for wherever the viewer already is: another torrent is loaded from scratch, another file of the same torrent is only opened, the same file is only seeked, and a difference of a second is not a navigation at all. Back from an episode returns to the previous one at the place it was left — or from its start, when it was left by moving on to the next. Back from the first episode shows the file list, and back from there the picker. Nothing in the handler writes history: the push-or-replace rule already makes that safe, since after a restore the address names the state, but a `timeupdate` from the file being left can arrive mid-transition when the address and the player disagree, and that one would have pushed.

## 0.8.105

- **New**: Browser history now walks what was watched. Changing file or torrent adds an entry, so Back returns to the previous episode — or the previous page of a comic — while the playhead moving only ever rewrites the entry it is in, so a two-hour film leaves exactly one entry behind instead of thousands. The rule is one line and is decided by comparing the address with the state being written, which also makes Back safe by construction: after the browser restores an entry the address already names that state, so the app's own write replaces and cannot bury the history it is walking.
- **New**: Moving on to the next episode drops the position of the one being left, so Back opens it from the start; jumping to some other file keeps the position, so Back returns to where the viewer was. The intention is read from the DESTINATION rather than from how far through the file they got — credits run for different lengths in every release and most people skip them, so no "near enough to the end" threshold could be right. "Next" means next in the playlist, not the next index, since a pack also carries subtitles, samples and artwork.
- **Chore**: The address follows the playhead every two seconds instead of five, so a bookmark is never more than two seconds out. Fifteen writes per thirty seconds against the hundred at which Safari — the strictest, and the same engine on iOS — begins refusing.
- **Chore**: First tests in this repo (`npm test`). The address-bar rules are easy to state and easy to get wrong in combination — an entry per episode but not per second, a position that survives a jump but not the end of an episode, a Back button that walks history rather than burying it — so the decisions are pure functions in `public/domain/url-state.js` and the matrix is covered case by case.

## 0.8.104

- **New**: The address bar describes what is on screen — which torrent, which file, and where in it — so a bookmark reopens exactly that. It was doing the opposite: the URL was read once on load and then wiped (`params.delete` + `replaceState`), so during playback it was empty and nothing could be recovered from it. Query parameters rather than a path, because a magnet is long and full of characters a path segment cannot hold; they are the same three the share link already builds and the loader already parses. Written with `replaceState`, never push, so a film does not bury the viewer's history under hundreds of entries: on the events where the position has settled (seek finished, pause, play), when the tab is hidden or unloaded, and while playing at most once every five seconds — six calls per thirty seconds, an order of magnitude below the rate at which any browser starts throttling.
- **New**: When the proxy has lost the transcode session, the player builds another one and carries on from the same second. A session can vanish under a healthy player — disposed after the browser was away, or the proxy restarted — and every request then answers 404, which the player had no way to interpret: it polled a dead id indefinitely behind a spinner, measured at eleven minutes in the field. Nothing has to be fetched again to recover, since the source, the file and the position are all already in hand. Detected by the keep-alive ping, which is the one request that runs in every state.

## 0.8.103

- **Fix**: Playback no longer dies ten minutes after a pause. Reproducible at will — pause, wait ten minutes — and every request then answered 404: the proxy had disposed the transcode session as idle. It was right to. A paused browser goes completely silent, counted in the log as 39, 17, 11, 4 and 5 requests in the last active minutes and then **nothing at all for thirteen**, so the only signal the proxy has said the viewer had left. The root cause is that presence was asserted once, when the session was created, and never again, while what expires is a count of media requests; during playback those two agree only by accident, because fetching segments happens to keep the timer alive. The browser now re-asserts presence for as long as it holds a session — a ping every 30 s against the progress endpoint, which the proxy already counts as an access, twenty chances to be heard before the timeout and a 44-byte response each. It starts with the first session and stops with the last, so a viewer who really has gone still frees the session on the proxy's own timer. Full chain of reasoning, and two related gaps left open on purpose rather than patched over: `research/dead-channel-2026-08-06.md`.

## 0.8.102

- **New**: Control messages travel on their own channel. Seek, session create and release, progress, stats and the link report now go down a second data channel; segment and stream bodies keep the original one. One channel carried both, and SCTP delivers a stream in order, so a 300-byte seek written after an 8 MB segment waited for that segment to finish going out — on the 1-5.8 Mbit/s measured on cellular, 11 to 64 seconds, which is how late the proxy would learn the viewer had moved. Measured on the LAN there is nothing to gain and nothing is expected to change: control responses already left in 1-4 ms while 6-11 MB segments were being pushed, and the send buffer never accumulated. The proxy needs no change — it already accepts each channel separately and answers on the one a request arrived on — and a browser that meets an older proxy, or whose second channel does not open, falls back to the single channel it uses today. Reasoning, measurements and how to verify: `research/control-channel-2026-08-05.md`.

## 0.8.101

- **Fix**: The time until playback is now one end-to-end number for both a cold open and a seek, computed as a sum of the stages that have not happened yet instead of a choice between figures that each described only one of them. Choosing was the fault: the number answered "how long until the NEXT stage ends" and changed meaning as stages completed, which is why it jumped from 5.5 s to 15 s the instant the download finished, and why it printed 0.00 — "starting now" — for the whole 13.7 s of a measured seek and for four seconds of a cold open with an empty buffer. The sum is: bytes still missing over the measured download rate, plus creating the session, plus producing a first segment, plus the media still needed over the rate media arrives at. Each term is zero once its stage is done, so the total can only fall, and each is a measurement — the two middle ones are medians the proxy takes of its own recent runs, which matters because producing a first segment is 0.8-1.5 s when video is copied and around 7 s when it is re-encoded. Replayed against the two instrumented sessions: a cold open now reads 20.0 → 12.6 → 10.5 → 5.0 → 0.4 → 0.1 against a true 7.9 → 5.8 → 5.8 → 3.6 → 1.5 → 0.2, and the seek that used to read zero throughout reads 11.8 → 11.0 → 2.1 → 1.1 against a true 13.7 → 10.7 → 5.7 → 1.7.
- **Chore**: The buffer's fill rate is gone from the estimate. It was an attempt to measure three stages with one figure and could not: media arrives in ~10 s steps, so between two arrivals the measured rate decayed although nothing had slowed — an estimate built on it climbed from 11.9 s to 13.7 s while the real remaining time fell to 0.25 s — and before the first arrival there was no rate at all.
- **Chore**: How much buffer the player needs before it starts is no longer a chosen constant. It was 15 s, and 2 s after a seek; measured, the player actually started at 0.5 s, at 2.0 s and at 20.0 s in three different cases. The browser now records what it needed at each `playing` event and uses the median of the last few, with one segment as the floor because no player starts on less than one. Reasoning and every field number: `research/playback-eta-2026-08-05.md`.

## 0.8.100

- **Fix**: The estimate no longer says "starting now" while nothing has arrived. Measured on a session with 13-22 peers and re-encoded video: a seek to 34:02 took **13.7 s**, and for essentially all of it the figure read **0.00** — the same "100% • starting now on a frozen player" this project removed once before, reintroduced by 0.8.99's small post-seek target, which a healthy pipeline rate divides down to nothing. While the buffer holds nothing at all, the wait still contains a whole first segment that has to be encoded and carried, so the figure is now floored by exactly that: the host's own measured time to a first segment plus the same cautious delivery price the cold-start branch uses. On that session the floor would have read ~9 s against a real 13.7 s.
- **Fix**: A cold open no longer spends its first ticks counting toward the wrong cushion. "Is this the first open" was asked as `#isProcessing`, which is still false for the first moments of one, so two ticks counted toward the 2 s post-seek target while the real gate was going to hold out for 15 s. It now asks whether the player has ever actually played, which is the thing that distinguishes the two cases.

## 0.8.99

- **Fix**: The time until playback is a countdown again, and a much closer one. Replayed against a fully instrumented session — first figure at 9.9 s before playback actually began — the old sequence shown was 15 → 21 → 5.5 → 15 → 11.9 → 12.2 → 12.6 → 12.9 → 13.3 → 13.7 → 0, with two jumps upward and a fall from 13.7 straight to zero. The same session now reads 15.0 → 7.6 → 5.5 → 3.3 → 1.2 → 0.0 against a true 9.9 → 7.9 → 5.8 → 3.6 → 1.5 → 0.2: every figure after the first is within 0.3 s, and none of them grows. Five separate faults, each found from the `[eta]` diagnostic and the proxy log side by side:
  - the first download estimate had no trend behind it, because a rate sample was only kept when the speed was above zero and a cold torrent's first tick reads zero — so the second tick still divided by the instant rate, 21.3 s against a real 7.9 s. Zero is now recorded, and that moment projects to 7.6 s;
  - when the download finished with no session yet, the figure fell back to assuming realtime and leapt from 5.5 s up to 15 s with 3.8 s left. It now uses what the proxy measured itself taking to make a first segment, plus a cautious price for delivering it;
  - the number was allowed to increase. It no longer can within one wait: each estimate is capped by the previous one minus the time since, and only a real event — a seek, another file — lets it start over;
  - the buffer's fill rate decayed while the buffer sat still between two segment arrivals, so an estimate built on it climbed from 11.9 s to 13.7 s while the real remaining time fell to 0.25 s. A gap between arrivals is no longer counted as a slowdown;
  - after a seek the figure counted toward a 15 s cushion that nothing enforces — the player resumes by itself, measured at **0.5 s** buffered, so it still read 4.9 s once playback had already resumed. A seek now counts toward what actually gates it.

## 0.8.98

- **Fix**: The time until playback no longer says three times what it turns out to be. While the torrent is still the thing being waited for, the figure divided what was left by the speed at that instant — right when a cold swarm is still climbing, measured on one session at 74 KB/s, then 1264, 2635, 3587, 3987 two seconds apart. Every error went the same way and the worst of them landed at the moment a viewer is most likely to be looking: 35 s shown with 4.7 s to go, 8.5 s with 2.5 s, and 19 s with 6.2 s. The climb is now part of the estimate — for a rate `v` rising at `a`, the bytes left take the time that solves `R = v·t + a·t²/2` — which turns those three into 10.4 s, 4.8 s and 6.6 s against the same 4.7, 2.5 and 6.2. A rate that has levelled off has no slope, so a settled connection gets exactly the old arithmetic; a falling rate is never projected, and the projection may not claim an average more than four times what is being achieved now.
- **New**: The `[eta]` diagnostic says which of the four measurements produced the number on screen — the buffer's own fill rate, the pipeline's production rate, the download, or the realtime floor — along with the download speed and bytes outstanding it was given. It remains ONE figure, seconds until playback; this records where each value of it came from, which is the first question whenever a shown number turns out wrong. Forwarded to the server log, so a field report can be checked without the device.

## 0.8.97

- **Fix**: The loading screen's Playlist button sits next to Cancel and looks like it. It was added as an unstyled button and rendered as the browser's default control, left-aligned on a line of its own above Cancel. Both — and the mid-load action button, which had no styling either — now share one rule and one centred row, with the gap carried by the buttons themselves rather than by a wrapper introduced to hold two of them.

## 0.8.96

- **New**: The proxy is told to start the torrent as soon as one is opened, without waiting for an episode to be chosen. Announcing to trackers, connecting to peers and being unchoked by them takes seconds and does not depend on which file is wanted; on a torrent holding a single video the two pieces the codec probe reads are fetched as well. The request is never waited on and never surfaces a failure: everything it does the ordinary path does again for itself, and both steps are cached, so a warm-up that does not happen costs only the time it would have saved. Most useful on a season pack, where the viewer spends seconds reading the list — a single-file torrent has no such pause to fill.

## 0.8.95

- **Fix**: Picking a video from the error screen works again. "Choose File" reveals the player and opens the playlist, and the entry it highlights is the file that just failed — but a click on the entry already marked active did nothing but close the list, which is right while that file is playing and wrong when it is the thing that broke. The viewer was left looking at an empty player with no way forward. Re-picking the active file is now honoured whenever the application is in its error state.
- **New**: The state machine announces where it is (`APP:STATE_CHANGED`). It kept its state entirely private, so components that needed to behave differently depending on it — the playlist, above — had to infer it from whichever events they happened to see.
- **New**: A long load offers a way out other than giving up. The loading screen now has a Playlist button next to Cancel, shown when the torrent holds more than one video, so a viewer waiting on a file nobody is sharing can switch to another episode instead of cancelling and starting over. The screen is a modal dialog, so it steps aside for the drawer and returns if the drawer is closed without a choice.
- **Fix**: A file with no seeders is no longer reported as a failure. After three minutes of waiting for the header the load used to drop to the error screen, which was wrong twice over: nothing is broken, and retrying cannot help — someone may start sharing in a minute or never. The wait now continues and the screen says so plainly, with live peers, speed and progress still updating underneath; the viewer leaves by cancelling or by picking another video.

## 0.8.94

- **Fix**: A file whose audio is MP3 no longer loads forever without playing. The browser asked itself the wrong question: MP3 support was probed as `audio/mpeg; codecs="mp3"`, the container the track is NOT delivered in, and the fallback used `canPlayType`, which answers "probably" for types MediaSource then refuses — measured in Chromium, `canPlayType('audio/mp4; codecs="mp4a.69"')` is "probably" while `MediaSource.isTypeSupported` on the same string is false. So the track was copied into fMP4, hls.js could not create a buffer for it, and it reloaded the playlist every 1.2 s forever (field 2026-08-04: 45 s of `index.m3u8` → `init.mp4` → `segment-00000.mp4` with the encoder healthy at 2.2x). Copy compatibility is now decided by `MediaSource.isTypeSupported` on the type the track will actually be appended as, per container.
- **New**: The browser picks the segment container when the codec it wants copied demands one. fMP4 stays the default and the proxy's `--segment-format` still decides everything else — MediaSource takes Opus, FLAC, AV1 and VP9 inside MP4 and has no place for them in MPEG-TS, and an fMP4 segment reaches the decoder without hls.js rebuilding it. MPEG-TS is asked for in exactly one case: a copied MP3 track, which hls.js can only carry by demuxing the transport stream and appending to a plain `audio/mpeg` buffer (verified in our own `vendor/hls.min.js`, which falls back to that buffer when no MP4 codec string is supported). Without a preference nothing is sent and the proxy's setting stands.

## 0.8.93

- **Chore**: Browser-side receive timing for data-channel responses, the counterpart to the proxy's transfer instrumentation. Each body over 64 KB logs `[dc-recv]` with `waitMs` (request sent → first body byte, i.e. time spent on the proxy) and `transferMs` (first byte → last, i.e. time on the wire), plus chunk count and resulting rate. The two sides together locate a slow segment delivery without guessing: proxy-side production, transfer, or the browser's own handling.

## 0.8.92

- **Fix**: The browser now tells the proxy **where the viewer seeked**, instead of leaving it to guess from segment requests. A scrub emits a continuous stream of `seeking` events; 300 ms after the last one the settled `currentTime` is posted to the proxy session. This is the only place the intent exists — measured on the proxy side, one seek leaves ~25 concurrent segment requests outstanding across a wide span, so no rule over them can recover which position the viewer meant (it caused nine encoder restarts in one minute and a ~70 s seek). Requires proxy 2.9.62+; on older proxies the post is ignored and behaviour is unchanged.

## 0.8.91

- **Chore**: Widened the hls.js fragment retry budget (`fragLoadPolicy` `maxNumRetry` 8 → 12) to match proxy 2.9.57, which now answers a not-yet-produced segment with a retryable 503 after ~2 s instead of holding the request open for up to 30 s (required to stay under iOS AVPlayer's ~3.5 s response-header deadline). A slow segment is therefore spread across more retries than before; with the existing growing delay this budget still covers well over a minute of production time.

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
