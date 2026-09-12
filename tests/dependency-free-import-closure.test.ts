import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import {
  importSpecifiers,
  scanImportClosure,
  stripComments,
} from '../scripts/ci/check-dependency-free-import-closure.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = 'scripts/ci/check-dependency-free-import-closure.mjs';
const WORKFLOW = '.github/workflows/followup-drainer.yml';

describe('followup-drainer dependency-free import closure (#7341)', () => {
  it('walks the complete closure and reports only the documented guarded package', () => {
    const output = execFileSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
    expect(output).toMatch(/dependency-free import closure OK: \d+ files/);
    expect(output).toContain('guarded package exception: scripts/load-rc-env.mjs -> firebase-admin');

    const { files } = scanImportClosure();
    expect(files).toEqual(expect.arrayContaining([
      'scripts/lib/secrets-scope-detect.mjs',
      'scripts/lib/workflow-scope-detect.mjs',
    ]));
  });

  it('runs the closure check before the zero-dependency drain entrypoint', () => {
    const document = YAML.parse(readFileSync(resolve(ROOT, WORKFLOW), 'utf8')) as any;
    const steps = Object.values(document.jobs ?? {}).flatMap((job: any) => job.steps ?? []);
    const checkIndex = steps.findIndex((step: any) => step.name === 'Verify dependency-free import closure');
    const drainIndex = steps.findIndex((step: any) =>
      typeof step.run === 'string' && step.run.includes('node scripts/ci/followup-drainer.mjs'),
    );
    expect(checkIndex).toBeGreaterThan(-1);
    expect(drainIndex).toBeGreaterThan(checkIndex);
    expect(steps[checkIndex].run).toBe(`node ${SCRIPT}`);
    expect(steps.some((step: any) => typeof step.run === 'string' && /\bnpm ci\b/.test(step.run))).toBe(false);
  });

  it('#7995 — strips inline comments without changing quoted source and rejects template fakes', () => {
    const source = [
      'const url = "https://example.test/a//b";',
      'const block = "/* not a comment */";',
      'import {',
      "  real, // mention 'fake' from './fake.mjs'",
      "} from './real.mjs';",
      'const generated = `',
      "import { fake } from './template.mjs';",
      '`;',
      "const regex = /['// /* not a comment */]/;",
      "import './regex-safe.mjs';",
    ].join('\n');

    expect(stripComments(source)).toContain('"https://example.test/a//b"');
    expect(stripComments(source)).toContain('"/* not a comment */"');
    expect(importSpecifiers(source)).toEqual(['./real.mjs', './regex-safe.mjs']);
  });

  it('#7995 — caps multiline clauses and still reads real re-exports', () => {
    const tooWideImport = [
      'import {',
      ...Array.from({ length: 25 }, (_, index) => `  value${index},`),
      "} from './too-wide.mjs';",
    ].join('\n');

    expect(importSpecifiers(tooWideImport)).toEqual([]);
    expect(importSpecifiers("export { value } from './reexport.mjs';")).toEqual(['./reexport.mjs']);
  });
});
