/**
 * Regression test for thin-content recovery in scripts/create-article.mjs.
 *
 * 2026-06-24 incident (run 28078614313): a news source produced only
 * 296/700 Italian words. The generator threw
 *   `Contenuto IT troppo corto dopo 6 tentativi + espansione (296/700 parole).`
 * but `isQualityRejectError` did NOT recognise the message, so the error
 * was treated as an infrastructure failure: it propagated past the
 * headline-retry loops (which skip quality rejects and try the next
 * source) AND past `main().catch` (which defers quality rejects with
 * exit 0). Result: the run exited 1, went red, and raised a
 * false-positive "Workflow Failure: Generate Blog Article" Bug issue —
 * instead of self-healing to another topic.
 *
 * This is the SAME class of bug as the 2026-05-11 topic-gate-abort miss
 * (see topic-gate-abort-retry.test.ts): a per-headline quality error
 * whose wording escaped the recognition regex.
 *
 * Fix: `troppo corto` is added to the isQualityRejectError regex (covers
 * the whole thin-content class — too-short IT body after retry+expand,
 * too-short char count, too-short locale field) AND the two fatal
 * thin-content throw sites tag `err.qualityReject = true` explicitly.
 * Both layers then self-heal: the loop skips the thin source and tries
 * the next headline; if every candidate is exhausted, main().catch
 * defers cleanly (exit 0) so the self-trigger back-off retries later.
 *
 * The test extracts the real recognition regex from the source and runs
 * it against the actual thrown messages, so it cannot silently drift.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(
  resolve(__dirname, '..', 'scripts/create-article.mjs'),
  'utf8',
);

/** Pull the literal regex used inside isQualityRejectError and rebuild it. */
function extractQualityRejectRegex(): RegExp {
  const fn = SRC.match(/function isQualityRejectError\(e\)\s*\{[\s\S]*?\n\}/);
  expect(fn, 'isQualityRejectError not found').toBeTruthy();
  const lit = fn![0].match(/\/([^\n]+?)\/i\.test\(/);
  expect(lit, 'recognition regex literal not found').toBeTruthy();
  return new RegExp(lit![1], 'i');
}

describe('thin-content quality-reject recovery', () => {
  const rx = extractQualityRejectRegex();

  it('recognises the fatal "Contenuto IT troppo corto dopo N tentativi" message', () => {
    expect(
      rx.test('Contenuto IT troppo corto dopo 6 tentativi + espansione (296/700 parole).'),
    ).toBe(true);
  });

  it('recognises the "Articolo troppo corto dopo retry" char-floor message', () => {
    expect(
      rx.test('Articolo troppo corto dopo retry: 1200 chars (min: 2500). Google penalizza thin content.'),
    ).toBe(true);
  });

  it('recognises the too-short locale field message', () => {
    expect(rx.test('Campo body2 troppo corto per en')).toBe(true);
  });

  it('still does NOT match a genuine infrastructure error', () => {
    expect(rx.test('ENOBUFS: stdout maxBuffer exceeded')).toBe(false);
    expect(rx.test('HTTP 500: internal server error')).toBe(false);
  });

  it('both fatal thin-content throw sites tag err.qualityReject = true', () => {
    // The retry+expand ladder fatal throw.
    expect(SRC).toMatch(
      /shortErr\.qualityReject\s*=\s*true;[\s\S]*?throw shortErr;/,
    );
    // The final char-floor thin-content guard.
    expect(SRC).toMatch(
      /thinErr\.qualityReject\s*=\s*true;[\s\S]*?throw thinErr;/,
    );
  });
});
