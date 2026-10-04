import { ProviderHttp } from "./ProviderHttp.js";

/** Every provider implements search(query) and download(item). */
export class SubtitleProvider {
  constructor({ name, origin, headers, fetch }) {
    this.name = name;
    this.http = new ProviderHttp({ origin, headers, fetch });
  }

  async search(_query) { throw new Error("SubtitleProvider.search must be implemented"); }
  async download(_item) { throw new Error("SubtitleProvider.download must be implemented"); }
}
