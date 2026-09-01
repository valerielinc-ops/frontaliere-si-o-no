// Guards for #5251 — the #2569 cross-shard CDN-push ordering gate.
//
// Three defects this file pins, all measured on real runs (2026-08-06):
//
//  1. NO MARGIN. On run 31076991699 — a run recorded as SUCCESS — the `de` leg
//     waited 2714s against a 2700s budget and matched on the LAST of its 181
//     polls. The IT leg only reached its CDN push after 31min of section-shard
//     pushes + 5min packing + 4min strip. deploy.yml now hoists that push
//     ahead of the section fan-out, so the marker turns while the non-IT legs
//     are still packing.
//
//  2. SILENT. Both terminal states of the gate are one poll apart and, from
//     outside the job, identical: `continue-on-error: true` reports the step
//     as `conclusion: success` either way. A near-miss must therefore say so.
//
//  3. MISDIAGNOSED. A gate timeout and a shard push failure used to be
//     surfaced by ONE step with ONE issue title whose body blamed the shard
//     deploy key. On run 31062047677 the IT leg's BUILD failed, the marker
//     never turned, all three non-IT gates burned 2700s — and issues #5224
//     (fr), #5225 (en), #5227 (de) were filed against the shard deploy keys.
//     The two causes must now be told apart.
//
// Every assertion below is paired with the negative case it is supposed to
// catch: the near-miss test has a comfortable-margin counterpart, the
// timeout test has a matched counterpart, and the "early CDN push only runs
// section 2" test has an unflagged counterpart that must reach further.
import { describe, it, expect, beforeAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import YAML from 'yaml';

const DEPLOY_YML = readFileSync(resolve('.github/workflows/deploy.yml'), 'utf8');
const PREP_SH = resolve('scripts/lib/deploy-it-pages-prep.sh');
const GATE_SH = resolve('scripts/lib/wait-cdn-build-id.sh');
const EARLY_CDN_STEP = 'Push generated assets to CDN (early — ahead of the shard pushes)';

/** Slice one `- name: <title>` step out of the build-locale step list. */
function step(title: string): string {
  const idx = DEPLOY_YML.indexOf(`      - name: ${title}`);
  expect(idx, `step "${title}" not found in deploy.yml`).toBeGreaterThan(-1);
  const rest = DEPLOY_YML.slice(idx + 1);
  const end = rest.indexOf('\n      - name: ');
  return rest.slice(0, end === -1 ? undefined : end);
}

describe('deploy.yml — the IT CDN push runs BEFORE anything publishes (#5251)', () => {
  it('the early CDN push step exists and is ordered ahead of the IT section-shard fan-out', () => {
    const early = DEPLOY_YML.indexOf('- name: Push generated assets to CDN (early');
    const sections = DEPLOY_YML.indexOf('- name: Push section shards (IT →');
    const prep = DEPLOY_YML.indexOf('- name: Deploy prep (IT → Pages + CDN)');
    expect(early, 'early CDN push step missing').toBeGreaterThan(-1);
    expect(sections, 'IT section-shard push step missing').toBeGreaterThan(-1);
    // THE regression this file exists for: if the early push is ever moved back
    // behind the section fan-out, the gate goes back to a ~40min head start it
    // does not have the budget for.
    expect(early, 'early CDN push must precede the IT section-shard pushes').toBeLessThan(sections);
    expect(sections, 'section pushes must still precede the full Deploy prep').toBeLessThan(prep);
  });

  it('the early step runs ONLY the CDN push phase, and the IT leg is its only caller', () => {
    const s = step('Push generated assets to CDN (early — ahead of the shard pushes)');
    expect(s, 'early step must run deploy-it-pages-prep.sh').toMatch(/bash scripts\/lib\/deploy-it-pages-prep\.sh/);
    expect(s, 'early step must set the phase flag').toMatch(/DEPLOY_CDN_PUSH_ONLY: '1'/);
    expect(s, 'early step must be IT-only').toMatch(/if: matrix\.locale == 'it'/);
    // A CDN push failure must never fail the leg: the full prep still retries
    // the push at its original position, which is the pre-hoist behaviour.
    expect(s, 'early step must be continue-on-error').toMatch(/continue-on-error: true/);
    expect(s, 'early step needs the CDN credentials + target').toMatch(/CDN_DEPLOY_KEY:/);
    expect(s, 'early step needs CDN_TARGET').toMatch(/CDN_TARGET:/);
    // The marker IS the build id — without it the push writes an empty marker
    // and the gate can never match.
    expect(s, 'early step must pass DEPLOY_BUILD_ID (the marker value)').toMatch(/DEPLOY_BUILD_ID:/);
  });

  it('the #2569 invariant itself is unchanged: the shard publish is still gated on the marker', () => {
    const push = step('Push locale shard');
    expect(
      push,
      'Push locale shard must stay gated on the ordering guard — hoisting the CDN push must not relax the gate',
    ).toMatch(/if: matrix\.locale != 'it' && steps\.cdn-gate\.outcome == 'success'/);
    const gate = step('Wait for IT CDN push (cross-shard ordering guard)');
    expect(gate, 'the gate must still poll the marker script').toMatch(/wait-cdn-build-id\.sh/);
    expect(gate, 'the gate must stay continue-on-error (one shard must not abort the deploy)').toMatch(
      /continue-on-error: true/,
    );
    expect(gate, 'near-miss threshold must be configured').toMatch(/CDN_WAIT_MARGIN_WARN_S: \d+/);
  });
});

describe('deploy.yml — a timeout and a push failure are told APART (#5251)', () => {
  // Both titles use `${{ matrix.locale }}` — the ONLY discriminant
  // tests/monitor-issue-dedup.test.ts sanctions for deploy.yml (its
  // ENTITY_DISCRIMINANTS allowlist: one issue per locale shard). A shell
  // `${LOCALE}` here is rejected by that guard, and rightly so: the guard
  // cannot tell a stable entity key from a varying counter, which is why the
  // allowlist is explicit. Same literal in every step that files or closes
  // them, which is what makes the drift check below real.
  const GATE_TITLE = 'Deploy: guard di ordinamento CDN #2569 scaduto (${{ matrix.locale }}) — shard non pubblicato';
  const PUSH_TITLE = 'Deploy: ${{ matrix.locale }} locale shard push failed (stale live locale)';

  it('each cause has its OWN step, gated on its OWN outcome', () => {
    const gateStep = step('Surface an unpublished locale shard (#2569 CDN ordering gate timed out)');
    const pushStep = step('Surface a stale-locale shard push failure (#2658)');
    expect(gateStep).toMatch(/if: matrix\.locale != 'it' && steps\.cdn-gate\.outcome == 'failure'/);
    expect(pushStep).toMatch(/if: matrix\.locale != 'it' && steps\.push-shard\.outcome == 'failure'/);
    // The regression: collapsing them back into one `||` condition loses the
    // distinction that cost the #5224/#5225/#5227 misdiagnosis.
    expect(
      pushStep,
      'the push-failure step must NOT also fire on a gate timeout (that is what made the two indistinguishable)',
    ).not.toMatch(/steps\.cdn-gate\.outcome == 'failure'/);
  });

  it('neither step aborts the deploy, and both emit a run-level error annotation', () => {
    for (const title of [
      'Surface an unpublished locale shard (#2569 CDN ordering gate timed out)',
      'Surface a stale-locale shard push failure (#2658)',
    ]) {
      const s = step(title);
      // Tolerance is deliberate: one unpublished shard must not take the other
      // 26 down with it.
      expect(s, `${title}: must stay continue-on-error`).toMatch(/continue-on-error: true/);
      // ...but tolerated is not the same as invisible. `::warning::` used to be
      // the only signal; an unpublished shard is an error-grade fact.
      expect(s, `${title}: must emit an ::error:: annotation, not just a warning`).toMatch(/echo "::error title=/);
      expect(s, `${title}: must write a job-summary row`).toMatch(/GITHUB_STEP_SUMMARY/);
      expect(s, `${title}: must file/refresh a deduped tracking issue`).toMatch(/github-issue-creator\.mjs/);
    }
  });

  it('the gate-timeout issue carries the measured facts and points at the IT leg', () => {
    const s = step('Surface an unpublished locale shard (#2569 CDN ordering gate timed out)');
    for (const out of ['cdn_waited_s', 'cdn_timeout_s', 'cdn_expected', 'cdn_last_seen']) {
      expect(s, `gate-timeout step must surface steps.cdn-gate.outputs.${out}`).toMatch(
        new RegExp(`steps\\.cdn-gate\\.outputs\\.${out}`),
      );
    }
    expect(s, 'the body must send the reader to the IT leg, not the shard repo').toMatch(/leg IT/);
    expect(
      s,
      'the gate-timeout body must NOT repeat the deploy-key diagnosis that misdiagnosed #5224/#5225/#5227',
    ).not.toMatch(/deploy key shard scaduta/);
  });

  it('the CDN marker value (remote bytes) never reaches a run: block by interpolation', () => {
    const s = step('Surface an unpublished locale shard (#2569 CDN ordering gate timed out)');
    const runIdx = s.indexOf('\n        run: |');
    expect(runIdx, 'gate-timeout step has no run: block').toBeGreaterThan(-1);
    const runBlock = s.slice(runIdx);
    // cdn_last_seen is the body of a file fetched over the network. It must be
    // bound through `env:` (above the run block) and referenced as a shell
    // variable — never expanded into the script text by Actions.
    expect(
      runBlock,
      'network-sourced gate outputs must be passed via env:, never interpolated into run: text',
    ).not.toMatch(/\$\{\{\s*steps\.cdn-gate\.outputs\./);
    expect(s.slice(0, runIdx), 'CDN_LAST_SEEN must be bound in env:').toMatch(
      /CDN_LAST_SEEN: \$\{\{ steps\.cdn-gate\.outputs\.cdn_last_seen \}\}/,
    );
  });

  it('a green push resolves BOTH canonical issue titles, spelled exactly as filed', () => {
    const resolve_ = step('Resolve stale-locale shard issues on successful push (#2658)');
    expect(resolve_).toMatch(/if: matrix\.locale != 'it' && steps\.push-shard\.outcome == 'success'/);
    // Title drift is the failure mode: a surfacing step that files title A and
    // a resolve step that closes title B leaves a permanently-open issue. These
    // two assertions go red the moment either title is edited in one place only.
    expect(resolve_, 'resolve step must close the push-failure issue').toContain(PUSH_TITLE);
    expect(resolve_, 'resolve step must close the #2569 gate-timeout issue').toContain(GATE_TITLE);
    expect(step('Surface a stale-locale shard push failure (#2658)')).toContain(PUSH_TITLE);
    expect(step('Surface an unpublished locale shard (#2569 CDN ordering gate timed out)')).toContain(GATE_TITLE);
  });
});

// ── scripts/lib/wait-cdn-build-id.sh — near-miss + machine-readable facts ────
interface GateRun {
  code: number;
  stdout: string;
  outputs: Record<string, string>;
  summary: string;
}

// Every invocation gets its OWN tmpdir for GITHUB_OUTPUT/GITHUB_STEP_SUMMARY and
// its OWN env object — nothing is shared between two runs, and the script itself
// only ever writes inside that dir. That is what makes the parallel batches
// below safe: `runGateAsync` is the same call, just not blocking the event loop.
function gateFiles() {
  const dir = mkdtempSync(join(tmpdir(), 'cdn-gate-'));
  const outFile = join(dir, 'output');
  const sumFile = join(dir, 'summary');
  writeFileSync(outFile, '');
  writeFileSync(sumFile, '');
  return { outFile, sumFile };
}

// A lone spawn finishes a 6s-budget case in ~7,4s, so 20s left 2,7x of headroom
// before the kill. Batched, the polls serialize on process spawn (each poll is
// a fake `gh` → bash + jq, plus a curl) and the per-child wall time grows with
// the batch: measured 10,0s at 12 concurrent, 13,0s at 24, 19,5s at 48 — i.e.
// the 20s ceiling is ~1,0x away from a batch only four times this one's size,
// on a runner slower than this laptop. The cost is spawn serialization, not
// CPU: adding 8 CPU-saturating loops did not move those numbers.
//
// A trip would fail loudly, not silently — the child is SIGTERM'd before it
// writes $GITHUB_OUTPUT, so `cdn_wait_result` comes back undefined and the
// assertions go red — but red-for-the-wrong-reason on a busy runner is exactly
// the flake this file should not add. Hence: the sync runner keeps the 20s it
// always had (one spawn at a time, unchanged from before the batching), and
// only the batched runner gets the wider ceiling.
const GATE_KILL_MS_SOLO = 20000;
const GATE_KILL_MS_BATCHED = 60000;

// `stdio` is deliberately NOT here: `execFileSync` takes it, `execFile` does
// not. Everything the two runners genuinely share lives in this one place.
function gateOpts(env: Record<string, string>, outFile: string, sumFile: string, killMs: number) {
  return {
    env: { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: sumFile, ...env },
    encoding: 'utf8' as const,
    timeout: killMs,
  };
}

function collectGate(outFile: string, sumFile: string, code: number, stdout: string): GateRun {
  const outputs: Record<string, string> = {};
  for (const line of readFileSync(outFile, 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return { code, stdout, outputs, summary: readFileSync(sumFile, 'utf8') };
}

function runGate(args: string[], env: Record<string, string> = {}): GateRun {
  const { outFile, sumFile } = gateFiles();
  let code = 0;
  let stdout = '';
  try {
    stdout = execFileSync('bash', [GATE_SH, ...args], {
      ...gateOpts(env, outFile, sumFile, GATE_KILL_MS_SOLO),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: Buffer | string };
    code = err.status ?? 1;
    stdout = err.stdout?.toString() ?? '';
  }
  return collectGate(outFile, sumFile, code, stdout);
}

/**
 * Same contract as `runGate`, without blocking the event loop — so a set of
 * independent invocations can be spawned with `Promise.all` instead of one
 * after the other. The gate spends its time in `sleep`, not on the CPU: the
 * budget-burning cases below cost the same wall time each whether they run
 * alone or nine at a time.
 *
 * The assertions that pin the budget (`cdn_waited_s`) stay deterministic under
 * load because the script counts polls (`elapsed=$((elapsed + interval_s))`),
 * it does not read a clock.
 */
function runGateAsync(args: string[], env: Record<string, string> = {}): Promise<GateRun> {
  const { outFile, sumFile } = gateFiles();
  return new Promise((resolvePromise) => {
    execFile('bash', [GATE_SH, ...args], gateOpts(env, outFile, sumFile, GATE_KILL_MS_BATCHED), (err, stdout) => {
      const status = (err as { code?: number } | null)?.code;
      resolvePromise(collectGate(outFile, sumFile, err ? (status ?? 1) : 0, stdout ?? ''));
    });
  });
}

function markerUrl(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cdn-build-id-'));
  const file = join(dir, 'cdn-build-id.txt');
  writeFileSync(file, contents);
  return `file://${file}`;
}

describe('wait-cdn-build-id.sh — a near miss is not the same green as a comfortable match', () => {
  it('MATCH with little budget left → exit 0, ::warning::, cdn_near_miss=true', () => {
    // Reproduces run 31076991699's de leg in miniature: it matched, the shard
    // was safe to publish, and the run said nothing about how close it was.
    const url = markerUrl('1718000000123');
    const r = runGate(['1718000000123'], {
      CDN_BUILD_ID_URL: url,
      CDN_WAIT_TIMEOUT_S: '10',
      CDN_WAIT_INTERVAL_S: '1',
      CDN_WAIT_MARGIN_WARN_S: '3600', // everything is a near miss at this threshold
    });
    expect(r.code, 'a near miss must still publish the shard').toBe(0);
    expect(r.stdout).toMatch(/::warning title=CDN ordering gate near miss::/);
    expect(r.outputs.cdn_wait_result).toBe('matched');
    expect(r.outputs.cdn_near_miss).toBe('true');
    expect(r.summary).toMatch(/NEAR MISS/);
  });

  it('NEGATIVE CASE — MATCH with a comfortable margin → exit 0 and NO near-miss warning', () => {
    // Without this counterpart the assertion above would also pass on a script
    // that warns unconditionally, which would be its own kind of silence.
    const url = markerUrl('1718000000123');
    const r = runGate(['1718000000123'], {
      CDN_BUILD_ID_URL: url,
      CDN_WAIT_TIMEOUT_S: '10',
      CDN_WAIT_INTERVAL_S: '1',
      CDN_WAIT_MARGIN_WARN_S: '1',
    });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/near miss/i);
    expect(r.outputs.cdn_near_miss).toBe('false');
    expect(r.outputs.cdn_margin_s).toBe('10');
    expect(r.summary).not.toMatch(/NEAR MISS/);
  });

  it('TIMEOUT → exit 1, ::error:: annotation, and facts the caller can name the cause with', () => {
    const url = markerUrl('an-older-build-id');
    const r = runGate(['the-new-build-id'], {
      CDN_BUILD_ID_URL: url,
      CDN_WAIT_TIMEOUT_S: '0',
      CDN_WAIT_INTERVAL_S: '1',
    });
    expect(r.code, 'a timeout must NOT let the shard publish').toBe(1);
    expect(r.stdout).toMatch(/::error title=CDN ordering gate TIMED OUT::/);
    expect(r.outputs.cdn_wait_result).toBe('timeout');
    expect(r.outputs.cdn_expected).toBe('the-new-build-id');
    expect(r.outputs.cdn_last_seen).toBe('an-older-build-id');
    expect(r.outputs.cdn_timeout_s).toBe('0');
    expect(r.summary).toMatch(/TIMED OUT/);
    expect(r.summary).toMatch(/STALE/);
  });

  it('NEGATIVE CASE — the no-op path (no build id) stays a no-op and claims nothing', () => {
    const r = runGate([''], { CDN_WAIT_TIMEOUT_S: '0' });
    expect(r.code).toBe(0);
    expect(r.outputs.cdn_wait_result).toBe('noop');
    // A skipped guard reported as a match is the "skip posted as ✅ OK" defect
    // class — it must not claim to have verified anything.
    expect(r.outputs.cdn_near_miss).toBeUndefined();
    expect(r.summary).toBe('');
  });

  it('a hostile CDN marker cannot break the key=value output contract', () => {
    // cdn_last_seen is remote bytes that end up inside a GitHub issue body.
    const r = runGate(['expected-id'], {
      CDN_BUILD_ID_URL: markerUrl('bad\nid=injected\n$(touch /tmp/pwned) `id` "x"'),
      CDN_WAIT_TIMEOUT_S: '0',
      CDN_WAIT_INTERVAL_S: '1',
    });
    expect(r.code).toBe(1);
    // Newlines, `=`, `/`, `$`, backticks, quotes and spaces are all gone: what
    // survives cannot open a second key=value line, cannot close the shell
    // string the caller builds, and cannot start a command substitution.
    expect(r.outputs.cdn_last_seen, 'marker must be reduced to a safe charset').toBe(
      'badidinjectedtouchtmppwnedidx',
    );
    // The smuggled `id=injected` key must NOT have landed as its own output.
    expect(r.outputs.injected).toBeUndefined();
    expect(r.outputs.cdn_last_seen).not.toMatch(/[=$`'"\s/()]/);
    expect(r.outputs.cdn_wait_result).toBe('timeout');
  });
});

// ── #5331: the gate must not wait out an event that is already impossible ────
//
// Run 31202386246: `build-locale (it)` ended in FAILURE at 18:07:04; the fr
// leg's gate had started at 18:04:25 and polled on until 18:50:17. Forty-three
// of those forty-five minutes were spent waiting for a marker that nothing was
// left to write, and the run then reported a bare "timeout" — the same shape a
// slow-but-alive IT leg produces, which is why triage went to the fr shard repo.
//
// The danger in fixing this is publishing a shard AHEAD of the CDN, i.e. undoing
// #2569. So every test below comes with the negative case that would catch an
// over-eager abort: "still running", "job absent", "API down" and "conclusion
// null" must ALL keep waiting, and a marker that matches must win even when the
// IT leg is dead.
function fakeGh(payload: unknown | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'));
  writeFileSync(join(dir, 'payload.json'), payload === null ? '' : JSON.stringify(payload));
  // Applies the REAL --jq filter to the payload, so these tests exercise the
  // script's actual selection predicate rather than a stub of it. `payload:
  // null` stands for a failing API call (403 / rate limit / network).
  writeFileSync(
    join(dir, 'gh'),
    [
      '#!/usr/bin/env bash',
      `if [ ! -s "${join(dir, 'payload.json')}" ]; then echo "gh: HTTP 403" >&2; exit 1; fi`,
      'filter="."',
      'while [ $# -gt 0 ]; do case "$1" in --jq) filter="$2"; shift 2 ;; *) shift ;; esac; done',
      `jq -r "$filter" < "${join(dir, 'payload.json')}"`,
    ].join('\n'),
    { mode: 0o755 },
  );
  return dir;
}

/** A fake jobs API whose authoritative snapshot advances once per `gh` call. */
function fakeGhSequence(payloads: (unknown | null)[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-sequence-'));
  writeFileSync(join(dir, 'state'), '0');
  payloads.forEach((payload, i) => {
    writeFileSync(join(dir, `payload-${i}.json`), payload === null ? '' : JSON.stringify(payload));
  });
  writeFileSync(
    join(dir, 'gh'),
    [
      '#!/usr/bin/env bash',
      `state=${JSON.stringify(join(dir, 'state'))}`,
      'index="$(cat "$state")"',
      `last=${payloads.length - 1}`,
      '[ "$index" -le "$last" ] || index="$last"',
      'printf "%s" "$((index + 1))" > "$state"',
      `payload="${join(dir, 'payload-')}\${index}.json"`,
      'if [ ! -s "$payload" ]; then echo "gh: HTTP 503" >&2; exit 1; fi',
      'filter="."',
      'while [ $# -gt 0 ]; do case "$1" in --jq) filter="$2"; shift 2 ;; *) shift ;; esac; done',
      'jq -r "$filter" < "$payload"',
    ].join('\n'),
    { mode: 0o755 },
  );
  return dir;
}

/**
 * A PATH holding the gate's real dependencies (curl/tr/cut/sleep) but NO `gh`,
 * so the "gh CLI not on PATH" precondition can be tested without also breaking
 * the polling the assertion depends on.
 */
function pathWithoutGh(): string {
  const dir = mkdtempSync(join(tmpdir(), 'no-gh-bin-'));
  for (const tool of ['curl', 'tr', 'cut', 'sleep', 'bash']) {
    const real = execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
    symlinkSync(real, join(dir, tool));
  }
  return dir;
}

/** A jobs-API response containing one IT leg in the given state. */
function jobsPayload(status: string, conclusion: string | null) {
  return {
    jobs: [
      { name: 'prep', status: 'completed', conclusion: 'success' },
      { name: 'build-locale (it)', status, conclusion },
      { name: 'build-locale (fr)', status: 'in_progress', conclusion: null },
    ],
  };
}

function readinessPayload(
  jobStatus: string,
  jobConclusion: string | null,
  stepName: string | null,
  stepStatus: string = 'queued',
) {
  return {
    jobs: [
      {
        name: 'build-locale (it)',
        status: jobStatus,
        conclusion: jobConclusion,
        steps: stepName === null ? [] : [{ name: stepName, status: stepStatus, conclusion: null }],
      },
    ],
  };
}

function readinessEnv(payloads: (unknown | null)[], marker: string, expectedId: string) {
  return {
    PATH: `${fakeGhSequence(payloads)}:${process.env.PATH ?? ''}`,
    CDN_BUILD_ID_URL: markerUrl(marker),
    CDN_IT_JOB_NAME: 'build-locale (it)',
    CDN_IT_READY_STEP_NAME: EARLY_CDN_STEP,
    CDN_IT_READY_TIMEOUT_S: '1',
    CDN_IT_READY_INTERVAL_S: '1',
    CDN_WAIT_TIMEOUT_S: '1',
    CDN_WAIT_INTERVAL_S: '1',
    CDN_IT_CHECK_EVERY_N: '1',
    GH_TOKEN: 'fake-token',
    GITHUB_REPOSITORY: 'valerielinc-ops/frontaliere-si-o-no',
    GITHUB_RUN_ID: '33520063656',
    _expected: expectedId,
  };
}

describe('wait-cdn-build-id.sh — #7049 keeps readiness time out of the marker budget', () => {
  it('waits for the exact early-CDN step, then starts the FULL marker budget at zero', () => {
    const { _expected, ...env } = readinessEnv(
      [
        readinessPayload('in_progress', null, 'another step', 'in_progress'),
        readinessPayload('in_progress', null, EARLY_CDN_STEP, 'in_progress'),
      ],
      'old-build',
      'new-build',
    );
    const r = runGate([_expected], env);
    expect(r.code, 'a missing marker must still keep the shard unpublished').toBe(1);
    expect(r.outputs.cdn_ready_result).toBe('ready');
    expect(r.outputs.cdn_ready_waited_s, 'phase 1 used its own clock').toBe('1');
    expect(r.outputs.cdn_wait_result).toBe('timeout');
    expect(r.outputs.cdn_waited_s, 'phase 2 still received its full independent budget').toBe('1');
    expect(r.stdout).toMatch(/phase 1\/2 ready after 1s/);
    expect(r.stdout).toMatch(/phase 2\/2: gating shard publish/);
  });

  it('publishes only after exact readiness AND an exact marker match', () => {
    const { _expected, ...env } = readinessEnv(
      [readinessPayload('in_progress', null, EARLY_CDN_STEP, 'in_progress')],
      'new-build',
      'new-build',
    );
    const r = runGate([_expected], env);
    expect(r.code).toBe(0);
    expect(r.outputs.cdn_ready_result).toBe('ready');
    expect(r.outputs.cdn_wait_result).toBe('matched');
  });

  it('fails before marker polling when the IT job dies before the exact step', () => {
    const { _expected, ...env } = readinessEnv(
      [readinessPayload('completed', 'failure', 'Build', 'completed')],
      'new-build',
      'new-build',
    );
    const r = runGate([_expected], env);
    expect(r.code).toBe(1);
    expect(r.outputs.cdn_ready_result).toBe('it_leg_failed');
    expect(r.outputs.cdn_it_conclusion).toBe('failure');
    expect(r.outputs.cdn_waited_s, 'marker budget must remain untouched').toBe('0');
    expect(r.stdout).not.toMatch(/phase 2\/2: gating shard publish/);
  });

  it('fails closed on a bounded jobs-API uncertainty even when the marker happens to match', () => {
    const { _expected, ...env } = readinessEnv([null], 'new-build', 'new-build');
    const r = runGate([_expected], env);
    expect(r.code).toBe(1);
    expect(r.outputs.cdn_ready_result).toBe('unobservable');
    expect(r.outputs.cdn_wait_result).toBe('it_ready_unobservable');
    expect(r.outputs.cdn_ready_waited_s).toBe('1');
    expect(r.outputs.cdn_ready_api_failures, 'both bounded polls were uncertain').toBe('2');
    expect(r.outputs.cdn_waited_s).toBe('0');
    expect(r.stdout).not.toMatch(/CDN published build id/);
  });

  it('retries transient jobs-API uncertainty and proceeds only after an authoritative ready snapshot', () => {
    const { _expected, ...env } = readinessEnv(
      [null, readinessPayload('in_progress', null, EARLY_CDN_STEP, 'in_progress')],
      'new-build',
      'new-build',
    );
    const r = runGate([_expected], env);
    expect(r.code).toBe(0);
    expect(r.outputs.cdn_ready_result).toBe('ready');
    expect(r.outputs.cdn_ready_waited_s).toBe('1');
    expect(r.outputs.cdn_ready_api_failures).toBe('1');
    expect(r.outputs.cdn_wait_result).toBe('matched');
  });

  it('fails closed at the readiness deadline without spending any marker budget', () => {
    const { _expected, ...env } = readinessEnv(
      [readinessPayload('in_progress', null, 'Build', 'in_progress')],
      'new-build',
      'new-build',
    );
    const r = runGate([_expected], env);
    expect(r.code).toBe(1);
    expect(r.outputs.cdn_ready_result).toBe('timeout');
    expect(r.outputs.cdn_wait_result).toBe('it_ready_timeout');
    expect(r.outputs.cdn_ready_waited_s).toBe('1');
    expect(r.outputs.cdn_waited_s).toBe('0');
    expect(r.stdout).not.toMatch(/phase 2\/2: gating shard publish/);
  });

  it('preserves the exact-marker race: a completed early push wins over an unrelated later IT failure', () => {
    const { _expected, ...env } = readinessEnv(
      [readinessPayload('completed', 'failure', EARLY_CDN_STEP, 'completed')],
      'new-build',
      'new-build',
    );
    const r = runGate([_expected], env);
    expect(r.code, 'the exact CDN payload is live and remains safe to publish').toBe(0);
    expect(r.outputs.cdn_ready_result).toBe('ready');
    expect(r.outputs.cdn_wait_result).toBe('matched');
  });
});

/** Gate env wired for the abort, pointed at a fake `gh` serving `payload`. */
function abortEnv(payload: unknown | null, marker: string, expectedId: string) {
  return {
    PATH: `${fakeGh(payload)}:${process.env.PATH ?? ''}`,
    CDN_BUILD_ID_URL: markerUrl(marker),
    CDN_IT_JOB_NAME: 'build-locale (it)',
    GH_TOKEN: 'fake-token',
    GITHUB_REPOSITORY: 'valerielinc-ops/frontaliere-si-o-no',
    GITHUB_RUN_ID: '31202386246',
    // Deliberately generous: an abort that works must finish in a fraction of
    // it, and a missed abort must be visible as "spent the whole budget".
    CDN_WAIT_TIMEOUT_S: '6',
    CDN_WAIT_INTERVAL_S: '1',
    CDN_IT_CHECK_EVERY_N: '1',
    _expected: expectedId,
  };
}

describe('wait-cdn-build-id.sh — abort the moment the IT leg can no longer publish (#5331)', () => {
  it('IT leg completed+failure → aborts on the FIRST poll instead of burning the budget', () => {
    const { _expected, ...env } = abortEnv(jobsPayload('completed', 'failure'), 'an-older-build-id', 'the-new-build-id');
    const t0 = Date.now();
    const r = runGate([_expected], env);
    expect(r.code, 'an aborted gate must still NOT let the shard publish').toBe(1);
    // The whole point: 0s waited against a 6s budget. Before #5331 this was 6s
    // (2700s in production).
    expect(r.outputs.cdn_waited_s, 'must abort on the first poll, not at the budget').toBe('0');
    expect(Date.now() - t0, 'must return well before the budget elapses').toBeLessThan(5000);
    expect(r.outputs.cdn_wait_result).toBe('it_leg_failed');
    expect(r.outputs.cdn_it_conclusion).toBe('failure');
    expect(r.stdout).toMatch(/::error title=CDN ordering gate ABORTED \(IT leg failure\)::/);
    // Triage must land on the IT leg, not on this shard's deploy key.
    expect(r.summary).toMatch(/#5331/);
    expect(r.summary).toMatch(/Look at the IT leg/);
    expect(r.summary, 'the shard is still unpublished and the locale still stale').toMatch(/STALE/);
  });

  // ── The "not yet seen" shapes. Any one of these aborting would publish
  //    a shard ahead of the CDN — the exact defect #2569 exists to prevent.
  //
  // Each of these deliberately runs the 6s budget out (that IS the assertion:
  // `cdn_waited_s === '6'`), so nine of them cost ~60s when spawned one after
  // the other — 6% of the whole vitest suite for one file.
  const NEGATIVE_CASES: [string, unknown][] = [
    ['still in_progress', jobsPayload('in_progress', null)],
    ['queued', jobsPayload('queued', null)],
    ['completed but successful', jobsPayload('completed', 'success')],
    ['completed with a null conclusion', jobsPayload('completed', null)],
    ['skipped (never ran — not the "ran and died" shape)', jobsPayload('completed', 'skipped')],
    ['absent from the response entirely', { jobs: [{ name: 'prep', status: 'completed', conclusion: 'success' }] }],
    ['an empty job list', { jobs: [] }],
    ['a body with no jobs key at all', { message: 'Not Found' }],
    ['a failing API call', null],
  ];

  /**
   * Every gate invocation in this describe whose test does NOT measure wall
   * time, spawned in one batch instead of one after the other.
   *
   * Safe because the invocations share nothing: `abortEnv` mints a fresh fake
   * `gh` dir and a fresh marker file per call, `runGateAsync` mints a fresh
   * GITHUB_OUTPUT/GITHUB_STEP_SUMMARY pair, the env object is built per call
   * and never mutated, and the script writes nowhere else — no cwd change, no
   * module state, no fixed path. The one test that DOES time itself (the
   * first-poll abort below) is deliberately left out of the batch: its
   * `Date.now()` assertion is only meaningful on an unloaded spawn.
   */
  const gateRuns = new Map<string, GateRun>();
  const DEAD_CONCLUSIONS = ['cancelled', 'timed_out'];
  const RACE_KEY = 'race:marker-matches-anyway';

  beforeAll(async () => {
    const jobs: [string, Promise<GateRun>][] = [
      ...NEGATIVE_CASES.map(([label, payload]): [string, Promise<GateRun>] => {
        const { _expected, ...env } = abortEnv(payload, 'an-older-build-id', 'the-new-build-id');
        return [label, runGateAsync([_expected], env)];
      }),
      ...DEAD_CONCLUSIONS.map((conclusion): [string, Promise<GateRun>] => {
        const { _expected, ...env } = abortEnv(jobsPayload('completed', conclusion), 'old', 'new');
        return [conclusion, runGateAsync([_expected], env)];
      }),
      // The IT leg pushes the CDN payload early (deploy-it-pages-prep.sh's
      // DEPLOY_CDN_PUSH_ONLY phase) and can still fail in a LATER step: marker
      // and job state disagree on purpose here.
      (() => {
        const { _expected, ...env } = abortEnv(
          jobsPayload('completed', 'failure'),
          'the-new-build-id',
          'the-new-build-id',
        );
        return [RACE_KEY, runGateAsync([_expected], env)] as [string, Promise<GateRun>];
      })(),
    ];
    // The keys come from three different places — the `it.each` labels, the
    // conclusion strings, a literal — and a duplicate among them would make one
    // test silently assert against ANOTHER test's run, with no signal at all:
    // the Map would just overwrite, `recorded()` would find a value, and every
    // assertion would be evaluated against the wrong process. Today they are
    // all distinct; this is what keeps them so when a case is added.
    const keys = jobs.map(([key]) => key);
    expect(new Set(keys).size, `duplicate batch key — one test would read another's run: ${keys.join(', ')}`).toBe(
      keys.length,
    );
    const settled = await Promise.all(jobs.map(([, p]) => p));
    jobs.forEach(([key], i) => gateRuns.set(key, settled[i]));
  }, 120_000);

  /** The recorded run for `key`, with a loud failure if the batch missed it. */
  function recorded(key: string): GateRun {
    const r = gateRuns.get(key);
    expect(r, `no recorded gate run for "${key}"`).toBeDefined();
    return r as GateRun;
  }

  it('cancelled and timed_out count as dead too (same "ran and died" shape)', () => {
    for (const conclusion of DEAD_CONCLUSIONS) {
      const r = recorded(conclusion);
      expect(r.code, `${conclusion} must not publish`).toBe(1);
      expect(r.outputs.cdn_wait_result, `${conclusion} must abort early`).toBe('it_leg_failed');
      expect(r.outputs.cdn_it_conclusion).toBe(conclusion);
    }
  });

  it.each(NEGATIVE_CASES)(
    'NEGATIVE CASE — %s → keeps waiting and ends as a plain timeout, never an abort',
    (label) => {
      const r = recorded(label);
      expect(r.code, 'still must not publish — but for the OLD reason').toBe(1);
      expect(r.outputs.cdn_wait_result, 'must NOT claim the IT leg is dead').toBe('timeout');
      expect(r.outputs.cdn_it_conclusion).toBeUndefined();
      // Spent the whole budget: proof it really kept polling rather than
      // short-circuiting on an ambiguous answer.
      expect(r.outputs.cdn_waited_s).toBe('6');
      expect(r.stdout).not.toMatch(/ABORTED/);
    },
  );

  it('RACE — a marker that matches wins even when the IT leg is already dead', () => {
    // The payload IS live, so the shard is safe to publish and the abort must
    // not steal that. This is why the jobs API is consulted BEFORE the marker
    // poll: the marker read is the last word.
    const r = recorded(RACE_KEY);
    expect(r.code, 'the CDN holds this build — publishing is correct').toBe(0);
    expect(r.outputs.cdn_wait_result).toBe('matched');
    expect(r.stdout).not.toMatch(/ABORTED/);
  });

  it('the abort is OFF unless every precondition is met, and says which one is missing', async () => {
    // 1s budget, not the 6s used above: this test asserts WHICH precondition is
    // reported, and each of the four cases has to run the budget out.
    const base = { ...abortEnv(jobsPayload('completed', 'failure'), 'old', 'new'), CDN_WAIT_TIMEOUT_S: '1' };
    const cases: [string, Record<string, string>, RegExp][] = [
      ['CDN_IT_JOB_NAME unset', { CDN_IT_JOB_NAME: '' }, /CDN_IT_JOB_NAME unset/],
      ['no token', { GH_TOKEN: '', GITHUB_TOKEN: '' }, /no GH_TOKEN/],
      ['not an Actions run', { GITHUB_RUN_ID: '' }, /GITHUB_REPOSITORY\/GITHUB_RUN_ID unset/],
      // Not `PATH: ''` — the gate still needs curl/tr/cut/sleep to do its job.
      // This PATH has those and ONLY those, so `gh` is genuinely absent.
      ['gh missing', { PATH: pathWithoutGh() }, /gh CLI not on PATH/],
    ];
    // The four differ only in which env key is blanked; each still burns its own
    // budget, so they are spawned together rather than in series.
    const runs = await Promise.all(
      cases.map(([, override]) => {
        const { _expected, ...env } = { ...base, ...override };
        return runGateAsync([_expected], env);
      }),
    );
    cases.forEach(([label, , why], i) => {
      const r = runs[i];
      // Degrades to the pre-#5331 behaviour — never to an early publish.
      expect(r.code, `${label}: must still refuse to publish`).toBe(1);
      expect(r.outputs.cdn_wait_result, `${label}: must fall back to the plain timeout`).toBe('timeout');
      expect(r.stdout, `${label}: must name the missing precondition`).toMatch(why);
    });
  });
});

describe('deploy.yml — the #5331 abort is actually wired to the gate step', () => {
  it('the gate step gets the IT job name, a token, and the job gets actions: read', () => {
    const gate = step('Wait for IT CDN push (cross-shard ordering guard)');
    // The job DISPLAY name, which is what the jobs API returns for a matrix leg.
    expect(gate, 'gate must know which job to watch').toMatch(/CDN_IT_JOB_NAME: build-locale \(it\)/);
    expect(gate, 'the jobs API call needs a token').toMatch(/GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
    const jobStart = DEPLOY_YML.indexOf('\n  build-locale:');
    expect(jobStart, 'build-locale job not found').toBeGreaterThan(-1);
    const job = DEPLOY_YML.slice(jobStart, DEPLOY_YML.indexOf('\n    steps:', jobStart));
    expect(job, 'reading this run’s job list needs actions: read').toMatch(/^ {6}actions: read$/m);
  });

  it('the name in CDN_IT_JOB_NAME matches a real matrix job, so a rename cannot silently disarm it', () => {
    const doc = YAML.parse(DEPLOY_YML) as { jobs: Record<string, { strategy?: { matrix?: unknown } }> };
    // `build-locale (it)` = job key + the matrix value in parentheses. Both
    // halves must exist; a wrong name would disarm the abort (safe, but silent),
    // which is exactly what this assertion is here to stop.
    expect(Object.keys(doc.jobs), 'the watched job key must exist').toContain('build-locale');
    expect(doc.jobs['build-locale'].strategy?.matrix, 'build-locale must still be a matrix job').toBeTruthy();
    expect(DEPLOY_YML, 'the matrix must still be keyed on `locale`').toMatch(/matrix:\n\s+locale:/);
  });

  it('#7049 wires the exact early-CDN step to a separate bounded phase without shrinking the marker budget', () => {
    const gate = step('Wait for IT CDN push (cross-shard ordering guard)');
    expect(gate).toContain(`CDN_IT_READY_STEP_NAME: ${EARLY_CDN_STEP}`);
    expect(gate, 'the readiness phase has its own explicit three-hour ceiling').toMatch(
      /CDN_IT_READY_TIMEOUT_S: 10800/,
    );
    expect(gate, 'jobs API polling stays bounded and explicit').toMatch(/CDN_IT_READY_INTERVAL_S: 30/);
    expect(gate, 'the historical exact-marker budget must remain unchanged').toMatch(/CDN_WAIT_TIMEOUT_S: 2700/);
    expect(
      step(EARLY_CDN_STEP),
      'the configured observer must name the real IT-only early push, not a stale sibling title',
    ).toMatch(/if: matrix\.locale == 'it'/);
  });

  it('the surfacing step distinguishes the two failure shapes in the issue it files', () => {
    const s = step('Surface an unpublished locale shard (#2569 CDN ordering gate timed out)');
    // Both outputs bound via env: (never interpolated into run: text) — the same
    // rule the cdn_last_seen test above pins for network-sourced values.
    expect(s).toMatch(/CDN_IT_CONCLUSION: \$\{\{ steps\.cdn-gate\.outputs\.cdn_it_conclusion \}\}/);
    expect(s).toMatch(/CDN_WAIT_RESULT: \$\{\{ steps\.cdn-gate\.outputs\.cdn_wait_result \}\}/);
    // A gate that aborted in 3 minutes must not be described as having spent
    // its budget: that wording is what makes a reader reach for the shard repo.
    expect(s, 'the body must branch on whether the IT conclusion was read').toMatch(
      /if \[ -n "\$\{CDN_IT_CONCLUSION:-\}" \]/,
    );
    expect(s, 'the abort branch must name the IT leg as the thing to fix').toMatch(/Fix the IT leg/);
  });

  it('the surfacing step reports readiness failures separately from marker timeouts', () => {
    const s = step('Surface an unpublished locale shard (#2569 CDN ordering gate timed out)');
    for (const out of [
      'cdn_ready_result',
      'cdn_ready_waited_s',
      'cdn_ready_timeout_s',
      'cdn_ready_api_failures',
    ]) {
      expect(s).toMatch(new RegExp(`steps\\.cdn-gate\\.outputs\\.${out}`));
    }
    expect(s).toMatch(/\[ "\$\{CDN_READY_RESULT\}" != 'ready' \]/);
    expect(s).toMatch(/marker budget was never started/);
    expect(s).toMatch(/jobs-API observability/);
  });
});

// ── scripts/lib/deploy-it-pages-prep.sh — the two phases ─────────────────────
function runPrep(env: Record<string, string>): { code: number; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'prep-'));
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'index.html'), '<!doctype html><title>t</title>');
  try {
    const stdout = execFileSync('bash', [PREP_SH], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '', RUNNER_TEMP: dir, ...env },
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: Buffer | string };
    return { code: err.status ?? 1, stdout: err.stdout?.toString() ?? '' };
  }
}

describe('deploy-it-pages-prep.sh — DEPLOY_CDN_PUSH_ONLY runs the CDN push and nothing else', () => {
  it('with the flag: the early phase returns after the CDN push, without touching the rest of the prep', () => {
    const r = runPrep({ DEPLOY_CDN_PUSH_ONLY: '1', CDN_TARGET: 'pages' });
    expect(r.code, 'the early phase must never fail the leg').toBe(0);
    expect(r.stdout, 'must run the CDN push section').toMatch(/no offloadable assets present|skipping CDN push|CDN payload/);
    // The full prep's terminal marker must NOT appear: the tar pack, the byte
    // audit and url-first-seen all still belong to the later step.
    expect(r.stdout, 'the early phase must not run the whole prep').not.toMatch(/deploy-it-pages-prep complete/);
    expect(r.stdout).toMatch(/early CDN push/);
  });

  it('NEGATIVE CASE — without the flag the SAME invocation goes on past the CDN push', () => {
    // Proves the flag is what stops the script, not an unrelated early return:
    // unflagged, execution reaches the fatal drop-assets/tar section (and, in
    // this bare temp dir with no CDN push, fails there).
    const r = runPrep({ CDN_TARGET: 'pages' });
    expect(r.stdout, 'unflagged run must not stop at the early phase').not.toMatch(/early CDN push/);
    expect(
      r.stdout + String(r.code),
      'unflagged run must proceed past the CDN push into the rest of the prep',
    ).toMatch(/deploy-it-pages-prep complete|FATAL step failed|Packed|sitemap/);
  });

  it('a CDN_BASE already exported by the early phase makes the full prep SKIP its own push', () => {
    // This is the handshake that keeps the payload published exactly once.
    const r = runPrep({ CDN_BASE: 'https://cdn.frontaliereticino.ch', CDN_TARGET: 'pages' });
    expect(r.stdout).toMatch(/already set by the early CDN push phase — skipping the CDN push/);
  });

  it('NEGATIVE CASE — without CDN_BASE the full prep still performs the push itself', () => {
    // The pre-hoist behaviour must survive verbatim, so a failed early push
    // degrades to "pushed at the original position", never to "never pushed".
    const r = runPrep({ CDN_TARGET: 'pages' });
    expect(r.stdout).not.toMatch(/skipping the CDN push/);
    expect(r.stdout).toMatch(/no offloadable assets present|skipping CDN push, assets stay in dist|CDN payload/);
  });
});

describe('deploy.yml — the paths-ignore denylist keeps its recorded verdict', () => {
  it('records that paths-ignore does not apply to workflow_dispatch (the #5251 measurement)', () => {
    // Not decoration: the obvious "fix" for the cancelled-run count is to widen
    // this denylist, and it would move 0 of the 40/141 dispatch-triggered runs.
    // If someone deletes the note, the next diagnosis repeats the mistake.
    const head = DEPLOY_YML.slice(0, DEPLOY_YML.indexOf('paths-ignore:'));
    expect(head).toMatch(/workflow_dispatch/);
    expect(head).toMatch(/trigger-deploy\.sh/);
    expect(head).toMatch(/#5251/);
  });
});

describe('deploy.yml — a step name must survive YAML parsing intact', () => {
  // Caught for real while writing this file: `- name: Surface a #2569 CDN
  // ordering-gate timeout (…)` parses as the step name "Surface a" — YAML
  // treats a `#` preceded by whitespace as a comment, so the rest of the name
  // is silently discarded. Every text-level assertion in this file still
  // passed (they read the raw file), the workflow was still valid, and the
  // Actions UI would have shown a step called "Surface a". The rule that makes
  // it impossible: no step name may lose characters between the raw
  // `- name: …` line and the parsed value.
  it('every step name in deploy.yml parses to exactly what the file says', () => {
    const doc = YAML.parse(DEPLOY_YML) as {
      jobs: Record<string, { steps?: { name?: string }[] }>;
    };
    const parsed: string[] = [];
    for (const job of Object.values(doc.jobs)) {
      for (const s of job.steps ?? []) if (s?.name) parsed.push(s.name);
    }
    expect(parsed.length, 'expected named steps in deploy.yml').toBeGreaterThan(20);
    const raw = [...DEPLOY_YML.matchAll(/^\s*- name: (.+)$/gm)].map((m) => m[1].trim());
    for (const line of raw) {
      // Quoted names are exempt: YAML does not comment inside a quoted scalar.
      if (/^['"]/.test(line)) continue;
      expect(
        parsed,
        `step name "${line}" is truncated by YAML comment handling (a " #" in an unquoted name) — quote it or drop the space before "#"`,
      ).toContain(line);
    }
  });
});
