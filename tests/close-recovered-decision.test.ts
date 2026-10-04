// @vitest-environment node
/**
 * LC-20 — la decisione di chiusura del closer è UNA funzione pura ed esportata.
 *
 * Prima viveva dentro `main()` di `scripts/ci/close-recovered-failure-issues.mjs`,
 * intrecciata alle chiamate `gh`, e l'unica uscita era il log testuale. Chi voleva lo
 * stesso verdetto (lo sweep dei needs-human) lo ricomponeva in prosa nel prompt, senza
 * scartare le run `skipped`: due oracoli che divergono (issue 9285 classificata «ancora
 * rossa» a ogni giro, con 23 run `skipped` su 60).
 *
 * Se questa suite diventa rossa il titolo del guasto è:
 * «Closer: la decisione di chiusura non è più quella esportata (oracolo duplicato)».
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CHRONIC_LABELS,
  CHRONIC_MARKER,
  CLOSE_ACTIONS,
  RECURRENCE_MARKER,
  classifyDecidingRun,
  decideFailureIssueClose,
  decidingRun,
  verdictRecord,
  verdictsOutPath,
} from '../scripts/ci/close-recovered-failure-issues.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ci', 'close-recovered-failure-issues.mjs');

const NOW = Date.parse('2026-10-03T12:00:00Z');
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const at = (msAgo: number, now = NOW) => new Date(now - msAgo).toISOString();

let nextRunId = 1000;
const runOf = (conclusion: string, msAgo: number, now = NOW) => ({
  databaseId: nextRunId++,
  status: 'completed',
  conclusion,
  createdAt: at(msAgo, now),
});

/** Le soglie di produzione, esplicite: la suite non deve dipendere dall'ambiente. */
const OPTIONS = {
  recurrence: { windowHours: 8, maxRecurrences: 1, minGreenStreak: 3, maxFailureRate: 0.02 },
  chronic: { threshold: 5, windowHours: 168 },
  holdMaxDays: 9,
};

const issueOpened = (msAgo: number, extra: Record<string, unknown> = {}) => ({
  number: 4242,
  title: 'Workflow Failure: Some workflow',
  createdAt: at(msAgo),
  labels: [],
  ...extra,
});

const decide = (input: Record<string, unknown>) => decideFailureIssueClose({ now: NOW, options: OPTIONS, ...input });

const recurrences = (n: number) => Array.from({ length: n }, (_, i) => ({
  body: `${RECURRENCE_MARKER} Recurrence on workflow run.`,
  createdAt: at((i + 1) * 12 * HOUR),
}));
const blockedVerdict = (msAgo: number) => ({
  body: 'Root cause trovata, fix scritta.\n\n<!-- FIX_OUTCOME: blocked-workflows-scope -->',
  createdAt: at(msAgo),
});

