import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  classifyJobAlertEngagementTier,
  jobAlertClickEvidence,
  resolveEffectiveJobAlertTier,
  JOB_ALERT_CLICK_EVIDENCE,
  JOB_ALERT_ENGAGEMENT_LOOKBACK_DAYS,
  JOB_ALERT_ENGAGEMENT_TIERS,
} from '../scripts/lib/jobAlertEngagementTier.mjs';
import {
  makeAlertUnsubscribeUrl,
  makeAllAlertsUnsubscribeUrl,
} from '../scripts/lib/job-alert-unsub-urls.mjs';

const NOW = 1_700_000_000_000; // fixed reference; all fixtures are relative to it
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => NOW - n * DAY;

// A click on an actual job ad: the shape that SHOULD count as engagement.
// Every fixture that means "a real click" carries one, because since #5767 a
// bare `last_click_at` with no URL is no longer proof of anything (see the
// fail-closed block at the bottom).
const JOB_AD_URL = 'https://frontaliereticino.ch/cerca-lavoro-ticino/annuncio-1';

// FILE-WIDE, not per-block: without the secret both unsubscribe builders return
// the unsigned fallback — a job-search page (job-alert-unsub-urls.mjs:41) — so
// an opt-out fixture silently becomes a CONTENT click and asserts the opposite
// of what it reads. That happened once while writing this file; the guard test
// in the last block is what keeps it from happening quietly.
let previousSecret: string | undefined;
beforeAll(() => {
  previousSecret = process.env.NEWSLETTER_SECRET;
  process.env.NEWSLETTER_SECRET = 'test-secret-#5767';
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.NEWSLETTER_SECRET;
  else process.env.NEWSLETTER_SECRET = previousSecret;
});

function sub(overrides: Record<string, unknown> = {}) {
  return {
    last_open_at: null,
    last_click_at: null,
    ...overrides,
  };
}

/** A real click, as the document remembers it. */
function clicked(nDaysAgo: number, url: string = JOB_AD_URL) {
  return { last_click_at: daysAgo(nDaysAgo), last_clicked_url: url };
}

describe('classifyJobAlertEngagementTier', () => {
  it('classifies a subscriber who clicked recently as daily', () => {
    const verdict = classifyJobAlertEngagementTier(sub(clicked(1)), NOW);
    expect(verdict.tier).toBe(JOB_ALERT_ENGAGEMENT_TIERS.DAILY);
  });

  it('classifies a subscriber who only opened recently as every-other-day', () => {
    const verdict = classifyJobAlertEngagementTier(sub({ last_open_at: daysAgo(2) }), NOW);
    expect(verdict.tier).toBe(JOB_ALERT_ENGAGEMENT_TIERS.OPEN_EVERY_OTHER_DAY);
  });

  it('classifies a never-engaged subscriber as weekly', () => {
    const verdict = classifyJobAlertEngagementTier(sub(), NOW);
    expect(verdict.tier).toBe(JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY);
  });

  it('classifies a subscriber whose last engagement is outside the lookback as weekly', () => {
    const verdict = classifyJobAlertEngagementTier(
      sub({ last_open_at: daysAgo(JOB_ALERT_ENGAGEMENT_LOOKBACK_DAYS + 1), ...clicked(JOB_ALERT_ENGAGEMENT_LOOKBACK_DAYS + 1) }),
      NOW,
    );
    expect(verdict.tier).toBe(JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY);
  });

  it('treats engagement exactly at the lookback boundary as still-recent', () => {
    const verdict = classifyJobAlertEngagementTier(sub({ last_open_at: daysAgo(JOB_ALERT_ENGAGEMENT_LOOKBACK_DAYS) }), NOW);
    expect(verdict.tier).toBe(JOB_ALERT_ENGAGEMENT_TIERS.OPEN_EVERY_OTHER_DAY);
  });

  it('a click always wins over an open, regardless of which is more recent', () => {
    const clickOlderThanOpen = classifyJobAlertEngagementTier(
      sub({ ...clicked(10), last_open_at: daysAgo(1) }),
      NOW,
    );
    expect(clickOlderThanOpen.tier).toBe(JOB_ALERT_ENGAGEMENT_TIERS.DAILY);
  });

  it('a stale click outside the lookback does not block a fresh open from scoring every-other-day', () => {
    const verdict = classifyJobAlertEngagementTier(
      sub({ ...clicked(JOB_ALERT_ENGAGEMENT_LOOKBACK_DAYS + 5), last_open_at: daysAgo(1) }),
      NOW,
    );
    expect(verdict.tier).toBe(JOB_ALERT_ENGAGEMENT_TIERS.OPEN_EVERY_OTHER_DAY);
  });

  it('honors the camelCase field spellings too', () => {
    // 458 documents in production carry only the camelCase stamp (#5673), and
    // that family is what produced #5733 and #5741. Both halves of the click —
    // the instant AND the url the classifier now needs — have a camel spelling.
    const camel = { lastClickAt: daysAgo(1), lastClickedUrl: JOB_AD_URL };
    expect(classifyJobAlertEngagementTier(camel, NOW).tier).toBe(JOB_ALERT_ENGAGEMENT_TIERS.DAILY);
    const camelOptOut = { lastClickAt: daysAgo(1), lastClickedUrl: makeAllAlertsUnsubscribeUrl('reader@example.test'), lastOpenAt: daysAgo(1) };
    expect(classifyJobAlertEngagementTier(camelOptOut, NOW).tier).toBe(JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY);
  });
});

