#!/usr/bin/env node
/**
 * newsletter-confirmed-status-backfill.mjs — repair the STATUS WORD on the
 * documents a retired script overwrote, and repair nothing else (#5692).
 *
 * 843 documents in `newsletter_subscribers` say `status: 'pending'` while
 * carrying `confirmed_at`. They are not pending: `scripts/mailtrap-suppression-
 * retry.mjs` wrote `status: 'pending', isActive: true` over a previously
 * confirmed address as a DELIVERABILITY re-probe, where `pending` meant
 * "re-probe me" and not "never consented". That script does not run any more.
 * The documents it damaged are still here.
 *
 * Everything that reads consent through `hasConfirmationProof`
 * (functions/src/lib/subscriberConsent.js) already treats them correctly — it
 * is why `decideConfirmationFollowup` answers `already-confirmed` for all 843
 * and why the follow-up runner's `due_now` is 0. What is NOT correct is the
 * word itself: any reader that looks at `status` alone, and there will always
 * be one, counts 843 confirmed subscribers as unconfirmed.
 *
 * ── THE OWNER'S THREE CONSTRAINTS, WHICH ARE THE WHOLE DESIGN ──────────────
 *
 *   1. «Riempi i dati mancanti SENZA rimandare email.» There is no sender in
 *      this file and no import that could reach one. The repair is a status
 *      word; a person who confirmed in March is not written to in August to
 *      celebrate it.
 *   2. «Ricostruisci lo stato vero dagli EVENTI, non dallo status.» The
 *      selection criterion is PROOF, never the word being repaired: the
 *      `confirm` event in `newsletter_subscribers/{email}/events`, or the flat
 *      `confirmed_at`/`confirmedAt` stamp, whichever exists. Both are records
 *      of a click the recipient made (see subscriberConsent.js); neither is an
 *      inference from a signup form.
 *   3. «Mailtrap non si usa più.» Nothing here consults a provider, a
 *      suppression list or a deliverability signal. The damage is in Firestore
 *      and the repair is in Firestore.
 *
 * ── WHY `status` IS NEVER THE CRITERION, EVEN WHEN `status` IS THE TARGET ───
 *
 * Measured on 2026-08-13 over 8.670 documents, and it is the reason this file
 * is careful rather than short: closing the `pending` backlog on the word alone
 * would have hit 848 valid consents against 866 genuine ghosts. The word is
 * wrong in BOTH directions — 392 documents say `confirmed` with no stamp and no
 * `confirm` event behind them, put there by a recovery procedure that DEDUCED
 * consent from the signup origin. This script does not touch those either: it
 * only ever moves a document TOWARDS the state its own evidence already
 * supports, and it has no branch that writes `pending` over anything.
 *
 * ── THE TWO SOURCES, AND WHY BOTH ARE READ ─────────────────────────────────
 *
 * The flat stamp and the `confirm` event coincided exactly when this was
 * written: zero `pending` documents carried the event without the stamp. That
 * is a measurement, not an invariant — the stamp is overwritten by later
 * `.set({merge:true})` calls and the event subcollection is append-only, so the
 * shapes CAN diverge, and if they ever do the event is the more durable record.
 * So the criterion is the disjunction, the run reports `event_only` as its own
 * number, and an operator reading a non-zero there learns that the coincidence
 * has broken without having to already suspect it.
 *
 * Events are fetched only for the documents the flat stamp does NOT already
 * answer for — proof is proof, and a second read cannot make it truer. That
 * keeps the subcollection reads bounded to the few hundred `pending` documents
 * with no stamp instead of one per subscriber.
 *
 * ── WHAT IT REFUSES TO DO ──────────────────────────────────────────────────
 *
 * ONE FIELD. `buildConfirmedStatusFields()` returns `{status}` and nothing
 * else, and the apply path has no second `batch.set`. Not `confirmed_at` (it is
 * the evidence — a repair that writes its own evidence proves nothing), not
 * `isActive`, not `updated_at`. `updated_at` is load-bearing elsewhere: the
 * issue cooldown reads it and bot writes refreshing it is how 13 issues went
 * into permanent stall, and the same field on a subscriber gates re-engagement
 * timing. A cosmetic status repair must not move a clock that decides who gets
 * written to. tests/newsletter-confirmation-followup.test.ts drives the apply
 * path against a Firestore double and fails on any second key.
 *
 * A CONSEQUENCE, REPORTED RATHER THAN ACTED ON: a repaired document whose
 * `isActive` is falsy ends up `confirmed` + inactive. That is the fail-CLOSED
 * half of the mismatch #5733 was about — such a record is skipped by senders,
 * which is the safe direction — and fixing it is a second decision with a
 * second risk. The dry-run prints the count under `repair_with_inactive_flag`
 * so the decision is made with the number in hand, not discovered later.
 *
 * OPT-OUTS ARE EXCLUDED, and this is the trap that would make an otherwise
 * correct script destructive. `decideConfirmationFollowup` asks
 * `hasConfirmationProof` BEFORE it asks about opt-outs, so a document that both
 * confirmed once and later unsubscribed never reaches its opt-out branch and is
 * invisible in that runner's `opt-out` bucket. Writing `confirmed` over its
 * `pending` would take a person who asked to be left alone and hand the senders
 * a mailable status — the exact shape of the 186 resurrected by a login flow.
 * Their true status is `unsubscribed`, not `confirmed`, and writing THAT is a
 * different decision that nobody has taken. They are counted under
 * `opt-out-bound` and left alone.
 *
 * NEVER-ASKED DOCUMENTS ARE EXCLUDED BY CONSTRUCTION. The cohort the follow-up
 * runner calls `never_asked_backlog` is `pending` with no proof of anything;
 * the proof gate is the first thing asked here, so they cannot be selected. The
 * number is 0 today and the exclusion does not depend on it staying 0.
 *
 * ── IDEMPOTENT, AND NOT BY PROMISE ─────────────────────────────────────────
 *
 * A repaired document is `confirmed`, and `confirmed` is not `pending`, so the
 * next run does not select it — the selection predicate is its own completion
 * check. Running this twice repairs the same document once and counts it once.
 *
 * ── IT STOPS IF THE COHORT IS NOT THE COHORT ───────────────────────────────
 *
 * `--apply` refuses when the number found is far from the expected 843. A large
 * drift does not mean "more work to do", it means the query is looking at
 * something else — a truncated read, a changed collection, a writer nobody
 * knew about putting `pending` back over confirmations. The dry-run always
 * prints the number, drift or not, because a number an operator cannot see is
 * a guard that only ever fires in the dark.
 *
 * Usage:
 *   node scripts/newsletter-confirmed-status-backfill.mjs            # DRY-RUN
 *   node scripts/newsletter-confirmed-status-backfill.mjs --json
 *   node scripts/newsletter-confirmed-status-backfill.mjs --sample 25
 *   node scripts/newsletter-confirmed-status-backfill.mjs --apply    # writes `status` only
 *   node scripts/newsletter-confirmed-status-backfill.mjs --apply --expected 812
 *   node scripts/newsletter-confirmed-status-backfill.mjs --show-emails
 */
