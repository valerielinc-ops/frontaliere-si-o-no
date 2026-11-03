import fs from 'node:fs';
import { TextDecoder } from 'node:util';

// V8 refuses to materialize a single string larger than this value. Keep the
// normal path byte-for-byte identical, and only switch to item-wise parsing
// for the assembled jobs array once the file crosses the limit.
export const DEFAULT_JSON_STRING_LIMIT = 0x1fffffe8;
const READ_CHUNK_BYTES = 1024 * 1024;
const TEXT_PART_CHARS = 16 * 1024;

function isWhitespace(char) {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t';
}

function createCharReader(chunks) {
  const iterator = chunks[Symbol.iterator]();
  let chunk = '';
  let offset = 0;
  let done = false;
  let hasBuffered = false;
  let buffered = '';

  const pull = () => {
    while (offset >= chunk.length && !done) {
      const next = iterator.next();
      if (next.done) {
        done = true;
        return null;
      }
      chunk = String(next.value);
      offset = 0;
    }
    if (done) return null;
    return chunk[offset++];
  };

  return {
    next() {
      if (hasBuffered) {
        hasBuffered = false;
        return { done: false, value: buffered };
      }
      const value = pull();
      return value === null ? { done: true, value: undefined } : { done: false, value };
    },
    peek() {
      if (!hasBuffered) {
        const value = pull();
        if (value === null) return null;
        buffered = value;
        hasBuffered = true;
      }
      return buffered;
    },
  };
}

function nextChar(reader, message) {
  const next = reader.next();
  if (next.done) throw new SyntaxError(message);
  return next.value;
}

function skipWhitespace(reader) {
  while (true) {
    const char = reader.peek();
    if (char === null || !isWhitespace(char)) return;
    reader.next();
  }
}

function createTextAccumulator(maxItemBytes) {
  const parts = [];
  let pending = [];
  let pendingLength = 0;
  let totalLength = 0;

  return {
    append(value) {
      totalLength += value.length;
      if (totalLength > maxItemBytes) {
        throw new SyntaxError('large JSON value exceeds the inline parser limit');
      }
      pending.push(value);
      pendingLength += value.length;
      if (pendingLength >= TEXT_PART_CHARS) {
        parts.push(pending.join(''));
        pending = [];
        pendingLength = 0;
      }
    },
    finish() {
      if (pending.length > 0) parts.push(pending.join(''));
      return parts.join('');
    },
  };
}

function consumeString(reader, maxItemBytes = DEFAULT_JSON_STRING_LIMIT) {
  const text = createTextAccumulator(maxItemBytes);
  text.append('"');
  let escaped = false;
  while (true) {
    const char = nextChar(reader, 'unterminated JSON string');
    text.append(char);
    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '"') {
      return text.finish();
    }
  }
}

function consumeContainer(reader, firstChar, maxItemBytes) {
  const text = createTextAccumulator(maxItemBytes);
  text.append(firstChar);
  let depth = 1;
  let inString = false;
  let escaped = false;

  while (depth > 0) {
    const char = nextChar(reader, 'unterminated large JSON value');
    text.append(char);
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ']') {
      depth -= 1;
    }
  }
  if (inString) throw new SyntaxError('unterminated JSON string');
  return text.finish();
}

function consumeValue(reader, firstChar, maxItemBytes) {
  if (firstChar === '"') return consumeString(reader, maxItemBytes);
  if (firstChar === '{' || firstChar === '[') {
    return consumeContainer(reader, firstChar, maxItemBytes);
  }

  const text = createTextAccumulator(maxItemBytes);
  text.append(firstChar);
  while (true) {
    const next = reader.peek();
    if (next === null || next === ',' || next === ']' || next === '}') break;
    text.append(reader.next().value);
  }
  return text.finish();
}

function parseArrayAfterOpen(reader, { maxItemBytes = DEFAULT_JSON_STRING_LIMIT } = {}) {
  const items = [];
  skipWhitespace(reader);
  if (reader.peek() === ']') {
    reader.next();
    return items;
  }

  while (true) {
    skipWhitespace(reader);
    const firstChar = nextChar(reader, 'unterminated large JSON array');
    if (firstChar !== '{' && firstChar !== '[') {
      throw new SyntaxError('large JSON array items must be objects or arrays');
    }
    const raw = consumeContainer(reader, firstChar, maxItemBytes);
    items.push(JSON.parse(raw));

    skipWhitespace(reader);
    const separator = nextChar(reader, 'unterminated large JSON array');
    if (separator === ']') return items;
    if (separator !== ',') {
      throw new SyntaxError('expected a comma or closing JSON array bracket');
    }
    skipWhitespace(reader);
    if (reader.peek() === ']') {
      throw new SyntaxError('expected a JSON array item after comma');
    }
  }
}

