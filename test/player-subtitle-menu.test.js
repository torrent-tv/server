import test from "node:test";
import assert from "node:assert/strict";
import { PLAYER_EVENTS } from "../public/shared/events.js";

// The menu is published on every text-track change; re-creating its items each
// time stood the page for 620–780 ms per publication with 339 of them
// (torrent-tv/meta#178). What the player does to the elements is counted here.
test("the subtitle menu writes only what a publication changed", async () => {
  const saved = Object.fromEntries(["document", "window", "HTMLVideoElement", "customElements"].map(key => [key, globalThis[key]]));
  const writes = [];
  let created = 0;
  class Node extends EventTarget {
    hidden = false;
    dataset = {};
    children = [];
    attributes = new Map();
    #text = "";
    classes = new Set();
    classList = { add: (...names) => names.forEach(name => this.classes.add(name)), remove: (...names) => names.forEach(name => this.classes.delete(name)),
      contains: name => this.classes.has(name), toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name) };
    get textContent() { return this.#text; }
    set textContent(value) { writes.push(["text", this.dataset.subtitleKey, value]); this.#text = value; }
    setAttribute(name, value) { writes.push(["set", this.dataset.subtitleKey, name]); this.attributes.set(name, value); }
    removeAttribute(name) { writes.push(["remove", this.dataset.subtitleKey, name]); this.attributes.delete(name); }
    getAttribute(name) { return this.attributes.get(name); }
    hasAttribute(name) { return this.attributes.has(name); }
    toggleAttribute(name, enabled) { if (enabled) this.setAttribute(name, ""); else if (this.attributes.has(name)) this.removeAttribute(name); }
    querySelectorAll() { return [...this.children]; }
    appendChild(child) { this.insertBefore(child, null); }
    insertBefore(child, before) {
      writes.push(["place", child.dataset.subtitleKey]);
      if (child.parent) child.parent.children = child.parent.children.filter(other => other !== child);
      child.parent = this;
      const at = before ? this.children.indexOf(before) : -1;
      if (at < 0) this.children.push(child); else this.children.splice(at, 0, child);
    }
    remove() { writes.push(["drop", this.dataset.subtitleKey]); this.parent.children = this.parent.children.filter(child => child !== this); }
    matches() { return false; }
    hidePopover() {}
    getBoundingClientRect() { return { width: 640, height: 360 }; }
  }
  const nodes = new Map();
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, new Node()); return nodes.get(selector); };
  const document = Object.assign(new EventTarget(), { readyState: "loading", querySelector: node,
    createElement: () => { created += 1; return new Node(); } });
  globalThis.document = document;
  globalThis.window = { devicePixelRatio: 1, setInterval: () => 1, clearInterval() {} };
  globalThis.HTMLVideoElement = class {};
  globalThis.customElements = { whenDefined: () => new Promise(() => {}) };
  try {
    const { Player } = await import("../public/components/player/player.js");
    new Player();
    const publish = (items) => document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.SET_SUBTITLE_TRACKS, { detail: { items } }));
    const menu = node("#player__subtitle-menu");
    const offers = Array.from({ length: 330 }, (_, n) => ({ key: `p${n}`, text: `Offer ${n}`, checked: false }));
    const tracks = [{ key: "t1", text: "Russian", checked: false }, { key: "t2", text: "English", checked: false }, ...offers];

    publish(tracks);
    assert.equal(created, 333);
    assert.deepEqual(menu.children.map(child => child.dataset.subtitleKey).slice(0, 4), ["", "t1", "t2", "p0"]);
    const first = [...menu.children];

    writes.length = 0;
    created = 0;
    publish(tracks.map(track => ({ ...track })));
    assert.equal(created, 0, "an identical publication creates nothing");
    assert.deepEqual(writes, [], "an identical publication writes, places and removes nothing");
    assert.ok(menu.children.every((child, position) => child === first[position]), "the elements stay where they are");

    writes.length = 0;
    publish(tracks.map(track => (track.key === "t2" ? { ...track, checked: true } : track)));
    assert.equal(created, 0);
    assert.deepEqual(writes, [["remove", "", "checked"], ["set", "t2", "checked"]], "a mode change writes checked on two items");

    writes.length = 0;
    publish([]);
    assert.equal(menu.children.length, 0);
    assert.equal(menu.hidden, true);
    assert.equal(node("#player__subtitle-button").hidden, true);
  } finally { Object.assign(globalThis, saved); }
});
