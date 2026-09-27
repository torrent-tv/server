/**
 * @file What the proxy answered about THIS viewer's output, when it answered
 * with something other than bytes.
 *
 * Two answers, and each asks the page to do something (roadmap item 97, step
 * 11):
 *
 * 1. `output-unavailable` — nothing the proxy holds or could make is admitted
 *    by this viewer's link. The proxy does not hand over a stream it knows the
 *    link cannot carry; the page tells the viewer, with the reason, and keeps
 *    what is playing;
 * 2. `assignment-lost` — a part of the film this viewer was already given came
 *    from an output that has gone, and nothing proven to match it can stand in.
 *    The page starts a new viewing where the picture is, which is the one way
 *    out that never puts a piece under a header it may not match. Repeating the
 *    same request would be answered the same way for ever.
 *
 * The loader reads the answers and does not act on them: it has no player and
 * no viewer. Whoever built the player listens here.
 *
 * AN OUTCOME NAMES THE VIEWING IT BELONGS TO. The channel is one list for the
 * whole page, and an answer to a request made before a seek, or for the file
 * played before this one, can arrive after the page has moved on. Acted on
 * then, `assignment-lost` would seek and reload the video now on screen for a
 * part of another viewing. So every outcome carries the output its request
 * addressed and the generation its request was stamped with, and the page acts
 * only on one that is its own (`outcomeBelongsTo`).
 */

/**
 * @typedef {object} ProxyOutcome
 * @property {string} outcome - `output-unavailable` or `assignment-lost`.
 * @property {string} reason
 * @property {object | null} figures
 * @property {string} path - What was asked for, as it was sent.
 * @property {string} outputId - The output the request addressed: the first
 *   part of the path after `/transcode/`, or empty for any other path.
 * @property {number | null} generation - The viewing the request was stamped
 *   with when it was sent, or null when it carried none.
 */

/** @type {Set<(outcome: ProxyOutcome) => void>} */
const listeners = new Set();

/**
 * Which output and which viewing a request path names.
 *
 * Read from the path as it was SENT: the loader stamps the generation into the
 * query at the moment it builds the request, which is the only moment that
 * says which viewing the request belongs to.
 *
 * @param {string} path
 * @returns {{ outputId: string, generation: number | null }}
 */
export function viewingOfPath(path) {
  const text = typeof path === "string" ? path : "";
  const queryAt = text.indexOf("?");
  const pathname = queryAt >= 0 ? text.slice(0, queryAt) : text;
  const query = queryAt >= 0 ? text.slice(queryAt + 1) : "";
  const named = /^\/transcode\/([^/]+)\//.exec(pathname);
  let outputId = "";
  if (named) {
    try {
      outputId = decodeURIComponent(named[1]);
    } catch {
      // silent-ok: a part that does not decode names no output of ours.
      outputId = "";
    }
  }
  const stated = new URLSearchParams(query).get("generation");
  const generation = stated !== null && /^\d+$/.test(stated) ? Number(stated) : null;
  return { outputId, generation };
}

/**
 * Parse a proxy answer body into an outcome, or null when it names none.
 *
 * @param {unknown} parsed - The JSON body of a refused request.
 * @param {string} path - What was asked for, as it was sent.
 * @returns {ProxyOutcome | null}
 */
export function outcomeOf(parsed, path) {
  const outcome = typeof parsed?.outcome === "string" ? parsed.outcome : "";
  if (outcome !== "output-unavailable" && outcome !== "assignment-lost") {
    return null;
  }
  const sent = typeof path === "string" ? path : "";
  return {
    outcome,
    reason: typeof parsed?.reason === "string" ? parsed.reason : "",
    figures: parsed?.figures && typeof parsed.figures === "object" ? parsed.figures : null,
    path: sent,
    ...viewingOfPath(sent)
  };
}

/**
 * Whether an outcome belongs to the viewing on screen now.
 *
 * 1. The output its request addressed must be the one the page is playing. An
 *    answer about the file before this one says nothing about this one.
 * 2. The generation its request was stamped with must be the page's current
 *    one. A lower one belongs to a viewing the viewer has left by seeking; the
 *    page raises its own number before it sends anything, so a higher one
 *    cannot be the page's and is not accepted either.
 * 3. A request that carried no generation — a transport with no loader of
 *    ours — has one viewing, so rule 2 does not apply to it; rule 1 still does.
 *
 * @param {Pick<ProxyOutcome, "outputId" | "generation">} outcome
 * @param {{ sessionId: string | null | undefined, generation: number }} current
 * @returns {{ belongs: boolean, reason: string }}
 */
