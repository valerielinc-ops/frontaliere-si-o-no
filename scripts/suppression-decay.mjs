#!/usr/bin/env node
/**
 * Suppression decay runner — the recovery edge that machine-inferred
 * suppressions never had.
 *
 * Policy, tiers and rationale live in scripts/lib/suppressionDecay.mjs (pure,
 * unit-tested). This file is the I/O half: scan, classify, cap, write, report.
 *
 * WHY IT EXISTS. `status` gates every send, and `bounced`/`suppressed` are
 * permanent in practice: once written we stop sending, so the delivered/open
 * event that would clear them can never arrive. The only recoveries that ever
 * happened were hand-run one-offs — and the one that ran queried a SINGLE
 * collection, so `job_alert_subscribers` has never been cleaned at all.
 *
 * WHAT MAKES IT DIFFERENT FROM ITS TWO SIBLINGS. Both channels, from one
 * exported list (SUPPRESSION_COLLECTIONS) rather than a hard-coded query, so a
 * third channel cannot be silently forgotten the way the second one was;
 * `tests/suppression-decay.test.ts` fails if that list stops covering every
 * collection a sender reads a suppression status from.
 *
 * THE PROBE IS THE NORMAL SEND. The `never-probed` tier does not invent a
 * probe message: it un-suppresses a small batch, the next regular newsletter
 * reaches them through the existing cascade, and the provider webhook records
 * `delivered` or `bounce`. Both edges of that loop are existing code — a
 * delivery promotes the address to `proven-alive` permanently, and a genuine
 * hard bounce re-suppresses it via `bounceUpdateFields({ severity: 'hard' })`
 * while a soft signal only increments the counter. This runner only decides
 * how fast addresses are fed in, under the rails in
 * scripts/lib/suppressionDecay.mjs (batch size, re-probe budget, circuit
 * breaker, settle window) plus the kill switch below.
 *
 * Usage:
 *   node scripts/suppression-decay.mjs                          # DRY-RUN, proven-alive
 *   node scripts/suppression-decay.mjs --tier=never-probed      # DRY-RUN, re-probe batch
 *   node scripts/suppression-decay.mjs --apply                  # write (proven-alive)
 *   node scripts/suppression-decay.mjs --apply --tier=never-probed
 *   node scripts/suppression-decay.mjs --apply --limit=25       # tighter cap than the tier default
 *   SUPPRESSION_REPROBE_ENABLED=false node scripts/suppression-decay.mjs --apply --tier=never-probed
 *
 * DRY-RUN is the default, same convention as scripts/job-alert-sunset.mjs and
 * scripts/mailtrap-suppression-retry.mjs. Idempotent: a recovered doc leaves
 * the decayable statuses entirely, so re-running once the backlog is clear
 * classifies every doc as `none` and writes nothing.
 *
 * Requires Firebase application-default credentials (CI: load-rc-env.mjs).
 * Writes data/suppression-decay-report.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { commitInChunks } from './lib/firestore-batch.mjs';
import {
  classifySuppressionDecay,
  compareOldestSuppressionFirst,
  evaluateReprobeCohort,
  maskAddress,
  publishableReason,
  recoveredStatus,
  reprobeBatchId,
  ACTIONABLE_TIERS,
  MAX_DECAY_PER_RUN,
  MAX_REPROBE_ATTEMPTS,
  REPROBE_BATCH_SIZE,
  SUPPRESSION_COLLECTIONS,
} from './lib/suppressionDecay.mjs';

const REPORT_PATH = 'data/suppression-decay-report.json';

const APPLY = process.argv.includes('--apply');

/**
 * Owner override for the circuit breaker. Creates a NEW cohort despite a
 * tripped one, which is the only way the breaker ever clears — it is sticky by
 * construction (see `evaluateReprobeCohort`). Never passed by the cron.
 */
const FORCE_REPROBE = process.argv.includes('--force-reprobe');

