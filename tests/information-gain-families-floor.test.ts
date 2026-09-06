/**
 * Le sei famiglie comunali stanno sopra il loro floor di information gain,
 * misurato sull'HTML che i plugin emettono ADESSO (issue #5002).
 *
 * PERCHÉ NON BASTA IL GATE SU dist/
 * ---------------------------------------------------------------------------
 * `audit-information-gain.mjs` gira in `post-deploy-validate-dist.yml`: vede
 * il numero solo DOPO il merge e dopo il deploy. Un refactor che svuotasse il
 * blocco del confronto — un `pool` sbagliato, un `keyOf` che collide, un
 * `limit` a 1 — passerebbe typecheck, test unitari e review, e il rosso
 * arriverebbe il giorno dopo su un corpus già pubblicato.
 *
 * Questo test rende OGNI pagina above-floor delle sei famiglie e ripassa
 * l'output al motore della metrica, cioè fa pre-merge la stessa misura che il
 * gate fa post-deploy. È anche la misura citata in `docs/INFORMATION-GAIN.md`:
 * il documento e il test non possono divergere perché la prendono dallo stesso
 * posto.
 *
 * LE SOGLIE SONO I VALORI MISURATI, NON NUMERI SCELTI
 * ---------------------------------------------------------------------------
 * Ogni soglia è il valore misurato il 2026-08-24 meno un margine di 1 punto.
 * Il margine c'è perché la mediana di una famiglia si muove quando il dataset
 * cambia (un comune above-floor in più sposta i vicini di qualcuno), non per
 * lasciare spazio a una regressione: 1 punto è meno del contributo di UNA
 * frase page-specific su queste pagine.
 */
import { describe, it, expect } from 'vitest';
import { fingerprintPage, scoreCohorts } from '@/scripts/lib/informationGain.mjs';
import { FISCAL_ABOVE_FLOOR } from '@/build-plugins/fiscalMunicipalityData';
import { renderAboveFloorPage as renderFiscal } from '@/build-plugins/fiscalMunicipalityPagesPlugin';
import { AUSTRIAN_ABOVE_FLOOR } from '@/build-plugins/austrianBorderMunicipalityData';
import { renderAboveFloorPage as renderAustrian } from '@/build-plugins/austrianBorderMunicipalityPagesPlugin';
import { GERMAN_ABOVE_FLOOR } from '@/build-plugins/germanBorderMunicipalityData';
import { renderAboveFloorPage as renderGerman } from '@/build-plugins/germanBorderMunicipalityPagesPlugin';
import { FRENCH_ABOVE_FLOOR } from '@/build-plugins/frenchBorderMunicipalityData';
import { renderAboveFloorPage as renderFrench } from '@/build-plugins/frenchBorderMunicipalityPagesPlugin';
import { LIECHTENSTEIN_ABOVE_FLOOR } from '@/build-plugins/liechtensteinBorderMunicipalityData';
import { renderAboveFloorPage as renderLiechtenstein } from '@/build-plugins/liechtensteinBorderMunicipalityPagesPlugin';
import { MUNICIPALITIES } from '@/data/municipalities';
import { renderPage as renderItalian } from '@/build-plugins/borderMunicipalityPagesPlugin';
import { TICINO_VITA_CORRIDOR_PROVINCES } from '@/build-plugins/shared/borderMunicipalityCorridors';
import { generateBorderWaitPages } from '@/build-plugins/borderWaitPagesPlugin';

const DIST = '/tmp/information-gain-families';

type Rendered = { urlPath: string; html: string };

