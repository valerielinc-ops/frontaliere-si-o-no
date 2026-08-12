/**
 * THE INVARIANT: `status: 'confirmed'` implies `confirmed_at` (#5677).
 *
 * A double-opt-in confirmation is a click, and the click leaves a record:
 * `action === 'confirm'` in functions/src/newsletterSubscriptionManagement.js
 * writes `status: 'confirmed'`, `confirmed_at`, `confirmedAt` and a `confirm`
 * event, all in the same write. A document at `confirmed` with no stamp was
 * therefore not confirmed by anyone — it was DEDUCED, and downstream nothing
 * can tell the two apart.
 *
 * Measured on production 2026-08-12 (8.617 documents): 392 sit at
 * `status: 'confirmed'` with neither `confirmed_at` nor `confirmedAt`. 380 of
 * them carry a restore marker (183 explicitly `mailtrap_suspension_mismapped`)
 * and ZERO of the 392 carry a `confirm` event — against 192 of a 200-doc
 * control sample of properly stamped confirmed docs. The inference is not a
 * weaker version of the click; it is unrelated to it.
 *
 * Nobody noticed because nothing asserted it. This file is that assertion, in
 * the only two places an assertion can bite:
 *   1. STRUCTURALLY — no automatic procedure may write the word at all, and
 *      the one legitimate writer must write the stamp in the same object;
 *   2. BEHAVIOURALLY — the send gate refuses a `confirmed` row with no stamp
 *      (tests/daily-brief-recipients.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Comments are where this invariant is DISCUSSED — including in the two files
 * repaired by #5677 — so a scan that did not strip them would fail on its own
 * documentation and get "fixed" by deleting the explanation.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const WRITES_CONFIRMED = /status\s*:\s*['"`]confirmed['"`]/;
/**
 * A `status:` key whose VALUE EXPRESSION mentions 'confirmed' — which is the
 * pre-#5677 shape `status: confirmed ? 'confirmed' : 'pending'`, and the reason
 * a literal-only scan is not enough: no quote follows the colon there, so
 * WRITES_CONFIRMED alone reads that line as clean.
 *
 * The character class stops at `,` `;` `}` so the match cannot run past the end
 * of the value into an unrelated later property — without that bound, a benign
 * `status: item.status || 'unknown'` followed anywhere by the word would trip
 * it (measured: 5 innocent scripts before the bound was added).
 */
