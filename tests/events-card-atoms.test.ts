/**
 * The `eventi` text-to-HTML correction, pinned from both ends.
 *
 * Measured cause (issue #5312 §2). On a median event DETAIL page the
 * `class="…"` attributes alone were 13.0 KB of a 30.5 KB document (42.8 %)
 * against 2.6 KB of visible text — an 8.5 % ratio, under the 10 %
 * `audit:text-html-ratio` floor. The worst single block was the event-card
 * grid: 1 423 B of markup per card for ~90 B of text, 957 B of which (67 %)
 * was a utility string repeated verbatim on every card in the corpus.
 *
 * The correction has two halves that MUST stay in lockstep:
 *   1. index.css `@layer components` declares short `.ev-*` atoms (same
 *      mechanism and rationale as the pre-existing `.jc-*` / `.ec-*` SEO card
 *      atoms directly above them).
 *   2. build-plugins/eventsSeoPagesPlugin.ts emits those atom names instead of
 *      the utility strings.
 *
 * An atom that is emitted but never declared costs nothing at build time and
 * fails silently in production as an UNSTYLED element — the exact failure mode
 * these tests exist to make impossible. They assert, against real rendered
 * HTML, that every `ev-*` class the plugin emits has a rule in index.css, that
 * the hoisted utility soup has not crept back, that the one cascade-order
 * dependency between the atoms holds, and that the resulting page clears the
 * audit floor with margin.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { slugifyEvent } from '../scripts/lib/events-utils.mjs';
import {
  renderEventDetailPage,
  renderComunePage,
  renderHubPage,
  pathForEventDetail,
} from '../build-plugins/eventsSeoPagesPlugin';
// The audit's own extractor — imported, never re-implemented, so a change to
// the gate's definition of "visible text" moves this test with it.
import { extractVisibleText } from '../scripts/audit-text-html-ratio.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_CSS = readFileSync(path.join(ROOT, 'index.css'), 'utf8');

const distDir = mkdtempSync(path.join(os.tmpdir(), 'events-atoms-'));

const EVENT = {
  id: 'guidle:1',
  title: 'Concerto sinfonico al LAC',
  startDate: '2026-07-04',
  endDate: '2026-07-04',
  startTime: '20:00',
  category: 'musica',
  venue: 'LAC Lugano Arte e Cultura',
  comune: 'Lugano',
  canton: 'TI',
  url: 'https://www.guidle.com/e/1',
  sourceKey: 'guidle',
  sourceName: 'Guidle',
  description:
    'La stagione sinfonica si apre con un programma dedicato al repertorio romantico, eseguito dall’orchestra della Svizzera italiana con solisti ospiti internazionali e un preludio introduttivo aperto al pubblico.',
};
// `renderEventDetailPage` drops the page's own event from the card grid, so
// the long-description fixture has to be a SIBLING, not EVENT itself.
// Apostrophes are avoided in the long one on purpose: `esc()` expands `'` to
// `&#39;`, which would make the rendered length assertion below measure escape
// sequences rather than characters.
const LONG_DESC =
  'La rassegna estiva porta in citta venti giorni di concerti, letture e proiezioni all aperto, ' +
  'distribuiti fra il parco, il lungolago e i cortili del centro storico, con ingresso libero a tutti gli appuntamenti diurni.';
const SIBLINGS = [
  EVENT,
  { ...EVENT, id: 'guidle:2', title: 'Mostra fotografica', startTime: undefined, description: 'Una retrospettiva sul reportage alpino del Novecento.' },
  { ...EVENT, id: 'guidle:3', title: 'Mercato contadino', description: undefined },
  { ...EVENT, id: 'guidle:4', title: 'Rassegna estiva', description: LONG_DESC },
];

const detailHref = (e: { id: string }) => pathForEventDetail('it', 'Lugano', `slug-${e.id}`);

function renderDetail(locale: 'it' | 'en' | 'de' | 'fr' = 'it') {
  return renderEventDetailPage({
    locale,
    event: EVENT as never,
    comune: 'Lugano',
    eventSlug: slugifyEvent(EVENT),
    sameComuneEvents: SIBLINGS as never,
    dateStamp: '2026-06-30',
    distDir,
    detailHref: detailHref as never,
  });
}

/** Every `ev-*` token that appears in any `class="…"` of the rendered HTML. */
function emittedEvAtoms(html: string): Set<string> {
  const out = new Set<string>();
  for (const m of html.matchAll(/\sclass=(?:"([^"]*)"|([^\s>]+))/g)) {
    for (const token of (m[1] ?? m[2] ?? '').split(/\s+/)) {
      if (/^ev-/.test(token)) out.add(token);
    }
  }
  return out;
}

