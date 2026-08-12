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
 * the two places an assertion can bite:
 *   1. STRUCTURALLY — no top-level script under scripts/ may write the word in
 *      the literal or ternary form the scanner recognises, and every branch a
 *      recipient can CLICK to reach `confirmed` must write the stamp in the
 *      same object;
 *   2. BEHAVIOURALLY — the send gate refuses a `confirmed` row with no stamp
 *      (tests/daily-brief-recipients.test.ts).
 *
 * WHAT THIS FILE DOES **NOT** PROVE, so nobody reads a wider promise into it:
 * `scripts/suppression-decay.mjs:150` writes `status: restoredStatus`, which
 * can still resolve to `'confirmed'` through `recoveredStatus()` →
 * `hasConsentEvidence()`, and it runs weekly with `--apply` from
 * suppression-hygiene.yml. The scanner below does not see it — the value is a
 * bare identifier with no `'confirmed'` literal anywhere near it — and this
 * file makes no claim about it. Closing that one means changing
 * `hasConsentEvidence()` itself, which has other callers; it is tracked as
 * chained work on #5677, not silently covered here.
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
 *
 * THE LIMIT, pinned by a test below rather than left to be discovered: the
 * value expression has to CONTAIN the word. `status: restoredStatus` resolves
 * to 'confirmed' at runtime and is invisible here, and no widening fixes that —
 * a rule broad enough to catch a bare identifier flags every benign computed
 * status in the tree. Catching it needs the value's definition, not a regex.
 */
const WRITES_COMPUTED_CONFIRMED = /status\s*:\s*[^,;}]{0,120}?['"`]confirmed['"`]/;
const writesConfirmed = (src: string) => WRITES_CONFIRMED.test(src) || WRITES_COMPUTED_CONFIRMED.test(src);

describe('no top-level script writes the literal or ternary status: confirmed', () => {
  it('no top-level script under scripts/ writes either form', () => {
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

  it('and it has a known blind spot, recorded here so nobody rediscovers it as a surprise', () => {
    // scripts/suppression-decay.mjs:150 is exactly this shape, and it runs
    // weekly with --apply. The value can still resolve to 'confirmed' through
    // recoveredStatus() → hasConsentEvidence(). The guard does not cover it and
    // does not pretend to; closing it means changing hasConsentEvidence(),
    // which has callers outside #5677.
    expect(writesConfirmed('status: restoredStatus,')).toBe(false);
    expect(read('scripts/suppression-decay.mjs')).toMatch(/status\s*:\s*restoredStatus/);
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

describe('every branch that writes the word writes the proof', () => {
  const src = read('functions/src/newsletterSubscriptionManagement.js');

  /**
   * Split the handler into its `if (action === '…')` blocks.
   *
   * Enumerated rather than named one by one on purpose. The Important that
   * #5677 shipped with was a SECOND branch nobody had looked at: the original
   * test asserted `confirm` and only `confirm`, and read as if the invariant
   * were covered while `resubscribe` sat three hundred lines below writing
   * `confirmed` with no stamp. A test that names the branches it checks can
   * only ever be as complete as its author's list; this one derives the list
   * from the file, so a third branch is covered the day it is written.
   */
  function actionBranches(source: string): Array<{ action: string; body: string }> {
    const re = /if \(action === '([a-z_]+)'\)/g;
    const marks: Array<{ action: string; start: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) marks.push({ action: m[1], start: m.index });
    return marks.map((mk, i) => ({
      action: mk.action,
      body: source.slice(mk.start, i + 1 < marks.length ? marks[i + 1].start : source.length),
    }));
  }

  it('finds the handler branches at all', () => {
    const actions = actionBranches(src).map((b) => b.action);
    expect(actions.length, 'the branch shape changed — re-point this test').toBeGreaterThan(3);
    expect(actions).toContain('confirm');
    expect(actions).toContain('resubscribe');
    expect(actions).toContain('unsubscribe');
  });

  it('EVERY action branch writing status: confirmed also writes confirmed_at and confirmedAt', () => {
    const writers = actionBranches(src).filter((b) => WRITES_CONFIRMED.test(stripComments(b.body)));
    // Both are clicks the RECIPIENT performs. If this list grows, the new
    // entry must be a click too — an automatic path belongs nowhere near it.
    expect(writers.map((b) => b.action).sort()).toEqual(['confirm', 'resubscribe']);
    for (const b of writers) {
      const body = stripComments(b.body);
      expect(body, `branch '${b.action}' writes confirmed with no confirmed_at`).toMatch(/confirmed_at\s*:/);
      expect(body, `branch '${b.action}' writes confirmed with no confirmedAt`).toMatch(/confirmedAt\s*:/);
    }
  });

  it('each of the two records its own event — the second half of the proof', () => {
    const branches = Object.fromEntries(actionBranches(src).map((b) => [b.action, stripComments(b.body)]));
    expect(branches.confirm).toMatch(/event_type\s*:\s*'confirm'/);
    // The resubscribe click is identified by its source_channel, which is the
    // field #5690's isExplicitNewsletterReOptIn() keys on to decide that this
    // — and only this — may lift a recorded opt-out.
    expect(branches.resubscribe).toMatch(/source_channel\s*:\s*'resubscribe_link'/);
  });

  it('the unsubscribe branch does not write the stamp, and does not clear it either', () => {
    // Both halves matter. Writing one there would fabricate consent from an
    // opt-out; CLEARING it would silently demote everyone who ever confirmed
    // and later unsubscribed — and it is precisely this non-deletion that hid
    // the resubscribe defect, since only never-confirmed docs came back bare.
    const body = stripComments(Object.fromEntries(
      actionBranches(src).map((b) => [b.action, b.body]),
    ).unsubscribe);
    expect(body).not.toMatch(WRITES_CONFIRMED);
    expect(body).not.toMatch(/confirmed_at\s*:\s*admin\.firestore\.FieldValue\.delete/);
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
