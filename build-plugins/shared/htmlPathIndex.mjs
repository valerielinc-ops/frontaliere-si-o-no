const LOAD_FACTOR = 0.7;
const UTF8 = new TextEncoder();

function nextPowerOfTwo(value) {
  let size = 2;
  while (size < value) size *= 2;
  return size;
}

function hashBytes(bytes) {
  let hash = 2_166_136_261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function sameBytes(bytes, data, start, end) {
  if (end - start !== bytes.length) return false;
  for (let index = 0; index < bytes.length; index += 1) {
    if (data[start + index] !== bytes[index]) return false;
  }
  return true;
}

/**
 * Build one exact, immutable existence oracle for all emitted HTML paths.
 *
 * The path bytes and open-addressing table live in SharedArrayBuffers. Worker
 * structured-clone therefore transfers descriptors, not 1.5M JS strings or a
 * Set per worker. Lookup still compares the full UTF-8 bytes after hashing, so
 * a hash collision cannot turn a missing target into an existing one.
 */
export function buildSharedHtmlPathIndex(paths) {
  let count = 0;
  let totalBytes = 0;
  for (const filePath of paths) {
    count += 1;
    totalBytes += Buffer.byteLength(String(filePath), 'utf8');
  }
  if (count > 0xffff_fffe) {
    throw new Error(`troppi path HTML per l'indice condiviso: ${count}`);
  }

  const tableSize = nextPowerOfTwo(Math.ceil(Math.max(1, count) / LOAD_FACTOR));
  const slots = new SharedArrayBuffer(tableSize * Uint32Array.BYTES_PER_ELEMENT);
  const offsets = new SharedArrayBuffer((count + 1) * Uint32Array.BYTES_PER_ELEMENT);
  const data = new SharedArrayBuffer(totalBytes);
  const slotView = new Uint32Array(slots);
  const offsetView = new Uint32Array(offsets);
  const dataView = new Uint8Array(data);
  const mask = tableSize - 1;

  let entryIndex = 0;
  let dataOffset = 0;
  for (const filePath of paths) {
    const encoded = UTF8.encode(String(filePath));
    offsetView[entryIndex] = dataOffset;
    dataView.set(encoded, dataOffset);
    dataOffset += encoded.length;

    let slot = hashBytes(encoded) & mask;
    while (slotView[slot] !== 0) slot = (slot + 1) & mask;
    slotView[slot] = entryIndex + 1;
    entryIndex += 1;
  }
  offsetView[count] = dataOffset;

  return Object.freeze({ slots, offsets, data, tableSize, count });
}

/**
 * Recreate the zero-copy lookup view inside a worker thread.
 */
export function createSharedHtmlPathIndexView(serialized) {
  const slotView = new Uint32Array(serialized.slots);
  const offsetView = new Uint32Array(serialized.offsets);
  const dataView = new Uint8Array(serialized.data);
  const mask = serialized.tableSize - 1;

  return {
    has(filePath) {
      const encoded = UTF8.encode(String(filePath));
      let slot = hashBytes(encoded) & mask;
      for (let probes = 0; probes < serialized.tableSize; probes += 1) {
        const stored = slotView[slot];
        if (stored === 0) return false;
        const entryIndex = stored - 1;
        if (
          sameBytes(
            encoded,
            dataView,
            offsetView[entryIndex],
            offsetView[entryIndex + 1],
          )
        ) {
          return true;
        }
        slot = (slot + 1) & mask;
      }
      return false;
    },
  };
}
