#!/usr/bin/env node
/**
 * build-employer-insights.mjs — rich per-company traffic insights for the
 * cold-outreach "proof page" (/azienda/<companyKey>/).
 *
 * Joins PostHog (historical, HogQL) with data/jobs.json to compute, per company:
 *   - views + distinct visitors PER AD ($pageview on the /cerca-lavoro-<canton>/<slug>/ pages)
 *   - applies PER AD (job_apply event, properties.job_slug) — recent (event is new)
 *   - total candidates (select_content job_board_apply, distinct persons) — historical
 *   - "lost" = views − candidates (interested-but-not-converted) — loss-aversion hook
 *   - weekly views trend
 * Writes one doc per company to Firestore `employer_insights/{companyKey}`.
 *
 * Few BIG queries + local aggregation (not N×queries). Path→company mapping uses
 * the slug (incl. previousSlugs) so URL-rotated ads still attribute correctly.
 *
 * Usage:
 *   eval "$(GOOGLE_APPLICATION_CREDENTIALS=<sa> node scripts/load-rc-env.mjs)"
 *   node scripts/build-employer-insights.mjs                  # dry-run, prints sample
 *   node scripts/build-employer-insights.mjs --company eoc-…  # single company
 *   node scripts/build-employer-insights.mjs --apply          # write Firestore
 *
 * Env: POSTHOG_PERSONAL_API_KEY, POSTHOG_PROJECT_ID, POSTHOG_HOST,
 *      GOOGLE_APPLICATION_CREDENTIALS (for --apply).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFirestoreDb } from './lib/firestore-admin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PERIOD_DAYS = Number(arg('--days', '90'));
const ONLY = arg('--company', null);
const APPLY = has('--apply');

// ───────────────────────── PostHog (HogQL) ─────────────────────────
async function hogql(query) {
  const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
  const projectId = process.env.POSTHOG_PROJECT_ID;
  const host = (process.env.POSTHOG_HOST || 'https://eu.posthog.com').replace(/\/$/, '');
  if (!apiKey || !projectId) throw new Error('no POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID');
  const r = await fetch(`${host}/api/projects/${projectId}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
  });
  if (!r.ok) throw new Error(`posthog ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).results || [];
}

// ───────────────────────── jobs.json mapping ─────────────────────────
function loadJobMaps() {
  const p = ['data/jobs.json', 'public/data/jobs.json'].map((x) => path.join(ROOT, x)).find(fs.existsSync);
  if (!p) throw new Error('jobs.json not found');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const jobs = Array.isArray(raw) ? raw : raw.jobs || [];
  const slugToCompany = new Map();   // slug (current+previous) → companyKey
  const slugToTitle = new Map();
  const companyName = new Map();     // companyKey → display name
  for (const j of jobs) {
    const ck = j.companyKey;
    if (!ck) continue;
    if (j.company) companyName.set(ck, j.company);
    const slugs = new Set([j.slug, ...(j.previousSlugs || [])].filter(Boolean));
    for (const s of slugs) { slugToCompany.set(s, ck); if (j.title && !slugToTitle.has(s)) slugToTitle.set(s, j.title); }
    if (j.slug && j.title) slugToTitle.set(j.slug, j.title);
  }
  return { slugToCompany, slugToTitle, companyName };
}

// last non-empty path segment, e.g. /cerca-lavoro-ticino/<slug>/ → <slug>
const slugFromPath = (p) => String(p || '').split('?')[0].split('#')[0].replace(/\/+$/, '').split('/').pop() || '';

// Derive a human title from a slug when the ad has expired out of jobs.json:
// strip the trailing "-<companyKey>-<location>" and title-case the lead tokens.
function deriveTitle(slug, companyKey) {
  let s = String(slug || '');
  const i = s.indexOf(companyKey);
  if (i > 0) s = s.slice(0, i - 1); // keep the part before "-<companyKey>"
  s = s.replace(/-+$/, '').replace(/-/g, ' ').trim();
  if (!s) return slug;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function main() {
  const { slugToCompany, slugToTitle, companyName } = loadJobMaps();
  const period = `INTERVAL ${PERIOD_DAYS} DAY`;
  // companyKeys longest-first so a substring match picks the most specific key
  // (the key is embedded in every ad slug: "<title>-<companyKey>-<location>").
  const companyKeys = [...companyName.keys()].sort((a, b) => b.length - a.length);
  const keyFromSlug = (slug) => {
    const s = String(slug || '');
    for (const k of companyKeys) if (s.includes(k)) return k;
    return null;
  };

  // Q1 — views + visitors per job-page path (one row per path).
  const viewsRows = await hogql(
    `SELECT properties.$pathname AS path, count() AS views, count(DISTINCT person_id) AS visitors
     FROM events WHERE event='$pageview' AND properties.$pathname LIKE '%cerca-lavoro-%'
     AND timestamp > now() - ${period} GROUP BY path LIMIT 100000`,
  );
  // Q2 — applies per ad (job_apply, recent event).
  const applyRows = await hogql(
    `SELECT properties.job_slug AS slug, count() AS applies, count(DISTINCT person_id) AS persons
     FROM events WHERE event='job_apply' AND coalesce(toString(properties.job_slug),'') != ''
     AND timestamp > now() - ${period} GROUP BY slug LIMIT 100000`,
  );
  // Q3 — historical total candidates per company (select_content job_board_apply).
  const candRows = await hogql(
    `SELECT splitByChar('_', coalesce(toString(properties.item_id),''))[1] AS company,
            count(DISTINCT person_id) AS persons, count(DISTINCT properties.$session_id) AS sessions
     FROM events WHERE event='select_content'
     AND properties.content_type IN ('job_board_apply','job_board_apply_header_logo','job_board_apply_header_title')
     AND timestamp > now() - ${period} GROUP BY company`,
  );
  // Q4 — weekly views trend per path.
  const trendRows = await hogql(
    `SELECT toStartOfWeek(timestamp) AS wk, properties.$pathname AS path, count() AS views
     FROM events WHERE event='$pageview' AND properties.$pathname LIKE '%cerca-lavoro-%'
     AND timestamp > now() - INTERVAL 84 DAY GROUP BY wk, path LIMIT 200000`,
  );

  // Index applies by slug.
  const appliesBySlug = new Map();
  for (const [slug, applies, persons] of applyRows) appliesBySlug.set(slug, { applies: +applies, persons: +persons });
  // Candidate totals: company token from item_id is a loose slug of the name; map via companyName slug match.
  const slugifyName = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const nameTokenToKey = new Map();
  for (const [ck, name] of companyName) nameTokenToKey.set(slugifyName(name), ck);
  const candByKey = new Map();
  for (const [company, persons, sessions] of candRows) {
    const ck = nameTokenToKey.get(slugifyName(company)) || company;
    const v = Math.min(+persons, +sessions); // conservative (matches employer-traffic-report)
    candByKey.set(ck, (candByKey.get(ck) || 0) + v);
  }

  // Aggregate per company.
  const companies = new Map(); // ck → { ads:Map<slug,{title,views,visitors,applies}>, hubViews, trendByWeek:Map }
  const attribute = (pathStr, views, visitors, wk) => {
    const slug = slugFromPath(pathStr);
    let isHub = false;
    let ck = slugToCompany.get(slug);
    if (!ck && slug.startsWith('azienda-')) { ck = slug.replace(/^azienda-/, ''); isHub = true; }
    if (!ck) ck = keyFromSlug(slug); // capture expired ads (slug no longer in jobs.json)
    if (!ck) return;
    if (ONLY && ck !== ONLY) return;
    if (!companies.has(ck)) companies.set(ck, { ads: new Map(), hubViews: 0, trendByWeek: new Map() });
    const c = companies.get(ck);
    if (wk != null) { c.trendByWeek.set(wk, (c.trendByWeek.get(wk) || 0) + (+views || 0)); return; }
    if (isHub) { c.hubViews += +views || 0; return; }
    const a = c.ads.get(slug) || { slug, title: slugToTitle.get(slug) || deriveTitle(slug, ck), views: 0, visitors: 0, applies: 0 };
    a.views += +views || 0; a.visitors += +visitors || 0;
    c.ads.set(slug, a);
  };
  for (const [p, views, visitors] of viewsRows) attribute(p, views, visitors, null);
  for (const [wk, p, views] of trendRows) attribute(p, views, 0, String(wk).slice(0, 10));

  // Build docs.
  const docs = [];
  for (const [ck, c] of companies) {
    let totViews = c.hubViews, totVisitors = 0, totApplies = 0;
    const ads = [];
    for (const a of c.ads.values()) {
      const ap = appliesBySlug.get(a.slug)?.applies || 0;
      const lost = Math.max(0, a.views - ap);
      ads.push({ slug: a.slug, title: a.title, path: `/cerca-lavoro-ticino/${a.slug}/`, views: a.views, visitors: a.visitors, applies: ap, lost });
      totViews += a.views; totVisitors += a.visitors; totApplies += ap;
    }
    ads.sort((x, y) => y.views - x.views);
    const candidates = candByKey.get(ck) || totApplies;
    const lost = Math.max(0, totViews - candidates);
    const trend = [...c.trendByWeek.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([week, views]) => ({ week, views }));
    docs.push({
      companyKey: ck,
      companyName: companyName.get(ck) || ck,
      generatedAt: new Date().toISOString(),
      periodDays: PERIOD_DAYS,
      totals: {
        views: totViews,
        visitors: totVisitors,
        candidates,
        adsCount: ads.length,
        lost,
        conversionRate: totViews ? +(candidates / totViews).toFixed(4) : 0,
      },
      topAd: ads[0] ? { slug: ads[0].slug, title: ads[0].title, views: ads[0].views } : null,
      ads: ads.slice(0, 100),
      trend,
    });
  }
  docs.sort((a, b) => b.totals.views - a.totals.views);

  console.log(`Built insights for ${docs.length} companies (period ${PERIOD_DAYS}d).`);
  const sample = ONLY ? docs.find((d) => d.companyKey === ONLY) : docs[0];
  if (sample) console.log('SAMPLE:', JSON.stringify(sample, null, 1).slice(0, 1400));

  if (!APPLY) { console.log('\n(dry-run — pass --apply to write Firestore employer_insights/*)'); return; }

  const { FieldValue } = await import('firebase-admin/firestore');
  const db = await getFirestoreDb();
  let written = 0;
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    for (const d of docs.slice(i, i + 400)) {
      batch.set(db.collection('employer_insights').doc(d.companyKey), { ...d, updatedAt: FieldValue.serverTimestamp() });
      written++;
    }
    await batch.commit();
  }
  console.log(`✅ Wrote ${written} docs to employer_insights/.`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
