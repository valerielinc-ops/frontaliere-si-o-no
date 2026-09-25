#!/usr/bin/env node
// Weekly post-deploy scan for placeholder DefinedTerm.description values on
// live /glossario-frontaliere/ term pages (issue #4409).
//
// Fetches https://frontaliereticino.ch/sitemap-glossario.xml, walks every
// term-detail URL listed inside, extracts the page's `DefinedTerm` JSON-LD
// block(s), and flags any `description` still matching the generic
// auto-generated fallback template ("Definizione e spiegazione di <term>
// per frontalieri…" — see services/seo/glossaryTermDefinitions.ts and its
// GLOSSARY_PLACEHOLDER_DESCRIPTION_RX). Every real term must have a
// backfilled entry in that shared map; a live page still showing the
// template means either a new term id was added without a definition, or a
// past regression slipped through.
//
// Mirrors scripts/check-sitemap-shard-size.mjs: pure Node stdlib + native
// fetch, JSON report on disk, exit code drives the calling workflow.
//
// Exit codes:
//   0 — every term page has a real definition
//   1 — at least one term page still ships the placeholder
//   2 — fetch/parse error (sitemap unreachable or empty)

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flatString } from './lib/flat-string.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const SITEMAP_URL = 'https://frontaliereticino.ch/sitemap-glossario.xml';
const USER_AGENT = 'FrontaliereTicino-Bot/1.0';
const FETCH_TIMEOUT_MS = 20_000;
const REPORT_PATH = resolve(PROJECT_ROOT, 'data/glossario-definitions-report.json');

// Same literal pattern as GLOSSARY_PLACEHOLDER_DESCRIPTION_RX in
// services/seo/glossaryTermDefinitions.ts. Duplicated here (not imported)
// because this script runs standalone via plain Node against dist/live HTML,
// not through the Vite/TS module graph — kept in sync manually, both are
// small and stable regexes documenting the same known fallback string.
const PLACEHOLDER_RX = /^Definizione e spiegazione di .+ per frontalieri/i;

const EXIT_OK = 0;
const EXIT_PLACEHOLDER_FOUND = 1;
const EXIT_FETCH_ERROR = 2;

/**
 * Fetch a URL with a polite UA + timeout. Returns response text or throws.
 */
async function politeFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function extractLocs(xml) {
  // flatString: la capture affetta DENTRO l'intero XML. Qui il padre è uno
  // solo e piccolo, ma il costrutto è quello che ha fatto OOM la catena BFS
  // — vedi scripts/lib/flat-string.mjs (issue #7419).
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => flatString(m[1].trim()));
}

/** Extract every `DefinedTerm.description` found in a page's JSON-LD blocks. */
function extractDefinedTermDescriptions(html) {
  const scripts = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
  const descriptions = [];
  for (const [, raw] of scripts) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // tolerate any non-JSON/malformed block — not this script's concern
    }
    const nodes = Array.isArray(parsed) ? parsed : (parsed['@graph'] || [parsed]);
    for (const node of nodes) {
      if (node && node['@type'] === 'DefinedTerm' && typeof node.description === 'string') {
        descriptions.push(node.description);
      }
    }
  }
  return descriptions;
}

async function main() {
  console.log(`[glossario-definitions] fetching ${SITEMAP_URL}`);

  let sitemapXml;
  try {
    sitemapXml = await politeFetch(SITEMAP_URL);
  } catch (err) {
    console.error(`[glossario-definitions] failed to fetch sitemap: ${err.message}`);
    process.exit(EXIT_FETCH_ERROR);
  }

  const urls = extractLocs(sitemapXml).filter((u) => /\/glossario-frontaliere\/[^/]+\/?$/.test(u));
  if (urls.length === 0) {
    console.error('[glossario-definitions] sitemap-glossario.xml contained zero term-detail <loc> entries');
    process.exit(EXIT_FETCH_ERROR);
  }
  console.log(`[glossario-definitions] found ${urls.length} term page(s)`);

  const flagged = [];
  let fetchErrors = 0;

  for (const url of urls) {
    try {
      const html = await politeFetch(url);
      const descriptions = extractDefinedTermDescriptions(html);
      for (const description of descriptions) {
        if (PLACEHOLDER_RX.test(description.trim())) {
          flagged.push({ url, description });
        }
      }
    } catch (err) {
      fetchErrors += 1;
      console.error(`[glossario-definitions] failed to fetch ${url}: ${err.message}`);
    }
  }

  const report = {
    _generatedAt: new Date().toISOString(),
    termPageCount: urls.length,
    fetchErrors,
    flagged,
  };

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`[glossario-definitions] report written to ${REPORT_PATH}`);
  console.log(
    `[glossario-definitions] summary: ${urls.length} pages, ${flagged.length} placeholder(s), ${fetchErrors} fetch error(s)`,
  );

  if (flagged.length > 0) process.exit(EXIT_PLACEHOLDER_FOUND);
  process.exit(EXIT_OK);
}

main().catch((err) => {
  console.error('[glossario-definitions] unexpected error:', err);
  process.exit(EXIT_FETCH_ERROR);
});