import { pathToFileURL } from 'node:url';
import { hasConfirmationProof } from '../services/subscriberConsent.mjs';
import { isNewsletterOptOutBinding } from '../functions/src/lib/newsletterOptOut.js';
import { commitInChunks } from './lib/firestore-batch.mjs';

const COLLECTION = 'newsletter_subscribers';
const EVENTS_SUBCOLLECTION = 'events';

/** The word being repaired — the only `status` this script will read as a candidate. */
export const REPAIRABLE_STATUS = 'pending';

/**
 * The word written in its place.
 *
 * The same one `action === 'confirm'` writes in
 * functions/src/newsletterSubscriptionManagement.js, because the whole claim of
 * this script is that these documents should already say what a confirmation
 * click says.
 */
export const CONFIRMED_STATUS = 'confirmed';

/** The `event_type` a confirmation click appends. */
export const CONFIRM_EVENT_TYPE = 'confirm';

/**
 * How many documents this is expected to find, measured 2026-08-14 by
 * `node scripts/newsletter-confirmation-followups.mjs --json`
 * (`skipped.already-confirmed`).
 */
export const EXPECTED_REPAIR_COHORT = 843;

/**
 * How far the count may drift before `--apply` refuses.
 *
 * Relative, with an absolute floor so the band does not collapse if a later
 * operator passes a small `--expected`. The cohort can only SHRINK on its own —
 * its writer is retired, and a member leaves it by confirming, unsubscribing or
 * expiring — so growth past the band is the louder signal of the two: it means
 * something is writing `pending` over confirmations again.
 */
