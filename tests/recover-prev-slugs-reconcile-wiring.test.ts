/**
 * recover-prev-slugs.yml — duplicate stable-id records collapse BEFORE
 * scan/backfill run (#5348 genuine post-backfill residual).
 *
 * Root cause: a dedicated-crawler slice can hold two records sharing the
 * same `.id` (e.g. banca-cler's /de/bank-cler/... vs /it/banca-cler/... URL
 * variants of the same requisition), each with its own previousSlugs
 * history. backfill-prev-slugs-from-loss-events.mjs's resolveRecoveryTarget()
 * redirects a recovered slug onto ONE of the two duplicate objects via a
 * `bySuffixHash` map (first-wins) while the post-backfill rescan looks the
 * job up via `Array.find()` (also first-array-match) against a DIFFERENT
 * in-memory object keyed by `byId` (last-wins) — so the recovered slug can
 * land on the object the rescan never checks, and the job stays "still
 * missing" no matter how well backfill runs. No amount of backfill retrying
 * can fix a loss that lives in the duplication itself.
 *
 * scripts/reconcile-duplicate-stable-id-jobs.mjs already existed for this
 * exact class (issue #4603) — idempotent, dry-run by default — but was never
 * wired into a workflow. These tests verify it now runs before scan/backfill
 * and that its output gates the commit step the same way scan's does.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';

const WORKFLOW = new URL('../.github/workflows/recover-prev-slugs.yml', import.meta.url);

type Step = { name?: string; id?: string; if?: string; env?: Record<string, string>; run?: string };
let steps: Step[];
let reconcile: Step;
let scan: Step;
let commit: Step;

beforeAll(() => {
  const doc = parse(readFileSync(WORKFLOW, 'utf8'));
  steps = doc.jobs.recover.steps as Step[];
  reconcile = steps.find((s) => s.id === 'reconcile')!;
  scan = steps.find((s) => s.id === 'scan')!;
  commit = steps.find((s) => s.name === 'Commit and push restored slices')!;
});

describe('recover-prev-slugs.yml — wiring del reconcile duplicate stable-id', () => {
  it('esiste uno step reconcile che invoca lo script dedicato', () => {
    expect(reconcile).toBeTruthy();
    expect(reconcile.run).toContain('scripts/reconcile-duplicate-stable-id-jobs.mjs');
  });

  it('il reconcile gira PRIMA dello scan — deduplica la slice prima che scan/backfill la leggano', () => {
    const order = steps.map((s) => s.name || s.id);
    const reconcileIdx = order.indexOf(reconcile.name!);
    const scanIdx = order.indexOf(scan.name!);
    expect(reconcileIdx).toBeGreaterThan(-1);
    expect(scanIdx).toBeGreaterThan(reconcileIdx);
  });

  it('rispetta dry_run — non passa --apply quando dry_run=true', () => {
    expect(reconcile.run).toContain('DRY_RUN');
    expect(reconcile.run).toMatch(/if \[ "\$DRY_RUN" = "true" \]; then APPLY_FLAG=""; fi/);
  });

  it('il commit gate include anche il residuo del reconcile, non solo quello dello scan', () => {
    expect(commit.if).toContain('steps.scan.outputs.recoverable_slugs');
    expect(commit.if).toContain('steps.reconcile.outputs.reconciled_dropped');
  });
});

describe('recover-prev-slugs.yml — parsing del report reconcile (script reale)', () => {
  /** Runs the reconcile step's REAL shell body against a stubbed `node`. */
  function runReconcile(env: Record<string, string>, cwd: string, nodeOutput: string) {
    mkdirSync(path.join(cwd, 'bin'), { recursive: true });
    const nodeShim = path.join(cwd, 'bin', 'node');
    writeFileSync(nodeShim, `#!/bin/bash\ncat <<'EOF'\n${nodeOutput}\nEOF\n`);
    chmodSync(nodeShim, 0o755);

    const script = reconcile.run!;
    const scriptPath = path.join(cwd, 'reconcile.sh');
    writeFileSync(scriptPath, script);
    const stepSummary = path.join(cwd, 'step-summary.txt');
    try {
      const stdout = execFileSync('bash', [scriptPath], {
        cwd,
        encoding: 'utf-8',
        env: {
          ...process.env,
          PATH: `${path.join(cwd, 'bin')}:${process.env.PATH}`,
          GITHUB_OUTPUT: path.join(cwd, 'github-output.txt'),
          GITHUB_STEP_SUMMARY: stepSummary,
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      writeFileSync(path.join(cwd, 'github-output-checked.txt'), '1');
      const output = readFileSync(path.join(cwd, 'github-output.txt'), 'utf-8');
      return { status: 0, stdout, output };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { status: err.status ?? 1, stdout: `${err.stdout || ''}${err.stderr || ''}`, output: '' };
    }
  }

  it('estrae reconciled_dropped da un report con duplicati trovati e --apply', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'prev-slug-reconcile-'));
    const r = runReconcile(
      { DRY_RUN: 'false' },
      dir,
      'banca-cler.json: 15 → 14 jobs\n\nApplied: 1 duplicate-id group(s), 1 record(s) collapsed, 1 needsRetranslation mark(s) carried onto a survivor.\n  - banca-cler.json: id=company-sbman6 — kept https://example.test (crawledAt=2026-08-15T21:29:59.657Z), dropped 1',
    );
    expect(r.status).toBe(0);
    expect(r.output).toContain('reconciled_dropped=1');
  });

  it('estrae 0 quando non ci sono duplicati (idempotente)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'prev-slug-reconcile-'));
    const r = runReconcile(
      { DRY_RUN: 'false' },
      dir,
      '\nApplied: 0 duplicate-id group(s), 0 record(s) collapsed, 0 needsRetranslation mark(s) carried onto a survivor.',
    );
    expect(r.status).toBe(0);
    expect(r.output).toContain('reconciled_dropped=0');
  });

  it('in dry-run riporta comunque il conteggio (Dry-run: ...) senza scrivere', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'prev-slug-reconcile-'));
    const r = runReconcile(
      { DRY_RUN: 'true' },
      dir,
      '\nDry-run: 2 duplicate-id group(s), 3 record(s) collapsed, 0 needsRetranslation mark(s) carried onto a survivor.',
    );
    expect(r.status).toBe(0);
    expect(r.output).toContain('reconciled_dropped=3');
  });

  it('fail-loud (#5954): nessuna riga Applied:/Dry-run: nel report → step fallisce, non reconciled_dropped=0', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'prev-slug-reconcile-'));
    const r = runReconcile(
      { DRY_RUN: 'false' },
      dir,
      'banca-cler.json: 15 → 14 jobs\n\nSome unrelated format-drifted summary line with no prefix at all.',
    );
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('format drift');
    expect(r.output).not.toContain('reconciled_dropped=0');
  });

  it('fail-loud (#5954): riga con prefisso ma shape diversa → step fallisce, non reconciled_dropped=0', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'prev-slug-reconcile-'));
    const r = runReconcile(
      { DRY_RUN: 'false' },
      dir,
      '\nApplied: reconciled 1 duplicate group, dropped 1 record onto a survivor.',
    );
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('did not match the expected');
    expect(r.output).not.toContain('reconciled_dropped=0');
  });
});
