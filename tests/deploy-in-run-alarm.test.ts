/**
 * Le due reti dell'allarme di deploy DENTRO `deploy.yml`, e la chiusura a run
 * tutta verde.
 *
 * ─── I due guasti del 24-25/09 che questo file rende impossibili ─────────
 *
 * 1. La run 36065965021 (2026-09-24, `workflow_dispatch` del job `rearm` col
 *    GITHUB_TOKEN, actor `github-actions[bot]`) è fallita nel leg it e
 *    l'osservatore esterno (`deploy-failure-alarm.yml`) non è mai partito:
 *    GitHub non emette `workflow_run` per le run avviate da quel token. Il job
 *    `in-run-alarm` è la rete per quelle run, e SOLO per quelle: le altre le
 *    vede l'osservatore esterno, a run conclusa.
 * 2. La run 36077807468 (push) è fallita nel leg it, e una gamba verde della
 *    stessa run ha chiuso #9179 «tornata verde» alle 04:53: lo step di chiusura
 *    stava in ogni gamba e vedeva solo la propria. Ora la chiusura è il job
 *    `resolve-build-alarm`, che guarda l'esito AGGREGATO della matrice.
 *
 * ─── Perché le condizioni si VALUTANO invece di confrontarle col testo ───
 *
 * Una condizione `if:` scritta giusta a occhio è la forma di guasto che ha
 * lasciato il deploy rosso per 10 ore il 19/09. Qui sotto un valutatore minimo
 * delle espressioni di GitHub Actions (il sottoinsieme che questi `if:` usano,
 * con le sue due regole non ovvie: il `success() &&` implicito quando manca una
 * funzione di stato, e il confronto di stringhe case-insensitive) le fa girare
 * sugli esiti REALI delle due run, salvati in
 * `tests/fixtures/deploy-in-run-alarm/`.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import {
  consecutiveFailureStreak,
  buildAlarmDescription,
  firstFailure,
} from '../scripts/ci/report-deploy-run-failure.mjs';
import { parseWorkflow, coverageOf, isFailureGated } from '../scripts/ci/failure-issue-inventory.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEPLOY_RAW = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
const DEPLOY = parse(DEPLOY_RAW) as any;
const ALARM_RAW = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy-failure-alarm.yml'), 'utf8');
const ALARM = parse(ALARM_RAW) as any;
const FIXTURES = path.join(ROOT, 'tests/fixtures/deploy-in-run-alarm');
const readFixture = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
const RUN_LIST = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'tests/fixtures/deploy-failure-alarm/run-list-2026-09-19-incident.json'), 'utf8',
));

/** La run del bot che nessuno ha visto (24/09). */
const BOT_RUN = readFixture('run-36065965021.json');
/** La run di push la cui gamba verde ha chiuso l'allarme della gamba rossa (25/09). */
const PUSH_RUN = readFixture('run-36077807468.json');

const IN_RUN = DEPLOY.jobs['in-run-alarm'];
const RESOLVE = DEPLOY.jobs['resolve-build-alarm'];
const WORKFLOW_NAME = DEPLOY.name as string;

/* ── valutatore minimo delle espressioni GitHub Actions ─────────────────── */

/**
 * `__level` decide cosa guardano le funzioni di stato. In un `if:` di JOB
 * guardano i job di `needs`; in un `if:` di STEP guardano solo gli step
 * precedenti dello stesso job — per questo in un job partito dopo un rosso gli
 * step senza condizione (checkout, setup) girano normalmente.
 */
type Ctx = Record<string, any> & {
  __cancelled?: boolean;
  __needs?: Record<string, { result: string }>;
  __level?: 'job' | 'step';
  __stepFailed?: boolean;
};

function tokenize(src: string): string[] {
  const re = /\s*(\|\||&&|==|!=|!|\(|\)|,|'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_-]*(?:\.(?:[A-Za-z_][A-Za-z0-9_-]*|\*))*)/y;
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new Error(`token illeggibile a ${i}: ${src.slice(i, i + 20)}`);
    out.push(m[1]);
    i = re.lastIndex;
  }
  return out;
}

