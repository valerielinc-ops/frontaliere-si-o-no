/**
 * followup-drainer — transizioni bounded e provisioning delle label.
 *
 * Questi test esercitano il seam `ensureLabel` senza chiamare GitHub e fissano
 * l'ordine della mutazione: una transizione confermata viene commentata solo
 * dopo l'edit riuscito. Un errore di provisioning o di edit deve consumare un
 * tentativo bounded, non diventare un successo memoizzato.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureLabel,
  MAX_LABEL_DESCRIPTION_LENGTH,
  UNPARKED_LABEL_DESCRIPTION,
} from '../scripts/ci/followup-drainer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRAINER_SRC = resolve(__dirname, '../scripts/ci/followup-drainer.mjs');
const src = readFileSync(DRAINER_SRC, 'utf8');

type CloseFixture = {
  open: boolean;
  labels: Set<string>;
  events: string[];
};

/** Simula le due mutazioni non atomiche del close senza chiamare GitHub. */
function simulateClose({ closeSucceeds, cleanupSucceeds = true }: { closeSucceeds: boolean; cleanupSucceeds?: boolean }): CloseFixture {
  const issue: CloseFixture = { open: true, labels: new Set(['fu-parked']), events: [] };
  issue.labels.add('fu-resolved-auto');
  issue.events.push('add resolved-auto');
  if (!closeSucceeds) {
    issue.events.push('close failed');
    return issue;
  }
  issue.open = false;
  issue.events.push('close');
  if (cleanupSucceeds) {
    issue.labels.delete('fu-parked');
    issue.events.push('remove parked');
  } else {
    issue.events.push('cleanup failed');
  }
  issue.events.push('comment');
  return issue;
}

const selectedByVerdictExit = (issue: CloseFixture) => issue.open && issue.labels.has('fu-parked');

describe('ensureLabel — upsert verificato e descrizione bounded', () => {
  it('crea una label valida senza fallback edit', () => {
    const calls: string[][] = [];
    const run = (args: string[]) => { calls.push(args); };

    expect(ensureLabel('fu-test', '0e8a16', 'descrizione valida', { run, dry: false })).toBe('created');
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 2)).toEqual(['label', 'create']);
  });

  it('riallinea una label già esistente via fallback edit', () => {
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      if (args[1] === 'create') throw new Error('label already exists');
    };

    expect(ensureLabel('fu-test', '0e8a16', 'descrizione valida', { run, dry: false })).toBe('updated');
    expect(calls).toHaveLength(2);
    expect(calls[1].slice(0, 2)).toEqual(['label', 'edit']);
  });

  it('rifiuta una descrizione oltre il limite senza troncare né chiamare l API', () => {
    const calls: string[][] = [];
    const run = (args: string[]) => { calls.push(args); };
    const tooLong = 'x'.repeat(MAX_LABEL_DESCRIPTION_LENGTH + 1);

    expect(ensureLabel('fu-test', '0e8a16', tooLong, { run, dry: false })).toBe('failed');
    expect(ensureLabel('fu-test', '0e8a16', tooLong, { run, dry: true })).toBe('failed');
    expect(calls).toHaveLength(0);
  });

  it('non memoizza un fallimento di create+edit', () => {
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      throw new Error('API unavailable');
    };

    expect(ensureLabel('fu-test', '0e8a16', 'descrizione valida', { run, dry: false })).toBe('failed');
    expect(calls).toHaveLength(2);
  });

  it('la descrizione usata da UNPARKED resta nel contratto API', () => {
    expect(UNPARKED_LABEL_DESCRIPTION.length).toBeLessThanOrEqual(MAX_LABEL_DESCRIPTION_LENGTH);
  });
});

