#!/usr/bin/env node
/**
 * Google Search Console — CI/CD Integration Script
 *
 * Runs after deployment (alongside submit-indexnow.js) to:
 *   1. Ping sitemaps (sitemap index + sub-sitemaps + sitemap-news.xml)
 *   2. Inspect a sample of URLs for indexing status (max 20)
 *   3. Query search analytics for last 7 days summary
 *
 * Environment variables (loaded from Firebase Remote Config via load-rc-env.mjs):
 *   GSC_CLIENT_ID      — OAuth2 client ID
 *   GSC_CLIENT_SECRET   — OAuth2 client secret
 *   GSC_REFRESH_TOKEN   — OAuth2 refresh token
 *
 * Mirrors the submit-indexnow.js pattern: sitemap parsing, retry logic, emoji logging.
 * Always exits 0 — failures are logged but never block deployment.
 */

import { readFileSync, existsSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SITE_URL = 'https://frontaliereticino.ch';
const MAX_INSPECT_URLS = 20; // API quota: 2000/day — we use 20 per deploy
const MAX_RETRIES = 2;

// The site may be registered in GSC as a URL-prefix property (https://frontaliereticino.ch)
// or as a domain property (sc-domain:frontaliereticino.ch). We auto-detect at startup.
let RESOLVED_SITE_URL = SITE_URL;
let ENCODED_SITE_URL = encodeURIComponent(SITE_URL);

// ── Helpers ─────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const FETCH_TIMEOUT_MS = 20_000; // 20s per request — prevents indefinite hangs

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

function log(emoji, msg) {
  console.log(`${emoji}  ${msg}`);
}

// ── Detect the correct site property URL registered in GSC ──
async function detectSiteProperty(accessToken) {
  try {
    const res = await fetchWithTimeout(
      'https://www.googleapis.com/webmasters/v3/sites',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!res.ok) {
      log('⚠️', `Elenco siti GSC fallito (${res.status}) — uso default ${SITE_URL}`);
      return;
    }
    const data = await res.json();
    const sites = (data.siteEntry || []).map(s => s.siteUrl);

    // Prefer the exact URL-prefix match
    const urlPrefix = sites.find(s => s === SITE_URL || s === SITE_URL + '/');
    if (urlPrefix) {
      RESOLVED_SITE_URL = urlPrefix.replace(/\/$/, '');
      ENCODED_SITE_URL = encodeURIComponent(RESOLVED_SITE_URL);
      log('✅', `Sito GSC trovato: ${RESOLVED_SITE_URL} (URL-prefix)`);
      return;
    }

    // Try domain property
    const domain = sites.find(s => s.startsWith('sc-domain:') && SITE_URL.includes(s.replace('sc-domain:', '')));
    if (domain) {
      RESOLVED_SITE_URL = domain;
      ENCODED_SITE_URL = encodeURIComponent(domain);
      log('✅', `Sito GSC trovato: ${domain} (domain property)`);
      return;
    }

    // No match — list what's available
    log('⚠️', `Nessun sito corrispondente trovato. Siti registrati: ${sites.join(', ') || '(nessuno)'}`);
    log('ℹ️', `Uso default: ${SITE_URL}`);
  } catch (err) {
    log('⚠️', `Rilevamento sito GSC fallito: ${err.message}`);
  }
}

// ── Service Account JWT auth ────────────────────────────────
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
// GSC needs webmasters scope; Indexing API needs indexing scope
const GSC_SCOPES = [
  'https://www.googleapis.com/auth/webmasters',
  'https://www.googleapis.com/auth/indexing',
].join(' ');

function loadServiceAccount() {
  const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!saPath || !existsSync(saPath)) return null;
  try {
    const sa = JSON.parse(readFileSync(saPath, 'utf-8'));
    if (!sa.client_email || !sa.private_key) return null;
    return sa;
  } catch {
    return null;
  }
}

function createJwt(sa, scope) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iss: sa.client_email, scope, aud: TOKEN_URI, iat: now, exp: now + 3600 };
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64(header)}.${b64(payload)}`;
  const sign = createSign('RSA-SHA256');
  sign.update(unsigned);
  return `${unsigned}.${sign.sign(sa.private_key, 'base64url')}`;
}

async function getAccessTokenFromSA(sa) {
  const jwt = createJwt(sa, GSC_SCOPES);
  const res = await fetchWithTimeout(TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`SA token exchange failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return (await res.json()).access_token;
}

// ── OAuth2 user credentials auth (fallback) ─────────────────
async function getAccessTokenFromOAuth(clientId, clientSecret, refreshToken) {
  const res = await fetchWithTimeout(TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }
  return (await res.json()).access_token;
}