function lookup(ctx: Ctx, pathExpr: string): unknown {
  let cur: unknown[] = [ctx];
  let wildcard = false;
  for (const seg of pathExpr.split('.')) {
    if (seg === '*') {
      wildcard = true;
      cur = cur.flatMap((v) => (v && typeof v === 'object' ? Object.values(v as object) : []));
    } else {
      cur = cur.map((v) => (v && typeof v === 'object' ? (v as any)[seg] : undefined));
    }
  }
  return wildcard ? cur : cur[0];
}

const eq = (a: unknown, b: unknown) => (typeof a === 'string' && typeof b === 'string'
  ? a.toLowerCase() === b.toLowerCase()
  : a === b);

function evaluate(src: string, ctx: Ctx): unknown {
  const t = tokenize(src);
  let p = 0;
  const peek = () => t[p];
  const take = (want?: string) => {
    const v = t[p++];
    if (want && v !== want) throw new Error(`atteso ${want}, trovato ${v}`);
    return v;
  };
  const truthy = (v: unknown) => !(v === false || v === null || v === undefined || v === '' || v === 0);
  const needs = () => Object.values(ctx.__needs ?? {});
  const stepLevel = ctx.__level === 'step';
  const call = (name: string, args: unknown[]): unknown => {
    switch (name) {
      case 'always': return true;
      case 'cancelled': return Boolean(ctx.__cancelled);
      case 'success': return !ctx.__cancelled && (stepLevel
        ? !ctx.__stepFailed
        : needs().every((n) => n.result === 'success'));
      case 'failure': return stepLevel
        ? Boolean(ctx.__stepFailed)
        : needs().some((n) => n.result === 'failure');
      case 'contains': {
        const [hay, needle] = args;
        if (Array.isArray(hay)) return hay.some((h) => eq(h, needle));
        return String(hay ?? '').toLowerCase().includes(String(needle ?? '').toLowerCase());
      }
      default: throw new Error(`funzione non supportata: ${name}`);
    }
  };
  const primary = (): unknown => {
    const tok = take();
    if (tok === '(') { const v = or(); take(')'); return v; }
    if (tok.startsWith("'")) return tok.slice(1, -1).replace(/''/g, "'");
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    if (peek() === '(') {
      take('(');
      const args: unknown[] = [];
      while (peek() !== ')') { args.push(or()); if (peek() === ',') take(','); }
      take(')');
      return call(tok, args);
    }
    return lookup(ctx, tok);
  };
  const cmp = (): unknown => {
    const left = primary();
    if (peek() === '==') { take(); return eq(left, primary()); }
    if (peek() === '!=') { take(); return !eq(left, primary()); }
    return left;
  };
  const unary = (): unknown => (peek() === '!' ? (take(), !truthy(unary())) : cmp());
  const and = (): unknown => { let v = unary(); while (peek() === '&&') { take(); const r = unary(); v = truthy(v) ? r : v; } return v; };
  const or = (): unknown => { let v = and(); while (peek() === '||') { take(); const r = and(); v = truthy(v) ? v : r; } return v; };
  const v = or();
  if (p !== t.length) throw new Error(`token in avanzo: ${t.slice(p).join(' ')}`);
  return truthy(v);
}

/** Come GitHub valuta un `if:`: senza funzione di stato vale `success() && (…)`. */
function evalIf(raw: unknown, ctx: Ctx): boolean {
  if (raw === undefined) return evaluate('success()', ctx) as boolean;
  let src = String(raw).trim();
  const wrapped = src.match(/^\$\{\{([\s\S]*)\}\}$/);
  if (wrapped) src = wrapped[1].trim();
  if (!/\b(?:success|failure|cancelled|always)\(\)/.test(src)) src = `success() && (${src})`;
  return evaluate(src, ctx) as boolean;
}

