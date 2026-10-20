/** Selected-file metadata only; no chapter UI or automatic playback actions. */
export class ChapterMetadata {
  constructor(publish) { this.publish = publish; this.clear(); }

  clear() {
    this.abort?.abort();
    this.selection = null;
    this.snapshot = null;
    this.reading = null;
    this.again = false;
    this.active = false;
    this.publish(null);
  }

  select({ sourceKey, fileIndex, transport, defer = false }) {
    this.clear();
    this.selection = { sourceKey, fileIndex, transport };
    this.abort = new AbortController();
    this.active = !defer;
    void this.refresh();
  }

  activate() {
    if (this.active || !this.selection) return;
    this.active = true;
    void this.refresh();
  }

  changed(event) {
    if (event?.sourceKey === this.selection?.sourceKey && event?.fileIndex === this.selection?.fileIndex) {
      void this.refresh();
    }
  }

  async refresh() {
    if (!this.selection || !this.active) return;
    if (this.reading) { this.again = true; return this.reading; }
    const selected = this.selection;
    const signal = this.abort.signal;
    const read = (async () => {
      try {
        const response = await selected.transport.fetch(`/api/sources/${encodeURIComponent(selected.sourceKey)}/chapters?fileIndex=${selected.fileIndex}`, { signal, timeoutMs: 15000 });
        let answer;
        if (response.status === 404) {
          let body = null;
          if (typeof response.json === "function") {
            try { body = await response.json(); }
            catch (error) { console.warn("Chapter metadata error response could not be parsed", error); }
          }
          answer = body?.code === "SOURCE_NOT_FOUND"
            ? { capability: "supported", state: "error", reason: "source-not-found", complete: false }
            : { capability: "unsupported", state: "unsupported", reason: "chapter-endpoint-unavailable", complete: true };
        }
        else if (!response.ok) answer = { state: "error", reason: `chapter-http:${response.status}`, complete: false };
        else {
          answer = await response.json();
          if (answer?.version !== 1 || answer?.capability !== "supported") answer = { capability: "unsupported", state: "unsupported", reason: "chapter-contract-version", complete: true };
          else if (answer.sourceKey !== selected.sourceKey || answer.fileIndex !== selected.fileIndex) throw new Error("Chapter response does not match selected file");
        }
        if (this.selection !== selected || signal.aborted) return;
        if (answer.generation === this.snapshot?.generation && Number.isFinite(answer.revision) && Number.isFinite(this.snapshot?.revision) && answer.revision < this.snapshot.revision) return;
        this.snapshot = answer;
        this.publish(answer);
      } catch (error) {
        if (this.selection === selected && !signal.aborted) {
          console.warn("Chapter metadata request failed", error);
          this.snapshot = { state: "error", reason: error instanceof Error ? error.message : String(error), complete: false };
          this.publish(this.snapshot);
        }
      }
    })();
    this.reading = read;
    try { await read; }
    finally {
      if (this.reading === read) {
        this.reading = null;
        if (this.again) { this.again = false; void this.refresh(); }
      }
    }
  }
}