describe('decideFailureIssueClose — i sette rami', () => {
  it('verde successivo all\'apertura, nessun hold → close', () => {
    const green = runOf('success', 1 * HOUR);
    const verdict = decide({ issue: issueOpened(2 * HOUR), history: [green], comments: [] });
    expect(verdict.action).toBe('close');
    expect(verdict.runId).toBe(green.databaseId);
    expect(verdict.reason).toContain(`run ${green.databaseId} success`);
  });

  it('verde PRECEDENTE all\'apertura → keep (incidente 9321)', () => {
    const verdict = decide({ issue: issueOpened(2 * HOUR), history: [runOf('success', 3 * HOUR)], comments: null });
    expect(verdict.action).toBe('keep');
    expect(verdict.reason).toBe('green-predates-issue');
  });

  it('ultima run rossa → keep', () => {
    const history = [runOf('failure', 1 * HOUR), runOf('success', 90 * 60 * 1000)];
    const verdict = decide({ issue: issueOpened(2 * HOUR), history, comments: null });
    expect(verdict.action).toBe('keep');
    expect(verdict.reason).toBe('still-red');
    expect(verdict.runId).toBe(history[0].databaseId);
  });

  it('nessuna run risolvibile → keep, run-not-resolvable', () => {
    for (const history of [null, [], [runOf('skipped', HOUR)]]) {
      const verdict = decide({ issue: issueOpened(2 * HOUR), history, comments: null });
      expect(verdict).toMatchObject({ action: 'keep', reason: 'run-not-resolvable', runId: null });
    }
  });

  it('storia [skipped, skipped, success] → decide la success: le skipped non contano', () => {
    const green = runOf('success', 1 * HOUR);
    const history = [runOf('skipped', 5 * 60 * 1000), runOf('skipped', 10 * 60 * 1000), green];
    expect(decidingRun({ history })).toBe(green);
    const verdict = decide({ issue: issueOpened(2 * HOUR), history, comments: [] });
    expect(verdict.action).toBe('close');
    expect(verdict.runId).toBe(green.databaseId);
  });

  it('storia [skipped, skipped, failure] → resta rossa: una skipped non è un recupero', () => {
    const history = [runOf('skipped', 5 * 60 * 1000), runOf('skipped', 10 * 60 * 1000), runOf('failure', HOUR)];
    expect(decide({ issue: issueOpened(2 * HOUR), history, comments: null }).reason).toBe('still-red');
  });

  it('cinque 🔁 in 168 ore → chronic-escalate la prima volta, chronic-hold dopo', () => {
    const base = { issue: issueOpened(6 * DAY), history: [runOf('success', HOUR)] };
    const first = decide({ ...base, comments: recurrences(5) });
    expect(first.action).toBe('chronic-escalate');
    const later = decide({ ...base, comments: [...recurrences(5), { body: CHRONIC_MARKER, createdAt: at(HOUR) }] });
    expect(later.action).toBe('chronic-hold');
    expect(later.reason).toMatch(/CRONICA/);
    // Quattro non bastano: la soglia è quella dichiarata, non «qualche ricorrenza».
    expect(decide({ ...base, comments: recurrences(4) }).action).toBe('close');
  });

  it('il gate cronico ha precedenza sul TTL dello hold strutturale', () => {
    // Verdetto `blocked-*` vecchio di 30 giorni: da solo il TTL (9 giorni) lo rilascia e
    // la issue si chiuderebbe. Con cinque ricorrenze recenti NON deve chiudersi.
    const issue = issueOpened(30 * DAY);
    const history = [runOf('success', HOUR)];
    const stale = blockedVerdict(30 * DAY);
    expect(decide({ issue, history, comments: [stale] }).action).toBe('close');
    const verdict = decide({ issue, history, comments: [stale, ...recurrences(5), { body: CHRONIC_MARKER, createdAt: at(HOUR) }] });
    expect(verdict.action).toBe('chronic-hold');
    expect(verdict.structural).toBeUndefined();
  });

  it('FIX_OUTCOME strutturale non scaduto → structural-hold', () => {
    const verdict = decide({
      issue: issueOpened(3 * HOUR),
      history: [runOf('success', HOUR)],
      comments: [blockedVerdict(2 * HOUR)],
    });
    expect(verdict.action).toBe('structural-hold');
    expect(verdict.structural.code).toBe('blocked-workflows-scope');
  });

  it('commenti illeggibili nel ramo verde → structural-hold, mai close', () => {
    const verdict = decide({ issue: issueOpened(3 * HOUR), history: [runOf('success', HOUR)], comments: null });
    expect(verdict.action).toBe('structural-hold');
  });

  it('due rossi nella finestra di ricorrenza → recurrence-hold, prima dello hold strutturale', () => {
    const history = [runOf('success', 10 * 60 * 1000), runOf('failure', HOUR), runOf('failure', 2 * HOUR)];
    const verdict = decide({ issue: issueOpened(3 * HOUR), history, comments: [blockedVerdict(2 * HOUR)] });
    expect(verdict.action).toBe('recurrence-hold');
    expect(verdict.reason).toMatch(/RICORRE/);
    expect(verdict.structural).toBeUndefined();
  });

  it('percorso crawler: run esplicita, nessuno storico → il gate di ricorrenza è un no-op', () => {
    const run = { ...runOf('success', HOUR), repository: 'owner/corpus' };
    const verdict = decide({ issue: issueOpened(2 * HOUR), run, history: null, comments: [] });
    expect(verdict.action).toBe('close');
    expect(verdict.recurrence.measured).toBe(false);
    expect(verdictRecord({ number: 7, title: 'Crawler Failure: Run acme' }, verdict, 'owner/site')).toEqual({
      number: 7,
      title: 'Crawler Failure: Run acme',
      action: 'close',
      reason: verdict.reason,
      runId: run.databaseId,
      runRepo: 'owner/corpus',
    });
  });

  it('la de-escalation accompagna il verdetto senza sostituirlo', () => {
    const verdict = decide({
      issue: issueOpened(2 * HOUR, { labels: ['bug', ...CHRONIC_LABELS] }),
      history: [runOf('success', HOUR)],
      comments: [{ body: CHRONIC_MARKER, createdAt: at(90 * 60 * 1000) }],
    });
    expect(verdict.action).toBe('close');
    expect(verdict.deescalation.clear).toBe(true);
    expect(verdict.deescalation.labels).toEqual([...CHRONIC_LABELS]);
  });
});