/** L'esito aggregato di una matrice come lo espone `needs.<job>.result`. */
function matrixResult(legs: string[]): string {
  if (legs.some((l) => l === 'failure')) return 'failure';
  if (legs.some((l) => l === 'cancelled')) return 'cancelled';
  if (legs.length && legs.every((l) => l === 'success')) return 'success';
  return 'skipped';
}

const JOB_ID_BY_NAME: Record<string, string> = {
  'validate production promotion trigger': 'validate-promotion-trigger',
  'matrix-setup': 'matrix-setup',
  prep: 'prep',
};

/** `needs.*` di `in-run-alarm` ricostruito dalla Jobs API di una run reale. */
function needsFromRun(run: { jobs: Array<{ name: string; conclusion: string }> }) {
  const needs: Record<string, { result: string }> = {};
  const legs: string[] = [];
  for (const job of run.jobs) {
    if (job.name.startsWith('build-locale (')) legs.push(job.conclusion);
    else if (JOB_ID_BY_NAME[job.name]) needs[JOB_ID_BY_NAME[job.name]] = { result: job.conclusion };
  }
  needs['build-locale'] = { result: matrixResult(legs) };
  return needs;
}

function runCtx(run: any, over: Partial<Ctx> = {}): Ctx {
  const needs = needsFromRun(run);
  return {
    github: {
      ref: `refs/heads/${run.headBranch}`,
      actor: run.actor,
      triggering_actor: run.triggering_actor,
      event_name: run.event,
    },
    needs,
    __needs: needs,
    __cancelled: false,
    ...over,
  };
}

const allGreen = () => ({
  'validate-promotion-trigger': { result: 'success' },
  'matrix-setup': { result: 'success' },
  prep: { result: 'success' },
  'build-locale': { result: 'success' },
});

function botCtx(needs: Record<string, { result: string }>, over: Partial<Ctx> = {}): Ctx {
  return {
    github: { ref: 'refs/heads/main', actor: 'github-actions[bot]', triggering_actor: 'github-actions[bot]' },
    needs,
    __needs: needs,
    __cancelled: false,
    ...over,
  };
}

/* ── il valutatore stesso, prima di fidarsene ───────────────────────────── */

describe('il valutatore di espressioni rispetta le due regole non ovvie di GitHub', () => {
  it('senza funzione di stato aggiunge `success() &&`: un job dopo un rosso non parte', () => {
    const needs = { a: { result: 'failure' } };
    expect(evalIf("needs.a.result == 'failure'", { needs, __needs: needs })).toBe(false);
    expect(evalIf("!cancelled() && needs.a.result == 'failure'", { needs, __needs: needs })).toBe(true);
  });

  it('in uno STEP il `success()` implicito guarda gli step precedenti, non `needs`', () => {
    const needs = { a: { result: 'failure' } };
    const step = { needs, __needs: needs, __level: 'step' as const };
    expect(evalIf("needs.a.result == 'failure'", step)).toBe(true);
    expect(evalIf("needs.a.result == 'failure'", { ...step, __stepFailed: true })).toBe(false);
  });

  it('confronta le stringhe senza distinguere maiuscole, e `contains` scandisce `needs.*.result`', () => {
    const needs = { a: { result: 'success' }, b: { result: 'failure' } };
    const ctx = { github: { actor: 'GitHub-Actions[bot]' }, needs, __needs: needs };
    expect(evalIf("always() && github.actor == 'github-actions[bot]'", ctx)).toBe(true);
    expect(evalIf("always() && contains(needs.*.result, 'failure')", ctx)).toBe(true);
    expect(evalIf("always() && contains(needs.*.result, 'cancelled')", ctx)).toBe(false);
  });
});

/* ── in-run-alarm ───────────────────────────────────────────────────────── */

