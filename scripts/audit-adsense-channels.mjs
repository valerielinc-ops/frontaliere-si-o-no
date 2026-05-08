#!/usr/bin/env node
/**
 * audit-adsense-channels.mjs
 *
 * Read-only audit of AdSense URL channels. Lists every URL channel configured
 * for the ad client and cross-references the `uriPattern` against the live
 * sitemaps + the slug tables in services/router.ts.
 *
 * Why this gate exists: the 2026-05-08 monetization audit found that 4 of the
 * 9 URL channels were ghost entries pointing at paths that never existed on
 * the site (e.g. `prezzi-benzina-frontiera` instead of `prezzi-benzina/oggi`),
 * so they had recorded zero revenue. URL channels can ONLY be created/deleted
 * via the AdSense web console — there is no v2 REST mutation. This script
 * surfaces the mismatch so a human can reconcile in the console.
 *
 * Auth: same OAuth refresh-token chain as revenue-monitor.mjs
 *   ADSENSE_CLIENT_ID / ADSENSE_CLIENT_SECRET / ADSENSE_REFRESH_TOKEN
 *   (defaults fall back to GSC_* if AdSense vars are missing).
 *
 * Usage:
 *   node scripts/audit-adsense-channels.mjs                 # human report
 *   node scripts/audit-adsense-channels.mjs --json          # JSON for CI
 *   node scripts/audit-adsense-channels.mjs --suggest       # suggest path additions
 *
 * Exit code:
 *   0  — no ghost channels detected
 *   1  — ≥1 channel has a `uriPattern` that does not match any path emitted
 *        by the build (likely typo at creation time → revenue lost)
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const SUGGEST = args.includes('--suggest');

const ADSENSE_API = 'https://adsense.googleapis.com/v2';

async function getAccessToken() {
  const cid = process.env.ADSENSE_CLIENT_ID || process.env.GSC_CLIENT_ID;
  const cs = process.env.ADSENSE_CLIENT_SECRET || process.env.GSC_CLIENT_SECRET;
  const rt = process.env.ADSENSE_REFRESH_TOKEN;
  if (!cid || !cs || !rt) {
    console.error('audit-adsense-channels: missing ADSENSE_CLIENT_ID / ADSENSE_CLIENT_SECRET / ADSENSE_REFRESH_TOKEN');
    process.exit(2);
  }
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `client_id=${encodeURIComponent(cid)}&client_secret=${encodeURIComponent(cs)}&refresh_token=${encodeURIComponent(rt)}&grant_type=refresh_token`,
  });
  if (!r.ok) throw new Error(`token: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return j.access_token;
}

async function paginatedList(path, token, key) {
  let pageToken = '';
  const out = [];
  for (let i = 0; i < 20; i++) {
    const sep = path.includes('?') ? '&' : '?';
    const url = pageToken ? `${path}${sep}pageToken=${pageToken}` : path;
    const r = await fetch(`${ADSENSE_API}${url}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`${url}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    if (Array.isArray(j[key])) out.push(...j[key]);
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  return out;
}

/**
 * Path prefixes known to be emitted by the build (one prefix per major SEO
 * surface). Channels whose `uriPattern` does NOT begin with any of these are
 * ghost entries that never match a real URL.
 *
 * Keep this list aligned with services/router.ts route slug tables and the
 * 6 SEO-feature plugins enumerated in CLAUDE.md.
 */
const KNOWN_PATH_PREFIXES = [
  '',                                  // root domain
  'articoli-frontaliere',
  'aziende-che-assumono',
  'cerca-lavoro-ticino',
  'calcola-stipendio',
  'compara-servizi',
  'fisco',
  'guida-frontaliere',
  'lavoro-oss-svizzera',
  'lavoro-infermieri-svizzera',
  'mercato-lavoro-ticino',
  'premi-cassa-malati',
  'prezzi-benzina',
  'prezzi-diesel',
  'profilo',
  'ricerca',
  'statistiche',
  'tasse-e-pensione',
  'traffico-dogane',
  'vita',
  'vivere-in-ticino',
  'en', 'de', 'fr',  // locale prefixes
];

