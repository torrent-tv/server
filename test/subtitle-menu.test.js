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

test("local source headings are hidden and provider alternatives retain useful differences", () => {
  const items = subtitleMenuItems([
    { key: "local", language: "en", source: "In container" },
    { key: "a", language: "en", source: "OpenSubtitles", trackTitle: "Forced | Team A", forced: true },
    { key: "b", language: "en", source: "OpenSubtitles", trackTitle: "SDH | Team B", hearingImpaired: true, showing: true },
    { key: "c", language: "en", source: "OpenSubtitles", team: "Standard", trackTitle: "Subtitle (1)" }
  ]);
  assert.deepEqual(items.map(({ text, kind, level, key, depth }) => [text, kind, level, key, depth]), [
    ["English", "heading", "language", "language:en", 0],
    ["English", "radio", undefined, "local", 1],
    ["OpenSubtitles", "heading", "source", "source:en:OpenSubtitles", 1],
    ["Signs and foreign dialogue · Team A", "radio", undefined, "a", 2],
    ["Dialogue and sound descriptions · Team B", "radio", undefined, "b", 2],
    ["English", "radio", undefined, "c", 2]
  ]);
  assert.equal(items[1].depth, 1);
  assert.equal(items[3].depth, 2);
  assert.equal(items[3].accessibleText, "English, OpenSubtitles, Signs and foreign dialogue · Team A");
});

test("Moana-style container titles become useful labels without exposing the source or format", () => {
  const items = subtitleMenuItems([
    { key: "ru-forced", language: "ru", source: "In container", trackTitle: "Forced", forced: true },
    { key: "ru-jaskier", language: "ru", source: "In container", trackTitle: "Forced | Jaskier", forced: true },
    { key: "ru-focs", language: "ru", source: "In container", trackTitle: "Full | FOCS" },
    { key: "en-full", language: "en", source: "In container", trackTitle: "Full" },
    { key: "en-sdh", language: "en", source: "In container", trackTitle: "SDH", hearingImpaired: true }
  ]);
  assert.deepEqual(items.map(({ text, kind, key }) => [text, kind, key]), [
    ["English", "heading", "language:en"],
    ["Full dialogue", "radio", "en-full"],
    ["Dialogue and sound descriptions", "radio", "en-sdh"],
    ["Russian", "heading", "language:ru"],
    ["Signs and foreign dialogue", "radio", "ru-forced"],
    ["Signs and foreign dialogue · Jaskier", "radio", "ru-jaskier"],
    ["Full dialogue · FOCS", "radio", "ru-focs"]
  ]);
  assert.equal(items.some(item => /release|\.ass|srt|fps|unverified/iu.test(item.text)), false);
  assert.equal(items.some(item => item.text === "In container"), false);
});

test("provider differences use edition, uploader and date, never filename or arbitrary comments", () => {
  const items = subtitleMenuItems([
    { key: "a", language: "en", source: "OpenSubtitles", release: "VisionQuest S01E02 WEB-DL DDP5.1", uploaderName: "oakislandtk", uploadDate: "2025-03-13T00:50:01Z", filename: "VisionQuest.S01E02.eng.srt" },
    { key: "b", language: "en", source: "OpenSubtitles", release: "VisionQuest S01E02 WEB-DL DDP5.1", uploaderName: "other-uploader", uploadDate: "2025-03-13T00:50:02Z", filename: "VisionQuest.S01E02.eng.sdh.srt" }
  ]);
  assert.deepEqual(items.map(item => item.text), ["English", "Uploaded by oakislandtk", "Uploaded by other-uploader"]);
  assert.equal(items.some(item => /VisionQuest|\.srt|OpenSubtitles/iu.test(item.text)), false);
  assert.equal(items[1].key, "a");
  assert.equal(items[2].key, "b");
  const sameUploader = subtitleMenuItems([
    { key: "c", language: "en", source: "OpenSubtitles", uploaderName: "same", uploadDate: "2025-03-13T00:50:01Z" },
    { key: "d", language: "en", source: "OpenSubtitles", uploaderName: "same", uploadDate: "2025-03-13T00:50:02Z" }
  ]);
  assert.match(sameUploader[1].text, /^Uploaded /u);
  assert.match(sameUploader[2].text, /^Uploaded /u);
});

test("cue counts are shown only when every alternative has a complete count", () => {
  const entries = [
    { key: "a", language: "en", source: "OpenSubtitles", cueCount: 120 },
    { key: "b", language: "en", source: "OpenSubtitles", cueCount: 160 }
  ];
  assert.deepEqual(subtitleMenuItems(entries).map(item => item.text), ["English", "120 cues", "160 cues"]);
  assert.deepEqual(subtitleMenuItems([{ ...entries[0] }, { ...entries[1], cueCount: null }]).map(item => item.text), ["English", "English", "English"]);
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
    "English", "English", "English", "OpenSubtitles"
  ]);
  assert.deepEqual(items.slice(1).map(item => item.key), ["embedded", "sidecar", "provider"]);
  assert.equal(items.some(item => item.kind === "heading" && ["In container", "In torrent"].includes(item.text)), false);
});

test("one option stays addressable while a language changes from singleton to alternatives and back", () => {
  const one = [{ key: "container", language: "ru", source: "In container" }];
  assert.deepEqual(subtitleMenuItems(one).map(item => [item.key, item.text, item.kind]), [
    ["container", "Russian", "radio"]
  ]);
  assert.deepEqual(subtitleMenuItems([...one, { key: "provider", language: "ru", source: "OpenSubtitles" }]).map(item => [item.key, item.text]), [
    ["language:ru", "Russian"],
    ["container", "Russian"],
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
