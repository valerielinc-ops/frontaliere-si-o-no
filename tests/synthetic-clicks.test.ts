// scripts/lib/syntheticClicks.mjs — "this click is not a person", now shared
// by the daily brief and the job alerts (#5767).
//
// tests/daily-brief-cadence.test.ts already covers the calibration (the burst
// rate, the scanner ranges, the automation agents) through the re-export, and
// it is UNCHANGED by the extraction on purpose: if it had to be touched, the
// move was not a move. This file covers what the extraction ADDED, which is
// everything the job-alert channel needs and nobody had ever exercised.
//
// THE URLS ARE NOT WRITTEN BY HAND. Every opt-out fixture comes out of
// scripts/lib/job-alert-unsub-urls.mjs, the same builders that put the link in
// the mail. That is the whole point of the file: `action=unsubscribe_all` sat
// unmatched for a month because `_` is a word character and `\b` refused to
// close, and no hand-written fixture ever contained the suffix. A contract with
// no import shape is not covered by any guard — so here it is given one.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';

import {
  SCAN_BURST_MIN_TARGETS,
  classifyClickEvents,
  isOptOutLink,
  toMillis,
} from '@/scripts/lib/syntheticClicks.mjs';
import * as dailyBriefCadence from '@/scripts/lib/dailyBriefCadence.mjs';
import {
  JOB_ALERT_UNSUB_URL,
  makeAlertUnsubscribeUrl,
  makeAllAlertsUnsubscribeUrl,
} from '@/scripts/lib/job-alert-unsub-urls.mjs';

const EMAIL = 'reader@example.test';
const JOB_AD_URL = 'https://frontaliereticino.ch/cerca-lavoro-ticino/annuncio-1';
const at = (iso: string) => Date.parse(iso);

describe('the extraction keeps dailyBriefCadence.mjs a drop-in', () => {
  // The same shape scripts/lib/dailyBriefCadence.mjs already used for
  // EMAIL_SCANNER_IP_RANGES. If a name stopped being re-exported, its importers
  // would fail at runtime in a script, not here — so assert it here.
  it('re-exports every moved symbol under its old name', () => {
    for (const name of ['classifyClickEvents', 'isOptOutLink', 'isAutomationAgent', 'isScannerIp', 'ipInCidr', 'toMillis', 'SCAN_BURST_WINDOW_MS', 'SCAN_BURST_MIN_TARGETS', 'EMAIL_SCANNER_IP_RANGES']) {
      expect(dailyBriefCadence, `dailyBriefCadence.mjs must keep re-exporting ${name}`).toHaveProperty(name);
    }
    expect(dailyBriefCadence.classifyClickEvents).toBe(classifyClickEvents);
    expect(dailyBriefCadence.isOptOutLink).toBe(isOptOutLink);
  });

  it('keeps toMillis answering for every stored timestamp shape', () => {
    expect(toMillis(0)).toBe(0);
    expect(toMillis(null)).toBeNull();
    expect(toMillis('')).toBeNull();
    expect(toMillis('2026-08-13T06:33:00Z')).toBe(at('2026-08-13T06:33:00Z'));
    expect(toMillis({ _seconds: 1_700_000_000 })).toBe(1_700_000_000_000);
    expect(toMillis({ toMillis: () => 7 })).toBe(7);
    expect(toMillis({ toDate: () => new Date(9) })).toBe(9);
  });
});

describe('the opt-out link, as the builders actually emit it (#5767)', () => {
  let previousSecret: string | undefined;
  beforeAll(() => {
    // Both builders fall back to a job-search page when the secret is absent
    // (job-alert-unsub-urls.mjs:41). Without this the fixtures below would be
    // real URLs of the wrong page and the suite would prove nothing.
    previousSecret = process.env.NEWSLETTER_SECRET;
    process.env.NEWSLETTER_SECRET = 'test-secret-#5767';
  });
  afterAll(() => {
    if (previousSecret === undefined) delete process.env.NEWSLETTER_SECRET;
    else process.env.NEWSLETTER_SECRET = previousSecret;
  });

  it('recognises the per-alert unsubscribe link', () => {
    const url = makeAlertUnsubscribeUrl('backfill-newsletter', EMAIL);
    expect(url, 'the signed builder must have run, not the unsigned fallback').toContain(JOB_ALERT_UNSUB_URL);
    expect(isOptOutLink(url)).toBe(true);
  });

  it('recognises the stop-every-alert link, suffix and all', () => {
    const url = makeAllAlertsUnsubscribeUrl(EMAIL);
    expect(url).toContain('action=unsubscribe_all');
    expect(isOptOutLink(url)).toBe(true);
  });

  it('is not fooled by any suffix glued on with an underscore', () => {
    // The original defect, stated as a rule rather than as one example: `_` is
    // a word character, so a trailing \b can never close the match. Anchoring
    // on "the value starts with unsubscribe" is what makes the next suffix a
    // non-event.
    for (const suffix of ['', '_all', '_alerts', '_all_channels', 'd', '-all']) {
      expect(isOptOutLink(`https://frontaliereticino.ch/x/?action=unsubscribe${suffix}&token=t`), suffix).toBe(true);
    }
  });

  it('still refuses an editorial page that merely talks about unsubscribing', () => {
    expect(isOptOutLink('https://frontaliereticino.ch/blog/come-disiscriversi-dalle-newsletter')).toBe(false);
    expect(isOptOutLink('https://frontaliereticino.ch/cerca-lavoro-ticino/annuncio-1')).toBe(false);
    expect(isOptOutLink('')).toBe(false);
    expect(isOptOutLink(null as unknown as string)).toBe(false);
  });

  it('keeps recognising the newsletter opt-out links it already knew', () => {
    expect(isOptOutLink('https://frontaliereticino.ch/?action=unsubscribe&email=a%40example.test&token=x')).toBe(true);
    expect(isOptOutLink('https://frontaliereticino.ch/disiscriviti/?token=x')).toBe(true);
    expect(isOptOutLink('https://frontaliereticino.ch/de/abmelden?token=x')).toBe(true);
    expect(isOptOutLink('https://frontaliereticino.ch/fr/se-desabonner?token=x')).toBe(true);
  });

  it('reports WHEN the opt-out click happened, not only that one exists', () => {
    // A cadence engine has to know whether the opt-out is the person's latest
    // word; `byReason` counts, it cannot answer that.
    const verdict = classifyClickEvents([
      { at: at('2026-08-10T09:00:00Z'), url: JOB_AD_URL },
      { at: at('2026-08-11T09:00:00Z'), url: makeAllAlertsUnsubscribeUrl(EMAIL) },
    ]);
    expect(verdict.lastOptOutClickAtMs).toBe(at('2026-08-11T09:00:00Z'));
    expect(verdict.lastHumanClickAtMs).toBe(at('2026-08-10T09:00:00Z'));
    expect(verdict.byReason).toEqual({ 'opt-out-link': 1 });
  });
});

