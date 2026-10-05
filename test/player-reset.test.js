import test from "node:test";
import assert from "node:assert/strict";
import { APP_EVENTS, MEDIA_INFO_EVENTS, PLAYER_EVENTS } from "../public/shared/events.js";

test("player resets source controls on close and replacement through its owning method", async () => {
  const saved = Object.fromEntries(["document", "window", "HTMLVideoElement", "customElements"].map(key => [key, globalThis[key]]));
  class Node extends EventTarget {
    hidden = false;
    dataset = {};
    children = [];
    attributes = new Map();
    classes = new Set();
    classList = { add: (...names) => names.forEach(name => this.classes.add(name)), remove: (...names) => names.forEach(name => this.classes.delete(name)),
      contains: name => this.classes.has(name), toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name) };
    setAttribute(name, value) { this.attributes.set(name, value); }
    removeAttribute(name) { this.attributes.delete(name); }
    getAttribute(name) { return this.attributes.get(name); }
    toggleAttribute(name, enabled) { if (enabled) this.setAttribute(name, ""); else this.removeAttribute(name); }
    querySelectorAll() { return [...this.children]; }
    appendChild(child) { child.parent = this; this.children.push(child); }
    remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
    matches() { return this.popover === true; }
    hidePopover() { this.popover = false; }
    getBoundingClientRect() { return { width: 640, height: 360 }; }
  }
  const nodes = new Map();
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, new Node()); return nodes.get(selector); };
  const document = Object.assign(new EventTarget(), { readyState: "loading", querySelector: node, createElement: () => new Node() });
  globalThis.document = document;
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.HTMLVideoElement = class {};
  globalThis.customElements = { whenDefined: () => new Promise(() => {}) };
  try {
    const { Player } = await import("../public/components/player/player.js");
    const player = new Player();
    const send = (type, detail) => document.dispatchEvent(new CustomEvent(type, { detail }));
    for (const resetEvent of [APP_EVENTS.RESET_TO_PICKER, MEDIA_INFO_EVENTS.SELECTED]) {
      send(PLAYER_EVENTS.SET_AUDIO_TRACKS, { tracks: [{ index: 0 }, { index: 1 }] });
      send(PLAYER_EVENTS.SET_SUBTITLE_TRACKS, { items: [{ key: "en", text: "English" }] });
      send(PLAYER_EVENTS.SET_MEDIA_FILES, { video: [{ index: 0 }, { index: 1 }] });
      send(PLAYER_EVENTS.SET_SHARE_LINK, { url: "https://example.test/?torrent=example" });
      send(PLAYER_EVENTS.OPEN_PLAYLIST);
      node("#player__audio-menu").hidden = false;
      node("#player__subtitle-menu").hidden = false;
      node("#player__share-menu").popover = true;
      send(resetEvent, { selection: 2, names: ["Next"] });
      for (const selector of ["audio-button", "subtitle-button", "playlist-toggle", "share", "audio-menu", "subtitle-menu"]) assert.equal(node("#player__" + selector).hidden, true, selector);
      assert.equal(node("#player__audio-menu").children.length, 0);
      assert.equal(node("#player__subtitle-menu").children.length, 0);
      assert.equal(node("#player__share-menu").popover, false);
      assert.equal(node("#player__playlist-toggle").getAttribute("aria-expanded"), "false");
      assert.equal(node("#player").classList.contains("player--playlist"), false);
    }
    player.reset();
  } finally { Object.assign(globalThis, saved); }
});
