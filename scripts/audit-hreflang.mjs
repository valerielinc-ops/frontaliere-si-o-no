#!/usr/bin/env node
/**
 * audit-hreflang — post-build validator for hreflang tags in every dist/ HTML.
 *
 * Why this exists
 * ---------------
 * Semrush Site Audit (2026-04-24) reported 10 pages with "bad hreflang links
 * within page source code". The existing `validate-hreflang.mjs` only walked
 * the sitemap URLs — pages missing from the sitemap slipped through. This
 * script walks the full `dist/` tree and enforces 4 invariants:
 *
 *   1. Every HTML page with any hreflang MUST have >= 5 entries
 *      (4 locales: it, en, de, fr + x-default).
 *   2. Every hreflang href MUST be absolute on the canonical host
 *      `https://frontaliereticino.ch` (no `www.`, no `http://`).
 *   3. The locale code MUST match the URL path prefix:
 *        - `hreflang="it"`   → path MUST NOT start with `/en/`, `/de/`, `/fr/`
 *        - `hreflang="en"`   → path MUST start with `/en/`
 *        - `hreflang="de"`   → path MUST start with `/de/`
 *        - `hreflang="fr"`   → path MUST start with `/fr/`
 *   4. Every hreflang target MUST exist as a file in `dist/` (so Google
 *      doesn't hit a 404 when following the link).
 *
 * Pages without ANY hreflang tags are skipped — many utility pages (404.html,
 * bridge redirects, etc.) legitimately have none. Missing-hreflang checks
 * for indexable pages are enforced separately by `validate-hreflang.mjs`
 * (sitemap-driven) and `tests/post-build/hreflang-consistency.test.ts`.
 *
 * Exit codes: 0 on success, 1 on any failure. Fails fast with a summary
 * grouped by invariant so CI logs are readable.
 *
 * Intentionally a .mjs Node script (not TypeScript) so CI can run it without
 * transpilation after `vite build`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { writeAuditReport } from './lib/auditReport.mjs';

const DIST = path.resolve('dist');
const BASE_URL = 'https://frontaliereticino.ch';
const LOCALES = ['it', 'en', 'de', 'fr'];
const PREFIXED_LOCALES = ['en', 'de', 'fr'];

/** Collect every *.html file under dist/. */
function walkHtmlFiles(root) {
  /** @type {string[]} */
  const out = [];
  if (!existsSync(root)) return out;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.html')) {
        out.push(full);
      }
    }
  }
  return out;
}

/** Return a Map<hreflang, href> parsed from one HTML file's <head>. */
function extractAlternates(html) {
  const map = new Map();
  const regex = /<link\s+rel="alternate"[^>]*hreflang="([^"]+)"[^>]*href="([^"]+)"/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    map.set(match[1], match[2]);
  }
  return map;
}

