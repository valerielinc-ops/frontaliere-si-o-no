#!/usr/bin/env node
/**
 * Owner-run recovery for paid assisted applications (0,99 €) whose customer
 * never received the concierge email — the orders paid before the email-first
 * flow shipped (2026-09-29), when the CV upload was failing with 403 and no
 * email left at all. The hourly sweep deliberately never touches orders older
 * than 72 h, so these go through this script, one explicit order at a time.
 *
 * Modes (dry-run is the default and writes nothing):
 *   node scripts/recover-assisted-application-orders.mjs
 *       → list paid orders without a delivered intro, with the email preview
 *   node scripts/recover-assisted-application-orders.mjs --order <id> --test-to <you@example.com>
 *       → send the real customer + owner emails to YOUR address ("[TEST]" subject);
 *         nothing is recorded on the order, so the real send stays possible
 *   node scripts/recover-assisted-application-orders.mjs --order <id> --apply
 *       → backfill locale/order link from Stripe, then send the recovery email to
 *         the customer and the notice to valerie@ (idempotent: a second run skips)
 *
 * Options: --variant recovery|intro (default recovery), --order may repeat.
 * Credentials: GOOGLE_APPLICATION_CREDENTIALS (Firebase service account); email
 * provider keys and STRIPE_SECRET_KEY are read from Remote Config.
 */

import { createRequire } from 'node:module';
import { getRemoteConfigValue } from '../functions/src/remoteConfigSecrets.js';
import { ASSISTED_APPLICATIONS_COLLECTION } from '../functions/src/assistedApplicationConstants.js';
import {
  NOTIFICATION_KEYS,
  buildCustomerEmail,
  buildOwnerEmail,
  customerEmailFor,
  localeFromSiteUrl,
  resolveOrderLocale,
  sendPaidOrderNotifications,
} from '../functions/src/assistedApplicationNotifications.js';

// The same firebase-admin instance the functions modules resolve. A bare
// `import 'firebase-admin'` from scripts/ picks the root copy, while
// functions/src resolves functions/node_modules when it is installed: the app
// initialised here would then not exist for getRemoteConfigValue (Stripe key,
// email provider keys) nor match the FieldValue sentinels of the order writes.
export const FUNCTIONS_ADMIN_REQUIRE = createRequire(new URL('../functions/src/', import.meta.url));
const admin = FUNCTIONS_ADMIN_REQUIRE('firebase-admin');

export function parseArgs(argv) {
  const args = { orders: [], apply: false, testTo: '', variant: 'recovery' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--order') args.orders.push(String(argv[++index] || ''));
    else if (arg === '--test-to') args.testTo = String(argv[++index] || '').trim();
    else if (arg === '--variant') args.variant = String(argv[++index] || '');
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!['recovery', 'intro'].includes(args.variant)) throw new Error('--variant must be recovery or intro');
  if (args.apply && args.testTo) throw new Error('--apply and --test-to are exclusive');
  if ((args.apply || args.testTo) && args.orders.length === 0) {
    throw new Error('--apply and --test-to need at least one explicit --order <id>');
  }
  if (args.testTo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.testTo)) throw new Error('--test-to is not an email');
  return args;
}

/** Paid orders whose customer intro or owner notice was never delivered. */
export function needsRecovery(order) {
  if (order?.paymentStatus !== 'paid') return false;
  const delivered = (key) => ['sent', 'ambiguous'].includes(order.notifications?.[key]?.status);
  return !delivered(NOTIFICATION_KEYS.customerIntro) || !delivered(NOTIFICATION_KEYS.ownerNewOrder);
}

export function maskEmail(value) {
  const [user = '', domain = ''] = String(value || '').split('@');
  return value ? `${user.slice(0, 2)}***@${domain}` : '(none)';
}

/** Locale and resume link from the Stripe session the customer paid in. */
async function presentationFromStripe(order) {
  const sessionId = String(order.stripeCheckoutSessionId || order.stripeSessionId || '');
  if (!sessionId || (order.orderPageUrl && order.locale)) return null;
  const key = await getRemoteConfigValue('STRIPE_SECRET_KEY');
  if (!key) throw new Error('STRIPE_SECRET_KEY is empty in Remote Config');
  const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) throw new Error(`Stripe checkout session lookup returned HTTP ${response.status}`);
  const session = await response.json();
  const locale = localeFromSiteUrl(session.success_url);
  return locale ? { locale, orderPageUrl: session.success_url } : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();
  const collection = db.collection(ASSISTED_APPLICATIONS_COLLECTION);

  const docs = args.orders.length > 0
    ? await Promise.all(args.orders.map((id) => collection.doc(id).get()))
    : (await collection.where('paymentStatus', '==', 'paid').get()).docs;

  for (const snapshot of docs) {
    if (!snapshot.exists) {
      console.log(`✗ ${snapshot.id}: order not found`);
      continue;
    }
    let order = snapshot.data() || {};
    if (!needsRecovery(order)) {
      console.log(`· ${snapshot.id}: intro and owner notice already delivered, skipped`);
      continue;
    }

    let presentation = null;
    try {
      presentation = await presentationFromStripe(order);
    } catch (error) {
      // Without the Stripe success_url the email silently falls back to
      // Italian and the job-board root: never send that for real.
      console.log(`\n✗ ${snapshot.id}: locale backfill from Stripe failed (${error instanceof Error ? error.message : error})`);
      if (args.apply) continue;
    }
    if (presentation) order = { ...order, ...presentation };
    const customer = buildCustomerEmail(args.variant, order, snapshot.id);
    const owner = buildOwnerEmail('new_order', order, snapshot.id, { customerKey: args.variant });
    console.log(`\n▶ ${snapshot.id} · ${order.jobTitle} — ${order.companyName}`);
    console.log(`  paid ${order.paidAt?.toDate?.().toISOString?.() || '?'} · status ${order.submissionStatus} · CV ${order.cvStorageKey ? 'yes' : 'no'}`);
    console.log(`  customer ${maskEmail(customerEmailFor(order))} · locale ${resolveOrderLocale(order)}${presentation ? ' (from Stripe success_url)' : ''}`);
    console.log(`  → customer subject: ${customer.subject}`);
    console.log(`  → owner subject:    ${owner.subject}`);

    if (!args.apply && !args.testTo) {
      console.log(`\n${customer.text.split('\n').map((line) => `    ${line}`).join('\n')}`);
      continue;
    }

    if (args.apply && presentation) {
      await snapshot.ref.set(presentation, { merge: true });
      console.log(`  backfilled locale=${presentation.locale} and the order link`);
    }
    const results = await sendPaidOrderNotifications(db, snapshot.id, {
      variant: args.variant,
      recipientOverride: args.testTo,
      orderPatch: presentation,
    });
    for (const result of results) {
      console.log(`  ${result.ok ? '✓' : '✗'} ${result.key}: ${result.ok ? `sent to ${args.testTo ? result.to : maskEmail(result.to)} via ${result.provider || '?'}` : result.reason}`);
    }
  }
  if (!args.apply && !args.testTo) console.log('\nDry run: nothing sent or written. Use --order <id> --test-to <email>, then --apply.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0), (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
