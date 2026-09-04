/**
 * @file Which proxies may be chosen, and why it is never a filter.
 *
 * The second preference is content affinity: a viewer of a film some proxy is
 * already downloading costs that proxy the encode and nothing else, while the
 * same viewer sent anywhere else starts the download from nothing. Everything
 * the score reads is about the machine and none of it is about the film, so
 * without this two strangers watching one film land together only by chance.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { choosePool } from "../public/domain/proxy-preference.js";

const reachable = (id, extra = {}) => ({ id, reachable: true, sameNetwork: false, ...extra });

test("a proxy already downloading this film is preferred", () => {
  const { pool, narrowedBy } = choosePool([
    reachable("idle-but-empty"),
    reachable("has-the-film", { holdsThisFilm: true })
  ]);

  assert.deepEqual(pool.map((one) => one.id), ["has-the-film"]);
  assert.equal(narrowedBy, "content");
});

test("a saturated holder is not preferred, so a popular film does not pile onto one proxy", () => {
  // cpuLoad is the load average per processor, so 1 is "fully utilised" by the
  // definition of the figure — not a threshold chosen here.
  const { pool } = choosePool([
    reachable("busy-holder", { holdsThisFilm: true, metrics: { cpuLoad: 1.4 } }),
    reachable("free-but-empty", { metrics: { cpuLoad: 0.2 } })
  ]);

  assert.deepEqual(pool.map((one) => one.id), ["busy-holder", "free-but-empty"],
    "nobody is preferred, and the score's own order decides");
});

test("nobody holding it leaves every reachable candidate eligible", () => {
  const { pool, narrowedBy } = choosePool([reachable("one"), reachable("two")]);

  assert.deepEqual(pool.map((one) => one.id), ["one", "two"]);
  assert.equal(narrowedBy, "", "a preference that narrows nothing says so");
});

test("reachability narrows first, and content only within that", () => {
  const { pool, narrowedBy } = choosePool([
    { id: "unreachable-holder", reachable: false, sameNetwork: false, holdsThisFilm: true },
    reachable("reachable-empty"),
    reachable("reachable-holder", { holdsThisFilm: true })
  ]);

  assert.deepEqual(pool.map((one) => one.id), ["reachable-holder"]);
  assert.equal(narrowedBy, "reachability+content");
});

test("when nothing is reachable, everyone stays eligible", () => {
  // A failed inbound probe does not prove WebRTC cannot connect. Filtering here
  // would leave the viewer with no proxy at all.
  const { pool } = choosePool([
    { id: "a", reachable: false, sameNetwork: false },
    { id: "b", reachable: null, sameNetwork: false }
  ]);

  assert.deepEqual(pool.map((one) => one.id), ["a", "b"]);
});

test("an unreachable proxy holding the film is still preferred when nobody is reachable", () => {
  // The two preferences compose: reachability narrows to everyone, and content
  // then picks the one that has the film.
  const { pool } = choosePool([
    { id: "empty", reachable: false, sameNetwork: false },
    { id: "holder", reachable: false, sameNetwork: false, holdsThisFilm: true }
  ]);

  assert.deepEqual(pool.map((one) => one.id), ["holder"]);
});

test("nothing answered at all is not an error", () => {
  assert.deepEqual(choosePool([]).pool, []);
  assert.deepEqual(choosePool(undefined).pool, []);
});