/** Map an absolute canonical URL to the file that would serve it in dist/. */
function urlToDistFile(url) {
  const cleaned = url.split('#')[0].split('?')[0];
  if (!cleaned.startsWith(BASE_URL)) return null;
  const pathname = cleaned.slice(BASE_URL.length) || '/';
  if (pathname === '/' || pathname === '') return path.join(DIST, 'index.html');
  const rel = pathname.replace(/^\//, '').replace(/\/$/, '');
  if (path.extname(rel)) return path.join(DIST, rel);
  return path.join(DIST, rel, 'index.html');
}

/**
 * Validate one (locale, href) pair against the canonical host + locale prefix.
 * Returns a string describing the failure, or null if valid.
 */
function validateLocalePair(hreflang, href) {
  // Host check — reject www, http, or foreign domains.
  if (!href.startsWith(`${BASE_URL}/`) && href !== BASE_URL) {
    return `href "${href}" is not on canonical host ${BASE_URL}`;
  }
  if (hreflang === 'x-default') return null;
  if (!LOCALES.includes(hreflang)) {
    return `unknown hreflang code "${hreflang}"`;
  }
  const pathname = href.slice(BASE_URL.length) || '/';
  const isPrefixed = PREFIXED_LOCALES.some((p) => pathname.startsWith(`/${p}/`));
  if (hreflang === 'it') {
    if (isPrefixed) {
      return `hreflang="it" path "${pathname}" starts with a non-IT locale prefix`;
    }
  } else {
    const expectedPrefix = `/${hreflang}/`;
    if (!pathname.startsWith(expectedPrefix)) {
      return `hreflang="${hreflang}" path "${pathname}" does not start with "${expectedPrefix}"`;
    }
  }
  return null;
}

function normaliseHref(href) {
  return href.replace(/\/$/, '');
}

async function main() {
  if (!existsSync(DIST)) {
    console.error(`audit-hreflang: dist/ does not exist at ${DIST}`);
    process.exit(1);
  }

  const htmlFiles = walkHtmlFiles(DIST);
  if (htmlFiles.length === 0) {
    console.error('audit-hreflang: no HTML files found in dist/');
    process.exit(1);
  }

  const failures = {
    /** page has <5 entries (has some hreflang but is incomplete). */
    tooFew: [],
    /** hreflang code/path mismatch OR non-canonical host. */
    invalidPair: [],
    /** x-default ≠ IT href. */
    xDefaultMismatch: [],
    /** hreflang target is missing from dist/. */
    missingTarget: [],
  };
  let scanned = 0;
  let withHreflang = 0;

  for (const file of htmlFiles) {
    scanned += 1;
    let html;
    try {
      html = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const alternates = extractAlternates(html);
    if (alternates.size === 0) continue;
    withHreflang += 1;

    const rel = path.relative(DIST, file);

    if (alternates.size < 5) {
      failures.tooFew.push(
        `${rel}: has only ${alternates.size} hreflang entries (need 4 locales + x-default)`,
      );
    }

    // Pair validation (host + locale/slug prefix).
    for (const [hreflang, href] of alternates) {
      const error = validateLocalePair(hreflang, href);
      if (error) {
        failures.invalidPair.push(`${rel}: ${error}`);
      }
    }

    // x-default consistency.
    const itHref = alternates.get('it');
    const xDefault = alternates.get('x-default');
    if (itHref && xDefault && normaliseHref(itHref) !== normaliseHref(xDefault)) {
      failures.xDefaultMismatch.push(
        `${rel}: x-default "${xDefault}" does not match IT hreflang "${itHref}"`,
      );
    }

    // Target existence — only verify pages on our own host.
    for (const [hreflang, href] of alternates) {
      if (!href.startsWith(BASE_URL)) continue;
      const target = urlToDistFile(href);
      if (!target) continue;
      // Tolerate a trailing / vs no / variant — check both forms.
      if (!existsSync(target)) {
        const alt = target.endsWith(`${path.sep}index.html`)
          ? target.slice(0, -`${path.sep}index.html`.length) + '.html'
          : path.join(path.dirname(target), path.basename(target, '.html'), 'index.html');
        if (!existsSync(alt)) {
          failures.missingTarget.push(
            `${rel}: hreflang="${hreflang}" target not found in dist/ (${href})`,
          );
        }
      }
    }
  }

  const totalFailures =
    failures.tooFew.length +
    failures.invalidPair.length +
    failures.xDefaultMismatch.length +
    failures.missingTarget.length;

  // Flatten failures to the shared offender schema. Each failure msg starts
  // with "<relPath>: ..." so the page is the first colon-segment.
  const _structuredOffenders = [];
  const _byFeature = {};
  for (const [kind, list] of Object.entries(failures)) {
    _byFeature[kind] = list.length;
    for (const msg of list) {
      const idx = msg.indexOf(':');
      const pagePath = idx > 0 ? msg.slice(0, idx) : msg;
      _structuredOffenders.push({
        path: pagePath,
        feature: kind,
        metric: 1,
        ratio: null,
        message: idx > 0 ? msg.slice(idx + 1).trim() : msg,
      });
    }
  }

  if (totalFailures === 0) {
    console.log(
      `audit-hreflang: OK — scanned ${scanned} HTML files (${withHreflang} with hreflang), no issues.`,
    );
    await writeAuditReport({
      audit: 'hreflang',
      passed: true,
      threshold: { metric: 'count', value: 0, comparator: '<=' },
      offenders: _structuredOffenders,
      byFeature: _byFeature,
    });
    process.exit(0);
  }

  console.error(
    `audit-hreflang: FAILED — ${totalFailures} issue(s) across ${withHreflang} pages with hreflang`,
  );
  const MAX = 50;
  for (const [kind, list] of Object.entries(failures)) {
    if (list.length === 0) continue;
    console.error(`\n[${kind}] ${list.length} issue(s):`);
    for (const msg of list.slice(0, MAX)) {
      console.error(`  - ${msg}`);
    }
    if (list.length > MAX) {
      console.error(`  ... and ${list.length - MAX} more`);
    }
  }
  await writeAuditReport({
    audit: 'hreflang',
    passed: false,
    threshold: { metric: 'count', value: 0, comparator: '<=' },
    offenders: _structuredOffenders,
    byFeature: _byFeature,
  });
  process.exit(1);
}

main().catch((err) => {
  console.error('audit-hreflang: fatal', err);
  process.exit(2);
});
