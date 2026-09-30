/**
 * @file A signal that fires when the browser that sent a request goes away.
 *
 * Cancelling it ends that request's wait and nothing else: a shared fetch it
 * joined keeps running for whoever else is waiting and for the cache.
 */

/**
 * @param {import("fastify").FastifyReply} reply
 * @returns {AbortSignal}
 */
export function signalOfRequest(reply) {
  const controller = new AbortController();
  reply.raw.once("close", () => {
    if (!reply.raw.writableEnded) {
      controller.abort();
    }
  });
  return controller.signal;
}

/** A language tag: `en`, `en-US`. */
export const LANGUAGE = /^[a-z]{2}(?:-[A-Z]{2})?$/;