/** Misurato il 2026-08-24 sull'output dei plugin, meno 1 punto di margine. */
const FAMILIES: Array<{ name: string; minMedian: number; render: () => Rendered[] }> = [
  {
    name: 'tasse-frontalieri-comune',
    minMedian: 8, // misurato 9,1 % (era 0,0 %)
    render: () =>
      FISCAL_ABOVE_FLOOR.map((m) =>
        renderFiscal({ municipality: m, locale: 'it', dateStamp: '2026-08-24', distDir: DIST } as never),
      ),
  },
  {
    name: 'comuni-di-frontiera',
    minMedian: 14, // misurato 15,6 % (era 11,5-15,4 %)
    render: () =>
      MUNICIPALITIES.filter((m) => TICINO_VITA_CORRIDOR_PROVINCES.has(m.province))
        .slice(0, 40)
        .map((m) =>
          renderItalian({
            municipality: m,
            locale: 'it',
            dateStamp: '2026-08-24',
            distDir: DIST,
            waitSnapshot: {},
          } as never),
        ),
  },
  {
    name: 'vivere-in-germania',
    minMedian: 10, // misurato 11,1 % (era 5,1 %)
    render: () =>
      GERMAN_ABOVE_FLOOR.map((m) =>
        renderGerman({ municipality: m, locale: 'it', dateStamp: '2026-08-24', distDir: DIST } as never),
      ),
  },
  {
    name: 'vivere-in-liechtenstein',
    minMedian: 5, // misurato 6,1 % (era 0,0 %)
    render: () =>
      LIECHTENSTEIN_ABOVE_FLOOR.map((m) =>
        renderLiechtenstein({ municipality: m, locale: 'it', dateStamp: '2026-08-24', distDir: DIST } as never),
      ),
  },
  {
    name: 'vivere-in-francia',
    minMedian: 4.5, // misurato 5,6 % (era 0,0 %)
    render: () =>
      FRENCH_ABOVE_FLOOR.map((m) =>
        renderFrench({ municipality: m, locale: 'it', dateStamp: '2026-08-24', distDir: DIST } as never),
      ),
  },
  {
    name: 'vivere-in-austria',
    // La sola famiglia sotto il floor del gate, e per questo INVENTARIATA con
    // 4,2 %: il corridoio non ha alcun regime frontalieri, quindi la pagina è
    // dominata da uno spiegatore legale identico per tutti (~29 dei ~32
    // segmenti). Qui si pinna che non scenda ancora.
    minMedian: 3.2, // misurato 4,2 % (era 1,8 %)
    render: () =>
      AUSTRIAN_ABOVE_FLOOR.map((m) =>
        renderAustrian({ municipality: m, locale: 'it', dateStamp: '2026-08-24', distDir: DIST } as never),
      ),
  },
];

const measure = (pages: Rendered[]) => {
  const fingerprints = pages.map((p) =>
    fingerprintPage(`${p.urlPath.replace(/^\//, '').replace(/\/$/, '')}/index.html`, p.html),
  );
  // minCohortPages 2: qui la popolazione è la famiglia intera per costruzione,
  // non un campione, quindi non serve la soglia anti-rumore del gate.
  const { cohorts } = scoreCohorts(fingerprints, { minCohortPages: 2 });
  // La coorte più popolosa È la famiglia: le altre sono le poche pagine con una
  // sezione opzionale che cambia l'h1.
  return cohorts.slice().sort((a, b) => b.pages - a.pages)[0] ?? null;
};

describe('information gain delle sei famiglie comunali, misurato sull’output dei plugin', () => {
  for (const family of FAMILIES) {
    it(`${family.name} sta sopra ${family.minMedian} %`, () => {
      const cohort = measure(family.render());
      expect(cohort, `${family.name}: nessuna coorte prodotta`).not.toBeNull();
      expect(
        cohort!.medianIgs,
        `${family.name}: median ${cohort!.medianIgs.toFixed(1)} % su ${cohort!.pages} pagine.\n` +
          'Il blocco del confronto non sta più aggiungendo prosa page-specific.\n' +
          'Controlla `renderNearestComparison`: pool giusto? keyOf che non collide?\n' +
          'limit > 2? Se il calo è voluto, la misura va rifatta e va aggiornato\n' +
          'anche docs/INFORMATION-GAIN.md, che riporta gli stessi numeri.',
      ).toBeGreaterThanOrEqual(family.minMedian);
    });
  }

  it('nessuna pagina di nessuna famiglia resta senza niente di proprio', () => {
    // È il numero che conta più della percentuale: prima della fix la famiglia
    // fiscale aveva 29 pagine su 30 che non aggiungevano UNA frase.
    const offenders = FAMILIES.map((f) => ({ name: f.name, cohort: measure(f.render()) }))
      .filter((r) => (r.cohort?.zeroGainPages ?? 0) > 0)
      .map((r) => `${r.name}: ${r.cohort!.zeroGainPages}/${r.cohort!.pages}`);
    expect(offenders).toEqual([]);
  });
});

