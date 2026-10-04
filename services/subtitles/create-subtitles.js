import { readFileSync } from "node:fs";
import { OpenSubtitles } from "./OpenSubtitles.js";
import { Jimaku } from "./Jimaku.js";
import { SubtitleService } from "./SubtitleService.js";

function readKey(name) {
  if (process.env[name]) return process.env[name].trim();
  const file = process.env[`${name}_FILE`];
  if (!file) return null;
  try { return readFileSync(file, "utf8").trim() || null; }
  catch (error) { console.warn(`[subtitles] ${name} unavailable: ${error.code}`); return null; }
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