export function outcomeBelongsTo(outcome, current) {
  const playing = typeof current?.sessionId === "string" ? current.sessionId : "";
  if (!playing) {
    return { belongs: false, reason: "no output is being played" };
  }
  if (outcome?.outputId !== playing) {
    return { belongs: false, reason: `it is about output ${outcome?.outputId || "unknown"}, and ${playing} is being played` };
  }
  if (outcome.generation !== null && outcome.generation !== undefined && outcome.generation !== current.generation) {
    return { belongs: false, reason: `its request was made in viewing ${outcome.generation}, and this is viewing ${current.generation}` };
  }
  return { belongs: true, reason: "" };
}

/**
 * Tell whoever listens.
 *
 * @param {ProxyOutcome} outcome
 * @returns {void}
 */
export function noteProxyOutcome(outcome) {
  for (const listener of [...listeners]) {
    try {
      listener(outcome);
    } catch (error) {
      console.warn("[torrent-tv] a proxy outcome listener failed", error);
    }
  }
}

/**
 * Listen for outcomes. Returns the function that stops listening.
 *
 * @param {(outcome: ProxyOutcome) => void} listener
 * @returns {() => void}
 */
export function onProxyOutcome(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * A request the proxy answered with `output-unavailable`, as an error the
 * loading flow can recognise and explain.
 */
export class OutputUnavailableError extends Error {
  /**
   * The message IS what the viewer is told: every failure path of the loading
   * flow shows `error.message`, so an error that already speaks in the viewer's
   * terms needs nothing added at any of them. The proxy's own reason and the
   * figures stay on the error for the log.
   *
   * Retry is offered: the answer is judged against the link as it measures
   * now, and a link changes.
   *
   * @param {{ reason?: string, figures?: object | null }} body
   * @param {number} [height] - The quality asked for, when there was one.
   */
  constructor(body, height = 0) {
    super(describeUnavailable(body, height));
    this.name = "OutputUnavailableError";
    this.outcome = "output-unavailable";
    this.reason = typeof body?.reason === "string" ? body.reason : "";
    this.figures = body?.figures && typeof body.figures === "object" ? body.figures : null;
    this.canRetry = true;
  }
}

/**
 * A request the proxy answered with `no-capacity`: THIS MACHINE cannot take the
 * video now — no place for one more encoder beside what it already runs, or no
 * encoding mode it has shown it can hold for this picture (roadmap item 97,
 * step 14). The loading flow answers it by asking the rest of the pool, before
 * anything plays; the message is what the viewer sees only when nobody else can.
 */
export class NoCapacityError extends Error {
  /**
   * @param {{ reason?: string, figures?: object | null }} body
   */
  constructor(body) {
    super("This proxy is busy with other viewers right now. Press Retry in a moment, or pick a different file.");
    this.name = "NoCapacityError";
    this.outcome = "no-capacity";
    this.reason = typeof body?.reason === "string" ? body.reason : "";
    this.figures = body?.figures && typeof body.figures === "object" ? body.figures : null;
    this.canRetry = true;
  }
}

/**
 * What the viewer is told, in terms of their connection and the film — not in
 * terms of the proxy's parts. The figures travel beside it for the log.
 *
 * @param {{ figures?: object | null }} outcome
 * @param {number} [height] - The quality they asked for, when there was one.
 * @returns {string}
 */
export function describeUnavailable(outcome, height = 0) {
  const figures = outcome?.figures ?? null;
  // The share of the link a stream may use, which is what the proxy compared
  // against — the whole reading would say "fits" where it did not.
  const link = Number(figures?.linkMbps) * (Number(figures?.linkSafety) || 1);
  const needed = Number(figures?.totalMbps);
  const what = height > 0 ? `${height}p` : "This video";
  if (figures?.verdict === "no safe bound") {
    return `${what} can't be confirmed to fit your connection: the proxy can't bound how much it would send. ` +
      "Choose a lower quality, or try again on a faster connection.";
  }
  if (Number.isFinite(link) && Number.isFinite(needed)) {
    return `${what} needs about ${needed.toFixed(1)} Mbit/s and your connection carries about ` +
      `${link.toFixed(1)} Mbit/s. Choose a lower quality, or try again on a faster connection.`;
  }
  return `${what} doesn't fit your connection right now. Choose a lower quality, or try again later.`;
}
