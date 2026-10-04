import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// Import reale: e' l'arco che fa scegliere questo test alla selezione related
// quando cambia il validatore. Il registry e il ledger sono dati, non import:
// li collega la voce in `sourceTreeLintTests` di scripts/ci/run-related-tests.mjs
// (verificata in fondo a questo file).
import {
  buildLifecycleEvent,
  validateActionClassAgainstPolicy,
  validateDecisionLifecycle,
  validateHistoricalLifecycleEvent,
  validateHistoricalOutcomeAgainstPolicy,
} from '../scripts/lib/loop-fleet-contract.mjs';

// Il ledger durevole viene riletto contro il registry CORRENTE da chi lo usa a
// runtime: l'observer del lifecycle (validateHistoricalLifecycleEvent) e il
// merge del ledger che ogni loop esegue per scrivere i propri record. Il
// 2026-10-03 la PR 11001 ha cambiato i sourceRefs di L5 senza dichiarare
// outcome.historicalSourceRefs + historicalSourceRefsBefore: 199 eventi di
// lifecycle e 34 osservazioni gia' nel ledger sono diventati illeggibili, la PR
// e' passata verde e l'observer e' caduto al cron successivo, 4,5 ore dopo
// (issue 11178). Qui la stessa domanda si pone sulla PR, con le funzioni di
// produzione, su ogni record del ledger seminato su main.
const REGISTRY_PATH = 'data/loop-fleet/loop-registry.json';
const LEDGER_DIR = 'data/loop-fleet/ledger';
const LIFECYCLE_FILE = 'lifecycle-events.jsonl';
// Stessi tipi e stesse verifiche dipendenti dal registry di
// validateHistoricalRecord in scripts/ci/merge-loop-fleet-ledger.mjs.
const OUTCOME_FILES = [
  ['observation', 'loop-observations.jsonl'],
  ['decision', 'loop-decisions.jsonl'],
  ['health', 'loop-health-history.jsonl'],
] as const;

const FAILURE_TITLE = "Registry loop-fleet: sourceRefs cambiati senza historicalSourceRefs, il ledger durevole non e' piu' leggibile";
const SOURCE_REFS_HINT = "dichiara historicalSourceRefs + historicalSourceRefsBefore nel registry (outcome.historicalSourceRefs con i vecchi sourceRefs e come cutoff l'istante del cambio)";

type Registry = { loops: Array<Record<string, any>> };
type LedgerRecord = Record<string, any>;

const readRegistry = (): Registry => JSON.parse(fs.readFileSync(path.resolve(REGISTRY_PATH), 'utf8'));

