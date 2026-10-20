import { chapterTree, currentSectionId, formatChapterTime, navigableSections, sectionTitle } from "../../domain/chapter-navigation.js";
import { MEDIA_INFO_EVENTS, PLAYER_EVENTS } from "../../shared/events.js";

/** Render and navigate the selected file's chapter list. */
export class Chapters {
  static SELECTOR = {
    root: "#chapters",
    firstChapter: "button[data-chapter-id]",
    expandChapter: "button[data-chapter-expand]"
  };

  #root;
  #snapshot = null;
  #sections = [];
  #expandedSectionIds = new Set();
  #currentTime = 0;
  #duration = NaN;
  #activeSectionId = null;

  constructor() {
    this.#root = document.querySelector(Chapters.SELECTOR.root);
    if (!this.#root) throw new Error("Chapters component DOM node is missing.");
    document.addEventListener(MEDIA_INFO_EVENTS.CHAPTERS, this.#onSnapshot);
    document.addEventListener(PLAYER_EVENTS.POSITION_CHANGED, this.#onPosition);
    document.addEventListener(PLAYER_EVENTS.PANEL_CHANGED, this.#onPanelChanged);
    this.#root.addEventListener("click", this.#onClick);
  }

  #onSnapshot = (event) => {
    const snapshot = event instanceof CustomEvent ? event.detail : null;
    if (!snapshot || snapshot.sourceKey !== this.#snapshot?.sourceKey || snapshot.fileIndex !== this.#snapshot?.fileIndex ||
      snapshot.generation !== this.#snapshot?.generation) this.#expandedSectionIds.clear();
    this.#snapshot = snapshot;
    this.#sections = navigableSections(this.#snapshot?.sections);
    this.#render();
  };

  #onPosition = (event) => {
    const currentTime = event instanceof CustomEvent ? event.detail?.currentTime : null;
    if (!Number.isFinite(currentTime)) return;
    this.#currentTime = currentTime;
    this.#duration = event.detail.duration;
    const previousActiveSectionId = this.#activeSectionId;
    this.#updateCurrent();
    if (this.#root.dataset.open === "true" && this.#activeSectionId !== previousActiveSectionId) this.#expandCurrentAncestors();
  };

  #onPanelChanged = (event) => {
    const panel = event instanceof CustomEvent ? event.detail?.panel : null;
    const open = panel === "chapters";
    this.#root.hidden = !open;
    this.#root.inert = !open;
    this.#root.dataset.open = String(open);
    if (!open) return;
    this.#expandCurrentAncestors();
    const current = this.#root.querySelector('button[aria-current="location"]');
    const first = this.#root.querySelector(Chapters.SELECTOR.firstChapter);
    (current ?? first ?? this.#root).focus({ preventScroll: true });
  };

  #onClick = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const expandButton = target.closest(Chapters.SELECTOR.expandChapter);
    if (expandButton instanceof HTMLButtonElement) {
      const children = Array.from(expandButton.parentElement?.children ?? [])
        .find((element) => element.matches("ul.chapters__children"));
      if (!(children instanceof HTMLUListElement)) return;
      const expanded = expandButton.getAttribute("aria-expanded") !== "true";
      expandButton.setAttribute("aria-expanded", String(expanded));
      children.hidden = !expanded;
      const chapterButton = Array.from(expandButton.parentElement.children)
        .find((element) => element.matches(Chapters.SELECTOR.firstChapter));
      if (chapterButton instanceof HTMLButtonElement) {
        if (expanded) this.#expandedSectionIds.add(chapterButton.dataset.chapterId);
        else this.#expandedSectionIds.delete(chapterButton.dataset.chapterId);
      }
      return;
    }

    const button = target.closest(Chapters.SELECTOR.firstChapter);
    if (!(button instanceof HTMLButtonElement)) return;
    const section = this.#sections.find((item) => item.id === button.dataset.chapterId);
    if (!section) return;
    document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.REQUEST_SEEK, {
      detail: { positionSeconds: section.startSeconds }
    }));
    document.dispatchEvent(new CustomEvent(PLAYER_EVENTS.SET_PANEL, { detail: { panel: null } }));
  };

  #render() {
    this.#root.replaceChildren();
    if (this.#sections.length > 0) {
      chapterTree(this.#sections).forEach((node, index) => this.#root.append(this.#sectionItem(node, String(index))));
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

  #sectionItem(node, path) {
    const { section, children } = node;
    const item = document.createElement("li");
    const button = document.createElement("button");
    const title = document.createElement("span");
    const time = document.createElement("time");
    const seconds = section.startSeconds;

    button.type = "button";
    button.dataset.chapterId = section.id;
    button.className = "chapters__select";
    title.className = "chapters__title";
    title.textContent = sectionTitle(section);
    time.className = "chapters__time";
    time.dateTime = `PT${String(Number(seconds.toFixed(3)))}S`;
    time.textContent = formatChapterTime(seconds);
    button.append(title, time);
    item.append(button);

    if (children.length > 0) {
      const expand = document.createElement("button");
      const childList = document.createElement("ul");
      const expanded = this.#expandedSectionIds.has(section.id);
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const pathElement = document.createElementNS("http://www.w3.org/2000/svg", "path");

      expand.type = "button";
      expand.dataset.chapterExpand = "";
      expand.setAttribute("aria-label", `Toggle subchapters for ${sectionTitle(section)}`);
      expand.setAttribute("aria-expanded", String(expanded));
      expand.setAttribute("aria-controls", `chapters-children-${path}`);
      icon.setAttribute("class", "chapters__disclosure-icon");
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("aria-hidden", "true");
      pathElement.setAttribute("d", "m9 5 7 7-7 7");
      icon.append(pathElement);
      expand.append(icon);

      childList.className = "chapters__children";
      childList.id = `chapters-children-${path}`;
      childList.hidden = !expanded;
      children.forEach((child, index) => childList.append(this.#sectionItem(child, `${path}-${index}`)));
      item.append(expand, childList);
    }

    return item;
  }

  #expandCurrentAncestors() {
    let item = this.#root.querySelector('button[aria-current="location"]')?.parentElement;
    while (item) {
      const childList = item.parentElement;
      if (!(childList instanceof HTMLUListElement) || !childList.classList.contains("chapters__children")) return;
      const parentItem = childList.parentElement;
      if (!(parentItem instanceof HTMLLIElement)) return;
      const expand = Array.from(parentItem.children)
        .find((element) => element.matches(Chapters.SELECTOR.expandChapter));
      if (!(expand instanceof HTMLButtonElement)) return;
      childList.hidden = false;
      expand.setAttribute("aria-expanded", "true");
      const parentButton = Array.from(parentItem.children)
        .find((element) => element.matches(Chapters.SELECTOR.firstChapter));
      if (parentButton instanceof HTMLButtonElement) this.#expandedSectionIds.add(parentButton.dataset.chapterId);
      item = parentItem;
    }
  }

  #updateCurrent() {
    const activeId = currentSectionId(this.#sections, this.#currentTime, this.#duration);
    this.#activeSectionId = activeId;
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

