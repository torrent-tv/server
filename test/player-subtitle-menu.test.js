import test from "node:test";
import assert from "node:assert/strict";
import { PLAYER_EVENTS } from "../public/shared/events.js";
import { subtitleMenuItems } from "../public/domain/subtitle-menu.js";

test("the single subtitle menu updates headings and leaves by key without rebuilding unchanged rows", async () => {
  const saved = Object.fromEntries(["document", "window", "HTMLVideoElement", "customElements"].map(key => [key, globalThis[key]]));
  const writes = [];
  let created = 0;
  const createdNames = [];
  class Node extends EventTarget {
    hidden = false;
    dataset = {};
    children = [];
    attributes = new Map();
    classes = new Set();
    #text = "";
    #checked = false;
    localName;
    parent = null;
    classList = { add: (...names) => names.forEach(name => this.classes.add(name)), remove: (...names) => names.forEach(name => this.classes.delete(name)),
      contains: name => this.classes.has(name), toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name) };
    constructor(name = "div") { super(); this.localName = name; }
    get textContent() { return this.#text || this.children.map(child => child.textContent).join(""); }
    set textContent(value) { writes.push(["text", this.dataset.subtitleNodeKey, value]); this.#text = value; }
    get checked() { return this.#checked; }
    set checked(value) { writes.push(["checked", this.dataset.subtitleNodeKey, value]); this.#checked = value; }
    setAttribute(name, value) { writes.push(["set", this.dataset.subtitleNodeKey, name]); this.attributes.set(name, value); }
    removeAttribute(name) { writes.push(["remove", this.dataset.subtitleNodeKey, name]); this.attributes.delete(name); }
    getAttribute(name) { return this.attributes.get(name); }
    hasAttribute(name) { return this.attributes.has(name); }
    toggleAttribute(name, enabled) { if (enabled) this.setAttribute(name, ""); else if (this.attributes.has(name)) this.removeAttribute(name); }
    querySelector(selector) {
      if (selector === "[data-subtitle-label]") return this.descendants().find(child => child.dataset.subtitleLabel !== undefined) ?? null;
      return null;
    }
    querySelectorAll(selector) {
      if (selector === "media-chrome-menu[slot='submenu']") return this.descendants().filter(child => child.localName === "media-chrome-menu" && child.slot === "submenu");
      return [];
    }
    descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
    get submenuElement() { return this.children.find(child => child.localName === "media-chrome-menu") ?? null; }
    appendChild(child) { this.insertBefore(child, null); }
    insertBefore(child, before) {
      if (child.parent) child.parent.children = child.parent.children.filter(other => other !== child);
      child.parent = this;
      const at = before ? this.children.indexOf(before) : -1;
      if (at < 0) this.children.push(child); else this.children.splice(at, 0, child);
      writes.push(["place", child.dataset.subtitleNodeKey]);
      const radios = this.children.filter(item => item.type === "radio");
      if (radios.length && !radios.some(item => item.checked)) radios[0].checked = true;
    }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    matches() { return false; }
    hidePopover() {}
    getBoundingClientRect() { return { width: 640, height: 360 }; }
  }
  const nodes = new Map();
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, new Node()); return nodes.get(selector); };
  const document = Object.assign(new EventTarget(), { readyState: "loading", querySelector: node,
    createElement: name => { created += 1; createdNames.push(name); return new Node(name); } });
  globalThis.document = document;
  globalThis.window = { devicePixelRatio: 1, setInterval: () => 1, clearInterval() {} };
  globalThis.HTMLVideoElement = class {};
  globalThis.customElements = { whenDefined: () => new Promise(() => {}) };
  try {
    const { Player } = await import("../public/components/player/player.js");
    new Player();
    const publish = entries => document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.SET_SUBTITLE_TRACKS, { detail: { items: subtitleMenuItems(entries) } }));
    const menu = node("#player__subtitle-menu");
    const entries = [
      { key: "ru", language: "ru", variant: "Signs", details: ["Embedded", "ASS"], order: 0 },
      ...Array.from({ length: 330 }, (_, n) => ({ key: `p${n}`, language: "en", team: "Team A", variant: `Offer ${n}`, details: ["OpenSubtitles", "SRT"], order: n + 1 }))
    ];

    publish(entries);
    assert.equal(menu.children[0].dataset.subtitleKey, "");
    assert.equal(menu.children[1].querySelector("[data-subtitle-label]").textContent, "English");
    assert.equal(menu.children[1].dataset.subtitleGroup, "language");
    assert.equal(menu.children[2].querySelector("[data-subtitle-label]").textContent, "Team A");
    assert.equal(menu.children[2].dataset.subtitleGroup, "team");
    assert.equal(menu.children.at(-1).querySelector("[data-subtitle-label]").textContent, "Signs · Embedded · ASS");
    assert.equal(menu.children.at(-1).dataset.subtitleKey, "ru");
    assert.equal(menu.querySelectorAll("media-chrome-menu[slot='submenu']").length, 0);
    assert.equal(menu.children.length, 335, "language/team headings and track rows share one menu");
    assert.equal(createdNames.includes("media-settings-menu-item"), false, "the subtitle list does not create expandable groups");
    assert.equal(menu.children.filter(child => child.type === "radio").every(child => !child.checked || child.dataset.subtitleKey === ""), true,
      "only the Off row is checked when subtitles are off");
    const first = [...menu.children];

    writes.length = 0;
    created = 0;
    createdNames.length = 0;
    publish(entries.map(entry => ({ ...entry })));
    assert.equal(created, 0, `an identical publication creates nothing (${createdNames.join(", ")})`);
    assert.deepEqual(writes, [], "an identical publication writes, places and removes nothing");
    assert.deepEqual([...menu.children], first, "the elements stay where they are");

    writes.length = 0;
    publish(entries.map(entry => entry.key === "p1" ? { ...entry, showing: true } : entry));
    assert.equal(created, 0);
    assert.equal(writes.filter(([kind]) => kind === "checked").length, 2, "Off and the chosen leaf are updated");

    publish([]);
    assert.equal(menu.children.length, 0);
    assert.equal(menu.hidden, true);
    assert.equal(node("#player__subtitle-button").hidden, true);
  } finally {
    document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.SET_SUBTITLE_TRACKS, { detail: { items: [] } }));
    Object.assign(globalThis, saved);
  }
});
