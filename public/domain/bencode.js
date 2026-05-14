const textDecoder = new TextDecoder();

function readNumber(data, start, endByte) {
  let index = start;
  let numberText = "";
  while (index < data.length && data[index] !== endByte) {
    numberText += String.fromCharCode(data[index]);
    index += 1;
  }
  if (index >= data.length) {
    throw new Error("Unexpected end while reading number.");
  }
  if (!/^[-]?\d+$/.test(numberText)) {
    throw new Error(`Invalid number value: ${numberText}`);
  }
  return { value: Number(numberText), next: index + 1 };
}

function decodeNode(data, offset) {
  if (offset >= data.length) {
    throw new Error("Unexpected end of bencode data.");
  }

  const marker = data[offset];

  if (marker === 0x69) {
    const { value, next } = readNumber(data, offset + 1, 0x65);
    return { value, next };
  }

  if (marker === 0x6c) {
    const list = [];
    let index = offset + 1;
    while (index < data.length && data[index] !== 0x65) {
      const decoded = decodeNode(data, index);
      list.push(decoded.value);
      index = decoded.next;
    }
    if (index >= data.length) {
      throw new Error("Unterminated list.");
    }
    return { value: list, next: index + 1 };
  }

  if (marker === 0x64) {
    const dictionary = {};
    let index = offset + 1;
    while (index < data.length && data[index] !== 0x65) {
      const keyDecoded = decodeNode(data, index);
      if (!(keyDecoded.value instanceof Uint8Array)) {
        throw new Error("Dictionary key is not a byte string.");
      }
      const key = textDecoder.decode(keyDecoded.value);

      const valueStart = keyDecoded.next;
      const valueDecoded = decodeNode(data, valueStart);
      const valueEnd = valueDecoded.next;

      dictionary[key] = valueDecoded.value;
      if (key === "info") {
        dictionary.__infoStart = valueStart;
        dictionary.__infoEnd = valueEnd;
      }
      index = valueEnd;
    }
    if (index >= data.length) {
      throw new Error("Unterminated dictionary.");
    }
    return { value: dictionary, next: index + 1 };
  }

  if (marker >= 0x30 && marker <= 0x39) {
    const { value: stringLength, next } = readNumber(data, offset, 0x3a);
    if (!Number.isInteger(stringLength) || stringLength < 0) {
      throw new Error(`Invalid byte string length: ${stringLength}`);
    }
    const end = next + stringLength;
    if (end > data.length) {
      throw new Error("Byte string exceeds payload length.");
    }
    return { value: data.slice(next, end), next: end };
  }

  throw new Error(`Unsupported bencode marker: ${marker}`);
}

export function decodeBencode(data) {
  const decoded = decodeNode(data, 0);
  if (decoded.next !== data.length) {
    throw new Error("Trailing bytes after valid bencode payload.");
  }
  return decoded.value;
}

export function bytesToUtf8(value) {
  if (typeof value === "string") {
    return value;
  }
  if (!(value instanceof Uint8Array)) {
    return "";
  }
  return textDecoder.decode(value);
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function bytesToBase32(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 31];
  }
  return output;
}