// ── Resolve access token (SA first, then OAuth2) ────────────
async function resolveAccessToken() {
  const sa = loadServiceAccount();
  if (sa) {
    try {
      const token = await getAccessTokenFromSA(sa);
      log('🔑', `Authenticated via Service Account (${sa.client_email})`);
      return token;
    } catch (err) {
      log('⚠️', `SA auth failed: ${err.message}`);
      log('ℹ️', 'Falling back to OAuth2 user credentials...');
    }
  }

  const clientId = process.env.GSC_CLIENT_ID;
  const clientSecret = process.env.GSC_CLIENT_SECRET;
  const refreshToken = process.env.GSC_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;

  const token = await getAccessTokenFromOAuth(clientId, clientSecret, refreshToken);
  log('🔑', 'Authenticated via OAuth2 user credentials');
  return token;
}

// ── Fetch with retry ────────────────────────────────────────
async function fetchWithRetry(url, options, attempt = 1) {
  try {
    const res = await fetchWithTimeout(url, options);
    if (res.ok) return res;

    if ((res.status === 429 || res.status >= 500) && attempt <= MAX_RETRIES) {
      const delay = 2000 * attempt;
      log('⏳', `${res.status} — retry ${attempt}/${MAX_RETRIES} in ${delay / 1000}s`);
      await sleep(delay);
      return fetchWithRetry(url, options, attempt + 1);
    }

    return res; // Return non-OK response for caller to handle
  } catch (err) {
    if (attempt <= MAX_RETRIES) {
      const delay = 2000 * attempt;
      log('⏳', `Network error — retry ${attempt}/${MAX_RETRIES} in ${delay / 1000}s`);
      await sleep(delay);
      return fetchWithRetry(url, options, attempt + 1);
    }
    throw err;
  }
}

// ── Parse sitemaps to extract URLs ──────────────────────────
// Reads from dist/ (post-build output) when available, falls back to public/.
function getUrlsFromSitemap() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const rootDir = resolve(__dirname, '..');
  const urls = new Set();

  const sitemapDir = existsSync(resolve(rootDir, 'dist', 'sitemap-pages.xml'))
    ? resolve(rootDir, 'dist')
    : resolve(rootDir, 'public');

  // sitemap.xml is now a sitemap index — read all sub-sitemaps
  const subSitemaps = ['sitemap-pages.xml', 'sitemap-blog.xml', 'sitemap-glossario.xml', 'sitemap-jobs.xml'];
  for (const file of subSitemaps) {
    try {
      const xml = readFileSync(resolve(sitemapDir, file), 'utf-8');
      for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) urls.add(m[1].trim());
    } catch { /* sub-sitemap may not exist */ }
  }

  // News sitemap
  try {
    const newsXml = readFileSync(resolve(sitemapDir, 'sitemap-news.xml'), 'utf-8');
    for (const m of newsXml.matchAll(/<loc>([^<]+)<\/loc>/g)) urls.add(m[1].trim());
  } catch { /* sitemap-news.xml may not exist */ }

  return [...urls].sort();
}

// ── 1. Sitemap Ping ─────────────────────────────────────────
async function pingSitemaps(accessToken) {
  log('📡', 'Sitemap ping...');

  const sitemaps = [
    `${SITE_URL}/sitemap.xml`,
    `${SITE_URL}/sitemap-pages.xml`,
    `${SITE_URL}/sitemap-blog.xml`,
    `${SITE_URL}/sitemap-glossario.xml`,
    `${SITE_URL}/sitemap-jobs.xml`,
    `${SITE_URL}/sitemap-news.xml`,
  ];

  const headers = { Authorization: `Bearer ${accessToken}` };
  let ok = 0;
  let fail = 0;

  for (const sitemapUrl of sitemaps) {
    const encoded = encodeURIComponent(sitemapUrl);
    const apiUrl = `https://www.googleapis.com/webmasters/v3/sites/${ENCODED_SITE_URL}/sitemaps/${encoded}`;

    try {
      const res = await fetchWithRetry(apiUrl, { method: 'PUT', headers });
      if (res.ok) {
        ok++;
        log('✅', `Sitemap: ${sitemapUrl}`);
      } else {
        fail++;
        const text = await res.text().catch(() => '');
        log('⚠️', `Sitemap ${sitemapUrl}: ${res.status} — ${text.slice(0, 150)}`);
        if (res.status === 403 && text.includes('insufficient authentication scopes')) {
          log('💡', 'Token con scope insufficienti — rigenera con: node scripts/setup-google-oauth.mjs <CLIENT_ID> <CLIENT_SECRET>');
        }
      }
    } catch (err) {
      fail++;
      log('❌', `Sitemap ${sitemapUrl}: ${err.message}`);
    }
  }

  log('📊', `Sitemaps: ${ok} OK, ${fail} errori`);
  return { ok, fail };
}

