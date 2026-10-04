import { MEDIA_INFO_EVENTS } from "../../shared/events.js";
import { providerSubtitleQuery } from "../../domain/provider-subtitles.js";

/** Provider discovery follows the active picture without delaying playback. */
export class ProviderSubtitles {
  #state = null;
  #file = null;
  #key = null;
  #abort = null;
  #onItems;

  constructor(onItems) {
    this.#onItems = onItems;
    document.addEventListener(MEDIA_INFO_EVENTS.CHANGED, event => {
      this.#state = event instanceof CustomEvent ? event.detail : null;
      if (!this.#state) this.clear();
      else void this.#search();
    });
  }

  clear() { this.#abort?.abort(); this.#abort = null; this.#file = null; this.#key = null; }
  start(fileIndex) { this.clear(); this.#file = fileIndex; void this.#search(); }
  retry() { this.#key = null; void this.#search(); }

  async #search() {
    if (this.#file === null) return;
    const query = providerSubtitleQuery(this.#state, this.#file);
    if (!query) return;
    const key = JSON.stringify(query);
    if (key === this.#key) return;
    this.#abort?.abort();
    const abort = new AbortController();
    this.#abort = abort;
    this.#key = key;
    try {
      const response = await fetch("/api/subtitles/search", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: key,
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(35_000)])
      });
      if (!response.ok) throw new Error(`subtitle search returned ${response.status}`);
      const data = await response.json();
      if (this.#abort !== abort || abort.signal.aborted) return;
      this.#onItems((data.providers ?? []).flatMap(p => p.items ?? []), data.providers ?? []);
    } catch (error) {
      if (abort.signal.aborted) return;
      console.warn("[subtitles] provider discovery unavailable", error);
      this.#onItems([], [{ provider: "Provider search", status: "unavailable" }]);
    }
  }

  async load(item, signal) {
    const request = token => fetch("/api/subtitles/file", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(50_000)])
    });
    let response = await request(item.token);
    if (response.status === 410 && this.#key) {
      await response.body?.cancel();
      // A restart rotates selection permits. Refresh discovery once; a refused
      // permit has not consumed a download, so this cannot double-charge one.
      const refreshed = await fetch("/api/subtitles/search", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: this.#key,
        signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)])
      });
      if (refreshed.ok) {
        const data = await refreshed.json();
        const current = (data.providers ?? []).flatMap(p => p.items ?? []).find(candidate => candidate.provider === item.provider && candidate.id === item.id);
        if (current) { item.token = current.token; response = await request(current.token); }
      }
    }
    if (!response.ok) throw new Error(`subtitle download returned ${response.status}`);
    const text = await response.text();
    if (!text.startsWith("WEBVTT")) throw new Error("invalid subtitle document");
    return text;
  }
}
