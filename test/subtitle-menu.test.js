/**
 * @file The subtitle menu names tracks by key; labels are only what is shown.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { isTypingTarget, subtitleMenuItems, subtitleToggleKey } from "../public/domain/subtitle-menu.js";

test("a language with one subtitle is itself the selectable row", () => {
  const items = subtitleMenuItems([{
    key: "1:embedded:0", language: "ru", source: "In container", showing: true,
    variant: "release-name", details: ["ASS", "25 fps", "Version unverified"]
  }]);
  assert.deepEqual(items.map(({ key, text, kind, depth }) => [key, text, kind, depth]), [
    ["1:embedded:0", "Russian", "radio", 0]
  ]);
  assert.equal(items[0].accessibleText, "Russian");
  assert.equal(items[0].checked, true);
});

test("source headings precede team choices; an unknown team is omitted", () => {
  const items = subtitleMenuItems([
    { key: "local", language: "en", source: "In container" },
    { key: "a", language: "en", source: "OpenSubtitles", team: "Team A", forced: true },
    { key: "b", language: "en", source: "OpenSubtitles", team: "Team B", hearingImpaired: true, showing: true },
    { key: "c", language: "en", source: "OpenSubtitles", team: null }
  ]);
  assert.deepEqual(items.map(({ text, kind, level, key, depth }) => [text, kind, level, key, depth]), [
    ["English", "heading", "language", "language:en", 0],
    ["In container", "radio", undefined, "local", 1],
    ["OpenSubtitles", "heading", "source", "source:en:OpenSubtitles", 1],
    ["Team A", "radio", undefined, "a", 2],
    ["Team B", "radio", undefined, "b", 2],
    ["Subtitle", "radio", undefined, "c", 2]
  ]);
  assert.equal(items[1].depth, 1);
  assert.equal(items[3].depth, 2);
  assert.equal(items[3].accessibleText, "English, OpenSubtitles, Team A");
});

test("one source heading is hidden and only distinguishing Forced and SDH characteristics appear", () => {
  const items = subtitleMenuItems([
    { key: "forced", language: "ru", source: "OpenSubtitles", forced: true, filename: "movie.release.ass", fps: 25 },
    { key: "sdh", language: "ru", source: "OpenSubtitles", hearingImpaired: true, format: "SRT" },
    { key: "plain1", language: "ru", source: "OpenSubtitles" },
    { key: "plain2", language: "ru", source: "OpenSubtitles" }
  ]);
  assert.deepEqual(items.map(({ text, kind }) => [text, kind]), [
    ["Russian", "heading"],
    ["Forced", "radio"],
    ["SDH", "radio"],
    ["Subtitle (1)", "radio"],
    ["Subtitle (2)", "radio"]
  ]);
  assert.equal(items.some(item => /release|\.ass|srt|fps|unverified/iu.test(item.text)), false);
});

test("language variants remain separate and a sole provider heading is hidden", () => {
  const items = subtitleMenuItems([
    { key: "pt-br", language: "pt-BR", source: "OpenSubtitles", forced: true },
    { key: "pt", language: "pt", source: "OpenSubtitles", hearingImpaired: true }
  ]);
  assert.deepEqual(items.map(({ text, kind, depth }) => [text, kind, depth]), [
    ["Portuguese", "radio", 0],
    ["Portuguese (Brazil)", "radio", 0]
  ]);
});

test("script and region variants retain their own language rows", () => {
  const items = subtitleMenuItems([
    { key: "simplified", language: "zh-CN", source: "In container" },
    { key: "traditional", language: "zh-TW", source: "In container" },
    { key: "english", language: "en-US", source: "In container" },
    { key: "english-default", language: "en", source: "OpenSubtitles", provider: "opensubtitles" }
  ]);
  assert.deepEqual(items.map(({ key, text }) => [key, text]), [
    ["simplified", "Chinese (China)"],
    ["traditional", "Chinese (Taiwan)"],
    ["english-default", "English"],
    ["english", "English (United States)"]
  ]);
});

test("OpenSubtitles aliases display their language names without false country labels", () => {
  const items = subtitleMenuItems([
    { key: "ea", language: "ea", source: "OpenSubtitles", provider: "opensubtitles" },
    { key: "zh-ca", language: "zh-ca", source: "OpenSubtitles", provider: "opensubtitles" },
    { key: "ze", language: "ze", source: "OpenSubtitles", provider: "opensubtitles" }
  ]);
  assert.deepEqual(items.map(({ text }) => text), ["Chinese (Bilingual)", "Chinese (Cantonese)", "Spanish (Latin America)"]);
});

test("container and torrent subtitles precede provider results", () => {
  const items = subtitleMenuItems([
    { key: "provider", language: "en", source: "OpenSubtitles" },
    { key: "sidecar", language: "en", source: "In torrent" },
    { key: "embedded", language: "en", source: "In container" }
  ]);
  assert.deepEqual(items.map(item => item.text), [
    "English", "In container", "In torrent", "OpenSubtitles"
  ]);
});

test("one option stays addressable while a language changes from singleton to alternatives and back", () => {
  const one = [{ key: "container", language: "ru", source: "In container" }];
  assert.deepEqual(subtitleMenuItems(one).map(item => [item.key, item.text, item.kind]), [
    ["container", "Russian", "radio"]
  ]);
  assert.deepEqual(subtitleMenuItems([...one, { key: "provider", language: "ru", source: "OpenSubtitles" }]).map(item => [item.key, item.text]), [
    ["language:ru", "Russian"],
    ["container", "In container"],
    ["provider", "OpenSubtitles"]
  ]);
  assert.deepEqual(subtitleMenuItems(one).map(item => [item.key, item.text, item.kind]), [
    ["container", "Russian", "radio"]
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
