import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  GENERATED_FILE_REGISTRY,
} from '../scripts/ci/generated-files-registry.mjs';
import { collectRelativeImportClosure } from './helpers/collectRelativeImportClosure';

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = '.github/workflows/tests.yml';
const READ_PRELOAD = path.resolve(__dirname, 'helpers/record-fs-reads.mjs');

type SparseStep = {
  name?: string;
  uses?: string;
  with?: { 'sparse-checkout'?: unknown };
};

function postReviewSparsePatterns(): string[] {
  const workflow = YAML.parse(readFileSync(path.join(ROOT, WORKFLOW), 'utf8')) as {
    jobs?: Record<string, { steps?: SparseStep[] }>;
  };
  const step = workflow.jobs?.['post-review']?.steps?.find(
    (candidate) => candidate.name === 'Checkout trusted main for autorebase and token minting',
  );
  expect(step?.uses, `checkout sparse del job post-review non trovato in ${WORKFLOW}`).toMatch(/^actions\/checkout@/u);
  expect(typeof step?.with?.['sparse-checkout'], `sparse-checkout del job post-review non trovato in ${WORKFLOW}`).toBe(true);
  return String(step!.with!['sparse-checkout'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'));
}

function globPattern(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
    } else {
      source += character.replace(/[.+?^${}()|[\]\\]/gu, '\\$&');
    }
  }
  return new RegExp(`${source}$`, 'u');
}

function covers(pattern: string, touchedPath: string): boolean {
  const normalizedPattern = pattern.replace(/^\/+|\/+$/gu, '');
  const normalizedPath = touchedPath.replace(/^\/+|\/+$/gu, '');
  if (!normalizedPattern) return false;
  if (!normalizedPattern.includes('*')) {
    // Git materializza anche i parent necessari per un pattern figlio. Il
    // trailing slash del preload conserva comunque la distinzione fra una
    // directory enumerata e un file letto.
    if (touchedPath.endsWith('/')) {
      return normalizedPath === normalizedPattern
        || normalizedPath.startsWith(`${normalizedPattern}/`)
        || normalizedPattern.startsWith(`${normalizedPath}/`);
    }
    return normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern}/`);
  }
  if (touchedPath.endsWith('/')) {
    return [
      `${normalizedPath}/package.json`,
      `${normalizedPath}/__sparse_entry__/package.json`,
    ].some((candidate) => globPattern(normalizedPattern).test(candidate));
  }
  return globPattern(normalizedPattern).test(normalizedPath);
}

function missingMessage(generatorId: string, touchedPath: string): string {
  return `il generatore \`${generatorId}\` legge \`${touchedPath}\`, che il job post-review non materializza: aggiungilo ai path della regola in generated-files-registry.mjs`;
}

function mergeBase(cwd = ROOT): string {
  const result = spawnSync('git', ['merge-base', 'origin/main', 'HEAD'], {
    cwd,
    encoding: 'utf8',
  });
  expect(result.status, result.stderr || 'git merge-base origin/main HEAD fallito').toBe(0);
  return result.stdout.trim();
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function runGeneratorWithReadLog(
  rule: typeof GENERATED_FILE_REGISTRY[number],
  jobPatterns: string[],
): string[] {
  const logDir = mkdtempSync(path.join(tmpdir(), 'autorebase-generated-reads-'));
  const logPath = path.join(logDir, 'reads.json');
  const sparseRoot = mkdtempSync(path.join(tmpdir(), 'autorebase-generated-sparse-'));
  let worktreeAdded = false;
  try {
    runGit(ROOT, ['worktree', 'add', '--no-checkout', '--detach', sparseRoot, 'HEAD']);
    worktreeAdded = true;
    runGit(sparseRoot, ['sparse-checkout', 'init', '--no-cone']);
    runGit(sparseRoot, [
      'sparse-checkout',
      'set',
      '--no-cone',
      ...jobPatterns,
      ...(rule.worktreePaths || []),
    ]);
    runGit(sparseRoot, ['checkout', '-q', '--detach', 'HEAD']);
    symlinkSync(path.join(ROOT, 'node_modules'), path.join(sparseRoot, 'node_modules'), 'dir');

    const argv = rule.verifier.argv;
    const child = spawnSync(process.execPath, [
      '--import',
      READ_PRELOAD,
      ...argv.slice(1),
    ], {
      cwd: sparseRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        ...rule.verifier.env,
        CRAWLER_SOURCE_COMMIT: mergeBase(sparseRoot),
        SPARSE_READS_ROOT: sparseRoot,
        SPARSE_READS_OUTPUT: logPath,
      },
    });
    expect(child.error, `${rule.id}: processo generatore non avviato`).toBeUndefined();
    expect(child.status, `${rule.id} --check fallito:\n${child.stderr || child.stdout}`).toBe(0);
    return JSON.parse(readFileSync(logPath, 'utf8')) as string[];
  } finally {
    if (worktreeAdded) {
      execFileSync('git', ['worktree', 'remove', '--force', sparseRoot], {
        cwd: ROOT,
        stdio: 'ignore',
      });
    }
    rmSync(sparseRoot, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  }
}

describe('pr-autorebase — chiusura sparse del generatore di conflitti generati', () => {
  it('copre la chiusura statica e tutte le letture reali con il profilo post-review', () => {
    const jobPatterns = postReviewSparsePatterns();
    expect(jobPatterns).toContain('/scripts/');

    for (const rule of GENERATED_FILE_REGISTRY) {
      const allowed = [...jobPatterns, ...(rule.worktreePaths || [])];
      const generatorEntry = rule.generator.argv[1];
      expect(typeof generatorEntry, `${rule.id}: entrypoint del generatore mancante`).toBe('string');
      const closure = collectRelativeImportClosure(ROOT, generatorEntry);
      const uncoveredImports = closure.filter(
        (file) => !allowed.some((pattern) => covers(pattern, file)),
      );
      expect(
        uncoveredImports,
        uncoveredImports.map((file) => missingMessage(rule.id, file)).join('\n'),
      ).toEqual([]);

      const touched = runGeneratorWithReadLog(rule, jobPatterns)
        .filter((file) => file !== 'node_modules' && !file.startsWith('node_modules/'));
      const uncoveredReads = touched.filter(
        (file) => !allowed.some((pattern) => covers(pattern, file)),
      );
      expect(
        uncoveredReads,
        uncoveredReads.map((file) => missingMessage(rule.id, file)).join('\n'),
      ).toEqual([]);
    }
  });
});
