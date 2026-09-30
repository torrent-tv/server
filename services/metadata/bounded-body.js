/**
 * @file Read a response body without ever holding more than a stated number of
 * bytes of it.
 *
 * Selecting the fields we keep AFTER parsing a large answer does not stop the
 * memory being spent: the whole text and the whole parsed object exist first.
 * So the limit is applied while the bytes arrive, and a body that passes it is
 * abandoned at that byte.
 */

import { MetadataUnavailableError } from "./RequestGate.js";

/**
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
export async function readBoundedBody(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new MetadataUnavailableError(`the answer is larger than ${maxBytes} bytes`);
  }
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new MetadataUnavailableError(`the answer is larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}