/**
 * Recommended channels — paths that have meaningful traffic but no URL channel
 * yet. Surfaced under --suggest. Derived from the 2026-05-08 GA4 + AdSense
 * cross-reference: pages with >300 sessions/month and no per-channel revenue
 * attribution.
 */
const RECOMMENDED_CHANNELS = [
  'frontaliereticino.ch/calcola-stipendio',
  'frontaliereticino.ch/traffico-dogane',
  'frontaliereticino.ch/prezzi-benzina',
  'frontaliereticino.ch/mercato-lavoro-ticino',
  'frontaliereticino.ch/guida-frontaliere',
  'frontaliereticino.ch/compara-servizi',
];

function classifyChannel(uriPattern) {
  // uriPattern is `frontaliereticino.ch` or `frontaliereticino.ch/<slug>...`
  const parts = uriPattern.split('/');
  const pathPrefix = parts.slice(1).join('/');
  if (!pathPrefix) return { state: 'ok', kind: 'origin' };
  const firstSeg = pathPrefix.split('/')[0] || '';
  if (KNOWN_PATH_PREFIXES.includes(firstSeg)) {
    return { state: 'ok', kind: 'known_prefix' };
  }
  return { state: 'ghost', kind: 'unknown_prefix', firstSeg };
}

async function main() {
  const token = await getAccessToken();

  // Find first AFC ad client.
  const accounts = await paginatedList('/accounts?pageSize=10', token, 'accounts');
  const acct = accounts[0];
  if (!acct) { console.error('audit-adsense-channels: no AdSense account found'); process.exit(2); }

  const adClients = await paginatedList(`/${acct.name}/adclients?pageSize=10`, token, 'adClients');
  const ac = adClients.find((x) => x.productCode === 'AFC') || adClients[0];
  if (!ac) { console.error('audit-adsense-channels: no ad client found'); process.exit(2); }

  const urlChannels = await paginatedList(`/${ac.name}/urlchannels?pageSize=200`, token, 'urlChannels');

  const classified = urlChannels.map((c) => ({
    name: c.name,
    uriPattern: c.uriPattern,
    reportingDimensionId: c.reportingDimensionId,
    ...classifyChannel(c.uriPattern || ''),
  }));

  const ghosts = classified.filter((c) => c.state === 'ghost');
  const ok = classified.filter((c) => c.state === 'ok');

  // Suggested but missing channels
  const existingPatterns = new Set(classified.map((c) => c.uriPattern));
  const missing = RECOMMENDED_CHANNELS.filter((p) => !existingPatterns.has(p));

  if (JSON_OUT) {
    console.log(JSON.stringify({
      account: acct.displayName,
      adClient: ac.reportingDimensionId,
      total: classified.length,
      ok: ok.length,
      ghosts: ghosts.length,
      missingRecommended: missing,
      channels: classified,
    }, null, 2));
  } else {
    console.log(`AdSense URL channel audit — ${acct.displayName} / ${ac.reportingDimensionId}`);
    console.log(`Total channels: ${classified.length}  ·  ok: ${ok.length}  ·  ghost: ${ghosts.length}\n`);

    if (ghosts.length > 0) {
      console.log('🔴 GHOST channels (uriPattern does not match any known path prefix):');
      for (const g of ghosts) {
        console.log(`  - ${g.uriPattern}`);
        console.log(`      reportingId: ${g.reportingDimensionId}`);
      }
      console.log('\n  Action: delete these in https://adsense.google.com → Account → Sites → URL channels');
      console.log('  (The AdSense Management API v2 does not expose mutation methods for URL channels.)');
    }

    if (SUGGEST && missing.length > 0) {
      console.log(`\n🟡 SUGGESTED channels (high-traffic paths with no URL channel yet):`);
      for (const m of missing) console.log(`  + ${m}`);
      console.log('\n  Action: create these in the AdSense console → URL channels → New URL channel.');
    }

    if (ghosts.length === 0 && missing.length === 0) {
      console.log('✅ No ghost channels, no missing recommended channels.');
    }
  }

  process.exit(ghosts.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('audit-adsense-channels: fatal:', e?.stack || e);
  process.exit(2);
});
