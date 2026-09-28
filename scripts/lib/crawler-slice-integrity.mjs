import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  assertAccumulatorByteFloor,
  isCatastrophicAccumulatorShrink,
} from './accumulator-byte-floor-guard.mjs';
import { CRAWLER_GRACE_PERIOD_MAX_MISSES } from './crawler-grace-policy.mjs';
import { ISO_ALPHA2_COUNTRY_CODES } from './prospector/country-inventory.mjs';
import { isKnownSwissMunicipality } from './target-swiss-locations.mjs';

const JOB_SLICE_PATH_RE = /(?:^|\/)data\/jobs\/(?:by-crawler|expired\/by-crawler)\/[^/]+\.json$/;
const ACTIVE_JOB_SLICE_PATH_RE = /(?:^|\/)data\/jobs\/by-crawler\/[^/]+\.json$/;
const RETIRED_COOP_SCRATCH_ARCHIVE = 'data/jobs/expired/by-crawler/coop-ticino-locale-cache.json';
const SWISS_RE_SLICE_PATH_RE = /(?:^|\/)data\/jobs\/by-crawler\/swiss-re\.json$/;
const BUEHLER_SLICE_PATH_RE = /(?:^|\/)data\/jobs\/by-crawler\/buehler\.json$/;
const TERMINAL_COUNTRY_RE = /,\s*([A-Za-z]{2})\s*$/;
// These are the only unqualified locations observed in the Swiss Re slice
// written before #9858.  The old parser stamped its Swiss Re HQ metadata on
// them even though the source did not prove a Swiss workplace.  Keep this
// allowlist deliberately narrow: a generic unknown locality must still fail
// closed at the accumulator guard.
const SWISS_RE_LEGACY_HQ_FALLBACK_LOCATION_RE = /^(?:z(?:u|ü)rich|washington d)$/i;
// Before issue #9860 the Prospective factory stamped Bühler's configured HQ
// metadata on every listing in medium 1008005, including the group's foreign
// sites. Once the factory became source-geography aware, those rows were kept
// by the normal miss grace and then legitimately retired. Keep this signature
// narrow: only rows from that exact parser, with the old SG/CH HQ stamp, an
// exhausted grace streak, and a location that is not a Swiss municipality can
// be removed in one intentional migration.
const BUEHLER_LEGACY_SOURCE = 'bühler group dedicated parser (prospective medium 1008005)';
// The pre-#9860 Bühler slice stored the source city but had already stamped
// every row with the Swiss HQ country/canton.  These are the exact foreign
// locality values present in that 2026-09-24 legacy snapshot (the only
// unqualified evidence available after the old parser discarded the source
// country).  Keep the historical migration proof positive and closed-world:
// a new or malformed locality is not foreign merely because it is absent from
// the Swiss municipality inventory.
const BUEHLER_LEGACY_FOREIGN_LOCATION_KEYS = new Set([
  'alzenau',
  'bab ezzouar',
  'bangkok',
  'beijing',
  'beilngries',
  'biejing',
  'braunschweig',
  'cary',
  'curitiba',
  'hasselroth',
  'holland',
  'ikeja',
  'leobendorf burg kreuzenstein',
  'london',
  'makati city',
  'owatonna',
  'perrysburg',
  'plymouth',
  'prague',
  'singapore',
  'skovlunde',
  'subang jaya',
  'tangerang',
  'toluca',
  'wuxi',
  'izmir',
  'الرياض',
]);

function normalizedPath(filePath) {
  return String(filePath ?? '').replace(/\\/g, '/');
}

