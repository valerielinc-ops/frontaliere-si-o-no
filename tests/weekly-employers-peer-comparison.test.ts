/**
 * Il blocco «confronto fra le città pari della stessa settimana» sulle leaf
 * `/aziende-che-assumono/` (issue #7595).
 *
 * `tests/information-gain-families-floor.test.ts` misura l'EFFETTO del blocco
 * sulla metrica; qui si fissano le tre proprietà da cui quell'effetto dipende e
 * che un refactor può rompere senza far scendere subito la mediana:
 *
 *   1. il blocco NOMINA le pagine sorelle — se i nomi sparissero resterebbero
 *      solo cifre, che la maschera n. 1 azzera;
 *   2. due sorelle della stessa settimana ricevono un testo DIVERSO;
 *   3. lo stesso input rende lo stesso HTML — il blocco emette link interni, e
 *      un ordinamento non deterministico rimescolerebbe il link graph a ogni
 *      build (i pareggi fra città con lo stesso numero di annunci sono la
 *      norma, non l'eccezione).
 */
import { describe, expect, it } from 'vitest';
import { renderWeeklyEmployersCorpus, weeklyJobsFixture } from './weekly-employers-peer-fixture';
import { buildCityWeeklyStats, renderWeeklyEmployersPage } from '@/build-plugins/weeklyEmployersPlugin';
import { WEEKLY_EMPLOYERS_CITIES, buildArchiveWeekPath } from '@/build-plugins/weeklyEmployersData';

const blockOf = (html: string): string =>
  html.match(/<section data-peer-comparison=["']?1["']?[\s\S]*?<\/section>/)?.[0] ?? '';

const corpus = renderWeeklyEmployersCorpus();
const pageAt = (urlPath: string) => corpus.find((p) => p.urlPath === urlPath)!;

describe('confronto fra città pari sulle leaf settimanali', () => {
  it('nomina le città sorelle, non solo le cifre', () => {
    const block = blockOf(pageAt(buildArchiveWeekPath('it', 'mendrisio', 30, 2026)).html);
    expect(block).not.toBe('');
    const named = WEEKLY_EMPLOYERS_CITIES.filter(
      (c) => c !== 'ticino' && c !== 'mendrisio' && new RegExp(c, 'i').test(block),
    );
    expect(named.length).toBeGreaterThanOrEqual(3);
  });

  it('linka le sorelle alla LORO pagina della stessa settimana', () => {
    const block = blockOf(pageAt(buildArchiveWeekPath('it', 'chiasso', 31, 2026)).html);
    expect(block).toContain(`href="${buildArchiveWeekPath('it', 'lugano', 31, 2026)}"`);
    expect(block).not.toContain('settimana-30-2026');
  });

  it('dice cose diverse su due città della stessa settimana', () => {
    const a = blockOf(pageAt(buildArchiveWeekPath('it', 'lugano', 32, 2026)).html);
    const b = blockOf(pageAt(buildArchiveWeekPath('it', 'stabio', 32, 2026)).html);
    expect(a).not.toBe('');
    expect(a).not.toEqual(b);
  });

  it('non compare sull’hub regionale, che è la somma delle sue città', () => {
    expect(blockOf(pageAt(buildArchiveWeekPath('it', 'ticino', 30, 2026)).html)).toBe('');
  });

  it('è assente quando la coorte non viene passata (render isolato)', () => {
    const jobs = weeklyJobsFixture(30);
    const html = renderWeeklyEmployersPage({
      locale: 'it',
      city: 'lugano',
      variant: 'archive',
      weekNum: 30,
      year: 2026,
      stats: buildCityWeeklyStats({ city: 'lugano', locale: 'it', jobs }),
      hasHistoricalDelta: false,
      canonicalPath: buildArchiveWeekPath('it', 'lugano', 30, 2026),
      today: new Date('2026-09-05T00:00:00Z'),
      indexable: true,
    });
    expect(blockOf(html)).toBe('');
  });

  it('è deterministico: due render dello stesso input sono identici', () => {
    const again = renderWeeklyEmployersCorpus();
    for (const page of corpus) {
      const twin = again.find((p) => p.urlPath === page.urlPath)!;
      expect(blockOf(twin.html)).toEqual(blockOf(page.html));
    }
  });
});
