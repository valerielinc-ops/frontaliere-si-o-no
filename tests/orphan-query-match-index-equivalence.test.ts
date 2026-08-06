/**
 * Output-invariance guard for the `filterMatchingJobs` match index.
 *
 * `filterMatchingJobs` used to evaluate the whole per-pair body — the activity
 * gate, the title-token set and the location-token set — once per
 * (job, cluster) PAIR: 500 clusters x ~26k jobs = ~13M evaluations per build,
 * which was the entire 191 s wall of `orphan-query-landings` in deploy
 * 31065272867. Those sub-computations are pure functions of (job, locale) or of
 * `job` alone, so they are now memoised per job in a lazily-filled index.
 *
 * That is a caching change over a 4-valued key (the locale), which is exactly
 * the shape of bug that silently DROPS PAGES: if the locale dimension is lost,
 * a job's `it` activity/title tokens get reused for `en`/`de`/`fr`, the match
 * count moves, and clusters cross the `MIN_MATCHING_JOBS = 3` indexability gate
 * in the wrong direction — fewer pages in `sitemap-orphan-landings.xml`, which
 * trips the downstream shard shrink guard.
 *
 * So this file does NOT assert hand-written expectations. It runs a reference
 * implementation — the pre-index algorithm, transcribed verbatim below — beside
 * the shipped one over a corpus built to exercise every axis the index keys on,
 * and demands element-for-element equality. Any version that returns fewer
 * jobs, different jobs, or the same jobs in a different order fails.
 *
 * Verified red-then-green: with the locale dropped from the title-token cache
 * key ("titleTokensByLocale[locale]" -> a single shared slot) this file reports
 *   FAIL  locale dimension: en/de/fr must not reuse the it title tokens
 *   FAIL  reference parity across all four locales on a shared jobs array
 * and with the shipped code it passes.
 */

import { describe, it, expect } from 'vitest';
import {
  filterMatchingJobs,
  ORPHAN_LANDING_LOCALES,
  type OrphanQueryCluster,
  type OrphanCountableJob,
  type OrphanLandingLocale,
} from '../build-plugins/orphanQueryData';

// ─────────────────────────────────────────────────────────────────────────────
// Reference implementation — the algorithm exactly as it stood before the index
// (build-plugins/orphanQueryData.ts, pre-#5252). Kept self-contained on purpose:
// if the shipped helpers were imported here, a bug in one of them would cancel
// out on both sides and this file would go green on broken output.
// ─────────────────────────────────────────────────────────────────────────────

function refNormalizeTokens(s: string | undefined | null): string[] {
  if (!s) return [];
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((t) => t.length >= 3);
}

function refWordCount(s: string | undefined | null): number {
  if (!s) return 0;
  return String(s).trim().split(/\s+/).filter(Boolean).length;
}

function refIsActive(job: OrphanCountableJob, locale: OrphanLandingLocale): boolean {
  if (!job || typeof job !== 'object') return false;
  if (job.expired) return false;
  const nr = job.needsRetranslation;
  if (nr === true && locale !== (job.sourceLang || 'it')) return false;
  if (nr && typeof nr === 'object' && (nr as Record<string, boolean>)[locale]) return false;
  const localeDesc = job.descriptionByLocale?.[locale];
  const fallback = locale === 'it' ? job.description : undefined;
  const desc = localeDesc && localeDesc.trim().length > 0 ? localeDesc : fallback;
  return refWordCount(desc) >= 50;
}

const REF_BROAD_REGION_TOKENS = new Set<string>([
  'svizzera', 'suisse', 'switzerland', 'schweiz', 'ticino', 'tessin', 'ch',
]);
const REF_GENERIC_ROLE_STEMS = new Set<string>([
  'lavor', 'lavorar', 'lav', 'job', 'jobs', 'offert', 'offerta', 'offr', 'offre',
  'emplo', 'employ', 'travail', 'travaill', 'cerc', 'cerco', 'cercas', 'ricerc',
  'ricerch', 'trovar', 'trov', 'post', 'posizion', 'apert', 'assumon', 'assunzion',
  'aziend', 'annunc', 'concors', 'vacant', 'recrutement', 'recrut', 'search', 'find',
  'near', 'nah', 'vicin', 'stellen', 'stellenangebot', 'stelleninserat', 'arbeit',
  'noi', 'ier', 'hier', 'ultim', 'giorn', 'settiman', 'tutt', 'letzten', 'tagen',
  'dernier', 'jour', 'press', 'ent',
]);

