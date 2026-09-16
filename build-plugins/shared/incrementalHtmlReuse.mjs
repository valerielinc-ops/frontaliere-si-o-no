import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  computeInputHash,
  loadIncrementalManifest,
  normalizeManifestPath,
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

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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

function newBlockStats() {
  return {
    rendered: 0,
    reused: 0,
    wallMs: 0,
    mismatches: 0,
    missReasons: new Map(),
    loggedMissReasons: new Set(),
  };
}

function elapsedMs(startedAt) {
  return Number(process.hrtime.bigint() - startedAt) / 1e6;
}

export class JobsSeoHtmlReuse {
  constructor({ cacheRoot, previousByLocale, verify }) {
    this.cacheRoot = cacheRoot;
    this.previousByLocale = previousByLocale;
    this.verify = verify;
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
      if (this.mismatchLogCount < MAX_MISMATCH_LOGS) {
        this.mismatchLogCount += 1;
        console.warn(
          `[jobs-seo-reuse] verify=mismatch block=${candidate.block} locale=${candidate.locale} path=${candidate.path}`,
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
    for (const entries of manifest?.entriesByKind?.values?.() || []) {
      for (const pagePath of entries.keys()) currentCacheNames.add(cacheFileName(pagePath));
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
      console.log(
        `[jobs-seo-reuse] block=${block} rendered=${stats.rendered} reused=${stats.reused}`
        + ` miss-reason=${missReasons} wall_ms=${stats.wallMs.toFixed(1)} mismatches=${stats.mismatches}`,
      );
    }
  }
}

/**
 * Enable only when explicitly requested. Previous manifests are metadata-only
 * maps; HTML stays on disk and is read one page at a time.
 */
export async function createJobsSeoHtmlReuse(rootDir, locales) {
  if (process.env[JOBS_SEO_REUSE_ENV] !== '1') return null;

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
  });
}
