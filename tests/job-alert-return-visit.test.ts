// Return-visit classification — issue #5705, owner's decision of 2026-08-14:
// a decayed job alert comes back on its own when the person returns to the site.
//
// The question is not "does the test pass" but "which shape has this test never
// seen" (#5764). The refusals below are the ones the owner approved, and each is
// built from a REAL producer wherever one exists — the unsubscribe URL comes out
// of scripts/lib/job-alert-unsub-urls.mjs, the scanner address out of the CIDR
// list emailScannerRanges.js records as actually seen in our own click log, the
// crawler user-agents out of the regex the two components have been running.
// `action=unsubscribe_all` survived a month of green tests because every opt-out
// URL in the suite was typed by hand; nothing here is typed by hand.
//
// The shapes, with the verdict each must produce:
//
//   1. no stamp at all                    → no-visit          (fail-closed)
//   2. a stamp with no readable instant   → unreadable-visit  (fail-closed)
//   3. a prerendered load                 → prefetch
//   4. a load never reported visible      → prefetch
//   5. a crawler user-agent               → crawler-agent
//   6. an automation client               → automation-agent
//   7. a corporate scanner address        → scanner-ip
//   8. landing on the real unsubscribe URL→ opt-out-entry
//   9. landing on ?action=unsubscribe_all → opt-out-entry
//  10. landing in the preference centre   → opt-out-entry
//  11. no identity on the session         → anonymous-visit
//  12. a person, on a job page            → ok
//  13. camelCase stamps (458 prod docs)   → read exactly like snake_case
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CRAWLER_UA_RE,
  RETURN_VISIT_VERDICTS,
  classifyReturnVisit,
  isCrawlerVisitorAgent,
  readReturnVisitStamp,
  redactVisitEntryUrl,
} from '../functions/src/lib/returnVisit.js';
import {
  makeAlertUnsubscribeUrl,
  makeAllAlertsUnsubscribeUrl,
} from '../scripts/lib/job-alert-unsub-urls.mjs';
import { makePreferencesUrl } from '../services/newsletterUrls.mjs';

const NOW = Date.parse('2026-08-14T09:12:00Z');
const EMAIL = 'reader@example.test';
const A_JOB_PAGE = 'https://frontaliereticino.ch/cerca-lavoro-ticino/annuncio-1';
const A_READER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const UID = 'firebase-uid-9f2c';

/** A visit that passes every filter — the baseline every refusal below mutates. */
function aRealReturn(overrides: Record<string, unknown> = {}) {
  return {
    atMs: NOW,
    uid: UID,
    userAgent: A_READER_UA,
    entryUrl: A_JOB_PAGE,
    visible: true,
    prerender: false,
    ip: '',
    ...overrides,
  };
}

const verdictOf = (visit: unknown) => classifyReturnVisit(visit as never).verdict;

describe('the baseline: a person opening a job page counts as a return', () => {
  it('accepts it, and says so', () => {
    const decision = classifyReturnVisit(aRealReturn());
    expect(decision.returned).toBe(true);
    expect(decision.verdict).toBe(RETURN_VISIT_VERDICTS.OK);
  });

  it('is not vacuous: every refusal below is a single-field mutation of this one', () => {
    // If the baseline stopped passing, every `not ok` assertion in this file
    // would still pass — for the wrong reason. This is the guard against that.
    expect(verdictOf(aRealReturn())).toBe(RETURN_VISIT_VERDICTS.OK);
  });
});

// ── SHAPES 1 and 2 — nothing to read ───────────────────────────────────────
describe('fail-closed on a stamp that is missing or unreadable', () => {
  it('refuses a document with no visit stamp at all', () => {
    expect(readReturnVisitStamp({})).toBe(null);
    expect(readReturnVisitStamp(null)).toBe(null);
    expect(verdictOf(null)).toBe(RETURN_VISIT_VERDICTS.NO_VISIT);
    expect(verdictOf(readReturnVisitStamp({ status: 'active' }))).toBe(RETURN_VISIT_VERDICTS.NO_VISIT);
  });

  it('refuses a stamp with no readable instant, even when everything else is right', () => {
    expect(verdictOf(aRealReturn({ atMs: null }))).toBe(RETURN_VISIT_VERDICTS.UNREADABLE);
    expect(verdictOf(aRealReturn({ atMs: NaN }))).toBe(RETURN_VISIT_VERDICTS.UNREADABLE);
    expect(verdictOf(readReturnVisitStamp({ last_site_visit_uid: UID, last_site_visit_at: 'not a date' })))
      .toBe(RETURN_VISIT_VERDICTS.UNREADABLE);
  });
});

