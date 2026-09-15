import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import {
  AGENTS_REQUIRED_SECTIONS,
  extractSectionByHeading,
} from '../scripts/ci/redflag-doc-sections.mjs';
import { MAX_SOURCE_BYTES } from '../scripts/ci/issue-fix-read-budget.mjs';

const ROOT = process.cwd();
const WORKFLOW = join(ROOT, '.github/workflows/issue-fix.yml');
const SCRIPT = join(ROOT, 'scripts/ci/redflag-doc-sections.mjs');
const AGENTS = join(ROOT, 'AGENTS.md');
const BASH_HOOK = join(ROOT, 'scripts/ci/sibling-check-gate.mjs');

function tierRun(): string {
  const workflow: any = YAML.parse(readFileSync(WORKFLOW, 'utf8'));
  const step = workflow?.jobs?.fix?.steps?.find((candidate: any) => candidate?.id === 'tier');
  expect(step?.run, 'the zero-Claude tier step is missing').toEqual(expect.any(String));
  return step.run;
}

function fixerPrompt(): string {
  const workflow: any = YAML.parse(readFileSync(WORKFLOW, 'utf8'));
  const step = workflow?.jobs?.fix?.steps?.find(
    (candidate: any) => candidate?.uses === 'anthropics/claude-code-action@v1'
      || candidate?.uses === './.github/actions/claude-codex-fallback',
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

function runToolHook(
  toolName: string,
  toolInput: Record<string, unknown>,
  issueFix = true,
  cwd = ROOT,
) {
  const env = { ...process.env };
  if (issueFix) {
    env.ISSUE_NUMBER = '7776';
    env.FIX_TIER = 'normal';
  } else {
    delete env.ISSUE_NUMBER;
    delete env.FIX_TIER;
  }
  return spawnSync(process.execPath, [BASH_HOOK], {
    cwd,
    encoding: 'utf8',
    env,
    input: JSON.stringify({
      cwd,
      tool_name: toolName,
      tool_input: toolInput,
    }),
  });
}

function runBashHook(command: string, issueFix = true, cwd = ROOT) {
  return runToolHook('Bash', { command }, issueFix, cwd);
}

function runReadHook(
  filePath: string,
  options: Record<string, unknown> = {},
  issueFix = true,
  cwd = ROOT,
) {
  return runToolHook('Read', { file_path: filePath, ...options }, issueFix, cwd);
}

function withLargeSourceFixture(callback: (cwd: string) => void) {
  const cwd = mkdtempSync(join(tmpdir(), 'issue-fix-read-budget-'));
  writeFileSync(join(cwd, 'large.mjs'), 'x'.repeat(MAX_SOURCE_BYTES + 1));
  try {
    callback(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('issue-fix read budget preserves targeted context', () => {
  it('allows bounded and small reads, blocks only a large integral source read', () => {
    const citedRange = runBashHook("sed -n '205,255p' scripts/lib/ipersonal-spec-runtime.mjs");
    expect(citedRange.status, citedRange.stderr).toBe(0);

    const smallSource = runBashHook('cat -n scripts/ci/lib/hook-exit-codes.mjs');
    expect(smallSource.status, smallSource.stderr).toBe(0);

    const largeIntegral = runBashHook(
      'wc -l scripts/lib/ipersonal-spec-runtime.mjs && cat -n scripts/lib/ipersonal-spec-runtime.mjs',
    );
    expect(largeIntegral.status).toBe(2);
    expect(largeIntegral.stdout).toBe('');
    expect(largeIntegral.stderr).toContain('ipersonal-spec-runtime.mjs');
    expect(largeIntegral.stderr).not.toContain('import {');

    const redirectedIntegral = runBashHook('cat < scripts/lib/ipersonal-spec-runtime.mjs');
    expect(redirectedIntegral.status).toBe(2);
  });

  it('leaves writes and non-issue-fix sessions untouched', () => {
    const write = runBashHook('cat > scripts/new-source.mjs <<\'EOF\'\nexport const value = 1;\nEOF');
    expect(write.status, write.stderr).toBe(0);

    const outsideIssueFix = runBashHook(
      'cat -n scripts/lib/ipersonal-spec-runtime.mjs',
      false,
    );
    expect(outsideIssueFix.status, outsideIssueFix.stderr).toBe(0);
  });

  it('does not skip pipelines or byte-oriented alternatives and verifies exit 2', () => {
    withLargeSourceFixture((cwd) => {
      for (const command of [
        'cat large.mjs | cat',
        `head -c ${MAX_SOURCE_BYTES + 1} large.mjs`,
        `tail -c ${MAX_SOURCE_BYTES + 1} large.mjs`,
      ]) {
        const blocked = runBashHook(command, true, cwd);
        expect(blocked.status, `${command}\n${blocked.stderr}`).toBe(2);
        expect(blocked.stdout).toBe('');
        expect(blocked.stderr).toContain('large.mjs');
      }

      const unboundedRead = runReadHook('large.mjs', {}, true, cwd);
      expect(unboundedRead.status, unboundedRead.stderr).toBe(2);
      expect(unboundedRead.stderr).toContain('large.mjs');

      for (const command of [
        `head -c ${MAX_SOURCE_BYTES} large.mjs`,
        `tail -c ${MAX_SOURCE_BYTES} large.mjs`,
      ]) {
        const bounded = runBashHook(command, true, cwd);
        expect(bounded.status, `${command}\n${bounded.stderr}`).toBe(0);
      }

      const boundedRead = runReadHook(
        'large.mjs',
        { offset: 0, limit: MAX_SOURCE_BYTES },
        true,
        cwd,
      );
      expect(boundedRead.status, boundedRead.stderr).toBe(0);
    });
  });

  it('attaches the read guard to both Bash and Read hooks', () => {
    let settingsSource: string;
    try {
      settingsSource = readFileSync(join(ROOT, '.claude/settings.json'), 'utf8');
    } catch {
      const fromGit = spawnSync('git', ['show', 'HEAD:.claude/settings.json'], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      expect(fromGit.status, fromGit.stderr).toBe(0);
      settingsSource = fromGit.stdout;
    }
    const settings: any = JSON.parse(settingsSource);
    const siblingMatchers = settings.hooks.PreToolUse
      .filter((entry: any) => entry.hooks?.some((hook: any) => hook.command?.includes('sibling-check-gate')))
      .map((entry: any) => entry.matcher);

    expect(siblingMatchers).toContain('Bash|Read');
  });
});
