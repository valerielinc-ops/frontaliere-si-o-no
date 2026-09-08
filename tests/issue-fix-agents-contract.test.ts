import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import {
  AGENTS_REQUIRED_SECTIONS,
  extractSectionByHeading,
} from '../scripts/ci/redflag-doc-sections.mjs';

const ROOT = process.cwd();
const WORKFLOW = join(ROOT, '.github/workflows/issue-fix.yml');
const SCRIPT = join(ROOT, 'scripts/ci/redflag-doc-sections.mjs');
const AGENTS = join(ROOT, 'AGENTS.md');

function tierRun(): string {
  const workflow: any = YAML.parse(readFileSync(WORKFLOW, 'utf8'));
  const step = workflow?.jobs?.fix?.steps?.find((candidate: any) => candidate?.id === 'tier');
  expect(step?.run, 'the zero-Claude tier step is missing').toEqual(expect.any(String));
  return step.run;
}

function fixerPrompt(): string {
  const workflow: any = YAML.parse(readFileSync(WORKFLOW, 'utf8'));
  const step = workflow?.jobs?.fix?.steps?.find(
    (candidate: any) => candidate?.uses === 'anthropics/claude-code-action@v1',
  );
  expect(step?.with?.prompt, 'the Claude prompt is missing').toEqual(expect.any(String));
  return step.with.prompt;
}

describe('issue-fix delivers the binding AGENTS contract before Claude', () => {
  it('connects the real non-negotiables to the prompt through the zero-Claude output', () => {
    const run = tierRun();
    const prompt = fixerPrompt();
    const result = spawnSync(process.execPath, [SCRIPT, '--agents-only'], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(Buffer.byteLength(readFileSync(AGENTS))).toBeLessThanOrEqual(30000);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(12288);
    expect(result.stdout).toContain('# Issue-fix: contratto AGENTS.md vincolante');
    expect(result.stdout).toContain('## AGENTS.md — Non-Negotiables');
    expect(result.stdout).toContain('## AGENTS.md — Privacy');
    expect(result.stdout).toContain('Mai disabilitare AdSense Auto Ads');
    expect(result.stdout).toContain('Git identity canonica');
    for (const { file, heading } of AGENTS_REQUIRED_SECTIONS) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      expect(result.stdout).toContain(extractSectionByHeading(source, heading));
    }

    expect(run).toContain('AGENTS_CONTRACT_FILE="AGENTS.md"');
    expect(run).toContain('AGENTS_CONTRACT_MAX_BYTES=12288');
    expect(run).toContain('REDFLAG_DOC_ROOT=. node scripts/ci/redflag-doc-sections.mjs --agents-only');
    expect(run).toContain('agents_contract<<AGENTS_CONTRACT_EOF');
    expect(run).toContain('cat "$CTX_DIR/agents-contract.md"');

    const outputReference = '${{ steps.tier.outputs.agents_contract }}';
    expect(prompt).toContain(outputReference);
    expect(prompt.indexOf(outputReference)).toBeLessThan(prompt.indexOf('**Bootstrap'));
    expect(prompt).toContain('prefetch zero-Claude');
    expect(prompt).not.toContain('Leggi `AGENTS.md` — non-negotiables + Privacy + architettura. VINCOLANTE.');
  });
});
