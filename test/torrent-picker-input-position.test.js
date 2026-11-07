import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * torrent-tv/meta#290: the picker reports a bad file through the native
 * validation bubble of the file input (setCustomValidity + reportValidity).
 * The browser anchors that bubble to the input's own box, so an input parked
 * off-screen (`position: fixed; top: -100vh`) shows the viewer nothing.
 *
 * The input must stay on screen: absolutely positioned over its positioned
 * label, covering it, invisible only through opacity, and never removed from
 * layout or focus.
 */

const css = readFileSync(new URL("../public/components/torrent/torrent.css", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

/** Body of the block opened right after `selector` (nested blocks included). */
function blockOf(selector) {
  const match = new RegExp(`${selector}\\s*\\{`).exec(css);
  assert.ok(match, `${selector} has a rule in torrent.css`);
  let depth = 1;
  let end = match.index + match[0].length;
  while (depth > 0 && end < css.length) {
    if (css[end] === "{") depth += 1;
    if (css[end] === "}") depth -= 1;
    end += 1;
  }
  return css.slice(match.index + match[0].length, end - 1);
}

/** Declarations of a block's own level, nested rules dropped. */
function declarations(body) {
  let flat = body;
  let previous;
  do {
    previous = flat;
    flat = flat.replace(/[^{};]*\{[^{}]*\}/g, "");
  } while (flat !== previous);
  const result = {};
  for (const part of flat.split(";")) {
    const index = part.indexOf(":");
    if (index > 0) result[part.slice(0, index).trim().toLowerCase()] = part.slice(index + 1).trim().toLowerCase();
  }
  return result;
}

const input = declarations(blockOf("#torrent__input"));
const label = declarations(blockOf("#torrent__label"));

test("picker file input is not parked off-screen", () => {
  assert.notEqual(input.position, "fixed", `position is ${input.position}`);
  for (const side of ["top", "left", "right", "bottom", "inset", "inset-block", "inset-inline", "inset-block-start", "inset-inline-start", "inset-block-end", "inset-inline-end", "margin-top", "margin-left", "margin-block-start", "margin-inline-start"]) {
    const value = input[side];
    if (value === undefined) continue;
    assert.doesNotMatch(value, /(^|\s)-\s*[\d.]/, `${side}: ${value} is a negative offset`);
    assert.doesNotMatch(value, /v[hw]|vmin|vmax|dv[hw]|sv[hw]|lv[hw]/, `${side}: ${value} is a viewport offset`);
  }
  assert.doesNotMatch(input.transform ?? "", /translate/, "no translate moves the input away");
  assert.equal(input.clip, undefined, "no clip");
  assert.doesNotMatch(input["clip-path"] ?? "", /inset|polygon|circle/, "no clip-path");
});

test("picker file input covers its positioned label", () => {
  assert.ok(label.position && label.position !== "static", `#torrent__label is positioned (${label.position})`);
  assert.equal(input.position, "absolute");
  const box = input.inset === "0" || input.inset === "0rem" || ["top", "left", "right", "bottom"].every(side => /^0(rem)?$/.test(input[side] ?? ""));
  assert.ok(box, "the input is inset 0 on all sides, over the label");
  assert.equal(input.opacity, "0", "the input is transparent, not hidden");
});

test("picker file input stays focusable and anchorable for the validation bubble", () => {
  assert.notEqual(input.display, "none");
  assert.notEqual(input.visibility, "hidden");
  assert.notEqual(input.visibility, "collapse");
  assert.notEqual(input["pointer-events"], "none", "the input stays clickable");
  for (const size of ["width", "height", "inline-size", "block-size", "max-width", "max-height"]) {
    if (input[size] !== undefined) assert.doesNotMatch(input[size], /^0(\.0+)?[a-z%]*$/, `${size}: ${input[size]} collapses the input`);
  }
  const tag = /<input\b[^>]*\bid="torrent__input"[^>]*>/.exec(html);
  assert.ok(tag, "index.html has #torrent__input");
  assert.doesNotMatch(tag[0], /\shidden(\s|=|\/|>)/, "no hidden attribute");
  assert.doesNotMatch(tag[0], /type="hidden"/);
});

test("picker file input geometry uses rem, not px", () => {
  for (const [name, value] of Object.entries(input)) {
    assert.doesNotMatch(value, /\d\s*px\b/, `${name}: ${value}`);
  }
});
