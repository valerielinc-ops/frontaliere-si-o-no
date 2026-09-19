import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  computeInputHash,
  JOB_DIGEST_ALGORITHM_VERSION,
  loadIncrementalManifest,
  normalizeManifestPath,
  templateVersionForKind,
} from './incrementalManifest.mjs';

export const JOBS_SEO_REUSE_ENV = 'JOBS_SEO_REUSE';
export const JOBS_SEO_REUSE_VERIFY_ENV = 'JOBS_SEO_REUSE_VERIFY';
export const JOBS_SEO_REUSE_VERIFY_SAMPLE_ENV = 'JOBS_SEO_REUSE_VERIFY_SAMPLE';
// Output-validated fingerprint (opt-in). When only the emitter fingerprint of
// the render source graph changed, render a deterministic stratified sample of
// otherwise reusable pages and compare it with the cached HTML before deciding
// whether the block may keep reusing. See `JobsSeoHtmlReuse.lookup()`.
export const JOBS_SEO_REUSE_PROBE_ENV = 'JOBS_SEO_REUSE_PROBE';
export const JOBS_SEO_REUSE_PROBE_RATE_ENV = 'JOBS_SEO_REUSE_PROBE_RATE';
export const JOBS_SEO_REUSE_PROBE_MIN_ENV = 'JOBS_SEO_REUSE_PROBE_MIN';
export const JOBS_SEO_REUSE_PROBE_MAX_ENV = 'JOBS_SEO_REUSE_PROBE_MAX';
export const JOBS_SEO_REUSE_PROBE_PER_STRATUM_ENV = 'JOBS_SEO_REUSE_PROBE_PER_STRATUM';
export const JOBS_SEO_REUSE_PROBE_DEFAULTS = Object.freeze({
  rate: 0.015,
  min: 200,
  max: 5000,
  perStratum: 3,
});
const JOBS_SEO_REUSE_PROBE_VERSION = 2;
// Identity of THIS build process. The verdict sidecar lives in the same cache
// directory that CI restores between builds, so a file restored (or left over)
// from another build could otherwise vouch for a fingerprint change that this
// build never probed. Only the process that wrote the sidecar can read it back
// as valid; anything else — another build, a restored cache, a second process —
// fails closed on the historical full invalidation.
export const JOBS_SEO_REUSE_PROBE_BUILD_ID = randomBytes(16).toString('hex');
export const JOBS_SEO_REUSE_BLOCKS = Object.freeze([
  'active',
  'expired-soft-landing',
  'previous-slug-legacy',
  'cross-locale-reconciliation',
]);

const MAX_MISMATCH_LOGS = 20;
const MAX_VERIFY_DIAGNOSTICS = 20;
const MISMATCH_CONTEXT_RADIUS = 60;
export const JOBS_SEO_EMITTER_KINDS = Object.freeze([
  'active-job',
  'expired-soft-landing',
  'legacy-slug-bridge',
  'previous-slugs-full-content',
  'cross-locale-reconciliation',
]);

const JOBS_SEO_RENDER_ENTRY = 'build-plugins/jobsSeoPagesPlugin.ts';
// This module owns cache persistence only. Changes here must not invalidate
// already-rendered HTML by changing the emitter fingerprint.
const JOBS_SEO_REUSE_STORAGE_MODULE = 'build-plugins/shared/incrementalHtmlReuse.mjs';
export const JOBS_SEO_HTML_PACK_VERSION = 'pack@1';
const JOBS_SEO_HTML_PACK_FORMAT = 'frontaliere-jobs-seo-html-pack';
const JOBS_SEO_HTML_INDEX_FORMAT = 'frontaliere-jobs-seo-html-index';
const PACK_HEADER_READ_BYTES = 4096;
const KIND_TO_REUSE_BLOCK = Object.freeze({
  'active-job': 'active',
  'expired-soft-landing': 'expired-soft-landing',
  'legacy-slug-bridge': 'previous-slug-legacy',
  'previous-slugs-full-content': 'previous-slug-legacy',
  'cross-locale-reconciliation': 'cross-locale-reconciliation',
});
const JOBS_SEO_ASSET_MANIFEST_FILES = Object.freeze([
  // These files are the stable-name contract or external assets referenced by
  // one of the reusable job-page HTML variants. The renderer source graph
  // covers the HTML builders and inline fragments below; this list is only
  // the asset-side dependency surface visible from the emitted HTML.
  'build-plugins/shared/spaEntryFilenames.ts',
  'index.css',
  'vite.config.ts',
  'public/assets/seo-static.css',
  'public/assets/bridge.css',
  'public/assets/logo.svg',
  'public/favicon.ico',
  'public/favicon.svg',
]);
const SOURCE_MODULE_EXTENSIONS = Object.freeze(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
// Static `import … from` / `export … from` statements. The statement must
// start a line (or follow a `;`): a quoted `import … from '@/…'` inside a
// comment is documentation, not a dependency, and used to drag the whole SPA
// JobBoard graph into the fingerprint. The clause `[^;'"]*?` cannot cross a
// quote, so one match never spans two statements and the `type` modifier is
// attributed to the statement it belongs to.
const STATIC_FROM_RE = /(?:^|;)[ \t]*(?:import|export)\b([^;'"]*?)\bfrom\s*['"]([^'"]+)['"]/gm;
const SIDE_EFFECT_IMPORT_RE = /(?:^|;)[ \t]*import\s*['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
// `import type` / `export type` are erased by TypeScript and esbuild in every
// configuration, so the module they name never executes at render time.
// Type-only imports of SPA components (e.g. `import type { JobListing } from
// '../components/community/JobBoard'`) were the path by which ~300 SPA and
// locale modules entered the render graph. Mixed `import { type A, b }` keeps
// the edge: only the whole-statement modifier is proof of erasure.
const TYPE_ONLY_CLAUSE_RE = /^\s*type\s+(?!from\b)[{*\w$]/;

// Modules reachable from the renderer that provably cannot change a job page's
// HTML, pruned from the render graph together with their own imports. Each
// entry names the only importers allowed to reach it: if any other module of
// the render graph imports it, the module is hashed again (fail-closed), so a
// new consumer cannot silently depend on data the fingerprint ignores.
// Changing one of the listed importers still changes the fingerprint, because
// the importer itself stays in the graph.
export const JOBS_SEO_FINGERPRINT_INERT_MODULES = Object.freeze({
  // Nightly-refreshed wait averages. borderCrossings.ts copies them onto the
  // morning/evening average fields; the job renderer reaches borderCrossings
  // only through the job location snapshot service, which ranks crossings by
  // position and static metadata and never reads the averages.
  'data/border-wait-averages.json': Object.freeze(['data/borderCrossings.ts']),
  // Crawler-time machine-translation cascade. events-utils.mjs uses it only as
  // the default translator of the event crawlers; the job renderer imports
  // dataset and listing helpers from it, none of which translates.
  'scripts/lib/free-translate.mjs': Object.freeze(['scripts/lib/events-utils.mjs']),
  // Deploy I/O and telemetry. On 2026-09-16..19 these files, edited for build
  // speed and memory, invalidated every reusable job page without touching a
  // byte of HTML. Each one receives or measures HTML that is already built:
  //
  // WriteCollector queues the exact string passed to add() and writes it
  // unchanged. What it decides is WHETHER to write (content-hash skip, locale
  // emit filter, collision claim), never WHAT. Its private imports go with it:
  // contentHash.ts (skip manifest) and postWalkDerivedDigest.ts (post-walk
  // digest of files already written).
  'build-plugins/batchWrite.ts': Object.freeze([
    'build-plugins/employerProfilePagesPlugin.ts',
    'build-plugins/jobsSeoPagesPlugin.ts',
  ]),
  // Path-collision registry: claim() either accepts the write or throws; the
  // renderer reads only getPathHistory().size for a memory log line.
  'build-plugins/sharedWriteRegistry.ts': Object.freeze([
    'build-plugins/batchWrite.ts',
    'build-plugins/jobsSeoPagesPlugin.ts',
    'build-plugins/shared/postWalkDerivedDigest.ts',
  ]),
  // `[mem]` log line; returns only the MB freed by the forced GC.
  'build-plugins/shared/buildMemLog.ts': Object.freeze([
    'build-plugins/employerProfilePagesPlugin.ts',
    'build-plugins/jobsSeoPagesPlugin.ts',
    'build-plugins/shared/jobsSeoRetentionProbe.ts',
  ]),
  // global.gc() wrapper: collects garbage, returns whether it ran.
  'build-plugins/shared/forceGc.ts': Object.freeze([
    'build-plugins/jobsSeoPagesPlugin.ts',
    'build-plugins/shared/buildMemLog.ts',
  ]),
  // hrtime counters and the timing summary; the renderer imports no
  // pass-through wrapper (`timed`) from it, only start/record/print.
  'build-plugins/shared/jobsSeoProfiler.ts': Object.freeze(['build-plugins/jobsSeoPagesPlugin.ts']),
  // Incremental manifest I/O and the reuse digest (buildMinimalJobInput,
  // computeInputHash). The renderer uses it to build the manifest input next
  // to each page, never to build the page. The only render-time helper it
  // had, stableJobId (a memo key), lives in stableJobId.mjs and stays hashed;
  // templateVersionForKind and JOB_DIGEST_ALGORITHM_VERSION are hashed by
  // value in computeJobsSeoEmitterFingerprints. A digest change needs no
  // fingerprint: pages whose input hash moves are simply not reused.
  'build-plugins/shared/incrementalManifest.mjs': Object.freeze([
    'build-plugins/jobsSeoPagesPlugin.ts',
    'build-plugins/shared/incrementalHtmlReuse.mjs',
  ]),
});

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sourceModuleCandidates(file) {
  const extension = path.extname(file);
  if (extension) return [file];
  return [
    file,
    ...SOURCE_MODULE_EXTENSIONS.map((candidateExtension) => `${file}${candidateExtension}`),
    ...SOURCE_MODULE_EXTENSIONS.map((candidateExtension) => path.join(file, `index${candidateExtension}`)),
  ];
}

function resolveSourceModule(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const resolved = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of sourceModuleCandidates(resolved)) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.resolve(candidate);
    }
  }
  return null;
}

function resolveGraphSpecifier(fromFile, specifier, rootDir) {
  if (specifier.startsWith('.')) return resolveSourceModule(fromFile, specifier);
  // Vite's application entry uses the repository-root `@/` alias.
  if (specifier.startsWith('@/')) {
    return resolveSourceModule(path.join(rootDir, 'index.tsx'), `./${specifier.slice(2)}`);
  }
  return null;
}

// Blanks block and line comments (keeping newlines, so line anchors survive).
// Deliberately naive: a `/*` or `//` inside a string or regex literal can blank
// real code, so the stripped text is only ever scanned IN ADDITION to the raw
// text — it can add edges (`/* c */ import …`, `import /* c */ x from …`),
// never remove one the raw scan found.
function blankComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (comment) => ' '.repeat(comment.length));
}