function parseLargeJsonObject(reader, { maxItemBytes = DEFAULT_JSON_STRING_LIMIT } = {}) {
  const result = {};
  let sawJobs = false;
  skipWhitespace(reader);
  if (reader.peek() === '}') {
    reader.next();
    throw new SyntaxError('large JSON object must contain a jobs array');
  }

  while (true) {
    skipWhitespace(reader);
    if (nextChar(reader, 'large JSON object key must be a string') !== '"') {
      throw new SyntaxError('large JSON object key must be a string');
    }
    const key = JSON.parse(consumeString(reader, maxItemBytes));
    skipWhitespace(reader);
    if (nextChar(reader, 'expected a colon after large JSON object key') !== ':') {
      throw new SyntaxError('expected a colon after large JSON object key');
    }
    skipWhitespace(reader);
    const firstChar = nextChar(reader, 'missing large JSON object value');
    if (key === 'jobs') {
      if (firstChar !== '[') {
        throw new SyntaxError('large JSON object jobs value must be an array');
      }
      if (sawJobs) throw new SyntaxError('duplicate jobs key in large JSON object');
      result.jobs = parseArrayAfterOpen(reader, { maxItemBytes });
      sawJobs = true;
    } else {
      result[key] = JSON.parse(consumeValue(reader, firstChar, maxItemBytes));
    }

    skipWhitespace(reader);
    const separator = nextChar(reader, 'unterminated large JSON object');
    if (separator === '}') break;
    if (separator !== ',') throw new SyntaxError('expected a comma or closing JSON object bracket');
    skipWhitespace(reader);
    if (reader.peek() === '}') throw new SyntaxError('trailing comma in large JSON object');
  }

  if (!sawJobs) throw new SyntaxError('large JSON object must contain a jobs array');
  skipWhitespace(reader);
  if (reader.peek() !== null) {
    throw new SyntaxError('unexpected data after large JSON object');
  }
  return result;
}

/**
 * Parse a top-level JSON array without ever concatenating the whole file.
 * Each array item is still parsed as one JSON value, which keeps the parser
 * bounded by the largest individual job record.
 */
export function parseLargeJsonArray(chunks) {
  const reader = createCharReader(chunks);
  skipWhitespace(reader);
  if (nextChar(reader, 'large JSON input must be a top-level array') !== '[') {
    throw new SyntaxError('large JSON input must be a top-level array');
  }
  const items = parseArrayAfterOpen(reader);
  skipWhitespace(reader);
  if (reader.peek() !== null) throw new SyntaxError('unexpected data after JSON array');
  return items;
}

function parseLargeJsonDocument(chunks, options = {}) {
  const reader = createCharReader(chunks);
  skipWhitespace(reader);
  const firstChar = nextChar(reader, 'empty large JSON input');
  if (firstChar === '[') {
    const items = parseArrayAfterOpen(reader, options);
    skipWhitespace(reader);
    if (reader.peek() !== null) throw new SyntaxError('unexpected data after JSON array');
    return items;
  }
  if (firstChar === '{') return parseLargeJsonObject(reader, options);
  throw new SyntaxError('large JSON input must be an array or a jobs wrapper object');
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
 * parse a large top-level jobs array (optionally inside a `{ jobs: [...] }`
 * wrapper) item by item.
 */
export function readJsonFile(filePath, { maxInlineBytes = DEFAULT_JSON_STRING_LIMIT } = {}) {
  const { size } = fs.statSync(filePath);
  if (size <= maxInlineBytes) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const chunks = readTextChunks(filePath);
  try {
    return parseLargeJsonDocument(chunks);
  } finally {
    // Parsing can stop before the generator reaches EOF (for example on a
    // malformed separator). Explicitly closing it releases the file descriptor
    // instead of leaving the generator suspended until garbage collection.
    chunks.return?.();
  }
}
