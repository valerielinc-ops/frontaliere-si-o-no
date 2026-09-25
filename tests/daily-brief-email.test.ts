// The daily brief's own email — issue #5415 §2b, §4.7, §4.8, and the restyle of
// issue #5683.
//
// Everything asserted here is something no eyeball on a rendered preview can
// check: that nothing of the WEEKLY newsletter's dress survived the split, that
// the headers are the RFC 8058 ones Gmail and Yahoo require of a bulk sender,
// that exactly one block leads and it is the one that MOVED, that the message
// contains nothing a mail client will refuse to render (no flexbox, no grid, no
// image), and that the footer's controller identity comes from the shared
// module rather than from a string typed here.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  buildDailyBriefEmail, briefSections, cadenceSentence, dailyHighlight, formatEditionDate, markLead,
} from '@/services/daily-brief-template.mjs';
import { DATA_CONTROLLER_NAME, dataControllerFooterLine } from '@/functions/src/lib/dataControllerIdentity.js';
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

// The real 2026-08-12 payload, trimmed: an ordinary morning where NOTHING moved
// enough to lead — EUR/CHF 1,0695 → 1,0694 (0,009 %) and 762 new listings
// against a 7-day mean of 598 (+27 %). It is the case the lead rule has to get
// right, because it is almost every morning.
const ORDINARY = {
  ...BRIEF,
  dateIso: '2026-08-12',
  blocks: {
    ...BRIEF.blocks,
    exchange: { available: true, rate: 1.0694, prevRate: 1.0695, delta1d: -0.0001, rate7dAgo: 1.0727 },
    jobs: { available: true, activeJobs: 22798, activeCompanies: 846, yesterdayAdded: 762, last7dAdded: 4183 },
  },
};

/** Same morning, but the job board doubled overnight: +101 % on the 7-day mean. */
const JOBS_SURGE = {
  ...ORDINARY,
  blocks: { ...ORDINARY.blocks, jobs: { ...ORDINARY.blocks.jobs, yesterdayAdded: 1200 } },
};