function sha256(raw) {
  return createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

function housekeepingProofTarget(slicePath, { proofDir, cwd = process.cwd() } = {}) {
  const absoluteSlicePath = path.resolve(cwd, slicePath);
  const relativePath = path.relative(cwd, absoluteSlicePath);
  if (
    !relativePath
    || path.isAbsolute(relativePath)
    || relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
  ) {
    return null;
  }
  const resolvedProofDir = path.resolve(
    proofDir
      || process.env.JOBS_HOUSEKEEPING_PROOF_DIR
      || path.join(
        process.env.RUNNER_TEMP || process.env.TMPDIR || '/tmp',
        'frontaliere-housekeeping-proofs',
      ),
  );
  return {
    relativePath: relativePath.split(path.sep).join('/'),
    proofPath: path.join(resolvedProofDir, `${relativePath}.housekeeping-proof.json`),
  };
}

function checkoutHeadSha(cwd) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Persist definitive URL evidence for the isolated commit helper.
 *
 * The proof is deliberately kept outside the checkout: the writer and the
 * later commit step may both rewrite the slice, so the commit helper binds the
 * sidecar to the final candidate digest plus the current run metadata. This is
 * shared by cleanup-jobs and source-verified crawler shrinks so the two write
 * paths cannot drift apart.
 *
 * @param {string} slicePath
 * @param {unknown[]} entries
 * @param {{baseRaw?: string, candidateRaw?: string, proofDir?: string, env?: NodeJS.ProcessEnv, cwd?: string, baseSha?: string}} [options]
 */
export function writeHousekeepingProofFile(
  slicePath,
  entries,
  { baseRaw, candidateRaw, proofDir, env = process.env, cwd = process.cwd(), baseSha = '' } = {},
) {
  if (!Array.isArray(entries) || entries.length === 0) return false;
  if (typeof baseRaw !== 'string' || typeof candidateRaw !== 'string') return false;
  const target = housekeepingProofTarget(slicePath, { proofDir, cwd });
  if (!target) return false;

  const resolvedBaseSha = String(baseSha || checkoutHeadSha(cwd) || env.GITHUB_SHA || '').trim();
  const runId = String(env.GITHUB_RUN_ID || '').trim();
  const runAttempt = String(env.GITHUB_RUN_ATTEMPT || '').trim();
  if (!resolvedBaseSha || !runId || !runAttempt) {
    throw new Error(
      'cannot write housekeeping proof without a checkout HEAD (or GITHUB_SHA), GITHUB_RUN_ID, and GITHUB_RUN_ATTEMPT',
    );
  }

  fs.mkdirSync(path.dirname(target.proofPath), { recursive: true });
  const temporaryPath = `${target.proofPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify({
      schemaVersion: 2,
      path: target.relativePath,
      baseDigest: sha256(baseRaw),
      candidateDigest: sha256(candidateRaw),
      baseSha: resolvedBaseSha,
      runId,
      runAttempt,
      entries,
    }, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, target.proofPath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch { /* best-effort cleanup */ }
    throw error;
  }
  return true;
}

function parseJobs(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return Array.isArray(parsed?.jobs) ? parsed.jobs : null;
  } catch {
    return null;
  }
}

function jobIdentity(job) {
  const url = String(job?.url ?? '').trim();
  if (url) return `url:${url}`;
  const id = String(job?.id ?? '').trim();
  return id ? `id:${id}` : null;
}

function hasNonEmptyJobUrl(job) {
  return typeof job?.url === 'string' && job.url.trim().length > 0;
}

function uniqueIdentities(jobs) {
  const identities = new Set();
  for (const job of jobs) {
    const identity = jobIdentity(job);
    if (!identity || identities.has(identity)) return null;
    identities.add(identity);
  }
  return identities;
}

function normalizedJobField(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The same semantic key used by cleanup-jobs for cross-crawler dedup. */
function titleCompanyLocationKey(job) {
  const fields = [job?.title, job?.company, job?.location].map(normalizedJobField);
  return fields.every(Boolean) ? fields.join('|') : null;
}

function terminalCountryCodes(location) {
  const entries = String(location ?? '')
    .split('|')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) return null;
  const codes = entries.map((entry) => entry.match(TERMINAL_COUNTRY_RE)?.[1]?.toUpperCase() ?? null);
  return codes.every((code) => code && ISO_ALPHA2_COUNTRY_CODES.has(code)) ? codes : null;
}

function isExplicitSwissLocation(location) {
  const codes = terminalCountryCodes(location);
  return Boolean(codes?.length && codes.every((code) => code === 'CH'));
}

function isExplicitForeignLocation(location) {
  const codes = terminalCountryCodes(location);
  return Boolean(codes?.length && codes.every((code) => code !== 'CH'));
}

function isGraceExhaustedLegacyLocation(job) {
  const location = String(job?.location ?? '').trim();
  const missStreak = Number(job?.crawlerMissStreak);
  return Boolean(
    location
    && terminalCountryCodes(location) === null
    && Number.isInteger(missStreak)
    && missStreak >= CRAWLER_GRACE_PERIOD_MAX_MISSES
  );
}

function isGraceRetainedLegacyLocation(job) {
  const location = String(job?.location ?? '').trim();
  const missStreak = Number(job?.crawlerMissStreak);
  return Boolean(
    location
    && terminalCountryCodes(location) === null
    && Number.isInteger(missStreak)
    && missStreak > 0
    && missStreak <= CRAWLER_GRACE_PERIOD_MAX_MISSES
  );
}

function isLegacySwissReHqFallback(job) {
  return (
    String(job?.companyKey ?? '').trim() === 'swiss-re'
    && normalizedJobField(job?.source) === 'swiss re dedicated parser'
    && normalizedJobField(job?.addressCountry) === 'ch'
    && normalizedJobField(job?.country) === 'ch'
    && normalizedJobField(job?.canton) === 'zh'
    && normalizedJobField(job?.addressRegion) === 'zh'
    && SWISS_RE_LEGACY_HQ_FALLBACK_LOCATION_RE.test(normalizedJobField(job?.location))
  );
}

function isLegacyBuehlerRow(job) {
  const missStreak = Number(job?.crawlerMissStreak);
  return (
    String(job?.companyKey ?? '').trim() === 'buehler'
    && normalizedJobField(job?.source) === BUEHLER_LEGACY_SOURCE
    && normalizedJobField(job?.addressCountry) === 'ch'
    && normalizedJobField(job?.country) === 'ch'
    && normalizedJobField(job?.canton) === 'sg'
    && normalizedJobField(job?.addressRegion) === 'sg'
    && Number.isInteger(missStreak)
    && missStreak >= CRAWLER_GRACE_PERIOD_MAX_MISSES
  );
}

function isLegacyBuehlerForeignJob(job) {
  const location = String(job?.location ?? '').trim();
  return isLegacyBuehlerRow(job)
    && location
    && (
      isExplicitForeignLocation(location)
      || BUEHLER_LEGACY_FOREIGN_LOCATION_KEYS.has(normalizedJobField(location))
    );
}

function isLegacyBuehlerSwissJob(job) {
  const location = String(job?.location ?? '').trim();
  return isLegacyBuehlerRow(job) && location && isKnownSwissMunicipality(location);
}

function isCurrentBuehlerSwissJob(job) {
  const location = String(job?.location ?? '').trim();
  return (
    String(job?.companyKey ?? '').trim() === 'buehler'
    && normalizedJobField(job?.source) === BUEHLER_LEGACY_SOURCE
    && normalizedJobField(job?.addressCountry) === 'ch'
    && normalizedJobField(job?.country) === 'ch'
    && normalizedJobField(job?.canton) === 'sg'
    && normalizedJobField(job?.addressRegion) === 'sg'
    && Boolean(location)
    && isKnownSwissMunicipality(location)
  );
}

export function isCrawlerSlicePath(filePath) {
  return JOB_SLICE_PATH_RE.test(normalizedPath(filePath));
}

/**
 * Recognise only the Swiss Re source-geography migration proved by issue
 * #9876: every retained record is explicitly Swiss or an ambiguous legacy
 * record still carrying a positive miss streak within the merge grace period,
 * and every removed record is either explicitly non-CH, an ambiguous legacy
 * record whose grace is exhausted, or the exact legacy HQ-fallback marker
 * observed before #9858. Unknown, mixed, malformed, or empty locations stay
 * on the generic fail-closed path.
 */
export function isSafeSwissReForeignPruneJobs(filePath, previousJobs, nextJobs) {
  if (!SWISS_RE_SLICE_PATH_RE.test(normalizedPath(filePath))) return false;
  if (!previousJobs || !nextJobs || previousJobs.length <= nextJobs.length || nextJobs.length === 0) {
    return false;
  }

  const previousIds = uniqueIdentities(previousJobs);
  const nextIds = uniqueIdentities(nextJobs);
  if (!previousIds || !nextIds) return false;

  for (const job of nextJobs) {
    if (!isExplicitSwissLocation(job?.location) && !isGraceRetainedLegacyLocation(job)) return false;
    if (String(job?.companyKey ?? '').trim() !== 'swiss-re') return false;
  }

  const removedJobs = previousJobs.filter((job) => !nextIds.has(jobIdentity(job)));
  if (removedJobs.length === 0) {
    return false;
  }
  return removedJobs.every((job) => (
    String(job?.companyKey ?? '').trim() === 'swiss-re'
    && (
      isExplicitForeignLocation(job?.location)
      || isGraceExhaustedLegacyLocation(job)
      || isLegacySwissReHqFallback(job)
    )
  ));
}

/**
 * Prove the one intentional large shrink caused by the Bühler geography fix
 * (#9860): retained rows must be source-backed Swiss municipalities, while
 * every removed row must be the exact legacy Bühler shape after the crawler's
 * miss grace is exhausted. At least one removed row must be a legacy foreign
 * row; a grace-exhausted Swiss row is allowed only as part of that same
 * migration, so an ordinary same-source Swiss shrink remains guarded.
 */
export function isSafeBuehlerForeignPruneJobs(filePath, previousJobs, nextJobs) {
  if (!BUEHLER_SLICE_PATH_RE.test(normalizedPath(filePath))) return false;
  if (!previousJobs || !nextJobs || previousJobs.length <= nextJobs.length || nextJobs.length === 0) {
    return false;
  }
  if (!nextJobs.every(isCurrentBuehlerSwissJob)) return false;

  const previousIds = uniqueIdentities(previousJobs);
  const nextIds = uniqueIdentities(nextJobs);
  if (!previousIds || !nextIds || ![...nextIds].some((identity) => previousIds.has(identity))) return false;

  const removedJobs = previousJobs.filter((job) => !nextIds.has(jobIdentity(job)));
  if (removedJobs.length !== previousJobs.length - nextJobs.length || removedJobs.length === 0) {
    return false;
  }
  if (!removedJobs.some(isLegacyBuehlerForeignJob)) return false;
  return removedJobs.every((job) => isLegacyBuehlerForeignJob(job) || isLegacyBuehlerSwissJob(job));
}

/**
 * Shared proof for source-geography migrations. Keep the employer-specific
 * predicates above narrow; this dispatcher is the single guard hook used by
 * the slice writer so a new migration cannot bypass the generic anti-shrink
 * check accidentally.
 */
export function isSafeSourceGeographyPruneJobs(filePath, previousJobs, nextJobs) {
  return (
    isSafeSwissReForeignPruneJobs(filePath, previousJobs, nextJobs)
    || isSafeBuehlerForeignPruneJobs(filePath, previousJobs, nextJobs)
  );
}

export function isSafeSwissReForeignPrune(filePath, previousRaw, nextRaw) {
  return isSafeSwissReForeignPruneJobs(filePath, parseJobs(previousRaw), parseJobs(nextRaw));
}

export function isSafeSourceGeographyPrune(filePath, previousRaw, nextRaw) {
  return isSafeSourceGeographyPruneJobs(filePath, parseJobs(previousRaw), parseJobs(nextRaw));
}

/**
 * Prove the only intentional large shrink performed by prune-dedup-from-slices.
 *
 * That command receives the post-dedup assembled dataset, so the surviving
 * duplicate can live in another crawler slice and will not be present in the
 * file being written. The proof therefore requires every removed record to:
 *   - be an unambiguous subset removal (no replacement or identity collision),
 *   - be absent from the assembled reference by URL/id, and
 *   - have its exact title+company+location key represented by a different
 *     record in that reference.
 *
 * Without this explicit reference the generic accumulator guard stays closed.
 */
export function isProvenCrossCrawlerDedupPrune(filePath, previousRaw, nextRaw, referenceJobs) {
  if (!ACTIVE_JOB_SLICE_PATH_RE.test(normalizedPath(filePath))) return false;
  const previousJobs = parseJobs(previousRaw);
  const nextJobs = parseJobs(nextRaw);
  const reference = Array.isArray(referenceJobs) ? referenceJobs : parseJobs(referenceJobs);
  if (!previousJobs || !nextJobs || !reference || previousJobs.length <= nextJobs.length) {
    return false;
  }

  const previousIds = uniqueIdentities(previousJobs);
  const nextIds = uniqueIdentities(nextJobs);
  if (!previousIds || !nextIds || [...nextIds].some((identity) => !previousIds.has(identity))) return false;

  const removed = previousJobs.filter((job) => !nextIds.has(jobIdentity(job)));
  if (removed.length !== previousJobs.length - nextJobs.length || removed.some((job) => !jobIdentity(job))) {
    return false;
  }

  const referenceIds = new Set(reference.map(jobIdentity).filter(Boolean));
  if (removed.some((job) => referenceIds.has(jobIdentity(job)))) return false;
  const referenceKeys = new Set(reference.map(titleCompanyLocationKey).filter(Boolean));
  return removed.every((job) => {
    const key = titleCompanyLocationKey(job);
    return key !== null && referenceKeys.has(key);
  });
}

/** `data/jobs/by-crawler/<key>.json` -> `data/jobs/expired/by-crawler/<key>.json`, or null. */
export function pairedExpiredSlicePath(filePath) {
  const normalized = normalizedPath(filePath);
  if (!ACTIVE_JOB_SLICE_PATH_RE.test(normalized)) return null;
  return normalized.replace(/(^|\/)data\/jobs\/by-crawler\//u, '$1data/jobs/expired/by-crawler/');
}

function nonEmptyStrings(values) {
  return values
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Keys under which an archived (expired) entry can be found again. */
function archiveEntryKeys(entry) {
  const slugs = [
    entry?.slug,
    ...Object.values(entry?.slugByLocale && typeof entry.slugByLocale === 'object' ? entry.slugByLocale : {}),
    ...(Array.isArray(entry?.previousSlugs) ? entry.previousSlugs : []),
    ...Object.values(
      entry?.previousSlugsByLocale && typeof entry.previousSlugsByLocale === 'object'
        ? entry.previousSlugsByLocale
        : {},
    ).flatMap((values) => (Array.isArray(values) ? values : [])),
  ];
  return [
    ...nonEmptyStrings(slugs).map((slug) => `slug:${slug}`),
    ...nonEmptyStrings([entry?.sourceIdentity]).map((identity) => `source:${identity}`),
  ];
}

/** Keys under which cleanup-jobs archives an active job (its current slug, its source identity). */
function activeJobArchiveKeys(job) {
  return [
    ...nonEmptyStrings([job?.slug]).map((slug) => `slug:${slug}`),
    ...nonEmptyStrings([job?.sourceIdentity]).map((identity) => `source:${identity}`),
  ];
}

/**
 * Prove, from the committed refs alone, that a catastrophic active-slice
 * shrink is an archive move rather than a lost accumulator (#9876).
 *
 * Housekeeping proves its large prunes with definitive URL evidence
 * (`isProvenHousekeepingPrune`), but that proof lives in the runner that wrote
 * the slice. The post-push guard on main only sees two commits, so it used to
 * revert the proven prune of the active slice while keeping the expired slice
 * of the same push: 79 jobs then lived in both files, assembly deduplicated
 * the expired slice by 98.6% and its own shrink guard broke every build.
 *
 * The in-repo evidence is closed-world:
 *   - the next slice is a strict subset of the previous one (no replacement,
 *     no identity collision), so nothing was rewritten or re-keyed;
 *   - every removed job has a slug and is present, by slug/previous slug or
 *     source identity, in the paired expired slice of the same AFTER commit,
 *     on an archive entry that carries a valid `expiredAt`.
 * A reader that degraded to an empty fallback archives nothing, so it still
 * fails this proof and the byte guard stays closed for it.
 */
export function isProvenArchiveMovePrune(filePath, previousRaw, nextRaw, expiredAfterRaw) {
  if (!ACTIVE_JOB_SLICE_PATH_RE.test(normalizedPath(filePath))) return false;
  const previousJobs = parseJobs(previousRaw);
  const nextJobs = parseJobs(nextRaw);
  if (!previousJobs || !nextJobs || previousJobs.length <= nextJobs.length) return false;

  let archive;
  try {
    archive = JSON.parse(expiredAfterRaw);
  } catch {
    return false;
  }
  if (!Array.isArray(archive) || archive.length === 0) return false;

  const previousIds = uniqueIdentities(previousJobs);
  const nextIds = uniqueIdentities(nextJobs);
  if (!previousIds || !nextIds || [...nextIds].some((identity) => !previousIds.has(identity))) return false;

  const removedJobs = previousJobs.filter((job) => !nextIds.has(jobIdentity(job)));
  if (
    removedJobs.length !== previousJobs.length - nextJobs.length
    || removedJobs.some((job) => !jobIdentity(job) || nonEmptyStrings([job?.slug]).length === 0)
  ) {
    return false;
  }

  const archivedKeys = new Set();
  for (const entry of archive) {
    if (!entry || typeof entry !== 'object') continue;
    if (!Number.isFinite(Date.parse(String(entry.expiredAt ?? '')))) continue;
    for (const key of archiveEntryKeys(entry)) archivedKeys.add(key);
  }
  return removedJobs.every((job) => activeJobArchiveKeys(job).some((key) => archivedKeys.has(key)));
}

/**
 * Prove a large housekeeping shrink from definitive URL evidence.
 *
 * Housekeeping is allowed to remove a job only after the validator has
 * returned a definitive dead verdict (404/410, a closed-portal marker, or a
 * generic-listing redirect).  The proof is carried alongside the write so the
 * byte guard can distinguish that intentional expiry from a reader that
 * silently fell back to an empty accumulator.
 *
 * Non-definitive failures are deliberately not accepted here, even though
 * ordinary housekeeping may remove an old unprotected row for those signals:
 * a catastrophic shrink needs stronger evidence than a normal prune.
 */
export function isProvenHousekeepingPrune(filePath, previousRaw, nextRaw, proofEntries) {
  if (!ACTIVE_JOB_SLICE_PATH_RE.test(normalizedPath(filePath))) return false;
  const proof = Array.isArray(proofEntries)
    ? { entries: proofEntries }
    : proofEntries && typeof proofEntries === 'object' ? proofEntries : null;
  const entries = proof?.entries;
  const previousJobs = parseJobs(previousRaw);
  const nextJobs = parseJobs(nextRaw);
  if (!previousJobs || !nextJobs || previousJobs.length <= nextJobs.length) return false;
  if (!Array.isArray(entries) || entries.length === 0) return false;
  if (proof?.baseDigest && (!proof.baseRaw || sha256(proof.baseRaw) !== proof.baseDigest)) return false;
  if (proof?.candidateDigest && (!proof.candidateRaw || sha256(proof.candidateRaw) !== proof.candidateDigest)) return false;
  if (
    proof?.runId
    && process.env.GITHUB_RUN_ID
    && String(proof.runId) !== String(process.env.GITHUB_RUN_ID)
  ) return false;
  if (
    proof?.runAttempt
    && process.env.GITHUB_RUN_ATTEMPT
    && String(proof.runAttempt) !== String(process.env.GITHUB_RUN_ATTEMPT)
  ) return false;

  const previousIds = uniqueIdentities(previousJobs);
  const nextIds = uniqueIdentities(nextJobs);
  if (!previousIds || !nextIds || [...nextIds].some((identity) => !previousIds.has(identity))) {
    return false;
  }

  const removedJobs = previousJobs.filter((job) => !nextIds.has(jobIdentity(job)));
  if (
    removedJobs.length !== previousJobs.length - nextJobs.length
    || removedJobs.some((job) => !jobIdentity(job) || !hasNonEmptyJobUrl(job))
  ) {
    return false;
  }

  const provenIds = new Set();
  for (const entry of entries) {
    if (entry?.definitive !== true || !hasNonEmptyJobUrl(entry.job)) return false;
    const identity = jobIdentity(entry.job);
    if (!identity || provenIds.has(identity)) return false;
    provenIds.add(identity);
  }

  if (provenIds.size !== removedJobs.length) return false;
  return removedJobs.every((job) => provenIds.has(jobIdentity(job)));
}

/**
 * Prove the one allowlisted deletion of the retired Coop translation cache.
 *
 * Unlike URL housekeeping, this is not a collection of dead-job verdicts:
 * the entire path was a crawler scratch artifact. Keep the exception bound to
 * that exact path, company key, entry count, run sidecar and byte-for-byte
 * base/candidate snapshots so it cannot authorize another archive deletion.
 */
export function isProvenRetiredScratchArchiveDelete(filePath, previousRaw, nextRaw, proof) {
  if (normalizedPath(filePath) !== RETIRED_COOP_SCRATCH_ARCHIVE) return false;
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return false;
  if (
    typeof proof.baseRaw !== 'string'
    || typeof proof.candidateRaw !== 'string'
    || proof.baseRaw !== previousRaw
    || proof.candidateRaw !== nextRaw
    || proof.baseDigest !== sha256(previousRaw)
    || proof.candidateDigest !== sha256(nextRaw)
  ) return false;

  let previousEntries;
  let nextEntries;
  try {
    previousEntries = JSON.parse(previousRaw);
    nextEntries = JSON.parse(nextRaw);
  } catch {
    return false;
  }
  if (
    !Array.isArray(previousEntries)
    || previousEntries.length === 0
    || previousEntries.some((entry) => entry?.companyKey !== 'coop-ticino')
    || !Array.isArray(nextEntries)
    || nextEntries.length !== 0
  ) return false;

  return proof.entries?.length === 1
    && proof.entries[0]?.operation === 'retired-scratch-archive-delete'
    && proof.entries[0]?.companyKey === 'coop-ticino'
    && proof.entries[0]?.entryCount === previousEntries.length;
}

/**
 * Guard the final bytes written for a crawler slice. The semantic exception
 * is deliberately narrower than the byte guard and is shared by all writers
 * so a later merge/ownership step cannot reintroduce the false positive.
 */
export function assertCrawlerSliceWriteSafe(
  filePath,
  previousRaw,
  nextRaw,
  { dedupReferenceJobs = null, housekeepingProof = null } = {},
) {
  const previousBytes = Buffer.byteLength(String(previousRaw), 'utf8');
  const nextBytes = Buffer.byteLength(String(nextRaw), 'utf8');
  if (!isCatastrophicAccumulatorShrink(previousBytes, nextBytes)) {
    return { previousBytes, nextBytes, reason: null };
  }
  if (isSafeSwissReForeignPrune(filePath, previousRaw, nextRaw)) {
    return { previousBytes, nextBytes, reason: 'swiss-re-foreign-prune' };
  }
  if (isSafeBuehlerForeignPruneJobs(filePath, parseJobs(previousRaw), parseJobs(nextRaw))) {
    return { previousBytes, nextBytes, reason: 'buehler-foreign-prune' };
  }
  if (isProvenCrossCrawlerDedupPrune(filePath, previousRaw, nextRaw, dedupReferenceJobs)) {
    return { previousBytes, nextBytes, reason: 'proven-cross-crawler-dedup' };
  }
  if (isProvenHousekeepingPrune(filePath, previousRaw, nextRaw, housekeepingProof)) {
    return { previousBytes, nextBytes, reason: 'proven-housekeeping-prune' };
  }
  if (isProvenRetiredScratchArchiveDelete(filePath, previousRaw, nextRaw, housekeepingProof)) {
    return { previousBytes, nextBytes, reason: 'proven-retired-scratch-archive-delete' };
  }
  assertAccumulatorByteFloor(previousBytes, nextBytes, { label: filePath });
  return { previousBytes, nextBytes, reason: null };
}

// Exit codes of the CLI, read by scripts/lib/git-commit-data.sh to print an
// honest reason instead of labelling every non-zero exit a "catastrophic shrink".
export const CRAWLER_SLICE_INTEGRITY_EXIT = Object.freeze({
  ok: 0,
  catastrophicShrink: 1,
  usage: 2,
  invalidHousekeepingProof: 3,
  unreadableInput: 4,
});

export class HousekeepingProofError extends Error {}

/**
 * Load the cleanup-jobs sidecar for a slice whose staged blob is a
 * catastrophic shrink.
 *
 * The proof binds to the run (id, attempt, checked-out commit) and to the
 * slice cleanup-jobs wrote (`candidateDigest`). Its `baseDigest` is the slice
 * cleanup-jobs READ, which in a crawler run is the crawler's fresh output, not
 * any git blob: the commit helper cannot reconstruct it, so it is verified only
 * when the caller passes that exact snapshot (`basePath` other than `-`).
 * Comparing it with the checkout's git blob (#10105) failed on every crawler
 * that pruned a dead URL, catastrophic shrink or not (2026-09-28 wave:
 * belimo 35 → 34 jobs refused in group 02, one crawler per group in 02, 04,
 * 05, 06 and 11).
 *
 * @param {string} filePath
 * @param {{proofPath?: string, basePath?: string, candidatePath?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function loadHousekeepingProof(filePath, { proofPath, basePath = '-', candidatePath, env = process.env } = {}) {
  let proof;
  try {
    proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
  } catch (error) {
    throw new HousekeepingProofError(`unreadable housekeeping proof for ${filePath}: ${error?.message ?? error}`);
  }
  if (
    !proof
    || proof.schemaVersion !== 2
    || normalizedPath(proof.path) !== normalizedPath(filePath)
    || !Array.isArray(proof.entries)
  ) {
    throw new HousekeepingProofError(`invalid or path-mismatched housekeeping proof for ${filePath}`);
  }
  if (!candidatePath) {
    throw new HousekeepingProofError(`housekeeping proof for ${filePath} needs the committed candidate snapshot`);
  }
  const candidateRaw = fs.readFileSync(candidatePath, 'utf8');
  const hasBase = Boolean(basePath) && basePath !== '-';
  const baseRaw = hasBase ? fs.readFileSync(basePath, 'utf8') : null;
  if (proof.candidateDigest !== sha256(candidateRaw)) {
    throw new HousekeepingProofError(
      `stale housekeeping proof: the slice changed after cleanup-jobs wrote it (candidate digest mismatch) for ${filePath}`,
    );
  }
  if (hasBase && proof.baseDigest !== sha256(baseRaw)) {
    throw new HousekeepingProofError(`stale housekeeping proof: base digest mismatch for ${filePath}`);
  }
  const proofBaseSha = String(proof.baseSha ?? '').trim();
  const proofRunId = String(proof.runId ?? '').trim();
  const proofRunAttempt = String(proof.runAttempt ?? '').trim();
  const currentRunId = String(env.GITHUB_RUN_ID || '').trim();
  const currentRunAttempt = String(env.GITHUB_RUN_ATTEMPT || '').trim();
  const expectedBaseSha = String(env.HOUSEKEEPING_BASE_SHA || '').trim();
  if (!proofBaseSha || !proofRunId || !proofRunAttempt
    || !currentRunId || !currentRunAttempt || !expectedBaseSha) {
    throw new HousekeepingProofError(`invalid housekeeping proof: missing required run metadata for ${filePath}`);
  }
  if (proofRunId !== currentRunId) {
    throw new HousekeepingProofError(`stale housekeeping proof: run mismatch for ${filePath}`);
  }
  if (proofRunAttempt !== currentRunAttempt) {
    throw new HousekeepingProofError(`stale housekeeping proof: run attempt mismatch for ${filePath}`);
  }
  if (proofBaseSha !== expectedBaseSha) {
    throw new HousekeepingProofError(`stale housekeeping proof: base snapshot mismatch for ${filePath}`);
  }
  if (hasBase) return { ...proof, baseRaw, candidateRaw };
  const { baseDigest: _unverifiableBase, ...boundProof } = proof;
  return { ...boundProof, candidateRaw };
}

/**
 * CLI body, exported for tests. The housekeeping proof is consulted only when
 * the staged blob is a catastrophic shrink: an ordinary prune needs no proof,
 * so a stale sidecar must not turn it into a failure.
 */
export function runCrawlerSliceIntegrityCli(argv, { env = process.env, stdout = console.log, stderr = console.error } = {}) {
  const [filePath, previousPath, nextPath, housekeepingProofPath, basePath, candidatePath] = argv;
  if (!filePath || !previousPath || !nextPath) {
    stderr('usage: crawler-slice-integrity.mjs <file> <previous> <next> [housekeeping-proof] [base|-] [candidate]');
    return CRAWLER_SLICE_INTEGRITY_EXIT.usage;
  }
  let previousRaw;
  let nextRaw;
  try {
    previousRaw = fs.readFileSync(previousPath, 'utf8');
    nextRaw = fs.readFileSync(nextPath, 'utf8');
  } catch (error) {
    stderr(`crawler slice integrity: cannot read inputs for ${filePath}: ${error?.message ?? error}`);
    return CRAWLER_SLICE_INTEGRITY_EXIT.unreadableInput;
  }
  const previousBytes = Buffer.byteLength(previousRaw, 'utf8');
  const nextBytes = Buffer.byteLength(nextRaw, 'utf8');
  let housekeepingProof = null;
  if (housekeepingProofPath && isCatastrophicAccumulatorShrink(previousBytes, nextBytes)) {
    try {
      housekeepingProof = loadHousekeepingProof(filePath, {
        proofPath: housekeepingProofPath,
        basePath,
        candidatePath,
        env,
      });
    } catch (error) {
      stderr(error instanceof Error ? error.message : String(error));
      return error instanceof HousekeepingProofError
        ? CRAWLER_SLICE_INTEGRITY_EXIT.invalidHousekeepingProof
        : CRAWLER_SLICE_INTEGRITY_EXIT.unreadableInput;
    }
  }
  try {
    const result = assertCrawlerSliceWriteSafe(filePath, previousRaw, nextRaw, { housekeepingProof });
    if (result.reason) stdout(`crawler slice integrity: allowed ${result.reason} for ${filePath}`);
    return CRAWLER_SLICE_INTEGRITY_EXIT.ok;
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return CRAWLER_SLICE_INTEGRITY_EXIT.catastrophicShrink;
  }
}

function runCli() {
  process.exitCode = runCrawlerSliceIntegrityCli(process.argv.slice(2));
}

if (process.argv[1]?.endsWith('crawler-slice-integrity.mjs')) runCli();