// The five webhook handlers write five different metadata shapes on the
// job-alert branch, all poorer than their newsletter twins in the same file
// (measured 2026-08-13: of 393 click events, 0 with metadata.ip, 0 with a
// user-agent). A classifier that cannot read the url on one of them is a
// classifier that silently counts a scanner as a reader on that provider.
describe('the event shapes the job-alert webhooks actually write', () => {
  const providerEvent = (provider: string, metadata: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    event_type: 'click',
    provider,
    occurred_at: at('2026-08-13T06:00:00Z'),
    metadata,
    ...extra,
  });

  it('finds the url whichever of the five wrote the event', () => {
    const events = [
      providerEvent('mailgun', { url: JOB_AD_URL, tags: [] }),
      providerEvent('maileroo', { original_url: JOB_AD_URL, tags: null }),
      providerEvent('mailjet', { custom_id: null, url: JOB_AD_URL }),
      providerEvent('mailtrap', { url: JOB_AD_URL, category: null, custom_variables: null }),
      // Resend stores the raw webhook body verbatim (`metadata: rawEvent`) and
      // is the only handler without a `provider` field.
      { event_type: 'click', occurred_at: at('2026-08-13T06:00:00Z'), link_url: JOB_AD_URL, metadata: { data: { click: { link: JOB_AD_URL } } } },
    ];
    for (const event of events) {
      const [verdict] = classifyClickEvents([event]).verdicts;
      expect(verdict.url, JSON.stringify(event.metadata)).toBe(JOB_AD_URL);
      expect(verdict.atMs).toBe(at('2026-08-13T06:00:00Z'));
    }
  });

  it('finds an opt-out click through each of those shapes too', () => {
    const previous = process.env.NEWSLETTER_SECRET;
    process.env.NEWSLETTER_SECRET = 'test-secret-#5767';
    try {
      const optOut = makeAlertUnsubscribeUrl('backfill-newsletter', EMAIL);
      const shapes = [
        providerEvent('mailgun', { url: optOut }),
        providerEvent('maileroo', { original_url: optOut }),
        { event_type: 'click', occurred_at: at('2026-08-13T06:00:00Z'), link_url: optOut, metadata: { data: { click: { link: optOut } } } },
      ];
      for (const event of shapes) {
        const verdict = classifyClickEvents([event]);
        expect(verdict.byReason).toEqual({ 'opt-out-link': 1 });
        expect(verdict.lastHumanClickAtMs).toBeNull();
      }
    } finally {
      if (previous === undefined) delete process.env.NEWSLETTER_SECRET;
      else process.env.NEWSLETTER_SECRET = previous;
    }
  });

  it('reads the ip and user-agent Resend nests one level down', () => {
    // 109 of the 393 sampled events were Resend's, and every one carried the
    // address under metadata.data.click.* — where the extractors did not look,
    // so `scanner-ip` and `automation-agent` were dead on this channel.
    const nestedIp = classifyClickEvents([{
      occurred_at: at('2026-08-13T06:00:00Z'),
      link_url: JOB_AD_URL,
      metadata: { data: { click: { link: JOB_AD_URL, ipAddress: '74.242.242.134', userAgent: 'Mozilla/5.0' } } },
    }]);
    expect(nestedIp.byReason).toEqual({ 'scanner-ip': 1 });

    const nestedAgent = classifyClickEvents([{
      occurred_at: at('2026-08-13T06:00:00Z'),
      link_url: JOB_AD_URL,
      metadata: { data: { click: { link: JOB_AD_URL, ipAddress: '93.71.103.4', userAgent: 'python-requests/2.32.3' } } },
    }]);
    expect(nestedAgent.byReason).toEqual({ 'automation-agent': 1 });
  });

  it('still catches a burst on the ip-less events four of the five providers write', () => {
    // The rule that survives on this channel: no ip, no user-agent, just an
    // instant and a url — which is exactly what a Mailgun job-alert click is.
    const burst = Array.from({ length: SCAN_BURST_MIN_TARGETS }, (_, i) => providerEvent('mailgun', {
      url: `https://frontaliereticino.ch/cerca-lavoro-ticino/annuncio-${i}`,
    }, { occurred_at: at('2026-08-13T06:00:00Z') + (i * 100) }));
    const verdict = classifyClickEvents(burst);
    expect(verdict.humanCount).toBe(0);
    expect(verdict.byReason['scan-burst']).toBe(SCAN_BURST_MIN_TARGETS);
  });
});
