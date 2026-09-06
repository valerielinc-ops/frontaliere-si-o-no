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
import { renderProfessionCantonPage } from '@/build-plugins/professionCantonLandings';
import { buildProfessionCantonPath, PROFESSION_CANTON_KEYS } from '@/build-plugins/professionCantonData';
import { ALL_CANTON_PROFESSION_IDS, type AnyProfessionId } from '@/build-plugins/professionLandingsData';
import type { ProfessionJobsSnapshot } from '@/build-plugins/professionJobsAggregate';

const DIST = '/tmp/information-gain-families';

type Rendered = { urlPath: string; html: string };


/**
 * IL CORPUS SINTETICO DELLA FAMIGLIA professione × cantone (#7596)
 * ---------------------------------------------------------------------------
 * Le sei famiglie comunali sopra rendono da dati checked-in. Questa no: i suoi
 * snapshot escono da `aggregateProfessionJobsByCanton`, che legge
 * `data/jobs.json` — un blob da 31 MB che la CI assembla e che qui non c'è.
 *
 * QUESTO NUMERO NON È IL NUMERO LIVE, e non prova a esserlo. Il corpus qui
 * sotto tiene gli stessi tre datori di lavoro su OGNI pagina e fa variare fra
 * le celle le sole CIFRE, cioè proprio ciò che la maschera n. 1 dell'auditor
 * riduce a `#`; misura 9,7 % col blocco di confronto e 6,2 % senza, mentre il
 * corpus live misura 6,7 % col blocco e 2,9 % senza (110 URL campionate dal
 * sitemap il 2026-09-06, issue #7596 — comando nella scheda della issue).
 * I due assoluti non sono confrontabili perché i corpus non lo sono; il DELTA
 * sì, ed è quello che questo test difende.
 *
 * Da qui la soglia: 8,7 % è il misurato meno un punto, e sta SOPRA il 6,2 %
 * che la famiglia darebbe senza il blocco. È questo che rende il test un
 * osservatore e non una decorazione — svuota `renderPeerComparison` e il test
 * diventa rosso, che è l'unica cosa che il gate post-deploy non può fare in
 * tempo utile.
 */
const SYNTHETIC_CANTONS = PROFESSION_CANTON_KEYS.slice(0, 8);

/** Conteggio deterministico e ben distribuito per (cantone, professione). */
const syntheticLiveCount = (cantonKey: string, id: AnyProfessionId): number => {
  let h = 7;
  for (const ch of `${cantonKey}:${id}`) h = (h * 31 + ch.charCodeAt(0)) % 100003;
  // 0-3 finisce sotto MIN_JOBS: anche nel sintetico alcune coppie non hanno
  // pagina, così le coorti per cantone hanno dimensioni diverse come dal vivo.
  return h % 60;
};

const syntheticSnapshot = (cantonKey: string, id: AnyProfessionId): ProfessionJobsSnapshot => {
  const liveCount = syntheticLiveCount(cantonKey, id);
  return {
    liveCount,
    fresh30Count: liveCount % 7,
    medianSalaryChf: 60000 + (liveCount % 13) * 1000,
    featured: [],
    // Identici ovunque: vedi il commento sopra, il gain non deve poter venire
    // da qui.
    topEmployers: [
      { name: 'Alpha AG', count: 3 },
      { name: 'Beta SA', count: 2 },
      { name: 'Gamma GmbH', count: 1 },
    ],
  };
};

const renderProfessionCantonFamily = (): Rendered[] => {
  const pages: Rendered[] = [];
  for (const cantonKey of SYNTHETIC_CANTONS) {
    const cantonProfessions: Partial<Record<AnyProfessionId, ProfessionJobsSnapshot>> = {};
    for (const id of ALL_CANTON_PROFESSION_IDS) cantonProfessions[id] = syntheticSnapshot(cantonKey, id);
    for (const id of ALL_CANTON_PROFESSION_IDS) {
      const snapshot = cantonProfessions[id]!;
      if (snapshot.liveCount < 3) continue; // MIN_JOBS: sotto floor esce un bridge, non questa pagina
      pages.push({
        urlPath: buildProfessionCantonPath('it', cantonKey, id),
        html: renderProfessionCantonPage({
          locale: 'it',
          cantonKey,
          id,
          snapshot,
          cantonProfessions,
          distDir: DIST,
        }).html,
      });
    }
  }
  return pages;
};

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
    name: 'lavoro-cantone-professione',
    // Misurato 9,7 % sul corpus sintetico qui sopra, meno 1 punto di margine —
    // e sopra il 6,2 % che la stessa famiglia dà senza il blocco.
    minMedian: 8.7,
    render: renderProfessionCantonFamily,
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

describe('information gain delle famiglie a payload numerico, misurato sull’output dei plugin', () => {
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
