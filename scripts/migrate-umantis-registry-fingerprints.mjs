#!/usr/bin/env node
/**
 * One-shot migration for umantis slug-registry fingerprints.
 *
 * Root cause (2026-07-10 audit, KSA/GKB poisoning): extractJobIdentityFromUrl
 * used registrableDomain(host), collapsing every umantis tenant onto
 * `umantis.com`, so the PER-TENANT vacancy-id sequences collided across
 * employers and `id|umantis.com|<vid>` registry entries were shared between
 * companies (e.g. GKB's Immobilienbewerter vs KSA's Pflegefachfrau, both
 * vacancy 1910). The shared entry cross-pinned one company's slugs onto the
 * other's job on every crawl/relocalize cycle.
 *
 * The identity fix keys umantis jobs on the FULL host
 * (`id|recruitingapp-<tenant>.umantis.com|<vid>`). This script migrates the
 * EXISTING `id|umantis.com|<vid>` entries to the new key space so healthy
 * pins keep resolving:
 *
 *   - Ownership is determined by matching the entry's canonicalSlug /
 *     slugByLocale values against the per-crawler slices (active + expired):
 *     the owner is the tenant whose slice actually carries those slugs, with
 *     a company-token tie-break (slug text names the company) when poisoned
 *     copies make the slug appear in more than one tenant's slice.
 *   - Single unambiguous owner → the entry moves WHOLE to the owner's
 *     full-host key (createdAt preserved).
 *   - Contested vacancy id (several tenants) → a per-tenant entry is created
 *     ONLY from values that unambiguously belong to that tenant; ambiguous
 *     pin values are DROPPED (logged) — the writer guards re-register real
 *     values on the next crawl (registerJobSlug / backfillRegistryLocaleSlugs).
 *   - Orphan entries (no umantis job with that vacancy id in any slice) are
 *     left in place under the old key: after the identity fix the old key is
 *     never derived again, so they are inert; keeping them preserves the
 *     audit trail. Reported separately.
 *   - A destination key that already exists (written post-fix by a crawl) is
 *     immutable — the migrating entry is dropped in its favor (logged).
 *
 * Usage:
 *   node scripts/migrate-umantis-registry-fingerprints.mjs           # dry-run
 *   node scripts/migrate-umantis-registry-fingerprints.mjs --apply   # write
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(ROOT, 'data', 'slug-registry.json');
const ACTIVE_DIR = path.join(ROOT, 'data', 'jobs', 'by-crawler');
const EXPIRED_DIR = path.join(ROOT, 'data', 'jobs', 'expired', 'by-crawler');

const UMANTIS_URL_RE = /recruitingapp-(\d+)\.umantis\.com\/vacancies\/(\d+)/i;
const OLD_KEY_RE = /^id\|umantis\.com\|(.+)$/;

function slugTokens(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4);
}

/**
 * Scan active + expired per-crawler slices and index every umantis job by
 * vacancy id. Each candidate carries the tenant id, the slice file, the full
 * set of slugs the job has ever claimed (active + previousSlugs, both
 * shapes), and the company tokens for the tie-break.
 *
 * @param {string[]} dirs directories containing per-crawler slice JSON files
 * @returns {Map<string, Array<{tenant:string,file:string,slugSet:Set<string>,companyTokens:Set<string>}>>}
 */
export function buildUmantisJobIndex(dirs = [ACTIVE_DIR, EXPIRED_DIR]) {
  const byVacancy = new Map();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch { continue; }
      const jobs = Array.isArray(parsed) ? parsed : (parsed?.jobs || []);
      for (const job of jobs) {
        const m = UMANTIS_URL_RE.exec(String(job?.url || '').toLowerCase());
        if (!m) continue;
        const [, tenant, vid] = m;
        const slugSet = new Set();
        if (job.slug) slugSet.add(String(job.slug));
        for (const s of Object.values(job.slugByLocale || {})) if (s) slugSet.add(String(s));
        for (const s of (Array.isArray(job.previousSlugs) ? job.previousSlugs : [])) if (s) slugSet.add(String(s));
        for (const arr of Object.values(job.previousSlugsByLocale || {})) {
          for (const s of (arr || [])) if (s) slugSet.add(String(s));
        }
        const companyTokens = new Set(slugTokens(job.company || ''));
        if (!byVacancy.has(vid)) byVacancy.set(vid, []);
        const bucket = byVacancy.get(vid);
        const existing = bucket.find((c) => c.tenant === tenant);
        if (existing) {
          for (const s of slugSet) existing.slugSet.add(s);
          for (const t of companyTokens) existing.companyTokens.add(t);
        } else {
          bucket.push({ tenant, file: f, slugSet, companyTokens });
        }
      }
    }
  }
  return byVacancy;
}

function entrySlugValues(entry) {
  const values = new Set();
  if (entry?.canonicalSlug) values.add(String(entry.canonicalSlug));
  for (const s of Object.values(entry?.slugByLocale || {})) if (s) values.add(String(s));
  return [...values];
}

/**
 * Which candidate tenants does a single slug value belong to?
 * Slice membership is authoritative; when a poisoned copy makes the slug
 * appear under several tenants, the company-token tie-break (slug text names
 * exactly one candidate's company) decides; otherwise the value is ambiguous.
 */
function attributeValue(value, candidates) {
  const bySlice = candidates.filter((c) => c.slugSet.has(value));
  if (bySlice.length === 1) return bySlice[0];
  const pool = bySlice.length > 1 ? bySlice : candidates;
  const tokens = new Set(slugTokens(value));
  // Strict-max company-token score: companies sharing a city token (Kanton
  // Aargau vs Kantonsspital AARAU) both match ≥1 token, so a boolean check is
  // ambiguous — the owner is the candidate matching STRICTLY more tokens.
  let best = null;
  let bestScore = 0;
  let tied = false;
  for (const c of pool) {
    const score = [...c.companyTokens].filter((t) => tokens.has(t)).length;
    if (score > bestScore) { best = c; bestScore = score; tied = false; }
    else if (score === bestScore && score > 0) { tied = true; }
  }
  if (best && bestScore > 0 && !tied) return best;
  return null;
}

