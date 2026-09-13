import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import YAML from 'yaml';
import {
  REQUIRED_SECTIONS,
  buildRedflagDocumentSections,
  extractSectionByHeading,
  indentAndValidateRedflagDocumentSections,
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
    (candidate: any) => candidate?.uses === 'anthropics/claude-code-action@v1'
      || candidate?.uses === './.github/actions/claude-codex-fallback',
  );
  expect(step?.with?.prompt, 'the Claude prompt is missing').toEqual(expect.any(String));
  return step.with.prompt;
}

describe('pr-redflag-fixer prefetches its binding document sections', () => {
  it('delivers binding content to the action prompt after a persisted bundle read', () => {
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
    expect(run).toMatch(/REDFLAG_DOC_SECTIONS<<[A-Z0-9_]+/);
    expect(run).toContain("sed 's/^/            /' \"$OUT/redflag-doc-sections.md\"");
    const bundleAssembly = run.match(/(echo "# Redflag-fix bundle[\s\S]*?\n\s*\} > "\$OUT\/redflag-bundle\.md")/)?.[1];
    expect(bundleAssembly, 'the existing bundle assembly is missing').toEqual(expect.any(String));
    expect(bundleAssembly).not.toContain('cat "$OUT/redflag-doc-sections.md"');

    expect(prompt).toContain('${{ env.REDFLAG_DOC_SECTIONS }}');
    expect(prompt).toContain('sezioni vincolanti sono già dentro questa richiesta');
    expect(prompt).toMatch(/prefetch fallito[\s\S]*bundle incompleto/i);

    const sentinel = 'SENTINEL_AFTER_THE_TOOL_PREVIEW_7f2c';
    const fixtureDocs: Record<string, string> = {
      'REVIEW.md': [
        '# Review',
        '',
        REQUIRED_SECTIONS[0].heading,
        '',
        `${'padding '.repeat(300)}${sentinel}`,
        '',
        REQUIRED_SECTIONS[1].heading,
        '',
        'severity binding content',
      ].join('\n'),
      'AGENTS.md': [
        '# Agents',
        '',
        REQUIRED_SECTIONS[2].heading,
        '',
        'non-negotiable binding content',
        '',
        REQUIRED_SECTIONS[3].heading,
        '',
        'privacy binding content',
      ].join('\n'),
    };
    const injectedSections = buildRedflagDocumentSections({
      read: (file) => fixtureDocs[file],
    });
    const persistedToolOutput = [
      '<persisted-output>',
      'Output too large (redflag-bundle.md). Full output saved to: /runner/temp/redflag/redflag-bundle.md',
      '',
      'Preview (first 2KB):',
      injectedSections.slice(0, 2048),
      '</persisted-output>',
    ].join('\n');
    expect(prompt).toContain('--- BEGIN REDFLAG_DOC_SECTIONS (indented runtime injection) ---');
    expect(prompt).toContain('--- END REDFLAG_DOC_SECTIONS ---');
    const indentedSections = injectedSections
      .split('\n')
      .map((line) => `            ${line}`)
      .join('\n');
    const resolvedPrompt = prompt.replace('${{ env.REDFLAG_DOC_SECTIONS }}', indentedSections);

    expect(injectedSections.indexOf(sentinel)).toBeGreaterThan(2048);
    expect(persistedToolOutput).not.toContain(sentinel);
    expect(resolvedPrompt).toContain(sentinel);
    const injectedStart = resolvedPrompt.indexOf('--- BEGIN REDFLAG_DOC_SECTIONS');
    const injectedEnd = resolvedPrompt.indexOf('--- END REDFLAG_DOC_SECTIONS ---');
    expect(injectedStart).toBeGreaterThanOrEqual(0);
    expect(injectedEnd).toBeGreaterThan(injectedStart);
    const renderedInjection = resolvedPrompt.slice(injectedStart, injectedEnd);
    expect(renderedInjection).toContain('\n            ## REVIEW.md — Scopo progetto = filtro "important"');
    expect(renderedInjection).not.toMatch(/\n## REVIEW\.md —/);
    expect(`${resolvedPrompt}\n${persistedToolOutput}`).toContain(sentinel);
  });

  it('fails closed on the heredoc delimiter and on oversized GITHUB_ENV content', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'redflag-doc-sections-'));
    const review = [
      '# Review',
      '',
      REQUIRED_SECTIONS[0].heading,
      '',
      'project scope',
      '',
      REQUIRED_SECTIONS[1].heading,
      '',
      'REDFLAG_DOC_SECTIONS_EOF',
    ].join('\n');
    const agents = [
      '# Agents',
      '',
      REQUIRED_SECTIONS[2].heading,
      '',
      'non-negotiables',
      '',
      REQUIRED_SECTIONS[3].heading,
      '',
      'privacy',
    ].join('\n');

    try {
      writeFileSync(join(fixtureRoot, 'REVIEW.md'), review);
      writeFileSync(join(fixtureRoot, 'AGENTS.md'), agents);
      const collision = spawnSync(process.execPath, [SCRIPT], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, REDFLAG_DOC_ROOT: fixtureRoot },
      });
      expect(collision.status, collision.stderr).not.toBe(0);
      expect(collision.stderr).toMatch(/heredoc delimiter/i);

      writeFileSync(
        join(fixtureRoot, 'REVIEW.md'),
        review.replace('REDFLAG_DOC_SECTIONS_EOF', 'x'.repeat(200_000)),
      );
      const oversized = spawnSync(process.execPath, [SCRIPT], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, REDFLAG_DOC_ROOT: fixtureRoot },
      });
      expect(oversized.status, oversized.stderr).not.toBe(0);
      expect(oversized.stderr).toMatch(/too large|maximum|limit/i);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('bounds the indented prompt value after adding the per-line indent', () => {
    const document = 'x'.repeat(16_380);
    expect(() => indentAndValidateRedflagDocumentSections(document)).toThrow(/Indented redflag document too large/);
    expect(indentAndValidateRedflagDocumentSections('ok', '  ')).toBe('  ok');
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

  it('recognizes setext headings and stops at the next setext boundary', () => {
    const fixture = [
      '# Document',
      '',
      'Privacy',
      '-------',
      'binding content',
      '',
      'Next section',
      '-------',
      'after',
    ].join('\n');

    expect(extractSectionByHeading(fixture, '## Privacy')).toBe('binding content');
  });

  it('fails closed on an unclosed fence instead of swallowing the rest of the document', () => {
    expect(() => extractSectionByHeading('## Severity\n```\nnot finished', '## Severity')).toThrow(
      /Unclosed fenced code block/,
    );
  });

  it('does not close a longer fence with a shorter same-character marker', () => {
    const fixture = [
      '## Wrapper',
      '',
      '````md',
      '## Privacy',
      '```',
      '## Still inside',
      '````',
      '',
      '## Privacy',
      'binding content',
    ].join('\n');

    expect(extractSectionByHeading(fixture, '## Privacy')).toBe('binding content');
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
