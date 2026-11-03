import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const READ_CHUNK_BYTES = 1024 * 1024;
const JSON_WHITESPACE = new Set([' ', '\t', '\n', '\r']);

function trimJsonWhitespace(value) {
  return value.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '');
}

/**
 * Read a top-level JSON array without materializing the entire file as one
 * JavaScript string. Each array item is still parsed with JSON.parse, so the
 * accepted JSON grammar and value types match the regular JSON reader.
 *
 * @param {string} filePath
 * @param {{collect?: boolean, onItem?: (item: unknown, index: number) => void}} [options]
 * @returns {unknown[] | number} Parsed items, or the item count when collect=false.
 */
export function readJsonArrayFile(filePath, { collect = true, onItem } = {}) {
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  const decoder = new StringDecoder('utf8');
  const items = collect ? [] : null;
  let count = 0;
  let state = 'leading';
  let itemParts = [];
  let nestedDepth = 0;
  let inString = false;
  let escaped = false;

  const finishItem = () => {
    const source = trimJsonWhitespace(itemParts.join(''));
    if (!source) throw new SyntaxError(`empty item in JSON array: ${filePath}`);
    const value = JSON.parse(source);
    if (collect) items.push(value);
    onItem?.(value, count);
    count += 1;
    itemParts = [];
    nestedDepth = 0;
    inString = false;
    escaped = false;
  };

  const consume = (text) => {
    let itemStart = 0;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (state === 'leading') {
        if (JSON_WHITESPACE.has(char)) continue;
        if (char !== '[') throw new SyntaxError(`expected a top-level JSON array: ${filePath}`);
        state = 'after-open';
        continue;
      }

      if (state === 'after-open' || state === 'after-comma') {
        if (JSON_WHITESPACE.has(char)) continue;
        if (char === ']' && state === 'after-open') {
          state = 'closed';
          continue;
        }
        if (char === ']') throw new SyntaxError(`trailing comma in JSON array: ${filePath}`);
        state = 'item';
        itemStart = index;
      }

      if (state === 'closed') {
        if (!JSON_WHITESPACE.has(char)) throw new SyntaxError(`unexpected data after JSON array: ${filePath}`);
        continue;
      }

      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === '{' || char === '[') {
        nestedDepth += 1;
      } else if (char === '}') {
        if (nestedDepth <= 0) throw new SyntaxError(`unexpected } in JSON array item: ${filePath}`);
        nestedDepth -= 1;
      } else if (char === ']') {
        if (nestedDepth === 0) {
          if (index > itemStart) itemParts.push(text.slice(itemStart, index));
          finishItem();
          state = 'closed';
          itemStart = index + 1;
        } else {
          nestedDepth -= 1;
        }
      } else if (char === ',' && nestedDepth === 0) {
        if (index > itemStart) itemParts.push(text.slice(itemStart, index));
        finishItem();
        state = 'after-comma';
        itemStart = index + 1;
      }
    }
    if (state === 'item' && itemStart < text.length) itemParts.push(text.slice(itemStart));
  };

  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      consume(decoder.write(buffer.subarray(0, bytesRead)));
    }
    consume(decoder.end());
    if (state !== 'closed') throw new SyntaxError(`unexpected end of JSON array: ${filePath}`);
    return collect ? items : count;
  } finally {
    fs.closeSync(fd);
  }
}

/** Return whether the first non-whitespace byte is the JSON array opener. */
export function hasTopLevelJsonArray(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      for (let index = 0; index < bytesRead; index += 1) {
        const byte = buffer[index];
        if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
        return byte === 0x5b;
      }
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}
