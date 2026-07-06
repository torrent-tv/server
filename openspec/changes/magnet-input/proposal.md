# Proposal: Magnet link input (queued)

## Why

Major indexers hand out magnet links as the primary (sometimes only)
artefact; supporting them removes the "download a file, then feed it to the
site" step. The `.torrent` file already works through every input path; the
same paths should accept magnets.

## What Changes

Magnet links accepted through the same three channels the `.torrent` file
already has (plus drag-and-drop for files):

1. **URL parameter** — alongside the existing `?torrent=<base64 of file>`,
   a `?magnet=<encoded magnet URI>` parameter.
2. **Clipboard paste** — the document paste handler today reads only
   `clipboardData.files`; it additionally reads text and, when it parses as
   a magnet URI, starts the flow.
3. **Input field** — a text input on the picker next to the file control.

Proxy side: the source registry already accepts
`sourceType: "magnet"` end-to-end (torrent-pool passes the URI to
WebTorrent, which fetches metadata via DHT/peers). The browser, however,
parses the `.torrent` locally to list files BEFORE contacting a proxy — for
magnets it cannot. Needed: a proxy route returning the metadata file list
for a registered source, and a browser flow that defers file listing until
the proxy responds (loading screen shows "fetching metadata from the
swarm").

## Capabilities

### New Capabilities

- `magnet-input`: accepting magnet URIs through URL, paste and input, and
  the deferred file-listing flow they require.

### Modified Capabilities

<!-- none -->

## Impact

- server: `components/torrent/` (input + paste + URL param), loading flow
  branch for deferred metadata.
- proxy: metadata/file-list route for a registered source (+ addon bump).

## Priority

Queued after `cancel-loading` and the tracks stage (embedded subtitles,
audio selection).
