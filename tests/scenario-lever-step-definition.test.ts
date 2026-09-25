/**
 * Le due frasi che parlano del «gradino di RAL» usano LO STESSO gradino
 * (issue #7727).
 *
 * IL DIFETTO CHE QUESTO TEST FISSA
 * ---------------------------------------------------------------------------
 * In `scenarioLeverSentences` convivevano due definizioni di gradino: la frase
 * `stepVsOther` prendeva il primo fra `salaryUp` e `salaryDown` che esistesse,
 * mentre `heavierThanStep` decideva chi batte il gradino sul MASSIMO delle due
 * magnitudini. Su 228 delle 432 combinazioni pubblicate `|salaryDown|` supera
 * `|salaryUp|`, quindi la prima frase stampava il rapporto contro il gradino
 * più piccolo e quella adiacente ragionava sul più grande: due numeri per la
 * stessa parola. Oggi la contraddizione *manifesta* fra le due frasi non si
 * vede su nessuna pagina, ma si apre da sola appena la scala di RAL cambia
 * passo — ed è esattamente ciò che qui diventa rosso.
 *
 * PERCHÉ SULLA PROSA E NON SU UNA FUNZIONE INTERNA
 * ---------------------------------------------------------------------------
 * Il gradino di riferimento è un dettaglio interno; ciò che il lettore vede
 * sono le due frasi. Il test le legge come le legge lui: quale gradino nomina
 * `stepVsOther`, e se `heavierThanStep` è d'accordo su chi lo batte.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  generateAllScenarios,
  scenarioToInputs,
  SALARY_LEVELS,
} from '@/build-plugins/salaryHubScenarios';
import { scenarioLeverSentences } from '@/build-plugins/shared/scenarioLeverComparison';
import { calculateSimulation } from '@/services/calculationService';

const STEP_UP = 'il gradino di RAL successivo';
const STEP_DOWN = 'il gradino di RAL precedente';
/** `stepVsOther` in italiano: "... fra queste due leve: A e B. A questo livello ...". */
const STEP_VS_OTHER = /^Il confronto che si muove più in fretta.*due leve: (.+?) e (.+?)\. A questo livello/;

const scenarios = generateAllScenarios();
const netIt = (s: (typeof scenarios)[number]): number =>
  calculateSimulation(scenarioToInputs(s)).itResident.netIncomeAnnual;

/** Le combinazioni in cui il gradino in giù pesa più di quello in su. */
const asymmetric = scenarios.filter((s) => {
  const i = SALARY_LEVELS.indexOf(s.salary as (typeof SALARY_LEVELS)[number]);
  const up = SALARY_LEVELS[i + 1];
  const down = SALARY_LEVELS[i - 1];
  if (up === undefined || down === undefined) return false;
  const base = netIt(s);
  return Math.abs(netIt({ ...s, salary: down }) - base) > Math.abs(netIt({ ...s, salary: up }) - base);
});

function sentencesFor(scenario: (typeof scenarios)[number]): string[] {
  const result = calculateSimulation(scenarioToInputs(scenario));
  return scenarioLeverSentences({
    scenario,
    allScenarios: scenarios,
    chResidentNetAnnual: result.chResident.netIncomeAnnual,
    itResidentNetAnnual: result.itResident.netIncomeAnnual,
    locale: 'it',
  });
}

