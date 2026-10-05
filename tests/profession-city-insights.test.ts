/**
 * Le landing professione × città (`/lavoro-{città}-{professione}/` + en/de/fr)
 * hanno un blocco che nessuna sorella ripete (issue #11678).
 *
 * Prima del blocco tutto ciò che distingueva una pagina dalle sorelle era
 * numerico, e la maschera n. 1 di `scripts/lib/informationGain.mjs` riduce le
 * cifre a `#`: live scan del 2026-10-05 al 14,5 % sulla coorte italiana, e un
 * replay del renderer su `data/jobs.json` reale al 3,3 % in inglese e all'1,6 %
 * in tedesco, con pagine a gain zero. Questo file fissa le proprietà da cui la
 * misura dipende e rifà la misura del gate sull'output del renderer:
 *
 *   - due pagine sorelle con dati diversi producono blocchi DIVERSI;
 *   - una pagina senza dati non produce il blocco (niente titolo vuoto);
 *   - i link portano solo a coppie sopra il floor (pagine vere, mai bridge);
 *   - la coorte con il blocco sta sopra la soglia pinnata, e senza il blocco
 *     resta sotto: svuotare il blocco fa diventare rosso il test.
 *
 * Il corpus è sintetico perché `data/jobs.json` lo assembla la CI: vale la
 * relazione (con / senza blocco), non l'assoluto. La misura sul dataset reale
 * è nel body della PR e in `docs/INFORMATION-GAIN.md`.
 */
import { describe, it, expect } from 'vitest';
import { fingerprintPage, scoreCohorts, MIN_COHORT_PAGES } from '@/scripts/lib/informationGain.mjs';
import { renderProfessionCityPage } from '@/build-plugins/professionCityLandings';
import {
  renderProfessionCityInsights,
  offerLines,
  MAX_OFFER_TITLES,
  type ProfessionCitySnapshots,
} from '@/build-plugins/professionCityInsights';
import { buildProfessionCityPath, PROFESSION_CITY_KEYS } from '@/build-plugins/professionCityData';
import { PROFESSION_IDS, type ProfessionId, type ProfessionLocale } from '@/build-plugins/professionLandingsData';
import type { FeaturedJob, ProfessionJobsSnapshot } from '@/build-plugins/professionJobsAggregate';

const LOCALES: readonly ProfessionLocale[] = ['it', 'en', 'de', 'fr'];
const MIN_JOBS = 3;
const DIST = '/tmp/profession-city-insights-test';

/** Deterministic [0, 1) from a string — no Math.random, no clock. */
const unit = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
};
const pick = <T,>(pool: readonly T[], seed: string): T => pool[Math.floor(unit(seed) * pool.length)];

const SENIORITY = ['Senior', 'Junior', 'Responsabile', 'Collaboratore', 'Specialista', 'Coordinatore'];
const UNITS = ['Notfall', 'Onkologie', 'Logistik', 'Produktion', 'Kundendienst', 'Werkstatt', 'Pädiatrie', 'Labor', 'Montage', 'Planung', 'Einkauf', 'Qualität'];
const EMPLOYERS = ['Kantonsspital Alpha', 'Beta Holding AG', 'Gamma Service SA', 'Delta Bau GmbH', 'Epsilon Pharma AG', 'Zeta Retail SA', 'Eta Logistik AG', 'Theta Klinik'];

const fakeJob = (seed: string, i: number): FeaturedJob => ({
  id: `${seed}-${i}`,
  title: `${pick(SENIORITY, `${seed}:s:${i}`)} ${pick(UNITS, `${seed}:u:${i}`)} ${pick(UNITS, `${seed}:v:${i}`)}`,
  titleByLocale: {},
  company: pick(EMPLOYERS, `${seed}:e:${i}`),
  companyKey: null,
  companyDomain: null,
  city: '',
  addressLocality: null,
  canton: null,
  contract: null,
  salaryMin: null,
  salaryMax: null,
  postedDate: '',
  daysAgo: 1,
  slug: `${seed}-${i}`,
  slugByLocale: {},
  employmentType: null,
  url: null,
});

const snapshotFor = (cityKey: string, id: ProfessionId): ProfessionJobsSnapshot => {
  const seed = `${cityKey}:${id}`;
  const liveCount = Math.floor(unit(seed) * 20);
  const jobs = Array.from({ length: liveCount }, (_, i) => fakeJob(seed, i));
  return {
    liveCount,
    fresh30Count: liveCount % 5,
    medianSalaryChf: null,
    featured: jobs.slice(0, 3),
    jobs,
    // Gli stessi due datori ovunque: il gain non deve poter venire da qui.
    topEmployers: EMPLOYERS.slice(0, 2).map((name, i) => ({ name, count: Math.max(1, liveCount - i) })),
  };
};

const byCity: ProfessionCitySnapshots = Object.fromEntries(
  PROFESSION_CITY_KEYS.map((k) => [k, Object.fromEntries(PROFESSION_IDS.map((id) => [id, snapshotFor(k, id)]))]),
);

const emptySnapshot: ProfessionJobsSnapshot = {
  liveCount: 0,
  fresh30Count: 0,
  medianSalaryChf: null,
  featured: [],
  jobs: [],
  topEmployers: [],
};

