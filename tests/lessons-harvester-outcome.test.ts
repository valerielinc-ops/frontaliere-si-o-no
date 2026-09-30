/**
 * lessons-harvester.yml — verde falso e gate dichiarato.
 *
 * La run 36336838172 e' finita verde con 0 PR: `gh pr create` era uscito con
 * codice 3 e niente distingueva «Codex ha deciso di non aprire la PR» da «non
 * ci e' riuscito». Ora Codex scrive `lessons-harvester-outcome.txt` e lo step
 * `Verify proposal outcome` lo confronta con PR e branch reali. Qui lo step
 * viene ESEGUITO con un `gh` finto, caso per caso.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import YAML from 'yaml';

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/lessons-harvester.yml'), 'utf8');
const steps: Array<Record<string, any>> = YAML.parse(WORKFLOW).jobs.harvest.steps;
const codexIndex = steps.findIndex((s) => s.uses === './.github/actions/claude-codex-fallback');
const verifyIndex = steps.findIndex((s) => String(s.name).startsWith('Verify proposal outcome'));
const STARTED_AT = '2026-09-28T05:20:00Z';

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'lessons-outcome-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'gh'), [
    '#!/bin/bash',
    'case "$*" in',
    '  *matching-refs*) printf \'%b\' "${STUB_REFS:-}" ;;',
    '  *commits/*) echo "${STUB_COMMIT_DATE:-2026-09-28T05:00:00Z}" ;;',
    '  "pr view"*) printf \'%b\\n\' "${STUB_PR:-}" ;;',
    'esac',
  ].join('\n'));
  chmodSync(join(dir, 'bin', 'gh'), 0o755);
  writeFileSync(join(dir, 'verify.sh'), steps[verifyIndex].run);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function verify(outcome: string | null, stub: Record<string, string> = {}) {
  rmSync(join(dir, 'lessons-harvester-outcome.txt'), { force: true });
  if (outcome !== null) writeFileSync(join(dir, 'lessons-harvester-outcome.txt'), `${outcome}\n`);
  const r = spawnSync('bash', ['-euo', 'pipefail', join(dir, 'verify.sh')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...stub, PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      REPO: 'valerielinc-ops/frontaliere-si-o-no', STARTED_AT },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const openPr = 'OPEN\tlessons/auto-harvest-20260928\t2026-09-28T05:31:00Z\tvalerielinc-ops';

describe('lessons-harvester.yml — lo step di verifica dell\'esito', () => {
  it('sta dopo lo step Codex e gira anche se quello fallisce', () => {
    expect(codexIndex).toBeGreaterThan(-1);
    expect(verifyIndex).toBeGreaterThan(codexIndex);
    expect(steps[verifyIndex].if).toMatch(/^always\(\) && /);
    expect(steps[verifyIndex].env.STARTED_AT).toContain('steps.guard.outputs.started_at');
  });

  it('file d\'esito assente → rosso (era il verde della run 36336838172)', () => {
    const r = verify(null);
    expect(r.code).toBe(1);
    expect(r.out).toContain('assente o vuoto');
  });

  it('failed:<causa> → rosso', () => {
    expect(verify('failed:gh pr create exit 3').code).toBe(1);
  });

  it('none:<motivo> senza branch nuovi → verde', () => {
    expect(verify('none:ogni cluster gia registrato').code).toBe(0);
  });

  it('none: con un branch lessons/auto-harvest-* pushato in questa run → rosso', () => {
    const r = verify('none:niente', {
      STUB_REFS: 'refs/heads/lessons/auto-harvest-20260928\tabc\n', STUB_COMMIT_DATE: '2026-09-28T05:30:00Z' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('branch lessons/auto-harvest-* e\' stato pushato');
  });

  it('none: con un branch vecchio (run precedente) → verde', () => {
    expect(verify('none:niente', {
      STUB_REFS: 'refs/heads/lessons/auto-harvest-20260901\tabc\n', STUB_COMMIT_DATE: '2026-09-01T05:30:00Z' }).code).toBe(0);
  });

  it('pr:<N> di una PR aperta in questa run → verde', () => {
    expect(verify('pr:10300', { STUB_PR: openPr }).code).toBe(0);
  });

  it('replay NOVEL>0: scrive il cluster, l outcome pr:<N> passa, senza outcome fallisce', () => {
    const harvestDir = mkdtempSync(join(tmpdir(), 'lessons-novel-replay-'));
    try {
      const binDir = join(harvestDir, 'bin');
      mkdirSync(binDir);
      const fakeGh = join(binDir, 'gh');
      writeFileSync(fakeGh, `#!/bin/bash
case "$*" in
  *"pr list"*) printf '%s' "$HARVEST_PR_JSON" ;;
  *"issue list"*) printf '%s' '[]' ;;
  *"issue view"*) printf '%s' '{"comments":[]}' ;;
  *"api"*) printf '%s' '[]' ;;
  *) printf '%s' '[]' ;;
esac
`);
      chmodSync(fakeGh, 0o755);

      const harvestOut = join(harvestDir, 'harvest-clusters.json');
      const harvestRegistry = join(harvestDir, 'registry.json');
      const githubOutput = join(harvestDir, 'github-output.txt');
      writeFileSync(harvestRegistry, JSON.stringify({ entries: [] }));
      const reviewLine = '🔴 Important: a never-before-seen zebraquartz sentinel regression in the transfer path.';
      const harvestPr = JSON.stringify([{
        number: 10401,
        mergedAt: new Date().toISOString(),
        reviews: [{ author: { login: 'claude' }, body: `## Findings\n${reviewLine}\n` }],
      }]);
      const run = spawnSync(process.execPath, [join(ROOT, 'scripts/ci/harvest-agent-lessons.mjs')], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH || ''}`,
          HARVEST_PR_JSON: harvestPr,
          HARVEST_OUT: harvestOut,
          HARVEST_REGISTRY: harvestRegistry,
          GITHUB_OUTPUT: githubOutput,
          WINDOW_DAYS: '0',
          THRESHOLD: '1',
          MAX_PRS: '0',
          MAX_ISSUES: '0',
          FOLLOWUP_NO_AUTOCLOSE: '1',
          HARVEST_EMIT_ESCALATIONS: 'false',
        },
      });
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);

      const harvest = JSON.parse(readFileSync(harvestOut, 'utf8'));
      expect(harvest.novelClusters).toBeGreaterThan(0);
      const novel = harvest.clusters.find((cluster: { novel?: boolean }) => cluster.novel);
      expect(novel).toMatchObject({
        source: 'reviewer-finding',
        novel: true,
        alreadyDocumented: false,
      });
      expect(novel.registryKey).toBe(`reviewer-finding/${novel.key}`);
      expect(readFileSync(githubOutput, 'utf8')).toMatch(/has_novel=true\nnovel_count=\d+/u);

      writeFileSync(join(dir, 'lessons-harvester-outcome.txt'), 'pr:10300\n');
      expect(readFileSync(join(dir, 'lessons-harvester-outcome.txt'), 'utf8')).toBe('pr:10300\n');
      expect(verify('pr:10300', { STUB_PR: openPr }).code).toBe(0);

      const missing = verify(null);
      expect(missing.code).toBe(1);
      expect(missing.out).toContain('assente o vuoto');
    } finally {
      rmSync(harvestDir, { recursive: true, force: true });
    }
  });

  it('pr:<N> incoerente (altro branch, prima della run, chiusa, o inesistente) → rosso', () => {
    expect(verify('pr:10300', { STUB_PR: openPr.replace('lessons/auto-harvest-20260928', 'fix/other') }).code).toBe(1);
    expect(verify('pr:10300', { STUB_PR: openPr.replace('2026-09-28T05:31:00Z', '2026-09-27T05:31:00Z') }).code).toBe(1);
    expect(verify('pr:10300', { STUB_PR: openPr.replace('OPEN', 'CLOSED') }).code).toBe(1);
    expect(verify('pr:10300', { STUB_PR: '' }).code).toBe(1);
    expect(verify('pr:abc').code).toBe(1);
  });

  it('esito non riconosciuto o none: senza motivo → rosso', () => {
    expect(verify('boh').code).toBe(1);
    expect(verify('none:').code).toBe(1);
  });
});

describe('lessons-harvester.yml — il gate dichiarato e\' quello reale', () => {
  const prompt = String(steps[codexIndex].with.prompt);

  it('nessuna promessa di gate umano che nessun meccanismo applica', () => {
    expect(WORKFLOW).not.toMatch(/never auto-merged|Human-gated|la rivede un umano/u);
    expect(prompt).toContain('auto-merge nativo');
  });

  it('il prompt chiede a Codex registro ed esito', () => {
    expect(prompt).toContain('scripts/ci/lessons-harvester-registry.json');
    expect(prompt).toContain('lessons-harvester-outcome.txt');
    expect(prompt).toMatch(/`pr:<N>`[\s\S]*`none:<motivo>`[\s\S]*`failed:<causa>`/u);
  });
});
