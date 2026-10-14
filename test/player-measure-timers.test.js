import test from "node:test";
import assert from "node:assert/strict";
import { APP_EVENTS } from "../public/shared/events.js";

// A wait polls the buffer every 500 ms; a moving picture reports decoded frames
// every 5 s. Starting one used to return before the other was stopped, so the
// buffer poll ran for the whole of playback (torrent-tv/meta#178).
test("the player keeps exactly the timer its state asks for", async () => {
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
    hasAttribute(name) { return this.attributes.has(name); }
    querySelectorAll() { return [...this.children]; }
    appendChild(child) { this.insertBefore(child, null); }
    insertBefore(child, before) {
      if (child.parent) child.parent.children = child.parent.children.filter(other => other !== child);
      child.parent = this;
      const at = before ? this.children.indexOf(before) : -1;
      if (at < 0) this.children.push(child); else this.children.splice(at, 0, child);
    }
    remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
    matches() { return this.popover === true; }
    hidePopover() { this.popover = false; }
    getBoundingClientRect() { return { width: 640, height: 360 }; }
  }
  const nodes = new Map();
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, new Node()); return nodes.get(selector); };
  const document = Object.assign(new EventTarget(), { readyState: "loading", querySelector: node, createElement: () => new Node() });
  globalThis.document = document;
  const live = new Map();
  let next = 1;
  globalThis.window = {
    devicePixelRatio: 1,
    setInterval: (fn, ms) => { const id = next++; live.set(id, ms); return id; },
    clearInterval: id => { live.delete(id); }
  };
  globalThis.HTMLVideoElement = class {};
  globalThis.customElements = { whenDefined: () => new Promise(() => {}) };
  try {
    const { Player } = await import("../public/components/player/player.js");
    new Player();
    const send = (type, detail) => document.dispatchEvent(new CustomEvent(type, { detail }));
    const timers = () => [...live.values()].sort((a, b) => a - b);
    send(APP_EVENTS.STATE_CHANGED, { state: "OPENING" });
    assert.deepEqual(timers(), [500], "waiting: the buffer poll alone");
    send(APP_EVENTS.STATE_CHANGED, { state: "ADVANCING" });
    assert.deepEqual(timers(), [5_000], "moving: the decode report alone");
    send(APP_EVENTS.STATE_CHANGED, { state: "STALLED" });
    assert.deepEqual(timers(), [500], "stalled: the buffer poll alone");
    send(APP_EVENTS.STATE_CHANGED, { state: "ADVANCING" });
    assert.deepEqual(timers(), [5_000], "moving again: the decode report alone");
  } finally { Object.assign(globalThis, saved); }
});
