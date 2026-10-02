/**
 * I due residui di `audit:max-bfs-depth` su sitemap-jobs.xml (build f3659686):
 *
 * 1. `/{cantone}/aziende/` linkava `azienda-{employerKey}` dallo snapshot
 *    settimanale: a Zurigo 28 link su 100 finivano su bridge noindex e 26 su
 *    pagine inesistenti, con il prefisso italiano anche in en/de/fr. Ora linka
 *    gli hub che jobsSeoPagesPlugin emette davvero
 *    (build-plugins/shared/cantonCompanyHubRegistry.ts).
 * 2. L'archivio `tutti/page-N/` era costruito solo dallo snapshot settimanale:
 *    307 delle 1 708 schede IT di Zurigo in sitemap non c'erano, e 44 delle 55
 *    schede sepolte venivano da lì. Ora è snapshot ∪ inventario live, con lo
 *    stesso dato per il navigatore della landing e per le pagine emesse
 *    (build-plugins/shared/cantonArchivePlan.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs, { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  _resetCantonCompanyHubRegistry,
  cantonCompanyHubs,
  markCantonCompanyHub,
} from '../build-plugins/shared/cantonCompanyHubRegistry';
import {
  _resetLiveCantonArchiveJobs,
  cantonArchivePageCount,
  mergeLiveArchiveJobs,
  readCantonArchiveData,
  readJobsData,
  setLiveCantonArchiveJobs,
  type CantonJobEntry,
} from '../build-plugins/shared/cantonArchivePlan';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

afterEach(() => {
  _resetCantonCompanyHubRegistry();
  _resetLiveCantonArchiveJobs();
});

describe('registro degli hub azienda per cantone', () => {
  it('restituisce gli hub emessi, i più grandi per primi', () => {
    markCantonCompanyHub('ZH', { slug: 'stadler-rail', name: 'Stadler Rail', jobs: 12, logoKey: 'stadler' });
    markCantonCompanyHub('ZH', { slug: 'migros-hq-zurich', name: 'Migros HQ', jobs: 31, logoKey: 'migros' });
    markCantonCompanyHub('ZH', { slug: 'abb', name: 'ABB', jobs: 12, logoKey: 'abb' });
    markCantonCompanyHub('BE', { slug: 'post', name: 'Post', jobs: 40, logoKey: 'post' });
    expect(cantonCompanyHubs('ZH').map((h) => h.slug)).toEqual(['migros-hq-zurich', 'abb', 'stadler-rail']);
    expect(cantonCompanyHubs('TI')).toEqual([]);
  });

  it('jobsSeoPagesPlugin registra solo gli hub sopra soglia, prima del loop dei locale', () => {
    const src = read('build-plugins/jobsSeoPagesPlugin.ts');
    const phase = src.slice(src.indexOf('/* ── Per-canton company hubs (Phase 3.3)'), src.indexOf('/* ── Per-canton company × city hubs (Phase 3.4)'));
    const bridge = phase.indexOf('emitCompanyCantonBelowFloorBridge(locale, canton');
    const mark = phase.indexOf('markCantonCompanyHub(canton, {');
    const loop = phase.indexOf('const cappedJobs = sortedJobs.slice(0, COMPANY_JOB_PAYLOAD_CAP);');
    expect(bridge).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(bridge);
    expect(mark).toBeLessThan(loop);
    expect(phase.slice(mark, loop)).toContain('slug: cSlug,');
  });

  it('la pagina aziende linka gli hub registrati con slug e prefisso del locale', () => {
    const src = read('build-plugins/seoHubsPlugin.ts');
    const block = src.slice(src.indexOf("// ── aziende (companies)"));
    expect(block).toContain('const emittedHubs = cantonCompanyHubs(canton).slice(0, 100);');
    expect(block).toContain('href: `${sectionRoot}/${COMPANY_ROUTE_PREFIX[locale]}-${hub.slug}/`,');
  });
});

describe('archivio tutti/page-N: snapshot ∪ inventario live', () => {
  const entry = (slug: string, extra: Partial<CantonJobEntry> = {}): CantonJobEntry => ({
    slug, role: slug, employer: 'Acme', employerKey: 'acme', city: 'Zürich', ...extra,
  });
  const snapshot = () => ({
    counts: new Map<string, number>(),
    urlToKey: new Map<string, string>(),
    cantonJobCounts: new Map([['ZH', 3]]),
    cantonJobs: new Map([['ZH', [entry('c-old'), entry('a-live'), entry('b-gone')]]]),
    cantonEmployerCounts: new Map([['ZH', new Map([['acme', 3]])]]),
  });

  it('tiene l\'ordine dello snapshot, aggiunge in coda i job nuovi e non toglie niente', () => {
    const hrefs = { it: '/cerca-lavoro-zurigo/a-live/', en: '/en/find-jobs-zurich/a-live-en/' };
    const live = new Map([['ZH', [
      entry('z-new', { employerKey: 'beta', hrefByLocale: { it: '/cerca-lavoro-zurigo/z-new/' } }),
      entry('a-live', { hrefByLocale: hrefs }),
      entry('m-new', { employerKey: 'beta', hrefByLocale: { it: '/cerca-lavoro-zurigo/m-new/' } }),
    ]]]);
    const merged = mergeLiveArchiveJobs(snapshot(), live);
    expect(merged.cantonJobs.get('ZH')!.map((e) => e.slug)).toEqual(['c-old', 'a-live', 'b-gone', 'm-new', 'z-new']);
    expect(merged.cantonJobs.get('ZH')![1].hrefByLocale).toEqual(hrefs);
    expect(merged.cantonJobCounts.get('ZH')).toBe(5);
    expect(merged.cantonEmployerCounts.get('ZH')!.get('beta')).toBe(2);
    expect(merged.cantonEmployerCounts.get('ZH')!.get('acme')).toBe(3);
  });

  it('non muta lo snapshot di partenza', () => {
    const snap = snapshot();
    mergeLiveArchiveJobs(snap, new Map([['ZH', [entry('n-new')]]]));
    expect(snap.cantonJobs.get('ZH')!.map((e) => e.slug)).toEqual(['c-old', 'a-live', 'b-gone']);
    expect(snap.cantonJobCounts.get('ZH')).toBe(3);
  });

  it('la sorgente unica legge il registro live quando c\'è, lo snapshot da solo altrimenti', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'canton-archive-'));
    try {
      mkdirSync(path.join(root, 'data', 'jobs-snapshots-history'), { recursive: true });
      writeFileSync(path.join(root, 'data', 'jobs-snapshots-history', '2026-40.json'), JSON.stringify({
        jobs: [{ slug: 'old-job-acme-zurich', employer: 'Acme', employerKey: 'acme', city: 'Zürich', canton: 'ZH', role: 'Old' }],
      }));
      const alone = readCantonArchiveData(fs, path, root);
      expect(alone.cantonJobs.get('ZH')!.map((e) => e.slug)).toEqual(['old-job-acme-zurich']);
      expect(readJobsData(fs, path, root).cantonJobs.get('ZH')!.map((e) => e.slug)).toEqual(['old-job-acme-zurich']);
      setLiveCantonArchiveJobs(new Map([['ZH', [entry('new-job-beta-zurich', { hrefByLocale: { it: '/cerca-lavoro-zurigo/new-job-beta-zurich/' } })]]]));
      const withLive = readCantonArchiveData(fs, path, root);
      expect(withLive.cantonJobs.get('ZH')!.map((e) => e.slug)).toEqual(['old-job-acme-zurich', 'new-job-beta-zurich']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('il numero di pagine cresce con i job aggiunti (landing e archivio lo leggono dalla stessa sorgente)', () => {
    const jobs = Array.from({ length: 150 }, (_, i) => entry(`job-${i}`, { role: `Ruolo ${i}`, employerKey: `e${i}` }));
    expect(cantonArchivePageCount(100, jobs.slice(0, 100), true)).toBe(1);
    expect(cantonArchivePageCount(150, jobs, true)).toBe(2);
  });

  it('jobsSeoPagesPlugin registra l\'inventario live prima di pianificare il navigatore', () => {
    const src = read('build-plugins/jobsSeoPagesPlugin.ts');
    const set = src.indexOf('setLiveCantonArchiveJobs(liveArchiveJobs);');
    const readAt = src.indexOf('const archiveSnapshot = readCantonArchiveData(fs, path, rootDir);');
    expect(set).toBeGreaterThan(-1);
    expect(readAt).toBeGreaterThan(set);
    expect(src).not.toMatch(/\breadJobsData\(/);
    // Il path live è quello della scheda emessa (stesso schema del loop dei job attivi).
    expect(src.slice(src.indexOf('const liveArchiveJobs'), set)).toContain(
      'withSlash(`${localePrefix[l]}/${buildCantonAwareSection(l, jobCanton)}/${localizedSlug(job, l)}`',
    );
  });

  it('seoHubsPlugin emette l\'archivio dalla stessa sorgente e usa il path live per primo', () => {
    const src = read('build-plugins/seoHubsPlugin.ts');
    expect(src).toContain('} = readCantonArchiveData(fs, np, rootDir);');
    expect(src).not.toMatch(/\breadJobsData\(/);
    expect(src).toContain('const livePath = j.hrefByLocale?.[locale];');
    expect(src).toMatch(/const href = livePath\s*\n\s*\|\| \(localePath/);
  });
});