export const COHORT_DRIFT_RATIO = 0.1;
export const COHORT_DRIFT_FLOOR = 50;

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

function argValue(flag, argv = process.argv) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * `a***@example.com` — the default, as in the sibling runner. Every row here is
 * somebody whose record we are correcting, not a debugging fixture.
 * @param {string} email
 * @returns {string}
 */
export function maskEmail(email) {
  const [local = '', domain = ''] = String(email || '').split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}

/**
 * Did this document's event log record a confirmation click?
 *
 * The append-only half of the proof. Accepts the already-read events rather
 * than a ref so the whole planner stays pure and driveable from a test with no
 * Firestore — the property that let the sibling runner be tested at all.
 *
 * @param {Array<Record<string, any>>|null|undefined} events
 * @returns {boolean}
 */
export function hasConfirmEvent(events) {
  if (!Array.isArray(events)) return false;
  return events.some((e) => norm(e?.event_type) === CONFIRM_EVENT_TYPE);
}

/**
 * Which record proves this person confirmed, or `null` if none does.
 *
 * The disjunction of the two sources, reported as WHICH one answered so the
 * run can measure their agreement instead of assuming it. `null` is the answer
 * that keeps a document out of the repair set, and it is the only answer that
 * needs to be right for this script to be safe.
 *
 * @param {{data?: Record<string, any>, events?: Array<Record<string, any>>}} doc
 * @returns {'both'|'flat'|'event'|null}
 */
export function confirmationProofSource(doc) {
  const flat = hasConfirmationProof(doc?.data);
  const event = hasConfirmEvent(doc?.events);
  if (flat && event) return 'both';
  if (flat) return 'flat';
  if (event) return 'event';
  return null;
}

/**
 * The exact write. One field, by construction, in the one place that builds it.
 *
 * A function and not an inline literal so there is a single symbol a test can
 * assert the shape of AND a single symbol the apply path can be shown to use —
 * the two halves of "it writes only `status`" that a source scan could only
 * guess at.
 *
 * @returns {{status: string}}
 */
export function buildConfirmedStatusFields() {
  return { status: CONFIRMED_STATUS };
}

/**
 * Split the collection into what gets repaired and what explicitly does not.
 *
 * Pure. The order of the gates is the safety property, so it is stated rather
 * than left to reading order:
 *   1. not `pending` → not this script's business, in either direction;
 *   2. NO PROOF → never touched. This is the gate whose removal turns a repair
 *      into the destruction of the never-asked cohort, and it is asserted by
 *      its own test;
 *   3. a binding opt-out → left `pending`, counted, never made mailable.
 * Only what survives all three is written to.
 *
 * @param {Array<{id: string, data: Record<string, any>, events?: Array<Record<string, any>>, ref?: unknown}>} docs
 * @returns {{total: number, repair: Array<object>, skipped: Record<string, number>,
 *   proofSources: Record<string, number>, eventOnly: number, inactiveFlag: number}}
 */
export function planConfirmedStatusBackfill(docs) {
  const repair = [];
  const skippedByReason = new Map();
  const proofSources = new Map();
  let eventOnly = 0;
  let inactiveFlag = 0;

  const skip = (reason) => skippedByReason.set(reason, (skippedByReason.get(reason) || 0) + 1);

  for (const doc of docs) {
    if (norm(doc?.data?.status) !== REPAIRABLE_STATUS) {
      skip('not-pending');
      continue;
    }

    // THE GATE. `status: 'pending'` with nothing behind it is a person who was
    // asked and never answered — writing `confirmed` there would fabricate a
    // consent, which is the one failure this whole area exists to prevent.
    const proof = confirmationProofSource(doc);
    if (!proof) {
      skip('no-confirmation-proof');
      continue;
    }

    // Counted before the opt-out gate so the divergence measurement covers
    // every proven document, including the ones deliberately left alone.
    proofSources.set(proof, (proofSources.get(proof) || 0) + 1);
    if (proof === 'event') eventOnly += 1;

    // See the docblock: proof is asked first in the follow-up policy too, so
    // these documents are invisible in ITS opt-out bucket. `confirmed` over a
    // recorded opt-out is a resurrection, not a repair.
    if (isNewsletterOptOutBinding(doc.data)) {
      skip('opt-out-bound');
      continue;
    }

    if (!(doc.data?.isActive ?? doc.data?.active)) inactiveFlag += 1;
    repair.push({ ...doc, proof });
  }

  return {
    total: docs.length,
    repair,
    proofSources: Object.fromEntries([...proofSources.entries()].sort((a, b) => b[1] - a[1])),
    eventOnly,
    inactiveFlag,
    skipped: Object.fromEntries([...skippedByReason.entries()].sort((a, b) => b[1] - a[1])),
  };
}

