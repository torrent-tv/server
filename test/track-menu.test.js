import test from "node:test";
import assert from "node:assert/strict";
import { audioMenuItems } from "../public/domain/audio-menu.js";
import { mediaTrackLanguageInfo } from "../public/domain/track-language.js";
import { trackMenuState } from "../public/domain/track-menu.js";

test("an unknown audio language uses a delimited title code and removes it from the title", () => {
  assert.deepEqual(mediaTrackLanguageInfo({ language: "und", title: "RUS | Jaskier" }), {
    code: "ru", name: "Russian", title: "Jaskier", rawTitle: "RUS | Jaskier", unknown: false
  });
  assert.deepEqual(mediaTrackLanguageInfo({ language: "und", title: "ENG" }), {
    code: "en", name: "English", title: "", rawTitle: "ENG", unknown: false
  });
});

test("explicit audio language wins over a conflicting title code", () => {
  assert.deepEqual(mediaTrackLanguageInfo({ language: "de", title: "RUS | Commentary" }), {
    code: "de", name: "German", title: "RUS | Commentary", rawTitle: "RUS | Commentary", unknown: false
  });
});

test("matching title codes are removed as whole tokens while language regions remain", () => {
  assert.deepEqual(mediaTrackLanguageInfo({ language: "pt-BR", title: "(POR) Commentary" }), {
    code: "pt-BR", name: "Portuguese (Brazil)", title: "Commentary", rawTitle: "(POR) Commentary", unknown: false
  });
  assert.equal(mediaTrackLanguageInfo({ language: "en", title: "French commentary" }).title, "French commentary");
});

test("audio labels use the shared language names and keep selectable track indices", () => {
  const items = audioMenuItems([
    { index: 0, language: "und", title: "RUS", channels: 2 },
    { index: 1, language: "und", title: "ENG", channels: 2 },
    { index: 2, language: "ru", title: "Commentary", channels: 6, isCommentary: true }
  ], 0);
  assert.deepEqual(items.map(({ key, text, kind, depth, checked }) => [key, text, kind, depth, checked]), [
    ["1", "English · (Stereo)", "radio", 0, false],
    ["audio-language:ru", "Russian", "heading", 0, false],
    ["0", "(Stereo)", "radio", 0, true],
    ["2", "(Commentary · 5.1)", "radio", 0, false]
  ]);
  assert.deepEqual(trackMenuState(items).map(({ key }) => key), items.map(({ key }) => key));
});

test("one audio choice is represented by its language and useful supported details", () => {
  assert.deepEqual(audioMenuItems([
    { index: 4, language: "pt-BR", channels: 2, isVisualImpaired: true }
  ]).map(({ key, text, checked }) => [key, text, checked]), [
    ["4", "Portuguese (Brazil) · (Audio description · Stereo)", false]
  ]);
});

test("audio alternatives with identical available metadata remain identifiable", () => {
  assert.deepEqual(audioMenuItems([
    { index: 0, language: "en", channels: 2 },
    { index: 1, language: "en", channels: 2 }
  ]).map(({ text }) => text), [
    "English",
    "(Stereo) · Track 1",
    "(Stereo) · Track 2"
  ]);
});
