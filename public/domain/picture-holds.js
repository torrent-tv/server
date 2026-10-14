/**
 * @file Who holds the picture while the stream is made ready for a change the
 * viewer asked for, and when a seek's hold may end (torrent-tv/meta#178).
 *
 * Two changes hold the picture today: a soundtrack published as its own
 * rendition, and a seek the proxy does not yet forecast it can play on from.
 * Both are one hold to the state machine (`SWITCHING`); this decides when that
 * hold begins and ends. The picture moves again only when no owner holds it,
 * so a seek finishing cannot release a soundtrack still being prepared, nor
 * the other way round, and a later seek takes the hold over from an earlier
 * one: the earlier seek's late answer releases nothing.
 */

export class PictureHolds {
  /** @type {Set<string>} */
  #owners = new Set();
  #seekSeq = 0;
  #signal;

  /**
   * @param {{ held: () => void, released: () => void }} signal - Called when
   *   the hold is raised (every time an owner takes it — the machine's
   *   self-transition) and when the last owner lets it go.
   */
  constructor(signal) {
    this.#signal = signal;
  }

  /** @param {string} owner */
  take(owner) {
    this.#owners.add(owner);
    this.#signal.held();
  }

  /** @param {string} owner */
  release(owner) {
    if (!this.#owners.delete(owner) || this.#owners.size > 0) return;
    this.#signal.released();
  }

  /**
   * A seek takes the hold, in the place of any earlier seek.
   *
   * @returns {number} Which seek holds the picture now.
   */
  beginSeek() {
    const seq = ++this.#seekSeq;
    for (const owner of [...this.#owners]) {
      if (owner.startsWith("seek:")) this.#owners.delete(owner);
    }
    this.take(seekOwner(seq));
    return seq;
  }

  /** Whether this seek still holds the picture. @param {number} seq */
  holdsSeek(seq) {
    return seq === this.#seekSeq && this.#owners.has(seekOwner(seq));
  }

  /** @param {number} seq */
  releaseSeek(seq) {
    this.release(seekOwner(seq));
  }

  get held() {
    return this.#owners.size > 0;
  }
}

/** @param {number} seq */
function seekOwner(seq) {
  return `seek:${seq}`;
}

/**
 * What one answer of the proxy's forecast means for a seek's hold.
 *
 * The forecast is the one the first start waits for (`playbackReadiness`):
 * production, delivery and the proxy's own stock for the viewer's position.
 * An answer to a request sent before the seek was reported may describe the
 * old position and is not read. A proxy that states no forecast releases the
 * hold, as a seek was released before there was one.
 *
 * @param {{ readiness: { version?: number, ready?: boolean } | null | undefined,
 *   requestedAt: number, reportedAt: number }} answer - When the request was
 *   sent and when the proxy was told of the seek, on one clock.
 * @returns {"release" | "wait" | "stale"}
 */
export function seekHoldAnswer({ readiness, requestedAt, reportedAt }) {
  if (!(requestedAt >= reportedAt)) return "stale";
  if (readiness?.version !== 1) return "release";
  return readiness.ready === true ? "release" : "wait";
}
