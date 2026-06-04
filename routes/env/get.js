/**
 * Expose the running server version to the browser as `window.env.version`,
 * so the deployed build can be verified at a glance (DevTools console:
 * `window.env.version`). Served dynamically so it always reflects the live
 * server, independent of any cached static asset.
 *
 * GET /env.js
 *
 * @param {import("fastify").FastifyRequest} _req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ version: string }} deps
 * @returns {Promise<void>}
 */
export async function handleEnvGet(_req, reply, { version }) {
  reply.header("Content-Type", "application/javascript; charset=utf-8");
  reply.header("Cache-Control", "no-store");
  return reply.send(
    `window.env = Object.assign({}, window.env, { version: ${JSON.stringify(version)} });\n`
  );
}