// ── SHAPES 3 and 4 — the seventh refusal ───────────────────────────────────
describe('a prefetch is not a visit', () => {
  it('refuses a prerendered load', () => {
    expect(verdictOf(aRealReturn({ prerender: true }))).toBe(RETURN_VISIT_VERDICTS.PREFETCH);
  });

  it('refuses a load that was never reported visible — absence is not evidence', () => {
    expect(verdictOf(aRealReturn({ visible: false }))).toBe(RETURN_VISIT_VERDICTS.PREFETCH);
    // The field missing entirely is the same answer: a stamp that says nothing
    // about whether anybody saw the page does not prove anybody saw it. This is
    // the shape every document written before this feature existed has.
    expect(verdictOf(aRealReturn({ visible: undefined }))).toBe(RETURN_VISIT_VERDICTS.PREFETCH);
  });
});

// ── SHAPES 5, 6 and 7 — the first refusal ──────────────────────────────────
describe('scanners and bots do not come back', () => {
  it('refuses every crawler the site already refuses elsewhere', () => {
    const crawlers = [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
      'facebookexternalhit/1.1',
      'LinkedInBot/1.0 (compatible; Mozilla/5.0)',
      'WhatsApp/2.19.81 A',
      'Mozilla/5.0 (compatible; SemrushBot/7~bl)',
    ];
    for (const ua of crawlers) {
      expect(isCrawlerVisitorAgent(ua), ua).toBe(true);
      expect(verdictOf(aRealReturn({ userAgent: ua })), ua).toBe(RETURN_VISIT_VERDICTS.CRAWLER_AGENT);
    }
    // …and does not refuse an ordinary reader, which is the half that makes the
    // assertions above mean something.
    expect(isCrawlerVisitorAgent(A_READER_UA)).toBe(false);
  });

  it('refuses an automation client through the shared click-rule predicate', () => {
    // These are caught by isAutomationAgent in functions/src/lib/syntheticClicks.js
    // — the same predicate that refuses to promote a scanner's click to the
    // fastest cadence tier. One rule, two consumers.
    for (const ua of ['python-requests/2.31.0', 'okhttp/4.9.3', 'Java/17.0.1']) {
      expect(verdictOf(aRealReturn({ userAgent: ua })), ua).toBe(RETURN_VISIT_VERDICTS.AUTOMATION_AGENT);
    }
  });

  it('refuses a corporate scanner address — a real one from the recorded ranges', () => {
    // 74.242.242.134 is an address emailScannerRanges.js records under `seenAs`,
    // i.e. actually observed in our own click log. An invented address would
    // make this test go green on a rule that never fires.
    expect(verdictOf(aRealReturn({ ip: '74.242.242.134' }))).toBe(RETURN_VISIT_VERDICTS.SCANNER_IP);
    expect(verdictOf(aRealReturn({ ip: '81.62.14.7' }))).toBe(RETURN_VISIT_VERDICTS.OK);
  });
});

// ── SHAPES 8, 9 and 10 — the second refusal, the one the owner named first ─
describe('somebody on their way out is not coming back', () => {
  const withSecret = <T,>(fn: () => T): T => {
    const previous = process.env.NEWSLETTER_SECRET;
    process.env.NEWSLETTER_SECRET = 'test-secret-#5705';
    try {
      return fn();
    } finally {
      if (previous === undefined) delete process.env.NEWSLETTER_SECRET;
      else process.env.NEWSLETTER_SECRET = previous;
    }
  };

  it('refuses a session that started on the real per-alert unsubscribe URL', () => {
    withSecret(() => {
      const url = makeAlertUnsubscribeUrl('backfill-newsletter', EMAIL);
      expect(url).toContain('/disiscrivi-alert/'); // guard: the builder still emits the route
      expect(verdictOf(aRealReturn({ entryUrl: redactVisitEntryUrl(url) })))
        .toBe(RETURN_VISIT_VERDICTS.OPT_OUT_ENTRY);
    });
  });

  it('refuses ?action=unsubscribe_all — the form a word boundary used to miss', () => {
    withSecret(() => {
      const url = makeAllAlertsUnsubscribeUrl(EMAIL);
      expect(url).toContain('action=unsubscribe_all');
      expect(verdictOf(aRealReturn({ entryUrl: redactVisitEntryUrl(url) })))
        .toBe(RETURN_VISIT_VERDICTS.OPT_OUT_ENTRY);
    });
  });

  it('refuses a session that started in the preference centre, from its real builder', () => {
    withSecret(() => {
      const url = makePreferencesUrl(EMAIL, 'it', { fallbackUnsigned: true });
      expect(url).toContain('preferenze-newsletter'); // guard: still the real slug
      expect(verdictOf(aRealReturn({ entryUrl: redactVisitEntryUrl(url) })))
        .toBe(RETURN_VISIT_VERDICTS.OPT_OUT_ENTRY);
    });
  });
});

// ── SHAPE 11 — the sixth refusal ───────────────────────────────────────────
describe('an anonymous visit has nobody to reactivate', () => {
  it('refuses a session with no identity, however human it looks', () => {
    expect(verdictOf(aRealReturn({ uid: '' }))).toBe(RETURN_VISIT_VERDICTS.ANONYMOUS);
    expect(verdictOf(aRealReturn({ uid: undefined }))).toBe(RETURN_VISIT_VERDICTS.ANONYMOUS);
  });
});

