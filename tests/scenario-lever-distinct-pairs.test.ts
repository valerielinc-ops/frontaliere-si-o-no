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
  SALARY_LEVELS,
  scenarioToInputs,
  type SalaryHubScenario,
} from '@/build-plugins/salaryHubScenarios';
import { calculateSimulation } from '@/services/calculationService';
import { SCAN_TEST_TIMEOUT_MS } from './helpers/distHtmlScan';
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
  { ranking: string; listSeparator: RegExp; separatorTokens: readonly string[]; pairs: readonly string[] }
> = {
  it: {
    ranking: 'in ordine di peso: ',
    listSeparator: /, | e /,
    separatorTokens: [', ', ' e '],
    pairs: ['In cifre proprie', 'Il confronto che si muove', 'Le due leve che qui si equivalgono'],
  },
  en: {
    ranking: 'by weight: ',
    listSeparator: /, | and /,
    separatorTokens: [', ', ' and '],
    pairs: [
      'In figures specific to',
      'The comparison that moves fastest',
      'The two levers that come closest',
    ],
  },
  de: {
    ranking: 'nach Gewicht geordnet: ',
    listSeparator: /, | und /,
    separatorTokens: [', ', ' und '],
    pairs: [
      'In den Zahlen dieses Bruttolohns',
      'Entlang der Bruttolohnleiter',
      'Die beiden Hebel, die sich hier am nächsten kommen',
    ],
  },
  fr: {
    ranking: 'par ordre de poids : ',
    listSeparator: /, | et /,
    separatorTokens: [', ', ' et '],
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
  const alternatives = [...labels].map((label) => label.trim()).sort((a, b) => b.length - a.length).map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  if (!alternatives) return [];
  const exactLabel = new RegExp(`(?<![\\p{L}\\p{N}])(${alternatives})(?![\\p{L}\\p{N}])`, 'gu');
  return [...sentence.matchAll(exactLabel)].map((match) => match[1]);
}

type LeverKey = 'salaryUp' | 'salaryDown' | 'childMore' | 'childLess' | 'marital' | 'regime' | 'zone';
type MeasuredLever = { key: LeverKey; label: string; delta: number };
const IT_LABELS: Record<LeverKey, string> = { salaryUp: 'il gradino di RAL successivo', salaryDown: 'il gradino di RAL precedente', childMore: 'un figlio a carico in più', childLess: 'un figlio a carico in meno', marital: '', regime: '', zone: '' };
const measuredNetCache = new Map<string, number>();
function measuredNet(scenario: SalaryHubScenario): number {
  const key = `${scenario.salary}|${scenario.frontierType}|${scenario.maritalStatus}|${scenario.children}|${scenario.distanceZone}`;
  const cached = measuredNetCache.get(key); if (cached !== undefined) return cached;
  const net = calculateSimulation(scenarioToInputs(scenario)).itResident.netIncomeAnnual; measuredNetCache.set(key, net); return net;
}
function salaryStep(salary: number, direction: 1 | -1): number | null {
  const index = SALARY_LEVELS.indexOf(salary as (typeof SALARY_LEVELS)[number]); return index < 0 ? null : SALARY_LEVELS[index + direction] ?? null;
}
function measuredLevers(scenario: SalaryHubScenario): MeasuredLever[] {
  const base = measuredNet(scenario); const out: MeasuredLever[] = [];
  const add = (key: LeverKey, label: string, variant: SalaryHubScenario) => out.push({ key, label, delta: measuredNet(variant) - base });
  const up = salaryStep(scenario.salary, 1); if (up !== null) add('salaryUp', IT_LABELS.salaryUp, { ...scenario, salary: up });
  const down = salaryStep(scenario.salary, -1); if (down !== null) add('salaryDown', IT_LABELS.salaryDown, { ...scenario, salary: down });
  if (scenario.children < 3) add('childMore', IT_LABELS.childMore, { ...scenario, children: scenario.children + 1 });
  if (scenario.children > 0) add('childLess', IT_LABELS.childLess, { ...scenario, children: scenario.children - 1 });
  add('marital', scenario.maritalStatus === 'MARRIED' ? 'il ritorno alla posizione di single' : 'il matrimonio con coniuge non lavoratore', { ...scenario, maritalStatus: scenario.maritalStatus === 'MARRIED' ? 'SINGLE' : 'MARRIED' });
  if (scenario.distanceZone === 'WITHIN_20KM') add('regime', scenario.frontierType === 'OLD' ? 'il passaggio al regime di nuovo frontaliere' : 'il passaggio al regime di vecchio frontaliere', { ...scenario, frontierType: scenario.frontierType === 'OLD' ? 'NEW' : 'OLD' });
  if (scenario.frontierType === 'NEW') add('zone', scenario.distanceZone === 'OVER_20KM' ? 'lo spostamento della residenza entro i 20 km dal confine' : 'lo spostamento della residenza oltre i 20 km dal confine', { ...scenario, distanceZone: scenario.distanceZone === 'OVER_20KM' ? 'WITHIN_20KM' : 'OVER_20KM' });
  return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || (a.key < b.key ? -1 : 1));
}
function ratioVariation(scenario: SalaryHubScenario, otherKey: LeverKey): number | null {
  const ratios: number[] = [];
  for (const salary of SALARY_LEVELS) {
    const levers = measuredLevers({ ...scenario, salary });
    const step = levers.filter((lever) => lever.key === 'salaryUp' || lever.key === 'salaryDown').sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
    const other = levers.find((lever) => lever.key === otherKey);
    if (!step || !other || Math.abs(step.delta) === 0 || Math.abs(other.delta) === 0) continue;
    ratios.push(Math.abs(step.delta) / Math.abs(other.delta));
  }
  return ratios.length > 1 ? Math.max(...ratios) - Math.min(...ratios) : null;
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
        for (const label of labels) {
          expect(
            spec.separatorTokens.some((token) => label.includes(token)),
            `${idOf(scenario)}: l'etichetta «${label}» contiene un separatore della lista`,
          ).toBe(false);
        }

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

  it('il superlativo di stepVsOther resta vero lungo tutta la scala salariale', { timeout: SCAN_TEST_TIMEOUT_MS }, () => {
    const offenders: string[] = [];
    let measured = 0;
    for (const scenario of scenarios) {
      const sentences = sentencesFor(scenario, 'it');
      const stepSentence = sentences.find((sentence) => sentence.startsWith('Il confronto che si muove'));
      if (!stepSentence) continue;
      const ranking = sentences.find((sentence) => sentence.includes(LOCALES.it.ranking));
      expect(ranking).toBeDefined();
      const labels = ranking!.slice(ranking!.indexOf(LOCALES.it.ranking) + LOCALES.it.ranking.length).replace(/\.$/, '').split(LOCALES.it.listSeparator).map((label) => label.trim());
      const named = labelsIn(stepSentence, labels);
      const other = measuredLevers(scenario).find((lever) => lever.key !== 'salaryUp' && lever.key !== 'salaryDown' && named.includes(lever.label));
      if (!other) continue;
      const selected = ratioVariation(scenario, other.key);
      const candidates = measuredLevers(scenario).filter((lever) => lever.key !== 'salaryUp' && lever.key !== 'salaryDown').map((lever) => ratioVariation(scenario, lever.key)).filter((value): value is number => value !== null);
      if (selected === null || candidates.length === 0) continue;
      measured += 1;
      const fastest = Math.max(...candidates);
      if (selected + 1e-9 < fastest) offenders.push(`${idOf(scenario)}: ${other.key} variation ${selected} < ${fastest}`);
    }
    expect(measured).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
