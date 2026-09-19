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
      labels: [],
      createdAt: new Date().toISOString(),
    };
    const comments = { comments: [{ body: '## Post-merge follow-up triage: zero outstanding items.' }] };
    const log = join(binDir, 'recovery-calls.log');
    const state = join(binDir, 'recovery-state.json');
    writeFileSync(log, '');
    writeFileSync(state, JSON.stringify(issue));
    const fake = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n');
const issue = JSON.parse(fs.readFileSync(process.env.STATE, 'utf8'));
const comments = ${JSON.stringify(comments)};
if (args[0] === 'api') process.stdout.write(JSON.stringify([[{ number: issue.number, title: issue.title, created_at: issue.createdAt }]]));
else if (args[0] === 'issue' && args[1] === 'view') process.stdout.write(JSON.stringify(issue));
else if (args[0] === 'pr' && args[1] === 'view') process.stdout.write(JSON.stringify(comments));
else if (args[0] === 'issue' && args[1] === 'edit' && args.includes('--body-file')) {
  const updated = JSON.parse(fs.readFileSync(process.env.STATE, 'utf8'));
  updated.body = fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
  const titleIndex = args.indexOf('--title');
  if (titleIndex >= 0) updated.title = args[titleIndex + 1];
  fs.writeFileSync(process.env.STATE, JSON.stringify(updated));
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
        DRY_RUN: '0',
        GH_REPO: 'o/r',
        CALL_LOG: log,
        STATE: state,
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
        labels: [],
      },
      {
        number: 502,
        title: 'follow-up(daily:2026-09-09): 1 item — o/r',
        body: makeBody('FU-2026-09-09-002', 'collecting', 8102, 'thirdGuard()'),
        labels: [],
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

  it('non accoda un daily bucket sealed quando la snapshot porta needs-human', () => {
    const tick = String.fromCharCode(96);
    const body = [
      '## Batch',
      '- Daily key: 2026-09-09 (Europe/Zurich)',
      '- State: sealed',
      '- Target repository: o/r',
      '',
      '## Item',
      '',
      '### FU-2026-09-09-001 — proteggi il comportamento',
      '- State: open',
      '- Sources: PR #8101',
      '- Target file: ' + tick + 'scripts/example.mjs' + tick,
      '- Original text:',
      '  > il controllo non è sempre applicato',
      '- Suggested action: aggiungi ' + tick + 'firstGuard()' + tick,
      '- Acceptance token: ' + tick + 'firstGuard()' + tick,
      '',
    ].join('\n');
    const issue = {
      number: 601,
      title: 'follow-up(daily:2026-09-09): 1 item — o/r',
      body,
      labels: [{ name: 'needs-human' }],
      createdAt: new Date().toISOString(),
    };
    const log = join(binDir, 'needs-human-calls.log');
    writeFileSync(log, '');
    const fake = [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      'const issue = ' + JSON.stringify(issue) + ';',
      "fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n');",
      "if (args[0] === 'api') process.stdout.write(JSON.stringify([[{ number: issue.number, title: issue.title, created_at: issue.createdAt }]]));",
      "else if (args[0] === 'issue' && args[1] === 'view') process.stdout.write(JSON.stringify(issue));",
    ].join('\n') + '\n';
    writeFileSync(join(binDir, 'gh'), fake);
    chmodSync(join(binDir, 'gh'), 0o755);
    const out = execFileSync('node', [GATE], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: binDir + ':' + (process.env.PATH ?? ''),
        BATCH_PRS: '',
        COLLECTION_OK: 'false',
        DRY_RUN: '0',
        GH_REPO: 'o/r',
        CALL_LOG: log,
      },
    });
    const calls = readFileSync(log, 'utf-8');
    expect(out).toContain('nessuna nuova agent:fix-queued (needs-human veto)');
    expect(calls).not.toContain('"--add-label","agent:fix-queued"');
  });

  it('non accoda un daily bucket sealed quando una label è malformata', () => {
    const tick = String.fromCharCode(96);
    const body = [
      '## Batch',
      '- Daily key: 2026-09-09 (Europe/Zurich)',
      '- State: sealed',
      '- Target repository: o/r',
      '',
      '## Item',
      '',
      '### FU-2026-09-09-001 — proteggi il comportamento',
      '- State: open',
      '- Sources: PR #8101',
      '- Target file: ' + tick + 'scripts/example.mjs' + tick,
      '- Original text:',
      '  > il controllo non è sempre applicato',
      '- Suggested action: aggiungi ' + tick + 'firstGuard()' + tick,
      '- Acceptance token: ' + tick + 'firstGuard()' + tick,
      '',
    ].join('\n');
    const issue = {
      number: 602,
      title: 'follow-up(daily:2026-09-09): 1 item — o/r',
      body,
      labels: [{}],
      createdAt: new Date().toISOString(),
    };
    const log = join(binDir, 'malformed-label-calls.log');
    writeFileSync(log, '');
    const fake = [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      'const issue = ' + JSON.stringify(issue) + ';',
      "fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n');",
      "if (args[0] === 'api') process.stdout.write(JSON.stringify([[{ number: issue.number, title: issue.title, created_at: issue.createdAt }]]));",
      "else if (args[0] === 'issue' && args[1] === 'view') process.stdout.write(JSON.stringify(issue));",
    ].join('\n') + '\n';
    writeFileSync(join(binDir, 'gh'), fake);
    chmodSync(join(binDir, 'gh'), 0o755);
    const out = execFileSync('node', [GATE], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: binDir + ':' + (process.env.PATH ?? ''),
        BATCH_PRS: '',
        COLLECTION_OK: 'false',
        DRY_RUN: '0',
        GH_REPO: 'o/r',
        CALL_LOG: log,
      },
    });
    const calls = readFileSync(log, 'utf-8');
    expect(out).toContain('labels non verificabili');
    expect(calls).not.toContain('"--add-label","agent:fix-queued"');
  });

  it('non riusa le label precedenti se la latest snapshot le omette prima della coda', () => {
    const tick = String.fromCharCode(96);
    const body = [
      '## Batch',
      '- Daily key: 2026-09-09 (Europe/Zurich)',
      '- State: sealed',
      '- Target repository: o/r',
      '',
      '## Item',
      '',
      '### FU-2026-09-09-001 — proteggi il comportamento',
      '- State: open',
      '- Sources: PR #8101',
      '- Target file: ' + tick + 'scripts/example.mjs' + tick,
      '- Original text:',
      '  > il controllo non è sempre applicato',
      '- Suggested action: aggiungi ' + tick + 'firstGuard()' + tick,
      '- Acceptance token: ' + tick + 'firstGuard()' + tick,
      '',
      '### FU-2026-09-09-002 — verifica la documentazione',
      '- State: open',
      '- Sources: PR #8101',
      '- Target file: ' + tick + 'scripts/example.mjs' + tick,
      '- Original text:',
      '  > il comportamento non è documentato',
      '- Suggested action: valuta il testo',
      '',
    ].join('\n');
    const issue = {
      number: 603,
      title: 'follow-up(daily:2026-09-09): 2 items — o/r',
      body,
      labels: [],
      createdAt: new Date().toISOString(),
    };
    const log = join(binDir, 'latest-missing-label-calls.log');
    writeFileSync(log, '');
    const fake = [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      'const issue = ' + JSON.stringify(issue) + ';',
      "const priorCalls = fs.existsSync(process.env.CALL_LOG) ? fs.readFileSync(process.env.CALL_LOG, 'utf8').split('\\n').filter(Boolean).length : 0;",
      "fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n');",
      "if (args[0] === 'api') process.stdout.write(JSON.stringify([[{ number: issue.number, title: issue.title, created_at: issue.createdAt }]]));",
      "else if (args[0] === 'issue' && args[1] === 'view') { const latest = { ...issue }; if (priorCalls >= 2) delete latest.labels; process.stdout.write(JSON.stringify(latest)); }",
      "else if (args[0] === 'pr' && args[1] === 'comment') process.stdout.write('');",
    ].join('\n') + '\n';
    writeFileSync(join(binDir, 'gh'), fake);
    chmodSync(join(binDir, 'gh'), 0o755);
    const out = execFileSync('node', [GATE], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: binDir + ':' + (process.env.PATH ?? ''),
        BATCH_PRS: '8101',
        COLLECTION_OK: 'false',
        TRIAGE_COMPLETE: 'false',
        DRY_RUN: '0',
        GH_REPO: 'o/r',
        CALL_LOG: log,
      },
    });
    const calls = readFileSync(log, 'utf-8');
    expect(out).toContain('demozione sigillata senza nuova coda');
    expect(out).toContain('labels non verificabili');
    expect(calls).not.toContain('"--add-label","agent:fix-queued"');
  });
});