describe('in-run-alarm — suona dove l osservatore esterno è cieco, e solo lì', () => {
  it('replay run 36065965021: run del bot, leg it rosso → suona', () => {
    expect(BOT_RUN.actor).toBe('github-actions[bot]');
    expect(BOT_RUN.event).toBe('workflow_dispatch');
    expect(evalIf(IN_RUN.if, runCtx(BOT_RUN))).toBe(true);
  });

  it('replay run 36077807468: run di push rossa → tace, e l osservatore esterno suona', () => {
    // Ogni run rossa è vista da UN osservatore: questa emette `workflow_run`,
    // quindi è dell'osservatore esterno. Accendere anche la rete interna
    // aggiungerebbe solo un secondo commento 🔁 sulla stessa issue.
    expect(evalIf(IN_RUN.if, runCtx(PUSH_RUN))).toBe(false);
    const externalCtx = {
      github: { event_name: 'workflow_run', event: { workflow_run: { conclusion: PUSH_RUN.conclusion } } },
    };
    expect(evalIf(ALARM.jobs.alarm.if, externalCtx)).toBe(true);
  });

  it('una run del bot tutta verde non suona', () => {
    expect(evalIf(IN_RUN.if, botCtx(allGreen()))).toBe(false);
  });

  it('un guasto a monte del build suona anche se i job a valle sono `skipped`', () => {
    // È la forma del guasto del 19/09: il rosso prima del build, tutto il resto
    // saltato. Uno step dentro `build-locale` non l'avrebbe mai visto.
    const needs = {
      'validate-promotion-trigger': { result: 'failure' },
      'matrix-setup': { result: 'skipped' },
      prep: { result: 'skipped' },
      'build-locale': { result: 'skipped' },
    };
    expect(evalIf(IN_RUN.if, botCtx(needs))).toBe(true);
  });

  it('una run cancellata non suona, nemmeno se una gamba era già rossa', () => {
    const cancelledLegs = { ...allGreen(), 'build-locale': { result: 'cancelled' } };
    expect(evalIf(IN_RUN.if, botCtx(cancelledLegs))).toBe(false);
    const redThenCancelled = { ...allGreen(), 'build-locale': { result: 'failure' } };
    expect(evalIf(IN_RUN.if, botCtx(redThenCancelled, { __cancelled: true }))).toBe(false);
  });

  it('fuori da `main` non suona', () => {
    const needs = { ...allGreen(), 'build-locale': { result: 'failure' } };
    const ctx = botCtx(needs);
    ctx.github.ref = 'refs/heads/feature';
    expect(evalIf(IN_RUN.if, ctx)).toBe(false);
  });

  it('un re-run lanciato dal bot su una run umana suona (`triggering_actor`)', () => {
    const needs = { ...allGreen(), 'build-locale': { result: 'failure' } };
    const ctx = botCtx(needs);
    ctx.github.actor = 'valerielinc-ops';
    expect(evalIf(IN_RUN.if, ctx)).toBe(true);
    ctx.github.triggering_actor = 'valerielinc-ops';
    expect(evalIf(IN_RUN.if, ctx)).toBe(false);
  });

  it('lo step che apre la issue parte su ogni job di `needs` rosso, uno per uno', () => {
    const opener = IN_RUN.steps.find((s: any) => s.name === 'Open or update the deploy alarm issue');
    expect(opener).toBeDefined();
    for (const job of IN_RUN.needs as string[]) {
      const needs = { ...allGreen(), [job]: { result: 'failure' } };
      // Il job parte (il suo `if:` è vero) e lo step deve partire con lui.
      expect(evalIf(IN_RUN.if, botCtx(needs)), `${job} rosso deve far partire il job`).toBe(true);
      expect(evalIf(opener.if, botCtx(needs, { __level: 'step' })), `${job} rosso deve aprire la issue`).toBe(true);
      expect(String(opener.if)).toContain(`needs.${job}.result == 'failure'`);
    }
    // E su una run del bot verde non apre niente anche se lo step venisse valutato.
    expect(evalIf(opener.if, botCtx(allGreen(), { __level: 'step' }))).toBe(false);
  });

  it('il digest non può saltare l apertura: se crasha, l allarme parte col testo di ripiego', () => {
    const digest = IN_RUN.steps.find((s: any) => s.id === 'digest');
    expect(digest['continue-on-error']).toBe(true);
    expect(digest.env.ALARM_OBSERVER).toBe('in-run');
    // La run è ancora in corso: la conclusion la prova l'`if:` del job.
    expect(digest.env.ALARM_RUN_CONCLUSION).toBe('failure');
    const opener = IN_RUN.steps.find((s: any) => s.name === 'Open or update the deploy alarm issue');
    expect(opener.run).toContain("if [ ! -s alarm-description.md ]; then");
  });

  it('non è un gate: il suo esito non conta per la run, e nessun job lo aspetta', () => {
    expect(IN_RUN['continue-on-error']).toBe(true);
    for (const [id, job] of Object.entries(DEPLOY.jobs) as Array<[string, any]>) {
      const needs = ([] as string[]).concat(job.needs ?? []);
      expect(needs, `${id} non deve aspettare l allarme`).not.toContain('in-run-alarm');
      expect(needs, `${id} non deve aspettare la chiusura`).not.toContain('resolve-build-alarm');
    }
    expect(IN_RUN.permissions).toEqual({ contents: 'read', issues: 'write', actions: 'read' });
  });
});

