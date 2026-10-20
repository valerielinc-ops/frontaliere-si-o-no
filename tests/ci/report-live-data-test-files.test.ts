/**
 * L'osservatore del reporter per file di `live-data-gates.yml` (issue 9453).
 *
 * Il difetto: il workflow apriva UNA sola issue, `Workflow Failure: live-data
 * gates`, per qualunque rosso dei ~60 file su dati vivi. Run 37198123353
 * (2026-10-04, main): tre file rossi insieme (job-locale-consistency al 33,04%
 * contro il 33%, la matrice farmacie con 4 cantoni su 5, un terzo file mai
 * comparso nell'estratto troncato) finivano tutti nello stesso thread,
 * gia` aperto da settimane: nessun rosso aveva un proprietario, nessuno aveva
 * una chiusura propria, e il verde di un file non si vedeva finche` tutti gli
 * altri non tornavano verdi.
 *
 * Il contratto difeso qui:
 *   - una issue per FILE di test, titolo stabile = prefisso + path del test;
 *   - quella issue si chiude alla prima run in cui QUEL file e` verde, anche se
 *     altri file restano rossi;
 *   - un file tutto `skipped` (dato assente) o assente dal report NON e` verde:
 *     chiuderlo sarebbe il falso verde per assenza di dato;
 *   - la issue di workflow (9453) resta l'indice, il wiring nel workflow fa
 *     girare il reporter sia sul rosso sia sul verde.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  ISSUE_TITLE_PREFIX,
  issueTitleFor,
  fileFromIssueTitle,
  summarizeVitestReport,
  planLiveDataFileIssues,
  buildFailureDescription,
  runLiveDataFileReporter,
} from '../../scripts/ci/report-live-data-test-files.mjs';

const ROOT = '/repo';
const abs = (f: string) => path.join(ROOT, f);

const FILES = [
  'tests/job-locale-consistency.test.ts',
  'tests/build-plugins/pharmacyDirectoryPagesPlugin.test.ts',
  'tests/scripts/prompt-placeholder-guard.test.ts',
  'tests/never-ran.test.ts',
];

function assertion(fullName: string, status: string, failureMessages: string[] = []) {
  return { ancestorTitles: [], fullName, title: fullName, status, failureMessages };
}

// Forma reale del reporter json di vitest 4 (`testResults[].name` assoluto,
// `status` per file, `assertionResults[]` per test).
const REPORT = {
  success: false,
  testResults: [
    {
      name: abs('tests/job-locale-consistency.test.ts'),
      status: 'failed',
      message: '',
      assertionResults: [
        assertion('job locale consistency stays under the mistranslation ratchet', 'failed', [
          '\u001b[31mAssertionError: expected 33.04 to be less than or equal to 33\u001b[39m\n    at tests/job-locale-consistency.test.ts:324:30',
        ]),
        assertion('other check', 'passed'),
      ],
    },
    {
      name: abs('tests/build-plugins/pharmacyDirectoryPagesPlugin.test.ts'),
      status: 'failed',
      message: '',
      assertionResults: [
        assertion('pharmacy matrix exposes 5 swiss cantons', 'failed', [
          'AssertionError: expected [ …(4) ] to have a length of 5 but got 4',
        ]),
      ],
    },
    {
      name: abs('tests/scripts/prompt-placeholder-guard.test.ts'),
      status: 'passed',
      message: '',
      assertionResults: [assertion('0 offender', 'passed')],
    },
    {
      // dato assente: tutto skippato. NON e` un verde.
      name: abs('tests/all-skipped.test.ts'),
      status: 'passed',
      message: '',
      assertionResults: [assertion('needs data/jobs.json', 'skipped')],
    },
  ],
};

describe('titolo stabile per file', () => {
  it('il titolo e` prefisso + path del test, e si inverte', () => {
    const t = issueTitleFor('tests/job-locale-consistency.test.ts');
    expect(t).toBe(`${ISSUE_TITLE_PREFIX}tests/job-locale-consistency.test.ts`);
    expect(fileFromIssueTitle(t)).toBe('tests/job-locale-consistency.test.ts');
    expect(fileFromIssueTitle('Workflow Failure: live-data gates')).toBeNull();
  });

  it('non contiene la misura: il titolo resta uguale fra un rosso e il successivo', () => {
    expect(issueTitleFor('tests/a.test.ts')).not.toMatch(/\d+[,.]\d+%/);
  });
});

describe('summarizeVitestReport', () => {
  it('normalizza i path assoluti e distingue failed / passed / skipped', () => {
    const byFile = summarizeVitestReport(REPORT, { root: ROOT });
    expect(byFile.get('tests/job-locale-consistency.test.ts')?.status).toBe('failed');
    expect(byFile.get('tests/job-locale-consistency.test.ts')?.failures).toHaveLength(1);
    expect(byFile.get('tests/scripts/prompt-placeholder-guard.test.ts')?.status).toBe('passed');
    expect(byFile.get('tests/all-skipped.test.ts')?.status).toBe('skipped');
  });

  it('un file rosso in raccolta (zero test, message presente) e` failed', () => {
    const byFile = summarizeVitestReport({
      testResults: [{ name: abs('tests/x.test.ts'), status: 'failed', message: 'SyntaxError: boom', assertionResults: [] }],
    }, { root: ROOT });
    expect(byFile.get('tests/x.test.ts')?.status).toBe('failed');
    expect(byFile.get('tests/x.test.ts')?.failures[0].message).toContain('SyntaxError: boom');
  });
});

describe('planLiveDataFileIssues', () => {
  const openIssues = [
    { number: 101, title: issueTitleFor('tests/scripts/prompt-placeholder-guard.test.ts') },
    { number: 102, title: issueTitleFor('tests/job-locale-consistency.test.ts') },
    { number: 103, title: issueTitleFor('tests/never-ran.test.ts') },
    { number: 104, title: issueTitleFor('tests/removed-from-inventory.test.ts') },
    { number: 9453, title: 'Workflow Failure: live-data gates' },
  ];
  const plan = planLiveDataFileIssues({
    byFile: summarizeVitestReport(REPORT, { root: ROOT }),
    files: [...FILES, 'tests/all-skipped.test.ts'],
    openIssues,
  });

  it('un report per OGNI file non verde dell\'inventario (rosso, tutto skippato o assente), non uno per workflow', () => {
    expect(plan.report.map((r) => r.file).sort()).toEqual([
      'tests/all-skipped.test.ts',
      'tests/build-plugins/pharmacyDirectoryPagesPlugin.test.ts',
      'tests/job-locale-consistency.test.ts',
      'tests/never-ran.test.ts',
    ]);
    for (const r of plan.report) expect(r.title).toBe(issueTitleFor(r.file));
    const byName = Object.fromEntries(plan.report.map((r) => [r.file, r.result.status]));
    expect(byName['tests/all-skipped.test.ts']).toBe('skipped');
    expect(byName['tests/never-ran.test.ts']).toBe('absent');
  });

  it('il primo skipped o il file assente dal report aprono la loro issue (accettazione della review della PR 11531)', () => {
    for (const byFile of [
      new Map(),
      new Map([['tests/x.test.ts', { status: 'skipped' as const, failures: [] }]]),
    ]) {
      const p = planLiveDataFileIssues({ byFile, files: ['tests/x.test.ts'], openIssues: [] });
      expect(p.report.map((r) => r.file)).toEqual(['tests/x.test.ts']);
    }
  });

  it('chiude la issue di un file verde anche se altri file restano rossi', () => {
    expect(plan.close).toContainEqual(expect.objectContaining({ number: 101, reason: 'completed' }));
  });

  it('non chiude un file rosso, ne` uno senza esito (assente dal report o tutto skippato)', () => {
    const closed = plan.close.map((c) => c.number);
    expect(closed).not.toContain(102);
    expect(closed).not.toContain(103);
    expect(plan.keep).toContainEqual(expect.objectContaining({ number: 103, why: 'no-result' }));
  });

  it('chiude come not_planned il file uscito dal gruppo dati vivi', () => {
    expect(plan.close).toContainEqual(expect.objectContaining({ number: 104, reason: 'not_planned' }));
  });

  it('non tocca la issue indice del workflow', () => {
    expect([...plan.close, ...plan.keep].map((c) => c.number)).not.toContain(9453);
  });

  it('senza inventario non ritira niente: un elenco vuoto non e` una prova', () => {
    const p = planLiveDataFileIssues({
      byFile: summarizeVitestReport(REPORT, { root: ROOT }),
      files: [],
      openIssues,
    });
    expect(p.close.filter((c) => c.reason === 'not_planned')).toEqual([]);
  });
});

describe('buildFailureDescription', () => {
  it('nomina file, test rossi, riproduzione e indice, senza ANSI', () => {
    const byFile = summarizeVitestReport(REPORT, { root: ROOT });
    const body = buildFailureDescription({
      file: 'tests/job-locale-consistency.test.ts',
      result: byFile.get('tests/job-locale-consistency.test.ts')!,
      runUrl: 'https://example.invalid/run/1',
    });
    expect(body).toContain('tests/job-locale-consistency.test.ts');
    expect(body).toContain('expected 33.04 to be less than or equal to 33');
    expect(body).toContain('npx vitest run tests/job-locale-consistency.test.ts');
    expect(body).toContain('Workflow Failure: live-data gates');
    expect(body).toContain('https://example.invalid/run/1');
    expect(body).not.toContain('\u001b[');
  });
});

describe('runLiveDataFileReporter', () => {
  it('apre una issue per file rosso e chiude per numero quella del file verde', async () => {
    const created: string[] = [];
    const resolved: Array<[number, string, string]> = [];
    const res = await runLiveDataFileReporter({
      report: REPORT,
      files: FILES,
      root: ROOT,
      runUrl: 'https://example.invalid/run/1',
      io: {
        listOpenIssues: () => [{ number: 101, title: issueTitleFor('tests/scripts/prompt-placeholder-guard.test.ts') }],
        createIssue: async ({ title, exactTitle }) => {
          expect(exactTitle).toBe(true);
          created.push(title);
          return { number: 1, persisted: true };
        },
        resolveByNumber: (n, { expectedTitle, reason }) => {
          resolved.push([n, expectedTitle, reason]);
          return { number: n, persisted: true };
        },
      },
    });
    expect(created.sort()).toEqual([
      issueTitleFor('tests/build-plugins/pharmacyDirectoryPagesPlugin.test.ts'),
      issueTitleFor('tests/job-locale-consistency.test.ts'),
      issueTitleFor('tests/never-ran.test.ts'),
    ]);
    expect(resolved).toEqual([[101, issueTitleFor('tests/scripts/prompt-placeholder-guard.test.ts'), 'completed']]);
    expect(res.undelivered).toEqual([]);
  });

  it('per un file assente dal report apre la issue e il testo dice che non e` stato raccolto', async () => {
    const created: Array<{ title: string, description: string, cosa: string }> = [];
    await runLiveDataFileReporter({
      report: { testResults: [] },
      files: ['tests/x.test.ts'],
      root: ROOT,
      io: {
        listOpenIssues: () => [],
        createIssue: async ({ title, description, signals }) => {
          created.push({ title, description, cosa: signals.cosa });
          return { number: 2, persisted: true };
        },
        resolveByNumber: () => ({ persisted: true }),
      },
    });
    expect(created.map((c) => c.title)).toEqual([issueTitleFor('tests/x.test.ts')]);
    expect(created[0].description).toContain('non compare nel report di vitest');
    expect(created[0].description).not.toContain('## Test rossi');
    expect(created[0].cosa).toBe('tests/x.test.ts assente dal report di vitest');
  });

  it('un report non consegnato e` contato, non perso in silenzio', async () => {
    const res = await runLiveDataFileReporter({
      report: REPORT,
      files: FILES,
      root: ROOT,
      runUrl: '',
      io: {
        listOpenIssues: () => [],
        createIssue: async () => ({ persisted: false }),
        resolveByNumber: () => null,
      },
    });
    expect(res.undelivered.length).toBe(res.plan.report.length);
  });

  it('se la lista delle issue aperte non si legge, non chiude niente ma riporta comunque i rossi', async () => {
    let resolveCalls = 0;
    const res = await runLiveDataFileReporter({
      report: REPORT,
      files: FILES,
      root: ROOT,
      runUrl: '',
      io: {
        listOpenIssues: () => null,
        createIssue: async () => ({ persisted: true }),
        resolveByNumber: () => { resolveCalls += 1; return null; },
      },
    });
    expect(resolveCalls).toBe(0);
    expect(res.plan.report.length).toBeGreaterThan(0);
  });
});

describe('live-data-gates.yml: il reporter per file e` collegato', () => {
  type Step = { name?: string; id?: string; if?: string; run?: string; env?: Record<string, string> };
  const WORKFLOW = path.resolve(__dirname, '..', '..', '.github', 'workflows', 'live-data-gates.yml');
  const doc = parseYaml(fs.readFileSync(WORKFLOW, 'utf-8')) as { jobs: { 'live-data': { steps: Step[] } } };
  const steps = doc.jobs['live-data'].steps;
  const vitestIdx = steps.findIndex((s) => typeof s.run === 'string' && s.run.includes('npx vitest run'));
  const reporterIdx = steps.findIndex((s) => typeof s.run === 'string' && s.run.includes('scripts/ci/report-live-data-test-files.mjs'));

  it('vitest scrive anche il report json che il reporter legge', () => {
    expect(vitestIdx).toBeGreaterThan(-1);
    expect(steps[vitestIdx].id).toBeTruthy();
    expect(steps[vitestIdx].run).toMatch(/--reporter=json\b/);
    expect(steps[vitestIdx].run).toContain('--outputFile.json=live-data-vitest.json');
    expect(steps[reporterIdx].run).toContain('live-data-vitest.json');
  });

  it('il reporter gira DOPO vitest sia sul rosso sia sul verde (senza success() implicito)', () => {
    expect(reporterIdx).toBeGreaterThan(vitestIdx);
    const cond = String(steps[reporterIdx].if || '');
    expect(cond).toContain('!cancelled()');
    expect(cond).toContain(`steps.${steps[vitestIdx].id}.outcome`);
    expect(cond).toContain("'failure'");
    expect(cond).toContain("'success'");
    expect(steps[reporterIdx].env?.GH_TOKEN).toBeTruthy();
  });

  it('la issue di workflow resta come indice', () => {
    const idx = steps.find((s) => s.name === 'Report failure to GitHub Issues') as Step & { with?: Record<string, string> };
    expect(idx?.with?.title).toBe('Workflow Failure: ${{ github.workflow }}');
  });
});
