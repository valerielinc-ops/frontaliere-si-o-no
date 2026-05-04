#!/usr/bin/env node
/**
 * crawl-provider-logos.mjs
 *
 * One-shot downloader for PROVIDER_LOGOS defined in services/brandLogos.ts.
 * Saves each logo to public/images/providers/{slug}.{ext} and auto-patches
 * services/brandLogos.ts to set the `localPath` field for each entry.
 *
 * Logo resolution order (per slug):
 *   1. Clearbit  — https://logo.clearbit.com/{domain}
 *   2. Fallback  — https://www.google.com/s2/favicons?domain={domain}&sz=128
 *      (grey-globe = 726B exact response is silently skipped as "no logo")
 *
 * Idempotent: entries that already have `localPath` in brandLogos.ts are
 * skipped on re-run. Re-run with --force to re-download everything.
 *
 * Run once to download all provider logos:
 *   node scripts/crawl-provider-logos.mjs
 *
 * Dry-run (prints what would be changed, no writes):
 *   node scripts/crawl-provider-logos.mjs --dry-run
 *
 * Force re-download even if localPath already set:
 *   node scripts/crawl-provider-logos.mjs --force
 *
 * After running: commit public/images/providers/ + services/brandLogos.ts
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

// ── Config ────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(process.cwd());
const BRAND_LOGOS_TS = path.join(ROOT, 'services', 'brandLogos.ts');
const OUT_DIR = path.join(ROOT, 'public', 'images', 'providers');
const PUBLIC_PREFIX = '/images/providers';

const FETCH_TIMEOUT_MS = 12_000;
const CONCURRENCY = 6;
const GREY_GLOBE_SIZE = 726; // bytes — Google's generic globe at sz=128

// ── Inline domain map (avoids TS import complexity, stays in sync via comment) ─
// Mirrored from services/brandLogos.ts PROVIDER_LOGOS.
// If you add entries to brandLogos.ts, add them here too.
const PROVIDER_DOMAIN_MAP = {
  // Currency exchange
  'wise':               'wise.com',
  'revolut':            'revolut.com',
  'yuh':                'yuh.com',
  'postfinance':        'postfinance.ch',
  'ubs':                'ubs.com',
  'credit-suisse':      'credit-suisse.com',
  'fineco':             'finecobank.com',
  'intesa-sanpaolo':    'intesasanpaolo.com',
  'credit-agricole-it': 'credit-agricole.it',
  'unicredit':          'unicredit.it',
  'banco-bpm':          'bancobpm.it',
  'cambiavalute':       'cambiavalute.ch',
  // Telecom — Italian operators
  'iliad':              'iliad.it',
  'ho-mobile':          'ho-mobile.it',
  'vodafone-it':        'vodafone.it',
  'tim':                'tim.it',
  'windtre':            'windtre.it',
  'very-mobile':        'verymobile.it',
  'fastweb-mobile':     'fastweb.it',
  // Telecom — Swiss operators
  'swisscom':           'swisscom.ch',
  'salt':               'salt.ch',
  'sunrise':            'sunrise.ch',
  'yallo':              'yallo.ch',
  'wingo':              'wingo.ch',
  'aldi-mobile-ch':     'aldisuisse.ch',
};

// ── MIME → extension map ──────────────────────────────────────────────────────

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Detect image format from magic bytes as a fallback when Content-Type is missing/wrong. */
function detectExtFromBytes(buf) {
  if (!buf || buf.length < 8) return null;
  const sig = buf.subarray(0, 8);
  if (sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4e && sig[3] === 0x47) return 'png';
  if (sig[0] === 0xff && sig[1] === 0xd8 && sig[2] === 0xff) return 'jpg';
  if (sig[0] === 0x47 && sig[1] === 0x49 && sig[2] === 0x46) return 'gif';
  if (sig[0] === 0x52 && sig[1] === 0x49 && sig[2] === 0x46 && sig[3] === 0x46) return 'webp';
  if (sig[0] === 0x00 && sig[1] === 0x00 && sig[2] === 0x01 && sig[3] === 0x00) return 'ico';
  const head = buf.subarray(0, 256).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'svg';
  return null;
}

