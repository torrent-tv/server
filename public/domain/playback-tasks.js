/** Serialize preparation while immediately cancelling a superseded request. */
export class PlaybackTasks {
  #version = 0;
  #pending = Promise.resolve();

  replace(run, cancel) {
    const version = ++this.#version;
    cancel();
    const predecessor = this.#pending;
    const pending = predecessor.catch(() => {}).then(() => {
      if (version !== this.#version) return;
      return run();
    });
    this.#pending = pending;
    return pending;
  }

  invalidate() {
    this.#version += 1;
  }
}
