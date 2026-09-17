import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  computeInputHash,
  JOB_DIGEST_ALGORITHM_VERSION,
  loadIncrementalManifest,
  normalizeManifestPath,
  templateVersionForKind,
} from './incrementalManifest.mjs';

export const JOBS_SEO_REUSE_ENV = 'JOBS_SEO_REUSE';
export const JOBS_SEO_REUSE_VERIFY_ENV = 'JOBS_SEO_REUSE_VERIFY';
export const JOBS_SEO_REUSE_BLOCKS = Object.freeze([
  'active',
  'expired-soft-landing',
  'previous-slug-legacy',
  'cross-locale-reconciliation',
]);

const MAX_INLINE_CACHE_FILE_NAME = 220;
const MAX_MISMATCH_LOGS = 20;
export const JOBS_SEO_EMITTER_KINDS = Object.freeze([
  'active-job',
  'expired-soft-landing',
  'legacy-slug-bridge',
  'previous-slugs-full-content',
  'cross-locale-reconciliation',
]);

const JOBS_SEO_RENDER_ENTRY = 'build-plugins/jobsSeoPagesPlugin.ts';
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
const STATIC_IMPORT_RE = /\b(?:import|export)\s+(?:(?:type\s+)?[\s\S]*?\sfrom\s+)?['"](\.[^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;
const STATIC_ALIAS_IMPORT_RE = /\b(?:import|export)\s+(?:(?:type\s+)?[\s\S]*?\sfrom\s+)?['"](@\/[^'"]+)['"]/g;
const DYNAMIC_ALIAS_IMPORT_RE = /\bimport\s*\(\s*['"](@\/[^'"]+)['"]\s*\)/g;

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

function importedSourceModules(source, fromFile, rootDir) {
  const specifiers = new Set();
  for (const pattern of [STATIC_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  // Vite's application entry uses the repository-root `@/` alias. The jobs
  // emitter itself is relative-import based, but including this alias keeps
  // the asset-side source graph honest if the entry wiring changes.
  const aliasSpecifiers = [];
  for (const pattern of [STATIC_ALIAS_IMPORT_RE, DYNAMIC_ALIAS_IMPORT_RE]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) aliasSpecifiers.push(match[1]);
  }
  return [
    ...[...specifiers]
      .map((specifier) => resolveSourceModule(fromFile, specifier))
      .filter(Boolean),
    ...aliasSpecifiers
      .map((specifier) => resolveSourceModule(path.join(rootDir, 'index.tsx'), `./${specifier.slice(2)}`))
      .filter(Boolean),
  ];
}

function collectSourceModuleFiles(rootDir, entryFiles) {
  const queue = entryFiles.map((file) => path.resolve(rootDir, file));
  const files = new Set();
  for (let index = 0; index < queue.length; index += 1) {
    const file = queue[index];
    if (!file || files.has(file) || !fs.existsSync(file)) continue;
    files.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const imported of importedSourceModules(source, file, rootDir)) {
      if (!files.has(imported)) queue.push(imported);
    }
  }
  return [...files].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function hashSourceModuleFiles(rootDir, entryFiles) {
  const files = collectSourceModuleFiles(rootDir, entryFiles);
  const records = files.map((file) => ({
    path: path.relative(rootDir, file).replaceAll(path.sep, '/'),
    hash: sha256File(file),
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
  const codeHash = hashSourceModuleFiles(rootDir, [JOBS_SEO_RENDER_ENTRY]);
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

function configuredPath(rootDir, value, fallback) {
  if (!value) return fallback;
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

function previousManifestPath(rootDir, locale) {
  const configured = process.env.JOBS_SEO_REUSE_MANIFEST_PREVIOUS;
  if (configured) return configuredPath(rootDir, configured.replaceAll('{locale}', locale), configured);
  return path.join(rootDir, '.cache', 'incremental-manifest-prev', `${locale}.jsonl`);
}

function cacheFileName(pagePath) {
  const normalized = normalizeManifestPath(pagePath);
  const encoded = Buffer.from(normalized, 'utf8').toString('base64url');
  return encoded.length <= MAX_INLINE_CACHE_FILE_NAME
    ? `p-${encoded}.html`
    : `h-${sha256(normalized)}.html`;
}

export function htmlReuseCachePath(rootDir, locale, pagePath, cacheRoot = null) {
  const root = cacheRoot || path.join(rootDir, '.cache', 'incremental-html');
  return path.join(root, safeLocale(locale), cacheFileName(pagePath));
}

function decodeCachePageName(fileName) {
  if (!fileName.startsWith('p-') || !fileName.endsWith('.html')) return null;
  try {
    const encoded = fileName.slice(2, -'.html'.length);
    const pagePath = Buffer.from(encoded, 'base64url').toString('utf8');
    return pagePath ? normalizeManifestPath(pagePath) : null;
  } catch {
    return null;
  }
}

/**
 * Compare rendered pages without letting build-only values turn a reusable
 * page into a false mismatch. This deliberately normalizes only generated
 * build-id/date fields; source dates such as datePosted remain significant.
 */
export function normalizeHtmlForReuse(html) {
  return String(html)
    .replace(
      /(<meta\b[^>]*\bname\s*=\s*["']ft-build-id["'][^>]*\bcontent\s*=\s*["'])[^"']*(["'][^>]*>)/gi,
      '$1__BUILD_ID__$2',
    )
    .replace(
      /(<meta\b[^>]*\bcontent\s*=\s*["'])[^"']*(["'][^>]*\bname\s*=\s*["']ft-build-id["'][^>]*>)/gi,
      '$1__BUILD_ID__$2',
    )
    .replace(/(<lastmod>)[^<]*(<\/lastmod>)/gi, '$1__GENERATED_DATE__$2')
    .replace(
      /((?:data-)?(?:build|generated)-(?:id|at)\s*=\s*["'])[^"']*(["'])/gi,
      '$1__GENERATED_VALUE__$2',
    );
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

function htmlAssetReferences(html) {
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
  return JSON.stringify(references.sort());
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

function newBlockStats() {
  return {
    rendered: 0,
    reused: 0,
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

export class JobsSeoHtmlReuse {
  constructor({ cacheRoot, previousByLocale, verify, emitterFingerprints = {} }) {
    this.cacheRoot = cacheRoot;
    this.previousByLocale = previousByLocale;
    this.verify = verify;
    this.emitterFingerprints = emitterFingerprints;
    this.stats = new Map(JOBS_SEO_REUSE_BLOCKS.map((block) => [block, newBlockStats()]));
    this.mismatchLogCount = 0;
    this.writeCounter = 0;
  }

  lookup(locale, pagePath, kind, input, block) {
    const stats = this.stats.get(block);
    if (!stats) throw new Error(`Unknown jobs SEO reuse block: ${block}`);
    const normalizedPath = normalizeManifestPath(pagePath);
    const previous = this.previousByLocale.get(String(locale));
    const cachePath = htmlReuseCachePath(this.cacheRoot, locale, normalizedPath, this.cacheRoot);
    let missReason = null;
    let html = null;

    if (!previous) {
      missReason = 'manifest-missing';
    } else {
      const entry = previous.entries.get(normalizedPath);
      if (!entry) {
        missReason = 'path-added';
      } else if (entry.kind !== kind) {
        missReason = 'kind-changed';
      } else if (previous.data.kinds[entry.kind]?.state !== 'live') {
        missReason = 'kind-not-live';
      } else if (
        !this.emitterFingerprints[entry.kind]
        || previous.data.jobsSeoEmitterFingerprint?.[entry.kind] !== this.emitterFingerprints[entry.kind]
        || previous.data.kinds[entry.kind]?.templateVersion !== templateVersionForKind(kind)
      ) {
        missReason = 'emitter-fingerprint-changed';
      } else if (entry.inputHash !== computeInputHash(input, kind)) {
        missReason = 'input-hash-changed';
      } else {
        try {
          html = fs.readFileSync(cachePath, 'utf8');
          if (!html) missReason = 'html-unavailable';
        } catch {
          missReason = 'html-unavailable';
        }
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

    return {
      block,
      locale: String(locale),
      path: normalizedPath,
      cachePath,
      html,
      hit: html !== null,
      startedAt: process.hrtime.bigint(),
    };
  }

  finish(candidate, renderedHtml) {
    if (!candidate) return;
    const stats = this.stats.get(candidate.block);
    stats.wallMs += elapsedMs(candidate.startedAt);
    if (candidate.hit && !this.verify) {
      stats.reused += 1;
      return;
    }

    stats.rendered += 1;
    if (candidate.hit && normalizeHtmlForReuse(candidate.html) !== normalizeHtmlForReuse(renderedHtml)) {
      stats.mismatches += 1;
      const mismatchReason = classifyHtmlReuseMismatch(candidate.html, renderedHtml);
      stats.mismatchReasons.set(
        mismatchReason,
        (stats.mismatchReasons.get(mismatchReason) || 0) + 1,
      );
      if (this.mismatchLogCount < MAX_MISMATCH_LOGS) {
        this.mismatchLogCount += 1;
        console.warn(
          `[jobs-seo-reuse] verify=mismatch block=${candidate.block} locale=${candidate.locale}`
          + ` path=${candidate.path} reason=${mismatchReason}`,
        );
      }
    }
    this.persist(candidate.cachePath, renderedHtml, candidate.block, candidate.path);
  }

  reusedHtml(candidate, buildId) {
    if (!candidate?.hit || this.verify) return null;
    return refreshHtmlBuildId(candidate.html, buildId);
  }

  persist(cachePath, html, block, pagePath) {
    let temp = null;
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      temp = `${cachePath}.${process.pid}.${this.writeCounter += 1}.tmp`;
      fs.writeFileSync(temp, String(html), 'utf8');
      fs.renameSync(temp, cachePath);
    } catch (error) {
      if (temp) {
        try {
          fs.unlinkSync(temp);
        } catch {
          // The cache is best-effort; retain the render fallback on cleanup failure.
        }
      }
      console.warn(
        `[jobs-seo-reuse] cache-write-failed block=${block} path=${pagePath} reason=${error?.message || error}`,
      );
    }
  }

  prune(locale, manifest) {
    const localeDir = path.join(this.cacheRoot, safeLocale(locale));
    if (!fs.existsSync(localeDir)) return;
    const currentCacheNames = new Set();
    if (manifest?.entriesByPath?.keys) {
      for (const pagePath of manifest.entriesByPath.keys()) currentCacheNames.add(cacheFileName(pagePath));
    } else {
      for (const entries of manifest?.entriesByKind?.values?.() || []) {
        for (const pagePath of entries.keys()) currentCacheNames.add(cacheFileName(pagePath));
      }
    }
    for (const fileName of fs.readdirSync(localeDir)) {
      if (currentCacheNames.has(fileName)) continue;
      const pagePath = decodeCachePageName(fileName);
      if (pagePath && manifest.hasPath(pagePath)) continue;
      try {
        fs.unlinkSync(path.join(localeDir, fileName));
      } catch (error) {
        console.warn(
          `[jobs-seo-reuse] cache-prune-failed locale=${locale} path=${pagePath || fileName} reason=${error?.message || error}`,
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
        wallMs: stats.wallMs,
        mismatches: stats.mismatches,
        mismatchReasons: Object.fromEntries(stats.mismatchReasons),
        missReasons: Object.fromEntries(stats.missReasons),
      }];
    }));
  }

  logSummary() {
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
        `[jobs-seo-reuse] block=${block} rendered=${stats.rendered} reused=${stats.reused}`
        + ` miss-reason=${missReasons} wall_ms=${stats.wallMs.toFixed(1)}`
        + ` mismatches=${stats.mismatches} mismatch-reason=${mismatchReasons}`,
      );
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
    emitterFingerprints: currentEmitterFingerprints,
  });
}