describe('in-run-alarm — lo STESSO titolo dell osservatore esterno', () => {
  const record = parseWorkflow(DEPLOY_RAW, 'deploy.yml');
  const external = parseWorkflow(ALARM_RAW, 'deploy-failure-alarm.yml');
  const EXTERNAL_TITLE = `Workflow Failure: ${WORKFLOW_NAME}`;

  it('apre esattamente il titolo che apre e chiude l osservatore esterno', () => {
    expect(external.openers.map((o: { title: string }) => o.title)).toContain(EXTERNAL_TITLE);
    expect(external.closers.map((c: { title: string }) => c.title)).toContain(EXTERNAL_TITLE);
    // Due scrittori — lo step principale e il ripiego senza checkout — e un
    // solo titolo: quello dell'osservatore esterno.
    const inRun = record.openers.filter((o: { title: string }) => o.title.startsWith('Workflow Failure:'));
    expect(inRun.map((o: { title: string }) => o.title)).toEqual([EXTERNAL_TITLE, EXTERNAL_TITLE]);
  });

  it('ogni opener è failure-gated per l inventario e ha un chiuditore', () => {
    const openers = record.openers.filter((o: { title: string }) => o.title === EXTERNAL_TITLE);
    expect(openers).toHaveLength(2);
    for (const opener of openers) {
      expect(opener.failureGated).toBe(true);
      expect(coverageOf(opener, record)).toEqual({ by: 'close-recovered-failure-issues' });
    }
  });
});

/* ── il ripiego che non dipende dal checkout ─────────────────────────────── */