const visibleText = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('blocco professione × città: dati diversi, testo diverso', () => {
  it('due professioni sorelle nella stessa città producono blocchi diversi', () => {
    const a = renderProfessionCityInsights({ locale: 'it', cityKey: 'lugano', id: 'infermiere', snapshot: snapshotFor('lugano', 'infermiere'), byCity, minJobs: MIN_JOBS });
    const b = renderProfessionCityInsights({ locale: 'it', cityKey: 'lugano', id: 'ingegnere', snapshot: snapshotFor('lugano', 'ingegnere'), byCity, minJobs: MIN_JOBS });
    expect(a).not.toBe('');
    expect(b).not.toBe('');
    expect(visibleText(a)).not.toBe(visibleText(b));
  });

  it('la stessa professione in due città produce blocchi diversi', () => {
    const a = renderProfessionCityInsights({ locale: 'de', cityKey: 'zurich', id: 'infermiere', snapshot: snapshotFor('zurich', 'infermiere'), byCity, minJobs: MIN_JOBS });
    const b = renderProfessionCityInsights({ locale: 'de', cityKey: 'bern', id: 'infermiere', snapshot: snapshotFor('bern', 'infermiere'), byCity, minJobs: MIN_JOBS });
    expect(visibleText(a)).not.toBe(visibleText(b));
  });

  it('una pagina senza dati non produce il blocco', () => {
    expect(renderProfessionCityInsights({ locale: 'it', cityKey: 'lugano', id: 'infermiere', snapshot: emptySnapshot, minJobs: MIN_JOBS })).toBe('');
    // Anche con le sorelle tutte sotto il floor: nessuna città, nessuna professione da nominare.
    const allBelow: ProfessionCitySnapshots = Object.fromEntries(
      PROFESSION_CITY_KEYS.map((k) => [k, Object.fromEntries(PROFESSION_IDS.map((id) => [id, { ...emptySnapshot, liveCount: MIN_JOBS - 1 }]))]),
    );
    expect(renderProfessionCityInsights({ locale: 'fr', cityKey: 'geneve', id: 'infermiere', snapshot: emptySnapshot, byCity: allBelow, minJobs: MIN_JOBS })).toBe('');
    const page = renderProfessionCityPage({ locale: 'it', cityKey: 'lugano', id: 'infermiere', snapshot: { ...emptySnapshot, liveCount: MIN_JOBS }, distDir: DIST });
    expect(page.html).not.toContain('data-profession-city-insights');
  });

  it('nomina le offerte reali, una riga ciascuna, al massimo il tetto', () => {
    const snap = snapshotFor('zurich', 'infermiere');
    const lines = offerLines(snap.jobs!, 'it', 'Zürich');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(MAX_OFFER_TITLES);
    expect(new Set(lines).size).toBe(lines.length);
    const html = renderProfessionCityInsights({ locale: 'it', cityKey: 'zurich', id: 'infermiere', snapshot: snap, byCity, minJobs: MIN_JOBS });
    for (const line of lines) expect(html).toContain(`<li>${line}</li>`);
  });

  it('non ripete la località quando è la città della pagina', () => {
    const job = { ...fakeJob('x', 0), title: 'Pflegefachperson Notfall', company: 'Theta Klinik' };
    expect(offerLines([{ ...job, addressLocality: 'Basel BS' }], 'it', 'Basel')).toEqual(['Pflegefachperson Notfall — Theta Klinik']);
    expect(offerLines([{ ...job, addressLocality: 'Riehen' }], 'it', 'Basel')).toEqual(['Pflegefachperson Notfall — Theta Klinik — Riehen']);
  });

  it('linka solo coppie sopra il floor, mai la pagina stessa', () => {
    const html = renderProfessionCityInsights({ locale: 'en', cityKey: 'bern', id: 'infermiere', snapshot: snapshotFor('bern', 'infermiere'), byCity, minJobs: MIN_JOBS });
    const links = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(0);
    expect(links).not.toContain(buildProfessionCityPath('en', 'bern', 'infermiere'));
    for (const k of PROFESSION_CITY_KEYS) {
      for (const id of PROFESSION_IDS) {
        if ((byCity[k]?.[id]?.liveCount ?? 0) < MIN_JOBS) expect(links).not.toContain(buildProfessionCityPath('en', k, id));
      }
    }
  });
});

describe('information gain della famiglia professione × città, sull’output del renderer', () => {
  const render = (locale: ProfessionLocale, withBlock: boolean) =>
    PROFESSION_CITY_KEYS.flatMap((cityKey) =>
      PROFESSION_IDS.flatMap((id) => {
        const snap = byCity[cityKey]![id]!;
        if (snap.liveCount < MIN_JOBS) return [];
        const urlPath = buildProfessionCityPath(locale, cityKey, id);
        const { html } = renderProfessionCityPage({
          locale,
          cityKey,
          id,
          snapshot: withBlock ? snap : { ...snap, featured: [], jobs: [] },
          byCity: withBlock ? byCity : undefined,
          distDir: DIST,
        });
        return [fingerprintPage(`${urlPath.replace(/^\//, '')}index.html`, html)];
      }),
    );
  const largest = (locale: ProfessionLocale, withBlock: boolean) =>
    scoreCohorts(render(locale, withBlock), { minCohortPages: 2 }).cohorts.sort((a, b) => b.pages - a.pages)[0];

  // Misurato il 2026-10-05 su questo corpus sintetico (170-219 pagine per
  // locale): 18,3-20,3 % con il blocco, 12,5-13,3 % senza. Soglia = il minimo
  // misurato meno un punto, sopra il valore senza blocco.
  const MIN = 17.3;

  for (const locale of LOCALES) {
    it(`${locale}: la coorte più grande sta sopra ${MIN} % con il blocco, e sotto senza`, () => {
      const withBlock = largest(locale, true);
      const without = largest(locale, false);
      expect(withBlock.pages).toBeGreaterThanOrEqual(MIN_COHORT_PAGES);
      expect(withBlock.medianIgs).toBeGreaterThanOrEqual(MIN);
      expect(withBlock.zeroGainPages).toBe(0);
      expect(without.medianIgs).toBeLessThan(MIN);
    });
  }
});