/**
 * Is the cohort we found the cohort we came for?
 *
 * Pure and exported so the band is a tested number rather than an inline
 * comparison nobody reads. `ok:false` stops `--apply`; it never stops the
 * dry-run, whose entire job is to show the operator the number that is out of
 * band.
 *
 * @param {{found: number, expected?: number, ratio?: number, floor?: number}} args
 * @returns {{ok: boolean, found: number, expected: number, min: number, max: number, drift: number, reason: string|null}}
 */
export function assessCohortDrift({
  found,
  expected = EXPECTED_REPAIR_COHORT,
  ratio = COHORT_DRIFT_RATIO,
  floor = COHORT_DRIFT_FLOOR,
} = {}) {
  const tolerance = Math.max(floor, Math.round(expected * ratio));
  const min = Math.max(0, expected - tolerance);
  const max = expected + tolerance;
  const drift = found - expected;
  if (found < min) {
    return { ok: false, found, expected, min, max, drift, reason: 'cohort-smaller-than-expected' };
  }
  if (found > max) {
    return { ok: false, found, expected, min, max, drift, reason: 'cohort-larger-than-expected' };
  }
  return { ok: true, found, expected, min, max, drift, reason: null };
}

/**
 * Write the repair. One `set({merge:true})` per document, carrying exactly what
 * `buildConfirmedStatusFields()` returns and nothing assembled here.
 *
 * Exported so the field-scope invariant is tested against the real write path
 * and not against a builder the write path might not use: the test drives this
 * with a Firestore double whose refs throw on `.collection()`, so a stray event
 * write or a second field fails loudly instead of shipping.
 *
 * @param {unknown} db
 * @param {Array<{ref: unknown}>} items
 * @param {{chunkSize?: number}} [opts]
 * @returns {Promise<number>} documents written
 */
export async function applyConfirmedStatusBackfill(db, items, opts = {}) {
  return commitInChunks(
    db,
    items,
    (batch, item) => {
      batch.set(item.ref, buildConfirmedStatusFields(), { merge: true });
    },
    opts,
  );
}

/**
 * Read `confirm` events for the documents the flat stamp does not already
 * answer for.
 *
 * Bounded twice over: only `pending` documents reach it, only those without a
 * stamp, and each read is `where(event_type == 'confirm').limit(1)` — the
 * question is "is there one", never "give me the log". A small pool keeps the
 * round trips overlapping without opening hundreds of streams at once.
 *
 * @param {Array<{id: string, data: Record<string, any>, ref: any}>} docs
 * @param {{concurrency?: number}} [opts]
 * @returns {Promise<Map<string, Array<Record<string, any>>>>}
 */
async function fetchConfirmEvents(docs, { concurrency = 16 } = {}) {
  const targets = docs.filter(
    (d) => norm(d.data?.status) === REPAIRABLE_STATUS && !hasConfirmationProof(d.data),
  );
  const byId = new Map();
  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const doc = targets[cursor++];
      const snap = await doc.ref
        .collection(EVENTS_SUBCOLLECTION)
        .where('event_type', '==', CONFIRM_EVENT_TYPE)
        .limit(1)
        .get();
      byId.set(doc.id, snap.docs.map((e) => e.data()));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  return byId;
}

async function initFirebase() {
  const admin = await import('firebase-admin');
  const a = admin.default || admin;
  if (!a.apps?.length) {
    a.initializeApp({
      credential: a.credential.applicationDefault(),
      projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'frontaliere-ticino',
    });
  }
  return a.firestore();
}

