import fs from 'node:fs';
import path from 'node:path';

// Import the shared loader, never the CLI script: scripts/ci/*.mjs carry a
// shebang and an `import.meta.url` main guard, and Vite's config bundler
// prepends its file-scope variables on the same line as the shebang, which
// broke every build leg of run 35169891808 (`Syntax error "!"`).
import {
  readIncrementalManifestHeader,
  streamIncrementalManifest,
} from './incrementalManifest.mjs';
import { relativeDistPath } from './distHtmlWalk';

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
 * - hreflang siblings named by a changed page are affected by the compact
 *   manifest reference projection, without reopening the changed HTML;
 * - an added/removed page does not itself force a full pass. A removal without
 *   a resolvable kind + job identity gets a bounded per-entry reference scan;
 *   only an unreadable scan falls back to full. A missing hreflang target is
 *   handled by the changed page's own transform; no target page exists that
 *   needs a second dispatch.
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
  'aliases + same kind/inputHash cluster + same-job/explicit path references + manifest-projected hreflang targets; add/remove stays incremental unless identity or existence proof is missing; unmanifested paths require the verifier sample unless the full-transform predicate selects them';

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
  /** HTML files emitted by a producer that has no manifest entry. */
  readonly unmanifested?: number;
  /** Unmanifested files omitted only when the sampled verifier is enabled. */
  readonly unmanifestedSkipped?: number;
  readonly fallbackReason?: string;
  readonly fallbackMode?: 'full' | 'entry';
  readonly reasonsByPath: ReadonlyMap<string, ReadonlySet<PostWalkPathReason>>;
};

export type PostWalkVerificationPathInfo = {
  readonly relativePath: string;
  readonly topLevel: string;
  readonly kind: string;
  readonly reason: string;
};

/**
 * Compact state produced by the streaming loader. `current.entries` contains
 * only path/hash/kind plus the small post-walk identity/reference projection;
 * the previous snapshot is consumed as a stream and is never retained.
 */
export type PostWalkManifestState = {
  readonly current: PostWalkManifestSnapshot;
  readonly currentEntryCount: number;
  readonly currentHtmlEntryCount: number;
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

function readManifestEmitterFingerprint(
  files: readonly string[],
  locales: readonly string[],
  label: string,
): Readonly<Record<string, string>> | undefined {
  let fingerprint: Readonly<Record<string, string>> | undefined;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!fs.existsSync(file)) throw new Error(`${label} manifest mancante: ${file}`);
    const header = readIncrementalManifestHeader(file);
    if (header.locale !== locales[index]) {
      throw new Error(
        `${label} manifest ${file} dichiara locale ${header.locale}, atteso ${locales[index]}`,
      );
    }
    if (header.jobsSeoEmitterFingerprint) {
      const serialized = JSON.stringify(header.jobsSeoEmitterFingerprint);
      if (fingerprint && JSON.stringify(fingerprint) !== serialized) {
        throw new Error(`${label} manifest con fingerprint emitter divergente`);
      }
      fingerprint = header.jobsSeoEmitterFingerprint;
    }
  }
  return fingerprint;
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

/** Return whether one emitted physical HTML alias is covered by the index. */
export function postWalkManifestCoversHtmlPath(
  distDir: string,
  filePath: string,
  entries: ReadonlyMap<string, PostWalkManifestEntry>,
): boolean {
  const logical = logicalPathForHtml(relativeDistPath(distDir, filePath));
  const entry = logical === null ? undefined : entries.get(logical);
  return entry !== undefined && isHtmlManifestEntry(entry);
}

