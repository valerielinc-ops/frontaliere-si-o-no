/**
 * Item 3 of issue #5632: "Gate CI che impedisca la ricomparsa della classe di
 * bug sui dati" — the item the original issue text marked
 * `blocked: dipende dalla PR 233 del corpus`.
 *
 * PR #233 (nanakokyobashi-rgb/frontaliere-articles) merged 2026-08-11T09:07Z,
 * BEFORE #5632 was even opened, so the block that justified deferring this
 * item is already gone. Nothing had built the gate — zero references to a
 * "faq illeggibili" baseline existed in any workflow or script — so this is
 * new construction, not a fix.
 *
 * WHAT THIS PROTECTS
 * -------------------
 * `packages/articles/engine/ogPagesPlugin.ts` reads every article's `.faq`
 * field with: decode -> `JSON.parse` -> keep `{q, a}` pairs with
 * `q.length > 10 && a.length > 20` -> require at least 2 survivors. A `.faq`
 * that fails this read loses BOTH its `FAQPage` JSON-LD and its visible
 * accordion, silently — the only trace is a `console.warn` in the build log
 * (`faqRejected`, added in #5602), which blocks nothing. That silence is
 * exactly how 102 published articles lost their FAQ before #5602 fixed the
 * chain-order defect responsible for most of them.
 *
 * `scripts/lib/faq-readability-gate.mjs` re-runs that same read over the
 * WHOLE corpus (`faqDecodesReadable` mirrors `ogPagesPlugin.ts`'s
 * `faqPairsFromData` logic field for field — see that module's doc comment).
 * `RATCHET_BASELINE` below is the count measured against this PR's corpus
 * snapshot: 26 unreadable `.faq` fields out of 16,308 scanned. It moves DOWN
 * when a repair pass lowers the real count, and this test goes RED the
 * moment anything — a corpus write, a decoder regression, a new writer bug —
 * pushes the count past it.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { faqDecodesReadable, scanCorpusFaqReadability } from '../scripts/lib/faq-readability-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('faqDecodesReadable — the invariant the ratchet below protects', () => {
  it('rejects a faq value damaged by the chain-order bug this issue is about', () => {
    // What a REGRESSED decoder produces for a JSON tab escape `\\t` (correct
    // TS spelling) when `\\` is resolved last: a lone backslash + a space,
    // which is not valid JSON.
    const damaged = String.raw`[{"q":"Domanda numero uno qui?","a":"Risposta\ tabbed abbastanza lunga da passare"},{"q":"Domanda numero due qui?","a":"Un'altra risposta sufficientemente lunga"}]`;
    expect(faqDecodesReadable(damaged)).toBe(false);
  });

  it('accepts the same content correctly escaped', () => {
    const clean = String.raw`[{"q":"Domanda numero uno qui?","a":"Risposta\\ttabbed abbastanza lunga da passare"},{"q":"Domanda numero due qui?","a":"Un'altra risposta sufficientemente lunga"}]`;
    expect(faqDecodesReadable(clean)).toBe(true);
  });

  it('rejects malformed JSON outright', () => {
    expect(faqDecodesReadable('not json at all')).toBe(false);
    expect(faqDecodesReadable(String.raw`[{"q":"unterminated`)).toBe(false);
  });

  it('rejects fewer than 2 usable pairs', () => {
    const onePair = String.raw`[{"q":"Domanda numero uno qui?","a":"Risposta sufficientemente lunga da passare la soglia"}]`;
    expect(faqDecodesReadable(onePair)).toBe(false);
  });

  it('rejects pairs whose q/a fall under the length threshold', () => {
    const tooShort = String.raw`[{"q":"short?","a":"short"},{"q":"also short?","a":"also short"}]`;
    expect(faqDecodesReadable(tooShort)).toBe(false);
  });

  it('accepts exactly 2 usable pairs at the threshold boundary', () => {
    const twoPairs = String.raw`[{"q":"Domanda numero uno qui?","a":"Risposta sufficientemente lunga da passare la soglia"},{"q":"Domanda numero due qui?","a":"Un'altra risposta sufficientemente lunga da passare"}]`;
    expect(faqDecodesReadable(twoPairs)).toBe(true);
  });
});

// Measured against this PR's corpus snapshot (see doc comment above). Lower
// this constant — never raise it — when a repair pass reduces the real
// count; a PR that raises it without a repair is the regression this gate
// exists to catch.
const RATCHET_BASELINE = 26;

describe('corpus FAQ readability ratchet (#5632 item 3)', () => {
  it(`stays at or below the ${RATCHET_BASELINE} unreadable .faq fields planted as the baseline`, () => {
    const { total, unreadable, offenders } = scanCorpusFaqReadability({ root: ROOT });

    // A near-empty scan means the corpus directories weren't found (e.g. a
    // future sparse-checkout profile excluding them) rather than a genuinely
    // clean corpus — fail loudly instead of passing on nothing.
    expect(total).toBeGreaterThan(1000);

    if (unreadable > RATCHET_BASELINE) {
      const sample = offenders
        .slice(0, 10)
        .map((o) => `${o.bodyDir}/${o.locale}/${o.file} (${o.id})`)
        .join('\n  ');
      throw new Error(
        `${unreadable} unreadable .faq fields out of ${total} scanned — ` +
          `${unreadable - RATCHET_BASELINE} more than the RATCHET_BASELINE of ${RATCHET_BASELINE} ` +
          `planted in tests/faq-readability-gate.test.ts.\n` +
          `A .faq the engine's ogPagesPlugin.ts will silently drop (no FAQPage JSON-LD, no visible ` +
          `accordion, only a build-log console.warn) reappeared or grew. First offenders:\n  ${sample}\n` +
          `If these are pre-existing corpus damage being repaired, lower RATCHET_BASELINE to the new count.`,
      );
    }

    expect(unreadable).toBeLessThanOrEqual(RATCHET_BASELINE);
  });
});