/** Atom names declared as `.ev-… { … }` rules in index.css. */
function declaredEvAtoms(): Set<string> {
  const out = new Set<string>();
  for (const m of INDEX_CSS.matchAll(/^\s*\.(ev-[a-z0-9-]+)\s*\{/gim)) out.add(m[1]);
  return out;
}

describe('events .ev-* atoms: emitted ⊆ declared', () => {
  const declared = declaredEvAtoms();

  it('index.css declares the atom set', () => {
    // Guards against the whole block being dropped/renamed wholesale, which
    // would make every assertion below vacuously pass.
    expect(declared.size).toBeGreaterThan(30);
    expect(declared.has('ev-card')).toBe(true);
    expect(declared.has('ev-x')).toBe(true);
  });

  for (const locale of ['it', 'en', 'de', 'fr'] as const) {
    it(`every ev-* class on a ${locale} detail page is declared`, () => {
      const emitted = emittedEvAtoms(renderDetail(locale).html);
      expect(emitted.size).toBeGreaterThan(10);
      // `ev-in` and `ev-grid` are declared by the per-page inline <style>
      // block (EVENTS_STYLE_BLOCK), not by index.css — they are animation /
      // grid hooks, never atoms.
      const inlineOnly = new Set(['ev-in', 'ev-grid']);
      const orphans = [...emitted].filter((a) => !declared.has(a) && !inlineOnly.has(a));
      expect(orphans).toEqual([]);
    });
  }

  it('every ev-* class on a comune page and a canton hub is declared', () => {
    const byComune = new Map([['Lugano', SIBLINGS]]);
    const pages = [
      renderComunePage({ locale: 'it', canton: 'TI', comune: 'Lugano', events: SIBLINGS as never, dateStamp: '2026-06-30', weekendDays: new Set(), distDir, detailHref: detailHref as never }),
      renderHubPage({ locale: 'it', canton: 'TI', events: SIBLINGS as never, byComune: byComune as never, dateStamp: '2026-06-30', weekendDays: new Set(), distDir, detailHref: detailHref as never, otherCantons: [], otherEvents: [] as never }),
    ];
    const inlineOnly = new Set(['ev-in', 'ev-grid', 'ev-featured']);
    for (const p of pages) {
      const orphans = [...emittedEvAtoms(p.html)].filter((a) => !declared.has(a) && !inlineOnly.has(a));
      expect(orphans, `orphan atoms on ${p.urlPath}`).toEqual([]);
    }
  });
});

describe('events .ev-* atoms: the hoisted utility soup does not creep back', () => {
  // Literal strings that used to sit in the markup. Their reappearance means
  // someone edited a template back to inline utilities, which silently undoes
  // the byte reduction across ~12.5 k pages without failing anything else.
  const HOISTED = [
    'transition-[box-shadow,border-color] duration-300 hover:border-accent-border',
    'font-display text-base font-semibold leading-snug text-heading line-clamp-2',
    'static after:absolute after:inset-0',
    'mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-body',
    'rounded-md border border-edge bg-surface p-4 shadow-stripe-sm',
    'mx-auto max-w-3xl px-4 py-6 sm:px-6 lg:px-8',
  ];
  const html = renderDetail().html;
  for (const soup of HOISTED) {
    it(`detail page no longer inlines "${soup.slice(0, 42)}…"`, () => {
      expect(html).not.toContain(soup);
    });
  }

  it('`hover:text-link-hover` is gone from the hoisted templates', () => {
    // Dead markup: there is no `--color-link-hover` in @theme, so Tailwind
    // never generated a `.hover\:text-link-hover` rule. Dropping it is
    // byte-identical in appearance — this pins that it stays dropped rather
    // than being re-added out of habit.
    expect(INDEX_CSS).not.toMatch(/\.ev-[a-z0-9-]+\s*\{[^}]*hover:text-link-hover/);
  });
});

describe('events .ev-* atoms: cascade order', () => {
  it('declares the tone atoms BEFORE .ev-chip', () => {
    // Both set background-color in the same layer, so the later rule wins.
    // Before the hoist both were plain utilities and Tailwind emitted
    // `.bg-surface\/95` after `.bg-accent-subtle`, so the translucent surface
    // won on the card chip. Reversing these two blocks silently repaints every
    // card chip in the corpus.
    const tone = INDEX_CSS.indexOf('.ev-tone-accent {');
    const chip = INDEX_CSS.indexOf('.ev-chip {');
    expect(tone).toBeGreaterThan(-1);
    expect(chip).toBeGreaterThan(-1);
    expect(tone).toBeLessThan(chip);
  });

  it('.ev-chip carries the translucent surface and .ev-tag carries none', () => {
    // The detail-page chip (.ev-tag) has no background of its own precisely so
    // the tone tint shows through there — as it did before the hoist.
    const chipRule = INDEX_CSS.match(/\.ev-chip \{([^}]*)\}/)![1];
    const tagRule = INDEX_CSS.match(/\.ev-tag \{([^}]*)\}/)![1];
    expect(chipRule).toContain('bg-surface/95');
    expect(tagRule).not.toMatch(/\bbg-/);
  });
});

