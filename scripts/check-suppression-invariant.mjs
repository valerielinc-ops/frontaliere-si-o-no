#!/usr/bin/env node
/**
 * Suppression invariant monitor.
 *
 * ONE invariant, asserted across every collection a sender reads a suppression
 * `status` from:
 *
 *   No address is blocked from every send without either a HUMAN DECISION
 *   (`complained` / `unsubscribed`) or UNAMBIGUOUS HARD EVIDENCE (a
 *   bounce reason matching HARD_BOUNCE_PATTERN).
 *
 * Anything else — a `bounced`/`suppressed` doc whose recorded reason is a soft
 * or reputation event — is a person we have silently stopped talking to on a
 * machine's guess, with no path back: `status` gates the send, so the
 * delivered/open event that would clear it can never arrive. Measured in
 * production on 2026-08-10: 505 such addresses, 453 of them confirmed signups.
 *
 * This runs AFTER scripts/suppression-decay.mjs in
 * .github/workflows/suppression-hygiene.yml, so what it reports is the
 * RESIDUE — the part the self-heal could not fix on its own. A non-empty
 * no-evidence bucket after a decay pass means one of: the per-run cap has not
 * drained the backlog yet, the reason strings carry a signal the classifier
 * does not read, or a writer is minting new evidence-free suppressions faster
 * than the decay clears them. All three are code-level questions, answerable
 * without production credentials.
 *
 * Buckets (see classifySuppressionEvidence in scripts/lib/suppressionDecay.mjs):
 *   own-choice        the human decided — legitimate
 *   hard-evidence     machine-inferred, unambiguous reason — legitimate
 *   engagement-sunset `inactive` — reversible by-construction on the next
 *                     open/click, reported separately rather than folded into
 *                     a bucket implying evidence it does not have
 *   no-evidence       THE VIOLATION
 *
 * Usage:
 *   node scripts/check-suppression-invariant.mjs
 *
 * Exit 0 when the no-evidence bucket is empty across all collections, 1
 * otherwise. Writes data/suppression-invariant-report.json either way.
 * Requires Firebase application-default credentials (CI: load-rc-env.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  classifySuppressionDecay,
  classifySuppressionEvidence,
  maskAddress,
  publishableReason,
  suppressionReason,
  SUPPRESSION_COLLECTIONS,
} from './lib/suppressionDecay.mjs';

const REPORT_PATH = 'data/suppression-invariant-report.json';
const MAX_OFFENDERS_PER_COLLECTION = 50; // the issue body needs a sample, not a mailing list

let db;

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
}

/**
 * Reasons are grouped and counted rather than listed per address: the actual
 * remediation is always "teach the classifier about this reason string" or
 * "stop the writer that mints it", and both are decided from the DISTRIBUTION
 * of reasons, not from which mailbox happened to hit it. It also keeps a
 * subscriber list out of a public issue body.
 *
 * `publishableReason()` redacts and truncates BEFORE the string becomes a
 * grouping key, because some provider reasons embed the recipient's own
 * address (seen in production: `"<…@icloud.com>: user is over quota"`) and
 * this map is what the workflow renders into a public issue.
 */
function tallyReason(map, reason) {
  const key = publishableReason(reason);
  map.set(key, (map.get(key) || 0) + 1);
}

async function scanCollection(name, nowMs) {
  const snap = await db.collection(name).get();
  const buckets = {
    'own-choice': 0,
    'hard-evidence': 0,
    'probe-exhausted': 0,
    'engagement-sunset': 0,
    'no-evidence': 0,
    'not-suppressed': 0,
  };
  const reasons = new Map();
  const offenders = [];
  // Split the violation by the tier the SELF-HEAL would assign it. Without
  // this the issue body cannot tell "the weekly --apply will clear these, it
  // is just capped" from "these are blocked on an owner decision about sender
  // reputation" — and those two need opposite responses. `none` here means
  // still inside NEVER_PROBED_COOLDOWN_DAYS.
  const noEvidenceByTier = { 'proven-alive': 0, 'never-probed': 0, none: 0, terminal: 0 };

  snap.forEach((doc) => {
    if (doc.id === '_meta_') return;
    const data = doc.data() || {};
    const bucket = classifySuppressionEvidence(data, nowMs);
    buckets[bucket] += 1;
    if (bucket !== 'no-evidence') return;
    noEvidenceByTier[classifySuppressionDecay(data, nowMs).tier] += 1;
    const reason = suppressionReason(data);
    tallyReason(reasons, reason);
    if (offenders.length < MAX_OFFENDERS_PER_COLLECTION) {
      // Masked, not raw: this report is uploaded as a workflow artifact, and
      // the doc id IS the subscriber's address. The domain survives because
      // "all of these are one provider" is the finding worth having.
      offenders.push({
        address: maskAddress(doc.id),
        status: String(data.status || ''),
        reason: publishableReason(reason),
      });
    }
  });

  return {
    scanned: snap.size,
    buckets,
    noEvidenceByTier,
    reasonBreakdown: Object.fromEntries([...reasons.entries()].sort((a, b) => b[1] - a[1])),
    offenders,
  };
}

async function main() {
  await initFirebase();
  const nowMs = Date.now();

  const collections = {};
  const totals = {
    'own-choice': 0,
    'hard-evidence': 0,
    'probe-exhausted': 0,
    'engagement-sunset': 0,
    'no-evidence': 0,
    'not-suppressed': 0,
  };
  const noEvidenceByTier = { 'proven-alive': 0, 'never-probed': 0, none: 0, terminal: 0 };

  for (const name of SUPPRESSION_COLLECTIONS) {
    const result = await scanCollection(name, nowMs);
    collections[name] = result;
    for (const key of Object.keys(totals)) totals[key] += result.buckets[key];
    for (const key of Object.keys(noEvidenceByTier)) noEvidenceByTier[key] += result.noEvidenceByTier[key];
    console.log(`📊 ${name}: ${result.scanned} docs`);
    console.log(`      own-choice        : ${result.buckets['own-choice']}`);
    console.log(`      hard-evidence     : ${result.buckets['hard-evidence']}`);
    console.log(`      probe-exhausted   : ${result.buckets['probe-exhausted']}`);
    console.log(`      engagement-sunset : ${result.buckets['engagement-sunset']}`);
    console.log(`      no-evidence       : ${result.buckets['no-evidence']}`);
    const top = Object.entries(result.reasonBreakdown).slice(0, 5);
    for (const [reason, count] of top) console.log(`         · "${reason}" ×${count}`);
  }

  const violated = totals['no-evidence'] > 0;
  const report = {
    generatedAt: new Date(nowMs).toISOString(),
    invariant: 'no address is suppressed without a human decision or unambiguous hard evidence',
    violated,
    totals,
    noEvidenceByTier,
    collections,
  };

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n📝 Report written to ${REPORT_PATH}`);

  if (violated) {
    console.error(`\n❌ Invariant violated: ${totals['no-evidence']} address(es) suppressed with no evidence.`);
    console.error(
      `   by decay tier — proven-alive: ${noEvidenceByTier['proven-alive']}`
      + ` · never-probed: ${noEvidenceByTier['never-probed']}`
      + ` · in cooldown: ${noEvidenceByTier.none}`,
    );
    process.exit(1);
  }
  console.log('\n✅ Invariant holds — every suppression has a human decision or hard evidence behind it.');
}

main().catch((err) => {
  console.error('[check-suppression-invariant] fatal:', err?.stack || err?.message || err);
  process.exit(1);
});