/** Same morning, a real franc day: +0,005 is 0,47 % — over the 0,3 % threshold. */
const FX_SHOCK = {
  ...ORDINARY,
  blocks: {
    ...ORDINARY.blocks,
    exchange: { available: true, rate: 1.0745, prevRate: 1.0695, delta1d: 0.005, rate7dAgo: 1.0727 },
    // No `last7dAdded`: jobs then has no baseline and cannot compete.
    jobs: { available: true, activeJobs: 22798, activeCompanies: 846, yesterdayAdded: 762 },
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

// ── The restyle (#5683) ─────────────────────────────────────────────────────

describe('the hierarchy: one lead, the rest as support', () => {
  it('marks exactly one block as the lead', () => {
    for (const brief of [BRIEF, ORDINARY, JOBS_SURGE, FX_SHOCK]) {
      expect(briefSections(brief, 'it').filter((s) => s.lead)).toHaveLength(1);
    }
  });

  // The defect this closes: four blocks at the same type size, so nothing in the
  // message told the reader where to look first.
  it('sets the lead twice the size of every other block', () => {
    const { html } = build({ brief: ORDINARY });
    expect(html.match(/font:800 40px/g)).toHaveLength(1);
    // The other three blocks, all at the support size.
    expect(html.match(/font:800 20px/g)).toHaveLength(3);
  });

  it('hands the lead to the block that moved past its own threshold', () => {
    expect(briefSections(JOBS_SURGE, 'it').find((s) => s.lead)?.key).toBe('jobs');
    expect(briefSections(FX_SHOCK, 'it').find((s) => s.lead)?.key).toBe('exchange');
  });

  // 1,0695 → 1,0694 is 0,009 % — the movement the issue quotes. It still gets a
  // signed, coloured treatment in its own row, but it must not become the day's
  // headline just because it is the only number with a delta attached.
  it('does not let a rounding-scale move take the lead', () => {
    const sections = briefSections(ORDINARY, 'it');
    expect(sections.find((s) => s.lead)?.key).toBe('borderWait');
    expect(sections.find((s) => s.key === 'exchange')?.move?.pct).toBeLessThan(0.02);
  });

  // `daily-brief.json` gives fuel and border waits today's figure and nothing to
  // compare it with. Inventing a baseline so they could compete would be the
  // fabricated placeholder this template was split off to get rid of.
  it('never lets a block without a previous-day baseline claim a movement', () => {
    const byKey = Object.fromEntries(briefSections(ORDINARY, 'it').map((s) => [s.key, s]));
    expect(byKey.fuel.move).toBeUndefined();
    expect(byKey.borderWait.move).toBeUndefined();
    expect(byKey.exchange.move).toBeDefined();
    expect(byKey.jobs.move).toBeDefined();
  });

  it('applies the threshold at its boundary, and falls back to reading order below it', () => {
    const at = (pct: number) => markLead([
      { key: 'fuel' }, { key: 'exchange', move: { pct } },
    ] as Parameters<typeof markLead>[0]);
    expect(at(0.3).find((s) => s.lead)?.key).toBe('exchange');
    expect(at(0.299).find((s) => s.lead)?.key).toBe('fuel');
  });
});

describe('the movement', () => {
  // Colour alone would be invisible to a colour-blind reader and unreliable
  // under a mail client's forced dark-mode colour transform.
  it('carries its direction as a glyph and a sign, never by colour alone', () => {
    const { html } = build({ brief: ORDINARY });
    expect(html).toContain('▼ -0,0001');   // exchange, down
    expect(html).toContain('▲ +28%');      // jobs, up on the 7-day mean
  });

  it('spells the comparison out instead of leaving a bare delta', () => {
    const { html } = build({ brief: ORDINARY });
    expect(html).toContain('da 1,0695 di ieri');
    expect(html).toContain('contro una media di 598 al giorno');
    expect(build({ brief: ORDINARY, locale: 'en' }).html).toContain('from 1.0695 yesterday');
  });

  it('says «invariato» rather than printing a signed zero', () => {
    // The base fixture's exchange block is flat (delta1d: 0).
    const { html } = build();
    expect(html).toContain('■ invariato');
    expect(html).not.toContain('+0,0000');
  });

  // The movement used to be spelled into the block's own sentence AND appended
  // by the plain-text renderer, so the exchange line printed its delta twice.
  it('prints each movement once in the plain-text part', () => {
    const { text } = build({ brief: ORDINARY });
    expect(text.match(/-0,0001/g)).toHaveLength(1);
    expect(text).toContain('(-0,0001, da 1,0695 di ieri)');
  });
});

describe('the one line that is not a number', () => {
  it('turns a figure buried in a support line into a sentence', () => {
    // Livigno's 25,25 € saving is candidate 0; 2026-08-08 selects it.
    expect(dailyHighlight(BRIEF, 'it')).toBe('Un pieno da 50 litri a Livigno costa 25,25 € meno che in Svizzera.');
  });

  it('is a function of the edition date: same day same line, next day another', () => {
    const day = (dateIso: string) => dailyHighlight({ ...BRIEF, dateIso }, 'it');
    expect(day('2026-08-08')).toBe(day('2026-08-08'));
    const week = new Set(['2026-08-08', '2026-08-09', '2026-08-10', '2026-08-11'].map(day));
    expect(week.size).toBeGreaterThan(1);
  });

  it('drops the candidates whose block was not measured, and stays silent with none', () => {
    const noFuel = { ...BRIEF, blocks: { ...BRIEF.blocks, fuel: { available: false } } };
    for (const dateIso of ['2026-08-08', '2026-08-09', '2026-08-10']) {
      expect(dailyHighlight({ ...noFuel, dateIso }, 'it')).not.toContain('Livigno');
    }
    expect(dailyHighlight({ dateIso: '2026-08-08', blocks: {} }, 'it')).toBeNull();
    expect(build({ brief: { dateIso: '2026-08-08', blocks: {} } }).html).not.toContain('Buono a sapersi');
  });

  it('is localized like everything else', () => {
    expect(dailyHighlight(BRIEF, 'de')).toContain('Eine 50-Liter-Tankfüllung');
    expect(dailyHighlight(BRIEF, 'fr')).toContain('Un plein de 50 litres');
  });
});

describe('what a real mail client can actually render', () => {
  const LOCALES = ['it', 'en', 'de', 'fr'] as const;

  // Outlook's Word engine supports neither; a flex row collapses to stacked text.
  it('uses no flexbox and no grid, in any locale', () => {
    for (const locale of LOCALES) {
      expect(build({ locale, brief: ORDINARY }).html)
        .not.toMatch(/display\s*:\s*(inline-)?(flex|grid)|flex-(direction|wrap|basis|grow)|grid-template/i);
    }
  });

  // Most clients block images on first receipt, and this one goes out daily to
  // thousands of addresses. Every figure, glyph and rule is text or a border.
  it('embeds no image at all, so nothing is lost with images blocked', () => {
    for (const locale of LOCALES) {
      expect(build({ locale, brief: ORDINARY }).html).not.toMatch(/<img|background-image|url\(/i);
    }
  });

  // Gmail's and Outlook's forced dark modes flip a declared background and leave
  // an undeclared text colour where it was — which is how dark-on-dark happens.
  // Declaring both on the same element makes them move together.
  it('declares a colour wherever it declares a background', () => {
    const html = build({ brief: ORDINARY }).html;
    const styles = [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]);
    const withBackground = styles.filter((style) => /(^|;)\s*background\s*:/.test(style));
    expect(withBackground.length).toBeGreaterThan(4);
    for (const style of withBackground) expect(style).toMatch(/(^|;)\s*color\s*:/);
  });
});

describe('dark mode', () => {
  const html = build({ brief: ORDINARY }).html;
  const darkBlock = html.match(/@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n {2}\}/)?.[1] ?? '';
  const markup = html.slice(html.indexOf('</style>'));

  it('announces that it handles both schemes', () => {
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain('<meta name="supported-color-schemes" content="light dark">');
  });

  // Every class the markup paints with has to be restated here, or that element
  // keeps its light inline colour on a dark background. Both directions are
  // asserted: a class added to the markup without a dark rule fails, and a rule
  // left behind for a class nobody uses fails too.
  it('restates every painted class, and paints nothing it does not use', () => {
    const painted = ['fb-page', 'fb-card', 'fb-lead', 'fb-panel', 'fb-note', 'fb-foot',
      'fb-ink', 'fb-text', 'fb-muted', 'fb-link', 'fb-good', 'fb-warn', 'fb-pill', 'fb-rule'];
    for (const cls of painted) {
      expect(markup, `${cls} missing from the markup`).toContain(`${cls}`);
      expect(darkBlock, `${cls} missing from the dark block`).toContain(`.${cls}`);
    }
  });

  // An inline style beats an embedded rule; only !important beats an inline style.
  it('marks every dark declaration !important, or the inline light value wins', () => {
    const declarations = darkBlock.match(/[a-z-]+\s*:\s*[^;{}]+;/g) ?? [];
    expect(declarations.length).toBeGreaterThan(10);
    for (const declaration of declarations) expect(declaration).toContain('!important');
  });
});

describe('the footer', () => {
  const SOURCE = readFileSync(new URL('../services/daily-brief-template.mjs', import.meta.url), 'utf-8');

  // #5675 made the identity a single source. A copy typed into this template
  // would keep rendering the right thing today and go stale on the next change.
  it('takes the controller identity from the shared module, in every locale', () => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const { html, text } = build({ locale });
      expect(html).toContain(dataControllerFooterLine(locale));
      expect(text).toContain(dataControllerFooterLine(locale));
    }
    expect(SOURCE).toContain('dataControllerFooterLine');
    expect(SOURCE).not.toContain(DATA_CONTROLLER_NAME);
  });

  // The complaint of 2026-08-12 reached the provider's abuse desk because the
  // link was 11px #94a3b8 on #f1f5f9 — 1,9:1, effectively invisible.
  it('shows the unsubscribe as a readable link, not grey on grey', () => {
    const { html } = build();
    const style = html.match(/<a class="fb-pill" href="[^"]*disiscrivi-newsletter[^"]*"[^>]*style="([^"]*)"/)?.[1] ?? '';
    expect(Number(style.match(/font:\d+ (\d+)px/)?.[1])).toBeGreaterThanOrEqual(14);
    expect(style).not.toMatch(/color:\s*#(94a3b8|64748b)/);
    expect(style).toContain('text-decoration:underline');
  });

  // Both doors the same size: the recipient who only wants it less often should
  // not have to hunt for the smaller one.
  it('gives preferences and unsubscribe the same prominence', () => {
    const { html } = build();
    const sizes = [...html.matchAll(/<a class="fb-pill"[^>]*style="([^"]*)"/g)]
      .map((m) => m[1].match(/font:\d+ (\d+)px/)?.[1]);
    expect(sizes).toHaveLength(2);
    expect(new Set(sizes).size).toBe(1);
  });

  // makeOneClickUnsubscribeUrl's output works with no JS and no autologin code;
  // the SPA-root form needs both. Making the link more visible must not make it
  // less reliable, so the template renders the URL it is handed, verbatim.
  it('renders the unsubscribe URL it was handed, without rewriting it', () => {
    const { html } = build({ unsubscribeUrl: 'https://frontaliereticino.ch/disiscrivi-newsletter/?action=unsubscribe&email=x&token=y' });
    expect(html).toContain('href="https://frontaliereticino.ch/disiscrivi-newsletter/?action=unsubscribe&amp;email=x&amp;token=y"');
    expect(html).not.toContain('frontaliereticino.ch/?action=unsubscribe');
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
