import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Run 35169891808 (17/09): build-plugins/shared/postWalkIncremental.ts imported
// scripts/ci/incremental-manifest-report.mjs. That script starts with a shebang
// and uses `import.meta.url` in its main guard; Vite's config bundler prepends
// its file-scope variables on the first line, so the shebang stopped being the
// first token and esbuild failed with `Syntax error "!"` on all four legs.
// CLI scripts live in scripts/ci; build plugins import shared helpers only.
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|mjs|js)$/.test(name)) out.push(full);
  }
  return out;
}

describe('build-plugins must not import CLI scripts', () => {
  it('no build-plugins module imports from scripts/ci/', () => {
    const root = path.resolve(__dirname, '..', 'build-plugins');
    const offenders: string[] = [];
    for (const file of walk(root)) {
      const source = readFileSync(file, 'utf8');
      const re = /from\s+['"]([^'"]*\/scripts\/ci\/[^'"]+)['"]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(source))) offenders.push(`${path.relative(root, file)} -> ${m[1]}`);
    }
    expect(offenders).toEqual([]);
  });
});
