import test from "node:test";
import assert from "node:assert/strict";
import { ChapterTimeline } from "../public/components/player/chapter-timeline.js";

class FakeCue {
  constructor(startTime, endTime, text) {
    this.startTime = startTime;
    this.endTime = endTime;
    this.text = text;
  }
}

class FakeTextTrack {
  mode = "disabled";
  cues = [];

  addCue(cue) { this.cues.push(cue); }
  removeCue(cue) { this.cues.splice(this.cues.indexOf(cue), 1); }
}

test("chapter timeline keeps one hidden track, updates cues, and clears stale state", () => {
  const track = new FakeTextTrack();
  const video = {
    currentTime: 2,
    duration: 12,
    ownerDocument: { defaultView: { VTTCue: FakeCue } },
    addTextTrack(kind, label) {
      assert.equal(kind, "chapters");
      assert.equal(label, "Playback chapters");
      return track;
    }
  };
  const range = { mediaChaptersCues: [] };
  const currentDisplay = { textContent: "" };
  const timeline = new ChapterTimeline(video, range, currentDisplay);

  assert.equal(track.mode, "hidden");
  timeline.setSnapshot({ state: "available", sections: [
    { id: "one", startSeconds: 0, displayEndSeconds: 5, titles: [{ text: "A & <B>" }] },
    { id: "two", startSeconds: 5, endSeconds: 12, type: "credits", titles: [{ text: "End" }] }
  ] });
  timeline.setDuration(video.duration);

  assert.equal(track.cues.length, 2);
  assert.equal(track.cues[0].text, "A &amp; &lt;B&gt;");
  assert.deepEqual(range.mediaChaptersCues.map(({ text, startTime, endTime }) => [text, startTime, endTime]), [
    ["A &amp; &lt;B&gt;", 0, 5], ["Credits: End", 5, 12]
  ]);
  assert.equal(currentDisplay.textContent, "A & <B>");

  timeline.setSnapshot({ state: "available", sections: [{ id: "next", startSeconds: 0, endSeconds: 12, titles: [{ text: "Next source" }] }] });
  assert.equal(track.cues.length, 1);
  assert.equal(track.cues[0].text, "Next source");
  assert.equal(currentDisplay.textContent, "Next source");
  timeline.setSnapshot({ state: "available", sections: [{ id: "next", startSeconds: 0, endSeconds: 12, titles: [{ text: "Updated title" }] }] });
  assert.equal(currentDisplay.textContent, "Updated title");

  timeline.setSnapshot(null);
  assert.equal(track.cues.length, 0);
  assert.deepEqual(range.mediaChaptersCues, []);
  assert.equal(currentDisplay.textContent, "");
});

test("unsupported chapter metadata clears the timeline", () => {
  const track = new FakeTextTrack();
  const video = {
    currentTime: 10,
    duration: 120,
    ownerDocument: { defaultView: { VTTCue: FakeCue } },
    addTextTrack() { return track; }
  };
  const range = { mediaChaptersCues: [] };
  const currentDisplay = { textContent: "" };
  const timeline = new ChapterTimeline(video, range, currentDisplay);
  timeline.setDuration(video.duration);
  timeline.setSnapshot({ state: "available", sections: [{ id: "one", startSeconds: 0, endSeconds: 60, titles: [{ text: "Opening" }] }] });
  assert.equal(currentDisplay.textContent, "Opening");

  timeline.setSnapshot({ state: "unsupported", sections: [{ id: "one", startSeconds: 0, endSeconds: 60, titles: [{ text: "Opening" }] }] });
  assert.equal(track.cues.length, 0);
  assert.deepEqual(range.mediaChaptersCues, []);
  assert.equal(currentDisplay.textContent, "");
});
