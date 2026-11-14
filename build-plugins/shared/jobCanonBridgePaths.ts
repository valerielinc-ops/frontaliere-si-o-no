import {
  buildCanonicalJobDetailPath,
} from './jobDetailPath';
import {
  isCompanyHubNamespaceSlug,
  resolveJobCanton,
} from './cantonSection';
import { ACTIVE_JOB_PAGE_LOCALES, localizedActiveJobSlug } from './activeJobPageSelection';
import {
  addWinnerCandidate,
  createWinnerCandidateAccumulator,
  makeKey as previousSlugWinnerKey,
  resolveWinner,
  type CandidateInput,
  type WinnerCandidateAccumulator,
  type WinnersFile,
} from '../../services/previousSlugWinners';
import {
  JOB_CANON_V2_SHARD_COUNT,
  jobSlugShardIndexForCount,
} from '../../services/jobSlugShards';
import { jobCanonTarget } from '../../infra/cloudflare-worker/locale-router.js';

export const JOB_CANON_LOCALES = ACTIVE_JOB_PAGE_LOCALES;
export type JobCanonLocale = (typeof JOB_CANON_LOCALES)[number];

export interface ActiveJobSlugMapRow {
  id?: unknown;
  slug?: unknown;
  datePosted?: unknown;
  firstSeenAt?: unknown;
  slugByLocale?: Partial<Record<JobCanonLocale, unknown>> | null;
  titleByLocale?: Partial<Record<JobCanonLocale, unknown>> | null;
  title?: unknown;
  company?: unknown;
  location?: string;
  canton?: string;
  previousSlugs?: unknown;
  previousSlugsByLocale?: Partial<Record<JobCanonLocale, unknown>> | null;
}

export type JobCanonEntryLike = Partial<Record<JobCanonLocale, unknown>> & {
  alias?: Partial<Record<JobCanonLocale, unknown>> | null;
};

export interface JobCanonBridgePath {
  path: string;
  locale: JobCanonLocale;
  slug: string;
  targetPath: string;
  kind: 'previousSlug' | 'legacyTiMirror' | 'crossLocale';
  canton: string;
  /** Stable job key whose fields in jobs-slug-map.json produced this path. */
  sourceJobIdentifier?: string;
}

export interface FinalWorkerSlugMapReconciliation {
  /** Jobs with one unique serialized row whose effective route fields now match the final SEO input. */
  matchedJobIdentifiers: Set<string>;
  /** Jobs with a missing/duplicate row or route-field drift; their bridges must stay static. */
  unmatchedJobIdentifiers: Set<string>;
  updatedJobCount: number;
}

function activeJobMapKey(job: ActiveJobSlugMapRow): string {
  return String(job.id || job.slug || '').trim();
}

function copiedSlugArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return result.length > 0 ? result : undefined;
}

