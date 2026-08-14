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
 * `scripts/suppression-decay.mjs` writes `status: restoredStatus`, which the
 * scanner below cannot see — the value is a bare identifier with no
 * `'confirmed'` literal anywhere near it — and no widening of the regex fixes
 * that. The claim this file makes stops at the literal and the ternary.
 *
 * That path is no longer the hole it was when the paragraph above was written.
 * `restoredStatus` resolves through `recoveredStatus()` → `hasConsentEvidence()`,
 * and #5717 reduced that function to the stamp plus an explicit `confirm`
 * event, so the weekly `--apply` run can no longer mint `confirmed` off a
 * `subscribe_completed` or a signup origin. It is asserted where it can be
 * asserted — behaviourally, over the predicate, in
 * tests/mailtrap-suppression-recovery.test.ts and
 * tests/no-channel-mails-unconfirmed.test.ts — and NOT here, because a source
 * scan is the wrong instrument for a value computed at runtime. The blind spot
 * in the SCANNER is still real and still recorded below; what changed is that
 * nothing dangerous is hiding in it.
 *
 * There are now TWO scripts in that blind spot. `scripts/newsletter-confirmed-
 * status-backfill.mjs` (#5692) writes `status: CONFIRMED_STATUS`, a bare
 * identifier the regex cannot follow, and it is recorded below for the same
 * reason `suppression-decay.mjs` is: a script that passes a guard through the
 * guard's documented hole and says nothing about it has not been checked, it
 * has been missed. Its cover is behavioural too — it may only write onto a
 * document that ALREADY carries the proof, so it cannot fabricate the consent
 * this file exists to protect, and it never writes the stamp itself.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { recoveredStatus } from '../scripts/lib/suppressionDecay.mjs';
import {
  planConfirmedStatusBackfill,
  buildConfirmedStatusFields,
} from '../scripts/newsletter-confirmed-status-backfill.mjs';

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
    // scripts/suppression-decay.mjs is exactly this shape, and it runs weekly
    // with --apply. The value resolves through recoveredStatus() →
    // hasConsentEvidence(), which a regex over this file cannot follow. The
    // guard does not cover it and does not pretend to.
    expect(writesConfirmed('status: restoredStatus,')).toBe(false);
    expect(read('scripts/suppression-decay.mjs')).toMatch(/status\s*:\s*restoredStatus/);
  });

  it('the blind spot is no longer load-bearing — the predicate behind it demands the proof', () => {
    // #5717. The scanner still cannot see the write, so the cover is the
    // PREDICATE instead: `recoveredStatus()` may only reach 'confirmed' on the
    // stamp or an explicit `confirm` event. Asserted here, next to the blind
    // spot, because this is where a reader comes looking for what covers it.
    const doc = { status: 'suppressed', source: 'signup', source_cta: 'job_gate' };
    expect(recoveredStatus('newsletter_subscribers', doc, [{ event_type: 'subscribe_completed' }])).toBe('pending');
    expect(recoveredStatus('newsletter_subscribers', doc, [{ event_type: 'confirm' }])).toBe('confirmed');
    expect(recoveredStatus('newsletter_subscribers', { ...doc, confirmed_at: '2026-01-01T00:00:00Z' })).toBe('confirmed');
  });

  it('the SECOND script in the blind spot is recorded here too, not left to be found', () => {
    // scripts/newsletter-confirmed-status-backfill.mjs (#5692) reaches
    // `confirmed` through the constant CONFIRMED_STATUS, so the scan above does
    // not see it either — the same shape as `status: restoredStatus`, and the
    // reason it is written down HERE instead of being quietly enjoyed. A script
    // that slips past a guard through the guard's own documented hole, and says
    // nothing, is how `alert-pat-down.mjs` came to name a workflow that did not
    // exist behind a green CI.
    //
    // It is not an exception to the rule the describe states. The rule is that a
    // script may not FABRICATE a consent it cannot witness; this one writes only
    // where the witness is already on the document, and that is asserted
    // immediately below rather than claimed.
    const src = stripComments(read('scripts/newsletter-confirmed-status-backfill.mjs'));
    expect(writesConfirmed(src)).toBe(false);
    expect(src).toMatch(/status:\s*CONFIRMED_STATUS/);
    expect(src).toMatch(/CONFIRMED_STATUS = 'confirmed'/);
  });

  it('and the blind spot is not load-bearing there either — proof gates the write', () => {
    // The behavioural cover, next to the blind spot it covers, exactly as the
    // `recoveredStatus` assertion above sits next to its own. The planner is
    // the only producer of the items the writer consumes, so a document it
    // refuses can never reach a `batch.set`.
    const ref = {};
    const pendingNoProof = { id: 'x@example.com', ref, data: { status: 'pending', confirmation_sent_at: '2026-08-01T00:00:00Z' } };
    const withStamp = { id: 'y@example.com', ref, data: { status: 'pending', confirmed_at: '2026-01-01T00:00:00Z' } };
    const withEvent = { id: 'z@example.com', ref, data: { status: 'pending' }, events: [{ event_type: 'confirm' }] };

    expect(planConfirmedStatusBackfill([pendingNoProof]).repair).toEqual([]);
    expect(planConfirmedStatusBackfill([withStamp]).repair).toHaveLength(1);
    // The `confirm` EVENT alone is enough, which is the same standard #5717
    // reduced hasConsentEvidence() to. Both are records of a click.
    expect(planConfirmedStatusBackfill([withEvent]).repair).toHaveLength(1);

    // …and the write it produces is the status word alone: it never mints the
    // stamp this whole file is about. `confirmed` here is only ever written
    // ONTO a document that already carries the proof, so the invariant
    // «confirmed implies confirmed_at» is preserved by construction — a repair
    // that wrote its own evidence would satisfy the invariant while destroying
    // the thing the invariant is for.
    expect(Object.keys(buildConfirmedStatusFields())).toEqual(['status']);
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

  /** `action === 'x'` as an expression, or null for anything else. */
  function actionEquality(expr: ts.Expression): string | null {
    if (!ts.isBinaryExpression(expr)) return null;
    if (expr.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return null;
    if (!ts.isIdentifier(expr.left) || expr.left.text !== 'action') return null;
    if (!ts.isStringLiteral(expr.right)) return null;
    return expr.right.text;
  }

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
   *
   * PARSED, NOT MATCHED (#5717 item 3). This was a plain global regex, which
   * cuts each branch at the next LITERAL occurrence of `if (action === '` —
   * including one inside a comment, a quoted string or a multi-line template
   * literal. This file renders branded HTML from template literals, so the day
   * one of them quotes the handler's own shape (an error message, a docs
   * snippet, a `<code>` sample) a branch would be cut short and everything
   * after the cut would silently leave the body this test asserts over: the
   * invariant goes on passing while covering less.
   *
   * A hand-rolled string-aware walk was tried first and REJECTED by the
   * cross-check below, which is the reason that check exists: it lost
   * `toggle_newsletter_subscription` and `set_daily_brief_frequency`, because
   * skipping quotes and comments is not enough in a file that also contains
   * regex literals — `/[^']/` opens a string to a scanner that does not know
   * what a regex is, and everything after it desyncs. A parser knows. The same
   * `typescript` AST that tests/packages-articles-confinement.test.ts uses to
   * prove the corpus confinement is what this leans on.
   */
  function actionBranches(source: string): Array<{ action: string; body: string }> {
    const sf = ts.createSourceFile(
      'newsletterSubscriptionManagement.js',
      source,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      ts.ScriptKind.JS,
    );
    const marks: Array<{ action: string; start: number }> = [];
    const visit = (node: ts.Node): void => {
      if (ts.isIfStatement(node)) {
        const action = actionEquality(node.expression);
        if (action) marks.push({ action, start: node.getStart(sf) });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    marks.sort((a, b) => a.start - b.start);
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

  it('the parse agrees with the naive scan on the file as it stands today', () => {
    // The cross-check that caught the hand-rolled walk. The naive scan sees
    // every literal occurrence; the parse sees only the ones that are code. On
    // a file with no such occurrence inside a string or a comment the two must
    // be identical — so a divergence means either somebody quoted the shape
    // (fine: the parse is doing its job, and the assertion below covers that
    // case) or the extraction lost a real branch (not fine, and silent).
    const naive = [...src.matchAll(/if \(action === '([a-z_]+)'\)/g)].map((m) => m[1]);
    expect(actionBranches(src).map((b) => b.action)).toEqual(naive);
  });

  it('and it does not split on the shape quoted inside a template literal or a comment', () => {
    // The scenario the guard is for, fed to it directly — otherwise the parse
    // is only ever exercised on a file that never needed it, which is how a
    // "robust" extraction stays untested until the day it matters.
    const synthetic = [
      "if (action === 'confirm') {",
      '  const help = `try if (action === \x27forged\x27) instead`;',
      "  // see if (action === 'alsoforged') in the docs",
      "  const ok = /[^']+/.test(help);",
      "  await db.set({ status: 'confirmed', confirmed_at: STAMP, confirmedAt: STAMP });",
      '}',
      "if (action === 'unsubscribe') { await db.set({ status: 'unsubscribed' }); }",
    ].join('\n');
    const branches = actionBranches(synthetic);
    expect(branches.map((b) => b.action)).toEqual(['confirm', 'unsubscribe']);
    // …and the confirm body still reaches the write below the decoys, one of
    // which is the regex literal that defeated the hand-rolled scanner.
    expect(branches[0].body).toMatch(/confirmed_at/);
    // The naive scan is what this replaces: it finds the decoys and cuts the
    // branch before its own write, which is the silent under-coverage.
    const naive = [...synthetic.matchAll(/if \(action === '([a-z_]+)'\)/g)].map((m) => m[1]);
    expect(naive).toEqual(['confirm', 'forged', 'alsoforged', 'unsubscribe']);
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

  it('the resubscribe branch writes the stamp ONCE and never bumps an existing one (#5717)', () => {
    // The invariant this file asserts is "confirmed implies a stamp", and it
    // survives: the write is skipped only when one is already there. What the
    // skip removes is the RECENCY bump, which is not inert —
    // `classifySuppressionDecay` (scripts/lib/suppressionDecay.mjs) compares
    // `confirmed_at` against `unsubscribed_at` to decide whether an opt-out has
    // been superseded, so a repeated "riattiva" could re-supersede an opt-out
    // on demand. `resubscribed_at` still records the click, unconditionally and
    // in the narrower field that means exactly it.
    const branch = stripComments(Object.fromEntries(
      actionBranches(src).map((b) => [b.action, b.body]),
    ).resubscribe);
    // Guarded by the flag, not written unconditionally…
    expect(branch).toMatch(/priorHasStamp/);
    // …and the flag defaults to "write it", so a failed read cannot cost a
    // first-time re-subscriber the only record of their consent.
    expect(stripComments(src)).toMatch(/let priorHasStamp = false;/);
    // The re-opt-in stamp stays unconditional — it is what lifts the opt-out.
    expect(branch).toMatch(/^\s*resubscribed_at:/m);
    expect(branch).toMatch(/^\s*resubscribedAt:/m);
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
