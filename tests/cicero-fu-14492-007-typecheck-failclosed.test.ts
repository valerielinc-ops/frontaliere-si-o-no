import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SOURCE = fs.readFileSync(
  path.join(ROOT, 'scripts', 'ci', 'check-typecheck-baseline.mjs'),
  'utf8',
);

describe('typecheck gate fail-closed contract (#14492 FU-007)', () => {
  it('turns a spawn failure or an abnormal tsc termination into an environment error', () => {
    expect(SOURCE).toMatch(/if \(res\.error\)[\s\S]*process\.exit\(2\)/u);
    expect(SOURCE).toContain(
      'if (res.signal || (res.status !== 0 && res.status !== 1 && res.status !== 2))',
    );
    expect(SOURCE).toContain('tsc terminato in modo anomalo');
  });

  it('parses global TypeScript diagnostics instead of silently dropping them', () => {
    expect(SOURCE).toContain("const GLOBAL_ERROR_RE = /^error (?<code>TS\\d+): (?<msg>.*)$/");
    expect(SOURCE).toContain("errors.push({ file: '(global)', line: 0, code: g.groups.code, msg: g.groups.msg })");
    expect(SOURCE).toContain('if (g) {');
  });
});
