import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(__dirname, '../scripts/analytics-report.mjs'), 'utf8');

describe('analytics-report machine-readable output', () => {
  it('lets a large JSON report drain before the successful exit path returns', () => {
    const jsonOutput = source.indexOf('console.log(JSON.stringify(report, null, 2));');
    const finalFlush = source.indexOf('await flushScoresBeforeExit();');
    expect(jsonOutput).toBeGreaterThan(-1);
    expect(finalFlush).toBeGreaterThan(jsonOutput);

    const afterFlush = source.slice(finalFlush, finalFlush + 400);
    expect(afterFlush).toContain('\n  return;');
    expect(afterFlush).not.toMatch(/\n\s*process\.exit\(0\);/);
  });
});