describe('invariante 9321 — nessuna chiusura senza una run verde successiva all\'apertura', () => {
  it('su ogni combinazione di storia e commenti, `close` implica verde e successiva', () => {
    const conclusions = ['success', 'failure', 'cancelled', 'skipped', 'timed_out'];
    const offsets = [-3 * HOUR, -30 * 60 * 1000, 30 * 60 * 1000, 3 * HOUR]; // rispetto all'apertura
    const commentSets = [[], null, recurrences(5), [blockedVerdict(HOUR)]];
    const opened = 4 * HOUR;
    let closes = 0;
    for (const head of conclusions) {
      for (const tail of conclusions) {
        for (const headOffset of offsets) {
          for (const comments of commentSets) {
            const history = [
              runOf(head, opened - headOffset),
              runOf(tail, opened - headOffset + 20 * 60 * 1000),
            ];
            const issue = issueOpened(opened);
            const verdict = decide({ issue, history, comments });
            expect(CLOSE_ACTIONS).toContain(verdict.action);
            if (verdict.action !== 'close') continue;
            closes++;
            const deciding = history.find((r) => r.databaseId === verdict.runId);
            expect(deciding?.conclusion).toBe('success');
            expect(Date.parse(deciding!.createdAt)).toBeGreaterThanOrEqual(Date.parse(issue.createdAt));
            expect(classifyDecidingRun({ issue, run: deciding })).toBe('recovered');
          }
        }
      }
    }
    expect(closes).toBeGreaterThan(0);
  });
});

describe('--verdicts-out', () => {
  it('legge il percorso nelle due forme e rifiuta l\'opzione senza valore', () => {
    expect(verdictsOutPath(['--dry-run'])).toBeNull();
    expect(verdictsOutPath(['--dry-run', '--verdicts-out', 'out/v.json'])).toBe('out/v.json');
    expect(verdictsOutPath(['--verdicts-out=out/v.json'])).toBe('out/v.json');
    expect(() => verdictsOutPath(['--verdicts-out'])).toThrow(/percorso/);
    expect(() => verdictsOutPath(['--verdicts-out', '--dry-run'])).toThrow(/percorso/);
    expect(() => verdictsOutPath(['--verdicts-out='])).toThrow(/percorso/);
  });
});