// ── 1b. WebSub Hub Ping ─────────────────────────────────────
async function pingWebSubHub() {
  log('🔔', 'WebSub hub ping...');
  const HUB_URL = 'https://pubsubhubbub.appspot.com/';
  const feeds = [
    `${SITE_URL}/rss.xml`,
    `${SITE_URL}/rss-en.xml`,
    `${SITE_URL}/rss-de.xml`,
    `${SITE_URL}/rss-fr.xml`,
  ];

  let ok = 0;
  let fail = 0;
  for (const feedUrl of feeds) {
    try {
      const body = new URLSearchParams({
        'hub.mode': 'publish',
        'hub.url': feedUrl,
      });
      const res = await fetchWithRetry(HUB_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (res.ok || res.status === 204) {
        ok++;
        log('✅', `WebSub: ${feedUrl}`);
      } else {
        fail++;
        log('⚠️', `WebSub ${feedUrl}: ${res.status}`);
      }
    } catch (err) {
      fail++;
      log('❌', `WebSub ${feedUrl}: ${err.message}`);
    }
  }
  log('📊', `WebSub: ${ok} OK, ${fail} errori`);
  return { ok, fail };
}

// ── 2. URL Inspection (sample) ──────────────────────────────
async function inspectUrls(accessToken) {
  log('🔍', `URL Inspection (campione di ${MAX_INSPECT_URLS} URL)...`);

  const allUrls = getUrlsFromSitemap();

  // Pick a diverse sample: prioritize high-traffic pages from analytics data
  // These are the top pages by real user engagement (from GA4 analytics)
  const PRIORITY_PATHS = [
    '/',
    '/calcola-stipendio',
    '/calcola-stipendio/stipendio-netto-80000-chf',
    '/calcola-stipendio/stipendio-netto-80000-chf-residenza-entro-20km',
    '/calcola-stipendio/stipendio-netto-80000-chf-residenza-oltre-20km',
    '/calcola-stipendio/simula-busta-paga',
    '/calcola-stipendio/cosa-cambia-se',
    '/tasse-e-pensione/calcola-previdenza',
    '/compara-servizi/cambio-franco-euro',
    '/statistiche',
    '/statistiche/storico-traffico-dogane',
    '/compara-servizi',
    '/compara-servizi/traffico-valichi-svizzera',
    '/compara-servizi/confronta-banche',
    '/compara-servizi/confronta-operatori-mobili',
    '/compara-servizi/confronta-casse-malati',
    '/guida-frontaliere',
    '/guida-frontaliere/primo-giorno-lavoro',
    '/vivere-in-ticino/comuni-di-frontiera',
    '/buongiorno-frontaliere',
  ];

  const italianUrls = allUrls.filter(u => {
    const path = new URL(u).pathname;
    return !path.startsWith('/en/') && !path.startsWith('/de/') && !path.startsWith('/fr/');
  });

  // Start with priority URLs, then fill remaining slots
  const priorityUrls = PRIORITY_PATHS
    .map(p => `${SITE_URL}${p}`)
    .filter(u => allUrls.includes(u));
  const otherItalian = italianUrls.filter(u => !priorityUrls.includes(u));
  const sample = [...priorityUrls, ...otherItalian].slice(0, MAX_INSPECT_URLS);

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  const verdicts = { PASS: 0, PARTIAL: 0, FAIL: 0, NEUTRAL: 0, UNKNOWN: 0 };
  const issues = [];

  for (const inspectionUrl of sample) {
    try {
      const res = await fetchWithRetry(
        'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            inspectionUrl,
            siteUrl: RESOLVED_SITE_URL,
          }),
        }
      );

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // 403 or quota exhausted — stop inspection but don't fail
        if (res.status === 403 || res.status === 429) {
          log('⚠️', `Inspection API limitata (${res.status}) — stop campione`);
          if (res.status === 403 && text.includes('insufficient authentication scopes')) {
            log('💡', 'Token con scope insufficienti — rigenera con: node scripts/setup-google-oauth.mjs <CLIENT_ID> <CLIENT_SECRET>');
          }
          break;
        }
        verdicts.UNKNOWN++;
        continue;
      }

      const data = await res.json();
      const result = data.inspectionResult?.indexStatusResult;
      const verdict = result?.verdict || 'UNKNOWN';
      verdicts[verdict] = (verdicts[verdict] || 0) + 1;

      if (verdict === 'FAIL') {
        const path = new URL(inspectionUrl).pathname;
        const reason = result?.coverageState || 'unknown';
        issues.push({ path, reason });
      }

      // Be gentle with the API — 100ms between requests
      await sleep(100);
    } catch (err) {
      verdicts.UNKNOWN++;
    }
  }

  // Print verdict summary
  const total = Object.values(verdicts).reduce((a, b) => a + b, 0);
  log('📊', `Inspection: ${total} URLs controllati`);
  if (verdicts.PASS > 0)    log('  ✅', `PASS:    ${verdicts.PASS}`);
  if (verdicts.PARTIAL > 0) log('  🟡', `PARTIAL: ${verdicts.PARTIAL}`);
  if (verdicts.FAIL > 0)    log('  ❌', `FAIL:    ${verdicts.FAIL}`);
  if (verdicts.NEUTRAL > 0) log('  ⚪', `NEUTRAL: ${verdicts.NEUTRAL}`);
  if (verdicts.UNKNOWN > 0) log('  ❓', `UNKNOWN: ${verdicts.UNKNOWN}`);

  // List failed URLs
  if (issues.length > 0) {
    log('⚠️', 'URLs non indicizzati:');
    for (const { path, reason } of issues) {
      log('  ', `  ${path} — ${reason}`);
    }
  }

  return verdicts;
}

