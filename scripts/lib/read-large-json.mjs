import fs from 'node:fs';
import { TextDecoder } from 'node:util';

// V8 refuses to materialize a single string larger than this value. Keep the
// normal path byte-for-byte identical, and only switch to item-wise parsing
// for the assembled jobs array once the file crosses the limit.
export const DEFAULT_JSON_STRING_LIMIT = 0x1fffffe8;
const READ_CHUNK_BYTES = 1024 * 1024;

function isWhitespace(char) {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t';
}

/**
 * Parse a top-level JSON array without ever concatenating the whole file.
 * Each array item is still parsed as one JSON value, which keeps the parser
 * bounded by the largest individual job record.
 */
export function parseLargeJsonArray(chunks) {
  const items = [];
  let rootStarted = false;
  let rootEnded = false;
  let itemParts = [];
  let itemDepth = 0;
  let inString = false;
  let escaped = false;

  const finishItem = () => {
    if (itemParts.length === 0 || itemDepth !== 0 || inString) {
      throw new SyntaxError('incomplete JSON array item');
    }
    items.push(JSON.parse(itemParts.join('')));
    itemParts = [];
    escaped = false;
  };

  for (const chunk of chunks) {
    for (const char of chunk) {
      if (rootEnded) {
        if (!isWhitespace(char)) throw new SyntaxError('unexpected data after JSON array');
        continue;
      }

      if (!rootStarted) {
        if (isWhitespace(char)) continue;
        if (char !== '[') throw new SyntaxError('large JSON input must be a top-level array');
        rootStarted = true;
        continue;
      }

      if (itemParts.length === 0) {
        if (isWhitespace(char) || char === ',') continue;
        if (char === ']') {
          rootEnded = true;
          continue;
        }
        if (char !== '{' && char !== '[') {
          throw new SyntaxError('large JSON array items must be objects or arrays');
        }
        itemParts = [char];
        itemDepth = 1;
        inString = false;
        escaped = false;
        continue;
      }

      itemParts.push(char);
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{' || char === '[') {
        itemDepth += 1;
      } else if (char === '}' || char === ']') {
        itemDepth -= 1;
        if (itemDepth < 0) throw new SyntaxError('unbalanced JSON array item');
        if (itemDepth === 0) finishItem();
      }
    }
  }

  if (!rootStarted || !rootEnded || itemParts.length !== 0 || inString || itemDepth !== 0) {
    throw new SyntaxError('unterminated large JSON array');
  }
  return items;
}

function* readTextChunks(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let position = 0;
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      yield decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read JSON normally until the runtime string limit would be exceeded, then
 * parse a large top-level array item by item.
 */
export function readJsonFile(filePath, { maxInlineBytes = DEFAULT_JSON_STRING_LIMIT } = {}) {
  const { size } = fs.statSync(filePath);
  if (size <= maxInlineBytes) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return parseLargeJsonArray(readTextChunks(filePath));
}