type MutablePostWalkPlanningState = {
  readonly current: PostWalkManifestSnapshot;
  readonly changed: Set<string>;
  readonly added: Set<string>;
  readonly removed: Set<string>;
  readonly affected: Set<string>;
  readonly unresolvedRemovals: Set<string>;
  readonly previousReferenceSources: Map<string, Set<string>>;
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

/**
 * Mark manifest-backed pages named by a changed page's compact references.
 * The reference projection is produced from the emitter input, so this keeps
 * the dependency proof bounded to changed entries without rereading their HTML
 * bodies during planning. Missing targets are handled by the changed page's
 * own post-walk transform; they do not require a second page to be opened.
 */
function addChangedReferenceMatches(
  state: MutablePostWalkPlanningState,
  logical: string | null,
  entry: PostWalkManifestEntry,
  baseUrl: string,
): void {
  if (logical === null || !state.changed.has(logical)) return;
  for (const reference of entry.postWalk?.references ?? []) {
    const target = logicalPathFromReference(String(reference), baseUrl);
    if (target === null || target === logical) continue;
    const targetEntry = state.current.entries.get(target);
    if (targetEntry !== undefined && isHtmlManifestEntry(targetEntry)) {
      state.affected.add(target);
    }
  }
}

function recordPreviousReferenceSources(
  state: MutablePostWalkPlanningState,
  entry: PostWalkManifestEntry,
  baseUrl: string,
): void {
  const source = logicalPathForManifestEntry(entry);
  if (source === null || !state.current.entries.has(source)) return;
  for (const reference of entry.postWalk?.references ?? []) {
    const target = logicalPathFromReference(String(reference), baseUrl);
    if (target === null || target === source) continue;
    let sources = state.previousReferenceSources.get(target);
    if (!sources) {
      sources = new Set<string>();
      state.previousReferenceSources.set(target, sources);
    }
    sources.add(source);
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

  // Scan the compact current projection once for event identities and content
  // clusters. The cluster check is folded into this pass so the planner does
  // not rescan the full current map after the manifest phase.
  const changedClusters = new Set<string>();
  for (const logical of state.changed) {
    const entry = state.current.entries.get(logical);
    if (entry) changedClusters.add(`${entry.kind}\u0000${entry.inputHash}`);
  }
  for (const [logical, entry] of state.current.entries) {
    if (!isHtmlManifestEntry(entry)) continue;
    if (entrySharesEventIdentity(entry, state.eventJobIds, state.eventSlugs)) {
      state.affected.add(logical);
    }
    if (changedClusters.has(`${entry.kind}\u0000${entry.inputHash}`)) {
      state.affected.add(logical);
    }
    addChangedReferenceMatches(state, logical, entry, baseUrl);
  }

  if (state.added.size > 0 || state.removed.size > 0) {
    for (const [target, sources] of state.previousReferenceSources) {
      if (!state.added.has(target) && !state.removed.has(target)) continue;
      for (const source of sources) {
        if (state.current.entries.has(source)) state.affected.add(source);
      }
    }
    for (const [logical, entry] of state.current.entries) {
      addReferenceMatches(state, logicalPathForManifestEntry(entry), entry, baseUrl);
    }
  }
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
  options: {
    readonly validateUniquePaths?: boolean;
    readonly retainReferences?: boolean;
  } = {},
): Promise<{
  readonly entryCount: number;
  readonly htmlEntryCount: number;
  readonly kinds: Map<string, string>;
  readonly jobsSeoEmitterFingerprint?: Readonly<Record<string, string>>;
}> {
  const kinds = new Map<string, string>();
  const duplicateGuard = options.validateUniquePaths === false
    ? null
    : new BoundedManifestDuplicateGuard();
  let entryCount = 0;
  let htmlEntryCount = 0;
  let jobsSeoEmitterFingerprint: Readonly<Record<string, string>> | undefined;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!fs.existsSync(file)) throw new Error(`${label} manifest mancante: ${file}`);
    let streamed;
    try {
      streamed = await streamIncrementalManifest(
        file,
        (rawEntry: StreamManifestEntry) => {
          const entry = normalizeStreamManifestEntry(
            rawEntry,
            rawEntry.path,
            options.retainReferences === true,
          );
          if (duplicateGuard?.hasSeen(entry.path)) {
            throw new Error(`${label} manifest path duplicato: ${entry.path}`);
          }
          onEntry(entry);
        },
        // The current snapshot owns the exact path map. The previous snapshot is
        // consumed as a stream and never needs a second all-path Set.
        // The coordinator's bounded Bloom guard handles duplicate paths for
        // the current snapshot. Recreating streamIncrementalManifest's full
        // Set(path) here would undo the memory reduction this loader exists
        // to provide.
        { validateUniquePaths: false },
      );
    } catch (error) {
      if (options.validateUniquePaths !== false && error instanceof Error) {
        const duplicate = error.message.match(/path duplicato\s+(.+)$/);
        if (duplicate) {
          throw new Error(`${label} manifest path duplicato: ${duplicate[1]}`);
        }
      }
      throw error;
    }
    if (streamed.data.locale !== locales[index]) {
      throw new Error(
        `${label} manifest ${file} dichiara locale ${streamed.data.locale}, atteso ${locales[index]}`,
      );
    }
    entryCount += streamed.entryCount;
    htmlEntryCount += streamed.entryCount
      - Number(streamed.data.counts?.byKind?.[NON_HTML_MANIFEST_KIND] ?? 0);
    mergeKindMetadata(kinds, streamed.data.kinds);
    if (streamed.jobsSeoEmitterFingerprint) {
      const serialized = JSON.stringify(streamed.jobsSeoEmitterFingerprint);
      if (
        jobsSeoEmitterFingerprint
        && JSON.stringify(jobsSeoEmitterFingerprint) !== serialized
      ) {
        throw new Error(`${label} manifest con fingerprint emitter divergente`);
      }
      jobsSeoEmitterFingerprint = streamed.jobsSeoEmitterFingerprint;
    }
  }
  return { entryCount, htmlEntryCount, kinds, jobsSeoEmitterFingerprint };
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
    const previousFiles = manifestFilePaths(rootDir, selectedLocales, true);
    const currentEmitterFingerprint = readManifestEmitterFingerprint(
      currentFiles,
      selectedLocales,
      'corrente',
    );
    // A first build has a current manifest but deliberately no previous one.
    // Treat that as a seed/full fallback while retaining the current compact
    // projection so the coordinator can classify unmanifested paths and write
    // the walk inventory for the very next build.
    const previousManifestAvailable = previousFiles.every((file) => fs.existsSync(file));
    const previousEmitterFingerprint = previousManifestAvailable
      ? readManifestEmitterFingerprint(previousFiles, selectedLocales, 'precedente')
      : undefined;
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
      { validateUniquePaths: true, retainReferences: true },
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
      previousReferenceSources: new Map(),
      eventJobIds: new Set(),
      eventSlugs: new Set(),
    };
    // Keep the current compact projection even when the producer fingerprint
    // changes. The plan still falls back as one full unit, but the coordinator
    // can classify the full walk against the current manifest and persist the
    // exact unmanifested index for the next identical build.
    const emitterFingerprintChanged = previousManifestAvailable && Boolean(
      (currentEmitterFingerprint || previousEmitterFingerprint)
      && JSON.stringify(currentEmitterFingerprint ?? null)
        !== JSON.stringify(previousEmitterFingerprint ?? null),
    );
    const previousResult = previousManifestAvailable && !emitterFingerprintChanged
      ? await streamManifestFiles(
        previousFiles,
        selectedLocales,
        'precedente',
        (entry) => {
          registerPreviousEntry(state, entry);
          recordPreviousReferenceSources(state, entry, baseUrl);
        },
        { validateUniquePaths: true, retainReferences: true },
      )
      : {
        entryCount: 0,
        htmlEntryCount: 0,
        kinds: new Map<string, string>(),
        jobsSeoEmitterFingerprint: undefined,
      };

    // The jobs/related emitters deliberately change this fingerprint when a
    // template, digest algorithm, or other producer contract changes.  Every
    // page hash may then differ even though there is no post-walk dependency
    // delta.  Treat that as one bounded full-pass fallback instead of building
    // hundreds of thousands of individual `changed` edges and then paying the
    // full planner/read cost anyway.
    if (emitterFingerprintChanged) {
      changed.clear();
      added.clear();
      removed.clear();
      affected.clear();
      unresolvedRemovals.clear();
    }
    finalizePlanningState(state, baseUrl);
    if (added.size > 0 || removed.size > 0) {
      onProgress?.({
        phase: 'references-loading',
        currentEntries: currentResult.entryCount,
        previousEntries: previousResult.entryCount,
      });
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
        currentHtmlEntryCount: currentResult.htmlEntryCount,
        previousEntryCount: previousResult.entryCount,
        previousKinds: previousResult.kinds,
        changed,
        added,
        removed,
        affected,
        unresolvedRemovals,
        fallbackReason: !previousManifestAvailable
          ? 'manifest precedente assente: seed full fallback'
          : emitterFingerprintChanged
            ? 'jobs SEO emitter fingerprint cambiato: delta non riusabile'
            : manifestKindMetadataMismatch(current.kinds, previousResult.kinds),
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Release the mutable maps retained by the loader once the coordinator has
 * copied the bounded plan. Assigning the state holder to null is not enough:
 * V8 can keep the live close-over and its 650k-entry maps until a later GC,
 * which overlaps the worker phase with the manifest projection.
 */
export function releasePostWalkManifestState(state: PostWalkManifestState): void {
  (state.current.entries as Map<string, PostWalkManifestEntry>).clear();
  (state.current.kinds as Map<string, string>).clear();
  (state.previousKinds as Map<string, string>).clear();
  (state.changed as Set<string>).clear();
  (state.added as Set<string>).clear();
  (state.removed as Set<string>).clear();
  (state.affected as Set<string>).clear();
  (state.unresolvedRemovals as Set<string>).clear();
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
    unmanifested: Math.max(0, processHtmlPaths.length - eligibleByManifest),
    unmanifestedSkipped: 0,
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

type PostWalkPlanInput = {
  readonly distDir: string;
  readonly allHtmlPaths: readonly string[];
  readonly processableHtmlPaths: readonly string[];
  readonly baseUrl: string;
  readonly readHtml?: (filePath: string) => string;
  readonly existingHtmlSet?: ReadonlySet<string>;
  /** Paths excluded from the transform pass but retained in the existence oracle. */
  readonly excludedHtmlPaths?: ReadonlySet<string>;
  /** Physical HTML aliases counted during the coordinator's single dist walk. */
  readonly coveredHtmlPathCount?: number;
  /** Keep the historical conservative path when no verifier is active. */
  readonly includeUncoveredPaths?: boolean;
  /**
   * Unmanifested physical files for which the full transform predicate has
   * already proved a write is possible. They stay bounded to the walk's
   * uncovered subset instead of reopening every unmanifested file in the
   * verifier.
   */
  readonly transformableUnmanifestedPaths?: readonly string[];
};

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

function buildPostWalkPlanFromState(
  input: PostWalkPlanInput,
  state: PostWalkManifestState,
): PostWalkIncrementalPlan {
  const readHtml = input.readHtml ?? ((filePath: string) => fs.readFileSync(filePath, 'utf-8'));
  const allHtml = input.existingHtmlSet ?? new Set(input.allHtmlPaths);
  const affected = state.affected as Set<string>;
  // The footer already reports how many entries belong to HTML-producing
  // kinds. Recounting current entries against the 1.5M-file walk made the
  // planner O(all); path existence is checked only for selected entries below.
  const eligibleByManifest = input.coveredHtmlPathCount ?? state.currentHtmlEntryCount;

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

  // An unresolved removal has no manifest identity or reverse edge, so the
  // bounded HTML scan is required even in sampled-verifier mode. Otherwise a
  // page outside the sample can retain a stale reference after the removal.
  // This scan is only entered for that conservative edge case; ordinary
  // verified planning remains O(changed + affected).
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

  // Select physical aliases directly from the compact logical manifest index.
  // The old implementation derived a logical key for every HTML path and
  // then scanned the whole 1.5M-file walk again. In verified mode the dispatch
  // is now O(changed + affected), with no per-file `path.relative` loop.
  const selectedPathSet = new Set<string>();
  const selectedLogical = new Set<string>();
  for (const logical of state.changed) selectedLogical.add(logical);
  for (const logical of state.added) selectedLogical.add(logical);
  for (const logical of state.affected) selectedLogical.add(logical);

  let affectedPhysical = 0;
  let unmanifestedSelected = 0;
  for (const logical of selectedLogical) {
    const entry = state.current.entries.get(logical);
    const covered = entry !== undefined && isHtmlManifestEntry(entry);
    const physicalPaths = physicalHtmlPathsForLogical(input.distDir, logical, allHtml);
    for (const filePath of physicalPaths) {
      if (input.excludedHtmlPaths?.has(filePath)) continue;
      if (selectedPathSet.has(filePath)) continue;
      selectedPathSet.add(filePath);
      if (!covered) unmanifestedSelected += 1;
      if (covered && state.affected.has(logical) && !state.changed.has(logical)) {
        affectedPhysical += 1;
      }
    }
  }

  // Some post-walk transforms intentionally operate on files that no current
  // emitter registers (for example a stale keyword landing left in a carried
  // dist). Keep those exact full-walk candidates in the incremental dispatch;
  // treating every unmanifested file as eligible would erase the optimization.
  for (const filePath of input.transformableUnmanifestedPaths ?? []) {
    if (input.excludedHtmlPaths?.has(filePath) || !allHtml.has(filePath)) continue;
    const relative = normalizeRelativePath(path.relative(input.distDir, filePath));
    const logical = logicalPathForHtml(relative);
    const entry = logical === null ? undefined : state.current.entries.get(logical);
    if (entry !== undefined && isHtmlManifestEntry(entry)) continue;
    if (selectedPathSet.has(filePath)) continue;
    selectedPathSet.add(filePath);
    unmanifestedSelected += 1;
  }

  const includeUncoveredPaths = input.includeUncoveredPaths !== false;
  let unmanifested = Math.max(0, input.processableHtmlPaths.length - eligibleByManifest);
  let unmanifestedSkipped = 0;
  if (includeUncoveredPaths) {
    unmanifested = 0;
    for (const filePath of input.processableHtmlPaths) {
      const logical = logicalPathForHtml(
        normalizeRelativePath(path.relative(input.distDir, filePath)),
      );
      const entry = logical === null ? undefined : state.current.entries.get(logical);
      if (entry === undefined || !isHtmlManifestEntry(entry)) {
        unmanifested += 1;
        selectedPathSet.add(filePath);
      }
    }
  } else {
    unmanifestedSkipped = Math.max(0, unmanifested - unmanifestedSelected);
  }

  const selectedPaths = [...selectedPathSet];
  const skippedUnchanged = Math.max(0, input.processableHtmlPaths.length - selectedPaths.length);

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
    unmanifested,
    unmanifestedSkipped,
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

/**
 * Classify the bounded verifier sample while the manifest projection is still
 * alive. The coordinator releases that projection before reading HTML, so the
 * mismatch marker must retain only this small diagnostic map, never a second
 * complete path index.
 */
export function describePostWalkVerificationPaths(input: {
  readonly distDir: string;
  readonly sampledPaths: readonly string[];
  readonly incrementalProcessPaths: readonly string[];
  readonly state: PostWalkManifestState;
}): ReadonlyMap<string, PostWalkVerificationPathInfo> {
  const planned = new Set(input.incrementalProcessPaths);
  const described = new Map<string, PostWalkVerificationPathInfo>();
  for (const filePath of input.sampledPaths) {
    const relativePath = normalizeRelativePath(path.relative(input.distDir, filePath));
    const topLevel = relativePath.split('/', 1)[0] || '<root>';
    const logical = logicalPathForHtml(relativePath);
    const entry = logical === null ? undefined : input.state.current.entries.get(logical);
    let kind = entry?.kind ?? 'unmanifested';
    let reason = logical === null
      ? 'unmanifested: physical path has no logical manifest key'
      : 'unmanifested: no current HTML manifest entry';

    if (entry && isHtmlManifestEntry(entry)) {
      kind = entry.kind;
      if (input.state.changed.has(logical)) {
        reason = 'changed entry selected by manifest delta';
      } else if (input.state.added.has(logical)) {
        reason = 'added entry selected by manifest delta';
      } else if (input.state.affected.has(logical)) {
        reason = 'affected entry selected by dependency rule';
      } else if (planned.has(filePath)) {
        reason = 'selected by incremental plan';
      } else {
        reason = 'unchanged entry: no changed/added/affected dependency edge';
      }
    }

    described.set(filePath, { relativePath, topLevel, kind, reason });
  }
  return described;
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

export const POST_WALK_TARGETED_WALK_ENV = 'POST_WALK_TARGETED_WALK';

/**
 * The claimed+targeted walk (and its persisted exact inventory) is an
 * explicit opt-in on top of POST_WALK_INCREMENTAL. At least 18 build plugins
 * still emit new HTML without WriteCollector/claim(), so a targeted walk can
 * miss a new unclaimed page below an indexed or claimed tree. Until those
 * writers are registered, POST_WALK_INCREMENTAL alone keeps the full walk,
 * which is complete by construction, and only the process phase is
 * incremental.
 */
export function postWalkTargetedWalkEnabled(): boolean {
  return process.env[POST_WALK_TARGETED_WALK_ENV] === '1';
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
