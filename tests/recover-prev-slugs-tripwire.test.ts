/**
 * recover-prev-slugs.yml — il tripwire misura il residuo POST-recupero (#5348).
 *
 * Il difetto: `STILL_LOST` era cablato a `steps.scan.outputs.recoverable_slugs`, cioè al
 * conteggio calcolato PRIMA del backfill. Nel run 31236737581 lo scan trovava 11 slug
 * recuperabili, il backfill ne ripristinava 10 (commit 0163c80652), e il tripwire
 * rileggeva comunque l'output dello step `scan` — ancora 11 — aprendo una issue che
 * diceva «auto-recovery could not restore them» mentre il residuo reale era 1, sotto la
 * soglia di 3. Non era una regressione del writer: nei due commit incolpati (8e5b71b65d,
 * d0c479a3cf) il journal mostra `slug-preservation-guard` attivo e i drop attribuiti a
 * `cleanPreviousSlugsPerLocale` (dedup legittimo di self-redirect). Il wire non poteva
 * scendere sotto soglia per costruzione, perché misurava un numero che il recupero non
 * tocca.
 *
 * Questi test ESEGUONO lo script bash vero estratto dal workflow, invece di
 * riprodurne la logica: una copia della condizione in TypeScript passerebbe anche se
 * il workflow tornasse a leggere il conteggio sbagliato, che è esattamente il bug.
 * Le espressioni `${{ ... }}` (interpolate da Actions, non da bash) vengono sostituite
 * con un segnaposto per rendere lo script eseguibile fuori dal runner.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';

const WORKFLOW = new URL('../.github/workflows/recover-prev-slugs.yml', import.meta.url);

type Step = { name?: string; id?: string; if?: string; env?: Record<string, string>; run?: string };
let steps: Step[];
let tripwire: Step;
let rescan: Step;
let scan: Step;

beforeAll(() => {
  const doc = parse(readFileSync(WORKFLOW, 'utf8'));
  steps = doc.jobs.recover.steps as Step[];
  tripwire = steps.find((s) => s.name === 'Trip the writer-regression wire')!;
  rescan = steps.find((s) => s.id === 'rescan')!;
  scan = steps.find((s) => s.id === 'scan')!;
});

/**
 * Run the tripwire step's REAL script with a controlled environment.
 * Returns { status, stdout } — never throws, so an above-threshold run (which walks on
 * into the jq/issue-creator pipeline) can be inspected rather than aborting the test.
 */