function readLedger(fileName: string): LedgerRecord[] {
  return fs.readFileSync(path.resolve(LEDGER_DIR, fileName), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

const lifecycleRecords = readLedger(LIFECYCLE_FILE);
const outcomeRecords = OUTCOME_FILES.map(([type, fileName]) => ({ type, fileName, records: readLedger(fileName) }));

// Un errore per (file, loop, messaggio) con il numero di record coinvolti: il
// fallimento dice quale loop correggere senza stampare migliaia di righe.
function replayLedger(registry: Registry): string[] {
  const failures = new Map<string, number>();
  const check = (fileName: string, loopId: unknown, run: () => void) => {
    try {
      run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint = /sourceRefs must exactly match/u.test(message) ? ` -> ${SOURCE_REFS_HINT}` : '';
      const key = `${String(loopId)} ${fileName}: ${message}${hint}`;
      failures.set(key, (failures.get(key) ?? 0) + 1);
    }
  };
  for (const event of lifecycleRecords) {
    check(LIFECYCLE_FILE, event.loopId, () => validateHistoricalLifecycleEvent(registry, event.loopId, event));
  }
  for (const { type, fileName, records } of outcomeRecords) {
    for (const record of records) {
      check(fileName, record.loopId, () => {
        validateActionClassAgainstPolicy(registry, record.loopId, record.actionClass);
        if (type === 'decision') validateDecisionLifecycle(registry, record.loopId, record);
        validateHistoricalOutcomeAgainstPolicy(registry, record.loopId, record.outcome);
      });
    }
  }
  return [...failures].map(([key, count]) => `${key} (${count} record)`).sort();
}

const withoutHistoricalSourceRefs = (registry: Registry, loopIds: Set<string>): Registry => {
  const clone: Registry = structuredClone(registry);
  for (const loop of clone.loops) {
    if (!loopIds.has(loop.loopId)) continue;
    delete loop.outcome.historicalSourceRefs;
    delete loop.outcome.historicalSourceRefsBefore;
  }
  return clone;
};

const registry = readRegistry();
const loopsWithHistory = registry.loops.filter((loop) => (loop.outcome?.historicalSourceRefs ?? []).length > 0);
// L5 e' il caso dell'incidente; se un giorno non ha piu' storico, vale il primo
// loop che ne dichiara uno.
const sensitivityLoop = loopsWithHistory.find((loop) => loop.loopId === 'L5') ?? loopsWithHistory[0];

describe('loop-fleet registry contro il ledger durevole', () => {
  it('ha un ledger seminato da rileggere (niente verde a vuoto)', () => {
    expect(lifecycleRecords.length).toBeGreaterThan(0);
    for (const { fileName, records } of outcomeRecords) {
      expect(records.length, fileName).toBeGreaterThan(0);
    }
  });

  it('ogni record del ledger resta valido per il registry corrente', () => {
    expect(replayLedger(registry), FAILURE_TITLE).toEqual([]);
  });

  it.skipIf(!sensitivityLoop)(
    sensitivityLoop
      ? `un evento ${sensitivityLoop.loopId} con i sourceRefs storici passa solo finche' il registry li dichiara`
      : 'SALTATO: nessun loop del registry dichiara outcome.historicalSourceRefs, il controllo di sensibilita\' non ha un caso',
    () => {
      const loop = sensitivityLoop!;
      const cutoffMs = Date.parse(loop.outcome.historicalSourceRefsBefore);
      expect(Number.isFinite(cutoffMs), `${loop.loopId}.outcome.historicalSourceRefsBefore`).toBe(true);
      const eventAt = (ms: number) => {
        const at = new Date(ms).toISOString();
        return {
          ...buildLifecycleEvent({
            eventType: 'candidate',
            loopId: loop.loopId,
            candidateId: 'synthetic-replay-candidate',
            owner: loop.owner,
            sourceRecordId: 'synthetic-replay-decision',
            sourceRefs: loop.outcome.historicalSourceRefs[0],
            lifecycle: loop.lifecycle,
            occurredAt: at,
            recordedAt: at,
          }),
          recordId: 'synthetic-replay-lifecycle',
        };
      };
      const before = eventAt(cutoffMs - 3_600_000);
      expect(() => validateHistoricalLifecycleEvent(registry, loop.loopId, before)).not.toThrow();
      // Dopo il cutoff i vecchi riferimenti non valgono piu'.
      expect(() => validateHistoricalLifecycleEvent(registry, loop.loopId, eventAt(cutoffMs + 3_600_000)))
        .toThrow(/sourceRefs must exactly match the registry declaration/u);
      // Senza la dichiarazione storica lo stesso evento e' illeggibile: e' la
      // forma esatta dell'incidente di L5 (registry di b0739760a45).
      const stripped = withoutHistoricalSourceRefs(registry, new Set([loop.loopId]));
      expect(() => validateHistoricalLifecycleEvent(stripped, loop.loopId, before))
        .toThrow(/sourceRefs must exactly match the registry declaration/u);
    },
  );

  // Prova che il replay esercita davvero i validatori sui record reali: se il
  // ledger contiene record con i riferimenti storici, togliere le dichiarazioni
  // deve far comparire il loop fra gli errori.
  const usesHistoricalRefs = (loop: Record<string, any>, sourceRefs: unknown) => Array.isArray(sourceRefs)
    && (loop.outcome.historicalSourceRefs as string[][]).some((refs) => refs.length === sourceRefs.length
      && refs.every((ref) => sourceRefs.includes(ref)));
  const loopsWithHistoricalRecords = loopsWithHistory.filter((loop) => lifecycleRecords
    .some((event) => event.loopId === loop.loopId && usesHistoricalRefs(loop, event.sourceRefs)));
  it.skipIf(loopsWithHistoricalRecords.length === 0)(
    loopsWithHistoricalRecords.length > 0
      ? 'il replay sui record reali diventa rosso senza historicalSourceRefs'
      : 'SALTATO: nessun record del ledger usa riferimenti storici, resta il controllo sintetico',
    () => {
      const failures = replayLedger(withoutHistoricalSourceRefs(registry, new Set(loopsWithHistoricalRecords.map((loop) => loop.loopId))));
      for (const loop of loopsWithHistoricalRecords) {
        expect(failures.some((failure) => failure.startsWith(`${loop.loopId} ${LIFECYCLE_FILE}:`)
          && failure.includes(SOURCE_REFS_HINT)), loop.loopId).toBe(true);
      }
    },
  );

  it('gira su ogni diff che tocca registry, ledger o validatore', () => {
    const runner = fs.readFileSync(path.resolve('scripts/ci/run-related-tests.mjs'), 'utf8');
    const start = runner.indexOf('const sourceTreeLintTests = new Map([');
    expect(start, 'sourceTreeLintTests in run-related-tests.mjs').toBeGreaterThanOrEqual(0);
    const block = runner.slice(start, runner.indexOf('\n]);', start));
    const entry = block.match(/\['tests\/loop-fleet-registry-ledger-replay\.test\.ts',\s*\/((?:\\.|[^/\n])+)\/([a-z]*)\]/u);
    expect(entry, 'voce di questo test in sourceTreeLintTests').not.toBeNull();
    const scope = new RegExp(entry![1], entry![2]);
    for (const file of [
      REGISTRY_PATH,
      `${LEDGER_DIR}/${LIFECYCLE_FILE}`,
      ...OUTCOME_FILES.map(([, fileName]) => `${LEDGER_DIR}/${fileName}`),
      'scripts/lib/loop-fleet-contract.mjs',
    ]) {
      expect(scope.test(file), file).toBe(true);
    }
    expect(scope.test('data/crawler-group-assignments.json')).toBe(false);
  });
});
