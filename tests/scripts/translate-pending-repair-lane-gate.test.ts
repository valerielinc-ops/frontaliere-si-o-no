import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  DEFAULT_REPAIR_LANE_DEADLINE_MS,
  DEFAULT_REPAIR_LANE_MIN_REMAINING_MS,
  decideRepairLane,
  describeDecision,
} from '../../scripts/translate-repair-lane-gate.mjs';

/**
 * Le fasi 2d/2e di translate-pending (e il broker Codex che le serve) partono
 * solo se l'involucro run-wide di 210 minuti ha ancora almeno 15 minuti.
 * Misurato sul corpus: 36240711198 (2d a 215min: broker 21s, 0 tradotti, commit
 * vuoto 137s) e 36169299281 (2e a 252min: broker 22s, commit vuoto 850s, poi il
 * job ucciso al tetto dei 350min). Ogni partenza produttiva misurata aveva
 * almeno 57 minuti residui.
 */
type Step = { id?: string; name?: string; uses?: string; if?: string; env?: Record<string, unknown>; run?: string };

const TARGETS = [
  '.github/workflows/translate-pending-logic.yml',
  '.github/corpus-workflows/translate-pending.yml',
];
const GATE_OUTPUT = "steps.repair_lane_budget.outputs.run == 'true'";
const GATED = [
  (step: Step) => step.id === 'setup_claude_haiku_fallback',
  (step: Step) => step.name === 'Phase 2d: Fix untranslated titles (free cascade)',
  (step: Step) => step.name === 'Commit title fixes',
  (step: Step) => step.name === 'Phase 2e: Fix untranslated descriptions (free cascade)',
  (step: Step) => step.name === 'Commit description fixes',
];

function stepsOf(rel: string): Step[] {
  const workflow = YAML.parse(fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8')) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  return workflow.jobs.translate.steps;
}

describe.each(TARGETS)('translate-pending: gate di budget per 2d/2e (%s)', (rel) => {
  const steps = stepsOf(rel);
  const gateAt = steps.findIndex((step) => step.id === 'repair_lane_budget');
  const gate = steps[gateAt];

  it('il gate precede il broker Codex e usa la stessa scadenza delle fasi', () => {
    expect(gateAt).toBeGreaterThan(0);
    expect(gate.run).toBe('node scripts/translate-repair-lane-gate.mjs');
    expect(gate).not.toHaveProperty('continue-on-error');
    const brokerAt = steps.findIndex((step) => step.id === 'setup_claude_haiku_fallback');
    expect(gateAt).toBeLessThan(brokerAt);
    const commitTranslationsAt = steps.findIndex((step) => step.id === 'commit_translations');
    expect(commitTranslationsAt).toBeGreaterThanOrEqual(0);
    expect(gateAt).toBeGreaterThan(commitTranslationsAt);

    const titleFix = steps.find((step) => step.name === 'Phase 2d: Fix untranslated titles (free cascade)');
    expect(gate.env?.REPAIR_LANE_DEADLINE_MS).toBe(titleFix?.env?.UNTRANSLATED_TITLE_FIX_DEADLINE_MS);
    // La soglia vale almeno un budget Codex della fase: sotto, la corsia non
    // potrebbe spenderlo e restano solo i costi fissi.
    expect(Number(gate.env?.REPAIR_LANE_MIN_REMAINING_MS))
      .toBeGreaterThanOrEqual(Number(titleFix?.env?.FREE_TRANSLATE_CODEX_MAX_MS));
  });

  it('broker, fasi 2d/2e e i loro commit partono solo col via del gate', () => {
    for (const predicate of GATED) {
      const index = steps.findIndex(predicate);
      expect(index).toBeGreaterThan(gateAt);
      expect(steps[index].if ?? '', steps[index].name ?? steps[index].id).toContain(GATE_OUTPUT);
    }
    // Nessun altro step dipende dal gate: il resto della coda (slug, cache,
    // deploy) deve continuare a girare anche quando le corsie sono saltate.
    const dependents = steps.filter((step) => (step.if ?? '').includes('repair_lane_budget'));
    expect(dependents).toHaveLength(GATED.length);
  });
});

describe('decideRepairLane', () => {
  const start = 1_000_000;
  const minute = 60_000;
  const decide = (elapsedMin: number) => decideRepairLane({
    startMs: start,
    nowMs: start + elapsedMin * minute,
    deadlineMs: DEFAULT_REPAIR_LANE_DEADLINE_MS,
    minRemainingMs: DEFAULT_REPAIR_LANE_MIN_REMAINING_MS,
  });

  it('lascia partire le corsie nei tempi misurati delle run produttive', () => {
    for (const elapsed of [99, 108, 153]) expect(decide(elapsed).run).toBe(true);
  });

  it('salta le corsie alle partenze tardive misurate e sotto la soglia', () => {
    for (const elapsed of [215, 252, 304]) expect(decide(elapsed).run).toBe(false);
    expect(decide(195).run).toBe(true);
    expect(decide(195.5).run).toBe(false);
  });

  it('spiega il salto con residuo e soglia', () => {
    expect(describeDecision(decide(215))).toMatch(/skipped: 215min elapsed .* deadline passed 5min ago \(threshold 15min\)/);
    expect(describeDecision(decide(200))).toMatch(/skipped: .*only 10min left/);
    expect(describeDecision(decide(100))).toMatch(/start: .*110min left/);
  });
});

describe('translate-repair-lane-gate CLI', () => {
  function run(elapsedMs: number) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-lane-gate-'));
    fs.writeFileSync(path.join(dir, 'translate-pending-run-start.txt'), String(Date.now() - elapsedMs));
    const output = path.join(dir, 'github-output');
    const result = spawnSync(process.execPath, [path.resolve('scripts/translate-repair-lane-gate.mjs')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RUNNER_TEMP: dir,
        GITHUB_OUTPUT: output,
        TRANSLATE_RUN_CLOCK_REQUIRED: '1',
        REPAIR_LANE_DEADLINE_MS: '12600000',
        REPAIR_LANE_MIN_REMAINING_MS: '900000',
      },
    });
    return { result, output: fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '' };
  }

  it('scrive run=false e una notice quando la scadenza e\' passata', () => {
    const { result, output } = run(215 * 60_000);
    expect(result.status).toBe(0);
    expect(output).toBe('run=false\n');
    expect(result.stdout).toContain('::notice title=translate-pending repair lanes skipped::');
    expect(result.stdout).toContain('Codex auth broker not started');
  });

  it('scrive run=true quando il budget basta', () => {
    const { result, output } = run(100 * 60_000);
    expect(result.status).toBe(0);
    expect(output).toBe('run=true\n');
    expect(result.stdout).not.toContain('::notice');
  });

  it('fallisce forte se manca il marker del clock condiviso', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-lane-gate-'));
    const result = spawnSync(process.execPath, [path.resolve('scripts/translate-repair-lane-gate.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, RUNNER_TEMP: dir, GITHUB_OUTPUT: path.join(dir, 'out'), TRANSLATE_RUN_CLOCK_REQUIRED: '1' },
    });
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(path.join(dir, 'out'))).toBe(false);
  });
});