function runTripwire(env: Record<string, string>, cwd: string) {
  // `${{ ... }}` is Actions-side interpolation; bash would choke on it ("bad
  // substitution"). Actions substitutes before the shell ever sees the script, so
  // replacing it here reproduces what the runner actually executes.
  const script = tripwire.run!.replace(/\$\{\{[^}]*\}\}/g, 'ACTIONS_EXPR');
  const scriptPath = path.join(cwd, 'tripwire.sh');
  writeFileSync(scriptPath, script);
  try {
    const stdout = execFileSync('bash', [scriptPath], {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${path.join(cwd, 'bin')}:${process.env.PATH}`, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

/**
 * A sandbox with the /tmp scan artifacts the script reads and a `node` shim on PATH, so
 * an above-threshold run records the issue-creation call instead of hitting GitHub.
 */
function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'prev-slug-tripwire-'));
  mkdirSync(path.join(dir, 'bin'));
  const marker = path.join(dir, 'issue-created.txt');
  writeFileSync(
    path.join(dir, 'bin', 'node'),
    `#!/bin/bash\nprintf '%s\\n' "$@" > ${marker}\n`,
  );
  chmodSync(path.join(dir, 'bin', 'node'), 0o755);
  mkdirSync('/tmp/prev-slug-recovery', { recursive: true });
  // Post-backfill artifacts: one residual slug, from a commit the body should name.
  writeFileSync(
    '/tmp/prev-slug-recovery/recoverable-post.json',
    JSON.stringify([{ file: 'a.json', jobId: 'j1', slugs: ['still-lost-slug'] }]),
  );
  writeFileSync(
    '/tmp/prev-slug-recovery/events-post.jsonl',
    `${JSON.stringify({ file: 'a.json', jobId: 'j1', lost: ['still-lost-slug'], commit: 'deadbeef' })}\n`,
  );
  // Pre-backfill artifacts: the far larger set recovery already healed.
  writeFileSync(
    '/tmp/prev-slug-recovery/recoverable.json',
    JSON.stringify([{ file: 'a.json', jobId: 'j1', slugs: ['still-lost-slug', 'healed-1', 'healed-2'] }]),
  );
  writeFileSync(
    '/tmp/prev-slug-recovery/events.jsonl',
    `${JSON.stringify({ file: 'a.json', jobId: 'j1', lost: ['healed-1'], commit: 'cafebabe' })}\n`,
  );
  return { dir, marker };
}

describe('tripwire — restored == recoverable NON apre issue (#5348)', () => {
  it('recupero completo (11 recuperabili, 11 ripristinati → 0 residui) → nessuna issue', () => {
    const { dir, marker } = sandbox();
    const r = runTripwire(
      { PRE_LOST: '11', POST_LOST: '0', THRESHOLD: '3', TOTAL: '52', WINDOW: '24 hours ago' },
      dir,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('under threshold');
    expect(existsSync(marker)).toBe(false); // github-issue-creator mai invocato
  });

  it('il caso REALE del run 31236737581: 11 recuperabili, 10 ripristinati, 1 residuo → nessuna issue', () => {
    // È il conteggio che il vecchio wire leggeva (11 > 3 → issue) contro quello che
    // deve leggere (1 <= 3 → silenzio). Un solo numero separa un falso positivo da un
    // comportamento corretto.
    const { dir, marker } = sandbox();
    const r = runTripwire(
      { PRE_LOST: '11', POST_LOST: '1', THRESHOLD: '3', TOTAL: '52', WINDOW: '24 hours ago' },
      dir,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Still-missing 1 slugs');
    expect(existsSync(marker)).toBe(false);
  });

  it('logga SEMPRE entrambi i conteggi, anche quando non apre nulla', () => {
    // Se questo fix fosse sbagliato, il confronto pre/post è l'unico modo di accorgersene
    // — ed è l'unico rischio serio introdotto qui.
    const { dir } = sandbox();
    const r = runTripwire(
      { PRE_LOST: '11', POST_LOST: '1', THRESHOLD: '3', TOTAL: '52', WINDOW: '24 hours ago' },
      dir,
    );
    expect(r.stdout).toContain('recoverable BEFORE backfill: 11');
    expect(r.stdout).toContain('still missing AFTER: 1');
  });

  it('residuo esattamente sulla soglia → nessuna issue (confine `-le`, invariato)', () => {
    const { dir, marker } = sandbox();
    const r = runTripwire(
      { PRE_LOST: '99', POST_LOST: '3', THRESHOLD: '3', TOTAL: '99', WINDOW: '24 hours ago' },
      dir,
    );
    expect(r.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('tripwire — una regressione VERA continua a scattare', () => {
  it('residuo sopra soglia → issue aperta, e col conteggio POST-recupero nel titolo/corpo', () => {
    const { dir, marker } = sandbox();
    const r = runTripwire(
      { PRE_LOST: '40', POST_LOST: '12', THRESHOLD: '3', TOTAL: '80', WINDOW: '24 hours ago' },
      dir,
    );
    expect(r.stdout).toContain('🚨 Tripwire: 12 slugs still missing');
    expect(existsSync(marker)).toBe(true);
    const args = readFileSync(marker, 'utf-8');
    expect(args).toContain('previousSlugs writer regression detected');
    // Il corpo riporta il residuo reale (12), non il conteggio pre-backfill (40).
    expect(args).toContain('**12** previousSlugs entries');
    expect(args).toContain('started from 40 recoverable');
    // Nomina il commit dietro lo slug ANCORA mancante, non quello già guarito.
    expect(args).toContain('deadbeef');
    expect(args).not.toContain('cafebabe');
  });

  it('ri-scan senza conteggio (step saltato/crash) → fallback sul PRE, il segnale non si perde', () => {
    // Fail-safe verso l'allarme: un falso positivo costa una issue da chiudere,
    // perdere una regressione vera costa slug indicizzati che servono 404.
    const { dir, marker } = sandbox();
    const r = runTripwire(
      { PRE_LOST: '40', POST_LOST: '', THRESHOLD: '3', TOTAL: '80', WINDOW: '24 hours ago' },
      dir,
    );
    expect(r.stdout).toContain('falling back to the pre-backfill count');
    expect(r.stdout).toContain('🚨 Tripwire: 40 slugs still missing');
    expect(existsSync(marker)).toBe(true);
  });
});

describe('recover-prev-slugs.yml — wiring del ri-scan', () => {
  it('separa le decontaminazioni cross-job provate da recovery e tripwire', () => {
    expect(scan.run).toContain('--safe-events-out /tmp/prev-slug-recovery/safe-cross-job-events.jsonl');
    expect(scan.run).toContain('safe_cross_job=');
    expect(scan.run).toContain('|| safe_cross_job=0');
    const backfill = steps.find((s) => s.name === 'Backfill recoverable slugs')!;
    expect(backfill.if).toContain('recoverable_slugs');
    expect(backfill.if).not.toContain('safe_cross_job');
    expect(backfill.run).toContain('--input /tmp/prev-slug-recovery/recoverable.json');
    expect(backfill.run).not.toContain('safe-cross-job');
    expect(tripwire.if).toContain('recoverable_slugs');
    expect(tripwire.if).not.toContain('safe_cross_job');
  });

  it('STILL_LOST non è più cablato all output dello step `scan`', () => {
    const env = tripwire.env || {};
    expect(JSON.stringify(env)).not.toContain('steps.scan.outputs.recoverable_slugs}}');
    expect(env.POST_LOST).toContain('steps.rescan.outputs.still_lost');
    // Il pre resta disponibile per il log e per il fallback, ma non decide.
    expect(env.PRE_LOST).toContain('steps.scan.outputs.recoverable_slugs');
  });

  it('il ri-scan gira DOPO il commit del backfill', () => {
    // Il body della issue nomina il merge 3-way di git-commit-data.sh («runs after
    // node exits») fra le classi note di perdita: solo un ri-scan post-commit le vede.
    const order = steps.map((s) => s.name);
    const commitIdx = order.indexOf('Commit and push restored slices');
    const rescanIdx = order.indexOf(rescan.name!);
    const tripIdx = order.indexOf('Trip the writer-regression wire');
    expect(commitIdx).toBeGreaterThan(-1);
    expect(rescanIdx).toBeGreaterThan(commitIdx);
    expect(tripIdx).toBeGreaterThan(rescanIdx);
  });

  it('il ri-scan usa lo STESSO scanner del conteggio pre — pre e post restano confrontabili', () => {
    expect(rescan.run).toContain('scripts/scan-prev-slug-losses.mjs');
    expect(rescan.run).toContain('still_lost=');
  });

  it('il ri-scan ha lo stesso gate del tripwire (mai in dry-run, mai a zero recuperabili)', () => {
    expect(rescan.if).toBe(tripwire.if);
  });
});
