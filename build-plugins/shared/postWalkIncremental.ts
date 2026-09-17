import fs from 'node:fs';
import path from 'node:path';

// Import the shared loader, never the CLI script: scripts/ci/*.mjs carry a
// shebang and an `import.meta.url` main guard, and Vite's config bundler
// prepends its file-scope variables on the same line as the shebang, which
// broke every build leg of run 35169891808 (`Syntax error "!"`).
import { loadIncrementalManifest } from './incrementalManifest.mjs';
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
 *   a resolvable kind + job identity still falls back, as does an owned
 *   hreflang target missing from `existingHtmlSet`.
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

export type PostWalkManifestPair = {
  readonly current: PostWalkManifestSnapshot;
  readonly previous: PostWalkManifestSnapshot;
};

export type PostWalkManifestLoadResult =
  | { readonly ok: true; readonly pair: PostWalkManifestPair }
  | { readonly ok: false; readonly reason: string };

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
  readonly reasonsByPath: ReadonlyMap<string, ReadonlySet<PostWalkPathReason>>;
};

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

type LoadedManifest = {
  readonly data: { readonly locale: string; readonly kinds: Record<string, unknown> };
  readonly entries: Map<string, {
    readonly path: string;
    readonly inputHash: string;
    readonly kind: string;
    readonly postWalk?: PostWalkManifestMetadata;
  }>;
};

function mergeLoadedManifests(
  loaded: readonly LoadedManifest[],
  expectedLocales: readonly string[],
): PostWalkManifestSnapshot {
  const entries = new Map<string, PostWalkManifestEntry>();
  const kinds = new Map<string, string>();
  for (const manifest of loaded) {
    if (!expectedLocales.includes(manifest.data.locale)) {
      throw new Error(`manifest locale ${manifest.data.locale} non atteso`);
    }
    for (const [kind, metadata] of Object.entries(manifest.data.kinds ?? {})) {
      const serialized = JSON.stringify(metadata);
      const previous = kinds.get(kind);
      if (previous !== undefined && previous !== serialized) {
        throw new Error(`metadata divergenti per kind ${kind}`);
      }
      kinds.set(kind, serialized);
    }
    for (const [rawPath, rawEntry] of manifest.entries) {
      const pagePath = normalizeLogicalPath(rawPath);
      const postWalk = validatePostWalkMetadata(rawEntry.postWalk, `entry ${rawPath}`);
      const entry: PostWalkManifestEntry = {
        path: pagePath,
        inputHash: String(rawEntry.inputHash),
        kind: String(rawEntry.kind),
        ...(postWalk ? { postWalk } : {}),
      };
      if (!entry.path || !entry.inputHash || !entry.kind) {
        throw new Error(`entry manifest non valida: ${rawPath}`);
      }
      const previousEntry = entries.get(pagePath);
      if (previousEntry) {
        throw new Error(`path manifest duplicato tra locale: ${pagePath}`);
      }
      entries.set(pagePath, entry);
    }
  }
  return { locales: expectedLocales, entries, kinds };
}

async function loadSnapshot(
  files: readonly string[],
  locales: readonly string[],
  label: string,
): Promise<PostWalkManifestSnapshot> {
  const loaded: LoadedManifest[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!fs.existsSync(file)) {
      throw new Error(`${label} manifest mancante: ${file}`);
    }
    loaded.push(await loadIncrementalManifest(file));
    if (loaded[index].data.locale !== locales[index]) {
      throw new Error(
        `${label} manifest ${file} dichiara locale ${loaded[index].data.locale}, atteso ${locales[index]}`,
      );
    }
  }
  return mergeLoadedManifests(loaded, locales);
}

