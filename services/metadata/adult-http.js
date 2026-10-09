/**
 * @file The request shape shared by the adult databases: one gate, one
 * deadline, a bounded body, and a refusal that says nothing about the work.
 */

import { readBoundedBody } from "./bounded-body.js";
import { MetadataUnavailableError } from "./RequestGate.js";
import { providerResponseError } from "./provider-diagnostics.js";

/** Largest answer read from an adult database, in bytes. A stated limit. */
const MAX_ANSWER_BYTES = 256 * 1024;

/** Deadline of one request, in milliseconds. */
const REQUEST_DEADLINE_MS = 4000;

/**
 * One request through the gate, answered as parsed JSON.
 *
 * @param {object} params
 * @param {typeof fetch} params.fetch
 * @param {import("./RequestGate.js").RequestGate} params.gate
 * @param {string} params.label - The database, for the refusal text.
 * @param {string} params.url
 * @param {RequestInit} params.init
 * @returns {Promise<any>}
 * @throws {MetadataUnavailableError}
 */
export function requestJson({ fetch, gate, label, url, init }) {
  return gate.run(async () => {
    let response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_DEADLINE_MS) });
    } catch (cause) {
      throw new MetadataUnavailableError(`${label} did not answer`, { cause });
    }
    if (response.status === 429) {
      const retry = Number(response.headers.get("retry-after"));
      gate.pause(Date.now() + (retry > 0 ? retry : 60) * 1000);
    }
    if (!response.ok) throw new MetadataUnavailableError(`${label} refused the request`, { cause: await providerResponseError(response) });
    try {
      return JSON.parse((await readBoundedBody(response, MAX_ANSWER_BYTES)).toString("utf8"));
    } catch (cause) {
      throw new MetadataUnavailableError(`${label} returned invalid data`, { cause });
    }
  }, { deadlineAt: Date.now() + 10_000 });
}

/**
 * A release name as words, for a text search: the separators of a release
 * name become spaces, and the tags after the title are left to the database.
 *
 * @param {string} name
 * @returns {string}
 */
export function wordsOf(name) {
  return String(name ?? "").replace(/\.[a-z0-9]{2,4}$/iu, "").replace(/[._]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 200);
}

/** The year of an ISO date, or `undefined`. */
export function yearOf(date) {
  const year = Number(String(date ?? "").slice(0, 4));
  return Number.isInteger(year) && year >= 1888 && year <= 2100 ? year : undefined;
}