function refTokenMatchesStem(tokens: Iterable<string>, stem: string): boolean {
  if (stem.length < 3) return false;
  for (const tok of tokens) {
    if (tok.startsWith(stem) || stem.startsWith(tok.slice(0, Math.max(3, stem.length - 1)))) return true;
  }
  return false;
}

function refLocalityMatchesCity(locTokens: Iterable<string>, cityTok: string): boolean {
  if (cityTok.length < 3) return false;
  for (const locTok of locTokens) if (locTok.startsWith(cityTok)) return true;
  return false;
}

function refMatches(job: OrphanCountableJob, cluster: OrphanQueryCluster): boolean {
  if (!refIsActive(job, cluster.locale)) return false;
  const titleTokens = new Set<string>([
    ...refNormalizeTokens(job.title),
    ...refNormalizeTokens(job.titleByLocale?.[cluster.locale]),
    ...refNormalizeTokens(job.company),
  ]);
  const locTokens = new Set<string>([
    ...refNormalizeTokens(job.location),
    ...refNormalizeTokens(job.addressLocality),
  ]);
  const specificRegions = cluster.regionTokens.filter((r) => !REF_BROAD_REGION_TOKENS.has(r));
  const allRolesGeneric =
    cluster.roleTokens.length === 0 || cluster.roleTokens.every((r) => REF_GENERIC_ROLE_STEMS.has(r));
  if (specificRegions.length > 0 && allRolesGeneric) {
    return specificRegions.some((rtok) => refLocalityMatchesCity(locTokens, rtok));
  }
  if (!cluster.roleTokens.some((stem) => refTokenMatchesStem(titleTokens, stem))) return false;
  if (specificRegions.length > 0) {
    if (!specificRegions.some((rtok) => refLocalityMatchesCity(locTokens, rtok))) return false;
  }
  return true;
}

function refFirstParsableMs(...values: unknown[]): number {
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    const ts = new Date(v as string | number | Date).getTime();
    if (Number.isFinite(ts)) return ts;
  }
  return 0;
}