describe('event card excerpt', () => {
  // The shell runs the output through htmlMinify, which drops attribute quotes
  // when the value has no whitespace (same `removeAttributeQuotes` caveat
  // audit-text-html-ratio.mjs documents on its NOINDEX_RE) — so every matcher
  // here has to accept `class=ev-x` as readily as `class="ev-x"`.
  const EXCERPT_RX = /<p class=(?:"ev-x"|ev-x)>([^<]*)<\/p>/g;

  it('shows the start of each sibling event’s own description', () => {
    const html = renderDetail().html;
    expect(html).toContain('Una retrospettiva sul reportage alpino del Novecento.');
    expect(html).toMatch(/<p class=(?:"ev-x"|ev-x)>/);
  });

  it('truncates a long description on a word boundary, with an ellipsis', () => {
    const html = renderDetail().html;
    // EVENT's own description is 200+ chars; the card copy is capped.
    const excerpts = [...html.matchAll(EXCERPT_RX)].map((m) => m[1]);
    expect(excerpts.length).toBeGreaterThan(0);
    const long = excerpts.find((e) => e.endsWith('…'));
    expect(long, 'a >160-char description should be truncated').toBeTruthy();
    expect(long!.length).toBeLessThanOrEqual(161);
    expect(long).not.toMatch(/\s…$/); // no dangling space before the ellipsis
  });

  it('omits the excerpt entirely for an event with no description', () => {
    const html = renderDetail().html;
    // 'Mercato contadino' has description: undefined — its card must carry a
    // title but no excerpt paragraph, never an empty one.
    expect(html).toContain('Mercato contadino');
    expect(html).not.toMatch(/<p class=(?:"ev-x"|ev-x)><\/p>/);
  });

  it('collapses source whitespace instead of shipping it into the cap', () => {
    const messy = { ...SIBLINGS[1], id: 'guidle:9', description: '  Righe\n\n  spezzate\tdalla   fonte.  ' };
    const html = renderEventDetailPage({
      locale: 'it',
      event: EVENT as never,
      comune: 'Lugano',
      eventSlug: slugifyEvent(EVENT),
      sameComuneEvents: [EVENT, messy] as never,
      dateStamp: '2026-06-30',
      distDir,
      detailHref: detailHref as never,
    }).html;
    expect(html).toContain('Righe spezzate dalla fonte.');
  });

  it('prefers the per-locale description when the source ships translations', () => {
    const translated = {
      ...SIBLINGS[1],
      id: 'guidle:8',
      description: 'Fallback italiano.',
      descriptionByLocale: { en: 'An English summary of the exhibition.' },
    };
    const html = renderEventDetailPage({
      locale: 'en',
      event: EVENT as never,
      comune: 'Lugano',
      eventSlug: slugifyEvent(EVENT),
      sameComuneEvents: [EVENT, translated] as never,
      dateStamp: '2026-06-30',
      distDir,
      detailHref: detailHref as never,
    }).html;
    expect(html).toContain('An English summary of the exhibition.');
    expect(html).not.toContain('Fallback italiano.');
  });
});

describe('events text-to-HTML ratio, measured with the audit’s own extractor', () => {
  const ratio = (html: string) =>
    (Buffer.byteLength(extractVisibleText(html), 'utf8') / Buffer.byteLength(html, 'utf8')) * 100;

  for (const locale of ['it', 'en', 'de', 'fr'] as const) {
    it(`${locale} detail page clears the 10 % floor with margin`, () => {
      // Floor is 10 % (audit-text-html-ratio.mjs `threshold`); 12 % is that
      // script's `warnThreshold` near-floor band, i.e. the level at which a
      // page stops being one content refresh away from failing. Measured on
      // the real corpus after this change: detail pages sit at p10 13.2 %,
      // median 16.8 %, min 10.7 % across 956 sampled pages in 4 locales.
      expect(ratio(renderDetail(locale).html)).toBeGreaterThan(12);
    });
  }

  it('the card grid is no longer the page’s densest markup block', () => {
    const html = renderDetail().html;
    const cards = [...html.matchAll(/<article\b[\s\S]*?<\/article>/g)].map((m) => m[0]);
    expect(cards.length).toBeGreaterThan(0);
    const cardBytes = cards.reduce((a, c) => a + Buffer.byteLength(c, 'utf8'), 0);
    const cardClassBytes = cards.reduce((a, c) => {
      let n = 0;
      for (const m of c.matchAll(/\sclass=(?:"[^"]*"|[^\s>]+)/g)) n += Buffer.byteLength(m[0], 'utf8');
      return a + n;
    }, 0);
    // Was 957 of 1 423 B per card (67 %). The atoms bring it under a third.
    expect(cardClassBytes / cardBytes).toBeLessThan(0.33);
  });
});
