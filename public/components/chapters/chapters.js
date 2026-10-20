import { currentSectionId, formatChapterTime, navigableSections, sectionTitle, sectionTypeLabel } from "../../domain/chapter-navigation.js";
import { MEDIA_INFO_EVENTS, PLAYER_EVENTS } from "../../shared/events.js";

/** Render and navigate the selected file's chapter list. */
export class Chapters {
  static SELECTOR = {
    root: "#chapters",
    firstChapter: "button[data-chapter-id]"
  };

  #root;
  #snapshot = null;
  #sections = [];
  #currentTime = 0;
  #duration = NaN;

  constructor() {
    this.#root = document.querySelector(Chapters.SELECTOR.root);
    if (!this.#root) throw new Error("Chapters component DOM node is missing.");
    document.addEventListener(MEDIA_INFO_EVENTS.CHAPTERS, this.#onSnapshot);
    document.addEventListener(PLAYER_EVENTS.POSITION_CHANGED, this.#onPosition);
    document.addEventListener(PLAYER_EVENTS.PANEL_CHANGED, this.#onPanelChanged);
    this.#root.addEventListener("click", this.#onClick);
  }

  #onSnapshot = (event) => {
    this.#snapshot = event instanceof CustomEvent ? event.detail : null;
    this.#sections = navigableSections(this.#snapshot?.sections);
    this.#render();
  };

  #onPosition = (event) => {
    const currentTime = event instanceof CustomEvent ? event.detail?.currentTime : null;
    if (!Number.isFinite(currentTime)) return;
    this.#currentTime = currentTime;
    this.#duration = event.detail.duration;
    this.#updateCurrent();
  };

  #onPanelChanged = (event) => {
    const panel = event instanceof CustomEvent ? event.detail?.panel : null;
    const open = panel === "chapters";
    this.#root.hidden = !open;
    this.#root.inert = !open;
    this.#root.dataset.open = String(open);
    if (!open) return;
    const current = this.#root.querySelector('button[aria-current="location"]');
    const first = this.#root.querySelector(Chapters.SELECTOR.firstChapter);
    (current ?? first ?? this.#root).focus({ preventScroll: true });
  };

  #onClick = (event) => {
    const target = event.target;
    const button = target instanceof Element ? target.closest(Chapters.SELECTOR.firstChapter) : null;
    if (!(button instanceof HTMLButtonElement)) return;
    const section = this.#sections.find((item) => item.id === button.dataset.chapterId);
    if (!section) return;
    document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.REQUEST_SEEK, {
      detail: { positionSeconds: section.startSeconds }
    }));
  };

  #render() {
    this.#root.replaceChildren();
    if (this.#sections.length > 0) {
      for (const section of this.#sections) this.#root.append(this.#sectionItem(section));
      this.#updateCurrent();
      return;
    }

    const message = this.#statusMessage();
    if (message) {
      const item = document.createElement("li");
      item.className = "chapters__message";
      item.setAttribute("role", "status");
      item.textContent = message;
      this.#root.append(item);
    }
  }

  #statusMessage() {
    if (!this.#snapshot) return "";
    if (this.#snapshot.state === "error") return "Chapter information is unavailable.";
    if (this.#snapshot.state === "pending" || this.#snapshot.complete === false) return "Reading chapters…";
    return "";
  }

  #sectionItem(section) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    const title = document.createElement("span");
    const details = document.createElement("span");
    const type = document.createElement("span");
    const time = document.createElement("time");
    const seconds = section.startSeconds;

    button.type = "button";
    button.dataset.chapterId = section.id;
    title.className = "chapters__title";
    title.textContent = sectionTitle(section);
    details.className = "chapters__details";
    type.className = "chapters__type";
    type.textContent = sectionTypeLabel(section.type);
    time.dateTime = `PT${String(Number(seconds.toFixed(3)))}S`;
    time.textContent = formatChapterTime(seconds);
    details.append(type, time);
    button.append(title, details);
    item.append(button);
    return item;
  }

  #updateCurrent() {
    const activeId = currentSectionId(this.#sections, this.#currentTime, this.#duration);
    for (const button of this.#root.querySelectorAll(Chapters.SELECTOR.firstChapter)) {
      if (button.dataset.chapterId === activeId) button.setAttribute("aria-current", "location");
      else button.removeAttribute("aria-current");
    }
  }
}

function bootstrapChapters() {
  new Chapters();
}

if (document.readyState !== "loading") bootstrapChapters();
else document.addEventListener("DOMContentLoaded", bootstrapChapters, { once: true });