function collectImportSpecifiers(text, specifiers) {
  STATIC_FROM_RE.lastIndex = 0;
  for (const match of text.matchAll(STATIC_FROM_RE)) {
    if (TYPE_ONLY_CLAUSE_RE.test(match[1])) continue;
    specifiers.add(match[2]);
  }
  for (const pattern of [SIDE_EFFECT_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) specifiers.add(match[1]);
  }
}

export function importedSourceModules(source, fromFile, rootDir) {
  const specifiers = new Set();
  // Union of the raw and comment-blanked scans: the raw scan keeps every
  // line-start import even if blanking misfires on a string; the blanked scan
  // catches imports that follow or contain a comment. A commented-out import
  // only enters through the raw scan when it starts its own line, which errs
  // on the side of invalidating.
  collectImportSpecifiers(source, specifiers);
  collectImportSpecifiers(blankComments(source), specifiers);
  return [...specifiers]
    .map((specifier) => resolveGraphSpecifier(fromFile, specifier, rootDir))
    .filter(Boolean);
}

function walkSourceGraph(rootDir, entryFiles, prunedFiles = new Set()) {
  const queue = entryFiles.map((file) => path.resolve(rootDir, file));
  const files = new Set();
  const importers = new Map();
  for (let index = 0; index < queue.length; index += 1) {
    const file = queue[index];
    if (!file || files.has(file) || prunedFiles.has(file) || !fs.existsSync(file)) continue;
    files.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const imported of importedSourceModules(source, file, rootDir)) {
      if (!importers.has(imported)) importers.set(imported, new Set());
      importers.get(imported).add(file);
      if (!files.has(imported)) queue.push(imported);
    }
  }
  return { files, importers };
}

export function collectSourceModuleFiles(rootDir, entryFiles, inertModules = {}) {
  const toRelative = (file) => path.relative(rootDir, file).replaceAll(path.sep, '/');
  const full = walkSourceGraph(rootDir, entryFiles);
  const pruned = new Set();
  const inertFiles = new Set(Object.keys(inertModules).map((relativeFile) => path.resolve(rootDir, relativeFile)));
  for (const [relativeFile, allowedImporters] of Object.entries(inertModules)) {
    const file = path.resolve(rootDir, relativeFile);
    if (!full.files.has(file)) continue;
    const allowed = new Set(allowedImporters);
    const actual = [...(full.importers.get(file) || [])].map(toRelative);
    if (actual.length > 0 && actual.every((importer) => allowed.has(importer))) pruned.add(file);
  }
  // An allowlisted importer that is itself inert vouches for its import only
  // while it stays pruned. If an unlisted consumer pulls it back into the
  // render graph (e.g. a template importing batchWrite.ts), what it imports
  // (sharedWriteRegistry.ts) is a render input again: un-prune to a fixpoint.
  for (let changed = true; changed;) {
    changed = false;
    for (const file of pruned) {
      const importers = full.importers.get(file) || new Set();
      if ([...importers].some((importer) => inertFiles.has(importer) && !pruned.has(importer))) {
        pruned.delete(file);
        changed = true;
      }
    }
  }
  const { files } = pruned.size > 0 ? walkSourceGraph(rootDir, entryFiles, pruned) : full;
  return [...files].map(toRelative).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function hashSourceModuleFiles(
  rootDir,
  entryFiles,
  inertModules = {},
  excludedRelativePaths = new Set(),
) {
  const records = collectSourceModuleFiles(rootDir, entryFiles, inertModules)
    .filter((relativeFile) => !excludedRelativePaths.has(relativeFile))
    .map((relativeFile) => ({
    path: relativeFile,
    hash: sha256File(path.resolve(rootDir, relativeFile)),
    }));
  return sha256(JSON.stringify(records));
}

function hashStaticShellAssetManifest(rootDir) {
  // Vite deliberately pins the job-page entry names and does not emit a
  // manifest.json. closeBundle can also run before dist/assets is durable, so
  // hash the source-of-truth asset manifest instead of racing the output
  // directory. The SPA source graph and staticScriptsPlugin source graph are
  // intentionally absent: both produce external files with stable URLs, and
  // neither graph is serialized into the job HTML. HTML builders and inline
  // fragments remain covered by codeHash below. Vite keeps the HTML-facing
  // `/assets/index-entry.js`, `/assets/index.css`, and static-script names
  // stable; its content-hashed non-CSS assets are not serialized in job HTML.
  // staticScriptsPlugin emits no inline payload, so there is no SPA-derived
  // inline fragment to hash separately and no asset-reference rewrite needed.
  const records = JOBS_SEO_ASSET_MANIFEST_FILES.map((relativeFile) => {
    const file = path.resolve(rootDir, relativeFile);
    if (!fs.existsSync(file)) throw new Error(`Jobs SEO asset fingerprint file missing: ${relativeFile}`);
    return { path: relativeFile, hash: sha256File(file) };
  });
  return sha256(JSON.stringify(records));
}

export function computeJobsSeoEmitterFingerprints(rootDir) {
  const codeHash = hashSourceModuleFiles(
    rootDir,
    [JOBS_SEO_RENDER_ENTRY],
    JOBS_SEO_FINGERPRINT_INERT_MODULES,
    new Set([JOBS_SEO_REUSE_STORAGE_MODULE]),
  );
  const assetManifestHash = hashStaticShellAssetManifest(rootDir);
  const renderFlags = {
    STRIP_ACTIVE_JOB_PROSE: process.env.STRIP_ACTIVE_JOB_PROSE ?? '1',
    STRIP_EXPIRED_JOB_PROSE: process.env.STRIP_EXPIRED_JOB_PROSE ?? '1',
    JOBS_SEO_SKIP_MINIFY: process.env.JOBS_SEO_SKIP_MINIFY === '1',
    INFEED_AD_EXPERIMENT_ACTIVE: process.env.KILL_JOBLIST_INFEED_EXPERIMENT?.trim().toLowerCase() !== 'true',
    ASSET_CDN: (process.env.ASSET_CDN || '').trim().replace(/\/+$/, ''),
    FAST_BUILD: Boolean(process.env.FAST_BUILD),
  };
  return Object.fromEntries(JOBS_SEO_EMITTER_KINDS.map((kind) => [
    kind,
    sha256(JSON.stringify({
      kind,
      templateVersion: templateVersionForKind(kind),
      jobDigestAlgorithm: JOB_DIGEST_ALGORITHM_VERSION,
      codeHash,
      assetManifestHash,
      renderFlags,
    })),
  ]));
}

function safeLocale(locale) {
  const value = String(locale || '').trim();
  if (!value || !/^[a-z0-9_-]+$/i.test(value)) {
    throw new Error(`Invalid jobs SEO reuse locale: ${locale}`);
  }
  return value;
}

function parseVerifySample(rawValue) {
  if (rawValue === undefined || String(rawValue).trim() === '') return 1;
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${JOBS_SEO_REUSE_VERIFY_SAMPLE_ENV} must be a number between 0 and 1`);
  }
  return value;
}

function verifySampleIncludes(locale, block, pagePath, sample) {
  if (sample >= 1) return true;
  if (sample <= 0) return false;
  const digest = createHash('sha256')
    .update(`${locale}\0${block}\0${pagePath}`, 'utf8')
    .digest();
  return digest.readUInt32BE(0) / 0x100000000 < sample;
}

function parseProbeNumber(name, fallback, { integer = false, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be ${integer ? 'a non-negative integer' : 'a non-negative number'}${Number.isFinite(max) ? ` <= ${max}` : ''}`);
  }
  return value;
}