describe('le frasi sul gradino di RAL usano una sola definizione di gradino', () => {
  it('la popolazione con gradino asimmetrico non è vuota', () => {
    // Misurato il 2026-09-06 su main: 228 delle 432 combinazioni. Il test non
    // fissa il numero (cambia col motore di calcolo), solo che il caso esista:
    // senza di esso le asserzioni sotto non proverebbero niente.
    expect(asymmetric.length).toBeGreaterThan(0);
  });

  it('`stepVsOther` nomina il gradino di magnitudine maggiore, lo stesso di `heavierThanStep`', () => {
    const offenders: string[] = [];
    for (const scenario of asymmetric) {
      const sentences = sentencesFor(scenario);
      const match = sentences.map((s) => STEP_VS_OTHER.exec(s)).find((m) => m !== null);
      if (!match) continue; // nessuna leva non salariale con cui confrontarsi
      const [, first, second] = match;
      const named = [first, second].filter((x) => x === STEP_UP || x === STEP_DOWN);
      const label = `${scenario.salary}/${scenario.children}f/${scenario.maritalStatus}/${scenario.frontierType}/${scenario.distanceZone}`;
      if (named.length !== 1) {
        offenders.push(`${label}: la frase non nomina esattamente un gradino (${named.join(', ')})`);
        continue;
      }
      if (named[0] !== STEP_DOWN) {
        offenders.push(`${label}: nomina «${named[0]}», ma il gradino più pesante qui è «${STEP_DOWN}»`);
      }
    }
    expect(
      offenders,
      'La frase sul gradino e quella su chi lo batte sono tornate a usare due\n' +
        'gradini diversi: il gradino di riferimento è UNO — quello di magnitudine\n' +
        'maggiore fra salaryUp e salaryDown (`referenceStepLever`).',
    ).toEqual([]);
  });

  it('chi è nominato per primo in `stepVsOther` è coerente con `heavierThanStep`', () => {
    const offenders: string[] = [];
    for (const scenario of scenarios) {
      const sentences = sentencesFor(scenario);
      const match = sentences.map((s) => STEP_VS_OTHER.exec(s)).find((m) => m !== null);
      if (!match) continue;
      const [, first, second] = match;
      const stepFirst = first === STEP_UP || first === STEP_DOWN;
      const other = stepFirst ? second : first;
      const heavier = sentences.find((s) => s.startsWith('A questa RAL'));
      const label = `${scenario.salary}/${scenario.children}f/${scenario.maritalStatus}/${scenario.frontierType}/${scenario.distanceZone}`;
      if (heavier === undefined) {
        offenders.push(`${label}: manca la frase su chi batte il gradino`);
        continue;
      }
      // Le due frasi devono concordare su `other`: se il gradino lo batte non
      // può comparire fra le leve che battono il gradino, e viceversa.
      // Fino a #7729 qui si pretendeva l'elenco VUOTO, perché `other` era per
      // costruzione la leva non salariale più pesante. Ora `stepVsOther`
      // scarta i candidati la cui coppia col gradino è già stata nominata da
      // `ratio`, quindi `other` può essere una leva più leggera mentre
      // un'altra batte comunque il gradino: l'elenco non vuoto non è più una
      // contraddizione, la presenza di `other` dentro l'elenco sì.
      if (stepFirst && heavier.includes(other)) {
        offenders.push(`${label}: il gradino pesa più di «${other}», ma la frase adiacente lo dà fra chi lo batte`);
      }
      if (!stepFirst && !heavier.includes(other)) {
        offenders.push(`${label}: «${other}» pesa più del gradino, ma non è fra quelle che lo battono`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('avvisa quando la famiglia salariale passata al confronto è incompleta', () => {
    const scenario = scenarios.find((candidate) => candidate.salary === SALARY_LEVELS[1])!;
    const missingSalary = SALARY_LEVELS[0];
    const partialFamily = scenarios.filter((candidate) => (
      !(
        candidate.frontierType === scenario.frontierType &&
        candidate.maritalStatus === scenario.maritalStatus &&
        candidate.children === scenario.children &&
        candidate.distanceZone === scenario.distanceZone &&
        candidate.salary === missingSalary
      )
    ));
    const result = calculateSimulation(scenarioToInputs(scenario));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const sentences = scenarioLeverSentences({
        scenario,
        allScenarios: partialFamily,
        chResidentNetAnnual: result.chResident.netIncomeAnnual,
        itResidentNetAnnual: result.itResident.netIncomeAnnual,
        locale: 'it',
      });

      expect(warning).toHaveBeenCalledWith(expect.stringContaining('famiglia salariale incompleta'));
      expect(sentences.some((sentence) => sentence.startsWith('Il confronto che si muove'))).toBe(false);
    } finally {
      warning.mockRestore();
    }
  });
});
