import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const AGENTS_MD = fs.readFileSync(path.join(process.cwd(), 'AGENTS.md'), 'utf8');
const testGateRule = AGENTS_MD.split(/\r?\n/).find((line) => /^\s*-\s+\*\*Gate test:\*\*/.test(line)) ?? '';

describe('policy test locali e gate CI in AGENTS.md', () => {
  it('mantiene facoltativi i test locali e obbligatorio il gate CI', () => {
    expect(testGateRule).toContain('i test locali sono facoltativi');
    expect(testGateRule).toContain('non sono un prerequisito per aprire la PR');
    expect(testGateRule).toContain('workflow required `tests.yml`');
    expect(testGateRule).toContain('source guards, typecheck, test correlati/Vitest e review Codex sulla stessa HEAD');
    expect(testGateRule).toContain('Non saltare o ridurre il gate.');
  });

  it('il runner blocca una selezione con inventario dei path incompleto', () => {
    const runner = fs.readFileSync(path.join(process.cwd(), 'scripts/ci/run-related-tests.mjs'), 'utf8');
    expect(runner).toContain("changedStatus !== 'complete'");
    expect(runner).toContain('stopWithoutFullSuite');
  });
});