/**
 * La settima famiglia: i valichi (issue #7593).
 *
 * PERCHÉ NON STA NELL'ARRAY QUI SOPRA
 * ---------------------------------------------------------------------------
 * `measure()` prende la coorte PIÙ POPOLOSA perché per le sei famiglie
 * comunali la coorte È la famiglia. Qui no: le 143 leaf italiane si spezzano
 * in una ventina di coorti (lo scheletro cambia con webcam, grafico orario,
 * grafico settimanale, percorsi alternativi), e la coorte peggiore — 15 minori
 * valichi tedeschi, mediana 1,3 % con 5 pagine a gain ZERO — non era la più
 * popolosa a pari merito. Guardare una coorte sola avrebbe misurato quella
 * sbagliata.
 *
 * Quindi qui si asserisce quello che asserisce il gate post-deploy: OGNI
 * coorte abbastanza grande da essere gatata (`MIN_COHORT_PAGES = 12` in
 * `scripts/audit-information-gain.mjs`) sta sopra il floor, e nessuna pagina
 * della famiglia — gatata o no — resta a gain zero.
 */
const BORDER_WAIT_GATED_MIN_PAGES = 12;
/** Misurato 6,2 % sulla coorte peggiore il 2026-09-06, meno 1 punto di margine. */
const BORDER_WAIT_MIN_MEDIAN = 5.2;

const measureBorderWaitCohorts = () => {
  const pages = generateBorderWaitPages({
    current: { perCrossing: {} } as never,
    today: new Date('2026-09-06T08:00:00Z'),
  });
  const leaves = Object.entries(pages).filter(([urlPath]) =>
    /^\/traffico-dogane\/[^/]+\/oggi\/$/.test(urlPath),
  );
  const fingerprints = leaves.map(([urlPath, html]) =>
    fingerprintPage(`${urlPath.replace(/^\//, '').replace(/\/$/, '')}/index.html`, html),
  );
  // minCohortPages 2 per VEDERE anche le coorti piccole: il floor lo si applica
  // solo a quelle gatate, ma il conteggio delle pagine a gain zero le copre
  // tutte — una pagina senza niente di proprio è un difetto anche in una
  // coorte da 3, e il gate la vedrebbe appena il dataset cresce.
  return scoreCohorts(fingerprints, { minCohortPages: 2 }).cohorts;
};

describe('information gain delle pagine-valico, misurato sull’output del plugin', () => {
  it(`ogni coorte gatata sta sopra ${BORDER_WAIT_MIN_MEDIAN} %`, () => {
    const gated = measureBorderWaitCohorts().filter(
      (cohort) => cohort.pages >= BORDER_WAIT_GATED_MIN_PAGES,
    );
    expect(gated.length, 'nessuna coorte gatata: il plugin non ha reso le leaf').toBeGreaterThan(0);
    const offenders = gated
      .filter((cohort) => cohort.medianIgs < BORDER_WAIT_MIN_MEDIAN)
      .map((cohort) => `${cohort.key}: ${cohort.medianIgs.toFixed(1)} % su ${cohort.pages} pagine`);
    expect(
      offenders,
      'Il blocco di confronto fra valichi del corridoio non sta più aggiungendo\n' +
        'prosa page-specific. Controlla `renderNearbyCrossingsComparison` in\n' +
        'borderWaitPagesPlugin.ts: il pool del corridoio è ancora popolato?\n' +
        '`limit` > 2? I nomi dei valichi vicini finiscono ancora nella prosa?\n' +
        'Se il calo è voluto la misura va rifatta e va aggiornato anche\n' +
        'docs/INFORMATION-GAIN.md, che riporta gli stessi numeri.',
    ).toEqual([]);
  });

  it('nessuna pagina-valico resta senza niente di proprio', () => {
    // È il numero che conta più della percentuale: prima della fix 25 delle 143
    // leaf italiane non aggiungevano UNA frase che le sorelle non avessero già.
    const zeroGain = measureBorderWaitCohorts()
      .filter((cohort) => cohort.zeroGainPages > 0)
      .map((cohort) => `${cohort.key}: ${cohort.zeroGainPages}/${cohort.pages}`);
    expect(zeroGain).toEqual([]);
  });
});
