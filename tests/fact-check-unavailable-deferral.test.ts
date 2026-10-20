import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(resolve(__dirname, '../scripts/create-article.mjs'), 'utf8');

describe('fact-check unavailable is a run deferral, not a regeneration loop', () => {
  it('types the unavailable verdict before the quality retry and defers the whole run', () => {
    const primaryStart = SOURCE.indexOf('const factResult = await llmFactCheck(');
    const primaryEnd = SOURCE.indexOf('const itWords = italianBodyWordCount', primaryStart);
    expect(primaryStart).toBeGreaterThan(-1);
    expect(primaryEnd).toBeGreaterThan(primaryStart);
    const primary = SOURCE.slice(primaryStart, primaryEnd);
    expect(primary).toContain('if (factResult.unverified === true)');
    expect(primary.indexOf('factResult.unverified')).toBeLessThan(primary.indexOf('if (!factResult.passed)'));
    expect(primary).toContain('if (isFactCheckUnavailableError(fcErr)) throw fcErr;');

    const catchStart = SOURCE.indexOf('main().catch(async (e) =>');
    const unavailable = SOURCE.indexOf('if (isFactCheckUnavailableError(e))', catchStart);
    const quota = SOURCE.indexOf('if (isQuotaExhaustedError(e))', catchStart);
    expect(catchStart).toBeGreaterThan(-1);
    expect(unavailable).toBeGreaterThan(catchStart);
    expect(unavailable).toBeLessThan(quota);
    const deferral = SOURCE.slice(unavailable, quota);
    expect(deferral).toContain("finalizeRunReport('deferred'");
    expect(deferral).toContain('process.exit(0)');
    expect(deferral).toMatch(/article not published|articolo non pubblicato/i);
  });
});
