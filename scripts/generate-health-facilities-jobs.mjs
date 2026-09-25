#!/usr/bin/env node
/**
 * generate-health-facilities-jobs — epic #4455 / sub #4456.
 *
 * Matches the curated Swiss hospital directory (`data/swiss-hospitals.json`)
 * against the live job corpus (`data/jobs.json`) and writes the committed
 * facility registry `data/health-facilities-jobs.json`, a small GENERATED
 * file (never hand-edit).
 *
 * The registry is the STABLE universe of health-facility pages: one entry per
 * crawler employer (`companyKey`) that maps to a directory hospital. It stores
 * the `companyKeys` used to select that employer's jobs at build time plus a
 * snapshot of the job count / role mix / median salary. The build plugin
 * (`build-plugins/healthFacilitiesPlugin.ts`) re-derives the LIVE counts from
 * the freshly-assembled `data/jobs.json` every build, so the snapshot numbers
 * here are informational — the universe (which paths exist, for the self-map
 * in searchConsoleCompat.ts) is what must stay committed and stable.
 *
 * Matching (see build-plugins/healthFacilitiesMatch.ts):
 *   1. employer-name match (primary)
 *   2. city geo-proximity fallback (secondary) — a hospital-typed employer in
 *      the same city+canton as an unmatched directory hospital. Swiss cities
 *      validated against data/canton-municipalities.json.
 * `data/municipalities-geocoded.json` (Italian border municipalities) supplies
 * the per-canton frontaliere commuter origins attached to each facility.
 *
 * Run: npx tsx scripts/generate-health-facilities-jobs.mjs
 */
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  employerMatchesHospital,
  isHospitalTypeName,
  extractHospitalCity,
  facilityCore,
  foldName,
  normalizeCategory,
  classifyHealthcareRole,
} from '../build-plugins/healthFacilitiesMatch.ts';
import { realSalaryMedianChf } from '../build-plugins/shared/realSalaryMedian.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** Job-count floor: facilities with fewer live jobs render a noindex bridge. */
const MIN_JOBS_FLOOR = 3;

/** Cantons that border Italy → frontaliere commuter origins (province codes as
 * they appear in data/municipalities-geocoded.json keys, e.g. "…|CO"). */
const CANTON_BORDER_PROVINCES = {
  TI: ['CO', 'VA', 'VB'],
  GR: ['SO', 'BS'],
  VS: ['VB'],
};

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));
}

