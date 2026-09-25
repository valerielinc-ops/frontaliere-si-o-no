import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildComment } from '../scripts/ci/report-vitest-failure.mjs';
import {
  VITEST_RELATED_STEP_NAME,
  REVIEW_GATE_STEP_NAME,
  failingSetKey,
  inheritedRedRescueDecision,
  parseVitestFailureReport,
  relativeImportCandidates,
  vitestFailureIsTestsStep,
} from '../scripts/ci/lib/vitestCheck.mjs';

// Il caso del 2026-09-25: #9753 rossa solo per live-data-test-guard, test fuori
// dal suo diff, rotto su main da #9724 e riparato da #9774 (2be881f6f1d) che
// modifica scripts/ci/live-data-test-guard.mjs, importato dal test.
const HEAD_9753 = '64d6dc7c10ea4b9f8b3d2d0f0c1a2b3c4d5e6f70';
const FIX_9774 = '2be881f6f1d0000000000000000000000000000a';
const PR_9753_FILES = [
  '.github/workflows/loop-l8-revenue-attribution.yml',
  'scripts/ci/export-l8-affiliate-outcomes.mjs',
  'scripts/ci/fetch-authorized-affiliate-export.mjs',
  'scripts/load-rc-env.mjs',
  'tests/l8-authorized-affiliate-export.test.ts',
  'tests/loop-l8-attribution-export.test.ts',
];

function report9753(headSha = HEAD_9753) {
  return buildComment([{
    file: 'shard-timing-related.json',
    failedTests: 1,
    failedFiles: 2,
    failures: [{
      file: 'tests/live-data-test-guard.test.ts',
      test: 'nessun test NUOVO puo` leggere dati vivi non ci sono test fuori inventario che leggono radici dati vive',
      error: 'AssertionError: Questi test leggono dati che la pipeline riscrive da sola',
    }],
  }], { runUrl: 'https://github.com/o/r/actions/runs/36079087777', runId: '36079087777', headSha });
}

describe('parseVitestFailureReport legge il commento del vero produttore', () => {
  it('estrae i file falliti e la HEAD verificata', () => {
    expect(parseVitestFailureReport(report9753())).toEqual({
      headPrefix: HEAD_9753.slice(0, 12),
      files: ['tests/live-data-test-guard.test.ts'],
      truncated: false,
    });
  });

  it('segnala un report troncato (insieme dei file incompleto)', () => {
    const failures = Array.from({ length: 25 }, (_, i) => ({ file: `tests/f${i}.test.ts`, test: 't', error: 'e' }));
    const body = buildComment([{ file: 'shard-timing-related.json', failedTests: 25, failedFiles: 25, failures }], { headSha: HEAD_9753 });
    expect(parseVitestFailureReport(body)?.truncated).toBe(true);
  });

  it('non riconosce un body che non è il report', () => {
    expect(parseVitestFailureReport('- **tests/a.test.ts** — `x`')).toBeNull();
  });
});

describe('relativeImportCandidates', () => {
  it('trova il modulo che #9774 ha riparato fra gli import diretti del test', () => {
    const file = 'tests/live-data-test-guard.test.ts';
    const source = readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    const groups = relativeImportCandidates(source, file);
    expect(groups).toContainEqual(['scripts/ci/live-data-test-guard.mjs']);
  });

  it('espande uno specifier senza estensione in candidati ordinati', () => {
    const groups = relativeImportCandidates("import { a } from '../services/foo';\nconst b = require('./b.cjs');", 'tests/x.test.ts');
    expect(groups[0].slice(0, 2)).toEqual(['services/foo.ts', 'services/foo.tsx']);
    expect(groups).toContainEqual(['tests/b.cjs']);
  });

  it('ignora gli import di pacchetti', () => {
    expect(relativeImportCandidates("import { describe } from 'vitest';", 'tests/x.test.ts')).toEqual([]);
  });
});

describe('vitestFailureIsTestsStep', () => {
  it('è vero solo quando è fallito lo step dei test', () => {
    expect(vitestFailureIsTestsStep([{ name: VITEST_RELATED_STEP_NAME, conclusion: 'failure' }])).toBe(true);
    expect(vitestFailureIsTestsStep([
      { name: VITEST_RELATED_STEP_NAME, conclusion: 'success' },
      { name: REVIEW_GATE_STEP_NAME, conclusion: 'failure' },
    ])).toBe(false);
    // #9695: vitest 64/64 verde, rosso del gate tsc.
    expect(vitestFailureIsTestsStep([
      { name: VITEST_RELATED_STEP_NAME, conclusion: 'success' },
      { name: 'Collect independent source gates', conclusion: 'failure' },
    ])).toBe(false);
    expect(vitestFailureIsTestsStep([])).toBe(false);
  });
});

