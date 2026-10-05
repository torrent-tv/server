import test from "node:test";
import assert from "node:assert/strict";
import { PLAYER_EVENTS } from "../public/shared/events.js";

test("system play and pause use explicit requests even when the element is already paused", async () => {
  const previous = new Map(["document", "navigator", "HTMLVideoElement"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const document = new EventTarget();
  document.readyState = "loading";
  const actions = new Map();
  class Video extends EventTarget {
    paused = true;
    play() { throw new Error("The bridge must not start the element directly."); }
    pause() { throw new Error("The bridge must not pause the element directly."); }
  }
  try {
    Object.defineProperty(globalThis, "document", { configurable: true, value: document });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
      mediaSession: { setActionHandler: (action, handler) => actions.set(action, handler) }
    } });
    Object.defineProperty(globalThis, "HTMLVideoElement", { configurable: true, value: Video });
    const { MediaSessionBridge } = await import("../public/components/media-session/media-session.js");
    new MediaSessionBridge();
    const video = new Video();
    document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.READY, { detail: { videoElement: video } }));
    const received = [];
    for (const type of ["mediaplayrequest", "mediapauserequest"]) video.addEventListener(type, event => {
      received.push(type);
      assert.equal(event.bubbles, true);
      assert.equal(event.composed, true);
      assert.equal(event.cancelable, true);
    });
    actions.get("pause")();
    actions.get("play")();
    assert.deepEqual(received, ["mediapauserequest", "mediaplayrequest"]);
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
