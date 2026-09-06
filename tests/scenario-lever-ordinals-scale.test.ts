/**
 * La frase `rank`/`ladderRank` non sparisce quando la scala supera la lista
 * degli ordinali scritti a parole (issue #7730).
 *
 * IL DIFETTO CHE QUESTO TEST FISSA
 * ---------------------------------------------------------------------------
 * `copy.ordinals` era una lista letterale di 24 voci per locale, e i due call
 * site la indicizzavano con una posizione DERIVATA dai dati — la combinazione
 * fra quelle alla stessa RAL (24 oggi), il gradino fra quelli di
 * `SALARY_LEVELS` (18 oggi) — dietro una guardia `position < ordinals.length`.
 * Margine ZERO sul primo dei due: bastava un valore in più su una qualunque
 * dimensione dello scenario perché le pagine eccedenti perdessero la frase
 * **in silenzio**, senza un errore e senza un test rosso, cioè esattamente
 * l'information gain che il blocco esiste per produrre.
 *
 * COSA ASSERISCE, E PERCHÉ SU DUE PIANI
 * ---------------------------------------------------------------------------
 * 1. **Copertura a parole della scala di OGGI**: dentro la scala reale
 *    l'ordinale è ancora una parola, mai una cifra. È questa metà che diventa
 *    rossa se domani la scala cresce — il segnale che chiede di riallungare le
 *    liste, che prima non esisteva.
 * 2. **Nessun silenzio oltre la scala**: con una popolazione più lunga della
 *    lista, OGNI pagina riceve la sua frase e nessuna posizione ne condivide
 *    l'ordinale con un'altra. È la garanzia che il difetto non torna sotto
 *    forma di frase mancante mentre qualcuno discute quali parole aggiungere.
 *
 * Su tutti e quattro i locali perché il ripiego è per-locale (la forma
 * grammaticale che ciascuna frase pretende è diversa) e un locale che lo
 * sbagliasse lo pubblicherebbe solo lì.
 */
import { describe, it, expect } from 'vitest';
import {
  generateAllScenarios,
  scenarioToInputs,
  SALARY_LEVELS,
  type SalaryHubScenario,
} from '@/build-plugins/salaryHubScenarios';
import { calculateSimulation } from '@/services/calculationService';
import {
  leverOrdinal,
  scenarioLeverSentences,
  type LeverLocale,
} from '@/build-plugins/shared/scenarioLeverComparison';

/** L'incipit della frase `rank` in ciascun locale. */
const RANK_MARKER: Record<LeverLocale, string> = {
  it: 'combinazioni calcolate alla stessa RAL',
  en: 'combinations computed at the same gross salary',
  de: 'bei gleichem Bruttolohn berechneten Kombinationen',
  fr: 'combinaisons calculées au même brut',
};

const LOCALES = Object.keys(RANK_MARKER) as LeverLocale[];

const ALL = generateAllScenarios();

/** La popolazione più lunga che oggi indicizza `ordinals`. */
const SCALE = (() => {
  const perSalary = new Map<number, number>();
  for (const s of ALL) perSalary.set(s.salary, (perSalary.get(s.salary) ?? 0) + 1);
  return Math.max(SALARY_LEVELS.length, ...perSalary.values());
})();

function sentencesFor(scenario: SalaryHubScenario, all: SalaryHubScenario[], locale: LeverLocale) {
  const r = calculateSimulation(scenarioToInputs(scenario));
  return scenarioLeverSentences({
    scenario,
    allScenarios: all,
    chResidentNetAnnual: r.chResident.netIncomeAnnual,
    itResidentNetAnnual: r.itResident.netIncomeAnnual,
    locale,
  });
}

describe('scenarioLeverComparison — ordinali contro la scala', () => {
  it('copre a parole tutta la scala pubblicata di oggi, in ogni locale', () => {
    for (const locale of LOCALES) {
      for (let position = 0; position < SCALE; position += 1) {
        const ordinal = leverOrdinal(locale, position);
        // Una cifra qui significa che la scala ha superato la lista letterale:
        // il ripiego tiene in piedi la frase, ma le parole vanno riallungate.
        expect(
          /\d/.test(ordinal),
          `[${locale}] posizione ${position + 1}/${SCALE} è resa in cifre ("${ordinal}"): la scala ha superato la lista di ordinali a parole, allungala`,
        ).toBe(false);
      }
    }
  });

  it('oltre la lista dà comunque un ordinale, distinto per posizione', () => {
    for (const locale of LOCALES) {
      const seen = new Set<string>();
      for (let position = 0; position < SCALE + 30; position += 1) {
        const ordinal = leverOrdinal(locale, position);
        expect(ordinal.trim().length, `[${locale}] posizione ${position + 1} senza ordinale`).toBeGreaterThan(0);
        expect(seen.has(ordinal), `[${locale}] ordinale ripetuto: "${ordinal}"`).toBe(false);
        seen.add(ordinal);
      }
    }
  });

  it('con una popolazione più lunga della lista, nessuna pagina perde la frase', () => {
    // La scala delle combinazioni alla stessa RAL arriva dall'input, quindi la
    // si può far crescere come farebbe un valore in più su una dimensione:
    // qui, figli oltre i quattro generati oggi.
    const salary = 60_000;
    const grown: SalaryHubScenario[] = [
      ...ALL,
      ...Array.from({ length: 27 }, (_, i) => ({
        salary,
        frontierType: 'NEW' as const,
        maritalStatus: 'SINGLE' as const,
        children: 4 + i,
        distanceZone: 'WITHIN_20KM' as const,
      })),
    ];
    const sameSalary = grown.filter((s) => s.salary === salary);
    expect(sameSalary.length).toBeGreaterThan(SCALE);

    for (const locale of LOCALES) {
      const ordinals = new Set<string>();
      for (const scenario of sameSalary) {
        const rank = sentencesFor(scenario, grown, locale).find((s) =>
          s.includes(RANK_MARKER[locale]),
        );
        expect(rank, `[${locale}] frase rank mancante su ${JSON.stringify(scenario)}`).toBeDefined();
        ordinals.add(rank as string);
      }
      expect(ordinals.size, `[${locale}] due pagine con lo stesso ordinale`).toBe(sameSalary.length);
    }
  });
});
