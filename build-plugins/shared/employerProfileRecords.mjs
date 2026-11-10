/**
 * Employer-profile record aggregation — ONE definition shared by the dataset
 * generator (scripts/build-employer-profiles.mjs) and the SSG plugin
 * (build-plugins/employerProfilePagesPlugin.ts).
 *
 * WHY THE PLUGIN NEEDS IT TOO. data/employer-profiles.json is a committed
 * snapshot refreshed a few times a week (refresh-employer-profiles.yml), while
 * the canton company hubs (`/cerca-lavoro-<canton>/azienda-<slug>/`) are built
 * from the LIVE corpus on every deploy. A company that crosses the floor
 * between two refreshes therefore had a populated hub and a hard 404 at
 * `/aziende/<slug>/` (e.g. `comune-di-minusio`, 3 live postings, absent from
 * the snapshot the build read). The plugin now fills those gaps from the live
 * corpus with exactly these functions, so a live-derived record is
 * byte-for-byte what the next snapshot refresh will write — the drift
 * employerProfileConfig.mjs warns about cannot open up between the two.
 *
 * Plain .mjs for the same dual-consumer reason as companyProfileSlug.mjs. The
 * salary summariser is injected rather than imported because its source is a
 * .ts module (realSalaryMedian.ts) that both consumers already import their
 * own way.
 */
import { canonicalCompanyProfileSlug } from './companyProfileSlug.mjs';
import { BRIDGE_FLOOR, MIN_ACTIVE_JOBS } from './employerProfileConfig.mjs';

/** Max cities / cantons surfaced per profile (kept lean; long tail dropped). */
export const MAX_CITIES = 6;
export const MAX_CANTONS = 6;

/** Slugs that would collide with the locale-prefix grammar of the route/compat
 * regex (`/^\/(?:(?:en|de|fr)\/)?aziende\/.../`) — never emit a page for them. */
export const RESERVED_SLUGS = new Set(['it', 'en', 'de', 'fr']);

/** Most frequent non-empty string of `field` in a group (deterministic tie-break). */
export function dominant(jobs, field) {
  const counts = new Map();
  for (const j of jobs) {
    const v = String(j[field] || '').trim();
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  let best = '';
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN || (n === bestN && v < best)) {
      best = v;
      bestN = n;
    }
  }
  return best || null;
}

/** Aggregate a field into [{ name, count }] sorted by count desc, name asc. */
export function topBy(jobs, pick, limit) {
  const counts = new Map();
  for (const j of jobs) {
    const v = pick(j);
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1))
    .slice(0, limit);
}

export function cityLabel(job) {
  const raw = String(job.addressLocality || job.location || '').split(/[,(]/)[0].trim();
  return raw || null;
}

const cantonOf = (j) => String(j.canton || '').trim().toUpperCase() || null;

/**
 * Canonical employer slug for one job, or '' when the job must not join any
 * group (no company, unsluggable, or a reserved locale code: `/aziende/en/`
 * would be parsed by the router / searchConsoleCompat regex as the EN-prefixed
 * root of a slug-less path).
 */
export function employerProfileSlugForJob(job) {
  const company = String(job.company || '').trim();
  if (!company) return '';
  const slug = canonicalCompanyProfileSlug(company, job.companyKey);
  if (!slug || RESERVED_SLUGS.has(slug)) return '';
  return slug;
}

/** Group active jobs by canonical employer slug (insertion order preserved). */
export function groupJobsByEmployerSlug(jobs) {
  const groups = new Map();
  for (const j of jobs) {
    const slug = employerProfileSlugForJob(j);
    if (!slug) continue;
    const arr = groups.get(slug);
    if (arr) arr.push(j);
    else groups.set(slug, [j]);
  }
  return groups;
}

/**
 * Build the dataset record for one employer group.
 *
 * @param {string} slug
 * @param {Array<Record<string, unknown>>} group active jobs of this employer
 * @param {{ salarySummary: (jobs: any[]) => { medianChf: number | null, sampleCount: number },
 *           trend?: { added: number, removed: number, net: number, windowDays: number } | null }} opts
 * @returns {{ band: 'profile', record: object } | { band: 'belowFloor', record: object } | null}
 *   null for singletons (no page, no bridge).
 */
export function buildEmployerProfileRecord(slug, group, { salarySummary, trend = null }) {
  const activeJobs = group.length;
  if (activeJobs < BRIDGE_FLOOR) return null;

  const name = dominant(group, 'company') || slug;
  const sector = dominant(group, 'sector');

  if (activeJobs < MIN_ACTIVE_JOBS) {
    const topCanton = topBy(group, cantonOf, 1)[0];
    return {
      band: 'belowFloor',
      record: {
        slug,
        name,
        activeJobs,
        sector,
        canton: topCanton ? topCanton.name : null,
      },
    };
  }

  const summary = salarySummary(group);
  return {
    band: 'profile',
    record: {
      slug,
      name,
      companyKey: dominant(group, 'companyKey'),
      sector,
      activeJobs,
      cantons: topBy(group, cantonOf, MAX_CANTONS),
      cities: topBy(group, cityLabel, MAX_CITIES),
      salaryMedianChf: summary.medianChf,
      salarySamples: summary.sampleCount,
      trend: trend || null,
    },
  };
}

/** Deterministic dataset order: active jobs desc, then slug asc. */
export function compareEmployerRecords(a, b) {
  return b.activeJobs - a.activeJobs || (a.slug < b.slug ? -1 : 1);
}
