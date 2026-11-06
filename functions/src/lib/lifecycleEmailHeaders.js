/**
 * lifecycleEmailHeaders.js — shared deliverability/anti-spam headers for
 * lifecycle emails (post-signup welcome email + onboarding drip).
 *
 * Deliberately NOT scripts/send-newsletter.mjs's buildEmailHeaders(): that
 * builder carries campaign A/B test + Feedback-ID complaint-loop semantics
 * specific to the weekly blast (plus a mailto: List-Unsubscribe fallback and
 * X-Campaign-Id) — none of which apply to a single transactional-ish
 * lifecycle send. This is a smaller, dedicated builder for the lifecycle
 * stream so both senders below emit byte-identical headers instead of each
 * hand-rolling its own subset.
 *
 * Used by:
 *  - functions/src/newsletterWelcomeEmail.js (post-signup welcome email)
 *  - scripts/send-onboarding-drip.mjs (day 0/3/7/14 onboarding drip)
 */

function slugifyHeaderValue(value) {
  return (
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'frontaliere-ticino'
  );
}

/**
 * @param {{email: string, campaignId: string, oneClickUnsubscribeUrl: string}} params
 * @returns {Record<string, string>}
 */
export function buildLifecycleEmailHeaders({ email, campaignId, oneClickUnsubscribeUrl }) {
  const campaignKey = slugifyHeaderValue(campaignId);
  const emailKey = Buffer.from(String(email || '').toLowerCase().trim()).toString('hex').slice(0, 24);
  return {
    'List-Unsubscribe': `<${oneClickUnsubscribeUrl || ''}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    'List-ID': 'Frontaliere Lifecycle <lifecycle.frontaliereticino.ch>',
    'X-Entity-Ref-ID': `${campaignKey}-${emailKey}`,
    'X-Auto-Response-Suppress': 'OOF, AutoReply',
  };
}
