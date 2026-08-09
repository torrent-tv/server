# waiting

The one interface a viewer sees while the picture cannot move — a cold open, a
seek into data that has not arrived, and starvation mid-playback are the same
wait and get the same overlay. There is no separate loading screen.

## Nobody tells it what to display

It subscribes to facts and rebuilds itself from them:

- `PLAYER:BUFFER` — how much media is buffered ahead and how fast that is
  filling, measured by the component that owns the `<video>`.
- `PROXY:MEASURED` — the proxy's poll answers, exactly as the proxy gave them.
- `WAITING:STEP` — the name of the step the pipeline has reached.
- `APP:STATE_CHANGED` — a wait that has ended takes its measurements with it.

There is no event meaning "display this". That is deliberate: while one existed,
a caller passed the overlay its own rendered text back as the step, every later
render appended its rows to that, and the line grew until it ran off the screen.
Measured 2026-08-09 at 53 rows. Removing the ability, rather than the one path,
is what closed it.

## Where the parts live

| what | where | tested by |
|---|---|---|
| the words | `domain/waiting-text.js` | `test/waiting-text.test.js` |
| the figures | `domain/waiting-model.js` | `test/waiting-model.test.js` |
| the buffer readings | `domain/buffer-metrics.js` | `test/buffer-metrics.test.js` |
| subscriptions + the element | this component | — |

A Humble Object split: a view with arithmetic in it can only be checked by
looking at it, so everything deciding WHAT the figures are lives in a class with
no DOM.

## Visibility is not its business

Whether the overlay is on screen is a function of the application state
(`isWaiting`), applied by `Player`. This component owns only what it says.

## Rules

- No text ever stands in for a number. No "0%", no "estimating…", no "starting
  now". A row with nothing measured to report is absent.
- One line per encoder run still going, not one averaged line — two runs sharing
  the same cores slow each other down, and that is exactly what an average hides.
