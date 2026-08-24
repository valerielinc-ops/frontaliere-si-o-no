/**
 * The per-page comparison block that replaced the fixed link grid in the six
 * municipality families (issue #5002).
 *
 * Three things are pinned, in order of what would hurt most if it broke:
 *
 *  1. PER-PAGE DISTINCTNESS on the real datasets. This is the whole point: the
 *     block exists because the families were mail-merges. A refactor that made
 *     the neighbour set page-independent would restore the defect while every
 *     other test stayed green.
 *  2. DETERMINISM. The renderer runs inside the build. If the neighbour order
 *     depended on the input order, every deploy would rewrite the internal
 *     links of ~950 pages.
 *  3. NO FAMILY GOES BACK to `ABOVE_FLOOR.filter(self).slice(0, 6)` — asserted
 *     against the plugin sources, because that construct is what four of the
 *     five families shipped and nothing in the type system forbids returning
 *     to it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  nearestComparablePlaces,
  renderNearestComparison,
  buildComparisonProse,
  formatDistanceKm,
  type ComparisonColumn,
} from '@/build-plugins/shared/nearestMunicipalityComparison';
import { FISCAL_ABOVE_FLOOR } from '@/build-plugins/fiscalMunicipalityData';
import { renderAboveFloorPage as renderFiscalPage } from '@/build-plugins/fiscalMunicipalityPagesPlugin';
import { MUNICIPALITIES } from '@/data/municipalities';
import { renderPage as renderItalianPage } from '@/build-plugins/borderMunicipalityPagesPlugin';
import { TICINO_VITA_CORRIDOR_PROVINCES } from '@/build-plugins/shared/borderMunicipalityCorridors';

const REPO_ROOT = path.resolve(__dirname, '..');

type Fake = { name: string; slug: string; lat: number; lng: number; value: number };

const fake = (name: string, lat: number, lng: number, value: number): Fake => ({
  name,
  slug: name.toLowerCase(),
  lat,
  lng,
  value,
});

const POOL: Fake[] = [
  fake('Centro', 45.8, 8.95, 10),
  fake('Vicino', 45.81, 8.95, 20),
  fake('Medio', 45.85, 8.95, 30),
  fake('Lontano', 46.2, 8.95, 10),
];

const valueColumn: ComparisonColumn<Fake> = {
  header: 'Valore',
  value: (p) => String(p.value),
  numeric: (p) => p.value,
  formatNumeric: (v) => String(v),
  spreadLabel: 'il valore',
};

describe('nearestComparablePlaces', () => {
  it('ordina per distanza ed esclude il posto corrente', () => {
    const got = nearestComparablePlaces(POOL[0], POOL, (p) => p.slug, 6);
    expect(got.map((n) => n.place.name)).toEqual(['Vicino', 'Medio', 'Lontano']);
  });

  it('è deterministico: l’ordine del pool non cambia il risultato', () => {
    const forward = nearestComparablePlaces(POOL[0], POOL, (p) => p.slug, 6);
    const reversed = nearestComparablePlaces(POOL[0], [...POOL].reverse(), (p) => p.slug, 6);
    expect(reversed.map((n) => n.place.slug)).toEqual(forward.map((n) => n.place.slug));
  });

  it('rompe le parità sulla chiave, non sull’ordine dell’array', () => {
    // Due posti alla stessa distanza esatta: senza la seconda chiave il loro
    // ordine arriverebbe dall'array e cambierebbe l'HTML a ogni rigenerazione
    // del dataset.
    const tied = [fake('Zeta', 45.81, 8.95, 1), fake('Alfa', 45.81, 8.95, 1)];
    const got = nearestComparablePlaces(POOL[0], [POOL[0], ...tied], (p) => p.slug, 6);
    expect(got.map((n) => n.place.name)).toEqual(['Alfa', 'Zeta']);
  });
});

describe('prosa del confronto', () => {
  const neighbours = nearestComparablePlaces(POOL[0], POOL, (p) => p.slug, 6);

  it('nomina i vicini e dichiara il raggio', () => {
    const [lead] = buildComparisonProse({ locale: 'it', current: POOL[0], neighbours, keyOf: (p) => p.slug });
    expect(lead).toContain('Vicino, Medio e Lontano');
    expect(lead).toContain('Centro');
  });

  it('dichiara lo spread con i detentori del minimo e del massimo', () => {
    const sentences = buildComparisonProse({
      locale: 'it',
      current: POOL[0],
      neighbours,
      keyOf: (p) => p.slug,
      spreadColumn: valueColumn,
    });
    expect(sentences.some((s) => s.includes('va da 10 (Centro) a 30 (Medio)'))).toBe(true);
  });

  it('conta il rango come «quanti stanno sotto», non come posizione nell’array', () => {
    // `irpefAddizionale` ha nove valori distinti su 518 comuni: le parità sono
    // la norma, e leggere la posizione dall'array ordinato racconterebbe a
    // quattro comuni con la stessa aliquota di essere 1°, 2°, 3° e 4°.
    const sentences = buildComparisonProse({
      locale: 'it',
      current: POOL[0],
      neighbours,
      keyOf: (p) => p.slug,
      spreadColumn: valueColumn,
    });
    const rank = sentences.find((s) => s.includes('partendo dal più basso'));
    expect(rank).toContain('1° su 4');
    expect(rank).toContain('a pari merito con un altro');
  });

  it('un gruppo piatto lo dice, invece di inventare una classifica', () => {
    const flatPool = [fake('Uno', 45.8, 8.95, 7), fake('Due', 45.81, 8.95, 7), fake('Tre', 45.82, 8.95, 7)];
    const sentences = buildComparisonProse({
      locale: 'it',
      current: flatPool[0],
      neighbours: nearestComparablePlaces(flatPool[0], flatPool, (p) => p.slug, 6),
      keyOf: (p) => p.slug,
      spreadColumn: valueColumn,
    });
    expect(sentences.some((s) => s.includes('identica per tutti'))).toBe(true);
    expect(sentences.some((s) => s.includes('partendo dal più basso'))).toBe(false);
  });

  it('rende le distanze con una cifra sotto i 10 km e nessuna sopra', () => {
    expect(formatDistanceKm(4.23, 'it')).toBe('4,2 km');
    expect(formatDistanceKm(21.6, 'it')).toBe('22 km');
  });
});

describe('renderNearestComparison', () => {
  const render = (locale: 'it' | 'en' | 'de' | 'fr') =>
    renderNearestComparison<Fake>({
      locale,
      current: POOL[0],
      pool: POOL,
      keyOf: (p) => p.slug,
      hrefFor: (p) => `/x/${p.slug}/`,
      columns: [valueColumn],
    });

  it('linka ogni vicino e marca la riga corrente', () => {
    const html = render('it');
    expect(html).toContain('href="/x/vicino/"');
    expect(html).toContain('href="/x/medio/"');
    expect(html).not.toContain('href="/x/centro/"'); // la riga di questa pagina non è un link a se stessa
  });

  it('mette la tabella in un contenitore scrollabile', () => {
    // AGENTS.md: contenuto largo scrolla dentro il suo contenitore, il body
    // della pagina non scrolla in orizzontale.
    expect(render('it')).toContain('overflow-x-auto');
  });

  it('rende in tutti e quattro i locali', () => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const html = render(locale);
      expect(html).toContain('data-nearest-comparison');
      expect(html.length).toBeGreaterThan(400);
    }
  });

  it('non emette nulla quando non c’è niente da confrontare', () => {
    // Un heading «confronta» con una riga sola è una promessa non mantenuta —
    // e conterebbe come prosa di template nell'audit.
    const alone = [POOL[0], POOL[1]];
    expect(
      renderNearestComparison<Fake>({
        locale: 'it',
        current: alone[0],
        pool: alone,
        keyOf: (p) => p.slug,
        hrefFor: (p) => `/x/${p.slug}/`,
        columns: [valueColumn],
      }),
    ).toBe('');
  });

  it('appende le frasi calcolate dalla famiglia', () => {
    const html = renderNearestComparison<Fake>({
      locale: 'it',
      current: POOL[0],
      pool: POOL,
      keyOf: (p) => p.slug,
      hrefFor: (p) => `/x/${p.slug}/`,
      columns: [valueColumn],
      extraProse: ({ current }) => [`Frase di famiglia per ${current.name}.`],
    });
    expect(html).toContain('Frase di famiglia per Centro.');
  });
});

describe('sui dataset reali il blocco è diverso su ogni pagina', () => {
  it('guida fiscale: due comuni con la STESSA aliquota hanno blocchi diversi', () => {
    // Il caso che rendeva la famiglia un mail-merge: 346 dei 518 comuni
    // condividono 0,55 %, quindi la sola aliquota non differenzia le pagine.
    const sameRate = FISCAL_ABOVE_FLOOR.filter((m) => m.irpefAddizionale === 0.55).slice(0, 2);
    expect(sameRate).toHaveLength(2);

    const [a, b] = sameRate.map(
      (m) =>
        renderFiscalPage({
          municipality: m,
          locale: 'it',
          dateStamp: '2026-08-24',
          distDir: '/tmp/does-not-need-to-exist',
        }).html,
    );
    const block = (html: string) => html.slice(html.indexOf('data-nearest-comparison'));
    expect(block(a)).not.toBe(block(b));
    expect(block(a).length).toBeGreaterThan(500);
  });

  it('guida fiscale: la pagina cita i propri vicini geografici', () => {
    const tradate = FISCAL_ABOVE_FLOOR.find((m) => m.slug === 'tradate');
    if (!tradate) return; // il floor del dataset può cambiare: non è questo il test del dataset
    const { html } = renderFiscalPage({
      municipality: tradate,
      locale: 'it',
      dateStamp: '2026-08-24',
      distDir: '/tmp/does-not-need-to-exist',
    });
    const nearest = nearestComparablePlaces(tradate, FISCAL_ABOVE_FLOOR, (m) => m.slug, 6);
    for (const entry of nearest) {
      expect(html).toContain(entry.place.name);
    }
  });

  it('comuni di frontiera: il blocco c’è e nomina vicini diversi per comune', () => {
    const corridor = MUNICIPALITIES.filter((m) => TICINO_VITA_CORRIDOR_PROVINCES.has(m.province));
    const [first, second] = [corridor[0], corridor[Math.floor(corridor.length / 2)]];
    const html = (m: (typeof corridor)[number]) =>
      renderItalianPage({
        municipality: m,
        locale: 'it',
        dateStamp: '2026-08-24',
        distDir: '/tmp/does-not-need-to-exist',
        waitSnapshot: {},
      }).html;
    const a = html(first);
    const b = html(second);
    expect(a).toContain('data-nearest-comparison');
    expect(b).toContain('data-nearest-comparison');
    const block = (h: string) => h.slice(h.indexOf('data-nearest-comparison'));
    expect(block(a)).not.toBe(block(b));
  });

  it('un comune senza addizionale non riceve la frase del delta in euro', () => {
    // I 51 comuni valdostani hanno `irpefAddizionale: 0` per statuto speciale,
    // non perché siano i più economici: `services/irpefAddizionaleRegime.ts`
    // esiste per impedire che quello zero venga confrontato sulla stessa scala.
    const noSurcharge = FISCAL_ABOVE_FLOOR.find((m) => m.province === 'AO');
    if (!noSurcharge) return; // dataset senza AO: niente da asserire
    const { html } = renderFiscalPage({
      municipality: noSurcharge,
      locale: 'it',
      dateStamp: '2026-08-24',
      distDir: '/tmp/does-not-need-to-exist',
    });
    expect(html).toContain('data-nearest-comparison');
    expect(html).not.toContain('la differenza di addizionale rispetto a');
    expect(html).not.toContain("È l'addizionale più bassa del gruppo");
  });
});

describe('la griglia di link fissa non torna', () => {
  const FAMILY_PLUGINS = [
    'build-plugins/fiscalMunicipalityPagesPlugin.ts',
    'build-plugins/austrianBorderMunicipalityPagesPlugin.ts',
    'build-plugins/germanBorderMunicipalityPagesPlugin.ts',
    'build-plugins/frenchBorderMunicipalityPagesPlugin.ts',
    'build-plugins/liechtensteinBorderMunicipalityPagesPlugin.ts',
    'build-plugins/borderMunicipalityPagesPlugin.ts',
  ];

  /**
   * Il costrutto vietato, verificato contro le versioni pre-#5002 dei cinque
   * plugin: `X_ABOVE_FLOOR.filter((m) => m.slug !== current.slug)` — la lista
   * globale filtrata solo su se stessa, con o senza `.slice(0, 6)`. Il limite
   * di 120 caratteri tiene il match dentro una singola espressione senza
   * fermarsi alla prima `)`, che è la parentesi del parametro della lambda:
   * una prima versione di questa regex usava `[^)]*` e per quel motivo non
   * matchava NESSUNO dei cinque originali — un guard verde perché cieco.
   */
  const FIXED_GRID_RE = /ABOVE_FLOOR\.filter\([^;]{0,120}?slug !== current\.slug\)/;

  it('nessuna famiglia costruisce più i «related» affettando la lista globale', () => {
    const offenders = FAMILY_PLUGINS.filter((rel) =>
      FIXED_GRID_RE.test(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8').replace(/\s+/g, ' ')),
    );
    expect(
      offenders,
      'Questi plugin sono tornati alla griglia fissa: la stessa manciata di comuni su ogni pagina.\n' +
        'È il difetto misurato in #5002 (gain 0,0 % sulla famiglia fiscale) e la concentrazione\n' +
        'dei link in entrata che #5107 ha rimosso dagli articoli. Usa renderNearestComparison.',
    ).toEqual([]);
  });

  it('tutte e sei le famiglie usano il renderer condiviso', () => {
    const missing = FAMILY_PLUGINS.filter(
      (rel) => !fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8').includes('renderNearestComparison'),
    );
    expect(missing).toEqual([]);
  });
});
