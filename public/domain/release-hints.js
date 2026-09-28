/**
 * Conservative media hints found in release filenames.
 *
 * These values are only an early proxy-selection aid. The file's own header
 * remains authoritative once the playback plan is read.
 *
 * @param {string} name
 * @returns {{ width: number, height: number, fps: number | null, bitrateKbps: number | null, codec: string | null } | null}
 */
export function mediaInfoHintFromFilename(name) {
  const text = typeof name === "string" ? name : "";
  const dimensions = /(?:^|[^\d])(\d{3,4})\s*[x×]\s*(\d{3,4})(?:[^\d]|$)/i.exec(text);
  const namedHeight = /(?:^|[^a-z0-9])((?:144|240|360|432|480|540|576|720|900|1080|1440|2160|4320))\s*p(?:$|[^a-z0-9])/i.exec(text);
  const width = dimensions ? Number(dimensions[1]) : namedHeight ? Math.round(Number(namedHeight[1]) * 16 / 9) : 0;
  const height = dimensions ? Number(dimensions[2]) : namedHeight ? Number(namedHeight[1]) : 0;
  if (!(width > 0 && height > 0)) {
    return null;
  }

  const codec = /(?:^|[^a-z0-9])(?:av1)(?:$|[^a-z0-9])/i.test(text)
    ? "av1"
    : /(?:^|[^a-z0-9])(?:x265|h[ ._-]?265|hevc)(?:$|[^a-z0-9])/i.test(text)
      ? "hevc"
      : /(?:^|[^a-z0-9])(?:x264|h[ ._-]?264|avc)(?:$|[^a-z0-9])/i.test(text)
        ? "h264"
        : null;
  return { width, height, fps: null, bitrateKbps: null, codec };
}