function flagValue(name) {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

const TIER = flagValue('tier') || 'proven-alive';
if (!ACTIONABLE_TIERS.includes(TIER)) {
  console.error(`❌ --tier must be one of: ${ACTIONABLE_TIERS.join(', ')} (got "${TIER}")`);
  process.exit(1);
}
const IS_REPROBE = TIER === 'never-probed';

/**
 * KILL SWITCH. Env var, not Remote Config: an RC parameter that is not also
 * added to the RC_TO_ENV table in scripts/load-rc-env.mjs reads as `undefined`
 * however it is set in the console — a silent no-op exactly when someone is
 * trying to stop something. An env var set in the workflow (or by the
 * `workflow_dispatch` input) needs no deploy and cannot fail that way.
 *
 * Default-enabled so a local/manual run behaves as written; disabled by the
 * literal string `false`, which .github/workflows/suppression-hygiene.yml
 * always passes explicitly.
 */
const REPROBE_ENABLED = String(process.env.SUPPRESSION_REPROBE_ENABLED ?? 'true').trim().toLowerCase() !== 'false';

// Per-tier default cap: proven-alive addresses have already accepted mail,
// never-probed ones have not, so they ramp four times slower.
const DEFAULT_LIMIT_BY_TIER = {
  'proven-alive': MAX_DECAY_PER_RUN,
  'never-probed': REPROBE_BATCH_SIZE,
};

const rawLimit = flagValue('limit');
const LIMIT = rawLimit === undefined ? DEFAULT_LIMIT_BY_TIER[TIER] : Number(rawLimit);
if (!Number.isFinite(LIMIT) || LIMIT <= 0) {
  console.error(`❌ --limit must be a positive number (got "${rawLimit}")`);
  process.exit(1);
}

let db;
let FieldValue;

async function initFirebase() {
  const admin = await import('firebase-admin');
  const a = admin.default || admin;
  if (!a.apps?.length) {
    a.initializeApp({
      credential: a.credential.applicationDefault(),
      projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'frontaliere-ticino',
    });
  }
  db = a.firestore();
  ({ FieldValue } = await import('firebase-admin/firestore'));
}

/**
 * Audit trail written on every touched doc. Field names follow what already
 * exists rather than inventing a parallel vocabulary: `bounce_reactivated_at`
 * is what scripts/dev/reactivate-false-positive-bounces.mjs stamps,
 * `mailtrap_suppression_resolved_at`/`reactivated_at` are what
 * scripts/mailtrap-suppression-retry.mjs stamps. Which of the two applies is
 * decided by the status we are decaying FROM, so a later reader can still tell
 * a decayed bounce from a decayed provider suppression.
 */
function recoveryFields({ collection, tier, previousStatus, reason, restoredStatus, priorProbes, batchId }) {
  // `isActive`/`active` follow the RESTORED status, not a blanket true: a
  // newsletter doc coming back as `pending` (no consent evidence) is not an
  // active subscriber, it is one that still owes a double opt-in. Same shape
  // as scripts/restore-mailtrap-suspension-suppressions.mjs's `isActive: confirmed`.
  const fullyMailable = restoredStatus !== 'pending';
  const fields = {
    status: restoredStatus,
    isActive: fullyMailable,
    active: fullyMailable,
    soft_bounce_count: 0,
    previous_suppression_status: previousStatus,
    suppression_decay_tier: tier,
    suppression_decay_reason: reason,
    suppression_decay_at: FieldValue.serverTimestamp(),
  };
  if (previousStatus === 'bounced') {
    fields.previous_bounce_reason = reason;
    fields.bounce_reactivated_at = FieldValue.serverTimestamp();
  } else {
    fields.reactivated_at = FieldValue.serverTimestamp();
    fields.mailtrap_suppression_resolved_at = FieldValue.serverTimestamp();
  }

  if (tier !== 'never-probed') return fields;

  // Re-probe bookkeeping. `reprobe_count` is the budget the classifier reads
  // back (>= MAX_REPROBE_ATTEMPTS ⇒ terminal, never selected again), and
  // `reprobe_batch` is the cohort id the circuit breaker measures on the next
  // run. Written with a literal value rather than FieldValue.increment() so
  // the number is knowable at write time — the exhaustion marker below has to
  // be decided in the same operation.
  const probes = priorProbes + 1;
  fields.reprobe_count = probes;
  fields.reprobe_batch = batchId;
  fields.last_reprobe_at = FieldValue.serverTimestamp();
  if (probes >= MAX_REPROBE_ATTEMPTS) {
    // The terminal marker. Redundant with the count by design: a human reading
    // the doc should not have to know the constant to see that this address is
    // out of budget.
    fields.reprobe_exhausted_at = FieldValue.serverTimestamp();
  }
  return fields;
}

async function scanCollection(name, nowMs) {
  const snap = await db.collection(name).get();
  const tally = { scanned: 0, 'proven-alive': 0, 'never-probed': 0, terminal: 0, none: 0 };
  const candidates = [];
  // Cohort members are collected in the SAME pass as the classification: the
  // breaker needs the previous batch's current status, and a second full read
  // of two 8k-document collections to get it would be pure waste.
  const cohorts = new Map();

  snap.forEach((doc) => {
    if (doc.id === '_meta_') return;
    const data = doc.data() || {};
    tally.scanned += 1;

    const batch = typeof data.reprobe_batch === 'string' ? data.reprobe_batch : null;
    if (batch) {
      if (!cohorts.has(batch)) cohorts.set(batch, []);
      cohorts.get(batch).push(data);
    }

    const verdict = classifySuppressionDecay(data, nowMs);
    tally[verdict.tier] += 1;
    if (verdict.tier !== TIER) return;
    candidates.push({
      ref: doc.ref,
      collection: name,
      data,
      email: String(data.email || doc.id).toLowerCase(),
      // Sort keys for compareOldestSuppressionFirst. `key` is the doc id, so
      // the order is total and identical between two runs over the same data.
      ageDays: verdict.evidence.ageDays,
      key: `${name}/${doc.id}`,
      priorProbes: Number(data.reprobe_count) || 0,
      tier: verdict.tier,
      previousStatus: verdict.evidence.status,
      reason: verdict.evidence.bounceReason,
      verdictReason: verdict.reason,
    });
  });

  return { tally, candidates, cohorts };
}

/**
 * Decide the status each SELECTED candidate is restored to.
 *
 * The `events` subcollection is read only here, for the ≤LIMIT docs actually
 * being written, not during the 15k-doc scan: consent evidence can live in a
 * `confirm` event, and skipping that read would demote genuinely-confirmed
 * subscribers to `pending`. Bounded by the run cap, so the extra reads are a
 * couple hundred at worst.
 *
 * `subscribe_completed` was in that sentence until #5717 and is not evidence:
 * the signup writes it, so it recorded the request and was read as the answer.
 * This path runs weekly with `--apply` (suppression-hygiene.yml) and writes
 * `status: restoredStatus`, which is why the disjunct mattered here more than
 * anywhere — see hasConsentEvidence() in scripts/lib/suppressionDecay.mjs.
 *
 * Non-newsletter collections need no event read at all — `recoveredStatus()`
 * answers unconditionally for them.
 */
async function resolveRestoredStatuses(candidates) {
  for (const c of candidates) {
    if (c.collection !== 'newsletter_subscribers') {
      c.restoredStatus = recoveredStatus(c.collection, c.data);
      continue;
    }
    let events = [];
    try {
      const evSnap = await c.ref.collection('events').get();
      events = evSnap.docs.map((d) => d.data() || {});
    } catch (err) {
      // Fail CLOSED to `pending`: an unreadable event log is not evidence of
      // consent, and `pending` under-delivers rather than fabricating one.
      console.warn(`⚠️  events unreadable for ${c.email}: ${err.message} — restoring as pending`);
    }
    c.restoredStatus = recoveredStatus(c.collection, c.data, events);
  }
}

async function main() {
  await initFirebase();
  const nowMs = Date.now();

  console.log(APPLY ? '🟢 APPLY mode — will write to Firestore' : '🔍 DRY-RUN — no writes (pass --apply to commit)');
  console.log(`   tier=${TIER}  limit=${LIMIT}  collections=${SUPPRESSION_COLLECTIONS.join(', ')}\n`);

  const perCollection = {};
  let allCandidates = [];
  const allCohorts = new Map();

  for (const name of SUPPRESSION_COLLECTIONS) {
    const { tally, candidates, cohorts } = await scanCollection(name, nowMs);
    perCollection[name] = { ...tally, candidates: candidates.length };
    allCandidates = allCandidates.concat(candidates);
    for (const [batch, docs] of cohorts) {
      allCohorts.set(batch, (allCohorts.get(batch) || []).concat(docs));
    }
    console.log(`📊 ${name}: ${tally.scanned} docs`);
    console.log(`      proven-alive : ${tally['proven-alive']}`);
    console.log(`      never-probed : ${tally['never-probed']}`);
    console.log(`      terminal     : ${tally.terminal}`);
    console.log(`      none         : ${tally.none}`);
    console.log(`   → candidates for tier=${TIER}: ${candidates.length}`);
  }

  // ── Rails, in the order that makes each one meaningful ────────────────────
  // Kill switch first (cheapest, and it must win over everything), then the
  // circuit breaker on the PREVIOUS cohort — before a new one is selected, so
  // a bad batch cannot be followed by another one.
  let reprobe = null;
  if (IS_REPROBE) {
    if (!REPROBE_ENABLED) {
      console.log('\n🛑 kill switch: SUPPRESSION_REPROBE_ENABLED=false — no re-probe batch this run.');
      writeReport({
        nowMs,
        perCollection,
        allCandidates,
        selected: [],
        deferred: allCandidates.length,
        reprobe: { enabled: false, allowed: false, halted: false, reason: 'kill switch: SUPPRESSION_REPROBE_ENABLED=false' },
      });
      return;
    }

    const latestBatchId = [...allCohorts.keys()].sort().pop() || null;
    const verdict = evaluateReprobeCohort({ batchId: latestBatchId, docs: allCohorts.get(latestBatchId) || [] }, nowMs);
    reprobe = { enabled: true, forced: FORCE_REPROBE, ...verdict };
    console.log(`\n🔬 previous cohort: ${verdict.reason}`);
    if (verdict.size) {
      console.log(`   size=${verdict.size} hard-bounces=${verdict.hardBounces} complaints=${verdict.complaints} rate=${(verdict.hardBounceRate * 100).toFixed(1)}%`);
    }

    if (!verdict.allowed && !FORCE_REPROBE) {
      console.log(verdict.halted
        ? '🛑 circuit breaker TRIPPED — no new batch. It stays tripped until an owner runs --force-reprobe.'
        : '⏸️  deferring — the previous cohort has not settled yet.');
      writeReport({ nowMs, perCollection, allCandidates, selected: [], deferred: allCandidates.length, reprobe });
      return;
    }
    if (!verdict.allowed && FORCE_REPROBE) {
      console.log('⚠️  --force-reprobe: overriding the breaker on explicit owner instruction.');
    }
  }

  // Deterministic, oldest-suppressed first. Without a total order the cap
  // would slice an arbitrary subset each run, no cohort would have a
  // measurable outcome, and the breaker above would be reading noise.
  allCandidates.sort(compareOldestSuppressionFirst);

  // The cap is GLOBAL, not per collection: it bounds how many real inboxes a
  // single unattended run can reach, and that number does not get bigger
  // because the backlog happens to be spread over two collections.
  const selected = allCandidates.slice(0, LIMIT);
  const deferred = allCandidates.length - selected.length;
  if (deferred > 0) {
    console.log(`\n⏳ ${deferred} candidate(s) deferred to the next run (cap=${LIMIT})`);
  }

  await resolveRestoredStatuses(selected);
  const batchId = reprobeBatchId(nowMs);
  if (IS_REPROBE) for (const c of selected) c.batchId = batchId;

  const restoredTally = selected.reduce((acc, c) => {
    acc[c.restoredStatus] = (acc[c.restoredStatus] || 0) + 1;
    return acc;
  }, {});
  console.log(`\n🔑 restored status: ${Object.entries(restoredTally).map(([k, v]) => `${k}=${v}`).join(' · ') || '(none)'}`);

  const totals = { candidates: allCandidates.length, selected: selected.length, deferred };

  if (!APPLY) {
    console.log('\n🔍 DRY-RUN — no writes. Re-run with --apply to commit.');
    for (const c of selected.slice(0, 10)) {
      console.log(`   [${c.tier}] ${c.collection}/${c.email} → ${c.restoredStatus} — ${c.verdictReason}`);
    }
  } else if (selected.length) {
    // TWO passes, not one: commitInChunks' contract is at most ONE operation
    // per item, and the audit event lives in a subcollection doc of its own.
    // Folding both into a single applyFn would double the ops in a batch whose
    // size guard assumes one, i.e. blow the 500-op cap at exactly the moment
    // the backlog is large enough to matter.
    totals.written = await commitInChunks(db, selected, (batch, it) => {
      batch.set(it.ref, recoveryFields(it), { merge: true });
    });
    totals.auditEvents = await commitInChunks(db, selected, (batch, it) => {
      batch.set(it.ref.collection('events').doc(), {
        event_type: 'suppression_decay',
        tier: it.tier,
        previous_status: it.previousStatus,
        restored_status: it.restoredStatus,
        reprobe_batch: IS_REPROBE ? batchId : null,
        reason: it.verdictReason,
        timestamp: FieldValue.serverTimestamp(),
      });
    });
    console.log(`\n✅ Decayed ${totals.written} suppression(s) (tier=${TIER}), ${totals.auditEvents} audit event(s) written`);
    if (IS_REPROBE) console.log(`   cohort id: ${batchId} — next run measures its outcome before releasing another batch.`);
  } else {
    totals.written = 0;
    totals.auditEvents = 0;
    console.log('\n✅ Nothing to decay — backlog clear for this tier.');
  }

  writeReport({
    nowMs,
    perCollection,
    allCandidates,
    selected,
    deferred,
    totals,
    restoredTally,
    reprobe: reprobe && { ...reprobe, newBatchId: APPLY && selected.length ? batchId : null },
  });
}

/**
 * The machine-readable report. Always written, including on every early return
 * above — a run that halted must leave a record saying so, because the workflow
 * renders `reprobe.halted` into the escalation issue and a missing file would
 * read as "nothing happened".
 *
 * NOTE on persistence: this file does NOT survive between GitHub Actions runs.
 * It is the run's artifact, not the breaker's memory — the breaker recomputes
 * from the `reprobe_batch` stamps in Firestore every time (see
 * `evaluateReprobeCohort`), which is why a lost report cannot re-arm it.
 */
function writeReport({ nowMs, perCollection, allCandidates, selected, deferred, totals, restoredTally, reprobe }) {
  const report = {
    generatedAt: new Date(nowMs).toISOString(),
    mode: APPLY ? 'apply' : 'dry-run',
    tier: TIER,
    limit: LIMIT,
    collections: perCollection,
    totals: totals || { candidates: allCandidates.length, selected: selected.length, deferred },
    restoredStatus: restoredTally || {},
    reprobe: reprobe || null,
    // Masked + redacted: the REPORT is uploaded as a workflow artifact, so it
    // must not carry a subscriber list, and some provider reason strings embed
    // the recipient's own address (production 2026-08-10:
    // `"<…@icloud.com>: user is over quota"`). The console preview keeps the
    // real addresses — that output is for the operator running the dry-run, and
    // is neither committed nor uploaded, same as the
    // `console.log(… s.email)` preview in scripts/mailtrap-suppression-retry.mjs.
    selectedSample: selected.slice(0, 25).map((c) => ({
      collection: c.collection,
      address: maskAddress(c.email),
      previousStatus: c.previousStatus,
      restoredStatus: c.restoredStatus,
      reprobeCount: c.priorProbes == null ? null : c.priorProbes + (IS_REPROBE ? 1 : 0),
      reason: publishableReason(c.reason),
      verdict: publishableReason(c.verdictReason),
    })),
  };

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`📝 Report written to ${REPORT_PATH}`);
}

main().catch((err) => {
  console.error('[suppression-decay] fatal:', err?.stack || err?.message || err);
  process.exit(1);
});