/** fetch() wrapped with a timeout AbortController. */
async function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; FrontaliereTicinoLogoFetch/1.0; +https://frontaliereticino.ch)',
        Accept: 'image/*,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

/** Run up to `concurrency` async workers over `items`. */
async function runConcurrent(items, worker, concurrency) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── Download logic ────────────────────────────────────────────────────────────

/**
 * Try to fetch `url` and return { buf, ext, contentType } on success,
 * or throw on non-2xx / empty body.
 */
async function tryFetch(url) {
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('empty body');
  const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const ext = MIME_EXT[ct] || detectExtFromBytes(buf) || 'png';
  return { buf, ext, contentType: ct };
}

/**
 * Download the logo for a single slug.
 * Returns { slug, status, localPath?, ext?, size?, error? }
 */
async function downloadOne({ slug, domain }) {
  const clearbitUrl = `https://logo.clearbit.com/${domain}`;
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;

  // 1. Try Clearbit
  let result = null;
  let primaryError = null;
  try {
    result = await tryFetch(clearbitUrl);
  } catch (err) {
    primaryError = err?.message ?? String(err);
  }

  // 2. Fallback to Google favicon
  if (!result) {
    try {
      const r = await tryFetch(faviconUrl);
      // Reject grey-globe (Google's generic "no favicon found" response)
      if (r.buf.length === GREY_GLOBE_SIZE) {
        return {
          slug,
          status: 'failed',
          error: `clearbit: ${primaryError} | google-favicon: grey-globe`,
        };
      }
      result = r;
    } catch (fallbackErr) {
      return {
        slug,
        status: 'failed',
        error: `clearbit: ${primaryError} | google-favicon: ${fallbackErr?.message ?? String(fallbackErr)}`,
      };
    }
  }

  const filename = `${slug}.${result.ext}`;
  const localPath = `${PUBLIC_PREFIX}/${filename}`;
  return {
    slug,
    status: 'downloaded',
    localPath,
    filename,
    ext: result.ext,
    size: result.buf.length,
    contentType: result.contentType,
    buf: result.buf,
  };
}

// ── brandLogos.ts patching ────────────────────────────────────────────────────

/**
 * Read brandLogos.ts and return a Set of slugs that already have `localPath`.
 * Matches:  'slug':  { domain: '...', localPath: '...' }
 */
function parseExistingLocalPaths(source) {
  const existing = new Set();
  // Match any entry that already contains localPath
  const re = /['"]([a-z0-9-]+)['"]\s*:\s*\{[^}]*localPath\s*:/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    existing.add(m[1]);
  }
  return existing;
}

/**
 * Patch brandLogos.ts source:
 * - { domain: 'X' }  →  { domain: 'X', localPath: '/images/providers/{slug}.{ext}' }
 *
 * Uses a targeted regex per slug so we don't accidentally match unrelated lines.
 * The trailing space-alignment is preserved as-is (the comment column).
 */
function patchSource(source, downloadedMap) {
  let patched = source;
  for (const [slug, { localPath }] of Object.entries(downloadedMap)) {
    // Match the line:  '  slug':  { domain: 'X' }
    // We escape the slug for regex safety (hyphens are fine but be explicit).
    const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      `(['"]${escapedSlug}['"]\\s*:\\s*\\{\\s*domain:\\s*'[^']*'\\s*\\})`,
      'g',
    );
    patched = patched.replace(re, (match) => {
      // If localPath is already present (shouldn't happen at this point, but be safe)
      if (match.includes('localPath')) return match;
      // Insert localPath before the closing brace
      return match.replace(/\s*\}$/, `, localPath: '${localPath}' }`);
    });
  }
  return patched;
}

