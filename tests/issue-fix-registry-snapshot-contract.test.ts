/**
 * Due contratti fra `issue-fix.yml` e i file che il ciclo autonomo modifica.
 * Entrambi si sono rotti il 2026-09-24, subito dopo #9659, e ogni run del
 * fixer falliva prima dell'agente:
 *
 * 1. `DECISIONS.md` viene iniettato nel prompt con un tetto in byte
 *    (`DECISIONS_MAX_BYTES`). Otto righe nuove lo hanno portato a 15539 byte e
 *    «Determine fix tier» usciva con `decision registry too large`.
 * 2. `risk_policy` calcola il fingerprint della issue e poi rimuove
 *    `agent:vision-approved`; il verify del job `fix` ricalcola il fingerprint
 *    dopo. Se la label entra nel fingerprint, ogni issue rientrata dal pre-pass
 *    fallisce con «issue snapshot cambiata».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const workflow = readFileSync(new URL('.github/workflows/issue-fix.yml', root), 'utf8');

describe('issue-fix ↔ DECISIONS.md', () => {
  it('il registro sta sotto il tetto che issue-fix accetta', () => {
    const m = /DECISIONS_MAX_BYTES=(\d+)/.exec(workflow);
    expect(m, 'DECISIONS_MAX_BYTES non trovato in issue-fix.yml').not.toBeNull();
    const cap = Number(m![1]);
    const size = statSync(new URL('DECISIONS.md', root)).size;
    expect(size).toBeLessThanOrEqual(cap);
  });
});

describe('issue-fix snapshot fingerprint', () => {
  it('esclude agent:vision-approved in entrambe le snapshot', () => {
    const labelLines = workflow
      .split('\n')
      .filter((line) => /^\s*labels: \(\[\.labels\[\]\.name\]/.test(line));
    expect(labelLines).toHaveLength(2);
    for (const line of labelLines) {
      expect(line).toContain('select(. != "agent:vision-approved")');
    }
  });

  it('risk_policy rimuove davvero la label esclusa dal fingerprint', () => {
    const start = workflow.indexOf('  risk_policy:');
    const end = workflow.indexOf('\n  fix:', start);
    expect(workflow.slice(start, end)).toContain('remove_label_idempotently "agent:vision-approved"');
  });
});
