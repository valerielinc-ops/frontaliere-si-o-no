/**
 * Contratto follow-up: `FOLLOWUP.md` deve nominare ogni stato, marker e motivo
 * che il codice usa.
 *
 * `FOLLOWUP.md` è il contratto che leggono triage e fixer, ma nessun test lo
 * legava al codice: dopo i cambi a conio, reconciler e routing `already-fixed`
 * non nominava i motivi di demozione (`closed-state-bullet`,
 * `target-file-missing`), né i marker a grana item, né chi scrive ogni
 * transizione (`grep -c 'FU_ITEM_' FOLLOWUP.md` → 1, la sola riga del marker
 * dei token nati veri). I letterali qui sotto si IMPORTANO dai moduli che li
 * definiscono: un rename nel codice senza aggiornare il documento rompe il test.
 *
 * Titolo di fallimento: «Contratto follow-up: `FOLLOWUP.md` non nomina uno
 * stato, un marker o un motivo che il codice usa».
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MINT_OBSERVATIONS } from '../scripts/ci/lib/followup-mint-admission.mjs';
import {
  ITEM_ATTEMPT_MARKER,
  ITEM_BLOCKED_MARKER,
  ITEM_BLOCKED_REASONS,
  ITEM_BORN_SATISFIED_MARKER,
  ITEM_EVIDENCE_MARKER,
  ITEM_UNBLOCKED_MARKER,
} from '../scripts/ci/lib/followup-item-evidence.mjs';
import { BUCKET_VERIFY_REQUEST_MARKER } from '../scripts/ci/reconcile-followups.mjs';
import { parseFollowupItems, updateFollowupItemState } from '../scripts/ci/followup-resolution-match.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOC = readFileSync(new URL('../FOLLOWUP.md', import.meta.url), 'utf8');

const STATE_HEADING = "## Stati dell'item, scrittori e chiusura";
const MINT_HEADING = '### Ammissione al conio: demozioni e osservazioni';

/** Il testo dall'heading dato fino al prossimo heading di livello uguale o superiore. */
function section(heading: string): string {
  const start = DOC.split('\n').findIndex((line) => line.trim() === heading);
  if (start < 0) return '';
  const level = heading.match(/^#+/)?.[0].length ?? 2;
  const lines = DOC.split('\n').slice(start + 1);
  const end = lines.findIndex((line) => {
    const hashes = line.match(/^(#+)\s/)?.[1];
    return hashes !== undefined && hashes.length <= level;
  });
  return (end < 0 ? lines : lines.slice(0, end)).join('\n');
}

/** Il primo valore fra backtick di ogni riga di tabella (`| \`x\` | …`). */
function tableKeys(text: string): string[] {
  return text.split('\n')
    .map((line) => line.match(/^\|\s*`([^`]+)`\s*\|/u)?.[1])
    .filter((key): key is string => Boolean(key));
}

const ITEM_ID = 'FU-2026-10-04-001';
const BUCKET = [
  '## Item',
  '',
  `### ${ITEM_ID} — esempio`,
  '- State: open',
  '- Target file: `scripts/ci/reconcile-followups.mjs`',
  '- Suggested action: rendi vero `exampleGuard()`',
  '- Acceptance token: `exampleGuard()`',
  '',
].join('\n');

describe('FOLLOWUP.md nomina ciò che il codice usa', () => {
  it('ogni codice di MINT_OBSERVATIONS ha una riga nella tabella di ammissione al conio', () => {
    const mint = section(MINT_HEADING);
    expect(mint, MINT_HEADING).not.toBe('');
    const rows = new Set(tableKeys(mint));
    const codes = Object.values(MINT_OBSERVATIONS);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) expect(rows.has(code), `MINT_OBSERVATIONS: ${code}`).toBe(true);
    for (const row of rows) expect(codes, `riga senza codice nel modulo: ${row}`).toContain(row);
  });

  it('ogni marker ha una riga con il suo scrittore nella tabella dei marker', () => {
    const states = section(STATE_HEADING);
    expect(states, STATE_HEADING).not.toBe('');
    const rows = new Set(tableKeys(states));
    const markers = [
      ITEM_EVIDENCE_MARKER,
      ITEM_ATTEMPT_MARKER,
      ITEM_BLOCKED_MARKER,
      ITEM_BORN_SATISFIED_MARKER,
      ITEM_UNBLOCKED_MARKER,
      BUCKET_VERIFY_REQUEST_MARKER,
    ];
    for (const marker of markers) expect(rows.has(marker), `marker: ${marker}`).toBe(true);
  });

  it('ogni motivo di ITEM_BLOCKED_REASONS è nominato nella sezione degli stati', () => {
    const states = section(STATE_HEADING);
    expect(ITEM_BLOCKED_REASONS.length).toBeGreaterThan(0);
    for (const reason of ITEM_BLOCKED_REASONS) expect(states, `motivo: ${reason}`).toContain(`\`${reason}\``);
  });

  it('gli stati dichiarati sono esattamente quelli che il parser accetta', () => {
    expect(parseFollowupItems(BUCKET).map((item) => item.id)).toEqual([ITEM_ID]);
    const line = section(STATE_HEADING).split('\n').find((l) => l.includes('Stati ammessi dal parser:')) ?? '';
    const declared = [...line.split('Stati ammessi dal parser:')[1]?.split('.')[0].matchAll(/`([^`]+)`/gu) ?? []]
      .map((match) => match[1]);
    expect(declared.length, 'riga «Stati ammessi dal parser:»').toBeGreaterThan(0);
    const probes = new Set([...declared, 'open', 'in-progress', 'done', 'blocked', 'closed', 'pending', 'parked', 'resolved', 'wontfix']);
    const accepted = [...probes].filter((state) => updateFollowupItemState(BUCKET, ITEM_ID, state) !== null);
    expect(declared.sort()).toEqual(accepted.sort());
  });

  it('i path citati nella sezione degli stati esistono nel repository', () => {
    const paths = [...section(STATE_HEADING).matchAll(/`([\w.-]+(?:\/[\w.-]+)+\.m?[jt]s)`/gu)].map((match) => match[1]);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of new Set(paths)) expect(existsSync(`${ROOT}${path}`), path).toBe(true);
  });

  it('il mutex nominato è quello dei workflow di triage, reconciler e drainer', () => {
    for (const workflow of ['post-merge-followup.yml', 'followup-reconcile.yml', 'followup-drainer.yml']) {
      const yml = readFileSync(`${ROOT}.github/workflows/${workflow}`, 'utf8');
      expect(yml, workflow).toMatch(/group:\s*followup-daily-\$\{\{\s*github\.repository\s*\}\}/u);
    }
    expect(section(STATE_HEADING)).toContain('`followup-daily-<repo>`');
  });
});