// ── CLI args ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  return {
    dryRun: argv.includes('--dry-run'),
    force: argv.includes('--force'),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { dryRun, force } = parseArgs(process.argv.slice(2));

  if (dryRun) {
    console.log('[crawl-provider-logos] DRY RUN — no files will be written\n');
  }

  // Read current brandLogos.ts to find which slugs already have localPath
  const sourceOriginal = await readFile(BRAND_LOGOS_TS, 'utf8');
  const alreadyHaveLocalPath = parseExistingLocalPaths(sourceOriginal);

  // Build work list
  const entries = Object.entries(PROVIDER_DOMAIN_MAP).map(([slug, domain]) => ({ slug, domain }));
  const toDownload = force
    ? entries
    : entries.filter(({ slug }) => !alreadyHaveLocalPath.has(slug));
  const skipped = entries.filter(({ slug }) => alreadyHaveLocalPath.has(slug));

  console.log(`[crawl-provider-logos] Total providers: ${entries.length}`);
  console.log(`[crawl-provider-logos] Already have localPath (skipping): ${skipped.length}`);
  console.log(`[crawl-provider-logos] To download: ${toDownload.length}${dryRun ? ' (DRY RUN)' : ''}`);

  if (dryRun) {
    if (skipped.length > 0) {
      console.log('\nSkipped (already have localPath):');
      for (const { slug } of skipped) {
        console.log(`  ~ ${slug}`);
      }
    }
    if (toDownload.length > 0) {
      console.log('\nWould download:');
      for (const { slug, domain } of toDownload) {
        console.log(`  → ${slug}  (clearbit: ${domain}, fallback: google-favicon)`);
      }
    }
    return;
  }

  // Create output directory if needed
  await mkdir(OUT_DIR, { recursive: true });

  // Download concurrently
  const results = await runConcurrent(toDownload, async (entry) => {
    const result = await downloadOne(entry);
    const icon = result.status === 'downloaded' ? '✓' : '✗';
    const detail = result.status === 'downloaded'
      ? `${result.localPath} (${result.size}B, ${result.contentType})`
      : result.error;
    process.stdout.write(`  ${icon} ${entry.slug} — ${detail}\n`);
    return result;
  }, CONCURRENCY);

  // Write image files
  const downloaded = results.filter((r) => r.status === 'downloaded');
  const failed = results.filter((r) => r.status === 'failed');

  for (const r of downloaded) {
    const dest = path.join(OUT_DIR, r.filename);
    await writeFile(dest, r.buf);
  }

  // Patch brandLogos.ts
  if (downloaded.length > 0) {
    const downloadedMap = Object.fromEntries(
      downloaded.map((r) => [r.slug, { localPath: r.localPath }]),
    );
    const patched = patchSource(sourceOriginal, downloadedMap);
    if (patched !== sourceOriginal) {
      await writeFile(BRAND_LOGOS_TS, patched, 'utf8');
      console.log(`\n[crawl-provider-logos] Patched ${BRAND_LOGOS_TS} (added localPath for ${downloaded.length} entries)`);
    } else {
      console.log('\n[crawl-provider-logos] brandLogos.ts unchanged (all entries already patched or no regex match)');
    }
  }

  // Summary
  console.log('\n── Summary ───────────────────────────────────────────────────');
  console.log(`  Downloaded : ${downloaded.length}`);
  console.log(`  Skipped    : ${skipped.length}  (already have localPath)`);
  console.log(`  Failed     : ${failed.length}`);

  if (failed.length > 0) {
    console.log('\nFailed entries (no logo found):');
    for (const r of failed) {
      console.log(`  ✗ ${r.slug} — ${r.error}`);
    }
  }

  if (downloaded.length > 0) {
    console.log('\nNext step: commit public/images/providers/ + services/brandLogos.ts');
  }
}

main().catch((err) => {
  console.error('[crawl-provider-logos] Fatal:', err);
  process.exit(1);
});
