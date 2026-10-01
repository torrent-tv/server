/** The chosen destination survives metadata waits and asynchronous proxy replies. */
export class SeekPosition {
  value = null;
  #revision = 0;

  reset(position = null) {
    this.value = position;
    this.#revision += 1;
  }

  async move(position, { stopLoad, reportSeek, startLoad }) {
    if (!Number.isFinite(position) || position < 0) return;
    this.value = position;
    const revision = ++this.#revision;
    stopLoad();
    try {
      await reportSeek(position);
    } catch (error) {
      if (revision !== this.#revision) return;
      throw error;
    }
    if (revision === this.#revision) startLoad(position);
  }
}
