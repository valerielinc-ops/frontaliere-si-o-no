const TELEGRAM_LEDGER_PATHS = new Set([
  'data/telegram-posted-jobs.json',
  'data/telegram-posted-announcements.json',
]);
const INSPECTION_STATE_PATH = 'data/inspection-state.json';
const PHARMACY_ENRICHMENT_PATH = 'data/pharmacy-enrichment.json';
const CF_HOT_404_PATH = 'data/cf-hot-404s.json';
const LEDGER_TRIM_LIMIT = 1000;
export const EVENT_CACHE_PATHS = new Set([
  'data/events-geocode-cache.json',
  'data/events-translation-cache.json',
  'data/events-description-rewrites.json',
]);

// The article sync keeps destination-only cover-credit records when the
// published API snapshot lags the site checkout. A stable refresh branch made
// by an older run may already have deleted those files; when the current
// refresh leaves a base record unchanged, restore the current refresh's copy
// instead of carrying that stale deletion forward. Keep this exception scoped
// to the generated image-credit tree so ordinary snapshot deletions retain
// their existing precedence.
const REFRESH_PRESERVED_IMAGE_CREDIT_RE = /^packages\/articles\/content\/image-credits\//u;

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

function mergeEventDescriptionRewriteCache(file, baseRaw, remoteRaw, refreshRaw) {
  const base = parseObject(baseRaw ?? '{}', `${file} merge base`);
  const remote = parseObject(remoteRaw, `${file} other branch`);
  const refresh = parseObject(refreshRaw, `${file} current refresh`);
  const mergedEntries = Object.fromEntries(Object.entries(mergeCacheEntries(
    base.entries ?? {},
    remote.entries ?? {},
    refresh.entries ?? {},
  )).sort(([left], [right]) => left.localeCompare(right)));
  return `${JSON.stringify({
    ...remote,
    ...refresh,
    entries: mergedEntries,
  }, null, 2)}\n`;
}

function parseHot404Document(raw, label) {
  const document = parseObject(raw, label);
  if (!Array.isArray(document.paths)) {
    throw new Error(`${label} must contain a paths array`);
  }
  const entries = new Map();
  for (const entry of document.paths) {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string' || !entry.path) {
      throw new Error(`${label} contains an invalid path entry`);
    }
    if (!Number.isFinite(entry.hits) || entry.hits < 0) {
      throw new Error(`${label} contains an invalid hit count for ${entry.path}`);
    }
    entries.set(entry.path, { ...entry });
  }
  return { document, entries };
}

function hot404Freshness(document) {
  for (const key of ['generatedAt', 'lastUpdated', 'updatedAt']) {
    if (typeof document[key] === 'string' && document[key]) return document[key];
  }
  return '';
}

function mergeHot404Entry(remote, refresh) {
  const remoteLastSeen = typeof remote.lastSeen === 'string' ? remote.lastSeen : '';
  const refreshLastSeen = typeof refresh.lastSeen === 'string' ? refresh.lastSeen : '';
  const newest = refreshLastSeen >= remoteLastSeen ? refresh : remote;
  return {
    ...remote,
    ...newest,
    path: remote.path,
    hits: Math.max(remote.hits, refresh.hits),
    ...(remoteLastSeen || refreshLastSeen
      ? { lastSeen: refreshLastSeen >= remoteLastSeen ? refreshLastSeen : remoteLastSeen }
      : {}),
  };
}

/**
 * Merge the bounded Cloudflare 404 accumulator as a 3-way set of paths.
 *
 * The file is an accumulator, not a complete snapshot: two pending sweeps can
 * each add a different hot path. A plain "current refresh wins" merge loses
 * one of those paths, while an unconditional union resurrects paths that one
 * side intentionally aged out. Keep additions from either side and honour a
 * deletion of a base path by either side; when both retain a path, keep the
 * strongest hit count and newest last-seen date.
 */