describe('followup-drainer — esito solo dopo la mutazione confermata', () => {
  it('UNPARK verifica label/edit prima di memo, contatore e commento', () => {
    const branch = src.slice(
      src.indexOf('if ((outcome === null || deliveredParked) && !isUnparkedOnce(iss)) {'),
      src.indexOf('const d = verdictExitDecision(outcome, {'),
    );
    expect(branch).toContain("if (labelStatus === 'failed')");
    expect(branch.indexOf("if (labelStatus === 'failed')")).toBeLessThan(branch.indexOf('unparkLabelEnsured = true'));
    expect(branch.indexOf('editChecked')).toBeLessThan(branch.lastIndexOf('succeeded++'));
    expect(branch.lastIndexOf('succeeded++')).toBeLessThan(branch.indexOf('const unparkBody'));
    expect(branch.indexOf('const unparkBody')).toBeLessThan(branch.indexOf("gh(['issue', 'comment'"));
    expect(branch).toContain('attempted++');
  });

  it('close, flag ed escalate non commentano prima di editChecked', () => {
    const verdict = src.slice(
      src.indexOf('const d = verdictExitDecision(outcome, {'),
      src.indexOf('// --- TOO-LARGE ESCALATION'),
    );
    const branchEnds = ["if (d.action === 'flag')", '// escalate', 'if (succeeded) console.log'];
    for (const [index, marker] of ["if (d.action === 'close')", "if (d.action === 'flag')", '// escalate'].entries()) {
      const branchStart = verdict.indexOf(marker);
      expect(branchStart, `branch ${marker} non trovato`).toBeGreaterThan(-1);
      const branch = verdict.slice(branchStart, verdict.indexOf(branchEnds[index], branchStart));
      const edit = branch.indexOf('editChecked');
      const comment = branch.indexOf("gh(['issue', 'comment'");
      expect(edit, marker).toBeGreaterThan(-1);
      if (comment >= 0) expect(edit, marker).toBeLessThan(comment);
    }
  });

  it('close mantiene fu-parked se la close fallisce e commenta solo dopo la close', () => {
    const closeBranch = src.slice(
      src.indexOf("if (d.action === 'close')"),
      src.indexOf("if (d.action === 'flag')"),
    );
    const addResolved = closeBranch.indexOf("editChecked(iss.number, { add: [LBL_RESOLVED_AUTO], remove: [] })");
    const close = closeBranch.indexOf("gh(['issue', 'close'");
    const cleanup = closeBranch.indexOf('const parkedCleanup');
    const comment = closeBranch.indexOf("gh(['issue', 'comment'");
    expect(addResolved).toBeGreaterThan(-1);
    expect(addResolved).toBeLessThan(close);
    expect(close).toBeLessThan(cleanup);
    expect(cleanup).toBeLessThan(comment);
    expect(closeBranch).toContain('cleanup ${LBL_PARKED} fallito');
    expect(closeBranch).toContain("'fu-parked fallito'");

    const failed = simulateClose({ closeSucceeds: false });
    expect(failed.open).toBe(true);
    expect(failed.labels.has('fu-parked')).toBe(true);
    expect(selectedByVerdictExit(failed)).toBe(true);
    expect(failed.events).not.toContain('comment');

    const happy = simulateClose({ closeSucceeds: true });
    expect(happy.open).toBe(false);
    expect(happy.labels.has('fu-parked')).toBe(false);
    expect(happy.events).toEqual(['add resolved-auto', 'close', 'remove parked', 'comment']);
  });

  it('sibling-debt e data-pending trattano provisioning/edit come gate', () => {
    const grouping = src.slice(src.indexOf('function prepareIssueGroup'), src.indexOf('/** Instrada una issue allo stadio di decomposizione'));
    expect(grouping).toContain("ensureLabel(label, '5319e7'");
    expect(grouping).toContain("=== 'failed') return null");

    const sibling = src.slice(
      src.lastIndexOf('// --- SIBLING-DEBT:'),
      src.lastIndexOf('// --- PARKED-RETRY:'),
    );
    expect(sibling).toContain("if (labelStatus === 'failed')");
    expect(sibling.indexOf("if (labelStatus === 'failed')")).toBeLessThan(sibling.indexOf('ensured = true'));
    expect(sibling).toContain('if (!editChecked(iss.number');
    expect(sibling.indexOf('editChecked')).toBeLessThan(sibling.indexOf("gh(['issue', 'comment'"));
    expect(sibling).toContain('if (attempted >= SIBLING_DEBT_MAX_PER_RUN)');
    expect(sibling).toContain('else if (attempted) console.log');

    const dataPending = src.slice(
      src.indexOf('const dataPending = detectDataPending'),
      src.indexOf('// Check: secrets-scoped category', src.indexOf('const dataPending = detectDataPending')),
    );
    expect(dataPending).toContain("ensureLabel(LBL_DATA_PENDING");
    expect(dataPending.indexOf('ensureLabel')).toBeLessThan(dataPending.indexOf('editChecked'));
    expect(dataPending.indexOf('editChecked')).toBeLessThan(dataPending.indexOf("gh(['issue', 'comment'"));
  });

  it('usa attempted per il cap e succeeded solo per transizioni confermate', () => {
    const verdict = src.slice(
      src.indexOf('const parked = listIssues(LBL_PARKED)'),
      src.indexOf('// --- TOO-LARGE ESCALATION'),
    );
    expect(verdict).toContain('let attempted = 0;');
    expect(verdict).toContain('let succeeded = 0;');
    expect(verdict).toContain('if (attempted >= VERDICT_EXIT_MAX_PER_RUN)');
    expect(verdict).toContain('if (succeeded) console.log');
    expect(verdict).toContain('nessuna transizione confermata dopo ${attempted} tentativi');
  });
});