describe('in-run-alarm — l allarme parte anche se checkout o setup falliscono', () => {
  const FALLBACK = IN_RUN.steps.find((s: any) => s.name === 'Open the deploy alarm without the checkout (fallback)');
  const redBuild = () => ({ ...allGreen(), 'build-locale': { result: 'failure' } });
  const stepCtx = (over: Partial<Ctx> = {}) => botCtx(redBuild(), { __level: 'step', ...over });

  it('checkout fallito → lo step principale salta, il ripiego parte', () => {
    const opener = IN_RUN.steps.find((s: any) => s.id === 'open');
    // Il difetto che il ripiego chiude: il `success()` implicito dello step
    // principale lo salta appena uno step precedente è rosso.
    expect(evalIf(opener.if, stepCtx({ __stepFailed: true }))).toBe(false);
    expect(evalIf(FALLBACK.if, stepCtx({ __stepFailed: true, steps: { open: { outcome: 'skipped' } } }))).toBe(true);
  });

  it('se lo step principale ha scritto, il ripiego tace: niente secondo commento', () => {
    expect(evalIf(FALLBACK.if, stepCtx({ steps: { open: { outcome: 'success' } } }))).toBe(false);
  });

  it('tace su una run cancellata e su una run del bot senza job rossi', () => {
    expect(evalIf(FALLBACK.if, stepCtx({ __cancelled: true, steps: { open: { outcome: 'skipped' } } }))).toBe(false);
    expect(evalIf(FALLBACK.if, botCtx(allGreen(), { __level: 'step', steps: { open: { outcome: 'skipped' } } })))
      .toBe(false);
  });

  it('senza checkout scarica il creator con `gh` allo SHA della run e apre il titolo canonico', () => {
    // Replay dello step reale in una directory vuota (nessun checkout, nessun
    // setup): `gh` è un finto che serve il creator vero e registra le chiamate.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'in-run-alarm-fallback-'));
    const bin = path.join(tmp, 'bin');
    const cwd = path.join(tmp, 'workspace');
    fs.mkdirSync(bin);
    fs.mkdirSync(cwd);
    const log = path.join(tmp, 'gh.log');
    fs.writeFileSync(path.join(bin, 'gh'), [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$FAKE_GH_LOG"',
      'case "$1 $2" in',
      '  "api -H") [ -n "$FAKE_GH_API_FAIL" ] && exit 1; cat "$FAKE_CREATOR" ;;',
      '  "issue create") echo "https://github.com/o/r/issues/4242" ;;',
      '  "issue view") echo \'{"state":"OPEN"}\' ;;',
      '  "issue list") echo "[]" ;;',
      '  *) echo "[]" ;;',
      'esac',
    ].join('\n'), { mode: 0o755 });
    const script = String(FALLBACK.run).replace(/\$\{\{\s*github\.workflow\s*\}\}/g, WORKFLOW_NAME);
    const run = (extra: Record<string, string> = {}) => spawnSync('bash', ['-e', '-c', script], {
      cwd,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: tmp,
        GH_TOKEN: 'x',
        GH_REPO: 'o/r',
        ALARM_SHA: 'abc123',
        ALARM_RUN_URL: 'https://github.com/o/r/actions/runs/36065965021',
        RUNNER_TEMP: tmp,
        FAKE_GH_LOG: log,
        FAKE_CREATOR: path.join(ROOT, 'scripts/lib/github-issue-creator.mjs'),
        ...extra,
      },
    });

    const ok = run();
    expect(ok.status).toBe(0);
    const calls = fs.readFileSync(log, 'utf8');
    expect(calls).toContain('api -H Accept: application/vnd.github.raw repos/o/r/contents/scripts/lib/github-issue-creator.mjs?ref=abc123');
    // Il body è su più righe: la chiamata va letta da `issue create` in poi.
    const create = calls.slice(calls.indexOf('issue create'));
    expect(calls.indexOf('issue create')).toBeGreaterThan(-1);
    expect(create).toContain(`--title Workflow Failure: ${WORKFLOW_NAME}`);
    expect(create).toContain('--repo o/r');

    // E se nemmeno l'API risponde: nessun rosso in più, un'annotation che lo dice.
    fs.rmSync(path.join(tmp, 'github-issue-creator.mjs'), { force: true });
    const noApi = run({ FAKE_GH_API_FAIL: '1' });
    expect(noApi.status).toBe(0);
    expect(noApi.stdout).toContain('::error title=Deploy alarm not written::');
    fs.rmSync(tmp, { recursive: true, force: true });
  }, 30_000);
});

/* ── resolve-build-alarm ────────────────────────────────────────────────── */

