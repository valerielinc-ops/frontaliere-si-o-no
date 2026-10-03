const TELEGRAM_LEDGER_PATHS = new Set([
  'data/telegram-posted-jobs.json',
  'data/telegram-posted-announcements.json',
]);
const INSPECTION_STATE_PATH = 'data/inspection-state.json';
const LEDGER_TRIM_LIMIT = 1000;
export const EVENT_CACHE_PATHS = new Set([
  'data/events-geocode-cache.json',
  'data/events-translation-cache.json',
]);

function parseObject(raw, label) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return parsed;
}

function mergeJsonLines(remoteRaw, refreshRaw) {
  const merged = [];
  const seen = new Set();
  for (const raw of [remoteRaw, refreshRaw]) {
    for (const line of raw.toString('utf8').split(/\r?\n/u)) {
      if (!line || seen.has(line)) continue;
      seen.add(line);
      merged.push(line);
    }
  }
  return merged.length ? `${merged.join('\n')}\n` : '';
}

function entryKey(entry) {
  if (entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id) {
    return `id:${entry.id}`;
  }
  return `raw:${JSON.stringify(entry)}`;
}

function mergePostedLedger(remoteRaw, refreshRaw, file) {
  const remote = parseObject(remoteRaw, `${file} stable branch`);
  const refresh = parseObject(refreshRaw, `${file} current refresh`);
  if (!Array.isArray(remote.posted) || !Array.isArray(refresh.posted)) {
    throw new Error(`${file} must contain a posted array`);
  }

  const merged = [];
  const indexes = new Map();
  const add = (entry, prefer) => {
    const key = entryKey(entry);
    const existing = indexes.get(key);
    if (existing === undefined) {
      indexes.set(key, merged.length);
      merged.push(entry);
    } else if (prefer) {
      merged[existing] = entry;
    }
  };

  for (const entry of remote.posted) add(entry, false);
  for (const entry of refresh.posted) add(entry, true);

  const out = {
    ...remote,
    ...refresh,
    schemaVersion: refresh.schemaVersion ?? remote.schemaVersion ?? 1,
    posted: merged.slice(-LEDGER_TRIM_LIMIT),
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

function mergeInspectionState(remoteRaw, refreshRaw) {
  const remote = parseObject(remoteRaw, `${INSPECTION_STATE_PATH} stable branch`);
  const refresh = parseObject(refreshRaw, `${INSPECTION_STATE_PATH} current refresh`);
  const remoteInspected = remote.inspected && typeof remote.inspected === 'object'
    ? remote.inspected
    : {};
  const refreshInspected = refresh.inspected && typeof refresh.inspected === 'object'
    ? refresh.inspected
    : {};
  return `${JSON.stringify({
    ...remote,
    ...refresh,
    inspected: { ...remoteInspected, ...refreshInspected },
  }, null, 2)}\n`;
}

function mergeCacheEntries(base, remote, refresh, mergeLocales = false) {
  const entries = new Map(Object.entries(remote));
  for (const [key, value] of Object.entries(refresh)) {
    const other = remote[key];
    if (mergeLocales && value && other && typeof value === 'object' && typeof other === 'object') {
      entries.set(key, mergeCacheEntries(base[key] ?? {}, other, value));
      continue;
    }
    // These caches accumulate resolved queries. Preserve additions from both
    // branches; an unchanged old value must not overwrite the other branch's
    // correction, while a newly resolved refresh value takes precedence.
    if (!entries.has(key) || JSON.stringify(value) !== JSON.stringify(base[key])) {
      entries.set(key, value);
    }
  }
  return Object.fromEntries(entries);
}

function mergeEventCache(file, baseRaw, remoteRaw, refreshRaw) {
  const base = parseObject(baseRaw ?? '{}', `${file} merge base`);
  const remote = parseObject(remoteRaw, `${file} other branch`);
  const refresh = parseObject(refreshRaw, `${file} current refresh`);
  const merged = mergeCacheEntries(base, remote, refresh, file === 'data/events-translation-cache.json');
  return `${JSON.stringify(merged, null, 2)}\n`;
}

function mergeBothChanged(file, baseRaw, remoteRaw, refreshRaw) {
  if (EVENT_CACHE_PATHS.has(file)) return mergeEventCache(file, baseRaw, remoteRaw, refreshRaw);
  if (file.endsWith('.jsonl')) return mergeJsonLines(remoteRaw, refreshRaw);
  if (TELEGRAM_LEDGER_PATHS.has(file)) return mergePostedLedger(remoteRaw, refreshRaw, file);
  if (file === INSPECTION_STATE_PATH) return mergeInspectionState(remoteRaw, refreshRaw);

  // Snapshot producers are authoritative for their complete current output.
  // The stable branch is still preserved for every other path; only a
  // same-file update chooses the newest refresh snapshot.
  return refreshRaw;
}

const IMAGE_PATH_RE = /\.(?:webp|png|jpe?g|avif)$/iu;

/**
 * Dependency-free container check for an image blob about to be committed.
 * Returns a reason string, or `null` when the bytes look like an image (or the
 * path is not one). The refresh merge runs from a temporary copy of these
 * scripts with no node_modules, so `sharp` is not available here.
 *
 * It exists for the incident behind deploy run 37035643275: a hero image went
 * through a UTF-8 text round trip on its way to the stable branch, the commit
 * was green, and the first thing to notice was the thumbnail generator three
 * hours into a deploy. The format is sniffed from the bytes rather than trusted
 * from the extension — the tree already holds a JPEG named `.png`, and sharp
 * decodes by content too.
 */
export function imageContainerDefect(file, bytes) {
  if (!IMAGE_PATH_RE.test(file) || !Buffer.isBuffer(bytes)) return null;
  if (bytes.length < 12) return `only ${bytes.length} bytes`;
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF') {
    if (bytes.subarray(8, 12).toString('latin1') !== 'WEBP') return 'RIFF container is not WEBP';
    const declared = bytes.readUInt32LE(4) + 8;
    return declared === bytes.length
      ? null
      : `RIFF header declares ${declared} bytes, file has ${bytes.length}`;
  }
  if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return null; // PNG
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return null; // JPEG
  if (bytes.subarray(4, 8).toString('latin1') === 'ftyp') return null; // AVIF/HEIF
  return 'no WebP, PNG, JPEG or AVIF signature';
}

/**
 * Merge one path from a stable branch and a current refresh commit.
 * `null` represents a missing blob in a git ref.
 * Buffers preserve snapshot bytes; only semantic JSON/JSONL merges decode text.
 */
export function mergeRefreshContent(file, baseRaw, remoteRaw, refreshRaw) {
  const sameContent = (left, right) => Buffer.isBuffer(left) && Buffer.isBuffer(right)
    ? left.equals(right)
    : left === right;
  const remoteChanged = !sameContent(remoteRaw, baseRaw);
  const refreshChanged = !sameContent(refreshRaw, baseRaw);

  if (!refreshChanged) return remoteRaw;
  if (!remoteChanged) return refreshRaw;
  if (remoteRaw === null) return refreshRaw;
  if (refreshRaw === null) return remoteRaw;
  return mergeBothChanged(file, baseRaw, remoteRaw, refreshRaw);
}
