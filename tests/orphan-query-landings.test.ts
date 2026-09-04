/**
 * Tests for F3b — Orphan-query cluster landings.
 *
 * Coverage:
 *   - Path builders + parsing (IT/EN/DE/FR).
 *   - Clustering script output shape + gates (≥5 impressions, known-slug skip).
 *   - Job-matching predicate (role + region overlap).
 *   - Build plugin quality gates (≥3 matching jobs → indexable, ≥50 words → indexable).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  readAllKnownJobSlugs,
  knownSlugsStoreExists,
} from '../scripts/lib/all-known-job-slugs-store.mjs';

import {
  buildOrphanLandingHubPath,
  buildOrphanLandingHubUrl,
  renderOrphanLandingHubHreflang,
} from '../build-plugins/orphanQueryLandingPlugin';

import {
  ORPHAN_LANDING_LOCALES,
  ORPHAN_LANDING_SECTION,
  ORPHAN_LANDING_LOCALE_PREFIX,
  buildOrphanLandingPath,
  parseOrphanLandingPath,
  buildOrphanLandingRoutes,
  filterMatchingJobs,
  jobMatchesCluster,
  median,
  topCounts,
  type OrphanQueryCluster,
  type OrphanCountableJob,
} from '../build-plugins/orphanQueryData';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ─── Path helpers ────────────────────────────────────────────
describe('orphanQueryData — path helpers', () => {
  it('exposes exactly 4 locales', () => {
    expect(ORPHAN_LANDING_LOCALES).toEqual(['it', 'en', 'de', 'fr']);
  });

  it('maps each locale to a distinct section slug', () => {
    const sections = Object.values(ORPHAN_LANDING_SECTION);
    expect(new Set(sections).size).toBe(sections.length);
    expect(ORPHAN_LANDING_SECTION.it).toBe('ricerca');
    expect(ORPHAN_LANDING_SECTION.en).toBe('search');
    expect(ORPHAN_LANDING_SECTION.de).toBe('suche');
    expect(ORPHAN_LANDING_SECTION.fr).toBe('recherche');
  });

  it('builds a canonical trailing-slash path per locale', () => {
    expect(buildOrphanLandingPath('it', 'chauffeur-jobs')).toBe('/ricerca/chauffeur-jobs/');
    expect(buildOrphanLandingPath('en', 'chauffeur-jobs')).toBe('/en/search/chauffeur-jobs/');
    expect(buildOrphanLandingPath('de', 'chauffeur-jobs')).toBe('/de/suche/chauffeur-jobs/');
    expect(buildOrphanLandingPath('fr', 'chauffeur-jobs')).toBe('/fr/recherche/chauffeur-jobs/');
  });

  it('parses a URL path back to (locale, slug)', () => {
    expect(parseOrphanLandingPath('/ricerca/chauffeur-jobs/')).toEqual({ locale: 'it', slug: 'chauffeur-jobs' });
    expect(parseOrphanLandingPath('/en/search/nursing-jobs-ticino/')).toEqual({ locale: 'en', slug: 'nursing-jobs-ticino' });
    expect(parseOrphanLandingPath('/de/suche/stellen-tessin/')).toEqual({ locale: 'de', slug: 'stellen-tessin' });
    expect(parseOrphanLandingPath('/fr/recherche/emploi-tessin/')).toEqual({ locale: 'fr', slug: 'emploi-tessin' });
  });

  it('returns null for unrelated paths', () => {
    expect(parseOrphanLandingPath('/')).toBeNull();
    expect(parseOrphanLandingPath('/cerca-lavoro-ticino/chauffeur-jobs/')).toBeNull();
    expect(parseOrphanLandingPath('/ricerca/')).toBeNull();
    expect(parseOrphanLandingPath('/ricerca/a/b/')).toBeNull();
  });

  it('produces distinct prefixes per locale', () => {
    const prefixes = Object.values(ORPHAN_LANDING_LOCALE_PREFIX);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('builds hub hreflang URLs without collapsing https:// and includes x-default', () => {
    expect(buildOrphanLandingHubPath('it')).toBe('/ricerca/');
    expect(buildOrphanLandingHubPath('en')).toBe('/en/search/');
    expect(buildOrphanLandingHubPath('de')).toBe('/de/suche/');
    expect(buildOrphanLandingHubPath('fr')).toBe('/fr/recherche/');
    expect(buildOrphanLandingHubUrl('fr')).toBe('https://frontaliereticino.ch/fr/recherche/');

    const html = renderOrphanLandingHubHreflang({
      it: true,
      en: true,
      de: true,
      fr: true,
    });

    expect(html.match(/rel="alternate"/g)).toHaveLength(5);
    expect(html).toContain('hreflang="x-default" href="https://frontaliereticino.ch/ricerca/"');
    expect(html).toContain('hreflang="de" href="https://frontaliereticino.ch/de/suche/"');
    expect(html).toContain('hreflang="en" href="https://frontaliereticino.ch/en/search/"');
    expect(html).not.toContain('https:/frontaliereticino.ch');
  });

  // Regression guard for the per-locale matrix-build hreflang bug (deploy
  // 27923956556): on a non-it shard the hub call site used to derive
  // availability from the emit-gated `indexableByLocale`, so en/de/fr hubs
  // collapsed to 2 entries (their own locale + x-default) and failed
  // audit-hreflang. The renderer itself is correct — a FULL availability map
  // must always yield 5 entries — and the plugin now ALWAYS passes the full
  // (ungated) map. This pins the renderer's full-map contract so a future
  // refactor cannot quietly reintroduce a partial map at the call site.
  it('emits the full 4-locale + x-default set whenever every locale has clusters (shard contract)', () => {
    const html = renderOrphanLandingHubHreflang({ it: true, en: true, de: true, fr: true });
    expect(html.match(/rel="alternate"/g)).toHaveLength(5);
    for (const loc of ['it', 'en', 'de', 'fr'] as const) {
      expect(html).toContain(`hreflang="${loc}"`);
    }
    expect(html).toContain('hreflang="x-default"');
  });

  // All-or-nothing contract: if ANY locale has zero indexable orphan clusters
  // site-wide (reachable when a locale's clusters all fall under
  // MIN_MATCHING_JOBS/MIN_INDEXABLE_WORDS), the renderer must emit '' — NOT a
  // partial set. A partial 3-locale + x-default block (4 entries, 3 declared)
  // trips audit-hreflang `[tooFew]`, the same gate this plugin fixes. Mirrors
  // the leaf `renderPage` `hasFullCluster` gate.
  it('emits nothing when any locale has no indexable clusters (no partial set)', () => {
    expect(renderOrphanLandingHubHreflang({ it: true, en: true, de: true, fr: false })).toBe('');
    expect(renderOrphanLandingHubHreflang({ it: true, en: false, de: false, fr: false })).toBe('');
    expect(renderOrphanLandingHubHreflang({ it: false, en: false, de: false, fr: false })).toBe('');
  });

  it('buildOrphanLandingRoutes emits one route per cluster', () => {
    const clusters: OrphanQueryCluster[] = [
      makeCluster('it', 'chauffeur-jobs', 20, ['chauffeur'], ['svizzera']),
      makeCluster('de', 'chauffeur-jobs', 15, ['chauffeur'], ['svizzera']),
    ];
    const routes = buildOrphanLandingRoutes(clusters);
    expect(routes).toHaveLength(2);
    expect(routes[0].path).toBe('/ricerca/chauffeur-jobs/');
    expect(routes[1].path).toBe('/de/suche/chauffeur-jobs/');
  });
});

// ─── Job matching ────────────────────────────────────────────
describe('orphanQueryData — job matching', () => {
  const cluster: OrphanQueryCluster = makeCluster('it', 'chauffeur-svizzera', 30, ['chauffeur'], ['svizzera']);

  it('matches a job whose title contains the role token', () => {
    const job = activeJob({ title: 'Chauffeur Kat. C', addressLocality: 'Brunegg' });
    expect(jobMatchesCluster(job, cluster)).toBe(true);
  });

  it('does not match a job whose title has no role overlap', () => {
    const job = activeJob({ title: 'Pastry Chef', addressLocality: 'Lugano' });
    expect(jobMatchesCluster(job, cluster)).toBe(false);
  });

  it('requires locale-specific descriptions (>=50 words) for activity', () => {
    const job = activeJob({ title: 'Chauffeur Kat. C' });
    // Override description to be too short for EN
    job.descriptionByLocale = { en: 'short' };
    expect(jobMatchesCluster(job, { ...cluster, locale: 'en' })).toBe(false);
  });

  it('respects region gate when cluster has specific cities (not catch-all svizzera/ticino)', () => {
    const c: OrphanQueryCluster = makeCluster('it', 'infermiere-lugano', 12, ['infermier'], ['lugano']);
    const luganoJob = activeJob({ title: 'Infermiere', location: 'Lugano', addressLocality: 'Lugano' });
    const luzernJob = activeJob({ title: 'Infermiere', location: 'Luzern', addressLocality: 'Luzern' });
    expect(jobMatchesCluster(luganoJob, c)).toBe(true);
    expect(jobMatchesCluster(luzernJob, c)).toBe(false);
  });

  it('geo-query (generic role + named city) matches by locality, not by title token', () => {
    // "lavoro stabio svizzera" — role token is the generic word "lavoro".
    // Must surface Stabio jobs regardless of their title, and must NOT surface
    // jobs in another Swiss locality (the broad "svizzera" token alone must not
    // satisfy the geo gate). Regression for the wrong-city doorway bug.
    const c: OrphanQueryCluster = makeCluster('it', 'lavoro-stabio-svizzera', 30, ['lavor'], ['stabio', 'svizzera']);
    const stabioJob = activeJob({ title: 'Operatore di produzione', location: 'Stabio', addressLocality: 'Stabio' });
    const zurichJob = activeJob({ title: 'Operatore di produzione', location: 'Zürich', addressLocality: 'Zürich' });
    expect(jobMatchesCluster(stabioJob, c)).toBe(true);
    expect(jobMatchesCluster(zurichJob, c)).toBe(false);
  });

  it('geo-query with a city-only region (no broad token) still matches by locality', () => {
    const c: OrphanQueryCluster = makeCluster('it', 'lavoro-mendrisio', 20, ['lavor'], ['mendrisio']);
    const mendrisioJob = activeJob({ title: 'Magazziniere', location: 'Mendrisio', addressLocality: 'Mendrisio' });
    const luganoJob = activeJob({ title: 'Magazziniere', location: 'Lugano', addressLocality: 'Lugano' });
    expect(jobMatchesCluster(mendrisioJob, c)).toBe(true);
    expect(jobMatchesCluster(luganoJob, c)).toBe(false);
  });

  it('city gate is prefix-only: a short city token does NOT bleed a foreign city sharing its prefix', () => {
    // Region 'manno' (TI) must NOT match a job in 'Männedorf' (ZH). The old
    // bidirectional fuzzy matcher sliced 'mannedorf'→'mann' and accepted
    // 'manno'.startsWith('mann'); the locality gate requires the job location to
    // actually begin with the searched city.
    const geo: OrphanQueryCluster = makeCluster('it', 'lavoro-manno', 20, ['lavor'], ['manno']);
    const mannoJob = activeJob({ title: 'Magazziniere', location: 'Manno', addressLocality: 'Manno' });
    const maennedorfJob = activeJob({ title: 'Magazziniere', location: 'Männedorf', addressLocality: 'Männedorf' });
    expect(jobMatchesCluster(mannoJob, geo)).toBe(true);
    expect(jobMatchesCluster(maennedorfJob, geo)).toBe(false);

    // Same guard on the profession+city branch (role token is specific).
    const prof: OrphanQueryCluster = makeCluster('it', 'magazziniere-manno', 20, ['magazzinier'], ['manno']);
    expect(jobMatchesCluster(mannoJob, prof)).toBe(true);
    expect(jobMatchesCluster(maennedorfJob, prof)).toBe(false);
  });

  it('profession + named city + broad token: broad does NOT override the city gate', () => {
    const c: OrphanQueryCluster = makeCluster('it', 'lavoro-oss-a-stabio-svizzera', 15, ['lavor', 'oss'], ['stabio', 'svizzera']);
    const ossStabio = activeJob({ title: 'OSS operatore socio sanitario', location: 'Stabio', addressLocality: 'Stabio' });
    const ossLugano = activeJob({ title: 'OSS operatore socio sanitario', location: 'Lugano', addressLocality: 'Lugano' });
    expect(jobMatchesCluster(ossStabio, c)).toBe(true);
    expect(jobMatchesCluster(ossLugano, c)).toBe(false);
  });

  it('broad-only region (svizzera/ticino) keeps site-wide coverage', () => {
    const c: OrphanQueryCluster = makeCluster('it', 'chauffeur-ticino', 30, ['chauffeur'], ['ticino']);
    const anywhere = activeJob({ title: 'Chauffeur Kat. C', location: 'Brunegg', addressLocality: 'Brunegg' });
    expect(jobMatchesCluster(anywhere, c)).toBe(true);
  });

  it('filterMatchingJobs returns at most `limit` jobs sorted by postedDate desc', () => {
    const jobs: OrphanCountableJob[] = Array.from({ length: 10 }).map((_, i) =>
      activeJob({
        title: 'Chauffeur Kat. C',
        addressLocality: 'Brunegg',
        postedDate: `2026-04-${String(i + 1).padStart(2, '0')}`,
      }),
    );
    const out = filterMatchingJobs(jobs, cluster, 5);
    expect(out).toHaveLength(5);
    const dates = out.map((j) => j.postedDate);
    expect([...dates].sort().reverse()).toEqual(dates);
  });
});

// ─── Small helpers ───────────────────────────────────────────
describe('orphanQueryData — helpers', () => {
  it('median returns 0 for empty / all-zero input', () => {
    expect(median([])).toBe(0);
    expect(median([0, 0, 0])).toBe(0);
  });

  it('median handles odd + even lengths', () => {
    expect(median([10, 20, 30])).toBe(20);
    expect(median([10, 20, 30, 40])).toBe(25);
  });

  it('topCounts sorts by frequency desc and caps at n', () => {
    const res = topCounts(['a', 'a', 'b', 'c', 'b', 'a', 'd'], 2);
    expect(res).toEqual([
      { name: 'a', count: 3 },
      { name: 'b', count: 2 },
    ]);
  });

  it('topCounts ignores empty/undefined names', () => {
    expect(topCounts(['x', '', undefined, null, 'x'], 5)).toEqual([{ name: 'x', count: 2 }]);
  });
});

// ─── Clustering script contract ─────────────────────────────
describe('cluster-orphan-queries.mjs — deterministic output', () => {
  const inputPath = path.join(ROOT, 'data', 'gsc-orphan-queries.json');
  // FUORI dal repository. Questo caso ESEGUE lo script, e lo script scrive:
  // puntarlo al percorso canonico faceva riscrivere un file TRACCIATO a ogni
  // `npm test`, lasciando il working tree sporco di un diff di cron che non
  // c'entra con ciò su cui si sta lavorando — e che un `git add -A` in una
  // sessione agent porta dentro una PR qualsiasi. È successo il 2026-09-04.
  const outputPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-clusters-')),
    'gsc-orphan-queries-clusters.json',
  );

  it('rispetta GSC_ORPHAN_CLUSTERS_OUT e non tocca il file tracciato', () => {
    // La regressione da impedire non e' un output sbagliato, e' un EFFETTO
    // COLLATERALE: prima, eseguire questo caso riscriveva
    // data/gsc-orphan-queries-clusters.json nel working tree. Il test passava
    // lo stesso, quindi nulla lo segnalava — se ne accorgeva l'agente dopo, con
    // un file di cron finito nello stage di una PR che non c'entrava.
    const tracked = path.join(ROOT, 'data', 'gsc-orphan-queries-clusters.json');
    const before = fs.existsSync(tracked) ? fs.readFileSync(tracked, 'utf-8') : null;
    const redirect = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-guard-')), 'out.json');

    execFileSync('node', ['scripts/cluster-orphan-queries.mjs'], {
      cwd: ROOT,
      stdio: 'pipe',
      env: { ...process.env, GSC_ORPHAN_CLUSTERS_OUT: redirect },
    });

    expect(fs.existsSync(redirect), 'lo script ha ignorato GSC_ORPHAN_CLUSTERS_OUT').toBe(true);
    const after = fs.existsSync(tracked) ? fs.readFileSync(tracked, 'utf-8') : null;
    expect(after, 'lo script ha scritto il file TRACCIATO nonostante il redirect').toBe(before);
  });

  it('produces a valid clusters file when run against the repo data', () => {
    if (!fs.existsSync(inputPath)) {
      // Missing input is OK in CI — plugin degrades gracefully.
      return;
    }
    execFileSync('node', ['scripts/cluster-orphan-queries.mjs'], {
      cwd: ROOT,
      stdio: 'pipe',
      env: { ...process.env, GSC_ORPHAN_CLUSTERS_OUT: outputPath },
    });
    const parsed = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    expect(parsed).toHaveProperty('generatedAt');
    expect(parsed).toHaveProperty('clusters');
    expect(Array.isArray(parsed.clusters)).toBe(true);

    for (const c of parsed.clusters) {
      // ≥5 cumulative impressions (hard gate — thin-content safety lives
      // downstream in the build plugin via MIN_MATCHING_JOBS + word count)
      expect(c.totalImpressions).toBeGreaterThanOrEqual(5);
      // Must carry identifying metadata
      expect(typeof c.canonicalQuery).toBe('string');
      expect(typeof c.canonicalSlug).toBe('string');
      expect(c.canonicalSlug.length).toBeGreaterThan(0);
      expect(ORPHAN_LANDING_LOCALES).toContain(c.locale);
      // Queries array non-empty
      expect(Array.isArray(c.queries)).toBe(true);
      expect(c.queries.length).toBeGreaterThan(0);
    }

    // Cluster IDs unique
    const ids = parsed.clusters.map((c: { clusterId: string }) => c.clusterId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('skips clusters whose canonical slug collides with a known job slug', () => {
    if (!fs.existsSync(outputPath) || !knownSlugsStoreExists(ROOT)) return;
    const parsed = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    const known = readAllKnownJobSlugs(ROOT);
    const knownKeys = new Set(Object.keys(known || {}));
    for (const c of parsed.clusters) {
      expect(knownKeys.has(c.canonicalSlug)).toBe(false);
    }
  });
});

// ─── Fixture helpers ─────────────────────────────────────────

function makeCluster(
  locale: 'it' | 'en' | 'de' | 'fr',
  slug: string,
  impressions: number,
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
    totalImpressions: impressions,
    totalClicks: 0,
    queries: [{ query: slug.replace(/-/g, ' '), clicks: 0, impressions }],
  };
}

function activeJob(partial: Partial<OrphanCountableJob>): OrphanCountableJob {
  const longDescription = 'This job description contains more than fifty words so that the activity gate passes during the filterMatchingJobs invocation; it describes the role, the responsibilities, the benefits, the requirements, the schedule, the compensation bracket, the ideal candidate profile, and the onboarding process along with details about training, tenure, mobility, equipment, relocation, and career development pathways.';
  return {
    title: 'Generic Role',
    company: 'Acme AG',
    location: 'Lugano',
    addressLocality: 'Lugano',
    postedDate: '2026-04-18',
    description: longDescription,
    descriptionByLocale: {
      it: longDescription,
      en: longDescription,
      de: longDescription,
      fr: longDescription,
    },
    slug: 'generic-role-acme',
    ...partial,
  };
}
