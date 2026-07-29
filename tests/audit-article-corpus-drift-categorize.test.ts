/**
 * Pins the verdict-precedence of `categorizeLocaleVerdicts`
 * (scripts/audit-article-corpus-drift.mjs).
 *
 * This logic has been wrong twice. Both regressions had the same shape: a
 * verdict the code could not interpret fell through to `'ok'`, so the audit
 * reported success while having verified nothing — the exact opposite of the
 * fail-loud contract the script states for itself.
 *
 *   1st (PR #4908): no `'unknown'` branch at all.
 *   2nd (PR #4914): a branch that only fired when EVERY locale was
 *      `'unknown'`, so a mix (it=ok, en=unknown) still passed silently.
 *
 * Hence these tests assert the precedence directly rather than the happy
 * path only: the mixed cases are where the bug lived both times.
 */
import { describe, it, expect } from 'vitest';
import { categorizeLocaleVerdicts } from '../scripts/audit-article-corpus-drift.mjs';

describe('categorizeLocaleVerdicts — precedence', () => {
  it('reports no-locale-verdicts when the checker printed nothing', () => {
    expect(categorizeLocaleVerdicts({})).toBe('no-locale-verdicts');
    expect(categorizeLocaleVerdicts(undefined)).toBe('no-locale-verdicts');
  });

  it('reports ok only when every locale is genuinely ok', () => {
    expect(categorizeLocaleVerdicts({ it: 'ok', en: 'ok', de: 'ok', fr: 'ok' })).toBe('ok');
  });

  it('reports content-mismatch — real drift outranks everything else', () => {
    expect(
      categorizeLocaleVerdicts({ it: 'content-mismatch', en: 'unknown', de: 'ok', fr: 'render-failure' }),
    ).toBe('content-mismatch');
  });

  // The 2nd-regression case: a single unparseable locale among healthy ones.
  it('reports unrecognized-verdicts when even ONE locale is unknown', () => {
    expect(categorizeLocaleVerdicts({ it: 'ok', en: 'unknown', de: 'ok', fr: 'ok' })).toBe(
      'unrecognized-verdicts',
    );
  });

  // The 1st-regression case.
  it('reports unrecognized-verdicts when every locale is unknown', () => {
    expect(categorizeLocaleVerdicts({ it: 'unknown', en: 'unknown', de: 'unknown', fr: 'unknown' })).toBe(
      'unrecognized-verdicts',
    );
  });

  it('lets unknown outrank tolerated noise, so a partial check never reads as a pass', () => {
    expect(categorizeLocaleVerdicts({ it: 'cf-bot-script-only', en: 'unknown' })).toBe(
      'unrecognized-verdicts',
    );
    expect(categorizeLocaleVerdicts({ it: 'render-failure', en: 'unknown' })).toBe('unrecognized-verdicts');
    expect(categorizeLocaleVerdicts({ it: 'fetch-or-liveness', en: 'unknown' })).toBe(
      'unrecognized-verdicts',
    );
  });

  it('keeps the tolerated-noise ordering among themselves', () => {
    expect(categorizeLocaleVerdicts({ it: 'cf-bot-script-only', en: 'render-failure' })).toBe(
      'ok-cf-bot-script-only',
    );
    expect(categorizeLocaleVerdicts({ it: 'render-failure', en: 'fetch-or-liveness' })).toBe(
      'render-failure',
    );
    expect(categorizeLocaleVerdicts({ it: 'fetch-or-liveness', en: 'ok' })).toBe('fetch-or-liveness');
  });

  it('fails the run for exactly the categories that mean "not verified"', async () => {
    // Guards the pairing between the precedence above and the failing set:
    // a category can only be added to one without considering the other.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../scripts/audit-article-corpus-drift.mjs', import.meta.url), 'utf8'),
    );
    const m = /const DIVERGENT_CATEGORIES = new Set\(\[([^\]]*)\]\)/.exec(src);
    expect(m).not.toBeNull();
    const divergent = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
    expect(divergent).toEqual(['content-mismatch', 'no-locale-verdicts', 'unrecognized-verdicts'].sort());
  });
});