function runFreshQueueFixture({
  title,
  body,
  labels,
  mode,
  collectionOk,
}: {
  title: string;
  body: string;
  labels: Array<{ name: string }>;
  mode: string;
  collectionOk: string;
}) {
  const dir = mkdtempSync(join(tmpdir(), 'mint-gate-fresh-queue-'));
  const log = join(dir, 'calls.log');
  const statePath = join(dir, 'state.json');
  const viewsPath = join(dir, 'views');
  const issue = { number: 701, title, body, labels, createdAt: new Date().toISOString() };
  writeFileSync(log, '');
  writeFileSync(statePath, JSON.stringify(issue));
  writeFileSync(viewsPath, '0');
  const fake = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const mode = ${JSON.stringify(mode)};
const statePath = process.env.STATE;
const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const writeState = (value) => fs.writeFileSync(statePath, JSON.stringify(value));
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'api') {
  const current = readState();
  process.stdout.write(JSON.stringify([[{ number: current.number, title: current.title, state: 'open', labels: current.labels, created_at: current.createdAt }]]));
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'view') {
  const count = Number(fs.readFileSync(process.env.VIEWS, 'utf8') || '0');
  fs.writeFileSync(process.env.VIEWS, String(count + 1));
  const latest = readState();
  if (mode === 'mutate-after-decision' && count > 0) latest.labels = [...latest.labels, { name: 'needs-human' }];
  if (mode === 'remove-followup-after-decision' && count > 0) latest.labels = [];
  if (mode === 'wrong-number-after-decision' && count > 0) latest.number = 702;
  if (mode === 'missing-number-after-decision' && count > 0) delete latest.number;
  process.stdout.write(JSON.stringify(latest));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ comments: [{ body: '## Post-merge follow-up triage\\n- Daily bucket: #701' }] }));
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'edit' && args.includes('--body-file')) {
  const updated = readState();
  updated.body = fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
  const titleIndex = args.indexOf('--title');
  if (titleIndex >= 0) updated.title = args[titleIndex + 1];
  if (mode === 'mutate-after-body') updated.labels = [...updated.labels, { name: 'needs-human' }];
  writeState(updated);
  process.exit(0);
}
if ((args[0] === 'issue' || args[0] === 'pr') && (args[1] === 'edit' || args[1] === 'comment')) process.exit(0);
process.exit(66);
`;
  writeFileSync(join(binDir, 'gh'), fake);
  chmodSync(join(binDir, 'gh'), 0o755);
  const stdout = execFileSync('node', [GATE], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      BATCH_PRS: '',
      DRY_RUN: '0',
      GH_REPO: 'o/r',
      GATE_PR_REPO: 'o/r',
      COLLECTION_OK: collectionOk,
      TRIAGE_COMPLETE: 'true',
      CALL_LOG: log,
      STATE: statePath,
      VIEWS: viewsPath,
      GITHUB_STEP_SUMMARY: '',
    },
  });
  const calls = readFileSync(log, 'utf8');
  return { out: { status: 0, stdout }, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const freshDailyBody = (state: 'sealed' | 'collecting', includeInvalid = false) => {
  const tick = String.fromCharCode(96);
  const valid = [
    '### FU-2026-09-19-001 — queue candidate',
    '- State: open',
    '- Sources: PR #8101',
    '- Target file: ' + tick + 'scripts/example.mjs' + tick,
    '- Original text:',
    '  > il controllo non è sempre applicato',
    '- Suggested action: aggiungi ' + tick + 'firstGuard()' + tick,
    '- Acceptance token: ' + tick + 'firstGuard()' + tick,
  ].join('\n');
  const invalid = [
    '### FU-2026-09-19-002 — missing acceptance',
    '- State: open',
    '- Sources: PR #8101',
    '- Target file: ' + tick + 'scripts/example.mjs' + tick,
    '- Suggested action: controllare il file',
  ].join('\n');
  return [
    '## Batch',
    '- Daily key: 2026-09-19 (Europe/Zurich)',
    '- State: ' + state,
    '- Target repository: o/r',
    '',
    '## Item',
    '',
    valid,
    ...(includeInvalid ? ['', invalid] : []),
    '',
  ].join('\n');
};

describe('gate queue — final freshness read before add-label', () => {
  it('keep: una label aggiunta dopo la decisione blocca la nuova coda', () => {
    const fixture = runFreshQueueFixture({
      title: 'follow-up(daily:2026-09-19): 1 item — o/r',
      body: freshDailyBody('sealed'),
      labels: [{ name: 'follow-up' }],
      mode: 'mutate-after-decision',
      collectionOk: 'false',
    });
    try {
      expect(fixture.out.status).toBe(0);
      expect(fixture.calls).not.toContain('"--add-label","agent:fix-queued"');
      expect(fixture.out.stdout).toContain('latest snapshot stale');
    } finally {
      fixture.cleanup();
    }
  });

  it('seal: una label mutata dopo il body-write blocca la nuova coda', () => {
    const fixture = runFreshQueueFixture({
      title: 'follow-up(daily:2026-09-19): 1 item — o/r',
      body: freshDailyBody('collecting'),
      labels: [{ name: 'follow-up' }],
      mode: 'mutate-after-body',
      collectionOk: 'true',
    });
    try {
      expect(fixture.out.status).toBe(0);
      expect(fixture.calls).toContain('"--body-file"');
      expect(fixture.calls).not.toContain('"--add-label","agent:fix-queued"');
      expect(fixture.out.stdout).toContain('latest snapshot stale');
    } finally {
      fixture.cleanup();
    }
  });

  it('demote: una label mutata dopo il body-write blocca la nuova coda', () => {
    const fixture = runFreshQueueFixture({
      title: 'follow-up(daily:2026-09-19): 2 items — o/r',
      body: freshDailyBody('collecting', true),
      labels: [{ name: 'follow-up' }],
      mode: 'mutate-after-body',
      collectionOk: 'true',
    });
    try {
      expect(fixture.out.status).toBe(0);
      expect(fixture.calls).toContain('"--body-file"');
      expect(fixture.calls).not.toContain('"--add-label","agent:fix-queued"');
      expect(fixture.out.stdout).toContain('latest snapshot stale');
    } finally {
      fixture.cleanup();
    }
  });

  it('rimozione della follow-up fra decisione e rilettura non riaccoda l issue', () => {
    const fixture = runFreshQueueFixture({
      title: 'follow-up(daily:2026-09-19): 1 item — o/r',
      body: freshDailyBody('sealed'),
      labels: [{ name: 'follow-up' }],
      mode: 'remove-followup-after-decision',
      collectionOk: 'false',
    });
    try {
      expect(fixture.out.status).toBe(0);
      expect(fixture.calls).not.toContain('"--add-label","agent:fix-queued"');
      expect(fixture.out.stdout).toContain('latest snapshot stale');
    } finally {
      fixture.cleanup();
    }
  });

  it('numero issue diverso fra decisione e rilettura non può spostare la label', () => {
    const fixture = runFreshQueueFixture({
      title: 'follow-up(daily:2026-09-19): 1 item — o/r',
      body: freshDailyBody('sealed'),
      labels: [{ name: 'follow-up' }],
      mode: 'wrong-number-after-decision',
      collectionOk: 'false',
    });
    try {
      expect(fixture.out.status).toBe(0);
      expect(fixture.calls).not.toContain('"--add-label","agent:fix-queued"');
      expect(fixture.out.stdout).toContain('latest snapshot stale');
    } finally {
      fixture.cleanup();
    }
  });

  it('numero issue mancante nella rilettura rende la snapshot non verificabile', () => {
    const fixture = runFreshQueueFixture({
      title: 'follow-up(daily:2026-09-19): 1 item — o/r',
      body: freshDailyBody('sealed'),
      labels: [{ name: 'follow-up' }],
      mode: 'missing-number-after-decision',
      collectionOk: 'false',
    });
    try {
      expect(fixture.out.status).toBe(0);
      expect(fixture.calls).not.toContain('"--add-label","agent:fix-queued"');
      expect(fixture.out.stdout).toContain('latest snapshot non verificabile');
    } finally {
      fixture.cleanup();
    }
  });
});