async function main() {
  const apply = process.argv.includes('--apply');
  const asJson = process.argv.includes('--json');
  const showEmails = process.argv.includes('--show-emails');
  const skipEvents = process.argv.includes('--no-events');
  const sampleRaw = argValue('--sample');
  const sampleSize = sampleRaw ? Number.parseInt(sampleRaw, 10) : 20;
  const expectedRaw = argValue('--expected');
  const expected = expectedRaw ? Number.parseInt(expectedRaw, 10) : EXPECTED_REPAIR_COHORT;
  if (!Number.isFinite(expected) || expected < 0) {
    console.error(`[confirmed-status-backfill] unusable --expected: ${expectedRaw}`);
    process.exit(2);
  }

  const db = await initFirebase();
  const nowIso = new Date().toISOString();

  // The whole collection, like the sibling runner and for the same reason: the
  // skip buckets ARE the report. A server-side `where('status','==','pending')`
  // would hand back a repair set with no denominator to judge it against.
  const snap = await db.collection(COLLECTION).get();
  const docs = snap.docs.map((d) => ({ id: d.id, data: d.data(), ref: d.ref }));

  if (!skipEvents) {
    const events = await fetchConfirmEvents(docs);
    for (const doc of docs) {
      if (events.has(doc.id)) doc.events = events.get(doc.id);
    }
  }

  const plan = planConfirmedStatusBackfill(docs);
  const drift = assessCohortDrift({ found: plan.repair.length, expected });

  const summary = {
    ran_at: nowIso,
    mode: apply ? 'apply' : 'dry-run',
    documents: plan.total,
    to_repair: plan.repair.length,
    expected,
    drift_band: [drift.min, drift.max],
    drift: drift.drift,
    drift_ok: drift.ok,
    drift_reason: drift.reason,
    // Which record answered for each repaired document. `event_only` is the
    // measurement the owner asked to be re-verified: the two sources coincided
    // exactly when this was written, and a non-zero here says they no longer do.
    proof_sources: plan.proofSources,
    event_only: plan.eventOnly,
    events_read: skipEvents ? 'skipped (--no-events)' : 'yes',
    // Reported, never acted on — see the docblock. `confirmed` + inactive is
    // the fail-closed half of the mismatch and a separate decision.
    repair_with_inactive_flag: plan.inactiveFlag,
    written_fields: Object.keys(buildConfirmedStatusFields()),
    skipped: plan.skipped,
  };
  const sample = plan.repair.slice(0, Math.max(0, sampleSize)).map((it) => ({
    id: showEmails ? it.id : maskEmail(it.id),
    proof: it.proof,
    status: it.data?.status ?? null,
  }));

  if (asJson) {
    console.log(JSON.stringify({ ...summary, sample }, null, 2));
  } else {
    console.log(`[confirmed-status-backfill] ${summary.mode} · ${summary.documents} documents`);
    console.log(`  → to repair (${REPAIRABLE_STATUS} WITH proof): ${summary.to_repair} (expected ~${expected}, band ${drift.min}-${drift.max})`);
    console.log(`  → proof sources: ${JSON.stringify(summary.proof_sources)} · event-only: ${summary.event_only}`);
    console.log(`  → fields written: ${JSON.stringify(summary.written_fields)}`);
    console.log(`  → repaired docs whose isActive/active is falsy (left alone, reported): ${summary.repair_with_inactive_flag}`);
    console.log(`  → skipped: ${JSON.stringify(summary.skipped)}`);
    for (const row of sample) {
      console.log(`     ${row.id} · proof: ${row.proof} · status: ${row.status}`);
    }
  }

  if (!drift.ok) {
    console.error(
      `[confirmed-status-backfill] COHORT DRIFT (${drift.reason}): found ${drift.found}, expected ${drift.expected} (band ${drift.min}-${drift.max}). ` +
        'A drift this size means this is not the same population — re-measure with scripts/newsletter-confirmation-followups.mjs --json before overriding with --expected.',
    );
    if (apply) {
      process.exitCode = 1;
      console.error('[confirmed-status-backfill] refusing to write.');
      return;
    }
  }

  if (!apply) {
    console.log('[confirmed-status-backfill] DRY-RUN — nothing written, nothing sent. Re-run with --apply.');
    return;
  }

  const written = await applyConfirmedStatusBackfill(db, plan.repair);
  console.log(`[confirmed-status-backfill] status repaired on ${written} document(s). No email was sent and no other field was written.`);
}

// Guarded, never called at module scope: the sibling runner documents why
// (importing scripts/newsletter-sunset.mjs RUNS it), and every exported symbol
// above is imported by tests/newsletter-confirmation-followup.test.ts.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error('[confirmed-status-backfill] failed:', err);
    process.exit(1);
  });
}
