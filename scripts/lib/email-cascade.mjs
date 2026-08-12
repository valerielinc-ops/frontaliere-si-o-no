/**
 * email-cascade.mjs — re-export shim + the post-send link audit hook.
 *
 * Canonical implementation moved to functions/src/emailCascade.js on
 * 2026-07-16 so Cloud Functions (functions/src/*.js, functions/index.js) can
 * import sendEmailCascade directly — functions/ has no bundler, so it can
 * only import from within functions/, never from scripts/lib/* (the inverse
 * direction works fine, since scripts/ has no such boundary).
 *
 * Edit functions/src/emailCascade.js, not this file — this file only
 * re-exports live bindings so every scripts/ caller and tests/*.test.ts
 * import path keeps working unchanged.
 *
 * ── The one exception: sendEmailCascade is WRAPPED here (issue #5682) ───────
 *
 * Every mass-email sender in scripts/ hands its per-recipient payloads to
 * sendEmailCascade, so this is the single place where the HTML that was
 * ACTUALLY sent — after personalization, after autologin wrapping, per
 * recipient — passes through for all of them at once. Auditing here is why the
 * check covers the bollettino, the weekly newsletter, job alerts, welcome
 * follow-ups, the drip, win-back, sunset and the saved-jobs digest without a
 * per-sender edit, instead of inspecting one `sampleHtml` the way
 * send-newsletter.mjs's inline QA did (issue #5682 point 4: "la copertura, non
 * il campione").
 *
 * The wrapper is POST-send by construction: it runs after the base cascade has
 * returned, it never throws (a defect in the audit must not be able to break a
 * send or a sender's bookkeeping), and it reports by setting `process.exitCode`
 * rather than by aborting — the message is already gone, what matters is that
 * the run goes red so somebody looks. Set `EMAIL_LINK_AUDIT=off` to skip it
 * entirely, `EMAIL_LINK_AUDIT_STRICT=0` to report without failing the run, or
 * `EMAIL_LINK_AUDIT_LIVE=0` to keep the static half only.
 *
 * The Cloud-Functions senders (welcome, confirmation, Stripe/publisher
 * transactional) import functions/src/emailCascade.js directly and therefore
 * bypass this wrapper — deliberate: they are the transactional channels issue
 * #5682 defers, and a CF must not spend its request budget on outbound probes.
 * scripts/check-sent-email-links.mjs audits their bodies on demand.
 */
export * from '../../functions/src/emailCascade.js';

import { sendEmailCascade as baseSendEmailCascade } from '../../functions/src/emailCascade.js';
import { auditSentEmail, formatAuditReport } from '../../functions/src/lib/emailLinkAudit.js';
import { isOwnerEmail } from './canaryAd.mjs';
import path from 'node:path';

/**
 * Every scripts/ sender that pushes mail through the cascade, the channel id it
 * reports as, and whether an unsubscribe link is mandatory in its bodies.
 *
 * This table is not decoration: tests/sent-email-link-audit.test.ts reads
 * scripts/*.mjs, finds every file that imports this module, and fails when one
 * is missing here — so a NEW mass-email channel cannot ship without appearing
 * in the audit's coverage. That structural guard is the answer to "il difetto
 * può stare nel template di un canale che il campione non rappresenta": there
 * is no longer a way to add a channel the check has never seen.
 *
 * `requireUnsubscribe: false` is only for mail that is not a subscription at
 * all — the journalist "your article is live" notice, and the internal GSC
 * indexation alert that goes to us. Every broadcast channel is `true`.
 */