function main() {
  const jobs = readJson('data/jobs.json');
  const hospitals = readJson('data/swiss-hospitals.json').hospitals || [];
  const cantonMunicipalities = readJson('data/canton-municipalities.json').cantons || {};
  const geocoded = readJson('data/municipalities-geocoded.json');

  // Set of every Swiss municipality (folded) present in each canton, for the
  // geo-fallback city validation.
  const swissCityByCanton = new Map(); // canton -> Set<foldedCity>
  for (const [canton, entry] of Object.entries(cantonMunicipalities)) {
    const set = new Set();
    for (const m of entry.municipalities || []) set.add(foldName(m).split(/[\s/]+/).pop());
    swissCityByCanton.set(canton, set);
  }

  // Border provinces actually present in the geocoded file (keeps the commuter
  // origins honest — only provinces we truly have residence data for).
  const provincesWithData = new Set();
  for (const key of Object.keys(geocoded)) {
    const prov = key.split('|')[1];
    if (prov) provincesWithData.add(prov);
  }

  // Group jobs by employer (companyKey).
  const employers = new Map(); // key -> { key, company, jobs, cantonCounts, cityCounts }
  for (const j of jobs) {
    const key = j.companyKey || foldName(j.company || '');
    if (!key) continue;
    let e = employers.get(key);
    if (!e) {
      e = { key, company: j.company || key, jobs: [], cantonCounts: {}, cityCounts: {} };
      employers.set(key, e);
    }
    e.jobs.push(j);
    if (j.canton) e.cantonCounts[j.canton] = (e.cantonCounts[j.canton] || 0) + 1;
    const city = j.addressLocality || '';
    if (city) e.cityCounts[city] = (e.cityCounts[city] || 0) + 1;
  }

  const dominant = (counts) => {
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return sorted.length ? sorted[0][0] : '';
  };

  // facility key -> aggregate
  const facilities = new Map();
  const attach = (employer, hospital, matchType) => {
    let f = facilities.get(employer.key);
    if (!f) {
      f = { employer, hospitals: [], categories: {}, matchType };
      facilities.set(employer.key, f);
    }
    f.hospitals.push(hospital);
    const cat = normalizeCategory(hospital.category);
    f.categories[cat] = (f.categories[cat] || 0) + 1;
    // employer-name match is stronger than geo — keep the strongest seen.
    if (matchType === 'employer') f.matchType = 'employer';
  };

  const matchedHospitals = new Set();

  // Pass 1 — employer-name match (primary).
  for (const h of hospitals) {
    let best = null;
    for (const e of employers.values()) {
      if (employerMatchesHospital(e.company, h.name)) {
        if (!best || e.jobs.length > best.jobs.length) best = e;
      }
    }
    if (best) {
      attach(best, h, 'employer');
      matchedHospitals.add(h);
    }
  }

  // Pass 2 — geo-proximity fallback for hospitals still unmatched.
  for (const h of hospitals) {
    if (matchedHospitals.has(h)) continue;
    const city = extractHospitalCity(h.name);
    if (!city) continue;
    const cantonCities = swissCityByCanton.get(h.canton);
    if (!cantonCities || !cantonCities.has(city)) continue; // validate real Swiss city
    let best = null;
    for (const e of employers.values()) {
      if (!isHospitalTypeName(e.company)) continue;
      if (dominant(e.cantonCounts) !== h.canton) continue;
      const domCity = foldName(dominant(e.cityCounts)).split(/[\s/]+/).pop();
      if (domCity !== city) continue;
      if (facilities.has(e.key)) continue; // already an employer-match facility
      if (!best || e.jobs.length > best.jobs.length) best = e;
    }
    if (best) {
      attach(best, h, 'geo');
      matchedHospitals.add(h);
    }
  }

  // Build facility records.
  const records = [];
  for (const f of facilities.values()) {
    const e = f.employer;
    // Canton = the employer's DOMINANT job canton, not the directory
    // hospital's canton. Deliberate (reviewer adversarial check, PR #4514): a
    // multi-canton group (e.g. Hirslanden, 7 directory sites across ZH/BE/AG)
    // collapses to ONE facility page, and every canton-dependent consumer
    // downstream (job-board CTA target, bridge CTA `canton === 'TI'`,
    // pickFacilities region ranking in healthFacilitiesLinksPlugin) should
    // point where the LIVE JOBS actually are — that is what the visitor
    // clicks through to. The directory hospital's canton only breaks the tie
    // when the employer has no canton-tagged jobs at all.
    const canton = dominant(e.cantonCounts) || f.hospitals[0].canton || '';
    const healthcareJobs = e.jobs.filter((j) => classifyHealthcareRole(j.title));
    const roleCounts = {};
    for (const j of healthcareJobs) {
      const r = classifyHealthcareRole(j.title);
      if (r) roleCounts[r] = (roleCounts[r] || 0) + 1;
    }
    const median =
      realSalaryMedianChf(healthcareJobs) ?? realSalaryMedianChf(e.jobs);
    const category = Object.entries(f.categories).sort((a, b) => b[1] - a[1])[0][0];
    // City: prefer a directory hospital's own city, else dominant job city.
    let city = '';
    for (const h of f.hospitals) {
      const c = extractHospitalCity(h.name);
      if (c) { city = c; break; }
    }
    const domJobCity = dominant(e.cityCounts);
    const displayCity = domJobCity || (city ? city.charAt(0).toUpperCase() + city.slice(1) : '');
    const commuterOrigins = (CANTON_BORDER_PROVINCES[canton] || []).filter((p) =>
      provincesWithData.has(p),
    );
    // Sites: cleaned, unique hospital site names (drop the shared brand prefix).
    const sites = [...new Set(f.hospitals.map((h) => h.name.trim()))].sort();

    records.push({
      slug: e.key,
      companyKeys: [e.key],
      name: e.company,
      canton,
      city: displayCity,
      category,
      matchType: f.matchType,
      sites,
      commuterOrigins,
      jobCountSnapshot: e.jobs.length,
      healthcareJobCountSnapshot: healthcareJobs.length,
      healthcareRoleCountsSnapshot: roleCounts,
      medianSalaryChfSnapshot: median,
      aboveFloorSnapshot: e.jobs.length >= MIN_JOBS_FLOOR,
    });
  }

  records.sort((a, b) => b.jobCountSnapshot - a.jobCountSnapshot || a.slug.localeCompare(b.slug));

  const aboveFloor = records.filter((r) => r.aboveFloorSnapshot);
  const belowFloor = records.filter((r) => !r.aboveFloorSnapshot);

  const out = {
    generatedAt: new Date().toISOString(),
    source:
      'data/swiss-hospitals.json ⨯ data/jobs.json (employer-name match + geo fallback) via build-plugins/healthFacilitiesMatch.ts',
    minJobsFloor: MIN_JOBS_FLOOR,
    counts: {
      hospitalsTotal: hospitals.length,
      hospitalsMatched: matchedHospitals.size,
      facilities: records.length,
      aboveFloor: aboveFloor.length,
      belowFloor: belowFloor.length,
      byMatchType: {
        employer: records.filter((r) => r.matchType === 'employer').length,
        geo: records.filter((r) => r.matchType === 'geo').length,
      },
    },
    facilities: records,
  };

  const outPath = path.join(ROOT, 'data', 'health-facilities-jobs.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf-8');

  console.log(`[generate-health-facilities-jobs] wrote ${path.relative(ROOT, outPath)}`);
  console.log(
    `  hospitals matched: ${matchedHospitals.size}/${hospitals.length} · facilities: ${records.length} ` +
      `(employer=${out.counts.byMatchType.employer}, geo=${out.counts.byMatchType.geo})`,
  );
  console.log(
    `  post-floor (>=${MIN_JOBS_FLOOR} jobs): ${aboveFloor.length} indexable · ${belowFloor.length} below-floor bridges`,
  );
  console.log('  top 10 above-floor facilities:');
  for (const r of aboveFloor.slice(0, 10)) {
    console.log(
      `    ${String(r.jobCountSnapshot).padStart(4)} jobs · [${r.canton}] ${r.slug} :: ${r.name}` +
        (r.medianSalaryChfSnapshot ? ` · median CHF ${r.medianSalaryChfSnapshot}` : ''),
    );
  }
}

main();