describe('main() usa la decisione esportata, e solo quella', () => {
  const SRC = fs.readFileSync(SCRIPT, 'utf8');
  const mainBody = SRC.slice(SRC.indexOf('function main()'));

  it('main() chiama decideFailureIssueClose e non ricompone i gate per conto suo', () => {
    expect(mainBody).toContain('decideFailureIssueClose(');
    for (const gate of ['decideChronicEscalation(', 'decideChronicDeescalation(', 'decideRecurrenceHold(', 'decideStructuralHold(']) {
      expect(mainBody, `main() richiama ${gate} direttamente: l'oracolo è di nuovo duplicato`).not.toContain(gate);
    }
  });

  // La passata vera, con un `gh` finto sul PATH: il file dei verdetti deve avere una voce
  // per ogni issue elencata, anche in `--dry-run`, e la passata non deve scrivere niente.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lc20-closer-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('scrive una voce per ogni issue esaminata, anche in --dry-run, senza mutare', () => {
    const now = Date.now();
    const liveRun = (id: number, conclusion: string, msAgo: number) => ({
      databaseId: id, status: 'completed', conclusion, createdAt: at(msAgo, now), headBranch: 'main',
    });
    const failureIssues = [
      { number: 1, title: 'Workflow Failure: LC20 Recovered', runs: [liveRun(11, 'success', HOUR)], action: 'close', reason: /^recovered \(run 11 / },
      { number: 2, title: 'CI Failure: LC20 Red', runs: [liveRun(21, 'failure', HOUR)], action: 'keep', reason: /^still-red$/ },
      { number: 3, title: 'Workflow Failure: LC20 Gone', runs: [], action: 'keep', reason: /^run-not-resolvable$/ },
      {
        number: 4,
        title: 'Workflow Failure: LC20 Skipped',
        runs: [liveRun(41, 'skipped', 5 * 60 * 1000), liveRun(42, 'skipped', 10 * 60 * 1000), liveRun(43, 'success', HOUR)],
        action: 'close',
        reason: /^recovered \(run 43 /,
      },
    ];
    const fixture = {
      issues: [
        ...failureIssues.map((i) => ({ number: i.number, title: i.title, createdAt: at(2 * HOUR, now), labels: [] })),
        { number: 99, title: 'Una issue qualsiasi', createdAt: at(2 * HOUR, now), labels: [] },
      ],
      runs: Object.fromEntries(failureIssues.map((i) => [i.title.replace(/^[^:]+: /, ''), i.runs])),
    };
    const fixturePath = path.join(tmp, 'fixture.json');
    const callsPath = path.join(tmp, 'calls.log');
    fs.writeFileSync(fixturePath, JSON.stringify(fixture));
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'gh'), [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      "fs.appendFileSync(process.env.LC20_CALLS, args.join(' ') + '\\n');",
      "const fixture = JSON.parse(fs.readFileSync(process.env.LC20_FIXTURE, 'utf8'));",
      "const key = args.slice(0, 2).join(' ');",
      "if (key === 'issue list') process.stdout.write(JSON.stringify(fixture.issues));",
      "else if (key === 'run list') process.stdout.write(JSON.stringify(fixture.runs[args[args.indexOf('-w') + 1]] || []));",
      "else if (args[0] === 'api' && /\\/comments$/.test(args[1])) process.stdout.write('[]');",
      'else process.exit(1);',
      '',
    ].join('\n'), { mode: 0o755 });

    const out = path.join(tmp, 'nested', 'verdicts.json');
    fs.mkdirSync(path.dirname(out));
    fs.writeFileSync(out, '"stale"');
    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      GH_REPO: 'owner/site',
      LC20_FIXTURE: fixturePath,
      LC20_CALLS: callsPath,
    };
    for (const name of Object.keys(env)) {
      if (name.startsWith('CLOSE_RECOVERED_') || name.startsWith('CRAWLER_RUN_') || name === 'GITHUB_PAT_NANAKO') delete env[name];
    }
    const result = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--verdicts-out', out], { env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);

    const verdicts = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(verdicts.map((v: { number: number }) => v.number)).toEqual(failureIssues.map((i) => i.number));
    for (const expected of failureIssues) {
      const verdict = verdicts.find((v: { number: number }) => v.number === expected.number);
      expect(Object.keys(verdict).sort()).toEqual(['action', 'number', 'reason', 'runId', 'runRepo', 'title']);
      expect(verdict.title).toBe(expected.title);
      expect(verdict.action, expected.title).toBe(expected.action);
      expect(verdict.reason).toMatch(expected.reason);
      expect(verdict.runRepo).toBe(verdict.runId === null ? null : 'owner/site');
    }
    // Il log testuale resta quello di prima: verdetto e riga dicono la stessa cosa.
    expect(result.stdout).toContain('#1 WOULD CLOSE — recovered (run 11 success');
    expect(result.stdout).toContain('#2 still red (latest completed run 21=failure) — keep open');
    expect(result.stdout).toContain('#3 "LC20 Gone" — no completed run on main (renamed/deleted?), keep open');
    expect(result.stdout).toContain('#4 WOULD CLOSE — recovered (run 43 success');

    const calls = fs.readFileSync(callsPath, 'utf8').trim().split('\n');
    expect(calls.filter((c) => /^issue (edit|close|comment|reopen)|^label /.test(c))).toEqual([]);
    // I commenti si leggono solo per le issue in chiusura: una chiamata per `close`.
    const commentReads = calls.filter((c) => /\/comments /.test(`${c} `)).map((c) => Number(/issues\/(\d+)\/comments/.exec(c)?.[1]));
    expect(commentReads.sort()).toEqual(failureIssues.filter((i) => i.action === 'close').map((i) => i.number).sort());
  });

  // LC-03 attraverso main(): la run che decide è sempre passata, calcolata dallo storico.
  // Con una verde precedente all'apertura in fondo allo storico, il thread `CI Failure:`
  // del monitor rosso per il solo verdetto si chiude `not planned`; il gemello
  // `Workflow Failure:` sullo stesso storico resta aperto. Job REALI della run 37121059160.
  it('LC-03: il thread di solo verdetto del monitor si chiude `not planned` passando da main()', () => {
    const now = Date.now();
    const verdictJobs = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'tests', 'fixtures', 'verdict-step-registry', 'run-37121059160-jobs.json'), 'utf8',
    ));
    const liveRun = (id: number, conclusion: string, msAgo: number) => ({
      databaseId: id, status: 'completed', conclusion, createdAt: at(msAgo, now), headBranch: 'main',
    });
    const fixture = {
      issues: [
        { number: 9243, title: 'CI Failure: crawler-health-monitor', createdAt: at(2 * HOUR, now), labels: [] },
        { number: 9244, title: 'Workflow Failure: crawler-health-monitor', createdAt: at(2 * HOUR, now), labels: [] },
      ],
      runs: {
        'crawler-health-monitor': [
          liveRun(701, 'failure', 10 * 60 * 1000),
          liveRun(702, 'failure', 40 * 60 * 1000),
          liveRun(700, 'success', 3 * HOUR),
        ],
      },
      jobs: { 701: verdictJobs, 702: verdictJobs },
    };
    const dir = fs.mkdtempSync(path.join(tmp, 'lc03-'));
    const fixturePath = path.join(dir, 'fixture.json');
    const callsPath = path.join(dir, 'calls.log');
    fs.writeFileSync(fixturePath, JSON.stringify(fixture));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'gh'), [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      "fs.appendFileSync(process.env.LC20_CALLS, args.join(' ') + '\\n');",
      "const fixture = JSON.parse(fs.readFileSync(process.env.LC20_FIXTURE, 'utf8'));",
      "const key = args.slice(0, 2).join(' ');",
      'const jobs = args[0] === \'api\' ? /\\/actions\\/runs\\/(\\d+)\\/jobs/.exec(args[1]) : null;',
      "if (key === 'issue list') process.stdout.write(JSON.stringify(fixture.issues));",
      "else if (key === 'run list') process.stdout.write(JSON.stringify(fixture.runs[args[args.indexOf('-w') + 1]] || []));",
      'else if (jobs && fixture.jobs[jobs[1]]) process.stdout.write(JSON.stringify(fixture.jobs[jobs[1]]));',
      "else if (key === 'issue close') process.stdout.write('');",
      // Il `gh` che esce 0 senza chiudere: la post-condizione deve accorgersene.
      "else if (key === 'issue view') process.stdout.write(JSON.stringify({ state: 'OPEN' }));",
      'else process.exit(1);',
      '',
    ].join('\n'), { mode: 0o755 });

    const baseEnv: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      GH_REPO: 'owner/site',
      LC20_FIXTURE: fixturePath,
      LC20_CALLS: callsPath,
    };
    for (const name of Object.keys(baseEnv)) {
      if (name.startsWith('CLOSE_RECOVERED_') || name.startsWith('CRAWLER_RUN_') || name === 'GITHUB_PAT_NANAKO' || name === 'ENABLE_FAILURE_REPORT') delete baseEnv[name];
    }
    const runPass = (args: string[], env: Record<string, string | undefined> = {}) => {
      fs.rmSync(callsPath, { force: true });
      const out = path.join(dir, `verdicts-${args.join('')}-${Object.keys(env).join('')}.json`);
      const result = spawnSync(process.execPath, [SCRIPT, ...args, '--verdicts-out', out], {
        env: { ...baseEnv, ...env }, encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      return {
        result,
        verdicts: JSON.parse(fs.readFileSync(out, 'utf8')),
        calls: fs.readFileSync(callsPath, 'utf8').trim().split('\n'),
      };
    };

    const dry = runPass(['--dry-run']);
    const byNumber = Object.fromEntries(dry.verdicts.map((v: { number: number }) => [v.number, v]));
    expect(byNumber[9243].action).toBe('close-not-planned');
    expect(byNumber[9243].reason).toBe('verdict-only-thread');
    expect(byNumber[9243].runId).toBe(701);
    expect(byNumber[9244].action).toBe('keep');
    expect(byNumber[9244].reason).toBe('green-predates-issue');
    expect(dry.result.stdout).toContain('#9243 WOULD CLOSE (not planned)');
    expect(dry.calls.filter((c) => /^issue (edit|close|comment|reopen)|^label /.test(c))).toEqual([]);
    // Memo per passata: due issue sullo stesso storico, una lettura dei job per run.
    const jobReads = dry.calls.filter((c) => /\/actions\/runs\/\d+\/jobs/.test(c));
    expect(jobReads.length).toBe(new Set(jobReads).size);

    // Interruttore ENABLE_FAILURE_REPORT=false: nessuna chiusura, come sugli altri rami.
    const off = runPass([], { ENABLE_FAILURE_REPORT: 'false' });
    expect(off.calls.filter((c) => /^issue close/.test(c))).toEqual([]);

    // `gh issue close` esce 0 ma la issue resta OPEN: non è contata come chiusa.
    const unconfirmed = runPass([]);
    expect(unconfirmed.calls.some((c) => /^issue close 9243 --reason not planned/.test(c))).toBe(true);
    expect(unconfirmed.result.stderr).toContain('#9243 close (not planned) not confirmed');
  });
});
