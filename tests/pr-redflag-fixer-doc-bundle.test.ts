import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import {
  REQUIRED_SECTIONS,
  buildRedflagDocumentSections,
  extractSectionByHeading,
} from '../scripts/ci/redflag-doc-sections.mjs';

const ROOT = process.cwd();
const WORKFLOW = join(ROOT, '.github/workflows/pr-redflag-fixer.yml');
const SCRIPT = join(ROOT, 'scripts/ci/redflag-doc-sections.mjs');

function collectContextRun(): string {
  const workflow: any = YAML.parse(readFileSync(WORKFLOW, 'utf8'));
  const step = workflow?.jobs?.['redflag-fix']?.steps?.find(
    (candidate: any) => candidate?.id === 'ctx',
  );
  expect(step?.run, 'the zero-Claude context step is missing').toEqual(expect.any(String));
  return step.run;
}

function fixerPrompt(): string {
  const workflow: any = YAML.parse(readFileSync(WORKFLOW, 'utf8'));
  const step = workflow?.jobs?.['redflag-fix']?.steps?.find(
    (candidate: any) => candidate?.uses === 'anthropics/claude-code-action@v1',
  );
  expect(step?.with?.prompt, 'the Claude prompt is missing').toEqual(expect.any(String));
  return step.with.prompt;
}

describe('pr-redflag-fixer prefetches its binding document sections', () => {
  it('puts the real required content in the existing bundle path', () => {
    const run = collectContextRun();
    const prompt = fixerPrompt();
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('## REVIEW.md — Scopo progetto = filtro "important"');
    expect(result.stdout).toContain('## REVIEW.md — Severity');
    expect(result.stdout).toContain('## AGENTS.md — Non-Negotiables');
    expect(result.stdout).toContain('## AGENTS.md — Privacy');
    expect(result.stdout).toContain('Rompe funnel/monetizzazione/traffico');
    expect(result.stdout).toContain('Mai abbassare quality threshold/test tolerance');
    expect(result.stdout).toContain('Git identity canonica');

    expect(run).toContain('git fetch --no-tags --depth=1 origin main:refs/remotes/origin/main');
    expect(run).toContain('git show "origin/main:$doc"');
    expect(run).toContain('REDFLAG_DOC_ROOT="$OUT/canonical-docs"');
    expect(run).toContain('node scripts/ci/redflag-doc-sections.mjs');
    const bundleAssembly = run.match(/\{\n([\s\S]*?)\n\s*\} > "\$OUT\/redflag-bundle\.md"/)?.[1];
    expect(bundleAssembly, 'the existing bundle assembly is missing').toEqual(expect.any(String));
    expect(bundleAssembly).toContain('cat "$OUT/redflag-doc-sections.md"');

    expect(prompt).toContain('`REVIEW.md` (scopo + severity)');
    expect(prompt).toContain('`AGENTS.md` (Non-Negotiables + Privacy)');
    expect(prompt).toMatch(/prefetch fallito[\s\S]*bundle incompleto/i);
    expect(prompt).not.toMatch(/Leggi `REVIEW\.md` \(severity\/scopo\).*`AGENTS\.md`/);
  });

  it('extracts by heading and fails when a required heading disappears', () => {
    const fixture = [
      '# Document',
      '',
      '## Irrelevant',
      'before',
      '',
      '## Severity',
      'binding content',
      '',
      '### Nested section',
      'nested binding content',
      '',
      '## Next section',
      'after',
    ].join('\n');

    expect(extractSectionByHeading(fixture, '## Severity')).toBe(
      'binding content\n\n### Nested section\nnested binding content',
    );
    expect(() => extractSectionByHeading(fixture, '## Privacy')).toThrow(
      /Required heading not found: ## Privacy/,
    );
  });

  it('fails closed on an unclosed fence instead of swallowing the rest of the document', () => {
    expect(() => extractSectionByHeading('## Severity\n```\nnot finished', '## Severity')).toThrow(
      /Unclosed fenced code block/,
    );
  });

  it('does not silently accept an empty required section', () => {
    expect(() =>
      buildRedflagDocumentSections({
        read: (file) => (file === REQUIRED_SECTIONS[0].file
          ? `${REQUIRED_SECTIONS[0].heading}\n\n## Next`
          : `${file}\ncontent`),
      }),
    ).toThrow(/Required heading has no content/);
  });
});
