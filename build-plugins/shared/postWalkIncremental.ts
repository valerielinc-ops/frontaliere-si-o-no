import fs from 'node:fs';
import path from 'node:path';

// Import the shared loader, never the CLI script: scripts/ci/*.mjs carry a
// shebang and an `import.meta.url` main guard, and Vite's config bundler
// prepends its file-scope variables on the same line as the shebang, which
// broke every build leg of run 35169891808 (`Syntax error "!"`).
import { streamIncrementalManifest } from './incrementalManifest.mjs';
import { extractHreflangAlternates } from '../hreflangPostprocessPlugin';
import { EMIT_ALL_LOCALES, ownerEmitLocale, shouldEmitLocale } from './localeEmitFilter';

export const POST_WALK_INCREMENTAL_ENV = 'POST_WALK_INCREMENTAL';
export const POST_WALK_INCREMENTAL_VERIFY_ENV = 'POST_WALK_INCREMENTAL_VERIFY';
export const POST_WALK_INCREMENTAL_VERIFY_SAMPLE_ENV = 'POST_WALK_INCREMENTAL_VERIFY_SAMPLE';

/**
 * Manifest paths are logical URL paths. The post-walk owns two possible files
 * for a logical page: `<path>/index.html` and the flat `<path>.html` alias.
 * `related-search-sitemap` is the only current manifest kind without an HTML
 * file and is therefore excluded from the post-walk page map.
 */
const NON_HTML_MANIFEST_KIND = 'related-search-sitemap';

/**
 * Dependency rule for the opt-in pass:
 *
 * - a changed entry owns both physical aliases of its logical page;
 * - related canonical/mirror entries with the same `kind + inputHash` are one
 *   cluster and are affected together;
 * - pages carrying the same job identity in current/previous input metadata,
 *   and entries explicitly referring to an added/removed path, are affected;
 * - hreflang siblings named by a changed page are affected by resolving only
 *   the changed page's links against the complete `existingHtmlSet`;
 * - an added/removed page does not itself force a full pass. A removal without
 *   a resolvable kind + job identity gets a bounded per-entry reference scan;
 *   only an unreadable scan falls back to full. An owned hreflang target
 *   missing from `existingHtmlSet` still requires the full proof fallback.
 *
 * `hreflangPostprocessPlugin` uses this same existence oracle: a target owned
 * by the current BUILD_LOCALE is checked against this leg's HTML set, while a
 * target owned by another locale is retained by `shouldEmitLocale`/
 * `ownerEmitLocale` and is not resolved against a cross-locale list. The
 * locale value on the hreflang tag, rather than a guessed URL prefix, decides
 * that ownership.
 *
 * Related hubs/listings that register `buildRelatedClusterManifestInput` have
 * membership/order in their hash, so an added/removed job changes their own
 * manifest entry. Unregistered families remain on the existing full path.
 */
export const POST_WALK_INCREMENTAL_DEPENDENCY_RULE =
  'aliases + same kind/inputHash cluster + same-job/explicit path references + owned hreflang targets; add/remove stays incremental unless identity or existence proof is missing';

export type PostWalkManifestMetadata = {
  /** Compact JSONL projection used by the streaming planner. */
  readonly jobId?: string;
  readonly slug?: string;
  readonly jobIds?: readonly string[];
  readonly slugs?: readonly string[];
  readonly references?: readonly string[];
};

export type PostWalkManifestEntry = {
  readonly path: string;
  readonly inputHash: string;
  readonly kind: string;
  /** Present in direct planner fixtures and in opt-in compact manifest data. */
  readonly input?: unknown;
  readonly postWalk?: PostWalkManifestMetadata;
};

export type PostWalkManifestSnapshot = {
  readonly locales: readonly string[];
  readonly entries: ReadonlyMap<string, PostWalkManifestEntry>;
  readonly kinds: ReadonlyMap<string, string>;
};

export type PostWalkPathReason = 'changed' | 'affected';

export type PostWalkIncrementalPlan = {
  readonly mode: 'incremental' | 'full';
  readonly processHtmlPaths: readonly string[];
  readonly eligibleByManifest: number;
  readonly processed: number;
  readonly skippedUnchanged: number;
  readonly affected: number;
  readonly changed: number;
  readonly added: number;
  readonly removed: number;
  readonly fallbackReason?: string;
  readonly fallbackMode?: 'full' | 'entry';
  readonly reasonsByPath: ReadonlyMap<string, ReadonlySet<PostWalkPathReason>>;
};

/**
 * Compact state produced by the streaming loader. `current.entries` contains
 * only path/hash/kind plus the small post-walk identity projection; the
 * previous snapshot is consumed once and is not retained.
 */
export type PostWalkManifestState = {
  readonly current: PostWalkManifestSnapshot;
  readonly currentEntryCount: number;
  readonly previousEntryCount: number;
  readonly previousKinds: ReadonlyMap<string, string>;
  readonly changed: ReadonlySet<string>;
  readonly added: ReadonlySet<string>;
  readonly removed: ReadonlySet<string>;
  readonly affected: ReadonlySet<string>;
  readonly unresolvedRemovals: ReadonlySet<string>;
  readonly fallbackReason?: string;
};

export type PostWalkManifestProgress = {
  readonly phase:
    | 'current-loaded'
    | 'previous-loaded'
    | 'references-loading'
    | 'references-loaded';
  readonly currentEntries: number;
  readonly previousEntries: number | null;
};

export type PostWalkManifestStateLoadResult =
  | { readonly ok: true; readonly state: PostWalkManifestState }
  | { readonly ok: false; readonly reason: string };

/** Replace a coordinator path list without passing every item as an argument. */
export function replacePostWalkPathList(
  target: string[],
  source: readonly string[],
): void {
  target.length = 0;
  for (const filePath of source) target.push(filePath);
}

