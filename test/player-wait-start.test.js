import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../public/components/player/player.js", import.meta.url), "utf8");
const start = source.indexOf("  #onFileChosenForPoster = (event) => {");
assert.ok(start >= 0, "file-choice handler exists");
const end = source.indexOf("\n  };", start) + 5;
const handler = source.slice(start, end);

function player() {
  const create = new Function("CustomEvent", `return class {
    #activeFileIndex = 0;
    #awaitingFirstPresentedFrame = false;
    #waitSequence = 0;
    #waitStartedAt = null;
    #loadArt = null;
    #onActiveFileForPoster(event) { this.#activeFileIndex = event.detail.fileIndex; }
    ${handler}
    choose(detail) { this.#onFileChosenForPoster(new CustomEvent("file-chosen", { detail })); }
    state() { return { waitSequence: this.#waitSequence, waitStartedAt: this.#waitStartedAt }; }
  }`);
  return new (create(CustomEvent))();
}

test("the presented-frame clock uses the original action time and ignores a duplicate same-file event", () => {
  const component = player();
  component.choose({ fileIndex: 0, startedAt: 1000, originalOpen: true });
  component.choose({ fileIndex: 0, startedAt: 2000 });

  assert.deepEqual(component.state(), { waitSequence: 1, waitStartedAt: 1000 });
});

test("a new file action replaces the waiting start even when another file is still waiting", () => {
  const component = player();
  component.choose({ fileIndex: 0, startedAt: 1000 });
  component.choose({ fileIndex: 1, startedAt: 3000 });

  assert.deepEqual(component.state(), { waitSequence: 2, waitStartedAt: 3000 });
});
