import { navigableSections, playbackSectionIntervals, currentSectionId, sectionLabel } from "../../domain/chapter-navigation.js";

/** Keep chapter cues on the media element's timeline and mirror them to media-chrome. */
export class ChapterTimeline {
  #video;
  #range;
  #currentDisplay;
  #track;
  #sections = [];
  #duration = NaN;
  #currentId = null;

  constructor(video, range, currentDisplay) {
    this.#video = video;
    this.#range = range;
    this.#currentDisplay = currentDisplay;
    this.#track = typeof video.addTextTrack === "function"
      ? video.addTextTrack("chapters", "Playback chapters")
      : null;
    if (this.#track) this.#track.mode = "hidden";
  }

  setSnapshot(snapshot) {
    const unsupported = snapshot?.state === "unsupported" || snapshot?.capability === "unsupported";
    this.#sections = unsupported ? [] : navigableSections(snapshot?.sections);
    this.#render();
    this.setCurrentTime(this.#video.currentTime);
  }

  setDuration(duration) {
    this.#duration = Number.isFinite(duration) && duration > 0 ? duration : NaN;
    this.#render();
    this.setCurrentTime(this.#video.currentTime);
  }

  setCurrentTime(currentTime) {
    const nextId = currentSectionId(this.#sections, currentTime, this.#duration);
    const section = this.#sections.find((item) => item.id === nextId);
    const label = section && hasSectionTitle(section) ? sectionLabel(section) : "";
    if (nextId === this.#currentId && label === this.#currentDisplay.textContent) return;
    this.#currentId = nextId;
    this.#currentDisplay.textContent = label;
  }

  clear() {
    this.#sections = [];
    this.#currentId = null;
    this.#currentDisplay.textContent = "";
    this.#render();
  }

  #render() {
    for (const cue of Array.from(this.#track?.cues ?? [])) this.#track.removeCue(cue);
    const intervals = playbackSectionIntervals(this.#sections, this.#duration);
    const Cue = this.#video.ownerDocument?.defaultView?.VTTCue ?? globalThis.VTTCue;
    const cues = typeof Cue === "function"
      ? intervals.map(({ startSeconds, endSeconds, ...section }) => ({
        text: escapeCueText(sectionLabel(section)),
        startTime: startSeconds,
        endTime: endSeconds
      }))
      : [];

    if (this.#track) {
      for (const cue of cues) this.#track.addCue(new Cue(cue.startTime, cue.endTime, cue.text));
    }
    this.#range.mediaChaptersCues = cues;
  }
}

function hasSectionTitle(section) {
  return section?.titles?.some((entry) => typeof entry?.text === "string" && entry.text.trim()) ?? false;
}

function escapeCueText(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
