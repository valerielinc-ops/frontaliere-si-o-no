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
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import YAML from 'yaml';

const DEPLOY_YML = readFileSync(resolve('.github/workflows/deploy.yml'), 'utf8');
const PREP_SH = resolve('scripts/lib/deploy-it-pages-prep.sh');
const GATE_SH = resolve('scripts/lib/wait-cdn-build-id.sh');

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

function runGate(args: string[], env: Record<string, string> = {}): GateRun {
  const dir = mkdtempSync(join(tmpdir(), 'cdn-gate-'));
  const outFile = join(dir, 'output');
  const sumFile = join(dir, 'summary');
  writeFileSync(outFile, '');
  writeFileSync(sumFile, '');
  let code = 0;
  let stdout = '';
  try {
    stdout = execFileSync('bash', [GATE_SH, ...args], {
      env: { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: sumFile, ...env },
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: Buffer | string };
    code = err.status ?? 1;
    stdout = err.stdout?.toString() ?? '';
  }
  const outputs: Record<string, string> = {};
  for (const line of readFileSync(outFile, 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return { code, stdout, outputs, summary: readFileSync(sumFile, 'utf8') };
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