describe('resolveEffectiveJobAlertTier', () => {
  it('defers to the engagement engine when the alert has no override', () => {
    const alert = { frequency: 'weekly' };
    const verdict = resolveEffectiveJobAlertTier(alert, sub(clicked(1)), NOW);
    expect(verdict.tier).toBe(JOB_ALERT_ENGAGEMENT_TIERS.DAILY);
    expect(verdict.manual).toBe(false);
  });

  it('defers to the engagement engine when frequencyOverride is explicitly false', () => {
    const alert = { frequency: 'daily', frequencyOverride: false };
    const verdict = resolveEffectiveJobAlertTier(alert, sub(), NOW);
    expect(verdict.tier).toBe(JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY);
    expect(verdict.manual).toBe(false);
  });

  it('honors a manual daily pin even for a disengaged subscriber', () => {
    const alert = { frequency: 'daily', frequencyOverride: true };
    const verdict = resolveEffectiveJobAlertTier(alert, sub(), NOW);
    expect(verdict.tier).toBe('daily');
    expect(verdict.manual).toBe(true);
  });

  it('honors a manual weekly pin even for a highly engaged subscriber', () => {
    const alert = { frequency: 'weekly', frequencyOverride: true };
    const verdict = resolveEffectiveJobAlertTier(alert, sub(clicked(1)), NOW);
    expect(verdict.tier).toBe('weekly');
    expect(verdict.manual).toBe(true);
  });

  it('treats a pinned alert with a non-daily/weekly frequency value as weekly (conservative default)', () => {
    const alert = { frequency: '36h', frequencyOverride: true };
    const verdict = resolveEffectiveJobAlertTier(alert, sub(clicked(1)), NOW);
    expect(verdict.tier).toBe('weekly');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #5767 — clicking "unsubscribe" in a job alert used to promote the recipient
// to the tier that sends the most. Two independent causes, both fixed: this
// module read `last_click_at` raw (it had no `import` line at all), and the
// opt-out regex could not see either of this channel's unsubscribe URLs.
//
// EVERY URL BELOW COMES FROM THE REAL BUILDERS. Hand-written strings are what
// let `action=unsubscribe_all` through for a month: `_` is a word character, so
// `\b` refused to close the match, and nobody typing a fixture by hand would
// have thought to include the suffix.
// ─────────────────────────────────────────────────────────────────────────────
describe('an opt-out click never promotes, and here it demotes (#5767)', () => {
  const EMAIL = 'reader@example.test';

  it('the builders really produce the alert unsubscribe route (guard against a vacuous suite)', () => {
    expect(makeAlertUnsubscribeUrl('alert-1', EMAIL)).toContain('/disiscrivi-alert/');
    expect(makeAllAlertsUnsubscribeUrl(EMAIL)).toContain('action=unsubscribe_all');
  });

  it('demotes to weekly when the last click was the per-alert unsubscribe link', () => {
    // The exact shape from production: alertId `backfill-newsletter`, and an
    // open on the same day, because you open the mail in order to leave it.
    const verdict = classifyJobAlertEngagementTier(sub({
      last_click_at: daysAgo(1),
      last_clicked_url: makeAlertUnsubscribeUrl('backfill-newsletter', EMAIL),
      last_open_at: daysAgo(1),
    }), NOW);
    expect(verdict.tier).toBe(JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY);
    expect(verdict.clickEvidence).toBe(JOB_ALERT_CLICK_EVIDENCE.OPT_OUT);
    expect(verdict.reason).toContain('asked to leave');
  });

  it('demotes to weekly on the stop-everything link, whose action=unsubscribe_all the old \\b could not match', () => {
    const verdict = classifyJobAlertEngagementTier(sub({
      last_click_at: daysAgo(2),
      last_clicked_url: makeAllAlertsUnsubscribeUrl(EMAIL),
      last_open_at: daysAgo(2),
    }), NOW);
    expect(verdict.tier).toBe(JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY);
    expect(verdict.clickEvidence).toBe(JOB_ALERT_CLICK_EVIDENCE.OPT_OUT);
  });

  it('lets a genuine click AFTER the opt-out restore the fast tier, but not one before it', () => {
    const optOut = { at: daysAgo(2), url: makeAllAlertsUnsubscribeUrl(EMAIL) };
    const jobClick = (n: number) => ({ at: daysAgo(n), url: JOB_AD_URL });

    // Came back: the later click is the person's latest word.
    expect(classifyJobAlertEngagementTier({}, NOW, { clickEvents: [optOut, jobClick(1)] }).tier)
      .toBe(JOB_ALERT_ENGAGEMENT_TIERS.DAILY);
    // Left: the opt-out is the latest word, and Monday's click does not undo it.
    expect(classifyJobAlertEngagementTier({}, NOW, { clickEvents: [jobClick(3), optOut] }).tier)
      .toBe(JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY);
  });

  it('still keeps an ordinary click on a job ad in the fast tier', () => {
    expect(classifyJobAlertEngagementTier(sub(clicked(1)), NOW).tier).toBe(JOB_ALERT_ENGAGEMENT_TIERS.DAILY);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #5674 arriving on this channel for the first time, and the fail-closed rule
// that has to accompany it: measured on 2026-08-13, of 393 click events sampled
// from 40 click-tier recipients here, ZERO carried an ip and ZERO a user-agent.
// Two of the four synthetic-click rules cannot fire, so evidence is thin by
// construction and a click we cannot read must not buy the fastest tier.
// ─────────────────────────────────────────────────────────────────────────────
describe('a click we cannot read never reaches the fast tier (#5674, #5767)', () => {
  it('does not promote on a scan burst, with the ip-less events this channel actually writes', () => {
    // The normal shape here: an instant, a url, and nothing else. Six targets
    // inside a second is the scanner walking the message top to bottom.
    const burst = ['volg', 'lidl', 'hilti', 'coop', 'migros', 'aldi'].map((slug, i) => ({
      occurred_at: daysAgo(1) + (i * 120),
      metadata: { url: `https://frontaliereticino.ch/cerca-lavoro-ticino/${slug}`, tags: [] },
    }));
    const evidence = jobAlertClickEvidence({}, { clickEvents: burst });
    expect(evidence.kind).toBe(JOB_ALERT_CLICK_EVIDENCE.SYNTHETIC);

    // Only synthetic clicks and no opens → weekly, not daily.
    expect(classifyJobAlertEngagementTier({}, NOW, { clickEvents: burst }).tier)
      .toBe(JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY);
    // Only synthetic clicks but a fresh open → the open still counts, the
    // clicks do not. Never daily.
    expect(classifyJobAlertEngagementTier({ last_open_at: daysAgo(1) }, NOW, { clickEvents: burst }).tier)
      .toBe(JOB_ALERT_ENGAGEMENT_TIERS.OPEN_EVERY_OTHER_DAY);
  });

  it('reads the ip Resend nests under metadata.data.click, where the classifier used not to look', () => {
    // Resend's job-alert branch stores the raw webhook body verbatim
    // (`metadata: rawEvent`). 109 of the 393 sampled events were Resend's and
    // every one of them carried the address — one level too deep to be seen.
    const events = [{
      occurred_at: daysAgo(1),
      link_url: JOB_AD_URL,
      metadata: { data: { click: { link: JOB_AD_URL, ipAddress: '74.242.242.134', userAgent: 'Mozilla/5.0' } } },
    }];
    expect(jobAlertClickEvidence({}, { clickEvents: events }).kind).toBe(JOB_ALERT_CLICK_EVIDENCE.SYNTHETIC);
    expect(classifyJobAlertEngagementTier({}, NOW, { clickEvents: events }).tier)
      .toBe(JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY);
  });

  it('refuses the fast tier for a click with an instant but no url', () => {
    const doc = { last_click_at: daysAgo(1), click_count: 4, last_open_at: daysAgo(1) };
    const evidence = jobAlertClickEvidence(doc);
    expect(evidence.kind).toBe(JOB_ALERT_CLICK_EVIDENCE.UNVERIFIABLE);
    expect(classifyJobAlertEngagementTier(doc, NOW).tier).toBe(JOB_ALERT_ENGAGEMENT_TIERS.OPEN_EVERY_OTHER_DAY);
    // …and with nothing else to go on, the slowest tier rather than the fastest.
    expect(classifyJobAlertEngagementTier({ last_click_at: daysAgo(1), click_count: 4 }, NOW).tier)
      .toBe(JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY);
  });

  it('refuses the fast tier for click_count > 0 with no instant and for an empty events log', () => {
    expect(jobAlertClickEvidence({ click_count: 9 }).kind).toBe(JOB_ALERT_CLICK_EVIDENCE.UNVERIFIABLE);
    expect(classifyJobAlertEngagementTier({ click_count: 9 }, NOW).tier).toBe(JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY);
    expect(jobAlertClickEvidence({ clickCount: 9 }, { clickEvents: [] }).kind).toBe(JOB_ALERT_CLICK_EVIDENCE.UNVERIFIABLE);
    expect(classifyJobAlertEngagementTier({ click_count: 9 }, NOW, { clickEvents: [] }).tier)
      .toBe(JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY);
  });

  it('refuses the fast tier when the events carry a url but no readable instant', () => {
    const events = [{ metadata: { url: JOB_AD_URL } }, { metadata: { url: JOB_AD_URL } }];
    expect(jobAlertClickEvidence({}, { clickEvents: events }).kind).toBe(JOB_ALERT_CLICK_EVIDENCE.UNVERIFIABLE);
    expect(classifyJobAlertEngagementTier({}, NOW, { clickEvents: events }).tier)
      .toBe(JOB_ALERT_ENGAGEMENT_TIERS.WEEKLY);
  });

  it('tells "no click at all" apart from "a click we could not read"', () => {
    expect(jobAlertClickEvidence({}).kind).toBe(JOB_ALERT_CLICK_EVIDENCE.NONE);
    expect(jobAlertClickEvidence({ click_count: 0 }).kind).toBe(JOB_ALERT_CLICK_EVIDENCE.NONE);
  });
});
