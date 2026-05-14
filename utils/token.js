/**
 * Validate a token sent by a proxy client against the server's configured token.
 *
 * Rules:
 * - If the server has no token configured (empty string) → accept everything.
 * - If the server has a token configured, the client token must match it exactly.
 *   An empty or missing client token is rejected in this case.
 *
 * @param {string} serverToken  - Token read from the server environment (may be empty).
 * @param {string} clientToken  - Token received from the proxy client (may be empty).
 * @returns {boolean} `true` if the client is allowed to proceed.
 */
export function isTokenValid(serverToken, clientToken) {
  if (!serverToken) {
    return true;
  }
  return clientToken === serverToken;
}