function refFilterMatchingJobs<T extends OrphanCountableJob>(
  jobs: readonly T[],
  cluster: OrphanQueryCluster,
  limit = 15,
): T[] {
  const matches = jobs.filter((j) => refMatches(j, cluster));
  matches.sort((a, b) => {
    const ad = refFirstParsableMs(a.postedDate, a.datePosted);
    const bd = refFirstParsableMs(b.postedDate, b.datePosted);
    return bd - ad;
  });
  return matches.slice(0, limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// Corpus — every field the index keys on varies across jobs, and the
// locale-dependent fields (titleByLocale, descriptionByLocale,
// needsRetranslation, sourceLang) vary across locales WITHIN a job.
// ─────────────────────────────────────────────────────────────────────────────

const LONG = (w: string) => Array.from({ length: 60 }, () => w).join(' ');

interface JobSeed extends OrphanCountableJob { slug: string }

function corpus(): JobSeed[] {
  const jobs: JobSeed[] = [];
  const cities = ['Lugano', 'Manno', 'Männedorf', 'Stabio', 'Mendrisio', 'Zürich', 'Luzern', 'Bellinzona', 'Chiasso', 'Locarno'];
  const roles = ['Infermiere', 'Chauffeur Kat. C', 'Magazziniere', 'Operatore di produzione', 'Pastry Chef', 'Software Engineer'];
  const companies = ['Clinica Sant Anna', 'AutoPostale', 'Migros Ticino', 'Läderach', 'ABB Svizzera'];

  for (let i = 0; i < 90; i++) {
    const city = cities[i % cities.length];
    const role = roles[i % roles.length];
    const company = companies[i % companies.length];
    const j: JobSeed = {
      slug: `job-${i}`,
      title: role,
      company,
      location: city,
      addressLocality: city,
      // Same calendar day for many jobs → ties, so a change in sort stability
      // (or a wrong precomputed sort key) reorders the `limit` slice.
      postedDate: `2026-0${(i % 5) + 1}-${String((i % 28) + 1).padStart(2, '0')}`,
      datePosted: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      description: LONG('mansione'),
    };

    // ── locale-varying title: the axis a locale-blind title cache destroys ──
    if (i % 3 === 0) {
      j.titleByLocale = {
        en: `${role} nurse position`,
        de: `${role} Pflegefachperson`,
        fr: `${role} infirmier poste`,
      };
    }

    // ── locale-varying activity ──
    if (i % 4 === 0) {
      // long enough only in it+en; de/fr fall under the 50-word gate
      j.descriptionByLocale = { it: LONG('mansione'), en: LONG('duty'), de: 'zu kurz', fr: 'trop court' };
    } else if (i % 4 === 1) {
      j.descriptionByLocale = { it: LONG('mansione'), en: LONG('duty'), de: LONG('aufgabe'), fr: LONG('tache') };
    } else if (i % 4 === 2) {
      // no per-locale description at all → only `it` gets the fallback
      j.descriptionByLocale = undefined;
    } else {
      j.descriptionByLocale = { it: LONG('mansione'), en: LONG('duty'), de: LONG('aufgabe'), fr: LONG('tache') };
      j.needsRetranslation = { de: true } as unknown as Partial<Record<OrphanLandingLocale, boolean>>;
    }

    if (i % 11 === 0) j.needsRetranslation = true;
    if (i % 11 === 0) j.sourceLang = (['it', 'en', 'de', 'fr'] as const)[i % 4];
    if (i % 17 === 0) j.expired = true;
    // malformed postedDate → firstParsableMs must fall through to datePosted
    if (i % 13 === 0) j.postedDate = '30/05/26';
    if (i % 19 === 0) j.postedDate = undefined;

    jobs.push(j);
  }
  return jobs;
}

function makeCluster(
  locale: OrphanLandingLocale,
  slug: string,
  roleTokens: string[],
  regionTokens: string[],
): OrphanQueryCluster {
  return {
    clusterId: `${locale}-${slug}`,
    locale,
    canonicalQuery: slug.replace(/-/g, ' '),
    canonicalSlug: slug,
    roleTokens,
    regionTokens,
    totalImpressions: 30,
    totalClicks: 3,
    queries: [{ query: slug.replace(/-/g, ' '), clicks: 3, impressions: 30 }],
  };
}

function allClusters(): OrphanQueryCluster[] {
  const shapes: Array<[string, string[], string[]]> = [
    ['infermiere-lugano', ['infermier'], ['lugano']],
    ['chauffeur-ticino', ['chauffeur'], ['ticino']],
    ['lavoro-manno', ['lavor'], ['manno']],
    ['lavoro-stabio-svizzera', ['lavor'], ['stabio', 'svizzera']],
    ['magazziniere-mendrisio', ['magazzinier'], ['mendrisio']],
    ['nurse-jobs', ['nurse'], ['svizzera']],
    ['pflegefachperson-tessin', ['pflegefachperson'], ['tessin']],
    ['infirmier-suisse', ['infirmier'], ['suisse']],
    ['no-role-broad-only', [], ['svizzera']],
    ['software-zurich', ['software'], ['zurich']],
  ];
  const out: OrphanQueryCluster[] = [];
  for (const locale of ORPHAN_LANDING_LOCALES) {
    for (const [slug, roles, regions] of shapes) out.push(makeCluster(locale, `${slug}`, roles, regions));
  }
  return out;
}

const slugs = (jobs: OrphanCountableJob[]): string[] => jobs.map((j) => String((j as JobSeed).slug));

describe('#5252 — orphan-query filterMatchingJobs index preserves output exactly', () => {
  it('reference parity across all four locales on a SHARED jobs array', () => {
    // One array instance for every call: this is what the plugin does, and it
    // is the only way the per-jobs-array index is exercised at all.
    const jobs = corpus();
    const clusters = allClusters();

    let comparedNonEmpty = 0;
    for (const cluster of clusters) {
      for (const limit of [15, 5, 3, 1]) {
        const got = filterMatchingJobs(jobs, cluster, limit);
        const want = refFilterMatchingJobs(jobs, cluster, limit);
        expect(
          slugs(got),
          `cluster=${cluster.clusterId} limit=${limit}`,
        ).toEqual(slugs(want));
        if (want.length > 0) comparedNonEmpty++;
      }
    }
    // Guard the guard: if the corpus stopped producing matches this file would
    // pass vacuously while proving nothing.
    expect(comparedNonEmpty).toBeGreaterThan(20);
  });

  it('locale dimension: en/de/fr must not reuse the it title tokens', () => {
    // These jobs match ONLY through `titleByLocale[<locale>]` — their base
    // `title` carries no matching role token. A title-token cache that forgets
    // the locale returns the `it` tokens for every locale and this goes to zero.
    const jobs: JobSeed[] = [
      {
        slug: 'loc-a',
        title: 'Operatore generico',
        company: 'Clinica',
        location: 'Lugano',
        addressLocality: 'Lugano',
        postedDate: '2026-03-01',
        description: LONG('mansione'),
        descriptionByLocale: { it: LONG('mansione'), en: LONG('duty'), de: LONG('aufgabe'), fr: LONG('tache') },
        titleByLocale: { en: 'Nurse', de: 'Pflegefachperson', fr: 'Infirmier' },
      },
      {
        slug: 'loc-b',
        title: 'Operatore generico',
        company: 'Ospedale',
        location: 'Lugano',
        addressLocality: 'Lugano',
        postedDate: '2026-03-02',
        description: LONG('mansione'),
        descriptionByLocale: { it: LONG('mansione'), en: LONG('duty'), de: LONG('aufgabe'), fr: LONG('tache') },
        titleByLocale: { en: 'Nurse', de: 'Pflegefachperson', fr: 'Infirmier' },
      },
    ];

    // Ask `it` FIRST so a locale-blind cache is populated with the it tokens.
    expect(slugs(filterMatchingJobs(jobs, makeCluster('it', 'nurse', ['nurse'], ['lugano']), 15))).toEqual([]);
    expect(slugs(filterMatchingJobs(jobs, makeCluster('en', 'nurse', ['nurse'], ['lugano']), 15)))
      .toEqual(['loc-b', 'loc-a']);
    expect(slugs(filterMatchingJobs(jobs, makeCluster('de', 'pflege', ['pflegefachperson'], ['lugano']), 15)))
      .toEqual(['loc-b', 'loc-a']);
    expect(slugs(filterMatchingJobs(jobs, makeCluster('fr', 'inf', ['infirmier'], ['lugano']), 15)))
      .toEqual(['loc-b', 'loc-a']);
  });

  it('locale dimension: the activity gate is re-evaluated per locale', () => {
    // Active in it/en, under the 50-word gate in de/fr. A locale-blind activity
    // cache keeps them "active" everywhere and de/fr gain pages that must not exist.
    const jobs: JobSeed[] = Array.from({ length: 4 }, (_, i) => ({
      slug: `act-${i}`,
      title: 'Infermiere',
      company: 'Clinica',
      location: 'Lugano',
      addressLocality: 'Lugano',
      postedDate: `2026-03-0${i + 1}`,
      description: LONG('mansione'),
      descriptionByLocale: { it: LONG('mansione'), en: LONG('duty'), de: 'kurz', fr: 'court' },
      titleByLocale: { en: 'Infermiere', de: 'Infermiere', fr: 'Infermiere' },
    }));

    const forLocale = (l: OrphanLandingLocale) =>
      filterMatchingJobs(jobs, makeCluster(l, 'infermiere-lugano', ['infermier'], ['lugano']), 15).length;

    expect(forLocale('it')).toBe(4);
    expect(forLocale('en')).toBe(4);
    expect(forLocale('de')).toBe(0);
    expect(forLocale('fr')).toBe(0);
  });

  it('sort key and limit slice are unchanged (ties, malformed and missing dates)', () => {
    const jobs: JobSeed[] = [
      { slug: 'newest', title: 'Infermiere', location: 'Lugano', addressLocality: 'Lugano', description: LONG('m'), postedDate: '2026-05-09' },
      // malformed postedDate must fall through to datePosted, NOT sort as a string
      { slug: 'malformed', title: 'Infermiere', location: 'Lugano', addressLocality: 'Lugano', description: LONG('m'), postedDate: '30/05/26', datePosted: '2026-05-08' },
      { slug: 'tie-a', title: 'Infermiere', location: 'Lugano', addressLocality: 'Lugano', description: LONG('m'), postedDate: '2026-05-07' },
      { slug: 'tie-b', title: 'Infermiere', location: 'Lugano', addressLocality: 'Lugano', description: LONG('m'), postedDate: '2026-05-07' },
      { slug: 'nodate', title: 'Infermiere', location: 'Lugano', addressLocality: 'Lugano', description: LONG('m') },
    ];
    const cluster = makeCluster('it', 'infermiere-lugano', ['infermier'], ['lugano']);
    for (const limit of [15, 4, 3, 2, 1]) {
      expect(slugs(filterMatchingJobs(jobs, cluster, limit)), `limit=${limit}`)
        .toEqual(slugs(refFilterMatchingJobs(jobs, cluster, limit)));
    }
    // Ties keep source order (stable sort), malformed date lands by datePosted.
    expect(slugs(filterMatchingJobs(jobs, cluster, 15)))
      .toEqual(['newest', 'malformed', 'tie-a', 'tie-b', 'nodate']);
  });

  it('a different jobs array is never served from another array index', () => {
    const cluster = makeCluster('it', 'infermiere-lugano', ['infermier'], ['lugano']);
    const a: JobSeed[] = [
      { slug: 'a1', title: 'Infermiere', location: 'Lugano', addressLocality: 'Lugano', description: LONG('m'), postedDate: '2026-05-01' },
    ];
    const b: JobSeed[] = [
      { slug: 'b1', title: 'Infermiere', location: 'Lugano', addressLocality: 'Lugano', description: LONG('m'), postedDate: '2026-05-01' },
      { slug: 'b2', title: 'Infermiere', location: 'Lugano', addressLocality: 'Lugano', description: LONG('m'), postedDate: '2026-05-02' },
    ];
    expect(slugs(filterMatchingJobs(a, cluster, 15))).toEqual(['a1']);
    expect(slugs(filterMatchingJobs(b, cluster, 15))).toEqual(['b2', 'b1']);
    expect(slugs(filterMatchingJobs(a, cluster, 15))).toEqual(['a1']);
  });

  it('an index built for a shorter corpus is not reused after the array grows', () => {
    // The WeakMap is keyed on array IDENTITY, so a caller that appends to the
    // SAME array in place is the one case identity alone cannot catch: without
    // the `hit.length === jobs.length` re-check the index still has entries for
    // the old length and the appended jobs are silently invisible — pages lost,
    // with no error anywhere.
    const cluster = makeCluster('it', 'infermiere-lugano', ['infermier'], ['lugano']);
    const jobs: JobSeed[] = [
      { slug: 'g1', title: 'Infermiere', location: 'Lugano', addressLocality: 'Lugano', description: LONG('m'), postedDate: '2026-05-01' },
    ];
    expect(slugs(filterMatchingJobs(jobs, cluster, 15))).toEqual(['g1']);

    jobs.push(
      { slug: 'g2', title: 'Infermiere', location: 'Lugano', addressLocality: 'Lugano', description: LONG('m'), postedDate: '2026-05-02' },
      { slug: 'g3', title: 'Infermiere', location: 'Lugano', addressLocality: 'Lugano', description: LONG('m'), postedDate: '2026-05-03' },
    );
    expect(slugs(filterMatchingJobs(jobs, cluster, 15))).toEqual(['g3', 'g2', 'g1']);
    expect(slugs(filterMatchingJobs(jobs, cluster, 15))).toEqual(slugs(refFilterMatchingJobs(jobs, cluster, 15)));
  });

  it('repeated calls with the same (jobs, cluster) are idempotent', () => {
    const jobs = corpus();
    const cluster = makeCluster('de', 'pflegefachperson-tessin', ['pflegefachperson'], ['tessin']);
    const first = slugs(filterMatchingJobs(jobs, cluster, 15));
    for (let i = 0; i < 4; i++) {
      expect(slugs(filterMatchingJobs(jobs, cluster, 15))).toEqual(first);
    }
    expect(first).toEqual(slugs(refFilterMatchingJobs(jobs, cluster, 15)));
  });
});
