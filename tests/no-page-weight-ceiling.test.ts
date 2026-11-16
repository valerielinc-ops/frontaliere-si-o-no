import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('page-weight ceiling stays removed', () => {
  it('keeps byte-budget guards out of every build plugin TypeScript file', () => {
    const forbidden = [
      /HARD_BUDGET/i,
      /exceeds\s+hard\s+budget/i,
      /PAGE_WEIGHT/i,
      /pageWeight/,
      /GUARD_BYTES/i,
      /WARN_BYTES/i,
    ];
    const matches = listTypeScriptFiles(join(ROOT, 'build-plugins')).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return forbidden
        .filter((pattern) => pattern.test(source))
        .map((pattern) => `${path}: ${pattern}`);
    });

    expect(matches).toEqual([]);
  });

  it('removes the page-weight auditor and its shared budgets', () => {
    const removedAudit = ['audit', 'page-weight.mjs'].join('-');
    expect(existsSync(join(ROOT, 'scripts', removedAudit))).toBe(false);
    expect(existsSync(join(ROOT, 'scripts/lib/pageWeightBudgets.mjs'))).toBe(false);
    expect(existsSync(join(ROOT, 'scripts/audit-img-attributes.mjs'))).toBe(true);
  });

  it('removes every page-weight registry, runner, task, and workflow reference', () => {
    const packageJson = readFileSync(join(ROOT, 'package.json'), 'utf8');
    expect(packageJson).not.toContain('audit:page-weight');
    expect(packageJson).toContain('audit:img-attributes');

    const sources = [
      'scripts/audit-all.mjs',
      'scripts/audit-img-attributes.mjs',
      'scripts/audit-dist-multi.mjs',
      'scripts/lib/post-build-tasks.sh',
      '.github/workflows/audit-dist-from-run.yml',
      '.github/workflows/audit-published-dist-full.yml',
      '.github/workflows/audit-published-dist.yml',
      'docs/SEO-GATES.md',
      'tests/build-plugins/healthFacilitiesJobInventory.test.ts',
      'tests/build-plugins/pharmacyDirectoryPagesPlugin.test.ts',
      'tests/plate-auction-pages.test.ts',
    ];
    for (const relativePath of sources) {
      const source = readFileSync(join(ROOT, relativePath), 'utf8');
      expect(source, relativePath).not.toContain('page-weight');
      expect(source, relativePath).not.toMatch(/\b260\s*KB\b/i);
    }

    const postBuildTasks = readFileSync(join(ROOT, 'scripts/lib/post-build-tasks.sh'), 'utf8');
    expect(postBuildTasks).toMatch(/audit:img-attributes\)\s+npm run audit:img-attributes/);
    expect(postBuildTasks.match(/^\s+audit:img-attributes$/gm)).toHaveLength(2);
  });

  it('records the owner decision in AGENTS.md', () => {
    const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('Nessun tetto di peso pagina');
  });
});
