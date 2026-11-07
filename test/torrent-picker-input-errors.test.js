import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ERROR_EVENTS, TORRENT_EVENTS } from "../public/shared/events.js";

/**
 * torrent-tv/meta#290: the picker reports a bad input the way the magnet field
 * does — constraint validation on the input — and never through ERROR:SHOW,
 * which only the ERROR state can show (IDLE cannot reach it). A view that
 * dispatches ERROR:SHOW from the picker leaves the viewer looking at nothing.
 *
 * The picker is exercised through a small DOM fake. No torrent is started: the
 * picker only reads bytes and dispatches DOM events.
 */

const publicDir = new URL("../public/", import.meta.url).pathname;
const MAGNET = "magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel";

/** A minimal valid single-file .torrent: the shape `parseTorrentBytes` reads. */
function validTorrentBytes() {
  const head = Buffer.from("d4:infod6:lengthi5e4:name5:a.mkv12:piece lengthi16384e6:pieces20:");
  return new Uint8Array(Buffer.concat([head, Buffer.alloc(20, 1), Buffer.from("ee")]));
}

let runs = 0;

async function mountPicker({ search = "" } = {}) {
  const keys = ["document", "window", "location", "history", "navigator", "HTMLInputElement"];
  const saved = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const define = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });

  class Node extends EventTarget {
    hidden = false;
    inert = false;
    value = "";
    files = null;
    attributes = new Map();
    setAttribute(name, value) { this.attributes.set(name, value); }
    removeAttribute(name) { this.attributes.delete(name); }
    hasAttribute(name) { return this.attributes.has(name); }
  }
  class Input extends Node {
    validationMessage = "";
    reported = [];
    setCustomValidity(message) { this.validationMessage = String(message); }
    reportValidity() { this.reported.push(this.validationMessage); return this.validationMessage === ""; }
  }
  class Dialog extends Node {
    get open() { return this.hasAttribute("open"); }
    showModal() { this.setAttribute("open", ""); }
    close() { this.removeAttribute("open"); }
  }
  class Form extends Node {
    controls = [];
    // HTML spec: requestSubmit() runs constraint validation (no novalidate on
    // the form) and fires NO submit event while any control is invalid; it
    // reports the first invalid control instead.
    requestSubmit() {
      const invalid = this.controls.find(control => control.validationMessage !== "");
      if (invalid) { invalid.reportValidity(); return; }
      this.dispatchEvent(new Event("submit", { cancelable: true }));
    }
  }
  const dialog = new Dialog();
  const form = new Form();
  const fileInput = new Input();
  const magnetInput = new Input();
  const demoButton = new Node();
  form.controls.push(fileInput, magnetInput);
  const nodes = new Map([
    ["#torrent", dialog], ["#torrent form", form], ["#torrent__input", fileInput],
    ["#torrent__magnet", magnetInput], ["#torrent__demo", demoButton]
  ]);
  const document = Object.assign(new EventTarget(), {
    readyState: "complete",
    querySelector: selector => nodes.get(selector) ?? null
  });
  define("document", document);
  define("window", {});
  define("location", { search, pathname: "/" });
  define("history", { replaceState() {} });
  define("navigator", { userAgent: "node" });
  define("HTMLInputElement", Input);

  const seen = { errors: [], files: [], magnets: [] };
  document.addEventListener(ERROR_EVENTS.SHOW, event => seen.errors.push(event.detail));
  document.addEventListener(TORRENT_EVENTS.FILE_DETAILS_READY, event => seen.files.push(event.detail));
  document.addEventListener(TORRENT_EVENTS.MAGNET_READY, event => seen.magnets.push(event.detail));

  await import(`../public/components/torrent/torrent.js?run=${runs++}`);
  const settle = () => new Promise(resolve => setTimeout(resolve, 25));
  await settle();

  const drop = files => {
    const event = new Event("drop", { cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { files } });
    document.dispatchEvent(event);
  };
  const choose = files => {
    fileInput.files = files;
    const event = new Event("change");
    Object.defineProperty(event, "currentTarget", { value: fileInput });
    fileInput.dispatchEvent(event);
  };
  const clickInput = () => {
    const event = new Event("click");
    Object.defineProperty(event, "currentTarget", { value: fileInput });
    fileInput.dispatchEvent(event);
  };
  const clickDemo = () => demoButton.dispatchEvent(new Event("click"));
  const paste = text => {
    const event = new Event("paste", { cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files: [], getData: () => text } });
    Object.defineProperty(event, "target", { value: document });
    document.dispatchEvent(event);
  };
  const restore = () => {
    for (const key of keys) {
      if (saved[key]) Object.defineProperty(globalThis, key, saved[key]);
      else delete globalThis[key];
    }
  };
  return { fileInput, magnetInput, form, seen, drop, choose, clickInput, clickDemo, paste, settle, restore };
}