describe('resolve-build-alarm — «CI Failure (build)» si chiude solo a run tutta verde', () => {
  const BUILD_TITLE = `CI Failure (build): ${WORKFLOW_NAME}`;

  it('replay run 36077807468: tre gambe verdi e una rossa → nessuna chiusura', () => {
    const legs = PUSH_RUN.jobs.filter((j: { name: string }) => j.name.startsWith('build-locale ('));
    // Lo stato che ha chiuso #9179: una gamba verde qualunque bastava.
    expect(legs.filter((j: { conclusion: string }) => j.conclusion === 'success')).toHaveLength(3);
    expect(legs.find((j: { name: string }) => j.name === 'build-locale (it)').conclusion).toBe('failure');
    expect(evalIf(RESOLVE.if, runCtx(PUSH_RUN))).toBe(false);
  });

  it('quattro gambe verdi → chiude', () => {
    expect(evalIf(RESOLVE.if, botCtx(allGreen()))).toBe(true);
  });

  it('una gamba cancellata non basta a chiudere', () => {
    expect(evalIf(RESOLVE.if, botCtx({ ...allGreen(), 'build-locale': { result: 'cancelled' } }))).toBe(false);
  });

  it('nessuno step di una gamba chiude più il titolo: l unico chiuditore è il job aggregato', () => {
    const legSteps = DEPLOY.jobs['build-locale'].steps as Array<{ name: string; run?: string }>;
    for (const step of legSteps) {
      const text = String(step.run ?? '');
      expect(/--resolve\b/.test(text) && text.includes('CI Failure (build)'), step.name).toBe(false);
    }
    const record = parseWorkflow(DEPLOY_RAW, 'deploy.yml');
    const closers = record.closers.filter((c: { title: string }) => c.title === BUILD_TITLE);
    expect(closers).toHaveLength(1);
    const resolveStep = RESOLVE.steps.find((s: any) => /--resolve\b/.test(String(s.run ?? '')));
    expect(resolveStep.run).toContain('--title "CI Failure (build): ${{ github.workflow }}"');
    expect(RESOLVE.needs).toEqual(['build-locale']);
  });

  it('anche il gate di memoria, che ha un titolo unico per le quattro gambe, chiude solo lì', () => {
    // Stessa classe di difetto: il titolo non porta il locale, quindi uno step
    // `if: success()` di una gamba verde chiudeva la issue di una gamba rossa.
    const MEMORY_TITLE = 'il picco di memoria della build risale sopra la soglia';
    const legSteps = DEPLOY.jobs['build-locale'].steps as Array<{ uses?: string; with?: Record<string, string> }>;
    const legOpeners = legSteps.filter((st) => st.with?.title === MEMORY_TITLE);
    expect(legOpeners).toHaveLength(1);
    expect(legOpeners[0].with!.mode ?? 'report').toBe('report');
    const closers = (RESOLVE.steps as Array<{ with?: Record<string, string> }>)
      .filter((st) => st.with?.title === MEMORY_TITLE);
    expect(closers).toHaveLength(1);
    expect(closers[0].with!.mode).toBe('resolve');
    // I titoli per-locale restano nella gamba: lì ogni gamba chiude il proprio.
    const legRuns = legSteps.map((st: any) => String(st.run ?? '')).join('\n');
    expect(legRuns).toContain('Deploy: ${{ matrix.locale }} locale shard push failed (stale live locale)');
  });

  it('non può rendere rossa una run verde: bloccherebbe la pubblicazione', () => {
    // La pubblicazione parte su `workflow_run` con conclusion `success`: un
    // reporter rosso su un build verde costerebbe un deploy intero.
    expect(RESOLVE['continue-on-error']).toBe(true);
    const resolveStep = RESOLVE.steps.find((s: any) => /--resolve\b/.test(String(s.run ?? '')));
    expect(resolveStep['continue-on-error']).toBe(true);
    expect(RESOLVE.permissions).toEqual({ contents: 'read', issues: 'write' });
  });
});

