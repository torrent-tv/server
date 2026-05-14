function encodePathSegments(path) {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function buildFileUrl(seedBase, file, isMultiFile) {
  const base = seedBase.trim();
  if (!base) {
    return "";
  }

  if (!isMultiFile) {
    return base;
  }

  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  return `${normalizedBase}${encodePathSegments(file.relativePath)}`;
}

export function pickWebSeedUrl(file, webSeeds, isMultiFile) {
  for (const seed of webSeeds) {
    const fileUrl = buildFileUrl(seed, file, isMultiFile);
    if (fileUrl) {
      return fileUrl;
    }
  }
  return "";
}

export async function probeWebSeed(fileUrl, options = {}) {
  const signal = options?.signal instanceof AbortSignal ? options.signal : undefined;
  const response = await fetch(fileUrl, {
    method: "HEAD",
    mode: "cors",
    signal
  });
  if (!response.ok) {
    throw new Error(`Webseed returned status ${response.status}.`);
  }

  const acceptRanges = response.headers.get("accept-ranges") ?? "";
  return {
    supportsRange: acceptRanges.toLowerCase().includes("bytes")
  };
}
