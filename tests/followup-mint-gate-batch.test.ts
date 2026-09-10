/**
 * «Salta una» contro «abbandona il lotto».
 *
 * Il difetto sorvegliato è una regressione reale, trovata in review su questa stessa PR:
 * `gh()` ritorna `null` quando la chiamata fallisce, e `JSON.parse(null)` coerce
 * l'argomento a `"null"` e ritorna `null` SENZA LANCIARE. Il `try/catch` attorno al parse
 * — che documentava «issue illeggibile → intatta» — non scattava più, l'oggetto nullo
 * entrava nella lista, e il primo accesso a un suo campo lanciava un `TypeError` raccolto
 * dal `catch` per-PR: una sola lettura fallita faceva perdere TUTTE le altre issue della
 * stessa PR, e nel log compariva «gate saltato» al posto delle righe per-issue.
 *
 * Perché questo test gira il processo vero invece di esercitare una funzione: la
 * differenza fra saltarne una e abbandonare il lotto vive nel ciclo di `main()`, ed è
 * **invisibile a un test che passa una issue sola**. Qui il lotto ne ha tre e quella in
 * mezzo è illeggibile. `gh` è un finto sul PATH, `DRY_RUN=1` non scrive niente.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = fileURLToPath(new URL('../scripts/ci/gate-minted-followups.mjs', import.meta.url));
let binDir = '';

beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), 'mint-gate-fake-gh-'));
  // `gh` finto: la lista rende tre issue della stessa PR, e `issue view` della SECONDA
  // fallisce — esattamente la lettura che prima abbatteva l'intero lotto.
  const fake = `#!/bin/sh
case "$1 $2" in
  "api "*)
    echo '[{"number":101,"title":"follow-up(#900): 1 item deferred - a","createdAt":"__NOW__"},{"number":102,"title":"follow-up(#900): 1 item deferred - b","createdAt":"__NOW__"},{"number":103,"title":"follow-up(#900): 1 item deferred - c","createdAt":"__NOW__"}]'
    ;;
  "issue view")
    if [ "$3" = "102" ]; then echo "gh: could not read issue 102" >&2; exit 1; fi
    # Heredoc QUOTATO: senza, la shell (o printf) trasformerebbe i \\n che devono restare
    # escape JSON in newline veri, e il corpo arriverebbe come JSON non valido.
    cat <<'JSON' | sed "s/__N__/$3/"
{"number":__N__,"title":"follow-up(#900): 1 item deferred - x","body":"## Origine\\n- PR: #900\\n\\n### 1. item senza condizione\\n- Source: reviewer\\n- Suggested action: valutare se serve un campo esplicito\\n","createdAt":"__NOW__"}
JSON
    ;;
  *) exit 0 ;;
esac
`.replace(/__NOW__/g, new Date().toISOString());
  writeFileSync(join(binDir, 'gh'), fake);
  chmodSync(join(binDir, 'gh'), 0o755);
});

afterAll(() => { if (binDir) rmSync(binDir, { recursive: true, force: true }); });

describe('gate sul conio — proceed-safe PER ISSUE, non per PR', () => {
  it('una issue illeggibile in mezzo al lotto non porta via le altre', () => {
    // `GITHUB_STEP_SUMMARY` si eredita dall'ambiente: in CI questo test scriverebbe la
    // propria riga nel summary REALE del job. Lo punto a un file di scarto e verifico che
    // resti vuoto — un dry-run non deve scrivere da nessuna parte.
    const summaryFile = join(binDir, 'step-summary.md');
    writeFileSync(summaryFile, '');
    const out = execFileSync('node', [GATE], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        BATCH_PRS: '900',
        DRY_RUN: '1',
        GH_REPO: 'o/r',
        GITHUB_STEP_SUMMARY: summaryFile,
      },
    });
    expect(readFileSync(summaryFile, 'utf-8')).toBe('');
    // Le due leggibili sono state giudicate...
    expect(out).toContain('#101 (PR #900)');
    expect(out).toContain('#103 (PR #900)');
    // ...quella illeggibile è saltata da sola, con la sua riga...
    expect(out).toContain('#102: non leggibile');
    // ...e il lotto NON è stato abbandonato: è la riga che compariva col difetto.
    expect(out).not.toContain('gate saltato');
  });

  it('recupera e sigilla un bucket storico quando il batch corrente è vuoto', () => {
    const issue = {
      number: 501,
      title: 'follow-up(daily:2026-09-09): 1 item — o/r',
      body: [
        '## Batch',
        '- Daily key: 2026-09-09 (Europe/Zurich)',
        '- State: collecting',
        '- Target repository: o/r',
        '',
        '## Item',
        '',
        '### FU-2026-09-09-001 — proteggi il comportamento',
        '- State: open',
        '- Sources: PR #8101',
        '- Target file: `scripts/example.mjs`',
        '- Original text:',
        '  > controllo non sempre applicato',
        '- Suggested action: aggiungi `firstGuard()` e `secondGuard()`',
        '- Acceptance token: `firstGuard()`',
        '',
      ].join('\n'),
      createdAt: new Date().toISOString(),
    };
    const comments = { comments: [{ body: '## Post-merge follow-up triage: zero outstanding items.' }] };
    const log = join(binDir, 'recovery-calls.log');
    writeFileSync(log, '');
    const fake = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n');
const issue = ${JSON.stringify(issue)};
const comments = ${JSON.stringify(comments)};
if (args[0] === 'api') process.stdout.write(JSON.stringify([[{ number: issue.number, title: issue.title, created_at: issue.createdAt }]]));
else if (args[0] === 'issue' && args[1] === 'view') process.stdout.write(JSON.stringify(issue));
else if (args[0] === 'pr' && args[1] === 'view') process.stdout.write(JSON.stringify(comments));
`;
    writeFileSync(join(binDir, 'gh'), fake);
    chmodSync(join(binDir, 'gh'), 0o755);
    const out = execFileSync('node', [GATE], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        BATCH_PRS: '',
        TRIAGE_COMPLETE: 'false',
        DRY_RUN: '0',
        GH_REPO: 'o/r',
        CALL_LOG: log,
        COLLECTION_OK: 'true',
      },
    });
    const calls = readFileSync(log, 'utf-8');
    expect(out).toContain('marker storici verificati');
    expect(out).toContain('→ seal');
    expect(calls).toContain('"--body-file"');
    expect(calls).toContain('"--add-label","agent:fix-queued"');
  });

  it('consolida un gruppo sealed+collecting senza lasciare il duplicate in starvation', () => {
    const makeBody = (id: string, state: string, pr: number, token: string) => [
      '## Batch',
      '- Daily key: 2026-09-09 (Europe/Zurich)',
      `- State: ${state}`,
      '- Target repository: o/r',
      '',
      '## Item',
      '',
      `### ${id} — proteggi il comportamento`,
      '- State: open',
      `- Sources: PR #${pr}`,
      '- Target file: `scripts/example.mjs`',
      '- Original text:',
      '  > il controllo non è sempre applicato',
      `- Suggested action: aggiungi \`${token}\``,
      `- Acceptance token: \`${token}\``,
      '',
    ].join('\n');
    const issues = [
      {
        number: 501,
        title: 'follow-up(daily:2026-09-09): 1 item — o/r',
        body: makeBody('FU-2026-09-09-001', 'sealed', 8101, 'firstGuard()'),
      },
      {
        number: 502,
        title: 'follow-up(daily:2026-09-09): 1 item — o/r',
        body: makeBody('FU-2026-09-09-002', 'collecting', 8102, 'thirdGuard()'),
      },
    ];
    const log = join(binDir, 'mixed-calls.log');
    writeFileSync(log, '');
    const fake = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const issues = ${JSON.stringify(issues)};
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'api') process.stdout.write(JSON.stringify([issues.map(({ number, title }) => ({ number, title }))]));
else if (args[0] === 'issue' && args[1] === 'view') {
  const issue = issues.find(({ number }) => String(number) === args[2]);
  process.stdout.write(JSON.stringify(issue || null));
} else if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ comments: [{ body: '## Post-merge follow-up triage: done' }] }));
}
`;
    writeFileSync(join(binDir, 'gh'), fake);
    chmodSync(join(binDir, 'gh'), 0o755);
    const out = execFileSync('node', [GATE], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        BATCH_PRS: '',
        TRIAGE_COMPLETE: 'false',
        COLLECTION_OK: 'true',
        DRY_RUN: '0',
        GH_REPO: 'o/r',
        CALL_LOG: log,
      },
    });
    const calls = readFileSync(log, 'utf-8');
    expect(out).toContain('duplicati consolidati/chiusi');
    expect(calls).toContain('"issue","close","502"');
    expect(calls).toContain('follow-up(daily:2026-09-09): 2 items');
  });
});