const WRITES_COMPUTED_CONFIRMED = /status\s*:\s*[^,;}]{0,120}?['"`]confirmed['"`]/;
const writesConfirmed = (src: string) => WRITES_CONFIRMED.test(src) || WRITES_COMPUTED_CONFIRMED.test(src);

describe('no automatic procedure may write status: confirmed', () => {
  it('no top-level script under scripts/ writes it', () => {
    // Top-level scripts/*.mjs are the automated runners: cron jobs, workflow
    // steps, recovery passes. None of them has a user in front of it, so none
    // of them can witness a click. scripts/dev/ is deliberately NOT scanned —
    // those are one-off tools run by hand, under the owner's eye.
    const files = readdirSync(path.join(ROOT, 'scripts'), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
      .map((e) => `scripts/${e.name}`);
    expect(files.length).toBeGreaterThan(20); // the scan found the directory

    const offenders = files.filter((f) => writesConfirmed(stripComments(read(f))));
    expect(offenders, 'a script writing status:confirmed fabricates a consent it cannot witness').toEqual([]);
  });

  it('the scan catches BOTH shapes — the literal and the computed one it replaced', () => {
    // Without this the guard is untested itself, and the ternary that #5677
    // removed is precisely the shape a literal-only regex reads as clean.
    expect(writesConfirmed("status: 'confirmed',")).toBe(true);
    expect(writesConfirmed("status: confirmed ? 'confirmed' : 'pending',")).toBe(true);
    expect(writesConfirmed("status: isOk && 'confirmed',")).toBe(true);
    expect(writesConfirmed("status:\n  hasProof\n    ? 'confirmed'\n    : 'pending',")).toBe(true);
    expect(writesConfirmed("status: 'pending',")).toBe(false);
    expect(writesConfirmed("expect(doc.status).toBe('confirmed')")).toBe(false);
    // The bound: a benign computed status must not reach a later 'confirmed'.
    expect(writesConfirmed("status: item.status || 'unknown', note: 'confirmed'")).toBe(false);
  });

  it('the restore pass writes the literal pending, with no branch that could widen', () => {
    const src = stripComments(read('scripts/restore-mailtrap-suspension-suppressions.mjs'));
    expect(src).toMatch(/status\s*:\s*'pending'/);
    // The pre-#5677 shape: `status: confirmed ? 'confirmed' : 'pending'`.
    // A computed restored status is the exact regression to catch.
    expect(writesConfirmed(src)).toBe(false);
  });

  it('the restore pass no longer derives the status from inferred consent', () => {
    const src = stripComments(read('scripts/restore-mailtrap-suspension-suppressions.mjs'));
    // hasConsentEvidence() answers "does anything about this document look like
    // consent?" — measured true for 1.442 of the 1.487 docs whose own status
    // says pending (97%), because AUTO_CONFIRMED_ORIGIN_RE matches the bare
    // `signup` origin. It must not reach a write from here.
    expect(src).not.toMatch(/hasConsentEvidence/);
    expect(src).not.toMatch(/recoveredStatus/);
  });
});

describe('the one legitimate writer writes the proof with the word', () => {
  const src = read('functions/src/newsletterSubscriptionManagement.js');

  it('the confirm branch writes confirmed_at and confirmedAt in the same object as the status', () => {
    const idx = src.indexOf("action === 'confirm'");
    expect(idx, "the confirm branch moved — re-point this test before trusting it").toBeGreaterThan(-1);
    // The branch's own write, bounded well before the next action block.
    const nextAction = src.indexOf("if (action === '", idx + 10);
    const branch = src.slice(idx, nextAction > idx ? nextAction : idx + 4000);
    expect(branch).toMatch(WRITES_CONFIRMED);
    expect(branch).toMatch(/confirmed_at\s*:/);
    expect(branch).toMatch(/confirmedAt\s*:/);
  });

  it('the confirm branch also records the confirm event — the second half of the proof', () => {
    const idx = src.indexOf("action === 'confirm'");
    const nextAction = src.indexOf("if (action === '", idx + 10);
    const branch = src.slice(idx, nextAction > idx ? nextAction : idx + 4000);
    expect(branch).toMatch(/event_type\s*:\s*'confirm'/);
  });
});

/**
 * The invariant as a predicate, so a reader can see what it means without
 * running a scan: `confirmed` is a claim, `confirmed_at` is the evidence, and
 * a claim without evidence is not confirmation.
 */
describe('the invariant, stated', () => {
  const confirmedImpliesStamp = (doc: Record<string, unknown>) =>
    String(doc.status || '').trim().toLowerCase() !== 'confirmed'
    || !!(doc.confirmed_at || doc.confirmedAt);

  it('holds for a properly confirmed document', () => {
    expect(confirmedImpliesStamp({ status: 'confirmed', confirmed_at: '2026-01-01T00:00:00Z' })).toBe(true);
    expect(confirmedImpliesStamp({ status: 'confirmed', confirmedAt: '2026-01-01T00:00:00Z' })).toBe(true);
  });

  it('is violated by exactly the shape the 392 documents have', () => {
    expect(confirmedImpliesStamp({
      status: 'confirmed',
      restored_reason: 'mailtrap_suspension_mismapped',
      source: 'signup',
    })).toBe(false);
  });

  it('says nothing about a pending document — pending carries no claim to back', () => {
    expect(confirmedImpliesStamp({ status: 'pending' })).toBe(true);
    expect(confirmedImpliesStamp({ status: 'pending', confirmed_at: '2026-01-01T00:00:00Z' })).toBe(true);
  });
});