/** Load and validate the complete previous/current manifest set for a build. */
export async function loadPostWalkManifestPair(
  rootDir: string,
  locales: readonly string[],
): Promise<PostWalkManifestLoadResult> {
  const selectedLocales = normalizeLocales(locales);
  if (selectedLocales.length === 0) {
    return { ok: false, reason: 'nessuna locale BUILD_LOCALE valida' };
  }
  try {
    const [previous, current] = await Promise.all([
      loadSnapshot(manifestFilePaths(rootDir, selectedLocales, true), selectedLocales, 'precedente'),
      loadSnapshot(manifestFilePaths(rootDir, selectedLocales, false), selectedLocales, 'corrente'),
    ]);
    return { ok: true, pair: { current, previous } };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function mapHtmlPathsByLogical(
  distDir: string,
  allHtmlPaths: readonly string[],
): { byLogical: Map<string, string[]>; byAbsolute: Map<string, string> } {
  const byLogical = new Map<string, string[]>();
  const byAbsolute = new Map<string, string>();
  for (const filePath of allHtmlPaths) {
    const relative = normalizeRelativePath(path.relative(distDir, filePath));
    const logical = logicalPathForHtml(relative);
    if (logical === null) continue;
    byAbsolute.set(filePath, logical);
    const paths = byLogical.get(logical) ?? [];
    paths.push(filePath);
    byLogical.set(logical, paths);
  }
  return { byLogical, byAbsolute };
}

function currentHtmlEntries(
  entries: ReadonlyMap<string, PostWalkManifestEntry>,
): Map<string, PostWalkManifestEntry> {
  const htmlEntries = new Map<string, PostWalkManifestEntry>();
  for (const entry of entries.values()) {
    const logical = logicalPathForManifestEntry(entry);
    if (logical !== null) htmlEntries.set(logical, entry);
  }
  return htmlEntries;
}

function cloneReasons(
  reasonsByPath: Map<string, Set<PostWalkPathReason>>,
): ReadonlyMap<string, ReadonlySet<PostWalkPathReason>> {
  return new Map([...reasonsByPath].map(([filePath, reasons]) => [filePath, new Set(reasons)]));
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
    processHtmlPaths: [...processHtmlPaths],
    eligibleByManifest,
    processed: processHtmlPaths.length,
    skippedUnchanged: 0,
    affected: 0,
    changed,
    added,
    removed,
    fallbackReason: reason,
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
  for (const jobId of metadata?.jobIds ?? []) {
    if (String(jobId).trim()) identity.jobIds.add(String(jobId).trim());
  }
  for (const slug of metadata?.slugs ?? []) {
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

type PostWalkIdentityIndex = {
  readonly byJobId: Map<string, Set<string>>;
  readonly bySlug: Map<string, Set<string>>;
  readonly byReference: Map<string, Set<string>>;
};

function addIndexValue(index: Map<string, Set<string>>, value: string, logical: string): void {
  const paths = index.get(value) ?? new Set<string>();
  paths.add(logical);
  index.set(value, paths);
}

function addEntryToIdentityIndex(
  index: PostWalkIdentityIndex,
  logical: string,
  entry: PostWalkManifestEntry,
  baseUrl: string,
): void {
  const identity = entryIdentity(entry);
  for (const jobId of identity.jobIds) addIndexValue(index.byJobId, jobId, logical);
  for (const slug of identity.slugs) addIndexValue(index.bySlug, slug, logical);
  for (const reference of identity.references) {
    const referencePath = logicalPathFromReference(reference, baseUrl);
    if (referencePath !== null) addIndexValue(index.byReference, referencePath, logical);
  }
}

function emptyIdentityIndex(): PostWalkIdentityIndex {
  return { byJobId: new Map(), bySlug: new Map(), byReference: new Map() };
}

function buildIdentityIndex(
  entries: ReadonlyMap<string, PostWalkManifestEntry>,
  baseUrl: string,
): PostWalkIdentityIndex {
  const index: PostWalkIdentityIndex = {
    byJobId: new Map(),
    bySlug: new Map(),
    byReference: new Map(),
  };
  for (const [logical, entry] of entries) {
    addEntryToIdentityIndex(index, logical, entry, baseUrl);
  }
  return index;
}

function addIdentityMatches(
  affectedLogicals: Set<string>,
  index: PostWalkIdentityIndex,
  identity: PostWalkEntryIdentity,
): void {
  for (const jobId of identity.jobIds) {
    for (const logical of index.byJobId.get(jobId) ?? []) affectedLogicals.add(logical);
  }
  for (const slug of identity.slugs) {
    for (const logical of index.bySlug.get(slug) ?? []) affectedLogicals.add(logical);
  }
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

function markPath(
  filePath: string,
  reason: PostWalkPathReason,
  processable: ReadonlySet<string>,
  reasonsByPath: Map<string, Set<PostWalkPathReason>>,
): void {
  if (!processable.has(filePath)) return;
  const reasons = reasonsByPath.get(filePath) ?? new Set<PostWalkPathReason>();
  reasons.add(reason);
  reasonsByPath.set(filePath, reasons);
}

/**
 * Build the incremental file plan after the complete HTML name walk.
 * Unmanifested HTML is deliberately selected for the full path.
 */
export function buildPostWalkIncrementalPlan(input: {
  readonly distDir: string;
  readonly allHtmlPaths: readonly string[];
  readonly processableHtmlPaths: readonly string[];
  readonly baseUrl: string;
  readonly manifests: PostWalkManifestPair;
  readonly readHtml?: (filePath: string) => string;
}): PostWalkIncrementalPlan {
  const { distDir, allHtmlPaths, processableHtmlPaths, baseUrl, manifests } = input;
  const readHtml = input.readHtml ?? ((filePath: string) => fs.readFileSync(filePath, 'utf-8'));
  const { byLogical, byAbsolute } = mapHtmlPathsByLogical(distDir, allHtmlPaths);
  const current = currentHtmlEntries(manifests.current.entries);
  const previous = currentHtmlEntries(manifests.previous.entries);
  const processable = new Set(processableHtmlPaths);
  const allHtml = new Set(allHtmlPaths);
  const entryByHtmlPath = new Map<string, PostWalkManifestEntry>();
  let eligibleByManifest = 0;
  const missingCurrentPaths: string[] = [];

  for (const [logical, entry] of current) {
    const physical = byLogical.get(logical) ?? [];
    if (physical.length === 0) {
      missingCurrentPaths.push(logical || '/');
      continue;
    }
    for (const filePath of physical) {
      entryByHtmlPath.set(filePath, entry);
      if (processable.has(filePath)) eligibleByManifest += 1;
    }
  }

  const changed = new Set<string>();
  const added = new Set<string>();
  const removed = new Set<string>();
  for (const [logical, currentEntry] of current) {
    const previousEntry = previous.get(logical);
    if (!previousEntry) {
      added.add(logical);
    } else if (
      previousEntry.kind !== currentEntry.kind
      || previousEntry.inputHash !== currentEntry.inputHash
    ) {
      changed.add(logical);
    }
  }
  for (const logical of previous.keys()) {
    if (!current.has(logical)) removed.add(logical);
  }

  if (missingCurrentPaths.length > 0) {
    return fullPlan(
      processableHtmlPaths,
      eligibleByManifest,
      changed.size,
      added.size,
      removed.size,
      `manifest corrente incompleto: path HTML non emesso (${missingCurrentPaths.slice(0, 3).join(', ')})`,
    );
  }

  // A removal is safe to plan incrementally only when the previous entry can
  // identify the owning job. Additions do not need a reverse scan: the new
  // page is selected below, and pages whose input names it are selected from
  // the same compact index. A missing identity on a removed page is the one
  // add/remove case where the dependency cannot be demonstrated.
  const unresolvedRemovals = [...removed].filter(
    (logical) => !hasResolvableIdentity(previous.get(logical)),
  );
  if (unresolvedRemovals.length > 0) {
    return fullPlan(
      processableHtmlPaths,
      eligibleByManifest,
      changed.size,
      added.size,
      removed.size,
      `rimozione senza kind/jobId risolvibile: ${unresolvedRemovals.slice(0, 3).join(', ')}`,
    );
  }

  const kindMetadataKeys = new Set([...manifests.current.kinds.keys(), ...manifests.previous.kinds.keys()]);
  for (const kind of kindMetadataKeys) {
    if (manifests.current.kinds.get(kind) !== manifests.previous.kinds.get(kind)) {
      return fullPlan(
        processableHtmlPaths,
        eligibleByManifest,
        changed.size,
        added.size,
        removed.size,
        `metadata manifest cambiata per kind ${kind}`,
      );
    }
  }

  const reasonsByPath = new Map<string, Set<PostWalkPathReason>>();
  for (const filePath of processableHtmlPaths) {
    const logical = byAbsolute.get(filePath);
    if (logical === undefined || !current.has(logical)) {
      // Families without a registered kind stay on the complete path.
      reasonsByPath.set(filePath, new Set());
    } else if (changed.has(logical)) {
      markPath(filePath, 'changed', processable, reasonsByPath);
    }
  }

  const markLogical = (logical: string, reason: PostWalkPathReason): void => {
    for (const filePath of byLogical.get(logical) ?? []) {
      markPath(filePath, reason, processable, reasonsByPath);
    }
  };

  // An addition is a new page to transform, not a reason to abandon the
  // incremental plan. A removed page has no current physical alias, so its
  // same-job and explicit-reference matches are marked below.
  for (const logical of added) markLogical(logical, 'affected');

  const hasDependencyEvents = changed.size > 0 || added.size > 0 || removed.size > 0;
  const hasAddRemoveEvents = added.size > 0 || removed.size > 0;
  const currentIdentityIndex = hasDependencyEvents
    ? buildIdentityIndex(current, baseUrl)
    : emptyIdentityIndex();
  const previousIdentityIndex = hasAddRemoveEvents
    ? buildIdentityIndex(previous, baseUrl)
    : emptyIdentityIndex();
  // During the first opt-in run a current entry may be written with the new
  // compact metadata while its unchanged predecessor predates that field (or
  // vice versa). Keep both snapshots' identity on the current logical path.
  for (const [logical, previousEntry] of previous) {
    if (current.has(logical)) addEntryToIdentityIndex(currentIdentityIndex, logical, previousEntry, baseUrl);
  }
  const eventIdentities = [...new Set([...changed, ...added, ...removed])]
    .map((logical) => [current.get(logical), previous.get(logical)] as const)
    .flatMap(([currentEntry, previousEntry]) => [currentEntry, previousEntry])
    .filter((entry): entry is PostWalkManifestEntry => entry !== undefined)
    .map(entryIdentity);
  const identityAffected = new Set<string>();
  for (const identity of eventIdentities) {
    addIdentityMatches(identityAffected, currentIdentityIndex, identity);
  }
  for (const logical of [...added, ...removed]) {
    for (const affectedLogical of currentIdentityIndex.byReference.get(logical) ?? []) {
      identityAffected.add(affectedLogical);
    }
    for (const affectedLogical of previousIdentityIndex.byReference.get(logical) ?? []) {
      if (current.has(affectedLogical)) identityAffected.add(affectedLogical);
    }
  }
  for (const logical of identityAffected) {
    if (!changed.has(logical)) markLogical(logical, 'affected');
  }

  // Canonical cluster/mirror pages share the exact manifest hash when they
  // were rendered from the same source projection. This avoids guessing from
  // localized slugs while still covering related-search canonical siblings.
  const changedClusters = new Set(
    [...changed]
      .map((logical) => current.get(logical))
      .filter((entry): entry is PostWalkManifestEntry => entry !== undefined)
      .map((entry) => `${entry.kind}\u0000${entry.inputHash}`),
  );
  for (const [logical, entry] of current) {
    if (!changedClusters.has(`${entry.kind}\u0000${entry.inputHash}`)) continue;
    if (!changed.has(logical)) markLogical(logical, 'affected');
  }

  // Hreflang links are read only from files already known to be changed. The
  // full existingHtmlSet remains the existence oracle; no unchanged HTML is
  // opened in incremental mode.
  for (const logical of changed) {
    for (const filePath of byLogical.get(logical) ?? []) {
      let html: string;
      try {
        html = readHtml(filePath);
      } catch (error) {
        return fullPlan(
          processableHtmlPaths,
          eligibleByManifest,
          changed.size,
          added.size,
          removed.size,
          `impossibile leggere il path cambiato ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      for (const alternate of extractHreflangAlternates(html)) {
        const resolution = resolveHreflangTargetFiles(
          alternate.locale,
          alternate.url,
          baseUrl,
          distDir,
          allHtml,
        );
        if (resolution.missingOwnedTarget) {
          return fullPlan(
            processableHtmlPaths,
            eligibleByManifest,
            changed.size,
            added.size,
            removed.size,
            `target hreflang di pagina cambiata non presente in existingHtmlSet: ${alternate.url}`,
          );
        }
        for (const targetFile of resolution.files) {
          const targetLogical = byAbsolute.get(targetFile);
          if (targetLogical !== undefined && targetLogical !== logical) {
            markLogical(targetLogical, 'affected');
          }
        }
      }
    }
  }

  const selected = new Set(reasonsByPath.keys());
  const skippedUnchanged = [...entryByHtmlPath.keys()]
    .filter((filePath) => processable.has(filePath) && !selected.has(filePath)).length;
  const affected = [...reasonsByPath].filter(([filePath, reasons]) =>
    processable.has(filePath) && reasons.has('affected') && !reasons.has('changed'),
  ).length;

  return {
    mode: 'incremental',
    processHtmlPaths: processableHtmlPaths.filter((filePath) => selected.has(filePath)),
    eligibleByManifest,
    processed: processableHtmlPaths.filter((filePath) => selected.has(filePath)).length,
    skippedUnchanged,
    affected,
    changed: changed.size,
    added: added.size,
    removed: removed.size,
    reasonsByPath: cloneReasons(reasonsByPath),
  };
}

export type PostWalkVerificationComparison = {
  readonly wouldWriteButSkipped: readonly string[];
  readonly processedButWouldNotWrite: readonly string[];
};

/** Compare the full dry-run writes with paths omitted by the incremental plan. */
export function comparePostWalkVerification(input: {
  readonly fullWouldWritePaths: readonly string[];
  readonly incrementalProcessPaths: readonly string[];
  readonly sampledPaths?: readonly string[];
}): PostWalkVerificationComparison {
  const fullWrites = new Set(input.fullWouldWritePaths);
  const planned = new Set(input.incrementalProcessPaths);
  const scope = new Set(input.sampledPaths ?? input.incrementalProcessPaths);
  return {
    wouldWriteButSkipped: [...fullWrites].filter((filePath) => scope.has(filePath) && !planned.has(filePath)),
    processedButWouldNotWrite: [...planned].filter((filePath) => scope.has(filePath) && !fullWrites.has(filePath)),
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

/** Deterministic sample selection that does not depend on filesystem order. */
export function selectPostWalkVerificationPaths(
  paths: readonly string[],
  sampleSize: number | null,
): string[] {
  if (sampleSize === null || sampleSize >= paths.length) return [...paths];
  const score = (value: string): number => {
    let hash = 2_166_136_261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
    return hash >>> 0;
  };
  return [...paths]
    .sort((left, right) => {
      const byScore = score(left) - score(right);
      if (byScore !== 0) return byScore;
      return left < right ? -1 : left > right ? 1 : 0;
    })
    .slice(0, sampleSize);
}