function assertReportedInline(picker, expectedMessage) {
  const { fileInput, seen } = picker;
  assert.deepEqual(seen.errors, [], "no ERROR:SHOW: the IDLE state cannot show the error view, so the app stays in the picker");
  assert.notEqual(fileInput.validationMessage, "", "the file input carries a validation message");
  if (expectedMessage) assert.equal(fileInput.validationMessage, expectedMessage);
  assert.ok(fileInput.reported.length > 0, "reportValidity was called so the viewer sees the message");
  assert.equal(fileInput.reported.at(-1), fileInput.validationMessage);
  assert.deepEqual(seen.files, [], "no source is opened");
  assert.deepEqual(seen.magnets, []);
}

test("dropping a .mkv is reported on the file input and does not dispatch ERROR:SHOW", async () => {
  const picker = await mountPicker();
  try {
    picker.drop([new File(["x"], "movie.mkv", { type: "video/x-matroska" })]);
    await picker.settle();
    assertReportedInline(picker, "Only .torrent files are accepted.");
  } finally { picker.restore(); }
});

test("choosing a .mkv in the file dialog is reported on the file input", async () => {
  const picker = await mountPicker();
  try {
    picker.choose([new File(["x"], "movie.mkv", { type: "video/x-matroska" })]);
    await picker.settle();
    assertReportedInline(picker, "Only .torrent files are accepted.");
  } finally { picker.restore(); }
});

test("a .torrent that does not parse is reported on the file input", async () => {
  const picker = await mountPicker();
  try {
    picker.drop([new File(["this is not bencode"], "broken.torrent")]);
    await picker.settle();
    assertReportedInline(picker, "Could not parse torrent file.");
  } finally { picker.restore(); }
});

test("a bad ?torrent= base64 is reported on the file input", async () => {
  const picker = await mountPicker({ search: "?torrent=%25%25not-base64%25%25" });
  try {
    await picker.settle();
    assertReportedInline(picker);
  } finally { picker.restore(); }
});

test("a valid .torrent still proceeds as before", async () => {
  const picker = await mountPicker();
  try {
    const file = new File([validTorrentBytes()], "a.torrent", { type: "application/x-bittorrent" });
    picker.drop([file]);
    await picker.settle();
    assert.equal(picker.seen.files.length, 1, "FILE_DETAILS_READY is dispatched once");
    assert.equal(picker.seen.files[0].file, file);
    assert.ok(picker.seen.files[0].torrentBytes instanceof Uint8Array);
    assert.ok(picker.seen.files[0].meta, "the parsed metadata travels with the event");
    assert.deepEqual(picker.seen.errors, []);
    assert.equal(picker.fileInput.validationMessage, "");
  } finally { picker.restore(); }
});

test("a valid .torrent clears the message an earlier wrong file left", async () => {
  const picker = await mountPicker();
  try {
    picker.drop([new File(["x"], "movie.mkv")]);
    await picker.settle();
    assert.notEqual(picker.fileInput.validationMessage, "", "the wrong file is reported first");
    picker.drop([new File([validTorrentBytes()], "a.torrent", { type: "application/x-bittorrent" })]);
    await picker.settle();
    assert.equal(picker.seen.files.length, 1);
    assert.equal(picker.fileInput.validationMessage, "", "a good file clears the earlier message");
  } finally { picker.restore(); }
});

test("the magnet field keeps its constraint validation", async () => {
  const picker = await mountPicker();
  try {
    picker.magnetInput.value = "magnet:?dn=no-hash";
    picker.form.requestSubmit();
    assert.equal(picker.magnetInput.validationMessage, "That does not look like a magnet link.");
    assert.deepEqual(picker.magnetInput.reported, ["That does not look like a magnet link."]);
    assert.deepEqual(picker.seen.magnets, []);
    assert.deepEqual(picker.seen.errors, []);

    picker.magnetInput.value = MAGNET;
    picker.magnetInput.dispatchEvent(new Event("input"));
    await picker.settle();
    assert.equal(picker.magnetInput.validationMessage, "");
    assert.equal(picker.seen.magnets.length, 1);
    assert.equal(picker.seen.magnets[0].magnetUri, MAGNET);
    assert.equal(picker.magnetInput.value, "");
  } finally { picker.restore(); }
});

// The file input, magnet field, Play magnet and demo button share one form
// without novalidate, so a stale error on the file input must not block them.
const badFile = () => new File(["x"], "movie.mkv", { type: "video/x-matroska" });
const brokenTorrent = () => new File(["this is not bencode"], "broken.torrent");
const goodTorrent = () => new File([validTorrentBytes()], "a.torrent", { type: "application/x-bittorrent" });
const BAD_FILES = [["a wrong file", badFile], ["a torrent that does not parse", brokenTorrent]];

