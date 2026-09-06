/**
 * Nessuna pagina calcolatore nomina DUE VOLTE la stessa coppia ordinata di
 * leve (issue #7729).
 *
 * IL DIFETTO CHE QUESTO TEST FISSA
 * ---------------------------------------------------------------------------
 * Tre delle undici frasi del blocco nominano due leve in un ordine che
 * significa qualcosa: `ratio` (la più pesante contro la seconda),
 * `stepVsOther` (il gradino di RAL contro una leva non salariale) e
 * `closestPair` (le due adiacenti che si equivalgono di più). Ognuna sceglieva
 * la propria coppia per conto suo, quindi la stessa coppia nello stesso ordine
 * usciva due volte nello stesso `<ul>`: misurato sul dominio pubblicato,
 * `ratio` e `stepVsOther` coincidevano su 188 delle 432 combinazioni, `ratio` e
 * `closestPair` su 41, `stepVsOther` e `closestPair` su 10. Due `<li>`
 * adiacenti che dicono lo stesso fatto con parole diverse: il blocco esiste per
 * produrre information gain e proprio lì ne produceva zero.
 *
 * PERCHÉ SULLA PROSA E SU TUTTI E QUATTRO I LOCALI
 * ---------------------------------------------------------------------------
 * La ripetizione è un difetto di ciò che il lettore legge, non di una funzione
 * interna: si misura sulle frasi. E si misura su ogni locale perché la
 * selezione delle coppie è condivisa ma la resa no — un locale che
 * riallineasse le sue frasi mentre gli altri restano distinti pubblicherebbe la
 * ripetizione solo lì, dove nessun test italiano guarda.
 */
import { describe, it, expect } from 'vitest';
import {
  generateAllScenarios,
  scenarioToInputs,
  type SalaryHubScenario,
} from '@/build-plugins/salaryHubScenarios';
import { calculateSimulation } from '@/services/calculationService';
import {
  scenarioLeverSentences,
  type LeverLocale,
} from '@/build-plugins/shared/scenarioLeverComparison';

/**
 * Per ogni locale: da dove comincia la frase dell'elenco ordinato (che nomina
 * TUTTE le leve, ed è quindi il dizionario delle etichette di quella pagina),
 * da dove cominciano le tre frasi che nominano una coppia, e il separatore
 * finale dell'elenco.
 */
const LOCALES: Record<
  LeverLocale,
  { ranking: string; listSeparator: RegExp; pairs: readonly string[] }
> = {
  it: {
    ranking: 'in ordine di peso: ',
    listSeparator: /, | e /,
    pairs: ['In cifre proprie', 'Il confronto che si muove', 'Le due leve che qui si equivalgono'],
  },
  en: {
    ranking: 'by weight: ',
    listSeparator: /, | and /,
    pairs: [
      'In figures specific to',
      'The comparison that moves fastest',
      'The two levers that come closest',
    ],
  },
  de: {
    ranking: 'nach Gewicht geordnet: ',
    listSeparator: /, | und /,
    pairs: [
      'In den Zahlen dieses Bruttolohns',
      'Entlang der Bruttolohnleiter',
      'Die beiden Hebel, die sich hier am nächsten kommen',
    ],
  },
  fr: {
    ranking: 'par ordre de poids : ',
    listSeparator: /, | et /,
    pairs: [
      'En chiffres propres',
      'La comparaison qui bouge',
      'Les deux leviers qui se valent',
    ],
  },
};

const scenarios = generateAllScenarios();

function sentencesFor(scenario: SalaryHubScenario, locale: LeverLocale): string[] {
  const result = calculateSimulation(scenarioToInputs(scenario));
  return scenarioLeverSentences({
    scenario,
    allScenarios: scenarios,
    chResidentNetAnnual: result.chResident.netIncomeAnnual,
    itResidentNetAnnual: result.itResident.netIncomeAnnual,
    locale,
  });
}

const idOf = (scenario: SalaryHubScenario): string =>
  `${scenario.salary}/${scenario.children}f/${scenario.maritalStatus}/${scenario.frontierType}/${scenario.distanceZone}`;

/** Le etichette nominate da una frase, nell'ordine in cui compaiono. */
function labelsIn(sentence: string, labels: readonly string[]): string[] {
  return labels
    .map((label) => ({ label, at: sentence.indexOf(label) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.label);
}

describe('nessuna pagina nomina due volte la stessa coppia ordinata di leve', () => {
  for (const locale of Object.keys(LOCALES) as LeverLocale[]) {
    const spec = LOCALES[locale];

    it(`${locale}: le coppie nominate sono tutte distinte sulle 432 combinazioni`, () => {
      const offenders: string[] = [];
      let pairsSeen = 0;

      for (const scenario of scenarios) {
        const sentences = sentencesFor(scenario, locale);
        const ranking = sentences.find((s) => s.includes(spec.ranking));
        expect(ranking, `${idOf(scenario)}: manca la frase dell'elenco ordinato`).toBeDefined();

        const labels = ranking!
          .slice(ranking!.indexOf(spec.ranking) + spec.ranking.length)
          .replace(/\.$/, '')
          .split(spec.listSeparator);

        const seen = new Set<string>();
        for (const prefix of spec.pairs) {
          const sentence = sentences.find((s) => s.startsWith(prefix));
          if (sentence === undefined) continue; // frase legittimamente taciuta

          const named = labelsIn(sentence, labels);
          // Se l'estrattore smette di riconoscere due etichette, il test
          // passerebbe senza aver confrontato niente: qui diventa rosso.
          expect(
            named.length,
            `${idOf(scenario)}: «${prefix}…» nomina ${named.length} etichette invece di 2`,
          ).toBe(2);

          const id = `${named[0]} → ${named[1]}`;
          pairsSeen += 1;
          if (seen.has(id)) {
            offenders.push(`${idOf(scenario)}: «${id}» nominata due volte`);
          }
          seen.add(id);
        }
      }

      // Il test misura davvero il dominio pubblicato: tre frasi di coppia ×
      // 432 combinazioni, meno quelle legittimamente taciute.
      expect(pairsSeen).toBeGreaterThan(scenarios.length);
      expect(
        offenders,
        'Due frasi dello stesso blocco sono tornate a nominare la stessa coppia\n' +
          'ordinata: `NamedPairs` in `scenarioLeverSentences` deve far scegliere a\n' +
          'chi emette per secondo un’altra coppia (se resta vera) o tacere.',
      ).toEqual([]);
    });
  }

  it('la deduplicazione morde davvero: qualche pagina tace `closestPair`', () => {
    // Senza questa asserzione il test sopra potrebbe passare perché le coppie
    // non collidono mai da sole — cioè senza provare nulla del fix. Misurato
    // il 2026-09-06: la coppia più vicina è già nominata sopra su 47 delle 432
    // combinazioni, e lì la pagina perde la frase invece di ripeterla.
    const suppressed = scenarios.filter(
      (scenario) =>
        !sentencesFor(scenario, 'it').some((s) =>
          s.startsWith('Le due leve che qui si equivalgono'),
        ),
    );
    expect(suppressed.length).toBeGreaterThan(0);
  });
});
