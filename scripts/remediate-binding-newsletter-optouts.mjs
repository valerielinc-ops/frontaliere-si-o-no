#!/usr/bin/env node
/**
 * Repair newsletter documents whose durable opt-out still binds but whose
 * last-writer-wins status/flags make them look mailable.
 *
 * The sender-side guard is the immediate protection. This script repairs the
 * inconsistent production rows as well, so admin views, future writers and
 * operational queries see the same decision. It never deletes a subscriber or
 * an opt-out stamp: the address remains a suppression record.
 *
 * Usage:
 *   node scripts/remediate-binding-newsletter-optouts.mjs       # dry-run
 *   node scripts/remediate-binding-newsletter-optouts.mjs --apply
 *   node scripts/remediate-binding-newsletter-optouts.mjs --limit 10
 *
 * `--apply` is intentionally required. Re-running after a successful repair is
 * idempotent because repaired rows are no longer selected.
 */

import admin from 'firebase-admin';
import { isNewsletterOptOutBinding } from '../services/newsletterOptOut.mjs';
import { ADDRESS_SUPPRESSED_STATUSES } from '../services/emailSuppression.mjs';

const COLLECTION = 'newsletter_subscribers';
const EVENT_TYPE = 'opt_out_integrity_repaired';
const APPLY = process.argv.includes('--apply');

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}

const parsedLimit = Number(argValue('--limit'));
const LIMIT = Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 0;

function normalizeStatus(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

/**
 * Select only rows where the opt-out is still binding and the current state
 * could contradict it. A hard address suppression keeps its own status; the
 * flags are still repaired if a stale writer left either one true.
 */
export function needsOptOutRepair(data) {
  if (!data || !isNewsletterOptOutBinding(data)) return false;
  const status = normalizeStatus(data.status);
  const statusIsSuppressed = status === 'unsubscribed' || ADDRESS_SUPPRESSED_STATUSES.has(status);
  const hasLiveFlag = data.isActive === true || data.active === true;
  return !statusIsSuppressed || hasLiveFlag;
}

/**
 * Pure parent-document part of the repair. The original opt-out fields are
 * deliberately absent: preserving them is what makes the repair auditable
 * and lets the shared supersession predicate continue to reason about the row.
 */
export function buildOptOutRepairFields(data) {
  const previousStatus = normalizeStatus(data?.status);
  const nextStatus = previousStatus === 'unsubscribed' || ADDRESS_SUPPRESSED_STATUSES.has(previousStatus)
    ? previousStatus
    : 'unsubscribed';
  return {
    status: nextStatus,
    isActive: false,
    active: false,
    opt_out_integrity_repair_reason: 'binding_opt_out',
  };
}

function maskEmail(value) {
  const email = String(value || '');
  const at = email.indexOf('@');
  if (at < 0) return '(invalid)';
  return `${email.slice(0, 2)}***@${email.slice(at + 1, at + 2)}***`;
}

function previousFlag(value) {
  return value === true ? 'true' : value === false ? 'false' : 'missing';
}

function initFirebase() {
  if (admin.apps.length > 0) return;
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'frontaliere-ticino',
  });
}

async function loadPlans(db) {
  const snapshot = await db.collection(COLLECTION).get();
  const plans = [];
  for (const doc of snapshot.docs) {
    if (doc.id === '_meta_') continue;
    if (!needsOptOutRepair(doc.data() || {})) continue;
    plans.push({ id: doc.id, ref: doc.ref, data: doc.data() || {} });
    if (LIMIT && plans.length >= LIMIT) break;
  }
  return {
    total: snapshot.size - (snapshot.docs.some((doc) => doc.id === '_meta_') ? 1 : 0),
    plans,
  };
}

function printPlanSummary(total, plans) {
  const byStatus = {};
  for (const plan of plans) {
    const status = normalizeStatus(plan.data.status) || '(missing)';
    byStatus[status] = (byStatus[status] || 0) + 1;
  }
  console.log(JSON.stringify({
    collection: COLLECTION,
    scanned: total,
    selected: plans.length,
    limited: Boolean(LIMIT),
    byPreviousStatus: byStatus,
    mode: APPLY ? 'apply' : 'dry-run',
  }));
  plans.slice(0, 20).forEach((plan) => {
    console.log(`  ${maskEmail(plan.id)}  ${normalizeStatus(plan.data.status) || '(missing)'} → ${buildOptOutRepairFields(plan.data).status}  isActive=${previousFlag(plan.data.isActive)} active=${previousFlag(plan.data.active)}`);
  });
  if (plans.length > 20) console.log(`  … altri ${plans.length - 20} record`);
}

export async function applyPlans(db, plans, { fieldValue = admin.firestore.FieldValue } = {}) {
  let written = 0;
  for (const plan of plans) {
    const applied = await db.runTransaction(async (transaction) => {
      // `loadPlans()` is only a candidate snapshot. Re-read inside the
      // transaction so a concurrent explicit re-opt-in wins over this repair.
      const currentSnapshot = await transaction.get(plan.ref);
      if (!currentSnapshot.exists) return false;
      const currentData = currentSnapshot.data() || {};
      if (!needsOptOutRepair(currentData)) return false;

      const repairFields = buildOptOutRepairFields(currentData);
      const occurredAt = new Date().toISOString();
      transaction.set(plan.ref, {
        ...repairFields,
        opt_out_integrity_repaired_at: fieldValue.serverTimestamp(),
        opt_out_integrity_repairedAt: fieldValue.serverTimestamp(),
        updated_at: fieldValue.serverTimestamp(),
        updatedAt: fieldValue.serverTimestamp(),
      }, { merge: true });
      const eventRef = plan.ref.collection('events').doc();
      transaction.set(eventRef, {
        email: plan.id,
        event_type: EVENT_TYPE,
        source_channel: 'remediation',
        repair_reason: 'binding_opt_out',
        previous_status: normalizeStatus(currentData.status) || null,
        previous_isActive: currentData.isActive ?? null,
        previous_active: currentData.active ?? null,
        repaired_status: repairFields.status,
        occurred_at: occurredAt,
        timestamp: fieldValue.serverTimestamp(),
      });
      return true;
    });
    if (applied) written += 1;
  }
  return written;
}

async function main() {
  initFirebase();
  const db = admin.firestore();
  const { total, plans } = await loadPlans(db);
  printPlanSummary(total, plans);
  if (!APPLY) {
    console.log('DRY-RUN — nessuna scrittura eseguita.');
    return;
  }
  const written = await applyPlans(db, plans);
  console.log(`APPLY — record riparati: ${written}; eventi audit: ${written}.`);
}

const isInvokedDirectly = process.argv[1]
  ? import.meta.url === `file://${process.argv[1]}`
  : false;

if (isInvokedDirectly) {
  main().catch((error) => {
    console.error('remediate-binding-newsletter-optouts failed:', error?.message || error);
    process.exitCode = 1;
  });
}