/* ── lo script, dentro la run ancora in corso ───────────────────────────── */

describe('report-deploy-run-failure — la run osservata è ancora in corso', () => {
  const failures = RUN_LIST.slice(6);
  const running = { databaseId: 99, status: 'in_progress', conclusion: null };

  it('conta la run in corso con la conclusion provata dal job, invece di saltarla', () => {
    // Senza l'opzione la run in corso è saltata e la serie è sottostimata di uno.
    expect(consecutiveFailureStreak([running, ...failures], { fromRunId: 99 }).streak).toBe(29);
    expect(consecutiveFailureStreak([running, ...failures], { fromRunId: 99, observedConclusion: 'failure' }))
      .toEqual({ streak: 30, saturated: true });
  });

  it('le ALTRE run non completate restano saltate', () => {
    const other = { databaseId: 98, status: 'queued', conclusion: null };
    expect(consecutiveFailureStreak([running, other, ...failures], { fromRunId: 99, observedConclusion: 'failure' }).streak)
      .toBe(30);
  });

  it('una run ancorata già completata tiene la sua conclusion vera', () => {
    const green = RUN_LIST[5] as { databaseId: number; conclusion: string };
    expect(green.conclusion).toBe('success');
    expect(consecutiveFailureStreak(RUN_LIST, { fromRunId: green.databaseId, observedConclusion: 'failure' }))
      .toEqual({ streak: 0, saturated: false });
  });

  it('attribuisce il rosso della run del bot al leg it, con lo step', () => {
    // La Jobs API vista da dentro: il job d'allarme stesso è `in_progress` e
    // non deve essere scambiato per il guasto.
    const payload = {
      jobs: [
        ...BOT_RUN.jobs.map((j: { name: string; conclusion: string; failedSteps: string[] }) => ({
          name: j.name,
          conclusion: j.conclusion,
          steps: j.failedSteps.map((name, i) => ({ name, number: i + 1, conclusion: 'failure' })),
        })),
        { name: 'in-run deploy alarm (run without workflow_run)', conclusion: null, steps: [] },
      ],
    };
    expect(firstFailure(payload)).toMatchObject({
      job: 'build-locale (it)',
      step: 'Validate full-corpus jobs SEO evidence',
    });
  });
});

describe('report-deploy-run-failure — il body dice da dove arriva l allarme', () => {
  const base = {
    workflowName: WORKFLOW_NAME,
    runUrl: 'https://github.com/o/r/actions/runs/36065965021',
    runId: '36065965021',
    conclusion: 'failure',
    failure: { job: 'build-locale (it)', step: 'Validate full-corpus jobs SEO evidence', stepNumber: 42 },
    streak: 1,
    streakSaturated: false,
  };

  it('l osservatore interno nomina il token del bot e il perché', () => {
    const body = buildAlarmDescription({ ...base, observer: 'in-run' });
    expect(body).toContain('github-actions[bot]');
    expect(body).toContain('job di allarme interno');
    expect(body).not.toContain('Questo allarme arriva da un osservatore esterno.');
    expect(body).toContain('reconciler');
    // Stessa regola del body esterno: un path di workflow azzera il fixer.
    expect(body).not.toMatch(/\.github\/workflows\//);
    expect(body).not.toMatch(/[\w-]+\.ya?ml\b/);
  });

  it('il default resta il testo dell osservatore esterno', () => {
    const body = buildAlarmDescription(base);
    expect(body).toContain('Questo allarme arriva da un osservatore esterno.');
    expect(body).not.toContain('github-actions[bot]');
  });
});

describe('forma del workflow', () => {
  it('isFailureGated riconosce l elenco dei `needs` rossi dello step di apertura', () => {
    const block = DEPLOY_RAW.slice(DEPLOY_RAW.indexOf('- name: Open or update the deploy alarm issue'));
    expect(isFailureGated(block.slice(0, block.indexOf('run: |')))).toBe(true);
  });
});