for (const [label, makeFile] of BAD_FILES) {
  test(`after ${label}, a magnet typed into the field still starts`, async () => {
    const picker = await mountPicker();
    try {
      picker.drop([makeFile()]);
      await picker.settle();
      assert.notEqual(picker.fileInput.validationMessage, "");
      picker.magnetInput.value = MAGNET;
      picker.magnetInput.dispatchEvent(new Event("input"));
      await picker.settle();
      assert.equal(picker.seen.magnets.length, 1, "MAGNET_READY is dispatched");
      assert.equal(picker.seen.magnets[0].magnetUri, MAGNET);
    } finally { picker.restore(); }
  });

  test(`after ${label}, pressing Enter / Play magnet in the field still submits`, async () => {
    const picker = await mountPicker();
    try {
      picker.drop([makeFile()]);
      await picker.settle();
      picker.magnetInput.value = MAGNET;
      picker.form.requestSubmit();
      assert.equal(picker.seen.magnets.length, 1, "MAGNET_READY is dispatched");
    } finally { picker.restore(); }
  });

  test(`after ${label}, a pasted magnet still starts`, async () => {
    const picker = await mountPicker();
    try {
      picker.drop([makeFile()]);
      await picker.settle();
      picker.paste(MAGNET);
      await picker.settle();
      assert.equal(picker.seen.magnets.length, 1, "MAGNET_READY is dispatched");
      assert.equal(picker.seen.magnets[0].magnetUri, MAGNET);
    } finally { picker.restore(); }
  });

  test(`after ${label}, the demo button still starts the demo`, async () => {
    const picker = await mountPicker();
    try {
      picker.drop([makeFile()]);
      await picker.settle();
      picker.clickDemo();
      await picker.settle();
      assert.equal(picker.seen.magnets.length, 1, "MAGNET_READY is dispatched");
      assert.match(picker.seen.magnets[0].magnetUri, /^magnet:\?xt=urn:btih:08ada5a7/);
    } finally { picker.restore(); }
  });

  test(`after ${label}, choosing a new .torrent via the dialog works`, async () => {
    const picker = await mountPicker();
    try {
      picker.drop([makeFile()]);
      await picker.settle();
      picker.clickInput();
      picker.choose([goodTorrent()]);
      await picker.settle();
      assert.equal(picker.seen.files.length, 1);
      assert.equal(picker.fileInput.validationMessage, "");
    } finally { picker.restore(); }
  });
}

test("after a wrong file, dropping a new .torrent works", async () => {
  const picker = await mountPicker();
  try {
    picker.drop([badFile()]);
    await picker.settle();
    picker.drop([goodTorrent()]);
    await picker.settle();
    assert.equal(picker.seen.files.length, 1);
  } finally { picker.restore(); }
});

test("after a bad ?torrent=, a magnet typed into the field still starts", async () => {
  const picker = await mountPicker({ search: "?torrent=%25%25not-base64%25%25" });
  try {
    await picker.settle();
    assert.notEqual(picker.fileInput.validationMessage, "");
    picker.magnetInput.value = MAGNET;
    picker.magnetInput.dispatchEvent(new Event("input"));
    await picker.settle();
    assert.equal(picker.seen.magnets.length, 1);
  } finally { picker.restore(); }
});

test("after a bad ?torrent=, the demo button still starts the demo", async () => {
  const picker = await mountPicker({ search: "?torrent=%25%25not-base64%25%25" });
  try {
    await picker.settle();
    picker.clickDemo();
    await picker.settle();
    assert.equal(picker.seen.magnets.length, 1);
  } finally { picker.restore(); }
});

test("after a bad ?torrent=, choosing a new .torrent works", async () => {
  const picker = await mountPicker({ search: "?torrent=%25%25not-base64%25%25" });
  try {
    await picker.settle();
    picker.clickInput();
    picker.choose([goodTorrent()]);
    await picker.settle();
    assert.equal(picker.seen.files.length, 1);
  } finally { picker.restore(); }
});

test("a ?magnet= link starts through the form on a clean picker", async () => {
  // Same requestSubmit path as paste/typing; the stale-error case for it is
  // covered by the tests above (a ?magnet= link cannot follow a file error in
  // the same page load, since it returns before ?torrent= is read).
  const picker = await mountPicker({ search: `?magnet=${encodeURIComponent(MAGNET)}` });
  try {
    await picker.settle();
    assert.equal(picker.seen.magnets.length, 1);
    assert.equal(picker.seen.magnets[0].magnetUri, MAGNET);
  } finally { picker.restore(); }
});

function walk(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

test("only torrent-tv.js dispatches ERROR:SHOW from a component; the picker names no error event", () => {
  const picker = readFileSync(join(publicDir, "components/torrent/torrent.js"), "utf8");
  assert.equal(picker.includes("ERROR_EVENTS"), false, "the picker reports through constraint validation");

  const files = walk(publicDir).filter(path => /\.(js|html|md)$/.test(path) && !path.includes("/vendor/"));
  const stale = files.filter(path => readFileSync(path, "utf8").includes("backEvent")).map(path => relative(publicDir, path));
  assert.deepEqual(stale, [], "nothing reads or sends backEvent any more");

  const dispatchers = files
    .filter(path => /CustomEvent\(\s*ERROR_EVENTS\.SHOW/.test(readFileSync(path, "utf8")))
    .map(path => relative(publicDir, path));
  assert.deepEqual(dispatchers, ["components/torrent-tv/torrent-tv.js"]);
});
