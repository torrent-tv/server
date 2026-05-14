/**
 * Returns the current date and time as an ISO 8601 string.
 *
 * @returns {string} e.g. "2026-05-17T12:00:00.000Z"
 */
export function nowIso() {
  return new Date().toISOString();
}
