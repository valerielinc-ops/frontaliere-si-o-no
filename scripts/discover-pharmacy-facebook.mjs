#!/usr/bin/env node

/**
 * Find candidate Facebook pages for explicitly configured pharmacies.
 *
 * This is discovery only: it never publishes facts from a search result.
 * Facebook frequently serves login/checkpoint HTML to unauthenticated public
 * searches. Discovery therefore reports only public candidates; an optional
 * Graph adapter may corroborate a candidate, but no Page token is required by
 * this workflow and no unverified facts are published from it.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = resolve(REPO_ROOT, 'data/pharmacy-enrichment-sources.json');
const TICINO_PATH = resolve(REPO_ROOT, 'data/pharmacies-ticino-complete.json');
const ITALY_PATH = resolve(REPO_ROOT, 'data/pharmacies-italy-border.json');

function text(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&#39;/gi, "'");
}

export function facebookSearchUrl(pharmacy) {
  const query = encodeURIComponent(`${pharmacy.name} ${pharmacy.city}`.trim());
  return `https://www.facebook.com/public/${query}`;
}

export function extractFacebookCandidateUrls(html) {
  const candidates = new Set();
  for (const match of String(html || '').matchAll(/https?:\/\/(?:www\.)?facebook\.com\/[^\s"'<>\\]+/gi)) {
    let value = decodeHtml(match[0]).replace(/[),.;]+$/, '');
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      const path = url.pathname.toLowerCase();
      if (!['facebook.com', 'www.facebook.com', 'm.facebook.com'].includes(host)) continue;
      if (!path || /^\/(?:public|login|checkpoint|recover|watch|security|ajax|hsts|help|policies|privacy|terms)(?:\/|$)/.test(path)) continue;
      url.search = '';
      url.hash = '';
      candidates.add(url.toString());
    } catch {
      // Ignore malformed links from the search HTML.
    }
  }
  return [...candidates].slice(0, 10);
}

function isBlockedSearchPage(html) {
  return /(?:checkpoint|login|log\s+in|create\s+new\s+account)/i.test(String(html || ''));
}

export async function discoverFacebookCandidates({
  config,
  pharmacies,
  checkedAt = new Date().toISOString(),
  fetchDocument,
} = {}) {
  const configuredIds = config?.providers?.facebook?.discoveryPharmacyIds || [];
  const byId = new Map((pharmacies || []).map((pharmacy) => [pharmacy.id, pharmacy]));
  const candidates = [];
  const warnings = [];

  for (const pharmacyId of configuredIds) {
    const pharmacy = byId.get(pharmacyId);
    if (!pharmacy) {
      warnings.push(`${pharmacyId}: pharmacy is not in the catalogue`);
      continue;
    }
    const searchUrl = facebookSearchUrl(pharmacy);
    try {
      const html = await fetchDocument(searchUrl);
      const urls = extractFacebookCandidateUrls(html);
      const blocked = isBlockedSearchPage(html);
      candidates.push({
        pharmacyId,
        query: text(`${pharmacy.name} ${pharmacy.city}`),
        searchUrl,
        checkedAt,
        status: blocked ? 'public_search_blocked' : urls.length ? 'candidate_needs_identity_verification' : 'no_candidate',
        urls: blocked ? [] : urls,
      });
    } catch (error) {
      candidates.push({
        pharmacyId,
        query: text(`${pharmacy.name} ${pharmacy.city}`),
        searchUrl,
        checkedAt,
        status: 'fetch_failed',
        urls: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { schemaVersion: 1, generatedAt: checkedAt, candidates, warnings };
}

async function defaultFetchDocument(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'FrontaliereTicino-FacebookDiscovery/1.0 (+https://frontaliereticino.ch/bot)' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function main() {
  const outputFlag = process.argv.indexOf('--output');
  const outputPath = outputFlag >= 0 && process.argv[outputFlag + 1]
    ? resolve(process.argv[outputFlag + 1])
    : resolve(REPO_ROOT, 'data/pharmacy-facebook-discovery.json');
  const [config, ticino, italy] = await Promise.all([
    readJson(CONFIG_PATH),
    readJson(TICINO_PATH),
    readJson(ITALY_PATH),
  ]);
  const result = await discoverFacebookCandidates({
    config,
    pharmacies: [...(ticino.pharmacies || []), ...(italy.pharmacies || [])],
    fetchDocument: defaultFetchDocument,
  });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  for (const candidate of result.candidates) {
    console.log(`[facebook-discovery] ${candidate.pharmacyId}: ${candidate.status} (${candidate.urls.length} candidate URL(s))`);
  }
  for (const warning of result.warnings) console.warn(`[facebook-discovery] ${warning}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[facebook-discovery] fatal: ${error?.stack || error}`);
    process.exitCode = 1;
  });
}
