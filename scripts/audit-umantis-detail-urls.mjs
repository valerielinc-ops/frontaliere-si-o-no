#!/usr/bin/env node
/**
 * Deterministic audit: probe every Umantis tenant's vacancy detail URL and flag
 * which tenants now 3xx-redirect `/Vacancies/{id}/Description/1` AWAY from the
 * umantis host (issue #1245). A cross-host redirect means the tenant deprecated
 * the Umantis detail page (→ public career site / migrated ATS such as
 * Prospective): the detail URL is "dead", carries no per-job body, and our
 * crawler now QUARANTINES those jobs instead of synthesising boilerplate.
 *
 * This makes the migration WAVE visible so we know which tenants need a
 * per-tenant description-recovery follow-up (out of scope for the quarantine
 * fix itself).
 *
 * Tenant discovery is DYNAMIC: we grep the dedicated parser files for
 * `recruitingapp-{ID}.umantis.com`, so the audit stays correct as tenants are
 * added/removed without a hardcoded registry to maintain.
 *
 * Usage:
 *   node scripts/audit-umantis-detail-urls.mjs            # all discovered tenants
 *   node scripts/audit-umantis-detail-urls.mjs 2782 2562  # only these tenants
 *   node scripts/audit-umantis-detail-urls.mjs --json     # machine-readable
 *
 * Exit code: 0 always (report-only — never gate CI on a live third-party probe).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCrossHostRedirect } from './lib/umantis-detail-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.resolve(__dirname, 'lib');

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';
const TIMEOUT_MS = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20_000;

/** Discover all `recruitingapp-{ID}.umantis.com` tenants referenced by parsers. */
function discoverTenants() {
  const tenants = new Set();
  for (const file of fs.readdirSync(LIB_DIR)) {
    if (!file.endsWith('-job-parser.mjs') && file !== 'umantis-listing-common.mjs') continue;
    const src = fs.readFileSync(path.join(LIB_DIR, file), 'utf-8');
    const rx = /recruitingapp-(\d+)\.umantis\.com/g;
    let m;
    while ((m = rx.exec(src))) tenants.add(m[1]);
  }
  return [...tenants].sort((a, b) => Number(a) - Number(b));
}

async function fetchText(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' },
      signal: controller.signal,
      ...opts,
    });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/** Grab the first real vacancy ID from a tenant's `/Jobs/All` listing. */
async function firstVacancyId(baseUrl) {
  const res = await fetchText(`${baseUrl}/Jobs/All?lang=ger`, { redirect: 'follow' });
  if (!res.ok) return null;
  const html = await res.text();
  const rx = /\/Vacancies\/(\d+)\/Description\/\d+/g;
  let m;
  while ((m = rx.exec(html))) {
    if (m[1] !== '9999') return m[1]; // 9999 = initiative-application placeholder
  }
  return null;
}

/**
 * Probe one tenant. Returns a status record:
 *   - status: 'ok' (same-host 2xx/3xx → live)
 *             'dead-detail' (cross-host 3xx → migrated away)
 *             'no-listings' (listing empty / unreachable)
 *             'error' (network failure)
 */
async function probeTenant(tenantId) {
  const baseUrl = `https://recruitingapp-${tenantId}.umantis.com`;
  try {
    const vacancyId = await firstVacancyId(baseUrl);
    if (!vacancyId) {
      return { tenantId, status: 'no-listings', detail: 'no vacancies on /Jobs/All' };
    }
    const detailUrl = `${baseUrl}/Vacancies/${vacancyId}/Description/1?lang=ger`;
    const res = await fetchText(detailUrl, { redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location') || '';
      if (isCrossHostRedirect(detailUrl, location)) {
        let dest = location;
        try { dest = new URL(location, detailUrl).hostname; } catch { /* keep raw */ }
        return {
          tenantId,
          status: 'dead-detail',
          detail: `${res.status} → ${dest}`,
          vacancyId,
          location,
        };
      }
      return { tenantId, status: 'ok', detail: `${res.status} same-host redirect`, vacancyId };
    }
    return { tenantId, status: 'ok', detail: `HTTP ${res.status}`, vacancyId };
  } catch (err) {
    return { tenantId, status: 'error', detail: err?.message || String(err) };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOut = args.includes('--json');
  const explicit = args.filter((a) => /^\d+$/.test(a));
  const tenants = explicit.length > 0 ? explicit : discoverTenants();

  if (!jsonOut) {
    console.log(`🔍 Auditing ${tenants.length} Umantis tenant(s) for deprecated (cross-host-redirecting) detail URLs...\n`);
  }

  const results = [];
  for (const tenantId of tenants) {
    const r = await probeTenant(tenantId);
    results.push(r);
    if (!jsonOut) {
      const icon = r.status === 'dead-detail' ? '🔴'
        : r.status === 'ok' ? '🟢'
        : r.status === 'no-listings' ? '⚪️'
        : '🟡';
      console.log(`  ${icon} ${r.tenantId.padEnd(8)} ${r.status.padEnd(12)} ${r.detail}`);
    }
    await new Promise((res) => setTimeout(res, 250)); // politeness
  }

  const dead = results.filter((r) => r.status === 'dead-detail');

  if (jsonOut) {
    console.log(JSON.stringify({ total: results.length, deadDetailCount: dead.length, results }, null, 2));
  } else {
    console.log(`\n📊 Summary: ${dead.length}/${results.length} tenant(s) have a deprecated detail URL (migrated away).`);
    if (dead.length > 0) {
      console.log(`   Dead-detail tenants: ${dead.map((r) => r.tenantId).join(', ')}`);
      console.log(`   These are auto-quarantined by the crawler (issue #1245). Per-tenant description recovery is a tracked follow-up.`);
    }
  }
  // Report-only: never fail CI on a live third-party probe.
  process.exit(0);
}

main();