function normalizeLogicalPath(value: string): string {
  return String(value)
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function normalizeRelativePath(value: string): string {
  return String(value).replaceAll('\\', '/').replace(/^\/+/, '');
}

function logicalPathForManifestEntry(entry: PostWalkManifestEntry): string | null {
  return entry.kind === NON_HTML_MANIFEST_KIND ? null : normalizeLogicalPath(entry.path);
}

function logicalPathForHtml(relPath: string): string | null {
  const normalized = normalizeRelativePath(relPath);
  if (normalized === 'index.html') return '';
  if (normalized.endsWith('/index.html')) {
    return normalizeLogicalPath(normalized.slice(0, -'/index.html'.length));
  }
  if (normalized.endsWith('.html')) {
    return normalizeLogicalPath(normalized.slice(0, -'.html'.length));
  }
  return null;
}

function logicalCandidates(logicalPath: string): string[] {
  const normalized = normalizeLogicalPath(logicalPath);
  if (!normalized) return ['index.html'];
  return [`${normalized}/index.html`, `${normalized}.html`];
}

function manifestFilePaths(rootDir: string, locales: readonly string[], previous: boolean): string[] {
  const directory = path.join(
    rootDir,
    '.cache',
    previous ? 'incremental-manifest-prev' : 'incremental-manifest',
  );
  return locales.map((locale) => path.join(directory, `${locale}.jsonl`));
}

function normalizeLocales(locales: readonly string[]): string[] {
  return [...new Set(locales.map((locale) => String(locale).trim().toLowerCase()).filter(Boolean))];
}

function validatePostWalkMetadata(value: unknown, label: string): PostWalkManifestMetadata | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}: postWalk metadata non valida`);
  }
  const record = value as Record<string, unknown>;
  const metadata: {
    jobIds?: readonly string[];
    slugs?: readonly string[];
    references?: readonly string[];
  } = {};
  for (const field of ['jobIds', 'slugs', 'references'] as const) {
    if (record[field] === undefined) continue;
    if (
      !Array.isArray(record[field])
      || record[field].some((item) => typeof item !== 'string' || item.length === 0)
    ) {
      throw new Error(`${label}: postWalk.${field} non valido`);
    }
    metadata[field] = record[field] as readonly string[];
  }
  return metadata;
}

function compactMetadataField(
  values: readonly string[],
  singular: 'jobId' | 'slug',
  plural: 'jobIds' | 'slugs',
): Pick<PostWalkManifestMetadata, 'jobId' | 'slug' | 'jobIds' | 'slugs'> {
  if (values.length === 0) return {};
  return values.length === 1
    ? { [singular]: values[0] }
    : { [plural]: values };
}

/**
 * Validate the JSONL metadata but retain only scalar identity values in the
 * current/previous streaming map. Reference arrays are needed only during the
 * bounded add/remove reverse-edge pass and are therefore opt-in.
 */
function projectStreamPostWalkMetadata(
  value: unknown,
  label: string,
  retainReferences: boolean,
): PostWalkManifestMetadata | undefined {
  const metadata = validatePostWalkMetadata(value, label);
  if (!metadata) return undefined;
  const projected: PostWalkManifestMetadata = {
    ...compactMetadataField(metadata.jobIds ?? [], 'jobId', 'jobIds'),
    ...compactMetadataField(metadata.slugs ?? [], 'slug', 'slugs'),
    ...(retainReferences && metadata.references?.length
      ? { references: metadata.references }
      : {}),
  };
  return Object.keys(projected).length > 0 ? projected : undefined;
}

type StreamManifestEntry = {
  readonly path: string;
  readonly inputHash: string;
  readonly kind: string;
  readonly postWalk?: unknown;
};

function normalizeStreamManifestEntry(
  rawEntry: StreamManifestEntry,
  label: string,
  retainReferences = false,
  compactIdentity = true,
): PostWalkManifestEntry {
  const pagePath = normalizeLogicalPath(rawEntry.path);
  const postWalk = compactIdentity
    ? projectStreamPostWalkMetadata(rawEntry.postWalk, `entry ${label}`, retainReferences)
    : validatePostWalkMetadata(rawEntry.postWalk, `entry ${label}`);
  const entry: PostWalkManifestEntry = {
    path: pagePath,
    inputHash: String(rawEntry.inputHash),
    kind: String(rawEntry.kind),
    ...(postWalk ? { postWalk } : {}),
  };
  if (!entry.path || !entry.inputHash || !entry.kind) {
    throw new Error(`entry manifest non valida: ${label}`);
  }
  return entry;
}

function mergeKindMetadata(
  target: Map<string, string>,
  kinds: Record<string, unknown>,
): void {
  for (const [kind, metadata] of Object.entries(kinds ?? {})) {
    const serialized = JSON.stringify(metadata);
    const previous = target.get(kind);
    if (previous !== undefined && previous !== serialized) {
      throw new Error(`metadata divergenti per kind ${kind}`);
    }
    target.set(kind, serialized);
  }
}

type MutablePostWalkManifestEntry = Omit<PostWalkManifestEntry, 'postWalk'> & {
  postWalk?: PostWalkManifestMetadata;
  _seenPreviousEntry?: boolean;
  _seenPreviousHtml?: boolean;
};

function metadataValues(
  metadata: PostWalkManifestMetadata | undefined,
  singular: 'jobId' | 'slug',
  plural: 'jobIds' | 'slugs' | 'references',
): readonly string[] {
  if (!metadata) return [];
  const values = metadata[plural] ?? [];
  if (values.length > 0) return values;
  const value = metadata[singular];
  return value ? [value] : [];
}

function mergePostWalkMetadata(
  current: PostWalkManifestMetadata | undefined,
  previous: PostWalkManifestMetadata | undefined,
): PostWalkManifestMetadata | undefined {
  if (!previous) return current;
  if (!current) return previous;

  let merged: PostWalkManifestMetadata = current;
  for (const [singular, plural] of [
    ['jobId', 'jobIds'],
    ['slug', 'slugs'],
    [undefined, 'references'],
  ] as const) {
    const currentValues = plural === 'references'
      ? current.references ?? []
      : metadataValues(current, singular, plural);
    const previousValues = plural === 'references'
      ? previous.references ?? []
      : metadataValues(previous, singular, plural);
    if (previousValues.length === 0) continue;
    const values = [...new Set([...currentValues, ...previousValues])];
    if (
      values.length !== currentValues.length
      || values.some((value, index) => value !== currentValues[index])
    ) {
      const next = { ...merged } as {
        jobId?: string;
        slug?: string;
        jobIds?: readonly string[];
        slugs?: readonly string[];
        references?: readonly string[];
      };
      if (plural === 'references') {
        next.references = values;
      } else {
        delete next[singular];
        delete next[plural];
        Object.assign(next, compactMetadataField(values, singular, plural));
      }
      merged = next;
    }
  }
  return merged;
}

function manifestKindMetadataMismatch(
  currentKinds: ReadonlyMap<string, string>,
  previousKinds: ReadonlyMap<string, string>,
): string | undefined {
  for (const kind of currentKinds.keys()) {
    if (currentKinds.get(kind) !== previousKinds.get(kind)) {
      return `metadata manifest cambiata per kind ${kind}`;
    }
  }
  for (const kind of previousKinds.keys()) {
    if (currentKinds.get(kind) !== previousKinds.get(kind)) {
      return `metadata manifest cambiata per kind ${kind}`;
    }
  }
  return undefined;
}

function isHtmlManifestEntry(entry: PostWalkManifestEntry): boolean {
  return logicalPathForManifestEntry(entry) !== null;
}

type MutablePostWalkPlanningState = {
  readonly current: PostWalkManifestSnapshot;
  readonly changed: Set<string>;
  readonly added: Set<string>;
  readonly removed: Set<string>;
  readonly affected: Set<string>;
  readonly unresolvedRemovals: Set<string>;
  readonly eventJobIds: Set<string>;
  readonly eventSlugs: Set<string>;
};

function addEventIdentity(
  state: MutablePostWalkPlanningState,
  entry: PostWalkManifestEntry | undefined,
): void {
  if (!entry) return;
  const identity = entryIdentity(entry);
  for (const jobId of identity.jobIds) state.eventJobIds.add(jobId);
  for (const slug of identity.slugs) state.eventSlugs.add(slug);
}

function entrySharesEventIdentity(
  entry: PostWalkManifestEntry,
  eventJobIds: ReadonlySet<string>,
  eventSlugs: ReadonlySet<string>,
): boolean {
  const metadata = entry.postWalk;
  for (const jobId of metadataValues(metadata, 'jobId', 'jobIds')) {
    if (eventJobIds.has(String(jobId).trim())) return true;
  }
  for (const slug of metadataValues(metadata, 'slug', 'slugs')) {
    if (eventSlugs.has(String(slug).trim())) return true;
  }
  if (entry.input === undefined) return false;
  const identity = entryIdentity(entry);
  for (const jobId of identity.jobIds) if (eventJobIds.has(jobId)) return true;
  for (const slug of identity.slugs) if (eventSlugs.has(slug)) return true;
  return false;
}

function registerPreviousEntry(
  state: MutablePostWalkPlanningState,
  previousEntry: PostWalkManifestEntry,
  seenPreviousPaths?: Set<string>,
): void {
  const previousLogical = logicalPathForManifestEntry(previousEntry);
  const currentEntry = state.current.entries.get(previousEntry.path);
  const currentLogical = currentEntry ? logicalPathForManifestEntry(currentEntry) : null;
  if (currentEntry !== undefined) {
    const mutable = currentEntry as MutablePostWalkManifestEntry;
    if (seenPreviousPaths?.has(previousEntry.path) || mutable._seenPreviousEntry) {
      throw new Error(`path manifest duplicato nel precedente snapshot: ${previousEntry.path}`);
    }
    seenPreviousPaths?.add(previousEntry.path);
    mutable._seenPreviousEntry = true;
  }

  if (previousLogical === null) return;
  if (currentEntry === undefined || currentLogical === null) {
    state.removed.add(previousLogical);
    if (!hasResolvableIdentity(previousEntry)) state.unresolvedRemovals.add(previousLogical);
    addEventIdentity(state, previousEntry);
    return;
  }

  // During the first opt-in build the previous manifest may carry the new
  // postWalk projection while the current one does not (or vice versa). Keep
  // both projections on the current logical key without retaining a second
  // snapshot, matching the old pair planner's compatibility rule.
  const mutableCurrent = currentEntry as MutablePostWalkManifestEntry;
  mutableCurrent._seenPreviousHtml = true;
  if (
    previousEntry.kind !== currentEntry.kind
    || previousEntry.inputHash !== currentEntry.inputHash
  ) {
    state.changed.add(currentLogical);
    addEventIdentity(state, currentEntry);
    addEventIdentity(state, previousEntry);
  } else {
    // A manifest can straddle the introduction of postWalk metadata: the
    // current entry may have the same content hash but no identity projection
    // while the previous entry still carries the job/slug/reference edges.
    // Preserve that projection on the compact current scan, matching the old
    // pair planner's identity-index compatibility rule without retaining the
    // previous entry.
    mutableCurrent.postWalk = mergePostWalkMetadata(
      currentEntry.postWalk,
      previousEntry.postWalk,
    );
  }
}

function addReferenceMatches(
  state: MutablePostWalkPlanningState,
  logical: string | null,
  entry: PostWalkManifestEntry,
  baseUrl: string,
): void {
  if (logical === null) return;
  const currentEntry = state.current.entries.get(logical);
  if (currentEntry === undefined || !isHtmlManifestEntry(currentEntry)) return;
  const references = entry.postWalk?.references ?? [];
  for (const reference of references) {
    const target = logicalPathFromReference(String(reference), baseUrl);
    if (target !== null && (state.added.has(target) || state.removed.has(target))) {
      state.affected.add(logical);
    }
  }
  if (entry.input !== undefined) {
    for (const reference of entryIdentity(entry).references) {
      const target = logicalPathFromReference(reference, baseUrl);
      if (target !== null && (state.added.has(target) || state.removed.has(target))) {
        state.affected.add(logical);
      }
    }
  }
}

function finalizePlanningState(
  state: MutablePostWalkPlanningState,
  baseUrl: string,
): void {
  for (const [logical, entry] of state.current.entries) {
    if (!isHtmlManifestEntry(entry)) continue;
    const mutable = entry as MutablePostWalkManifestEntry;
    if (!mutable._seenPreviousHtml) {
      state.added.add(logical);
      addEventIdentity(state, entry);
    }
  }

  // Scan the compact current projection once for event identities. This is
  // linear and bounded by the one current map; an inverse jobId/slug index
  // would retain another Set of logical paths for every identity.
  for (const [logical, entry] of state.current.entries) {
    if (!isHtmlManifestEntry(entry)) continue;
    if (entrySharesEventIdentity(entry, state.eventJobIds, state.eventSlugs)) {
      state.affected.add(logical);
    }
  }

  if (state.added.size > 0 || state.removed.size > 0) {
    for (const [logical, entry] of state.current.entries) {
      addReferenceMatches(state, logicalPathForManifestEntry(entry), entry, baseUrl);
    }
  }
}

/**
 * Recover reverse edges that exist only in the previous snapshot. The current
 * map is enough for ordinary identity matching, but a previous page may link
 * to a newly added/removed page. This pass is deliberately a second JSONL
 * stream: it retains no previous entry map or previous-path Set.
 */
function addPreviousReferenceMatches(
  state: MutablePostWalkPlanningState,
  entry: PostWalkManifestEntry,
  baseUrl: string,
): void {
  const logical = logicalPathForManifestEntry(entry);
  addReferenceMatches(state, logical, entry, baseUrl);
}

function clearPlanningStateMarkers(entries: ReadonlyMap<string, PostWalkManifestEntry>): void {
  for (const entry of entries.values()) {
    const mutable = entry as MutablePostWalkManifestEntry;
    delete mutable._seenPreviousEntry;
    delete mutable._seenPreviousHtml;
  }
}

/**
 * Bounded duplicate detector for a streamed manifest.
 *
 * A full `Set(path)` would recreate the memory problem on the previous
 * snapshot. This fixed-size Bloom guard never misses an exact duplicate; a
 * false positive only fails closed and makes the coordinator use full mode.
 */
class BoundedManifestDuplicateGuard {
  // 2^28 bits = 32 MiB; with four hashes this keeps false-positive fallback
  // probability negligible for the measured ~700k-entry manifests.
  private readonly bits = new Uint8Array(1 << 25);

  hasSeen(pathValue: string): boolean {
    let allSet = true;
    for (let seed = 0; seed < 4; seed += 1) {
      let hash = (2_166_136_261 ^ Math.imul(seed + 1, 0x9e3779b1)) >>> 0;
      for (let index = 0; index < pathValue.length; index += 1) {
        hash ^= pathValue.charCodeAt(index);
        hash = Math.imul(hash, 16_777_619);
      }
      const bit = hash & 0x0fff_ffff;
      const byteIndex = bit >>> 3;
      const mask = 1 << (bit & 7);
      if ((this.bits[byteIndex] & mask) === 0) allSet = false;
      this.bits[byteIndex] |= mask;
    }
    return allSet;
  }
}

async function streamManifestFiles(
  files: readonly string[],
  locales: readonly string[],
  label: string,
  onEntry: (entry: PostWalkManifestEntry) => void,
  options: { readonly retainReferences?: boolean } = {},
): Promise<{ readonly entryCount: number; readonly kinds: Map<string, string> }> {
  const kinds = new Map<string, string>();
  const duplicateGuard = new BoundedManifestDuplicateGuard();
  let entryCount = 0;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!fs.existsSync(file)) throw new Error(`${label} manifest mancante: ${file}`);
    const streamed = await streamIncrementalManifest(
      file,
      (rawEntry: StreamManifestEntry) => {
        const entry = normalizeStreamManifestEntry(
          rawEntry,
          rawEntry.path,
          options.retainReferences === true,
        );
        if (duplicateGuard.hasSeen(entry.path)) {
          throw new Error(`${label} manifest path duplicato: ${entry.path}`);
        }
        onEntry(entry);
      },
      // The current snapshot owns the exact path map. The previous snapshot is
      // consumed as a stream and never needs a second all-path Set.
      { validateUniquePaths: false },
    );
    if (streamed.data.locale !== locales[index]) {
      throw new Error(
        `${label} manifest ${file} dichiara locale ${streamed.data.locale}, atteso ${locales[index]}`,
      );
    }
    entryCount += streamed.entryCount;
    mergeKindMetadata(kinds, streamed.data.kinds);
  }
  return { entryCount, kinds };
}

/**
 * Load the current manifest into one compact path/hash/identity projection,
 * then walk the previous JSONL (and, for add/remove reverse references, a
 * second time) to derive deltas and affected paths. Unlike the pair loader,
 * this never retains previous entry objects or a second full path map.
 */
export async function loadPostWalkManifestState(
  rootDir: string,
  locales: readonly string[],
  baseUrl: string,
  onProgress?: (progress: PostWalkManifestProgress) => void,
): Promise<PostWalkManifestStateLoadResult> {
  const selectedLocales = normalizeLocales(locales);
  if (selectedLocales.length === 0) {
    return { ok: false, reason: 'nessuna locale BUILD_LOCALE valida' };
  }
  try {
    const currentEntries = new Map<string, PostWalkManifestEntry>();
    const currentFiles = manifestFilePaths(rootDir, selectedLocales, false);
    const currentResult = await streamManifestFiles(
      currentFiles,
      selectedLocales,
      'corrente',
      (entry) => {
        if (currentEntries.has(entry.path)) {
          throw new Error(`path manifest duplicato tra locale: ${entry.path}`);
        }
        currentEntries.set(entry.path, entry);
      },
    );
    const current: PostWalkManifestSnapshot = {
      locales: selectedLocales,
      entries: currentEntries,
      kinds: currentResult.kinds,
    };
    onProgress?.({
      phase: 'current-loaded',
      currentEntries: currentResult.entryCount,
      previousEntries: null,
    });

    const changed = new Set<string>();
    const added = new Set<string>();
    const removed = new Set<string>();
    const affected = new Set<string>();
    const unresolvedRemovals = new Set<string>();
    const state: MutablePostWalkPlanningState = {
      current,
      changed,
      added,
      removed,
      affected,
      unresolvedRemovals,
      eventJobIds: new Set(),
      eventSlugs: new Set(),
    };
    const previousFiles = manifestFilePaths(rootDir, selectedLocales, true);
    const previousResult = await streamManifestFiles(
      previousFiles,
      selectedLocales,
      'precedente',
      (entry) => registerPreviousEntry(state, entry),
    );
    finalizePlanningState(state, baseUrl);
    if (added.size > 0 || removed.size > 0) {
      onProgress?.({
        phase: 'references-loading',
        currentEntries: currentResult.entryCount,
        previousEntries: previousResult.entryCount,
      });
      const currentReferenceResult = await streamManifestFiles(
        currentFiles,
        selectedLocales,
        'corrente',
        (entry) => addReferenceMatches(state, logicalPathForManifestEntry(entry), entry, baseUrl),
        { retainReferences: true },
      );
      const previousReferenceResult = await streamManifestFiles(
        previousFiles,
        selectedLocales,
        'precedente',
        (entry) => addPreviousReferenceMatches(state, entry, baseUrl),
        { retainReferences: true },
      );
      if (currentReferenceResult.entryCount !== currentResult.entryCount) {
        throw new Error(
          `corrente manifest cambiato durante la lettura: `
            + `${currentResult.entryCount} -> ${currentReferenceResult.entryCount} entry`,
        );
      }
      if (previousReferenceResult.entryCount !== previousResult.entryCount) {
        throw new Error(
          `precedente manifest cambiato durante la lettura: `
            + `${previousResult.entryCount} -> ${previousReferenceResult.entryCount} entry`,
        );
      }
      onProgress?.({
        phase: 'references-loaded',
        currentEntries: currentResult.entryCount,
        previousEntries: previousResult.entryCount,
      });
    }
    clearPlanningStateMarkers(current.entries);
    onProgress?.({
      phase: 'previous-loaded',
      currentEntries: currentResult.entryCount,
      previousEntries: previousResult.entryCount,
    });

    return {
      ok: true,
      state: {
        current,
        currentEntryCount: currentResult.entryCount,
        previousEntryCount: previousResult.entryCount,
        previousKinds: previousResult.kinds,
        changed,
        added,
        removed,
        affected,
        unresolvedRemovals,
        fallbackReason: manifestKindMetadataMismatch(current.kinds, previousResult.kinds),
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function fullPlan(
  processHtmlPaths: readonly string[],
  eligibleByManifest: number,
  changed: number,
  added: number,
  removed: number,
  reason: string,
): PostWalkIncrementalPlan {
  return {
    mode: 'full',
    // Keep the caller's one full path list. Copying 1.5M references here was
    // the first avoidable retained duplicate in the fallback path.
    processHtmlPaths,
    eligibleByManifest,
    processed: processHtmlPaths.length,
    skippedUnchanged: 0,
    affected: 0,
    changed,
    added,
    removed,
    fallbackReason: reason,
    fallbackMode: 'full',
    reasonsByPath: new Map(),
  };
}

type PostWalkEntryIdentity = {
  readonly jobIds: Set<string>;
  readonly slugs: Set<string>;
  readonly references: Set<string>;
};

function emptyEntryIdentity(): PostWalkEntryIdentity {
  return { jobIds: new Set(), slugs: new Set(), references: new Set() };
}

function addIdentityValue(
  identity: PostWalkEntryIdentity,
  value: unknown,
  key: string,
  seen: WeakSet<object>,
): void {
  if (typeof value === 'string' || typeof value === 'number') {
    const stringValue = String(value).trim();
    if (!stringValue) return;
    const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (normalizedKey === 'jobid' || normalizedKey === 'winnerid') identity.jobIds.add(stringValue);
    if (normalizedKey.includes('slug')) identity.slugs.add(stringValue);
    if (
      normalizedKey.includes('path')
      || normalizedKey.includes('url')
      || normalizedKey.includes('href')
      || normalizedKey.includes('file')
      || normalizedKey.includes('candidate')
      || normalizedKey.includes('tracking')
      || normalizedKey.includes('prose')
      || normalizedKey.includes('reference')
    ) {
      identity.references.add(stringValue);
    }
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) addIdentityValue(identity, item, key, seen);
    return;
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    addIdentityValue(identity, childValue, childKey, seen);
  }
}

function entryIdentity(entry: PostWalkManifestEntry): PostWalkEntryIdentity {
  const identity = emptyEntryIdentity();
  const metadata = entry.postWalk;
  for (const jobId of metadataValues(metadata, 'jobId', 'jobIds')) {
    if (String(jobId).trim()) identity.jobIds.add(String(jobId).trim());
  }
  for (const slug of metadataValues(metadata, 'slug', 'slugs')) {
    if (String(slug).trim()) identity.slugs.add(String(slug).trim());
  }
  for (const reference of metadata?.references ?? []) {
    if (String(reference).trim()) identity.references.add(String(reference).trim());
  }
  if (entry.input !== undefined) addIdentityValue(identity, entry.input, '', new WeakSet());
  return identity;
}

function hasResolvableIdentity(entry: PostWalkManifestEntry | undefined): boolean {
  if (!entry || !String(entry.kind ?? '').trim()) return false;
  const identity = entryIdentity(entry);
  return identity.jobIds.size > 0 || identity.slugs.size > 0;
}

function logicalPathFromReference(value: string, baseUrl: string): string | null {
  let reference = String(value).trim();
  if (!reference) return null;
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  if (reference === trimmedBase) reference = '';
  else if (reference.startsWith(`${trimmedBase}/`)) reference = reference.slice(trimmedBase.length);
  else if (/^[a-z][a-z\d+.-]*:/i.test(reference)) {
    try {
      reference = new URL(reference).pathname;
    } catch {
      return null;
    }
  }
  const query = reference.indexOf('?');
  if (query !== -1) reference = reference.slice(0, query);
  const hash = reference.indexOf('#');
  if (hash !== -1) reference = reference.slice(0, hash);
  reference = normalizeLogicalPath(reference);
  if (reference === 'index.html') return '';
  if (reference.endsWith('/index.html')) {
    return normalizeLogicalPath(reference.slice(0, -'/index.html'.length));
  }
  if (reference.endsWith('.html')) {
    return normalizeLogicalPath(reference.slice(0, -'.html'.length));
  }
  return reference || null;
}

function resolveHreflangTargetFiles(
  locale: string,
  href: string,
  baseUrl: string,
  distDir: string,
  allHtmlPaths: ReadonlySet<string>,
): { readonly files: string[]; readonly missingOwnedTarget: boolean } {
  const targetOwned = EMIT_ALL_LOCALES || shouldEmitLocale(ownerEmitLocale(locale));
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  let target = String(href).trim();
  if (target === trimmedBase) target = '';
  else if (target.startsWith(`${trimmedBase}/`)) target = target.slice(trimmedBase.length);
  else if (/^[a-z][a-z\d+.-]*:/i.test(target)) {
    // A different absolute origin is not a cross-locale sibling in this
    // build. The legacy transform will check it on an owned page, so keep the
    // proof conservative and let the coordinator take the full path.
    return { files: [], missingOwnedTarget: targetOwned };
  }
  const query = target.indexOf('?');
  if (query !== -1) target = target.slice(0, query);
  const hash = target.indexOf('#');
  if (hash !== -1) target = target.slice(0, hash);
  target = normalizeLogicalPath(target);
  const candidates = logicalCandidates(target).map((relative) => path.join(distDir, relative));
  const files = candidates.filter((candidate) => allHtmlPaths.has(candidate));
  return {
    files,
    missingOwnedTarget: files.length === 0 && targetOwned,
  };
}

// Path selection is performed directly from the compact manifest state below;
// keeping a second reasons-by-path index would retain another large path map.

function physicalHtmlPathsForLogical(
  distDir: string,
  logical: string,
  allHtml: ReadonlySet<string>,
): string[] {
  const physical: string[] = [];
  for (const relative of logicalCandidates(logical)) {
    const filePath = path.join(distDir, relative);
    if (allHtml.has(filePath)) physical.push(filePath);
  }
  return physical;
}

function hasPhysicalHtmlForLogical(
  distDir: string,
  logical: string,
  allHtml: ReadonlySet<string>,
): boolean {
  for (const relative of logicalCandidates(logical)) {
    if (allHtml.has(path.join(distDir, relative))) return true;
  }
  return false;
}

type PostWalkPlanInput = {
  readonly distDir: string;
  readonly allHtmlPaths: readonly string[];
  readonly processableHtmlPaths: readonly string[];
  readonly baseUrl: string;
  readonly readHtml?: (filePath: string) => string;
  readonly existingHtmlSet?: ReadonlySet<string>;
};

function countEligibleManifestPaths(
  input: PostWalkPlanInput,
  current: ReadonlyMap<string, PostWalkManifestEntry>,
): number {
  let eligible = 0;
  for (const filePath of input.processableHtmlPaths) {
    const logical = logicalPathForHtml(normalizeRelativePath(path.relative(input.distDir, filePath)));
    const entry = logical === null ? undefined : current.get(logical);
    if (entry && isHtmlManifestEntry(entry)) eligible += 1;
  }
  return eligible;
}

function unresolvedRemovalReason(unresolved: ReadonlySet<string>): string {
  const preview: string[] = [];
  for (const logical of unresolved) {
    if (preview.length === 3) break;
    preview.push(logical);
  }
  return `rimozione senza kind/jobId risolvibile: ${preview.join(', ')}`;
}

/**
 * A removal with no identity cannot provide a manifest-backed reverse edge.
 * Scan the HTML references once, retaining only the source logical paths that
 * actually mention one of those removed entries. This is the per-entry
 * fallback: the removed file has no bytes to transform, and unrelated pages
 * remain incremental instead of forcing the whole worker pass.
 */
function scanUnresolvedRemovalReferences(
  input: PostWalkPlanInput,
  unresolvedRemovals: ReadonlySet<string>,
  affected: Set<string>,
  readHtml: (filePath: string) => string,
): string | undefined {
  if (unresolvedRemovals.size === 0) return undefined;
  const hrefPattern = /\b(?:href|src)\s*=\s*["']([^"']+)["']/gi;
  for (const filePath of input.processableHtmlPaths) {
    let html: string;
    try {
      html = readHtml(filePath);
    } catch (error) {
      return `impossibile leggere durante il fallback per-entry ${filePath}: ${error instanceof Error ? error.message : String(error)}`;
    }
    let sourceLogical: string | null = null;
    for (const match of html.matchAll(hrefPattern)) {
      const targetLogical = logicalPathFromReference(match[1], input.baseUrl);
      if (targetLogical && unresolvedRemovals.has(targetLogical)) {
        sourceLogical = logicalPathForHtml(
          normalizeRelativePath(path.relative(input.distDir, filePath)),
        );
        break;
      }
    }
    if (sourceLogical !== null) affected.add(sourceLogical);
  }
  return undefined;
}

function markChangedHreflangDependants(
  input: PostWalkPlanInput,
  state: PostWalkManifestState,
  affected: Set<string>,
  allHtml: ReadonlySet<string>,
  readHtml: (filePath: string) => string,
): string | undefined {
  for (const logical of state.changed) {
    for (const filePath of physicalHtmlPathsForLogical(input.distDir, logical, allHtml)) {
      let html: string;
      try {
        html = readHtml(filePath);
      } catch (error) {
        return `impossibile leggere il path cambiato ${filePath}: ${error instanceof Error ? error.message : String(error)}`;
      }
      for (const alternate of extractHreflangAlternates(html)) {
        const resolution = resolveHreflangTargetFiles(
          alternate.locale,
          alternate.url,
          input.baseUrl,
          input.distDir,
          allHtml,
        );
        if (resolution.missingOwnedTarget) {
          return `target hreflang di pagina cambiata non presente in existingHtmlSet: ${alternate.url}`;
        }
        for (const targetFile of resolution.files) {
          const targetLogical = logicalPathForHtml(
            normalizeRelativePath(path.relative(input.distDir, targetFile)),
          );
          if (targetLogical !== null && targetLogical !== logical) affected.add(targetLogical);
        }
      }
    }
  }
  return undefined;
}

function buildPostWalkPlanFromState(
  input: PostWalkPlanInput,
  state: PostWalkManifestState,
): PostWalkIncrementalPlan {
  const readHtml = input.readHtml ?? ((filePath: string) => fs.readFileSync(filePath, 'utf-8'));
  const allHtml = input.existingHtmlSet ?? new Set(input.allHtmlPaths);
  const affected = state.affected as Set<string>;
  const eligibleByManifest = countEligibleManifestPaths(input, state.current.entries);

  let missingCurrentCount = 0;
  const missingCurrentPreview: string[] = [];
  for (const [logical, entry] of state.current.entries) {
    if (!isHtmlManifestEntry(entry) || hasPhysicalHtmlForLogical(input.distDir, logical, allHtml)) continue;
    missingCurrentCount += 1;
    if (missingCurrentPreview.length < 3) missingCurrentPreview.push(logical || '/');
  }
  if (missingCurrentCount > 0) {
    return fullPlan(
      input.processableHtmlPaths,
      eligibleByManifest,
      state.changed.size,
      state.added.size,
      state.removed.size,
      `manifest corrente incompleto: path HTML non emesso (${missingCurrentPreview.join(', ')})`,
    );
  }

  if (state.fallbackReason) {
    return fullPlan(
      input.processableHtmlPaths,
      eligibleByManifest,
      state.changed.size,
      state.added.size,
      state.removed.size,
      state.fallbackReason,
    );
  }

  const unresolvedScanReason = scanUnresolvedRemovalReferences(
    input,
    state.unresolvedRemovals,
    affected,
    readHtml,
  );
  if (unresolvedScanReason) {
    return fullPlan(
      input.processableHtmlPaths,
      eligibleByManifest,
      state.changed.size,
      state.added.size,
      state.removed.size,
      unresolvedScanReason,
    );
  }

  const hreflangReason = markChangedHreflangDependants(input, state, affected, allHtml, readHtml);
  if (hreflangReason) {
    return fullPlan(
      input.processableHtmlPaths,
      eligibleByManifest,
      state.changed.size,
      state.added.size,
      state.removed.size,
      hreflangReason,
    );
  }

  // Canonical cluster/mirror pages share the exact manifest hash when they
  // were rendered from the same source projection. Build this small key set
  // without materialising an intermediate array of changed entries.
  const changedClusters = new Set<string>();
  for (const logical of state.changed) {
    const entry = state.current.entries.get(logical);
    if (entry) changedClusters.add(`${entry.kind}\u0000${entry.inputHash}`);
  }
  for (const [logical, entry] of state.current.entries) {
    if (isHtmlManifestEntry(entry) && changedClusters.has(`${entry.kind}\u0000${entry.inputHash}`)) {
      affected.add(logical);
    }
  }

  // Build the one dispatch list in bounded chunks. The old implementation
  // kept byLogical/byAbsolute, reasonsByPath, selected, and a copied full list
  // alive at the same time; selection now derives directly from the compact
  // manifest map and the existing HTML set.
  const selectedPaths: string[] = [];
  let skippedUnchanged = 0;
  let affectedPhysical = 0;
  const chunkSize = 8192;
  for (let start = 0; start < input.processableHtmlPaths.length; start += chunkSize) {
    const end = Math.min(start + chunkSize, input.processableHtmlPaths.length);
    for (let index = start; index < end; index += 1) {
      const filePath = input.processableHtmlPaths[index];
      const logical = logicalPathForHtml(
        normalizeRelativePath(path.relative(input.distDir, filePath)),
      );
      const entry = logical === null ? undefined : state.current.entries.get(logical);
      const covered = entry !== undefined && isHtmlManifestEntry(entry);
      const selected = !covered
        || state.changed.has(logical as string)
        || state.added.has(logical as string)
        || state.affected.has(logical as string);
      if (!selected) {
        skippedUnchanged += 1;
        continue;
      }
      selectedPaths.push(filePath);
      if (covered && state.affected.has(logical as string) && !state.changed.has(logical as string)) {
        affectedPhysical += 1;
      }
    }
  }

  return {
    mode: 'incremental',
    processHtmlPaths: selectedPaths,
    eligibleByManifest,
    processed: selectedPaths.length,
    skippedUnchanged,
    affected: affectedPhysical,
    changed: state.changed.size,
    added: state.added.size,
    removed: state.removed.size,
    fallbackReason: state.unresolvedRemovals.size > 0
      ? unresolvedRemovalReason(state.unresolvedRemovals)
      : undefined,
    fallbackMode: state.unresolvedRemovals.size > 0 ? 'entry' : undefined,
    // Reasons were diagnostic-only and duplicated the dispatch list for large
    // builds. The coordinator does not consume them; keep the API shape with
    // an empty map so no second complete path index is retained.
    reasonsByPath: new Map(),
  };
}

/** Build a plan from the streaming state without retaining the old snapshot. */
export function buildPostWalkIncrementalPlanFromState(
  input: PostWalkPlanInput & { readonly state: PostWalkManifestState },
): PostWalkIncrementalPlan {
  return buildPostWalkPlanFromState(input, input.state);
}

export type PostWalkVerificationComparison = {
  readonly wouldWriteButSkipped: readonly string[];
  readonly processedButWouldNotWrite: readonly string[];
};

/**
 * Compare bounded dry-run scopes with the one incremental dispatch list.
 *
 * The sample and affected scopes are intentionally passed separately. The
 * verifier never builds a `sample + affected` array or a full-walk index.
 */
export function comparePostWalkVerification(input: {
  readonly fullWouldWritePaths: readonly string[];
  readonly incrementalProcessPaths: readonly string[];
  readonly sampledPaths?: readonly string[];
  readonly affectedWouldWritePaths?: readonly string[];
  readonly affectedPaths?: readonly string[];
}): PostWalkVerificationComparison {
  const planned = new Set(input.incrementalProcessPaths);
  const reportedSkipped = new Set<string>();
  const reportedNotWritten = new Set<string>();
  const wouldWriteButSkipped: string[] = [];
  const processedButWouldNotWrite: string[] = [];

  const compareScope = (
    fullWouldWritePaths: readonly string[],
    scopedPaths: readonly string[],
  ): void => {
    const fullWrites = new Set(fullWouldWritePaths);
    for (const filePath of fullWrites) {
      if (!planned.has(filePath) && !reportedSkipped.has(filePath)) {
        reportedSkipped.add(filePath);
        wouldWriteButSkipped.push(filePath);
      }
    }
    for (const filePath of scopedPaths) {
      if (!fullWrites.has(filePath) && !reportedNotWritten.has(filePath)) {
        reportedNotWritten.add(filePath);
        processedButWouldNotWrite.push(filePath);
      }
    }
  };

  compareScope(
    input.fullWouldWritePaths,
    input.sampledPaths ?? input.incrementalProcessPaths,
  );
  if (input.affectedWouldWritePaths !== undefined && input.affectedPaths !== undefined) {
    compareScope(input.affectedWouldWritePaths, input.affectedPaths);
  }

  return {
    wouldWriteButSkipped,
    processedButWouldNotWrite,
  };
}

export function postWalkIncrementalEnabled(): boolean {
  return process.env[POST_WALK_INCREMENTAL_ENV] === '1';
}

export function postWalkIncrementalVerifyEnabled(): boolean {
  return process.env[POST_WALK_INCREMENTAL_VERIFY_ENV] === '1';
}

export function postWalkIncrementalVerifySampleSize(): number | null {
  const raw = process.env[POST_WALK_INCREMENTAL_VERIFY_SAMPLE_ENV];
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

const POST_WALK_VERIFY_SAMPLE_RATE = 0.02;

type VerificationCandidate = { readonly path: string; readonly score: number };

function postWalkVerificationScore(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function candidateIsWorse(left: VerificationCandidate, right: VerificationCandidate): boolean {
  return left.score > right.score || (left.score === right.score && left.path > right.path);
}

function siftVerificationHeapUp(heap: VerificationCandidate[], index: number): void {
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (!candidateIsWorse(heap[index], heap[parent])) break;
    [heap[index], heap[parent]] = [heap[parent], heap[index]];
    index = parent;
  }
}

function siftVerificationHeapDown(heap: VerificationCandidate[], index: number): void {
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let worst = index;
    if (left < heap.length && candidateIsWorse(heap[left], heap[worst])) worst = left;
    if (right < heap.length && candidateIsWorse(heap[right], heap[worst])) worst = right;
    if (worst === index) return;
    [heap[index], heap[worst]] = [heap[worst], heap[index]];
    index = worst;
  }
}

/**
 * Deterministic sample selection that does not depend on filesystem order.
 * `sampleSize=null` means 2% of the walk; an explicit value remains a count.
 * Forced paths are included by default (the coordinator passes the incremental
 * affected/changed dispatch list). With `includeForcedPaths=false`, the same
 * bounded sample excludes those paths so the caller can verify the forced list
 * in its already-owned dispatch array without creating a combined copy.
 */
export function selectPostWalkVerificationPaths(
  paths: readonly string[],
  sampleSize: number | null,
  forcedPaths: readonly string[] = [],
  includeForcedPaths = true,
): string[] {
  if (paths.length === 0) return [];
  const forced = forcedPaths.length > 0 ? new Set(forcedPaths) : null;
  const sampleCount = sampleSize === null
    ? Math.max(1, Math.ceil(paths.length * POST_WALK_VERIFY_SAMPLE_RATE))
    : Math.max(0, Math.min(paths.length, sampleSize));
  if (sampleCount >= paths.length && forced === null) return [...paths];

  const selected: string[] = [];
  const heap: VerificationCandidate[] = [];
  for (const filePath of paths) {
    if (forced?.has(filePath)) {
      if (includeForcedPaths) selected.push(filePath);
      continue;
    }
    if (sampleCount === 0) continue;
    const candidate = { path: filePath, score: postWalkVerificationScore(filePath) };
    if (heap.length < sampleCount) {
      heap.push(candidate);
      siftVerificationHeapUp(heap, heap.length - 1);
    } else if (candidateIsWorse(heap[0], candidate)) {
      heap[0] = candidate;
      siftVerificationHeapDown(heap, 0);
    }
  }
  heap.sort((left, right) => {
    if (left.score !== right.score) return left.score - right.score;
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });
  for (const candidate of heap) selected.push(candidate.path);
  return selected;
}
