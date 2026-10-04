import { signalOfRequest } from "../../metadata/request-signal.js";

export async function handleApiSubtitlesFilePost(req, reply, { subtitles }) {
  if (typeof req.body?.token !== "string" || req.body.token.length > 6000) return reply.code(400).send({ error: "A subtitle selection token is required." });
  reply.header("Cache-Control", "no-store");
  const result = await subtitles.file(req.body.token, signalOfRequest(reply));
  if (result.status !== "ready") return reply.code(result.status === "expired" ? 410 : 503).send({ error: "This subtitle is unavailable. Choose it again after refreshing the list." });
  return reply.type("text/vtt; charset=utf-8").send(result.vtt);
}