export function parseJobsSeoReuseProbeConfig() {
  if (process.env[JOBS_SEO_REUSE_PROBE_ENV] !== '1') return null;
  const config = {
    rate: parseProbeNumber(JOBS_SEO_REUSE_PROBE_RATE_ENV, JOBS_SEO_REUSE_PROBE_DEFAULTS.rate, { max: 1 }),
    min: parseProbeNumber(JOBS_SEO_REUSE_PROBE_MIN_ENV, JOBS_SEO_REUSE_PROBE_DEFAULTS.min, { integer: true }),
    max: parseProbeNumber(JOBS_SEO_REUSE_PROBE_MAX_ENV, JOBS_SEO_REUSE_PROBE_DEFAULTS.max, { integer: true }),
    perStratum: parseProbeNumber(
      JOBS_SEO_REUSE_PROBE_PER_STRATUM_ENV,
      JOBS_SEO_REUSE_PROBE_DEFAULTS.perStratum,
      { integer: true },
    ),
  };
  if (config.max < config.min) config.max = config.min;
  if (config.perStratum < 1) config.perStratum = 1;
  return config;
}

/** Probe target for one block: rate of the previous block size, clamped. */
export function jobsSeoReuseProbeTarget(blockSize, config) {
  const size = Math.max(0, Number(blockSize) || 0);
  const wanted = Math.min(config.max, Math.max(config.min, Math.ceil(size * config.rate)));
  return Math.min(size, wanted);
}

// String fields whose value (not only presence) selects a different template
// branch. Everything else is reduced to presence/cardinality so the number of
// strata stays small (tens, not thousands).
const PROBE_SHAPE_VALUE_KEYS = new Set(['action', 'bridgeType', 'baseLocale', 'locale', 'kind']);

function probeCardinality(length) {
  if (length <= 0) return '0';
  if (length === 1) return '1';
  if (length <= 3) return '2-3';
  return '4+';
}

function probeValueShape(key, value) {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'boolean') return value ? 'T' : 'F';
  if (typeof value === 'number') return 'n';
  if (typeof value === 'string') {
    if (value.length === 0) return 'e';
    return PROBE_SHAPE_VALUE_KEYS.has(key) ? `=${value}` : 's';
  }
  if (Array.isArray(value)) return `a${probeCardinality(value.length)}`;
  if (typeof value === 'object') return `o${probeCardinality(Object.keys(value).length)}`;
  return typeof value;
}

function hasText(value) {
  if (Array.isArray(value)) return value.some(hasText);
  if (value && typeof value === 'object') return Object.values(value).some(hasText);
  return value !== null && value !== undefined && String(value).trim() !== '';
}

/**
 * Optional page-shape hints from the source job record. The manifest input is
 * a digest, so optional render branches (salary block, company logo, multiple
 * locations, requirements list, …) are not visible from it; the call sites of
 * the heavy page kinds pass these hints so every shape is sampled.
 */
export function jobsSeoProbeShapeHints(job) {
  if (!job || typeof job !== 'object') return null;
  const location = String(job.location ?? '');
  return {
    salary: hasText(job.salaryMin) || hasText(job.salaryMax),
    logo: hasText(job.companyDomain) || hasText(job.companyLogo) || hasText(job.logo),
    multiLocation: /[,;/|]|\s(?:e|and|und|et)\s/i.test(location),
    requirements: hasText(job.requirements) || hasText(job.requirementsByLocale),
    contract: hasText(job.contract) || hasText(job.employmentType),
    street: hasText(job.streetAddress),
    previousSlugs: hasText(job.previousSlugs),
    description: hasText(job.description),
  };
}

/** Stratum of one page: kind × locale × shape of the input and the hints. */
export function jobsSeoProbeStratum(kind, locale, input, hints = null) {
  const parts = [String(kind), String(locale)];
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const key of Object.keys(input).sort()) {
      parts.push(`${key}:${probeValueShape(key, input[key])}`);
    }
  }
  if (hints && typeof hints === 'object') {
    for (const key of Object.keys(hints).sort()) {
      parts.push(`h.${key}:${hints[key] ? 1 : 0}`);
    }
  }
  return parts.join('|');
}

function newProbeState(target) {
  return {
    state: 'pending',
    reason: null,
    target,
    eligible: 0,
    sampled: 0,
    identical: 0,
    differing: 0,
    unavailable: 0,
    reused: 0,
    reusedBeforeInvalidate: 0,
    wallMs: 0,
    strata: new Map(),
  };
}

/** Drop any verdict left by another build before this one can consult it. */
export function discardJobsSeoReuseProbeVerdicts(rootDir, locales) {
  for (const locale of locales) {
    try {
      fs.rmSync(jobsSeoReuseProbePath(rootDir, locale), { force: true });
    } catch (error) {
      console.warn(
        `[jobs-seo-reuse-probe] verdict-discard-failed locale=${locale}`
        + ` reason=${error?.message || error}`,
      );
    }
  }
}

export function jobsSeoReuseProbePath(rootDir, locale) {
  const cacheRoot = configuredPath(
    rootDir,
    process.env.JOBS_SEO_REUSE_HTML_CACHE_DIR,
    path.join(rootDir, '.cache', 'incremental-html'),
  );
  return path.join(cacheRoot, `probe-${safeLocale(locale)}.json`);
}

function stableFingerprintJson(value) {
  if (!value || typeof value !== 'object') return 'null';
  return JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  ));
}

/**
 * Post-walk side of the probe. A changed emitter fingerprint normally makes
 * the whole post-walk delta unusable. It stays usable when, for every locale,
 * the jobs SEO probe of THIS build proved that each block whose kinds changed
 * fingerprint renders byte-identical HTML (verdict `inherit`). The sidecar is
 * bound to the exact previous/current fingerprints, so a stale file from an
 * older build can never vouch for a different change.
 */
export function jobsSeoProbeInheritsEmitterChange(rootDir, locales, previousFingerprint, currentFingerprint) {
  if (process.env[JOBS_SEO_REUSE_PROBE_ENV] !== '1') return { inherit: false, reason: 'probe-disabled' };
  if (!previousFingerprint || !currentFingerprint) return { inherit: false, reason: 'fingerprint-missing' };
  const kinds = new Set([...Object.keys(previousFingerprint), ...Object.keys(currentFingerprint)]);
  const changedKinds = [...kinds].filter((kind) => previousFingerprint[kind] !== currentFingerprint[kind]);
  if (changedKinds.length === 0) return { inherit: true, reason: 'unchanged' };
  const changedBlocks = new Set();
  for (const kind of changedKinds) {
    const block = KIND_TO_REUSE_BLOCK[kind];
    if (!block || !previousFingerprint[kind] || !currentFingerprint[kind]) {
      return { inherit: false, reason: `kind-not-probed:${kind}` };
    }
    changedBlocks.add(block);
  }
  for (const locale of locales) {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(jobsSeoReuseProbePath(rootDir, locale), 'utf8'));
    } catch {
      return { inherit: false, reason: `probe-verdict-missing:${locale}` };
    }
    if (record?.buildId !== JOBS_SEO_REUSE_PROBE_BUILD_ID) {
      return { inherit: false, reason: `probe-verdict-foreign-build:${locale}` };
    }
    if (
      record?.version !== JOBS_SEO_REUSE_PROBE_VERSION
      || stableFingerprintJson(record.previousFingerprint) !== stableFingerprintJson(previousFingerprint)
      || stableFingerprintJson(record.currentFingerprint) !== stableFingerprintJson(currentFingerprint)
    ) {
      return { inherit: false, reason: `probe-verdict-stale:${locale}` };
    }
    for (const block of changedBlocks) {
      const verdict = record.blocks?.[block]?.verdict;
      if (verdict !== 'inherit') {
        return { inherit: false, reason: `probe-${verdict || 'missing'}:${locale}:${block}` };
      }
    }
  }
  return { inherit: true, reason: `probe-inherit:${[...changedBlocks].sort().join(',')}` };
}

