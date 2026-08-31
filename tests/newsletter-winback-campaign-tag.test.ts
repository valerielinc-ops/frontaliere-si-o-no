// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Structural regression guard for #6317/#6765: sendWinbacks/sendStage1/
 * sendStage2 all force (or can land on) providers other than Maileroo, whose
 * webhooks read campaign_id off the payload's `tags` — Maileroo's own
 * per-message ref fallback (functions/src/lib/mailerooRef.js
 * defaultCampaignId) never covers them. A missing tag here silently files
 * every send `unattributed` instead of failing loudly, hence a payload-shape
 * assertion rather than a weekly metric re-check.
 */
vi.mock('../scripts/lib/email-cascade.mjs', () => ({
  sendEmailCascade: vi.fn(async (cascade) => {
    globalThis.__capturedCascade = cascade;
    return { sent: cascade.map((c) => ({ recipient: c.recipient, messageId: 'm-1' })), failed: [] };
  }),
  logProviderSummary: vi.fn(),
}));

beforeEach(() => {
  globalThis.__capturedCascade = undefined;
});

function campaignIdTag(payload) {
  return payload.tags?.find((t) => t.name === 'campaign_id')?.value;
}

describe('sendWinbacks (scripts/newsletter-sunset.mjs) — campaign_id tag', () => {
  it('tags every payload with campaign_id', async () => {
    const { sendWinbacks } = await import('../scripts/newsletter-sunset.mjs');
    await sendWinbacks([{ email: 'a@b.ch', locale: 'it' }]);
    const cascade = globalThis.__capturedCascade;
    expect(cascade).toHaveLength(1);
    expect(campaignIdTag(cascade[0].payload)).toBe('sunset_winback');
  });
});

describe('sendStage1 (scripts/newsletter-winback-campaign.mjs) — campaign_id tag', () => {
  it('tags every payload with campaign_id', async () => {
    const { sendStage1 } = await import('../scripts/newsletter-winback-campaign.mjs');
    await sendStage1([{ email: 'a@b.ch', locale: 'it', interest: 'general' }]);
    const cascade = globalThis.__capturedCascade;
    expect(cascade).toHaveLength(1);
    expect(campaignIdTag(cascade[0].payload)).toBe('winback_stage1');
  });
});

describe('sendStage2 (scripts/newsletter-winback-campaign.mjs) — campaign_id tag', () => {
  it('tags every payload with campaign_id', async () => {
    const { sendStage2 } = await import('../scripts/newsletter-winback-campaign.mjs');
    await sendStage2([{ email: 'a@b.ch', locale: 'it' }]);
    const cascade = globalThis.__capturedCascade;
    expect(cascade).toHaveLength(1);
    expect(campaignIdTag(cascade[0].payload)).toBe('winback_stage2');
  });
});
