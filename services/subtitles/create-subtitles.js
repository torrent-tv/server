import { OpenSubtitles } from "./OpenSubtitles.js";
import { Jimaku } from "./Jimaku.js";
import { SubtitleService } from "./SubtitleService.js";

function readKey(name) {
  return process.env[name]?.trim() || null;
}

export function createSubtitles(cache) {
  const providers = [];
  const openKey = readKey("OPENSUBTITLES_API_KEY");
  const jimakuKey = readKey("JIMAKU_API_KEY");
  if (openKey) providers.push(new OpenSubtitles({ key: openKey }));
  if (jimakuKey) providers.push(new Jimaku({ key: jimakuKey }));
  console.log(`[subtitles] enabled providers: ${providers.map(p => p.name).join(", ") || "none"}`);
  return new SubtitleService({ cache, providers });
}