describe('inheritedRedRescueDecision', () => {
  const base = {
    report: parseVitestFailureReport(report9753()),
    head: HEAD_9753,
    prFiles: PR_9753_FILES,
    relevantMainCommit: FIX_9774,
    usedKeys: [],
  };
  const key = `${failingSetKey(['tests/live-data-test-guard.test.ts'])}@${FIX_9774.slice(0, 12)}`;

  it('#9753: rescue dopo la riparazione di main, anche col one-shot già speso', () => {
    expect(inheritedRedRescueDecision(base)).toEqual({ rescue: true, reason: 'inherited-fixed', key });
  });

  it('prima della riparazione di main non scatta (nessun commit di main sul test)', () => {
    expect(inheritedRedRescueDecision({ ...base, relevantMainCommit: '' }).reason).toBe('main-unchanged');
  });

  it('se il test fallito è nel diff della PR il rosso è suo', () => {
    const d = inheritedRedRescueDecision({ ...base, prFiles: [...PR_9753_FILES, 'tests/live-data-test-guard.test.ts'] });
    expect(d).toMatchObject({ rescue: false, reason: 'failing-test-in-diff' });
  });

  it('una chiave già usata non si ripete: stessi test, stesso commit di main', () => {
    expect(inheritedRedRescueDecision({ ...base, usedKeys: [key] })).toMatchObject({ rescue: false, reason: 'already-rescued' });
  });

  it('un commit di main nuovo sugli stessi test apre una chiave nuova, fino al tetto', () => {
    const next = inheritedRedRescueDecision({ ...base, relevantMainCommit: 'abcdef1234567890', usedKeys: [key] });
    expect(next.rescue).toBe(true);
    expect(next.key).not.toBe(key);
    const capped = inheritedRedRescueDecision({ ...base, relevantMainCommit: 'abcdef1234567890', usedKeys: [key, 'x', 'y'], maxRescues: 3 });
    expect(capped).toMatchObject({ rescue: false, reason: 'cap-reached' });
  });

  it('il report di una HEAD precedente non vale per quella attuale', () => {
    expect(inheritedRedRescueDecision({ ...base, head: 'ffffffffffff' + HEAD_9753.slice(12) }).reason).toBe('report-other-head');
  });

  it('senza report, senza file o con report troncato non scatta', () => {
    expect(inheritedRedRescueDecision({ ...base, report: null }).reason).toBe('no-report');
    expect(inheritedRedRescueDecision({ ...base, report: { ...base.report!, files: [] } }).reason).toBe('no-failing-files');
    expect(inheritedRedRescueDecision({ ...base, report: { ...base.report!, truncated: true } }).reason).toBe('report-truncated');
  });

  it('la chiave non dipende dall\'ordine dei file', () => {
    expect(failingSetKey(['b', 'a', 'a'])).toBe(failingSetKey(['a', 'b']));
  });
});

describe('pr-autorebase: la chiave si consuma solo dopo il push', () => {
  const src = readFileSync(path.resolve(__dirname, '..', 'scripts', 'ci', 'pr-autorebase.mjs'), 'utf8');
  const processPr = src.slice(src.indexOf('async function processPR('));

  it('il commento con la chiave segue un push riuscito, non lo precede', () => {
    const push = processPr.indexOf('const pushed = pushBranch(branch);');
    const pushFailed = processPr.indexOf('if (pushed === null)', push);
    const comment = processPr.indexOf('commentInheritedRedRescue(num, inheritedRescue)');
    expect(push).toBeGreaterThan(-1);
    expect(comment).toBeGreaterThan(pushFailed);
  });

  it('il rescue con chiave si valuta anche quando il one-shot è già speso', () => {
    const oneShot = processPr.indexOf('hasCommentMarker(num, STUCK_RED_MARKER)');
    const inherited = processPr.indexOf('inheritedRescue = inheritedRedRescue(num, head)');
    expect(oneShot).toBeGreaterThan(-1);
    expect(inherited).toBeGreaterThan(oneShot);
  });
});
