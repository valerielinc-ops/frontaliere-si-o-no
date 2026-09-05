/**
 * Le 22 coorti dei calcolatori di stipendio netto stanno sopra il floor di
 * information gain, misurate sull'HTML che `salaryHubContent` emette ADESSO
 * (issue #7385, prima fetta di #7340).
 *
 * PERCHÉ NON BASTA IL GATE SU dist/
 * ---------------------------------------------------------------------------
 * Stesso argomento di `information-gain-families-floor.test.ts` per le sei
 * famiglie comunali: `audit-information-gain.mjs` gira in
 * `post-deploy-validate-dist.yml` e vede il numero solo DOPO il merge e dopo il
 * deploy. Qui il rischio è concreto e ha un nome: il blocco che rende queste
 * pagine distinguibili (`shared/scenarioLeverComparison.ts`) è fatto di frasi
 * la cui unica variazione sono PAROLE scelte da fasce qualitative. Sostituire
 * una fascia con una cifra, ridurre l'elenco delle leve a una sola, o unire le
 * frasi in un unico `<p>` passerebbe typecheck e review, e riporterebbe la
 * famiglia a 0 % senza che nulla diventi rosso fino al giorno dopo.
 *
 * TUTTI E QUATTRO I LOCALI
 * ---------------------------------------------------------------------------
 * La famiglia è `/calcola-stipendio/`, `/en/calculate-salary/`,
 * `/de/gehalt-berechnen/`, `/fr/calculer-salaire/`: 22 delle coorti dei 37
 * offender del 2026-09-01 stanno lì. Le coorti sono per locale (il motore
 * raggruppa su `locale|skeletonHash`), quindi un locale che perdesse il blocco
 * — un `COPY` incompleto, un `LeverLocale` non mappato — resterebbe invisibile
 * a un test che misura solo l'italiano.
 *
 * LA SOGLIA È IL VALORE MISURATO, NON UN NUMERO SCELTO
 * ---------------------------------------------------------------------------
 * Misurato il 2026-09-05 sull'output del plugin: la coorte peggiore delle 48
 * (12 per locale) sta a 6,5 %, la migliore sopra il 19 %. La soglia è 5,5 %:
 * un punto sotto il misurato, e comunque sopra il floor 5 % del gate. Il
 * margine c'è perché la mediana si muove quando cambia il motore di calcolo
 * (una soglia IRPEF diversa riordina le leve), non per lasciare spazio a una
 * regressione.
 */
import { describe, it, expect } from 'vitest';
import { fingerprintPage, scoreCohorts } from '@/scripts/lib/informationGain.mjs';
import {
  generateAllScenarios,
  scenarioToInputs,
  buildFullPath,
} from '@/build-plugins/salaryHubScenarios';
import { generatePageHtml } from '@/build-plugins/salaryHubContent';
import { calculateSimulation } from '@/services/calculationService';

const DIST = '/tmp/information-gain-salary-hub';
const LOCALES = ['it', 'en', 'de', 'fr'] as const;

/** Misurato il 2026-09-05 (peggiore 6,5 %), meno un punto di margine. */
const MIN_MEDIAN_IGS = 5.5;

const scenarios = generateAllScenarios();
const results = new Map(scenarios.map((s) => [s, calculateSimulation(scenarioToInputs(s))]));

function cohortsFor(locale: (typeof LOCALES)[number]) {
  const fingerprints = scenarios.map((s) => {
    const urlPath = buildFullPath(s, locale);
    const html = generatePageHtml(s, results.get(s)!, locale, scenarios, DIST);
    return fingerprintPage(`${urlPath.replace(/^\//, '').replace(/\/$/, '')}/index.html`, html);
  });
  // minCohortPages 2: la popolazione qui è la famiglia intera per costruzione,
  // non un campione, quindi non serve la soglia anti-rumore del gate.
  return scoreCohorts(fingerprints, { minCohortPages: 2 }).cohorts;
}

describe('information gain dei calcolatori di stipendio, misurato sull’output del plugin', () => {
  for (const locale of LOCALES) {
    it(`${locale}: ogni coorte sta sopra ${MIN_MEDIAN_IGS} %`, () => {
      const cohorts = cohortsFor(locale);
      expect(cohorts.length, `${locale}: nessuna coorte prodotta`).toBeGreaterThan(0);
      const below = cohorts
        .filter((c) => c.medianIgs < MIN_MEDIAN_IGS)
        .map((c) => `${c.label} → ${c.medianIgs.toFixed(1)} % su ${c.pages} pagine`);
      expect(
        below,
        'Il blocco delle leve non sta più aggiungendo prosa page-specific.\n' +
          'Controlla `renderScenarioLeverComparison`: le frasi escono ancora una per <li>?\n' +
          'Le fasce qualitative sono state sostituite da cifre (che la metrica maschera)?\n' +
          'Se il calo è voluto, la misura va rifatta e va aggiornato anche\n' +
          'docs/INFORMATION-GAIN.md, che riporta gli stessi numeri.',
      ).toEqual([]);
    });
  }

  it('nessuna pagina della famiglia resta senza niente di proprio', () => {
    // È il numero che conta più della percentuale: prima della fix una coorte
    // da 54 pagine ne aveva 36 che non aggiungevano UNA frase.
    const offenders = LOCALES.flatMap((locale) =>
      cohortsFor(locale)
        .filter((c) => c.zeroGainPages > 0)
        .map((c) => `${c.label}: ${c.zeroGainPages}/${c.pages}`),
    );
    expect(offenders).toEqual([]);
  });

  it('l’intestazione del blocco è la stessa su tutte le pagine di un locale', () => {
    // Un h2 che variasse per pagina spezzerebbe la famiglia in coorti da una
    // pagina, che il motore non punteggia: IGS "risolto" facendo sparire la
    // misura, cioè AGENTS.md #1 al contrario. Le coorti devono restare poche.
    for (const locale of LOCALES) {
      expect(cohortsFor(locale).length, `${locale}: coorti frammentate`).toBeLessThanOrEqual(20);
    }
  });
});