function configuredPath(rootDir, value, fallback) {
  if (!value) return fallback;
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

function previousManifestPath(rootDir, locale) {
  const configured = process.env.JOBS_SEO_REUSE_MANIFEST_PREVIOUS;
  if (configured) return configuredPath(rootDir, configured.replaceAll('{locale}', locale), configured);
  return path.join(rootDir, '.cache', 'incremental-manifest-prev', `${locale}.jsonl`);
}

function safeReuseBlock(block) {
  const value = String(block || '').trim();
  if (!JOBS_SEO_REUSE_BLOCKS.includes(value)) {
    throw new Error(`Invalid jobs SEO reuse block: ${block}`);
  }
  return value;
}

function cacheFileName(pagePath, kind = 'legacy', inputHash = 'legacy') {
  const normalized = normalizeManifestPath(pagePath);
  // The manifest is path-keyed, but one build can transiently render multiple
  // variants for that path (for example an expired bridge before an active
  // bridge wins). Key the disk entry by the complete render contract so a
  // later writer cannot make verify compare the wrong HTML.
  return `v2-${sha256(JSON.stringify([normalized, String(kind), String(inputHash)]))}.html`;
}

/**
 * Legacy one-file path retained only for a one-deploy migration from the old
 * cache layout. New entries are written to the locale/block pack below.
 */
export function htmlReuseCachePath(
  rootDir,
  locale,
  pagePath,
  cacheRoot = null,
  kind = 'legacy',
  inputHash = 'legacy',
) {
  const root = cacheRoot || path.join(rootDir, '.cache', 'incremental-html');
  return path.join(root, safeLocale(locale), cacheFileName(pagePath, kind, inputHash));
}

export function htmlReusePackPath(rootDir, locale, block, cacheRoot = null) {
  const root = cacheRoot || path.join(rootDir, '.cache', 'incremental-html');
  return path.join(root, safeLocale(locale), `${safeReuseBlock(block)}.pack`);
}

export function htmlReusePackIndexPath(rootDir, locale, block, cacheRoot = null) {
  const root = cacheRoot || path.join(rootDir, '.cache', 'incremental-html');
  return path.join(root, safeLocale(locale), `${safeReuseBlock(block)}.idx`);
}

function reusePackHeader(block, generation) {
  return `${JSON.stringify({
    format: JOBS_SEO_HTML_PACK_FORMAT,
    version: JOBS_SEO_HTML_PACK_VERSION,
    block,
    generation,
  })}\n`;
}

function reuseIndexHeader(block, generation) {
  return `${JSON.stringify({
    format: JOBS_SEO_HTML_INDEX_FORMAT,
    version: JOBS_SEO_HTML_PACK_VERSION,
    block,
    generation,
  })}\n`;
}

function newPackGeneration() {
  return randomBytes(16).toString('hex');
}

function writePackBytes(fd, buffer) {
  let written = 0;
  while (written < buffer.length) {
    const count = fs.writeSync(fd, buffer, written, buffer.length - written, null);
    if (!count) throw new Error('zero-byte write in jobs SEO HTML pack');
    written += count;
  }
}

function readFirstLine(fd) {
  const buffer = Buffer.allocUnsafe(PACK_HEADER_READ_BYTES);
  const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
  const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
  if (newline < 0) throw new Error('jobs SEO HTML pack header truncated');
  return {
    line: buffer.subarray(0, newline).toString('utf8'),
    length: newline + 1,
  };
}

function readLines(file, onLine) {
  const fd = fs.openSync(file, 'r');
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let carry = '';
  let lineNumber = 0;
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      carry += decoder.write(buffer.subarray(0, bytesRead));
      let newline;
      while ((newline = carry.indexOf('\n')) !== -1) {
        lineNumber += 1;
        onLine(carry.slice(0, newline), lineNumber);
        carry = carry.slice(newline + 1);
      }
    }
    carry += decoder.end();
    if (carry.length > 0) throw new Error(`${file}:${lineNumber + 1}: indice troncato`);
  } finally {
    fs.closeSync(fd);
  }
}

function packEntryKeyIsValid(key) {
  return /^v2-[0-9a-f]{64}\.html$/u.test(key);
}

class JobsSeoHtmlPackStore {
  constructor(rootDir, locale, block, cacheRoot) {
    this.locale = safeLocale(locale);
    this.block = safeReuseBlock(block);
    this.cacheRoot = cacheRoot;
    this.packPath = htmlReusePackPath(rootDir, this.locale, this.block, cacheRoot);
    this.indexPath = htmlReusePackIndexPath(rootDir, this.locale, this.block, cacheRoot);
    this.entries = new Map();
    this.packFd = null;
    this.appendPackFd = null;
    this.appendIndexFd = null;
    this.loaded = false;
    this.valid = false;
    this.packSize = 0;
    this.headerLength = 0;
    this.liveBytes = 0;
    this.generation = null;
  }

  close() {
    for (const field of ['packFd', 'appendPackFd', 'appendIndexFd']) {
      const fd = this[field];
      if (fd === null) continue;
      try {
        fs.closeSync(fd);
      } catch {
        // Cache file descriptors are best-effort and never affect rendering.
      }
      this[field] = null;
    }
  }

  invalidate() {
    this.close();
    this.entries.clear();
    this.loaded = false;
    this.valid = false;
    this.packSize = 0;
    this.headerLength = 0;
    this.liveBytes = 0;
    this.generation = null;
  }

  load() {
    if (this.loaded) return this.valid;
    this.loaded = true;
    this.valid = false;
    this.entries.clear();
    this.liveBytes = 0;
    let packFd = null;
    try {
      packFd = fs.openSync(this.packPath, 'r');
      const packHeader = readFirstLine(packFd);
      const parsedPackHeader = JSON.parse(packHeader.line);
      if (
        parsedPackHeader.format !== JOBS_SEO_HTML_PACK_FORMAT
        || parsedPackHeader.version !== JOBS_SEO_HTML_PACK_VERSION
        || parsedPackHeader.block !== this.block
        || typeof parsedPackHeader.generation !== 'string'
        || !/^[0-9a-f]{32}$/u.test(parsedPackHeader.generation)
      ) {
        throw new Error('jobs SEO HTML pack version/header non riconosciuto');
      }
      const packSize = fs.fstatSync(packFd).size;
      if (packSize < packHeader.length) throw new Error('jobs SEO HTML pack troncato');
      fs.closeSync(packFd);
      packFd = null;

      let indexHeader = null;
      readLines(this.indexPath, (line, lineNumber) => {
        if (lineNumber === 1) {
          indexHeader = JSON.parse(line);
          if (
            indexHeader.format !== JOBS_SEO_HTML_INDEX_FORMAT
            || indexHeader.version !== JOBS_SEO_HTML_PACK_VERSION
            || indexHeader.block !== this.block
            || indexHeader.generation !== parsedPackHeader.generation
          ) {
            throw new Error('indice jobs SEO HTML non compatibile con il pack');
          }
          return;
        }
        if (!indexHeader) throw new Error('header indice jobs SEO HTML mancante');
        const fields = line.split('\t');
        if (fields.length !== 3 || !packEntryKeyIsValid(fields[0])) {
          throw new Error(`indice jobs SEO HTML non valido alla riga ${lineNumber}`);
        }
        const offset = Number(fields[1]);
        const length = Number(fields[2]);
        if (
          !Number.isSafeInteger(offset)
          || !Number.isSafeInteger(length)
          || offset < packHeader.length
          || length <= 0
          || offset + length > packSize
        ) {
          throw new Error(`entry jobs SEO HTML troncata alla riga ${lineNumber}`);
        }
        this.entries.set(fields[0], { offset, length });
      });
      if (!indexHeader) throw new Error('header indice jobs SEO HTML mancante');
      for (const entry of this.entries.values()) this.liveBytes += entry.length;
      this.packSize = packSize;
      this.headerLength = packHeader.length;
      this.generation = parsedPackHeader.generation;
      this.packFd = fs.openSync(this.packPath, 'r');
      this.valid = true;
      return true;
    } catch {
      if (packFd !== null) {
        try {
          fs.closeSync(packFd);
        } catch {
          // Ignore a descriptor that failed while loading a corrupt cache.
        }
      }
      this.entries.clear();
      this.liveBytes = 0;
      this.packSize = 0;
      this.headerLength = 0;
      this.generation = null;
      return false;
    }
  }

  readEntryBuffer(entry) {
    if (this.packFd === null || !entry) return null;
    const buffer = Buffer.allocUnsafe(entry.length);
    let read = 0;
    while (read < entry.length) {
      const count = fs.readSync(
        this.packFd,
        buffer,
        read,
        entry.length - read,
        entry.offset + read,
      );
      if (!count) return null;
      read += count;
    }
    return buffer;
  }

  read(key) {
    if (!this.load()) return null;
    const entry = this.entries.get(key);
    if (!entry) return null;
    try {
      const buffer = this.readEntryBuffer(entry);
      return buffer && buffer.length > 0 ? buffer.toString('utf8') : null;
    } catch {
      return null;
    }
  }

  has(key) {
    return this.load() && this.entries.has(key);
  }