/**
 * Pure migration: returns { registry, stats, log } without touching disk.
 *
 * @param {Record<string, object>} registry
 * @param {Map<string, Array>} jobIndex from buildUmantisJobIndex()
 */
export function migrateUmantisRegistry(registry, jobIndex) {
  const out = { ...registry };
  const stats = {
    umantisEntries: 0,
    migratedWhole: 0,
    contested: 0,
    splitEntriesCreated: 0,
    droppedEntries: 0,
    droppedPinValues: 0,
    orphansLeft: 0,
    destConflicts: 0,
  };
  const log = [];

  for (const key of Object.keys(registry)) {
    const m = OLD_KEY_RE.exec(key);
    if (!m) continue;
    stats.umantisEntries += 1;
    const vid = m[1];
    const entry = registry[key];
    const candidates = jobIndex.get(vid) || [];

    if (candidates.length === 0) {
      stats.orphansLeft += 1;
      log.push(`ORPHAN  ${key} — no umantis job with vacancy ${vid} in any slice; left in place (inert key)`);
      continue;
    }

    const values = entrySlugValues(entry);
    const tenants = [...new Set(candidates.map((c) => c.tenant))];

    // Attribute every pin value to a tenant (or null = ambiguous).
    const byTenant = new Map(); // tenant -> Set(values)
    const ambiguous = [];
    for (const v of values) {
      const owner = attributeValue(v, candidates);
      if (owner) {
        if (!byTenant.has(owner.tenant)) byTenant.set(owner.tenant, new Set());
        byTenant.get(owner.tenant).add(v);
      } else {
        ambiguous.push(v);
      }
    }

    const owningTenants = [...byTenant.keys()];
    const singleCandidateTenant = tenants.length === 1 ? tenants[0] : null;

    // Whole-entry migration: exactly one owning tenant AND no value attributed
    // elsewhere; also covers the drifted-values case when only one tenant even
    // has this vacancy id (the only possible owner).
    const wholeOwner = owningTenants.length === 1 && ambiguous.length === 0
      ? owningTenants[0]
      : (owningTenants.length === 0 && singleCandidateTenant ? singleCandidateTenant : null);

    if (wholeOwner) {
      const newKey = `id|recruitingapp-${wholeOwner}.umantis.com|${vid}`;
      delete out[key];
      if (out[newKey]) {
        stats.destConflicts += 1;
        stats.droppedEntries += 1;
        log.push(`CONFLICT ${key} → ${newKey} already exists (immutable); old entry dropped`);
      } else {
        out[newKey] = entry; // whole entry, createdAt preserved
        stats.migratedWhole += 1;
        log.push(`MIGRATE ${key} → ${newKey}`);
      }
      continue;
    }

    // Contested: split per tenant, keeping only unambiguous values.
    stats.contested += 1;
    delete out[key];
    for (const [tenant, tenantValues] of byTenant) {
      const newKey = `id|recruitingapp-${tenant}.umantis.com|${vid}`;
      if (out[newKey]) {
        stats.destConflicts += 1;
        log.push(`CONFLICT ${key} split → ${newKey} already exists (immutable); split part dropped`);
        continue;
      }
      const canonicalOk = tenantValues.has(String(entry.canonicalSlug || ''));
      if (!canonicalOk) {
        // Without an attributable canonicalSlug there is no safe master pin —
        // drop this side and let the guards re-register from the live job.
        stats.droppedPinValues += tenantValues.size;
        log.push(`DROP    ${key} split for tenant ${tenant}: canonicalSlug not attributable; ${tenantValues.size} value(s) dropped`);
        continue;
      }
      const slugByLocale = {};
      for (const [locale, s] of Object.entries(entry.slugByLocale || {})) {
        if (s && tenantValues.has(String(s))) slugByLocale[locale] = s;
      }
      out[newKey] = {
        ...entry,
        canonicalSlug: entry.canonicalSlug,
        slugByLocale,
      };
      stats.splitEntriesCreated += 1;
      log.push(`SPLIT   ${key} → ${newKey} (${Object.keys(slugByLocale).length} locale pin(s))`);
    }
    if (ambiguous.length > 0) {
      stats.droppedPinValues += ambiguous.length;
      log.push(`DROP    ${key}: ${ambiguous.length} ambiguous pin value(s) dropped: ${ambiguous.join(', ')}`);
    }
    if (byTenant.size === 0) {
      stats.droppedEntries += 1;
      log.push(`DROP    ${key}: contested with no attributable values; entire entry dropped`);
    }
  }

  return { registry: out, stats, log };
}

function main() {
  const APPLY = process.argv.includes('--apply');
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const jobIndex = buildUmantisJobIndex();
  console.log(`Registry entries: ${Object.keys(registry).length}; umantis vacancy ids in slices: ${jobIndex.size}`);

  const { registry: migrated, stats, log } = migrateUmantisRegistry(registry, jobIndex);

  for (const line of log) console.log('  ' + line);
  console.log('\nSTATS: ' + JSON.stringify(stats, null, 2));
  console.log(`Registry entries after: ${Object.keys(migrated).length}`);

  if (APPLY) {
    writeJsonAtomic(REGISTRY_PATH, migrated);
    console.log(`\n✅ Applied to ${REGISTRY_PATH}`);
  } else {
    console.log('\n(dry-run — pass --apply to write)');
  }
}

const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`
      || import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  main();
}
