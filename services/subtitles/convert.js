/** Convert standalone provider text; no video, ffmpeg or torrent is involved. */
export function subtitleVtt(bytes, filename, language = "und") {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch {
    const encodings = { ru: "windows-1251", uk: "windows-1251", bg: "windows-1251", ja: "shift_jis", zh: "gb18030", el: "windows-1253", tr: "windows-1254", he: "windows-1255", ar: "windows-1256" };
    text = new TextDecoder(encodings[language] ?? "windows-1252").decode(bytes);
  }
  text = text.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  if (text.trimStart().startsWith("WEBVTT")) return text.trimStart();
  const ass = /\.(ass|ssa)$/iu.test(filename) || /^\[Events\]/imu.test(text);
  const cues = [];
  if (ass) {
    let columns = null;
    let events = false;
    for (const line of text.split("\n")) {
      if (/^\s*\[.*\]\s*$/u.test(line)) { events = /^\s*\[Events\]\s*$/iu.test(line); continue; }
      if (!events) continue;
      if (/^\s*Format:/iu.test(line)) { columns = line.split(":").slice(1).join(":").split(",").map(c => c.trim().toLowerCase()); continue; }
      if (!columns || !/^\s*Dialogue:/iu.test(line) || columns.at(-1) !== "text") continue;
      const fields = line.replace(/^\s*Dialogue:/iu, "").split(",");
      const start = fields[columns.indexOf("start")]?.trim();
      const end = fields[columns.indexOf("end")]?.trim();
      if (!/^\d+:\d{2}:\d{2}\.\d{1,2}$/u.test(start ?? "") || !/^\d+:\d{2}:\d{2}\.\d{1,2}$/u.test(end ?? "")) continue;
      const stamp = t => { const [h, m, s] = t.split(":"); return `${h.padStart(2, "0")}:${m}:${s.padEnd(6, "0")}`; };
      // ASS drawing events are not dialogue; positioning and styles cannot be
      // represented completely in the existing native WebVTT renderer.
      const raw = fields.slice(columns.length - 1).join(",");
      if (/\{[^}]*\\p[1-9]/u.test(raw)) continue;
      const clean = raw.replace(/\{[^}]*\}/gu, "").replace(/\\[Nn]/gu, "\n").replace(/\\h/gu, " ");
      if (clean.trim()) cues.push(`${stamp(start)} --> ${stamp(end)}\n${escapeText(clean)}`);
    }
  } else {
    for (const block of text.split(/\n\s*\n/gu)) {
      const lines = block.split("\n");
      const at = lines.findIndex(line => /^\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{3}/u.test(line));
      if (at < 0 || !lines.slice(at + 1).join("\n").trim()) continue;
      const timing = lines[at].match(/^(\d{1,2}:\d{2}:\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2})[,.](\d{3})/u);
      cues.push(`${timing[1].padStart(8, "0")}.${timing[2]} --> ${timing[3].padStart(8, "0")}.${timing[4]}\n${escapeText(lines.slice(at + 1).join("\n"))}`);
    }
  }
  if (!cues.length) throw new Error("subtitle file contains no supported text cues");
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

function escapeText(text) {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}
