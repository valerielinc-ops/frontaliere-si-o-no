// The daily brief's own email — issue #5415 §2b, §4.7, §4.8.
//
// Two things are asserted here that no eyeball on a rendered preview can check:
// that nothing of the WEEKLY newsletter's dress survived the split, and that the
// headers are the RFC 8058 ones Gmail and Yahoo require of a bulk sender.
import { describe, expect, it } from 'vitest';

import { buildDailyBriefEmail, briefSections, cadenceSentence, formatEditionDate } from '@/services/daily-brief-template.mjs';
import { buildBriefEmail, buildBriefHeaders } from '@/scripts/send-daily-brief.mjs';

const BRIEF = {
  dateIso: '2026-08-08',
  counts: { availableBlocks: 4 },
  blocks: {
    borderWait: {
      available: true, count: 141, zeroWaitCount: 104,
      worst: { slug: 'porto-ceresio-brusino', name: 'Porto Ceresio-Brusino', waitMinutes: 9 },
    },
    fuel: {
      available: true,
      cheapestItaly: [{ municipality: 'Livigno', province: 'SO', minPriceEur: 1.528 }],
      bestSavings: [{ municipality: 'Livigno', saving50LEur: 25.25 }],
    },
    exchange: { available: true, rate: 1.0695, prevRate: 1.0695, delta1d: 0 },
    jobs: { available: true, activeJobs: 22645, activeCompanies: 857, yesterdayAdded: 1188 },
  },
};

const build = (over = {}) => buildDailyBriefEmail({
  locale: 'it',
  brief: BRIEF,
  editionUrl: 'https://frontaliereticino.ch/articoli-frontaliere/bollettino-frontaliere-2026-08-08/',
  editionTitle: 'Bollettino del frontaliere — 8 agosto 2026',
  recipientName: 'Marco',
  cadenceDays: 1,
  unsubscribeUrl: 'https://frontaliereticino.ch/disiscrivi-newsletter/?action=unsubscribe&email=x&token=y',
  preferencesUrl: 'https://frontaliereticino.ch/preferenze-newsletter/?e=x&t=y',
  ...over,
});

describe('the bulletin is not the weekly newsletter', () => {
  // Everything in this list was in the email the brief actually sent before
  // #5415, because it WAS buildNewsletter's output.
  const WEEKLY_ARTEFACTS = [
    'Frontaliere Weekly',      // the <title>, on a daily edition
    'questa settimana',        // "ecco cosa succede ai tuoi soldi questa settimana"
    'Parliamoci chiaro',       // the weekly editorial's title
    '2.8%', 'CHF 467',         // the weekly's hardcoded placeholder metrics
    'Da leggere',              // the weekly's article slot, reused for the edition link
    '0% spam',                 // the weekly footer
  ];

  it.each(WEEKLY_ARTEFACTS)('carries no trace of %s', (artefact) => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      expect(build({ locale }).html).not.toContain(artefact);
    }
  });

  it('names itself in the masthead and the title, in every locale', () => {
    const mastheads = { it: 'Bollettino del Frontaliere', en: 'Cross-border Daily Brief', de: 'Grenzgänger-Tagesbulletin', fr: 'Bulletin du Frontalier' };
    for (const [locale, masthead] of Object.entries(mastheads)) {
      const { html } = build({ locale, editionTitle: '' });
      expect(html).toContain(masthead);
      expect(html).toContain(`<title>${masthead} —`);
    }
  });

  // The weekly's badge is `#N · date` where N comes from getIssueNumberFallback,
  // a WEEKLY counter — so two consecutive bulletins carried the same number.
  it('has no issue number at all: a daily edition is identified by its date', () => {
    const { html } = build();
    expect(html).not.toMatch(/#\d+\s*·/);
    expect(html).toContain('sabato 8 agosto 2026');
  });

  // `new Date()` here would relabel a delayed or re-sent edition with the day it
  // went out rather than the day its numbers are from.
  it('dates itself from the edition, not from the clock', () => {
    expect(build({ brief: { ...BRIEF, dateIso: '2026-01-02' } }).html).toContain('2 gennaio 2026');
    expect(formatEditionDate('2026-08-08', 'de')).toBe('Samstag, 8. August 2026');
    // Parsed at UTC noon so no timezone can shift the label off its own day.
    expect(formatEditionDate('2026-08-08', 'en')).toContain('8 August 2026');
  });
});

describe('the four data blocks', () => {
  it('gives each measured block its own section and live link', () => {
    const sections = briefSections(BRIEF, 'it');
    expect(sections.map((s) => s.key)).toEqual(['borderWait', 'fuel', 'exchange', 'jobs']);
    const { html } = build();
    expect(html).toContain('https://frontaliereticino.ch/traffico-dogane/');
    expect(html).toContain('https://frontaliereticino.ch/prezzi-benzina/oggi/');
    expect(html).toContain('https://frontaliereticino.ch/compara-servizi/cambio-franco-euro/');
    expect(html).toContain('https://frontaliereticino.ch/cerca-lavoro-svizzera/');
  });

  it('localizes the live links', () => {
    expect(build({ locale: 'de' }).html).toContain('https://frontaliereticino.ch/de/wartezeit-grenze/');
    expect(build({ locale: 'fr' }).html).toContain('https://frontaliereticino.ch/fr/prix-essence-suisse/aujourd-hui/');
  });

  it('tags every link so the return traffic is attributable', () => {
    const { html } = build();
    expect(html.match(/utm_source=daily-brief/g)?.length).toBeGreaterThanOrEqual(5);
  });

  // The corpus degrades per block; the email must not print a placeholder for
  // one it could not measure (§3.9).
  it('drops a block the corpus could not measure rather than faking it', () => {
    const thin = { ...BRIEF, counts: { availableBlocks: 2 }, blocks: { ...BRIEF.blocks, fuel: { available: false }, jobs: { available: false } } };
    const sections = briefSections(thin, 'it');
    expect(sections.map((s) => s.key)).toEqual(['borderWait', 'exchange']);
    expect(build({ brief: thin }).html).not.toContain('Benzina');
  });

  it('renders numbers in the recipient\'s locale', () => {
    expect(build({ locale: 'it' }).html).toContain('1,528');
    expect(build({ locale: 'en' }).html).toContain('1.528');
  });
});