function mergeCloudflareHot404s(baseRaw, remoteRaw, refreshRaw) {
  const base = parseHot404Document(baseRaw ?? '{"paths":[]}', `${CF_HOT_404_PATH} merge base`);
  const remote = parseHot404Document(remoteRaw, `${CF_HOT_404_PATH} stable branch`);
  const refresh = parseHot404Document(refreshRaw, `${CF_HOT_404_PATH} current refresh`);

  const paths = new Set([...remote.entries.keys(), ...refresh.entries.keys()]);
  for (const path of base.entries.keys()) {
    if (!remote.entries.has(path) || !refresh.entries.has(path)) paths.delete(path);
  }

  const metadata = hot404Freshness(remote.document) >= hot404Freshness(refresh.document)
    ? remote.document
    : refresh.document;
  const mergedPaths = [...paths].map((path) => {
    const remoteEntry = remote.entries.get(path);
    const refreshEntry = refresh.entries.get(path);
    if (!remoteEntry) return refreshEntry;
    if (!refreshEntry) return remoteEntry;
    return mergeHot404Entry(remoteEntry, refreshEntry);
  }).sort((left, right) => right.hits - left.hits || left.path.localeCompare(right.path));

  const cap = Number.isInteger(metadata.cap) && metadata.cap > 0 ? metadata.cap : mergedPaths.length;
  const retainedPaths = mergedPaths.length > cap
    ? [...mergedPaths]
      .sort((left, right) => (
        String(right.lastSeen || '').localeCompare(String(left.lastSeen || ''))
        || right.hits - left.hits
        || left.path.localeCompare(right.path)
      ))
      .slice(0, cap)
    : mergedPaths;
  retainedPaths.sort((left, right) => right.hits - left.hits || left.path.localeCompare(right.path));
  const { paths: _paths, ...rest } = metadata;
  return `${JSON.stringify({ ...rest, paths: retainedPaths }, null, 2)}\n`;
}

function validPharmacyUsage(value) {
  const month = String(value?.month || '');
  const requests = value?.googlePlaces?.requests;
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(month) || !Number.isInteger(requests) || requests < 0) {
    return null;
  }
  return {
    ...value,
    month,
    googlePlaces: { ...value.googlePlaces, requests },
  };
}

function mergePharmacyEnrichment(remoteRaw, refreshRaw) {
  const remote = parseObject(remoteRaw, `${PHARMACY_ENRICHMENT_PATH} stable branch`);
  const refresh = parseObject(refreshRaw, `${PHARMACY_ENRICHMENT_PATH} current refresh`);
  const remoteUsage = validPharmacyUsage(remote.providerUsage);
  const refreshUsage = validPharmacyUsage(refresh.providerUsage);
  let providerUsage = refreshUsage || remoteUsage;

  if (remoteUsage && refreshUsage) {
    if (remoteUsage.month === refreshUsage.month) {
      providerUsage = {
        ...refreshUsage,
        googlePlaces: {
          ...refreshUsage.googlePlaces,
          requests: Math.max(remoteUsage.googlePlaces.requests, refreshUsage.googlePlaces.requests),
        },
      };
    } else if (remoteUsage.month > refreshUsage.month) {
      providerUsage = remoteUsage;
    }
  }

  return `${JSON.stringify({
    ...refresh,
    ...(providerUsage ? { providerUsage } : {}),
  }, null, 2)}\n`;
}

function mergeBothChanged(file, baseRaw, remoteRaw, refreshRaw) {
  if (/^data\/pharmacy-duty-week-history\/\d{4}-\d{2}-\d{2}\.json$/u.test(file)) {
    const remote = parseObject(remoteRaw, `${file} stable branch`);
    const refresh = parseObject(refreshRaw, `${file} current refresh`);
    const weekStart = file.slice(file.lastIndexOf('/') + 1, -5);
    for (const edition of [remote, refresh]) {
      if (edition.version !== 1 || edition.weekStart !== weekStart || !Array.isArray(edition.observations)) {
        throw new Error(`Invalid pharmacy duty week history in ${file}`);
      }
    }
    // Observations are append-only, unlike the complete current duty feed.
    // Keep every distinct edition from both unmerged refreshes. The domain
    // reader validates their facts and deduplicates repeated assignments.
    const observations = [...new Map([...remote.observations, ...refresh.observations]
      .map((observation) => [JSON.stringify(observation), observation])).values()];
    return `${JSON.stringify({ version: 1, weekStart, observations })}\n`;
  }
  if (file === 'data/events-description-rewrites.json') {
    return mergeEventDescriptionRewriteCache(file, baseRaw, remoteRaw, refreshRaw);
  }
  if (file === CF_HOT_404_PATH) return mergeCloudflareHot404s(baseRaw, remoteRaw, refreshRaw);
  if (file === PHARMACY_ENRICHMENT_PATH) return mergePharmacyEnrichment(remoteRaw, refreshRaw);
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

  if (
    !refreshChanged
    && remoteRaw === null
    && refreshRaw !== null
    && REFRESH_PRESERVED_IMAGE_CREDIT_RE.test(file)
  ) {
    return refreshRaw;
  }
  if (!refreshChanged) return remoteRaw;
  if (!remoteChanged) return refreshRaw;
  if (remoteRaw === null) return refreshRaw;
  if (refreshRaw === null) return remoteRaw;
  return mergeBothChanged(file, baseRaw, remoteRaw, refreshRaw);
}