function copiedLocaleSlugArrays(value: unknown): Partial<Record<JobCanonLocale, string[]>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: Partial<Record<JobCanonLocale, string[]>> = {};
  for (const locale of JOB_CANON_LOCALES) {
    const slugs = copiedSlugArray((value as Partial<Record<JobCanonLocale, unknown>>)[locale]);
    if (slugs) result[locale] = slugs;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function sameSlugField(left: unknown, right: unknown): boolean {
  return JSON.stringify(copiedSlugArray(left) ?? null) === JSON.stringify(copiedSlugArray(right) ?? null);
}

function sameLocaleSlugField(left: unknown, right: unknown): boolean {
  return JSON.stringify(copiedLocaleSlugArrays(left) ?? null)
    === JSON.stringify(copiedLocaleSlugArrays(right) ?? null);
}

/**
 * Reconcile late previous-slug discoveries into the exact serialized input
 * later read by jobCanonRedirectMapPlugin. A missing or duplicate source row
 * is reported as unmatched so callers retain its static bridge.
 */
export function reconcileFinalWorkerSlugMapRows(
  serializedRows: ActiveJobSlugMapRow[],
  finalJobs: readonly ActiveJobSlugMapRow[],
): FinalWorkerSlugMapReconciliation {
  const rowsByKey = new Map<string, ActiveJobSlugMapRow[]>();
  for (const row of serializedRows) {
    const key = activeJobMapKey(row);
    if (!key) continue;
    const rows = rowsByKey.get(key) ?? [];
    rows.push(row);
    rowsByKey.set(key, rows);
  }

  const finalJobsByKey = new Map<string, ActiveJobSlugMapRow[]>();
  for (const job of finalJobs) {
    const key = activeJobMapKey(job);
    if (!key) continue;
    const jobs = finalJobsByKey.get(key) ?? [];
    jobs.push(job);
    finalJobsByKey.set(key, jobs);
  }

  const matchedJobIdentifiers = new Set<string>();
  const unmatchedJobIdentifiers = new Set<string>();
  let updatedJobCount = 0;
  for (const [key, jobs] of finalJobsByKey) {
    const rows = rowsByKey.get(key);
    if (jobs.length !== 1 || rows?.length !== 1) {
      unmatchedJobIdentifiers.add(key);
      continue;
    }

    const [job] = jobs;
    const [row] = rows;
    const sameRouteIdentity = String(row.slug ?? '') === String(job.slug ?? '')
      && resolveJobCanton(row) === resolveJobCanton(job)
      && JOB_CANON_LOCALES.every((locale) => localizedActiveJobSlug(row, locale) === localizedActiveJobSlug(job, locale));
    if (!sameRouteIdentity) {
      unmatchedJobIdentifiers.add(key);
      continue;
    }

    const previousSlugs = copiedSlugArray(job.previousSlugs);
    const previousSlugsByLocale = copiedLocaleSlugArrays(job.previousSlugsByLocale);
    const rowChanged = !sameSlugField(row.previousSlugs, previousSlugs)
      || !sameLocaleSlugField(row.previousSlugsByLocale, previousSlugsByLocale);
    if (previousSlugs) row.previousSlugs = previousSlugs;
    else delete row.previousSlugs;
    if (previousSlugsByLocale) row.previousSlugsByLocale = previousSlugsByLocale;
    else delete row.previousSlugsByLocale;
    if (rowChanged) updatedJobCount += 1;

    matchedJobIdentifiers.add(key);
  }

  return { matchedJobIdentifiers, unmatchedJobIdentifiers, updatedJobCount };
}

export type JobCanonEntryLookup =
  | ReadonlyMap<string, JobCanonEntryLike>
  | ((slug: string) => JobCanonEntryLike | undefined);

/**
 * Reconstruct the registry prefix/alias facts for a bounded set of slugs from
 * the same all-known-slugs rows consumed by jobCanonRedirectMapPlugin.
 * The registry read preserves first-insertion key order, which is the same
 * precedence consumed by jobCanonRedirectMapPlugin's compact slug index.
 */
export function buildTrackedJobCanonEntries(
  tracking: Readonly<Record<string, Partial<Record<JobCanonLocale, unknown>>>>,
  candidateSlugs: ReadonlySet<string>,
  onHeapSample?: () => void,
): { entries: Map<string, JobCanonEntryLike> } {
  const entries = new Map<string, JobCanonEntryLike>();
  const prefixByLocaleSlug = new Map<string, string>();
  const entryFor = (slug: string): JobCanonEntryLike => {
    let entry = entries.get(slug);
    if (!entry) {
      entry = {};
      entries.set(slug, entry);
    }
    return entry;
  };
  const pathParts = (value: unknown): { targetSlug: string; prefix: string; targetPath: string } | null => {
    if (typeof value !== 'string') return null;
    const targetPath = value.replace(/\/+$/, '');
    const segments = targetPath.split('/').filter(Boolean);
    if (segments.length < 2) return null;
    const targetSlug = segments[segments.length - 1];
    return {
      targetSlug,
      prefix: `/${segments.slice(0, -1).join('/')}`,
      targetPath,
    };
  };

  // Prefix staging indexes each source path under its destination's final
  // segment. PR-A resolves conflicts by first registry order, so retain that
  // same winner rather than inventing an ambiguity the Worker does not have.
  let sourceSlugCount = 0;
  for (const sourceSlug of Object.keys(tracking)) {
    sourceSlugCount++;
    if (sourceSlugCount % 8192 === 0) onHeapSample?.();
    const paths = tracking[sourceSlug];
    if (!paths || typeof paths !== 'object') continue;
    for (const locale of JOB_CANON_LOCALES) {
      const parsed = pathParts(paths[locale]);
      if (!parsed || !candidateSlugs.has(parsed.targetSlug)) continue;
      const key = localeSlugKey(locale, parsed.targetSlug);
      if (!prefixByLocaleSlug.has(key)) prefixByLocaleSlug.set(key, parsed.prefix);
    }
  }

  for (const slug of candidateSlugs) {
    const entry = entryFor(slug);
    for (const locale of JOB_CANON_LOCALES) {
      const key = localeSlugKey(locale, slug);
      const prefix = prefixByLocaleSlug.get(key);
      if (prefix !== undefined) entry[locale] = prefix;
    }
    const sourcePaths = tracking[slug];
    if (!sourcePaths || typeof sourcePaths !== 'object') continue;
    for (const locale of JOB_CANON_LOCALES) {
      if (locale === 'it' || entry[locale]) continue;
      const parsed = pathParts(sourcePaths[locale]);
      if (!parsed || parsed.targetSlug === slug) continue;
      const alias = entry.alias ?? (entry.alias = {});
      if (alias[locale] === undefined) alias[locale] = parsed.targetPath;
    }
  }
  return { entries };
}

export interface ActiveJobBridgePathStats {
  activeJobs: number;
  previousSlugClaims: number;
  previousSlugAutoClaims: number;
  previousSlugReservedClaims: number;
  previousSlugNonWinnerClaims: number;
  previousSlugActivePathCollisions: number;
  previousSlugPaths: number;
  legacyTiMirrorPaths: number;
  crossLocaleCandidates: number;
  crossLocaleReservedClaims: number;
  crossLocaleCompanyNamespaceClaims: number;
  crossLocaleActivePathCollisions: number;
  crossLocaleWorkerRecovered: number;
  crossLocaleAlreadyClaimed: number;
  crossLocalePaths: number;
}

export interface ActiveJobBridgePathPlan {
  bridgePaths: JobCanonBridgePath[];
  activeRouteSlugKeys: ReadonlySet<string>;
  activeCanonicalPaths: ReadonlySet<string>;
  activePrefixByLocaleSlug: Map<string, string | null>;
  stats: ActiveJobBridgePathStats;
}

export interface ActiveJobAliasStats {
  candidateGroups: number;
  realPageGroups: number;
  existingRegistryAliasGroups: number;
  ambiguousCantonGroups: number;
  autoAliasGroups: number;
  chainGroups: number;
  emittedAliases: number;
  aliasesByLocale: Record<JobCanonLocale, number>;
  ambiguousExamples: Array<{ locale: JobCanonLocale; slug: string; targets: string[] }>;
}

export interface ActiveJobAliasPlan {
  aliases: Array<{ slug: string; locale: JobCanonLocale; targetPath: string }>;
  ambiguousCantonKeys: ReadonlySet<string>;
  stats: ActiveJobAliasStats;
}

export type BridgeKeepReason =
  | 'exactPrefix'
  | 'ambiguousCanton'
  | 'noEntry'
  | 'noTarget'
  | 'crossLocaleAlias'
  | 'chain'
  | 'targetMismatch';

export interface BridgePathClassification {
  removable: Set<string>;
  keepBridge: Map<string, BridgeKeepReason>;
}

function localeSlugKey(locale: JobCanonLocale, slug: string): string {
  return `${locale}\u0000${slug}`;
}

function normalizedPathKey(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

function forEachPreviousSlugByLocale(
  job: ActiveJobSlugMapRow,
  visit: (locale: JobCanonLocale, slug: string) => void,
  includeSlug: (slug: string) => boolean = () => true,
): void {
  const byLocale = job.previousSlugsByLocale;
  const flat = Array.isArray(job.previousSlugs) && job.previousSlugs.length > 0
    ? job.previousSlugs
    : null;
  const allLocaleSlugs = flat && byLocale && typeof byLocale === 'object'
    ? new Set<string>()
    : null;
  if (allLocaleSlugs && byLocale && typeof byLocale === 'object') {
    for (const localeKey in byLocale) {
      if (!Object.prototype.hasOwnProperty.call(byLocale, localeKey)) continue;
      const value = (byLocale as Record<string, unknown>)[localeKey];
      if (!Array.isArray(value)) continue;
      for (const slug of value) {
        if (typeof slug === 'string' && slug && includeSlug(slug)) allLocaleSlugs.add(slug);
      }
    }
  }

  for (const locale of JOB_CANON_LOCALES) {
    let firstSeen: string | undefined;
    let seen: Set<string> | null = null;
    const alreadySeen = (slug: string): boolean => {
      if (firstSeen === undefined) {
        firstSeen = slug;
        return false;
      }
      if (seen === null) {
        if (firstSeen === slug) return true;
        seen = new Set([firstSeen]);
      }
      if (seen.has(slug)) return true;
      seen.add(slug);
      return false;
    };
    const values = byLocale && typeof byLocale === 'object' ? byLocale[locale] : undefined;
    if (Array.isArray(values)) {
      for (const slug of values) {
        if (typeof slug !== 'string' || !slug || !includeSlug(slug) || alreadySeen(slug)) continue;
        visit(locale, slug);
      }
    }
    if (flat) {
      for (const slug of flat) {
        if (
          typeof slug !== 'string'
          || !slug
          || !includeSlug(slug)
          || allLocaleSlugs?.has(slug)
          || alreadySeen(slug)
        ) continue;
        visit(locale, slug);
      }
    }
  }
}

function* localePreviousSlugs(
  job: ActiveJobSlugMapRow,
  locale: JobCanonLocale,
  includeSlug: (slug: string) => boolean = () => true,
): IterableIterator<string> {
  const byLocale = job.previousSlugsByLocale;
  const values = byLocale && typeof byLocale === 'object' ? byLocale[locale] : undefined;
  if (!Array.isArray(values)) return;
  for (const value of values) {
    if (typeof value === 'string' && value && includeSlug(value)) yield value;
  }
}

/**
 * Recreate the active previous-slug, legacy-TI mirror, and cross-locale bridge
 * path set. `workerWouldRecover` mirrors the jobs SEO plugin's existing
 * `legacyTiPathRecoveredByWorker` guard and is injected so tests can exercise
 * the path predicates without loading the full HTML emitter.
 */
export function buildActiveJobBridgePathPlan(
  jobs: readonly ActiveJobSlugMapRow[],
  options: {
    winners: WinnersFile;
    /** Reusable caller-owned copy for callers that emit one v2 bucket at a time. */
    resolvedWinners?: WinnersFile;
    reservedHubSlugs: ReadonlySet<string>;
    workerWouldRecover?: (locale: JobCanonLocale, slug: string, path: string) => boolean;
    canWriteCrossLocalePath?: (path: string) => boolean;
    onHeapSample?: () => void;
  },
): ActiveJobBridgePathPlan {
  const { reservedHubSlugs } = options;
  const workerWouldRecover = options.workerWouldRecover ?? (() => false);
  const canWriteCrossLocalePath = options.canWriteCrossLocalePath ?? (() => true);
  const stats: ActiveJobBridgePathStats = {
    activeJobs: jobs.length,
    previousSlugClaims: 0,
    previousSlugAutoClaims: 0,
    previousSlugReservedClaims: 0,
    previousSlugNonWinnerClaims: 0,
    previousSlugActivePathCollisions: 0,
    previousSlugPaths: 0,
    legacyTiMirrorPaths: 0,
    crossLocaleCandidates: 0,
    crossLocaleReservedClaims: 0,
    crossLocaleCompanyNamespaceClaims: 0,
    crossLocaleActivePathCollisions: 0,
    crossLocaleWorkerRecovered: 0,
    crossLocaleAlreadyClaimed: 0,
    crossLocalePaths: 0,
  };
  const activeRouteSlugKeys = new Set<string>();
  const activeCanonicalPaths = new Set<string>();
  const activeJobDirs = new Set<string>();
  const activeRouteOwnerKeys = new Set<string>();
  const cantonByJob = new Map<ActiveJobSlugMapRow, string>();
  const currentSlugByJobLocale = new Map<ActiveJobSlugMapRow, Record<JobCanonLocale, string>>();

  for (const job of jobs) {
    const canton = resolveJobCanton(job);
    cantonByJob.set(job, canton);
    const currentByLocale = {} as Record<JobCanonLocale, string>;
    for (const locale of JOB_CANON_LOCALES) {
      const currentSlug = localizedActiveJobSlug(job, locale);
      currentByLocale[locale] = currentSlug;
      if (!currentSlug) continue;
      activeRouteSlugKeys.add(localeSlugKey(locale, currentSlug));
      activeRouteOwnerKeys.add(`${canton}:${locale}:${currentSlug}`);
      const canonicalPath = buildCanonicalJobDetailPath(locale, job, currentSlug, canton);
      activeCanonicalPaths.add(normalizedPathKey(canonicalPath));
      activeJobDirs.add(normalizedPathKey(canonicalPath));
    }
    currentSlugByJobLocale.set(job, currentByLocale);
  }

  const claimantGroups = new Map<string, {
    canton: string;
    locale: JobCanonLocale;
    oldSlug: string;
    candidates: CandidateInput[];
  }>();

  for (const job of jobs) {
    options.onHeapSample?.();
    const canton = cantonByJob.get(job)!;
    const identifier = String(job.id || job.slug || '');
    const currentByLocale = currentSlugByJobLocale.get(job)!;
    forEachPreviousSlugByLocale(job, (locale, oldSlug) => {
      const currentSlug = currentByLocale[locale];
      if (!currentSlug) return;
      if (oldSlug === currentSlug) {
        stats.previousSlugAutoClaims += 1;
        return;
      }
      if (reservedHubSlugs.has(oldSlug)) {
        stats.previousSlugReservedClaims += 1;
        return;
      }
      stats.previousSlugClaims += 1;
      const key = previousSlugWinnerKey(canton, locale, oldSlug);
      const group = claimantGroups.get(key);
      const candidate = { jobIdentifier: identifier || currentSlug, canonicalSlug: currentSlug };
      if (group) group.candidates.push(candidate);
      else claimantGroups.set(key, { canton, locale, oldSlug, candidates: [candidate] });
    });
  }

  const resolvedWinners: WinnersFile = { ...options.winners };
  const winnerByClaimKey = new Map<string, string>();
  const now = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
  for (const [key, group] of claimantGroups) {
    const winner = resolveWinner(
      resolvedWinners,
      group.canton,
      group.locale,
      group.oldSlug,
      group.candidates,
      now,
    );
    if (winner) winnerByClaimKey.set(key, winner.winnerJobIdentifier);
  }

  // Each path keeps the last bridge writer, matching the existing emit loops:
  // a later TI mirror or later previous-slug page may replace the same path.
  const bridgeByPath = new Map<string, JobCanonBridgePath>();
  const claimedPaths = new Set<string>();
  const legacyTiMirrorDirs = new Set<string>();
  const activeLegacyTiBridgeDirs = new Set<string>();

  // Match the active legacy-slug and current-slug TI ownership that the SEO
  // plugin has already emitted before the previous-slug and cross-locale
  // phases. These paths can suppress later cross-locale writes, and current
  // TI claims suppress stale previous-slug mirrors.
  for (const job of jobs) {
    const canton = cantonByJob.get(job)!;
    const currentByLocale = currentSlugByJobLocale.get(job)!;
    const italianSlug = typeof job.slug === 'string' ? job.slug : '';
    if (!italianSlug) continue;
    for (const locale of JOB_CANON_LOCALES) {
      if (locale !== 'it' && currentByLocale[locale] !== italianSlug) {
        const localeAliasPath = buildCanonicalJobDetailPath(locale, job, italianSlug, canton);
        const localeAliasKey = `${locale}\u0000${normalizedPathKey(localeAliasPath)}`;
        if (!activeJobDirs.has(normalizedPathKey(localeAliasPath))) claimedPaths.add(localeAliasKey);
      }
      if (canton === 'TI' || isCompanyHubNamespaceSlug(italianSlug, locale)) continue;
      const legacyTiPath = buildCanonicalJobDetailPath(locale, 'TI', italianSlug);
      const legacyTiKey = `${locale}\u0000${normalizedPathKey(legacyTiPath)}`;
      if (activeJobDirs.has(normalizedPathKey(legacyTiPath))) continue;
      activeLegacyTiBridgeDirs.add(legacyTiKey);
      // The active current-slug TI page is emitted in IT. Other locales leave
      // this request to the Worker but still reserve the path from old-slug mirrors.
      if (locale === 'it') claimedPaths.add(legacyTiKey);
    }
  }

  for (const job of jobs) {
    options.onHeapSample?.();
    const canton = cantonByJob.get(job)!;
    const currentByLocale = currentSlugByJobLocale.get(job)!;
    const jobIdentifier = String(job.id || job.slug || '');
    forEachPreviousSlugByLocale(job, (locale, oldSlug) => {
      const currentSlug = currentByLocale[locale];
      if (!currentSlug || oldSlug === currentSlug || reservedHubSlugs.has(oldSlug)) return;
      const winnerKey = previousSlugWinnerKey(canton, locale, oldSlug);
      const winnerId = winnerByClaimKey.get(winnerKey);
      if (winnerId && winnerId !== (jobIdentifier || currentSlug)) {
        stats.previousSlugNonWinnerClaims += 1;
        return;
      }

      const oldPath = buildCanonicalJobDetailPath(locale, job, oldSlug, canton);
      const oldPathKey = normalizedPathKey(oldPath);
        if (
          activeJobDirs.has(oldPathKey)
          || activeRouteOwnerKeys.has(`${canton}:${locale}:${oldSlug}`)
        ) {
          stats.previousSlugActivePathCollisions += 1;
          return;
        }
        bridgeByPath.set(`${locale}\u0000${oldPathKey}`, {
          path: oldPath,
          locale,
          slug: oldSlug,
          targetPath: buildCanonicalJobDetailPath(locale, job, currentSlug, canton),
          kind: 'previousSlug',
          canton,
          sourceJobIdentifier: jobIdentifier,
        });
        claimedPaths.add(`${locale}\u0000${oldPathKey}`);

        if (canton !== 'TI' && !isCompanyHubNamespaceSlug(oldSlug, locale)) {
          const mirrorPath = buildCanonicalJobDetailPath(locale, 'TI', oldSlug);
          const mirrorKey = normalizedPathKey(mirrorPath);
          const mirrorMapKey = `${locale}\u0000${mirrorKey}`;
          if (
            activeJobDirs.has(mirrorKey)
            || activeLegacyTiBridgeDirs.has(mirrorMapKey)
            || legacyTiMirrorDirs.has(mirrorMapKey)
          ) return;
          legacyTiMirrorDirs.add(mirrorMapKey);
          bridgeByPath.set(mirrorMapKey, {
            path: mirrorPath,
            locale,
            slug: oldSlug,
            targetPath: buildCanonicalJobDetailPath(locale, job, currentSlug, canton),
            kind: 'legacyTiMirror',
            canton,
            sourceJobIdentifier: jobIdentifier,
          });
          claimedPaths.add(mirrorMapKey);
        }
    });
  }

  stats.previousSlugPaths = [...bridgeByPath.values()].filter((record) => record.kind === 'previousSlug').length;
  stats.legacyTiMirrorPaths = [...bridgeByPath.values()].filter((record) => record.kind === 'legacyTiMirror').length;

  for (const job of jobs) {
    options.onHeapSample?.();
    const canton = cantonByJob.get(job)!;
    const currentByLocale = currentSlugByJobLocale.get(job)!;
    for (const baseLocale of JOB_CANON_LOCALES) {
      const baseSlug = currentByLocale[baseLocale];
      if (!baseSlug) continue;
      const foreignSlugs = new Set<string>();
      for (const otherLocale of JOB_CANON_LOCALES) {
        if (otherLocale === baseLocale) continue;
        const foreignCurrent = currentByLocale[otherLocale];
        if (foreignCurrent && foreignCurrent !== baseSlug) foreignSlugs.add(foreignCurrent);
        for (const previousSlug of localePreviousSlugs(job, otherLocale)) {
          if (previousSlug !== baseSlug) foreignSlugs.add(previousSlug);
        }
      }
      for (const foreignSlug of foreignSlugs) {
        stats.crossLocaleCandidates += 1;
        if (reservedHubSlugs.has(foreignSlug)) {
          stats.crossLocaleReservedClaims += 1;
          continue;
        }
        if (isCompanyHubNamespaceSlug(foreignSlug, baseLocale)) {
          stats.crossLocaleCompanyNamespaceClaims += 1;
          continue;
        }
        const bridgePath = buildCanonicalJobDetailPath(baseLocale, 'TI', foreignSlug);
        const bridgePathKey = normalizedPathKey(bridgePath);
        const pathMapKey = `${baseLocale}\u0000${bridgePathKey}`;
        if (
          activeJobDirs.has(bridgePathKey)
          || activeRouteOwnerKeys.has(`TI:${baseLocale}:${foreignSlug}`)
        ) {
          stats.crossLocaleActivePathCollisions += 1;
          continue;
        }
        if (workerWouldRecover(baseLocale, foreignSlug, bridgePath)) {
          stats.crossLocaleWorkerRecovered += 1;
          continue;
        }
        if (!canWriteCrossLocalePath(bridgePath)) continue;
        if (claimedPaths.has(pathMapKey)) {
          stats.crossLocaleAlreadyClaimed += 1;
          continue;
        }
        bridgeByPath.set(pathMapKey, {
          path: bridgePath,
          locale: baseLocale,
          slug: foreignSlug,
          targetPath: buildCanonicalJobDetailPath(baseLocale, job, baseSlug, canton),
          kind: 'crossLocale',
          canton,
          sourceJobIdentifier: String(job.id || job.slug || ''),
        });
        claimedPaths.add(pathMapKey);
      }
    }
  }

  stats.crossLocalePaths = [...bridgeByPath.values()].filter((record) => record.kind === 'crossLocale').length;
  const bridgeSlugs = new Set([...bridgeByPath.values()].map((bridge) => bridge.slug));
  const activePrefixByLocaleSlug = new Map<string, string | null>();
  for (const job of jobs) {
    const canton = cantonByJob.get(job)!;
    const currentByLocale = currentSlugByJobLocale.get(job)!;
    for (const locale of JOB_CANON_LOCALES) {
      const currentSlug = currentByLocale[locale];
      if (!currentSlug || !bridgeSlugs.has(currentSlug)) continue;
      const canonicalPath = buildCanonicalJobDetailPath(locale, job, currentSlug, canton);
      const canonicalSegments = canonicalPath.replace(/\/+$/, '').split('/').filter(Boolean);
      if (canonicalSegments.length < 2) continue;
      const prefix = `/${canonicalSegments.slice(0, -1).join('/')}`;
      const prefixKey = localeSlugKey(locale, currentSlug);
      if (!activePrefixByLocaleSlug.has(prefixKey)) activePrefixByLocaleSlug.set(prefixKey, prefix);
      else if (activePrefixByLocaleSlug.get(prefixKey) !== prefix) activePrefixByLocaleSlug.set(prefixKey, null);
    }
  }
  bridgeSlugs.clear();
  return {
    bridgePaths: [...bridgeByPath.values()],
    activeRouteSlugKeys,
    activeCanonicalPaths,
    activePrefixByLocaleSlug,
    stats,
  };
}

/**
 * Resolve one alias per locale+slug after collecting every bridge destination.
 * Only slugs that are current active routes in this locale block an alias.
 * Historical registry prefixes are removed when an active alias is emitted;
 * existing registry aliases keep first-writer precedence.
 */
export function planActiveJobCanonAliases(
  plan: ActiveJobBridgePathPlan,
  entryForSlug: (slug: string) => JobCanonEntryLike | undefined,
  onHeapSample?: () => void,
): ActiveJobAliasPlan {
  const targetsByLocaleSlug = new Map<string, Set<string>>();
  const bridgePathKeys = new Set(
    plan.bridgePaths.map((bridge) => localeSlugKey(bridge.locale, normalizedPathKey(bridge.path))),
  );
  let bridgeIndex = 0;
  for (const bridge of plan.bridgePaths) {
    bridgeIndex++;
    if (bridgeIndex % 2048 === 0) onHeapSample?.();
    const key = localeSlugKey(bridge.locale, bridge.slug);
    const targets = targetsByLocaleSlug.get(key) ?? new Set<string>();
    targets.add(bridge.targetPath);
    targetsByLocaleSlug.set(key, targets);
  }

  const aliases: ActiveJobAliasPlan['aliases'] = [];
  const ambiguousCantonKeys = new Set<string>();
  const stats: ActiveJobAliasStats = {
    candidateGroups: targetsByLocaleSlug.size,
    realPageGroups: 0,
    existingRegistryAliasGroups: 0,
    ambiguousCantonGroups: 0,
    autoAliasGroups: 0,
    chainGroups: 0,
    emittedAliases: 0,
    aliasesByLocale: { it: 0, en: 0, de: 0, fr: 0 },
    ambiguousExamples: [],
  };

  let targetGroupIndex = 0;
  for (const [key, targets] of targetsByLocaleSlug) {
    targetGroupIndex++;
    if (targetGroupIndex % 2048 === 0) onHeapSample?.();
    const split = key.indexOf('\u0000');
    const locale = key.slice(0, split) as JobCanonLocale;
    const slug = key.slice(split + 1);
    const entry = entryForSlug(slug);
    if (plan.activeRouteSlugKeys.has(localeSlugKey(locale, slug))) {
      stats.realPageGroups += 1;
      continue;
    }
    if (targets.size > 1) {
      stats.ambiguousCantonGroups += 1;
      ambiguousCantonKeys.add(key);
      if (stats.ambiguousExamples.length < 12) {
        stats.ambiguousExamples.push({ locale, slug, targets: [...targets].sort() });
      }
      continue;
    }
    const targetPath = targets.values().next().value as string | undefined;
    if (!targetPath) continue;
    const targetSlug = targetPath.replace(/\/+$/, '').split('/').pop() || '';
    if (targetSlug === slug) {
      stats.autoAliasGroups += 1;
      continue;
    }
    if (
      bridgePathKeys.has(localeSlugKey(locale, normalizedPathKey(targetPath)))
      && !plan.activeCanonicalPaths.has(normalizedPathKey(targetPath))
    ) {
      stats.chainGroups += 1;
      continue;
    }
    const alias = entry?.alias?.[locale];
    if (typeof alias === 'string' && alias) {
      stats.existingRegistryAliasGroups += 1;
      continue;
    }
    aliases.push({ slug, locale, targetPath });
    stats.aliasesByLocale[locale] += 1;
    stats.emittedAliases += 1;
  }

  return { aliases, ambiguousCantonKeys, stats };
}

const AMBIGUOUS_TARGET = -1;

/**
 * Stream active-job bridge destinations into a compact locale+slug map.
 * Unlike `buildActiveJobBridgePathPlan`, this does not retain bridge paths or
 * destination sets: each key stores one interned canonical target ID or the
 * ambiguity sentinel. The build uses this form so the full bridge inventory
 * remains available to PR-B without inflating the closeBundle heap.
 */
export function emitActiveJobCanonAliases(
  jobs: readonly ActiveJobSlugMapRow[],
  options: {
    winners: WinnersFile;
    /** Restrict active alias planning to the v2 bucket currently being emitted. */
    bucketIndex?: number;
    reservedHubSlugs: ReadonlySet<string>;
    entryForSlug: (slug: string) => JobCanonEntryLike | undefined;
    hasRegistryAlias?: (slug: string, locale: JobCanonLocale) => boolean;
    workerWouldRecover?: (locale: JobCanonLocale, slug: string, path: string) => boolean;
    canWriteCrossLocalePath?: (path: string) => boolean;
    emitAlias: (slug: string, locale: JobCanonLocale, targetPath: string) => void;
    onHeapSample?: (phase?: string) => void;
  },
): ActiveJobAliasStats {
  const workerWouldRecover = options.workerWouldRecover ?? (() => false);
  const canWriteCrossLocalePath = options.canWriteCrossLocalePath ?? (() => true);
  const isInBucket = (slug: string): boolean => options.bucketIndex === undefined
    || jobSlugShardIndexForCount(slug, JOB_CANON_V2_SHARD_COUNT) === options.bucketIndex;
  const activeRouteSlugs = new Map<JobCanonLocale, Set<string>>(
    JOB_CANON_LOCALES.map((locale) => [locale, new Set<string>()]),
  );
  const activeTiSlugs = new Map<JobCanonLocale, Set<string>>(
    JOB_CANON_LOCALES.map((locale) => [locale, new Set<string>()]),
  );
  const legacyTiCurrentSlugs = new Map<JobCanonLocale, Set<string>>(
    JOB_CANON_LOCALES.map((locale) => [locale, new Set<string>()]),
  );
  const claimedTiBridgeSlugs = new Map<JobCanonLocale, Set<string>>(
    JOB_CANON_LOCALES.map((locale) => [locale, new Set<string>()]),
  );
  const emittedTiMirrors = new Map<JobCanonLocale, Set<string>>(
    JOB_CANON_LOCALES.map((locale) => [locale, new Set<string>()]),
  );

  const claimsByCanton = new Map<
    string,
    Map<JobCanonLocale, Map<string, WinnerCandidateAccumulator>>
  >();

  const recordClaim = (
    canton: string,
    locale: JobCanonLocale,
    oldSlug: string,
    candidate: CandidateInput,
  ): void => {
    let byLocale = claimsByCanton.get(canton);
    if (!byLocale) { byLocale = new Map(); claimsByCanton.set(canton, byLocale); }
    let bySlug = byLocale.get(locale);
    if (!bySlug) { bySlug = new Map(); byLocale.set(locale, bySlug); }
    let accumulator = bySlug.get(oldSlug);
    if (!accumulator) {
      const previousWinner = options.winners[previousSlugWinnerKey(canton, locale, oldSlug)]
        ?.winnerJobIdentifier;
      accumulator = createWinnerCandidateAccumulator(previousWinner);
      bySlug.set(oldSlug, accumulator);
    }
    addWinnerCandidate(oldSlug, accumulator, candidate);
  };

  for (const job of jobs) {
    options.onHeapSample?.('claims');
    const canton = resolveJobCanton(job);
    const identifier = String(job.id || job.slug || '');
    for (const locale of JOB_CANON_LOCALES) {
      const currentSlug = localizedActiveJobSlug(job, locale);
      if (!currentSlug) continue;
      if (!isInBucket(currentSlug)) continue;
      activeRouteSlugs.get(locale)!.add(currentSlug);
      if (canton === 'TI') activeTiSlugs.get(locale)!.add(currentSlug);
    }

    const italianSlug = typeof job.slug === 'string' ? job.slug : '';
    if (italianSlug && isInBucket(italianSlug) && canton !== 'TI') {
      for (const locale of JOB_CANON_LOCALES) {
        if (!isCompanyHubNamespaceSlug(italianSlug, locale)) {
          legacyTiCurrentSlugs.get(locale)!.add(italianSlug);
        }
      }
    }
    // jobsSeoPagesPlugin writes this localized current-slug bridge before the
    // cross-locale reconciliation phase when the job itself belongs to TI.
    if (italianSlug && isInBucket(italianSlug) && canton === 'TI') {
      for (const locale of JOB_CANON_LOCALES) {
        if (locale !== 'it' && localizedActiveJobSlug(job, locale) !== italianSlug) {
          claimedTiBridgeSlugs.get(locale)!.add(italianSlug);
        }
      }
    }

    forEachPreviousSlugByLocale(job, (locale, oldSlug) => {
      const currentSlug = localizedActiveJobSlug(job, locale);
      if (!currentSlug || oldSlug === currentSlug || options.reservedHubSlugs.has(oldSlug)) return;
      recordClaim(canton, locale, oldSlug, {
        jobIdentifier: identifier || currentSlug,
        canonicalSlug: currentSlug,
      });
    }, isInBucket);
  }

  const winnerByCanton = new Map<string, Map<JobCanonLocale, Map<string, string>>>();
  const winnerNow = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
  for (const [canton, byLocale] of claimsByCanton) {
    const winnersByLocale = new Map<JobCanonLocale, Map<string, string>>();
    winnerByCanton.set(canton, winnersByLocale);
    for (const [locale, bySlug] of byLocale) {
      const winnersBySlug = new Map<string, string>();
      winnersByLocale.set(locale, winnersBySlug);
      for (const [oldSlug, accumulator] of bySlug) {
        const winner = resolveWinner(
          options.winners,
          canton,
          locale,
          oldSlug,
          accumulator,
          winnerNow,
          { persist: false },
        );
        if (winner) winnersBySlug.set(oldSlug, winner.winnerJobIdentifier);
      }
      bySlug.clear();
    }
    byLocale.clear();
  }
  claimsByCanton.clear();
  options.onHeapSample?.('claims-cleared');

  const targetPathIds = new Map<string, number>();
  const targetPaths: string[] = [];
  const targetIdByLocaleSlug = new Map<JobCanonLocale, Map<string, number>>(
    JOB_CANON_LOCALES.map((locale) => [locale, new Map<string, number>()]),
  );
  const ambiguousTargetsByLocaleSlug = new Map<string, {
    locale: JobCanonLocale;
    slug: string;
    targets: Set<string>;
  }>();
  const internTarget = (canonicalPath: string): number => {
    const targetPath = canonicalPath.replace(/\/+$/, '');
    const existing = targetPathIds.get(targetPath);
    if (existing !== undefined) return existing;
    const id = targetPaths.length;
    targetPaths.push(targetPath);
    targetPathIds.set(targetPath, id);
    return id;
  };
  const recordDestination = (locale: JobCanonLocale, slug: string, canonicalPath: string): void => {
    const bySlug = targetIdByLocaleSlug.get(locale)!;
    const targetId = internTarget(canonicalPath);
    const prior = bySlug.get(slug);
    if (prior === undefined) bySlug.set(slug, targetId);
    else if (prior !== AMBIGUOUS_TARGET && prior !== targetId) {
      bySlug.set(slug, AMBIGUOUS_TARGET);
      if (ambiguousTargetsByLocaleSlug.size < 3) {
        ambiguousTargetsByLocaleSlug.set(localeSlugKey(locale, slug), {
          locale,
          slug,
          targets: new Set([targetPaths[prior], targetPaths[targetId]]),
        });
      }
    } else if (prior === AMBIGUOUS_TARGET) {
      const example = ambiguousTargetsByLocaleSlug.get(localeSlugKey(locale, slug));
      if (example && example.targets.size < 5) example.targets.add(targetPaths[targetId]);
    }
  };
  const tiBridgeTargetIds = new Map<JobCanonLocale, Map<string, number>>(
    JOB_CANON_LOCALES.map((locale) => [locale, new Map<string, number>()]),
  );

  for (const job of jobs) {
    options.onHeapSample?.('previous-targets');
    const canton = resolveJobCanton(job);
    const identifier = String(job.id || job.slug || '');
    forEachPreviousSlugByLocale(job, (locale, oldSlug) => {
      const currentSlug = localizedActiveJobSlug(job, locale);
      if (!currentSlug || oldSlug === currentSlug || options.reservedHubSlugs.has(oldSlug)) return;
      const winnerId = winnerByCanton.get(canton)?.get(locale)?.get(oldSlug);
      if (winnerId && winnerId !== (identifier || currentSlug)) return;
      const targetPath = buildCanonicalJobDetailPath(locale, job, currentSlug, canton);
      if (canton === 'TI') {
        tiBridgeTargetIds.get(locale)!.set(oldSlug, internTarget(targetPath));
      } else {
        recordDestination(locale, oldSlug, targetPath);
      }

      // Only TI-section bridges can collide with the later cross-locale
      // phase. A mirror has the same destination as its canton path, so it
      // adds no new target ID; retain just its compact locale+slug claim.
      if (canton === 'TI') {
        claimedTiBridgeSlugs.get(locale)!.add(oldSlug);
      } else if (
        !isCompanyHubNamespaceSlug(oldSlug, locale)
        && !activeTiSlugs.get(locale)!.has(oldSlug)
        && !legacyTiCurrentSlugs.get(locale)!.has(oldSlug)
        && !emittedTiMirrors.get(locale)!.has(oldSlug)
      ) {
        claimedTiBridgeSlugs.get(locale)!.add(oldSlug);
        emittedTiMirrors.get(locale)!.add(oldSlug);
        tiBridgeTargetIds.get(locale)!.set(oldSlug, internTarget(targetPath));
      }
    }, isInBucket);
  }
  winnerByCanton.clear();
  emittedTiMirrors.clear();
  legacyTiCurrentSlugs.clear();

  // One final TI path survives per locale+slug. The bridge emitter's later
  // writes replace an earlier TI previous-slug page with a legacy mirror (or
  // vice versa), so only its last target contributes to ambiguity.
  for (const locale of JOB_CANON_LOCALES) {
    for (const [slug, targetId] of tiBridgeTargetIds.get(locale)!) {
      recordDestination(locale, slug, targetPaths[targetId]);
    }
    tiBridgeTargetIds.get(locale)!.clear();
  }

  for (const job of jobs) {
    options.onHeapSample?.('cross-locale');
    const canton = resolveJobCanton(job);
    for (const baseLocale of JOB_CANON_LOCALES) {
      const baseSlug = localizedActiveJobSlug(job, baseLocale);
      if (!baseSlug) continue;
      const processForeignSlug = (foreignSlug: string): void => {
        if (!isInBucket(foreignSlug)) return;
        if (options.reservedHubSlugs.has(foreignSlug)) return;
        if (isCompanyHubNamespaceSlug(foreignSlug, baseLocale)) return;
        if (activeTiSlugs.get(baseLocale)!.has(foreignSlug)) return;
        const bridgePath = buildCanonicalJobDetailPath(baseLocale, 'TI', foreignSlug);
        if (workerWouldRecover(baseLocale, foreignSlug, bridgePath)) return;
        if (!canWriteCrossLocalePath(bridgePath)) return;
        if (claimedTiBridgeSlugs.get(baseLocale)!.has(foreignSlug)) return;
        claimedTiBridgeSlugs.get(baseLocale)!.add(foreignSlug);
        recordDestination(
          baseLocale,
          foreignSlug,
          buildCanonicalJobDetailPath(baseLocale, job, baseSlug, canton),
        );
      };
      for (const otherLocale of JOB_CANON_LOCALES) {
        if (otherLocale === baseLocale) continue;
        const foreignCurrent = localizedActiveJobSlug(job, otherLocale);
        if (foreignCurrent && foreignCurrent !== baseSlug) processForeignSlug(foreignCurrent);
        for (const previousSlug of localePreviousSlugs(job, otherLocale, isInBucket)) {
          if (previousSlug !== baseSlug) processForeignSlug(previousSlug);
        }
      }
    }
  }
  activeTiSlugs.clear();
  claimedTiBridgeSlugs.clear();
  targetPathIds.clear();

  const stats: ActiveJobAliasStats = {
    candidateGroups: 0,
    realPageGroups: 0,
    existingRegistryAliasGroups: 0,
    ambiguousCantonGroups: 0,
    autoAliasGroups: 0,
    chainGroups: 0,
    emittedAliases: 0,
    aliasesByLocale: { it: 0, en: 0, de: 0, fr: 0 },
    ambiguousExamples: [...ambiguousTargetsByLocaleSlug.values()].map((example) => ({
      locale: example.locale,
      slug: example.slug,
      targets: [...example.targets].sort(),
    })),
  };
  for (const locale of JOB_CANON_LOCALES) {
    const bySlug = targetIdByLocaleSlug.get(locale)!;
    stats.candidateGroups += bySlug.size;
    let groupsVisited = 0;
    for (const [slug, targetId] of bySlug) {
      groupsVisited += 1;
      if (groupsVisited % 4096 === 0) options.onHeapSample?.('alias-emission');
      if (activeRouteSlugs.get(locale)!.has(slug)) {
        stats.realPageGroups++;
        continue;
      }
      if (targetId === AMBIGUOUS_TARGET) {
        stats.ambiguousCantonGroups++;
        const example = ambiguousTargetsByLocaleSlug.get(localeSlugKey(locale, slug));
        if (example) {
          stats.ambiguousExamples.push({
            locale,
            slug,
            targets: [...example.targets].sort(),
          });
        }
        continue;
      }
      const targetPath = targetPaths[targetId];
      if (!targetPath) continue;
      const targetSlug = targetPath.split('/').pop() || '';
      if (targetSlug === slug) {
        stats.autoAliasGroups++;
        continue;
      }
      const entry = options.hasRegistryAlias ? undefined : options.entryForSlug(slug);
      const alias = options.hasRegistryAlias
        ? (options.hasRegistryAlias(slug, locale) ? '/registry-alias-present' : undefined)
        : entry?.alias?.[locale];
      if (typeof alias === 'string' && alias) {
        stats.existingRegistryAliasGroups++;
        continue;
      }
      options.emitAlias(slug, locale, targetPath);
      stats.aliasesByLocale[locale]++;
      stats.emittedAliases++;
    }
    bySlug.clear();
  }
  targetPathIds.clear();
  targetPaths.length = 0;
  winnerByCanton.clear();
  activeRouteSlugs.clear();
  activeTiSlugs.clear();
  legacyTiCurrentSlugs.clear();
  claimedTiBridgeSlugs.clear();
  emittedTiMirrors.clear();
  tiBridgeTargetIds.clear();
  ambiguousTargetsByLocaleSlug.clear();
  return stats;
}

/**
 * Compare each emitted 200 bridge with the exact target the Worker would use.
 * PR-B may remove only the `removable` paths; keep reasons are stable strings
 * suitable for reporting and follow-up decisions.
 */
export function classifyBridgePaths(
  bridgePaths: readonly JobCanonBridgePath[],
  entryForSlug: JobCanonEntryLookup,
  ambiguousCantonKeys: ReadonlySet<string> = new Set(),
  activeCurrentSlugKeys: ReadonlySet<string> = new Set(),
  onHeapSample?: () => void,
): BridgePathClassification {
  const lookup = typeof entryForSlug === 'function'
    ? entryForSlug
    : (slug: string) => entryForSlug.get(slug);
  const bridgePathKeys = new Set(
    bridgePaths.map((bridge) => `${bridge.locale}\u0000${normalizedPathKey(bridge.path)}`),
  );
  const removable = new Set<string>();
  const keepBridge = new Map<string, BridgeKeepReason>();

  let bridgeIndex = 0;
  for (const bridge of bridgePaths) {
    bridgeIndex++;
    if (bridgeIndex % 2048 === 0) onHeapSample?.();
    const entry = lookup(bridge.slug);
    const workerTarget = entry ? jobCanonTarget(entry, bridge.slug, bridge.locale) as string | null : null;
    if (workerTarget === bridge.targetPath) {
      removable.add(bridge.path);
      continue;
    }

    const ambiguous = ambiguousCantonKeys.has(localeSlugKey(bridge.locale, bridge.slug));
    let reason: BridgeKeepReason;
    if (activeCurrentSlugKeys.has(localeSlugKey(bridge.locale, bridge.slug))) {
      reason = 'exactPrefix';
    } else if (ambiguous) {
      reason = 'ambiguousCanton';
    } else if (!entry) {
      reason = 'noEntry';
    } else if (
      typeof entry.alias?.[bridge.locale] === 'string'
      && Boolean(entry.alias[bridge.locale])
      && !workerTarget
    ) {
      reason = 'crossLocaleAlias';
    } else if (!workerTarget) {
      reason = 'noTarget';
    } else if (bridgePathKeys.has(`${bridge.locale}\u0000${normalizedPathKey(workerTarget)}`)) {
      reason = 'chain';
    } else {
      reason = 'targetMismatch';
    }
    keepBridge.set(bridge.path, reason);
  }
  return { removable, keepBridge };
}

/**
 * A bridge is removable only when its source job was uniquely reconciled into
 * the final serialized Worker slug map. The caller supplies alias facts built
 * from that same reconciled input; unmatched source rows remain `keepBridge`.
 */
export function classifyBridgePathsFromFinalWorkerMap(
  bridgePaths: readonly JobCanonBridgePath[],
  entryForSlug: JobCanonEntryLookup,
  matchedWorkerJobIdentifiers: ReadonlySet<string>,
  ambiguousCantonKeys: ReadonlySet<string> = new Set(),
  activeCurrentSlugKeys: ReadonlySet<string> = new Set(),
  onHeapSample?: () => void,
): BridgePathClassification {
  const classification = classifyBridgePaths(
    bridgePaths,
    entryForSlug,
    ambiguousCantonKeys,
    activeCurrentSlugKeys,
    onHeapSample,
  );
  for (const bridge of bridgePaths) {
    if (bridge.sourceJobIdentifier && matchedWorkerJobIdentifiers.has(bridge.sourceJobIdentifier)) continue;
    if (classification.removable.delete(bridge.path)) {
      classification.keepBridge.set(bridge.path, 'noEntry');
    } else if (!classification.keepBridge.has(bridge.path)) {
      classification.keepBridge.set(bridge.path, 'noEntry');
    }
  }
  return classification;
}

/** Fail a build when any old bridge is unclassified or its alias target drifts. */
export function assertBridgePathClassificationCoverage(
  bridgePaths: readonly JobCanonBridgePath[],
  classification: BridgePathClassification,
  entryForSlug: JobCanonEntryLookup,
): void {
  if (classification.removable.size + classification.keepBridge.size !== bridgePaths.length) {
    throw new Error('[job-alias-redirect-gate] bridge path classification is incomplete');
  }
  const lookup = typeof entryForSlug === 'function'
    ? entryForSlug
    : (slug: string) => entryForSlug.get(slug);

  for (const bridge of bridgePaths) {
    const removable = classification.removable.has(bridge.path);
    const keepBridge = classification.keepBridge.has(bridge.path);
    if (removable === keepBridge) {
      throw new Error('[job-alias-redirect-gate] bridge path has conflicting classification');
    }
    if (removable) {
      const entry = lookup(bridge.slug);
      const workerTarget = entry ? jobCanonTarget(entry, bridge.slug, bridge.locale) as string | null : null;
      if (workerTarget !== bridge.targetPath) {
        throw new Error('[job-alias-redirect-gate] removable path has no exact Worker target');
      }
    }
  }
}

export interface JobAliasRemovedPageOutput {
  indexPath: string;
  flatPath: string;
}

export interface JobAliasRetainedPageOutput {
  indexPath: string;
  targetPath: string;
}

/** Verify removed paths stay absent and retained paths still contain their bridge page. */
export function assertBridgePathDistCoverage(
  removableOutputs: Iterable<JobAliasRemovedPageOutput>,
  retainedOutputs: Iterable<JobAliasRetainedPageOutput>,
  outputExists: (filePath: string) => boolean,
  retainedOutputMatches: (filePath: string, targetPath: string) => boolean,
): { removable404: number; retained200: number } {
  let removable404 = 0;
  for (const output of removableOutputs) {
    if (outputExists(output.indexPath) || outputExists(output.flatPath)) {
      throw new Error('[job-alias-redirect-gate] removable path still has static HTML');
    }
    removable404++;
  }
  let retained200 = 0;
  for (const output of retainedOutputs) {
    if (!outputExists(output.indexPath)) {
      throw new Error('[job-alias-redirect-gate] path has neither an exact 301 nor a retained bridge');
    }
    if (!retainedOutputMatches(output.indexPath, output.targetPath)) {
      throw new Error('[job-alias-redirect-gate] retained bridge does not point to its planned canonical');
    }
    retained200++;
  }
  return { removable404, retained200 };
}
