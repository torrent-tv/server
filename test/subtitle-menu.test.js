/**
 * @file The subtitle menu names tracks by key; labels are only what is shown.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { isTypingTarget, subtitleMenuItems, subtitleToggleKey } from "../public/domain/subtitle-menu.js";

test("one menu shows language and team headings before a track while keeping its key", () => {
  const items = subtitleMenuItems([{
    key: "1:embedded:0", label: "Russian (Signs)", language: "ru", team: null,
    variant: "Signs", details: ["Embedded", "ASS"], showing: true
  }]);
  assert.deepEqual(items.map(({ text, kind, level }) => [text, kind, level]), [
    ["Russian", "heading", "language"],
    ["Signs · Embedded · ASS", "radio", undefined]
  ]);
  assert.equal(items[1].key, "1:embedded:0");
  assert.equal(items[1].accessibleText, "Russian, Signs · Embedded · ASS");
  assert.equal(items[1].checked, true);
});

test("known teams get headings; missing teams follow the language without an invented team", () => {
  const items = subtitleMenuItems([
    { key: "a", language: "en", team: "Team A", variant: "Full", details: ["ASS"], order: 1 },
    { key: "b", language: "en", team: "Team A", variant: "Full", details: ["ASS"], order: 2, showing: true },
    { key: "c", language: "en", team: null, variant: "Signs", details: ["VTT"], order: 3 }
  ]);
  assert.deepEqual(items.map(({ text, kind, level, key }) => [text, kind, level, key]), [
    ["English", "heading", "language", "language:en"],
    ["Team A", "heading", "team", "team:en:Team%20A"],
    ["Full · ASS (1)", "radio", undefined, "a"],
    ["Full · ASS (2)", "radio", undefined, "b"],
    ["Signs · VTT", "radio", undefined, "c"]
  ]);
  assert.equal(items[2].accessibleText, "English, Team A, Full · ASS (1)");
  assert.equal(items[4].accessibleText, "English, Signs · VTT");
});

test("regional language tags share a primary-language group and remain visible on the track", () => {
  const items = subtitleMenuItems([
    { key: "br", language: "pt-BR", variant: "Brazilian", order: 1 },
    { key: "pt", language: "pt", variant: "General", order: 2 }
  ]);
  assert.deepEqual(items.map(({ text, kind, level, key }) => [text, kind, level, key]), [
    ["Portuguese", "heading", "language", "language:pt"],
    ["Brazilian · pt-BR", "radio", undefined, "br"],
    ["General", "radio", undefined, "pt"]
  ]);
});

test("the subtitles key turns off what is on, and otherwise the last choice, the file's own, or the first", () => {
  const entries = (showing) => [
    { key: "a", label: "A", showing: showing === "a" },
    { key: "b", label: "B", showing: showing === "b" }
  ];
  assert.equal(subtitleToggleKey({ entries: entries("b") }), "", "something is on: off");
  assert.equal(subtitleToggleKey({ entries: entries(null), lastChosenKey: "b", preferredKey: "a" }), "b");
  assert.equal(subtitleToggleKey({ entries: entries(null), preferredKey: "a" }), "a");
  assert.equal(subtitleToggleKey({ entries: entries(null), lastChosenKey: "gone" }), "a", "a key from another file is not used");
  assert.equal(subtitleToggleKey({ entries: [] }), "");
});

test("a key pressed while typing is not the page's", () => {
  assert.equal(isTypingTarget({ tagName: "INPUT" }), true);
  assert.equal(isTypingTarget({ tagName: "textarea" }), true);
  assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: "MEDIA-CONTROLLER" }), false);
  assert.equal(isTypingTarget(null), false);
});