  writeIndex(file, generation, entries) {
    const fd = fs.openSync(file, 'w');
    try {
      writePackBytes(fd, Buffer.from(reuseIndexHeader(this.block, generation), 'utf8'));
      for (const [key, entry] of entries) {
        writePackBytes(fd, Buffer.from(`${key}\t${entry.offset}\t${entry.length}\n`, 'utf8'));
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  initializeFresh() {
    this.close();
    fs.mkdirSync(path.dirname(this.packPath), { recursive: true });
    const generation = newPackGeneration();
    const stamp = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
    const packTemp = `${this.packPath}.${stamp}.tmp`;
    const indexTemp = `${this.indexPath}.${stamp}.tmp`;
    let packFd = null;
    try {
      packFd = fs.openSync(packTemp, 'w');
      const packHeader = reusePackHeader(this.block, generation);
      writePackBytes(packFd, Buffer.from(packHeader, 'utf8'));
      fs.closeSync(packFd);
      packFd = null;
      this.writeIndex(indexTemp, generation, new Map());
      fs.renameSync(packTemp, this.packPath);
      fs.renameSync(indexTemp, this.indexPath);
      this.entries.clear();
      this.loaded = true;
      this.valid = true;
      this.packSize = Buffer.byteLength(packHeader, 'utf8');
      this.headerLength = this.packSize;
      this.liveBytes = 0;
      this.generation = generation;
      this.packFd = fs.openSync(this.packPath, 'r');
    } finally {
      if (packFd !== null) fs.closeSync(packFd);
      for (const temp of [packTemp, indexTemp]) {
        if (fs.existsSync(temp)) {
          try {
            fs.unlinkSync(temp);
          } catch {
            // Best-effort cleanup; the next cache write can use a new temp name.
          }
        }
      }
    }
  }

  append(key, html) {
    if (!this.load()) this.initializeFresh();
    if (!this.valid) return false;
    const bytes = Buffer.from(String(html), 'utf8');
    if (bytes.length === 0) return false;
    const previous = this.entries.get(key);
    const offset = this.packSize;
    try {
      if (this.appendPackFd === null) this.appendPackFd = fs.openSync(this.packPath, 'a');
      writePackBytes(this.appendPackFd, bytes);
      this.packSize = offset + bytes.length;
      if (this.appendIndexFd === null) this.appendIndexFd = fs.openSync(this.indexPath, 'a');
      writePackBytes(this.appendIndexFd, Buffer.from(`${key}\t${offset}\t${bytes.length}\n`, 'utf8'));
    } catch (error) {
      this.invalidate();
      throw error;
    }
    this.entries.set(key, { offset, length: bytes.length });
    this.liveBytes += bytes.length - (previous?.length || 0);
    return true;
  }

  rewriteIndex() {
    const stamp = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
    const temp = `${this.indexPath}.${stamp}.tmp`;
    try {
      if (this.appendIndexFd !== null) {
        fs.closeSync(this.appendIndexFd);
        this.appendIndexFd = null;
      }
      this.writeIndex(temp, this.generation, this.entries);
      fs.renameSync(temp, this.indexPath);
    } finally {
      if (fs.existsSync(temp)) {
        try {
          fs.unlinkSync(temp);
        } catch {
          // Best-effort cleanup for a cache-only artifact.
        }
      }
    }
  }

  compact() {
    if (!this.load()) return false;
    const generation = newPackGeneration();
    const stamp = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
    const packTemp = `${this.packPath}.${stamp}.tmp`;
    const indexTemp = `${this.indexPath}.${stamp}.tmp`;
    const nextEntries = new Map();
    let packFd = null;
    let nextPackSize = 0;
    try {
      packFd = fs.openSync(packTemp, 'w');
      const packHeader = reusePackHeader(this.block, generation);
      writePackBytes(packFd, Buffer.from(packHeader, 'utf8'));
      nextPackSize = Buffer.byteLength(packHeader, 'utf8');
      for (const [key, entry] of this.entries) {
        const bytes = this.readEntryBuffer(entry);
        if (!bytes || bytes.length === 0) continue;
        const nextEntry = { offset: nextPackSize, length: bytes.length };
        writePackBytes(packFd, bytes);
        nextEntries.set(key, nextEntry);
        nextPackSize += bytes.length;
      }
      fs.closeSync(packFd);
      packFd = null;
      this.writeIndex(indexTemp, generation, nextEntries);
      this.close();
      fs.renameSync(packTemp, this.packPath);
      fs.renameSync(indexTemp, this.indexPath);
      this.loaded = false;
      this.valid = false;
      this.entries.clear();
      return this.load();
    } catch (error) {
      if (packFd !== null) fs.closeSync(packFd);
      this.invalidate();
      throw error;
    } finally {
      for (const temp of [packTemp, indexTemp]) {
        if (fs.existsSync(temp)) {
          try {
            fs.unlinkSync(temp);
          } catch {
            // Best-effort cleanup for a cache-only artifact.
          }
        }
      }
    }
  }

  prune(liveKeys) {
    if (!this.load()) return false;
    let changed = false;
    for (const key of this.entries.keys()) {
      if (liveKeys.has(key)) continue;
      this.entries.delete(key);
      changed = true;
    }
    this.liveBytes = 0;
    for (const entry of this.entries.values()) this.liveBytes += entry.length;
    const overCompactionRatio = this.packSize > (Math.max(1, this.liveBytes) * 2) + this.headerLength;
    if (overCompactionRatio) return this.compact();
    if (changed) this.rewriteIndex();
    return changed;
  }
}

// Matches the whole ft-build-id marker in any attribute order and in both the
// quoted (rendered) and unquoted (minified) spelling.
const BUILD_ID_META_PATTERN = /<meta\b(?=[^>]*\bname\s*=\s*["']?ft-build-id(?:["'\s>]|\/>))[^>]*>/gi;

/**
 * Compare rendered pages without letting build-only values turn a reusable
 * page into a false mismatch. This deliberately normalizes only generated
 * build-id/date fields; source dates such as datePosted remain significant.
 * The ft-build-id marker is removed whole, so a cached page rendered with the
 * marker still matches a render made with STATIC_BUILD_ID_META=off.
 */
export function normalizeHtmlForReuse(html) {
  return String(html)
    .replace(BUILD_ID_META_PATTERN, '')
    .replace(/(<lastmod>)[^<]*(<\/lastmod>)/gi, '$1__GENERATED_DATE__$2')
    .replace(
      /((?:data-)?(?:build|generated)-(?:id|at)\s*=\s*["'])[^"']*(["'])/gi,
      '$1__GENERATED_VALUE__$2',
    );
}

/** Remove the ft-build-id marker (STATIC_BUILD_ID_META=off). */
export function stripHtmlBuildId(html) {
  return String(html).replace(BUILD_ID_META_PATTERN, '');
}

export function refreshHtmlBuildId(html, buildId) {
  const value = String(buildId || '').replace(/[^0-9]/g, '');
  if (!value) return String(html);
  return String(html)
    .replace(
      /(<meta\b[^>]*\bname\s*=\s*["']ft-build-id["'][^>]*\bcontent\s*=\s*["'])[^"']*(["'][^>]*>)/gi,
      `$1${value}$2`,
    )
    .replace(
      /(<meta\b[^>]*\bcontent\s*=\s*["'])[^"']*(["'][^>]*\bname\s*=\s*["']ft-build-id["'][^>]*>)/gi,
      `$1${value}$2`,
    );
}

export function htmlHasIndexableRobots(html) {
  const tag = String(html).match(/<meta\b[^>]*\bname\s*=\s*["']robots["'][^>]*>/i)?.[0] || '';
  return !!tag && !/\bnoindex\b/i.test(tag);
}

function htmlAssetReferenceList(html) {
  const references = [];
  const assetReferencePattern = /<(script|link|img|source)\b[^>]*?\s(src|href)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (const match of String(html).matchAll(assetReferencePattern)) {
    const tag = match[1].toLowerCase();
    const url = match[3];
    const element = match[0];
    const rel = element.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    if (
      tag === 'script'
      || tag === 'img'
      || tag === 'source'
      || /\b(?:stylesheet|preload|icon|preconnect|dns-prefetch)\b/i.test(rel)
      || /(?:^|\/)assets\//i.test(url)
      || /(?:^|\/)favicon\.(?:ico|svg)(?:[?#]|$)/i.test(url)
    ) {
      references.push(`${tag}:${match[2].toLowerCase()}:${url}`);
    }
  }
  return references.sort();
}

function htmlAssetReferences(html) {
  return JSON.stringify(htmlAssetReferenceList(html));
}

function htmlInlineBlocks(html) {
  const blocks = [];
  const blockPattern = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  for (const match of String(html).matchAll(blockPattern)) {
    if (/\ssrc\s*=/i.test(match[2])) continue;
    blocks.push(`${match[1].toLowerCase()}:${match[3]}`);
  }
  const styleAttributePattern = /\bstyle\s*=\s*["']([^"']*)["']/gi;
  for (const match of String(html).matchAll(styleAttributePattern)) {
    blocks.push(`style-attribute:${match[1]}`);
  }
  return JSON.stringify(blocks.sort());
}

function classifyHtmlReuseMismatch(previousHtml, renderedHtml) {
  const previous = normalizeHtmlForReuse(previousHtml);
  const rendered = normalizeHtmlForReuse(renderedHtml);
  const assetsChanged = htmlAssetReferences(previous) !== htmlAssetReferences(rendered);
  const inlineChanged = htmlInlineBlocks(previous) !== htmlInlineBlocks(rendered);
  if (assetsChanged && inlineChanged) return 'asset-and-inline-changed';
  if (assetsChanged) return 'asset-reference-changed';
  if (inlineChanged) return 'inline-content-changed';
  return 'html-content-changed';
}

function stringIndexAtByteOffset(value, byteOffset) {
  let byteCount = 0;
  let index = 0;
  while (index < value.length && byteCount < byteOffset) {
    const codePoint = value.codePointAt(index);
    const character = String.fromCodePoint(codePoint);
    byteCount += Buffer.byteLength(character, 'utf8');
    index += character.length;
  }
  return index;
}

function firstByteDifference(expected, actual) {
  const expectedBytes = Buffer.from(expected, 'utf8');
  const actualBytes = Buffer.from(actual, 'utf8');
  const limit = Math.max(expectedBytes.length, actualBytes.length);
  for (let offset = 0; offset < limit; offset += 1) {
    if (expectedBytes[offset] !== actualBytes[offset]) return offset;
  }
  return -1;
}

function contextAround(value, byteOffset) {
  const index = stringIndexAtByteOffset(value, byteOffset);
  const start = Math.max(0, index - MISMATCH_CONTEXT_RADIUS);
  return value.slice(start, start + MISMATCH_CONTEXT_RADIUS * 2);
}

function firstAssetDifference(previousHtml, renderedHtml) {
  const previous = htmlAssetReferenceList(previousHtml);
  const rendered = htmlAssetReferenceList(renderedHtml);
  const previousOnly = previous.filter((reference) => !rendered.includes(reference));
  const renderedOnly = rendered.filter((reference) => !previous.includes(reference));
  if (previousOnly.length === 0 && renderedOnly.length === 0) return null;
  return {
    expected: previousOnly[0] || null,
    actual: renderedOnly[0] || null,
  };
}

/**
 * Return bounded, machine-readable evidence for a normalized HTML mismatch.
 * `offset` is a UTF-8 byte offset; contexts are intentionally short so the
 * same evidence is safe in both the log line and the per-locale artifact.
 */
export function diagnoseHtmlReuseMismatch(previousHtml, renderedHtml, reason) {
  const expected = normalizeHtmlForReuse(previousHtml);
  const actual = normalizeHtmlForReuse(renderedHtml);
  const offset = firstByteDifference(expected, actual);
  const diagnostic = {
    offset,
    expectedContext: offset < 0 ? '' : contextAround(expected, offset),
    actualContext: offset < 0 ? '' : contextAround(actual, offset),
  };
  if (String(reason).startsWith('asset-')) {
    diagnostic.asset = firstAssetDifference(expected, actual);
  }
  return diagnostic;
}

function newBlockStats() {
  return {
    rendered: 0,
    reused: 0,
    reusable: 0,
    verified: 0,
    probed: 0,
    wouldSaveMs: 0,
    wallMs: 0,
    mismatches: 0,
    mismatchReasons: new Map(),
    missReasons: new Map(),
    loggedMissReasons: new Set(),
  };
}

function elapsedMs(startedAt) {
  return Number(process.hrtime.bigint() - startedAt) / 1e6;
}

function hasUnavailableSourceInput(input) {
  if (input === null || input === undefined) return true;
  if (typeof input !== 'object' || Array.isArray(input)) return false;
  for (const key of ['sourceInputHash', 'canonicalInputHash']) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const value = input[key];
    if (value === null || value === undefined || value === '') return true;
  }
  return false;
}

function manifestCacheEntries(manifest) {
  if (typeof manifest?.entriesByPath?.entries === 'function') return manifest.entriesByPath.entries();
  if (typeof manifest?.entries?.entries === 'function') return manifest.entries.entries();
  const entries = [];
  for (const kindEntries of manifest?.entriesByKind?.values?.() || []) {
    entries.push(...kindEntries.entries());
  }
  return entries;
}

export class JobsSeoHtmlReuse {
  constructor({
    cacheRoot,
    previousByLocale,
    verify,
    verifySample = 1,
    emitterFingerprints = {},
    probe = null,
  }) {
    this.cacheRoot = cacheRoot;
    this.probe = probe;
    this.probeStates = new Map();
    this.previousByLocale = previousByLocale;
    this.verify = verify;
    this.verifySample = verifySample;
    this.mode = verify ? (verifySample < 1 ? 'verify-sample' : 'verify-render') : 'reuse';
    this.emitterFingerprints = emitterFingerprints;
    this.stats = new Map(JOBS_SEO_REUSE_BLOCKS.map((block) => [block, newBlockStats()]));
    this.mismatchLogCount = 0;
    this.diagnosticsByLocale = new Map();
    this.packStores = new Map();
  }

  packStore(locale, block) {
    const safe = `${safeLocale(locale)}\0${safeReuseBlock(block)}`;
    let store = this.packStores.get(safe);
    if (!store) {
      store = new JobsSeoHtmlPackStore(this.cacheRoot, locale, block, this.cacheRoot);
      this.packStores.set(safe, store);
    }
    return store;
  }

  shouldRender(candidate) {
    return Boolean(candidate?.verify);
  }

  probeBlockSize(locale, block) {
    const byKind = this.previousByLocale.get(String(locale))?.data?.counts?.byKind || {};
    let size = 0;
    for (const [kind, kindBlock] of Object.entries(KIND_TO_REUSE_BLOCK)) {
      if (kindBlock === block) size += Number(byKind[kind]) || 0;
    }
    return size;
  }

  probeState(locale, block) {
    const key = `${locale}\0${block}`;
    let state = this.probeStates.get(key);
    if (!state) {
      state = newProbeState(jobsSeoReuseProbeTarget(this.probeBlockSize(locale, block), this.probe));
      this.probeStates.set(key, state);
    }
    return state;
  }

  /**
   * Only the emitter fingerprint differs: kind, liveness and template version
   * of the previous entry are unchanged and both fingerprints exist. Anything
   * else keeps the historical hard invalidation.
   */
  probeEligibleFingerprintChange(previous, entry, kind) {
    if (!this.probe) return false;
    const current = this.emitterFingerprints[entry.kind];
    const before = previous.data.jobsSeoEmitterFingerprint?.[entry.kind];
    return Boolean(current && before && current !== before)
      && previous.data.kinds[entry.kind]?.templateVersion === templateVersionForKind(kind);
  }

  readCachedHtml(packStore, cacheKey, locale, normalizedPath, entry) {
    const html = packStore.read(cacheKey);
    if (html) return { html, storage: 'pack' };
    try {
      const previousCachePath = htmlReuseCachePath(
        this.cacheRoot,
        locale,
        normalizedPath,
        this.cacheRoot,
        entry.kind,
        entry.inputHash,
      );
      const legacy = fs.readFileSync(previousCachePath, 'utf8');
      if (legacy) return { html: legacy, storage: 'legacy' };
    } catch {
      // The old one-file layout is a migration fallback only.
    }
    return { html: null, storage: null };
  }

  lookup(locale, pagePath, kind, input, block, shapeHints = null) {
    const stats = this.stats.get(block);
    if (!stats) throw new Error(`Unknown jobs SEO reuse block: ${block}`);
    const normalizedPath = normalizeManifestPath(pagePath);
    const previous = this.previousByLocale.get(String(locale));
    // A bridge depends on the current source page. If that source was not
    // registered in this shard, its `sourceInputHash`/`canonicalInputHash`
    // is null. Hashing that null would make every such bridge look stable
    // across builds and could reuse HTML from a different source revision.
    // Treat the missing dependency as an explicit render miss instead.
    const inputUnavailable = hasUnavailableSourceInput(input);
    const inputHash = inputUnavailable ? null : computeInputHash(input, kind);
    const cacheKey = cacheFileName(normalizedPath, kind, inputHash || 'input-unavailable');
    const packStore = this.packStore(locale, block);
    const cachePath = packStore.packPath;
    let missReason = inputUnavailable ? 'input-unavailable' : null;
    let html = null;
    let storage = null;
    let probe = null;

    if (!missReason && !previous) {
      missReason = 'manifest-missing';
    } else if (!missReason) {
      const entry = previous.entries.get(normalizedPath);
      if (!entry) {
        missReason = 'path-added';
      } else if (entry.kind !== kind) {
        missReason = 'kind-changed';
      } else if (previous.data.kinds[entry.kind]?.state !== 'live') {
        missReason = 'kind-not-live';
      } else if (this.probeEligibleFingerprintChange(previous, entry, kind)) {
        // Output-validated fingerprint: same page, same input, only the
        // render source graph changed. Decide from the rendered bytes.
        if (entry.inputHash !== inputHash) {
          missReason = 'input-hash-changed';
        } else {
          const state = this.probeState(String(locale), block);
          state.eligible += 1;
          if (state.state === 'invalidate') {
            missReason = 'emitter-fingerprint-changed';
          } else {
            ({ html, storage } = this.readCachedHtml(packStore, cacheKey, locale, normalizedPath, entry));
            if (!html) {
              missReason = 'html-unavailable';
              state.unavailable += 1;
              // A cache that cannot produce a page it claims is not evidence:
              // stop inheriting instead of guessing for the rest of the block.
              this.invalidateProbe(state, block, String(locale), 'cache-unavailable', normalizedPath);
            } else {
              const stratum = jobsSeoProbeStratum(kind, locale, input, shapeHints);
              if (
                state.identical < state.target
                || (state.strata.get(stratum) || 0) < this.probe.perStratum
              ) {
                probe = { state, stratum };
              } else {
                state.reused += 1;
              }
            }
          }
        }
      } else if (
        !this.emitterFingerprints[entry.kind]
        || previous.data.jobsSeoEmitterFingerprint?.[entry.kind] !== this.emitterFingerprints[entry.kind]
        || previous.data.kinds[entry.kind]?.templateVersion !== templateVersionForKind(kind)
      ) {
        missReason = 'emitter-fingerprint-changed';
      } else if (entry.inputHash !== inputHash) {
        missReason = 'input-hash-changed';
      } else {
        ({ html, storage } = this.readCachedHtml(packStore, cacheKey, locale, normalizedPath, entry));
        if (!html) missReason = 'html-unavailable';
      }
    }

    if (missReason) {
      stats.missReasons.set(missReason, (stats.missReasons.get(missReason) || 0) + 1);
      if (!stats.loggedMissReasons.has(missReason)) {
        stats.loggedMissReasons.add(missReason);
        console.warn(
          `[jobs-seo-reuse] block=${block} locale=${locale} fallback=render reason=${missReason}`,
        );
      }
    }

    const verify = html !== null && (
      probe !== null
      || (this.verify && verifySampleIncludes(String(locale), block, normalizedPath, this.verifySample))
    );

    return {
      block,
      locale: String(locale),
      path: normalizedPath,
      cachePath,
      cacheKey,
      html,
      hit: html !== null,
      storage,
      verify,
      probe,
      cacheable: !inputUnavailable,
      startedAt: process.hrtime.bigint(),
    };
  }

  /**
   * A block stops inheriting from here on. Pages already reused belong to
   * strata that each collected `perStratum` byte-identical renders with the
   * new code, and they still pass through the sampled verify; the counter
   * `reusedBeforeInvalidate` keeps that exposure visible in the verdict file.
   */
  invalidateProbe(state, block, locale, reason, pagePath) {
    if (state.state === 'invalidate') return;
    state.reusedBeforeInvalidate = state.reused;
    state.state = 'invalidate';
    state.reason = reason;
    console.warn(
      `[jobs-seo-reuse-probe] block=${block} locale=${locale} verdict=invalidate reason=${reason}`
      + ` path=${pagePath} sampled=${state.sampled} identical=${state.identical}`
      + ` reused-before=${state.reused}`,
    );
  }

  finishProbe(candidate, renderedHtml, elapsed) {
    const { state, stratum } = candidate.probe;
    const stats = this.stats.get(candidate.block);
    stats.rendered += 1;
    stats.probed += 1;
    state.sampled += 1;
    state.wallMs += elapsed;
    if (normalizeHtmlForReuse(candidate.html) === normalizeHtmlForReuse(renderedHtml)) {
      state.identical += 1;
      state.strata.set(stratum, (state.strata.get(stratum) || 0) + 1);
    } else {
      state.differing += 1;
      const mismatchReason = classifyHtmlReuseMismatch(candidate.html, renderedHtml);
      const diagnostic = diagnoseHtmlReuseMismatch(candidate.html, renderedHtml, mismatchReason);
      if (this.mismatchLogCount < MAX_MISMATCH_LOGS) {
        this.mismatchLogCount += 1;
        console.warn(
          `[jobs-seo-reuse-probe] differing block=${candidate.block} locale=${candidate.locale}`
          + ` path=${candidate.path} reason=${mismatchReason} stratum=${JSON.stringify(stratum)}`
          + ` offset=${diagnostic.offset}`
          + ` expected=${JSON.stringify(diagnostic.expectedContext)}`
          + ` actual=${JSON.stringify(diagnostic.actualContext)}`,
        );
      }
      this.invalidateProbe(state, candidate.block, candidate.locale, `output-differs:${mismatchReason}`, candidate.path);
    }
    if (candidate.cacheable) this.persist(candidate, renderedHtml);
  }

  /** Final per-locale, per-block verdict of the output probe. */
  probeVerdicts(locale) {
    const previous = this.previousByLocale.get(String(locale));
    return Object.fromEntries(JOBS_SEO_REUSE_BLOCKS.map((block) => {
      const kinds = Object.entries(KIND_TO_REUSE_BLOCK)
        .filter(([, kindBlock]) => kindBlock === block)
        .map(([kind]) => kind);
      const changed = kinds.some((kind) => (
        (previous?.data?.jobsSeoEmitterFingerprint?.[kind] ?? null) !== (this.emitterFingerprints[kind] ?? null)
      ));
      const state = this.probeStates.get(`${locale}\0${block}`) || newProbeState(0);
      let verdict;
      let reason;
      if (!previous) {
        verdict = 'invalidate';
        reason = 'manifest-missing';
      } else if (!changed) {
        verdict = 'unchanged';
        reason = 'fingerprint-unchanged';
      } else if (state.state === 'invalidate') {
        verdict = 'invalidate';
        reason = state.reason;
      } else if (kinds.some((kind) => (
        !previous.data.jobsSeoEmitterFingerprint?.[kind]
        || !this.emitterFingerprints[kind]
        || (previous.data.kinds?.[kind] && previous.data.kinds[kind].templateVersion !== templateVersionForKind(kind))
      ))) {
        verdict = 'invalidate';
        reason = 'template-or-fingerprint-contract-changed';
      } else if (state.eligible === 0) {
        verdict = 'inherit';
        reason = 'no-eligible-pages';
      } else {
        verdict = 'inherit';
        reason = 'sample-identical';
      }
      return [block, {
        verdict,
        reason,
        target: state.target,
        eligible: state.eligible,
        sampled: state.sampled,
        identical: state.identical,
        differing: state.differing,
        unavailable: state.unavailable,
        strata: state.strata.size,
        reused: state.reused,
        reusedBeforeInvalidate: state.reusedBeforeInvalidate,
        probeWallMs: Math.round(state.wallMs),
      }];
    }));
  }

  writeProbeVerdicts() {
    for (const locale of this.previousByLocale.keys()) {
      let outputPath;
      try {
        outputPath = path.join(this.cacheRoot, `probe-${safeLocale(locale)}.json`);
        if (!this.probe) {
          // A verdict file must describe THIS build or not exist at all.
          fs.rmSync(outputPath, { force: true });
          continue;
        }
        const blocks = this.probeVerdicts(locale);
        for (const [block, result] of Object.entries(blocks)) {
          console.log(
            `[jobs-seo-reuse-probe] block=${block} locale=${locale}`
            + ` target=${result.target} eligible=${result.eligible} sampled=${result.sampled}`
            + ` identical=${result.identical} differing=${result.differing}`
            + ` unavailable=${result.unavailable} strata=${result.strata} reused=${result.reused}`
            + ` probe_wall_ms=${result.probeWallMs}`
            + ` verdict=${result.verdict} reason=${result.reason}`,
          );
        }
        fs.mkdirSync(this.cacheRoot, { recursive: true });
        // Atomic and fail-closed: a half-written or unwritable verdict must
        // leave NO file behind, otherwise an older sidecar with the same
        // fingerprint pair would answer for a probe that never ran.
        const temp = `${outputPath}.${process.pid}.tmp`;
        fs.writeFileSync(temp, `${JSON.stringify({
          version: JOBS_SEO_REUSE_PROBE_VERSION,
          buildId: JOBS_SEO_REUSE_PROBE_BUILD_ID,
          locale,
          previousFingerprint: this.previousByLocale.get(locale)?.data?.jobsSeoEmitterFingerprint || null,
          currentFingerprint: this.emitterFingerprints || null,
          config: this.probe,
          blocks,
        }, null, 2)}\n`, 'utf8');
        fs.renameSync(temp, outputPath);
      } catch (error) {
        try {
          if (outputPath) fs.rmSync(outputPath, { force: true });
          if (outputPath) fs.rmSync(`${outputPath}.${process.pid}.tmp`, { force: true });
        } catch {
          // Best effort: the post-walk still refuses a verdict it cannot read.
        }
        console.warn(
          `[jobs-seo-reuse-probe] verdict-write-failed locale=${locale} path=${outputPath}`
          + ` verdict=discarded reason=${error?.message || error}`,
        );
      }
    }
  }

  finish(candidate, renderedHtml) {
    if (!candidate) return;
    const stats = this.stats.get(candidate.block);
    const elapsed = elapsedMs(candidate.startedAt);
    stats.wallMs += elapsed;
    if (candidate.probe) {
      this.finishProbe(candidate, renderedHtml, elapsed);
      return;
    }
    if (candidate.hit) {
      stats.reusable += 1;
      if (!candidate.verify) {
        stats.reused += 1;
        if (candidate.storage === 'legacy' && candidate.cacheable) {
          this.persist(candidate, candidate.html);
        }
        return;
      }
      stats.verified += 1;
      stats.wouldSaveMs += elapsed;
    }

    stats.rendered += 1;
    if (candidate.hit && normalizeHtmlForReuse(candidate.html) !== normalizeHtmlForReuse(renderedHtml)) {
      stats.mismatches += 1;
      const mismatchReason = classifyHtmlReuseMismatch(candidate.html, renderedHtml);
      const diagnostic = diagnoseHtmlReuseMismatch(candidate.html, renderedHtml, mismatchReason);
      stats.mismatchReasons.set(
        mismatchReason,
        (stats.mismatchReasons.get(mismatchReason) || 0) + 1,
      );
      const localeDiagnostics = this.diagnosticsByLocale.get(candidate.locale) || [];
      if (localeDiagnostics.length < MAX_VERIFY_DIAGNOSTICS) {
        localeDiagnostics.push({
          block: candidate.block,
          locale: candidate.locale,
          path: candidate.path,
          reason: mismatchReason,
          ...diagnostic,
        });
        this.diagnosticsByLocale.set(candidate.locale, localeDiagnostics);
      }
      if (this.mismatchLogCount < MAX_MISMATCH_LOGS) {
        this.mismatchLogCount += 1;
        console.warn(
          `[jobs-seo-reuse] verify=mismatch block=${candidate.block} locale=${candidate.locale}`
          + ` path=${candidate.path} reason=${mismatchReason}`
          + ` offset=${diagnostic.offset}`
          + ` expected=${JSON.stringify(diagnostic.expectedContext)}`
          + ` actual=${JSON.stringify(diagnostic.actualContext)}`
          + (diagnostic.asset ? ` asset=${JSON.stringify(diagnostic.asset)}` : ''),
        );
      }
    }
    if (!candidate.cacheable) return;
    this.persist(candidate, renderedHtml);
  }

  /**
   * `buildId === null` (STATIC_BUILD_ID_META=off) strips the marker, so a page
   * cached before the switch matches a fresh render byte for byte.
   */
  reusedHtml(candidate, buildId) {
    if (!candidate?.hit || candidate.verify) return null;
    if (buildId === null) return stripHtmlBuildId(candidate.html);
    return refreshHtmlBuildId(candidate.html, buildId);
  }

  persist(candidate, html) {
    try {
      const store = this.packStore(candidate.locale, candidate.block);
      if (!store.append(candidate.cacheKey, html)) {
        throw new Error('empty jobs SEO HTML pack entry');
      }
    } catch (error) {
      console.warn(
        `[jobs-seo-reuse] cache-write-failed block=${candidate.block} path=${candidate.path}`
        + ` reason=${error?.message || error}`,
      );
    }
  }

  prune(locale, manifest) {
    const localeDir = path.join(this.cacheRoot, safeLocale(locale));
    if (!fs.existsSync(localeDir)) return;
    const liveByBlock = new Map(
      JOBS_SEO_REUSE_BLOCKS.map((block) => [block, new Set()]),
    );
    for (const [pagePath, entry] of manifestCacheEntries(manifest)) {
      const block = KIND_TO_REUSE_BLOCK[entry?.kind];
      const inputHash = entry?.inputHash || entry?.hash;
      if (!block || !inputHash) continue;
      liveByBlock.get(block).add(cacheFileName(pagePath, entry.kind, inputHash));
    }
    const currentCacheNames = new Set();
    for (const keys of liveByBlock.values()) {
      for (const key of keys) currentCacheNames.add(key);
    }
    const packedCacheNames = new Set();
    for (const block of JOBS_SEO_REUSE_BLOCKS) {
      const store = this.packStore(locale, block);
      try {
        store.prune(liveByBlock.get(block));
        for (const key of liveByBlock.get(block)) {
          if (store.has(key)) packedCacheNames.add(key);
        }
      } catch (error) {
        console.warn(
          `[jobs-seo-reuse] cache-pack-prune-failed locale=${locale} block=${block}`
          + ` reason=${error?.message || error}`,
        );
      }
    }
    for (const fileName of fs.readdirSync(localeDir)) {
      if (!fileName.endsWith('.html')) continue;
      if (currentCacheNames.has(fileName) && !packedCacheNames.has(fileName)) continue;
      try {
        fs.unlinkSync(path.join(localeDir, fileName));
      } catch (error) {
        console.warn(
          `[jobs-seo-reuse] cache-prune-failed locale=${locale} path=${fileName} reason=${error?.message || error}`,
        );
      }
    }
  }

  summary() {
    return Object.fromEntries(JOBS_SEO_REUSE_BLOCKS.map((block) => {
      const stats = this.stats.get(block);
      return [block, {
        rendered: stats.rendered,
        reused: stats.reused,
        reusable: stats.reusable,
        verified: stats.verified,
        probed: stats.probed,
        wouldSaveMs: stats.wouldSaveMs,
        wallMs: stats.wallMs,
        mismatches: stats.mismatches,
        mismatchReasons: Object.fromEntries(stats.mismatchReasons),
        missReasons: Object.fromEntries(stats.missReasons),
      }];
    }));
  }

  logSummary() {
    if (this.verify) this.writeVerifyDiagnostics();
    this.writeProbeVerdicts();
    for (const block of JOBS_SEO_REUSE_BLOCKS) {
      const stats = this.stats.get(block);
      const missReasons = [...stats.missReasons.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([reason, count]) => `${reason}:${count}`)
        .join(',') || 'none';
      const mismatchReasons = [...stats.mismatchReasons.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([reason, count]) => `${reason}:${count}`)
        .join(',') || 'none';
      console.log(
        `[jobs-seo-reuse] block=${block} mode=${this.mode}`
        + ` rendered=${stats.rendered} reused=${stats.reused} reusable=${stats.reusable}`
        + ` verified=${stats.verified} probed=${stats.probed} would-save_ms=${stats.wouldSaveMs.toFixed(1)}`
        + ` miss-reason=${missReasons} wall_ms=${stats.wallMs.toFixed(1)}`
        + ` mismatches=${stats.mismatches} mismatch-reason=${mismatchReasons}`,
      );
    }
  }

  writeVerifyDiagnostics() {
    const locales = new Set([
      ...this.previousByLocale.keys(),
      ...this.diagnosticsByLocale.keys(),
    ]);
    for (const locale of locales) {
      const safe = safeLocale(locale);
      const outputPath = path.join(this.cacheRoot, `verify-${safe}.json`);
      const mismatches = this.diagnosticsByLocale.get(locale) || [];
      try {
        fs.mkdirSync(this.cacheRoot, { recursive: true });
        fs.writeFileSync(
          outputPath,
          `${JSON.stringify({ version: 1, locale: safe, mismatches }, null, 2)}\n`,
          'utf8',
        );
      } catch (error) {
        console.warn(
          `[jobs-seo-reuse] verify-artifact-write-failed locale=${safe} path=${outputPath}`
          + ` reason=${error?.message || error}`,
        );
      }
    }
  }
}

/**
 * Enable only when explicitly requested. Previous manifests are metadata-only
 * maps; HTML stays on disk and is read one page at a time.
 */
export async function createJobsSeoHtmlReuse(rootDir, locales, emitterFingerprints = null) {
  if (process.env[JOBS_SEO_REUSE_ENV] !== '1') return null;

  const currentEmitterFingerprints = emitterFingerprints
    || (fs.existsSync(path.join(rootDir, JOBS_SEO_RENDER_ENTRY))
      ? computeJobsSeoEmitterFingerprints(rootDir)
      : {});

  const cacheRoot = configuredPath(
    rootDir,
    process.env.JOBS_SEO_REUSE_HTML_CACHE_DIR,
    path.join(rootDir, '.cache', 'incremental-html'),
  );
  // The HTML cache is restored from the previous build, so it can carry that
  // build's verdicts. Discard them before anything can read them: only the
  // verdict written by this build at the end of jobs-seo may be consulted.
  discardJobsSeoReuseProbeVerdicts(rootDir, locales);
  const previousByLocale = new Map();
  for (const rawLocale of locales) {
    const locale = safeLocale(rawLocale);
    const manifestPath = previousManifestPath(rootDir, locale);
    if (!fs.existsSync(manifestPath)) {
      console.warn(`[jobs-seo-reuse] locale=${locale} fallback=render reason=manifest-missing`);
      previousByLocale.set(locale, null);
      continue;
    }
    try {
      previousByLocale.set(locale, await loadIncrementalManifest(manifestPath));
      console.log(`[jobs-seo-reuse] locale=${locale} previous-manifest=${manifestPath}`);
    } catch (error) {
      console.warn(
        `[jobs-seo-reuse] locale=${locale} fallback=render reason=manifest-invalid detail=${error?.message || error}`,
      );
      previousByLocale.set(locale, null);
    }
  }

  return new JobsSeoHtmlReuse({
    cacheRoot,
    previousByLocale,
    verify: process.env[JOBS_SEO_REUSE_VERIFY_ENV] === '1',
    verifySample: parseVerifySample(process.env[JOBS_SEO_REUSE_VERIFY_SAMPLE_ENV]),
    emitterFingerprints: currentEmitterFingerprints,
    probe: parseJobsSeoReuseProbeConfig(),
  });
}