export const MASS_EMAIL_CHANNELS = {
  'send-newsletter.mjs': { id: 'newsletter-weekly', requireUnsubscribe: true },
  'send-daily-brief.mjs': { id: 'daily-brief', requireUnsubscribe: true },
  'send-job-alerts.mjs': { id: 'job-alert', requireUnsubscribe: true },
  'send-onboarding-drip.mjs': { id: 'onboarding-drip', requireUnsubscribe: true },
  'send-saved-jobs-digest.mjs': { id: 'saved-jobs-digest', requireUnsubscribe: true },
  'send-company-alerts.mjs': { id: 'company-alert', requireUnsubscribe: true },
  'send-cold-emails.mjs': { id: 'cold-email', requireUnsubscribe: true },
  'newsletter-winback-campaign.mjs': { id: 'winback', requireUnsubscribe: true },
  'newsletter-sunset.mjs': { id: 'sunset', requireUnsubscribe: true },
  'blast-publisher-ads.mjs': { id: 'publisher-blast', requireUnsubscribe: true },
  'preview-welcome-email.mjs': { id: 'welcome-preview', requireUnsubscribe: true },
  'notify-journalist-article-live.mjs': { id: 'journalist-notify', requireUnsubscribe: false },
  'monitor-gsc-job-indexation.mjs': { id: 'gsc-indexation-alert', requireUnsubscribe: false },
};

/** Channel config for the process currently running, from its entry script. */
export function resolveChannel(entry = process.argv[1] || '') {
  const base = path.basename(entry);
  return MASS_EMAIL_CHANNELS[base] || { id: path.basename(base, '.mjs') || 'unknown', requireUnsubscribe: true };
}

function recipientOf(item) {
  return item?.recipient?.email || item?.payload?.to?.[0] || '';
}

/**
 * Post-send audit of one delivered message.
 *
 * The canary is the site OWNER (scripts/lib/canaryAd.mjs OWNER_EMAIL, the same
 * identity the canary-ad gate already uses) — a real address on our side that
 * is really subscribed to these channels, so the audit reads a genuinely sent
 * message without creating a subscriber, writing to Firestore, or sending
 * anything extra to anybody.
 *
 * When the batch contains no canary (the owner has no job alert matching this
 * run, say) the STATIC half still runs, on the first recipient's body: it needs
 * no network, has no side effect, and it is the half that catches the missing
 * `ac` — the defect that produced the legal notice. Only the live probes are
 * canary-gated.
 *
 * Never throws. Returns the audit result, or null when it did not run.
 */
export async function auditCanarySend(emails, result, opts = {}) {
  try {
    if (process.env.EMAIL_LINK_AUDIT === 'off') return null;
    const delivered = result?.sent ?? [];
    if (!delivered.length) return null; // nothing went out — nothing to audit

    const resolved = resolveChannel();
    const channel = opts.channel || resolved.id;
    const requireUnsubscribe = opts.requireUnsubscribe ?? resolved.requireUnsubscribe;
    const canary = delivered.find((item) => isOwnerEmail(recipientOf(item)));
    const subject = canary || delivered[0];
    const html = subject?.payload?.html;
    if (!html) return null;

    const live = !!canary && process.env.EMAIL_LINK_AUDIT_LIVE !== '0';
    const audit = await auditSentEmail(html, { ...opts, channel, live, requireUnsubscribe });
    console.log(formatAuditReport(audit));
    if (!canary) {
      console.log(`   ℹ️  no canary recipient in this batch — static half only. Set CANARY_OWNER_EMAIL to an address of ours that is subscribed to ${channel} to get the live probes.`);
    }
    if (!audit.ok && process.env.EMAIL_LINK_AUDIT_STRICT !== '0') {
      console.error(`❌ post-send link audit failed for ${channel} — the message went out with broken links. Failing the run.`);
      process.exitCode = 1;
    }
    return audit;
  } catch (e) {
    // A broken audit must never look like a broken send.
    console.warn(`⚠️ post-send link audit skipped: ${e?.message || e}`);
    return null;
  }
}

/**
 * Same signature and same return value as functions/src/emailCascade.js's
 * sendEmailCascade — this only appends the post-send audit. The explicit local
 * export shadows the `export *` above (ESM re-export precedence), so every
 * existing `import { sendEmailCascade } from './lib/email-cascade.mjs'` call
 * site picks up the audit with no edit.
 */
export async function sendEmailCascade(emails, opts = {}) {
  const result = await baseSendEmailCascade(emails, opts);
  await auditCanarySend(emails, result);
  return result;
}