// ── 3. Search Analytics Summary (last 7 days) ──────────────
async function getSearchAnalytics(accessToken) {
  log('📈', 'Search Analytics (ultimi 7 giorni)...');

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 7);

  const fmt = (d) => d.toISOString().split('T')[0];

  try {
    const res = await fetchWithRetry(
      `https://www.googleapis.com/webmasters/v3/sites/${ENCODED_SITE_URL}/searchAnalytics/query`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          startDate: fmt(startDate),
          endDate: fmt(endDate),
          dimensions: [],
          rowLimit: 1,
        }),
      }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log('⚠️', `Search Analytics: ${res.status} — ${text.slice(0, 150)}`);
      return null;
    }

    const data = await res.json();
    const row = data.rows?.[0];

    if (!row) {
      log('ℹ️', 'Nessun dato Search Analytics disponibile (sito nuovo o pochi dati)');
      return null;
    }

    const clicks = row.clicks || 0;
    const impressions = row.impressions || 0;
    const ctr = ((row.ctr || 0) * 100).toFixed(1);
    const position = (row.position || 0).toFixed(1);

    log('📊', '┌──────────────────────────────────────┐');
    log('📊', '│  Search Console — Ultimi 7 giorni    │');
    log('📊', '├──────────────────────────────────────┤');
    log('📊', `│  Click:       ${String(clicks).padStart(10)}           │`);
    log('📊', `│  Impressioni: ${String(impressions).padStart(10)}           │`);
    log('📊', `│  CTR:         ${String(ctr + '%').padStart(10)}           │`);
    log('📊', `│  Posizione:   ${String(position).padStart(10)}           │`);
    log('📊', '└──────────────────────────────────────┘');

    return { clicks, impressions, ctr: parseFloat(ctr), position: parseFloat(position) };
  } catch (err) {
    log('⚠️', `Search Analytics errore: ${err.message}`);
    return null;
  }
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  console.log('');
  log('🔎', 'Google Search Console — Post-deploy Integration');
  console.log('═'.repeat(52));

  try {
    // Authenticate (SA first, then OAuth2)
    let accessToken;
    try {
      accessToken = await resolveAccessToken();
    } catch (err) {
      log('⚠️', `Authentication failed: ${err.message}`);
      process.exit(0);
    }

    if (!accessToken) {
      log('ℹ️', 'No credentials available (GOOGLE_APPLICATION_CREDENTIALS or GSC_* env vars) — skip');
      process.exit(0);
    }
    console.log('');

    // Detect which site property is registered in GSC
    await detectSiteProperty(accessToken);
    console.log('');

    // 1. Ping sitemaps
    await pingSitemaps(accessToken);
    console.log('');

    // 1b. Notify WebSub hub (no auth needed)
    await pingWebSubHub();
    console.log('');

    // 2. Inspect sample URLs
    await inspectUrls(accessToken);
    console.log('');

    // 3. Search analytics summary
    await getSearchAnalytics(accessToken);
    console.log('');

    log('✅', 'Google Search Console integration completata');
  } catch (err) {
    log('❌', `Errore: ${err.message}`);
    log('ℹ️', 'Questo errore non blocca il deploy — continue-on-error attivo');
  }

  // Always exit 0 — this script must never block deployment
  console.log('');
  process.exit(0);
}

main();