describe('the cadence disclosure', () => {
  // §3.7: adapting frequency to per-recipient click tracking is only acceptable
  // with the practice disclosed and the opt-out reachable from the email.
  it('says how often this recipient gets it, and how to change that', () => {
    expect(cadenceSentence('it', 1)).toContain('ogni mattina');
    expect(cadenceSentence('it', 3)).toContain('ogni 3 giorni');
    expect(cadenceSentence('it', 7)).toContain('una volta a settimana');
    expect(cadenceSentence('en', 2)).toContain('every 2 days');
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      expect(cadenceSentence(locale, 3)).toMatch(/pr[eé]f[eé]ren|preferen|Einstellungen/i);
    }
  });

  it('puts the preferences and unsubscribe links in the body, not only the headers', () => {
    const { html, text } = build();
    expect(html).toContain('preferenze-newsletter');
    expect(html).toContain('disiscrivi-newsletter');
    expect(text).toContain('Disiscriviti:');
  });
});

describe('email headers', () => {
  const headers = buildBriefHeaders({
    email: 'Mario.Rossi@example.com',
    campaignId: 'daily-brief-2026-08-08',
    unsubscribeUrl: 'https://frontaliereticino.ch/disiscrivi-newsletter/?action=unsubscribe&email=x&token=y',
  });

  // The bug this fixes: the brief was the only one of the three senders whose
  // List-Unsubscribe pointed at the SPA page, which newsletterUrls.js documents
  // as "NOT a valid List-Unsubscribe header target" (§2c).
  it('points List-Unsubscribe at the one-click endpoint, with a mailto fallback', () => {
    expect(headers['List-Unsubscribe']).toContain('<https://frontaliereticino.ch/disiscrivi-newsletter/?action=unsubscribe');
    expect(headers['List-Unsubscribe']).toContain('<mailto:alerts@frontaliereticino.ch');
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  // makeUnsubscribeUrl's output — the SPA root with a query string, which needs
  // client-side JS and an autologin code, and which a mail client's automated
  // POST cannot complete. That is what the brief was sending.
  it('never points it at the SPA-processed URL', () => {
    expect(headers['List-Unsubscribe']).not.toContain('frontaliereticino.ch/?action=unsubscribe');
    expect(headers['List-Unsubscribe']).not.toContain('preferenze-newsletter');
  });

  it('identifies the list as the bulletin, not the weekly', () => {
    expect(headers['List-ID']).toContain('daily.frontaliereticino.ch');
    expect(headers['List-ID']).not.toContain('weekly');
    expect(headers['X-Campaign-Id']).toBe('daily-brief-2026-08-08');
  });

  // The set the weekly sends and the brief was missing entirely (§2c).
  it('carries the same deliverability headers the weekly does', () => {
    expect(Object.keys(headers)).toEqual(expect.arrayContaining([
      'List-Unsubscribe', 'List-Unsubscribe-Post', 'List-ID',
      'Feedback-ID', 'X-Entity-Ref-ID', 'X-Campaign-Id', 'X-Auto-Response-Suppress',
    ]));
  });

  it('gives each recipient a stable, case-insensitive entity ref', () => {
    const lower = buildBriefHeaders({ email: 'mario.rossi@example.com', campaignId: 'daily-brief-2026-08-08', unsubscribeUrl: 'x' });
    expect(lower['X-Entity-Ref-ID']).toBe(headers['X-Entity-Ref-ID']);
  });
});

describe('buildBriefEmail', () => {
  const recipient = { email: 'marco@example.com', locale: 'it', name: 'Marco', nlDoc: null, jaDoc: null };
  const editionUrls = { it: 'https://frontaliereticino.ch/articoli-frontaliere/bollettino-frontaliere-2026-08-08/' };
  const editionTitles = { it: 'Bollettino del frontaliere — 8 agosto 2026' };

  it('uses the edition title as the subject', () => {
    const built = buildBriefEmail({ recipient, brief: BRIEF, editionUrls, editionTitles, cadenceDays: 1 });
    expect(built.subject).toBe('Bollettino del frontaliere — 8 agosto 2026');
  });

  it('builds the one-click unsubscribe URL, not the SPA one', () => {
    const built = buildBriefEmail({ recipient, brief: BRIEF, editionUrls, editionTitles, cadenceDays: 1 });
    expect(built.unsubscribeUrl).toContain('/disiscrivi-newsletter/');
    expect(built.unsubscribeUrl).not.toMatch(/frontaliereticino\.ch\/\?action=unsubscribe/);
  });

  it('falls back to a dated title when the API meta has none', () => {
    const built = buildBriefEmail({ recipient, brief: BRIEF, editionUrls, editionTitles: {}, cadenceDays: 7 });
    expect(built.subject).toContain('2026-08-08');
    expect(built.html).toContain('una volta a settimana');
  });
});