// ── SHAPE 13 — the camelCase family (#5673, and the defects #5733 / #5741) ──
describe('the stamp reads in both spellings', () => {
  const snake = {
    last_site_visit_at: new Date(NOW).toISOString(),
    last_site_visit_uid: UID,
    last_site_visit_ua: A_READER_UA,
    last_site_visit_entry: A_JOB_PAGE,
    last_site_visit_visible: true,
    last_site_visit_prerender: false,
  };
  const camel = {
    lastSiteVisitAt: new Date(NOW).toISOString(),
    lastSiteVisitUid: UID,
    lastSiteVisitUa: A_READER_UA,
    lastSiteVisitEntry: A_JOB_PAGE,
    lastSiteVisitVisible: true,
    lastSiteVisitPrerender: false,
  };

  it('gives the same verdict for either', () => {
    expect(verdictOf(readReturnVisitStamp(snake))).toBe(RETURN_VISIT_VERDICTS.OK);
    expect(verdictOf(readReturnVisitStamp(camel))).toBe(RETURN_VISIT_VERDICTS.OK);
    expect(readReturnVisitStamp(camel)?.atMs).toBe(readReturnVisitStamp(snake)?.atMs);
  });

  it('refuses a camelCase crawler exactly like a snake_case one', () => {
    const ua = 'Mozilla/5.0 (compatible; Googlebot/2.1)';
    expect(verdictOf(readReturnVisitStamp({ ...camel, lastSiteVisitUa: ua })))
      .toBe(RETURN_VISIT_VERDICTS.CRAWLER_AGENT);
    expect(verdictOf(readReturnVisitStamp({ ...snake, last_site_visit_ua: ua })))
      .toBe(RETURN_VISIT_VERDICTS.CRAWLER_AGENT);
  });

  it('reads a Firestore Timestamp, not only an ISO string', () => {
    const stamp = readReturnVisitStamp({ ...snake, last_site_visit_at: { _seconds: Math.floor(NOW / 1000) } });
    expect(stamp?.atMs).toBe(Math.floor(NOW / 1000) * 1000);
  });
});

// ── the redaction that makes storing the landing URL safe at all ───────────
describe('the landing URL is redacted before it is ever stored', () => {
  it('keeps the path and the action, and drops the token and the address', () => {
    const redacted = redactVisitEntryUrl(
      'https://frontaliereticino.ch/disiscrivi-alert/?alertId=a1&email=reader%40example.test&token=deadbeefcafe&action=unsubscribe_all',
    );
    expect(redacted).toBe('https://frontaliereticino.ch/disiscrivi-alert/?action=unsubscribe_all');
    expect(redacted).not.toContain('token');
    expect(redacted).not.toContain('example.test');
  });

  it('keeps enough for BOTH opt-out rules to still fire after redaction', () => {
    // The path rule and the action rule are the two halves of #5767, and the
    // redaction must not quietly disable either. This is the assertion that
    // would have caught it if it did.
    for (const url of [
      'https://frontaliereticino.ch/disiscrivi-alert/?email=a%40b.test&token=xyz',
      'https://frontaliereticino.ch/preferenze-newsletter/?email=a%40b.test&token=xyz&action=unsubscribe_all',
    ]) {
      expect(verdictOf(aRealReturn({ entryUrl: redactVisitEntryUrl(url) })), url)
        .toBe(RETURN_VISIT_VERDICTS.OPT_OUT_ENTRY);
    }
  });

  it('returns an empty string for something unparseable, which is then no evidence at all', () => {
    expect(redactVisitEntryUrl('')).toBe('');
    expect(redactVisitEntryUrl(null as never)).toBe('');
    // An empty entry URL is not a refusal on its own: it means we learned
    // nothing about the landing page, and the other six filters still apply.
    expect(verdictOf(aRealReturn({ entryUrl: '' }))).toBe(RETURN_VISIT_VERDICTS.OK);
  });
});

// ── the rule has ONE body, and these are the consumers ─────────────────────
describe('the crawler pattern is not duplicated any more', () => {
  it('is gone from the two components that carried a copy each', () => {
    // The regex lived inline and byte-identical in JobBoard.tsx and
    // NewsletterPopup.tsx. A third copy in the reactivation rule would be the
    // shape of #5674 — one decision computed by two functions that drift.
    // A grep, deliberately: the property being protected is "there is no second
    // body", which no import-following guard can see.
    expect(CRAWLER_UA_RE.source).toContain('googlebot');
    for (const file of ['components/community/JobBoard.tsx', 'components/community/NewsletterPopup.tsx']) {
      const text = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf-8');
      expect(text, file).not.toContain('facebookexternalhit|linkedinbot');
      expect(text, file).toContain('isCrawlerVisitorAgent');
    }
  });
});
