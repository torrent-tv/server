import { validateSubtitleQuery } from "../../../../services/subtitles/SubtitleService.js";
import { signalOfRequest } from "../../metadata/request-signal.js";
import { withProviderContext } from "../../../../services/metadata/provider-diagnostics.js";

export async function handleApiSubtitlesSearchPost(req, reply, { subtitles }) {
  const query = validateSubtitleQuery(req.body);
  if (!query) return reply.code(400).send({ error: "A work ID and a confirmed episode are required." });
  reply.header("Cache-Control", "no-store");
  return reply.send(await withProviderContext(req, () => subtitles.search(query, signalOfRequest(reply))));
}
