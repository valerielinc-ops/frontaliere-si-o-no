/**
 * `audit:max-bfs-depth` Causa B, pinned at the three seams that produced it
 * (issue #5434).
 *
 * The audit measures a property of the LINK GRAPH, and the graph only exists
 * after a full build — so the failure mode is a page family that is emitted,
 * sitemapped, and rendered perfectly while being reachable by nobody. Nothing
 * in the type system or the per-plugin tests could see it: each of the three
 * defects below is locally correct code.
 *
 *   1. `borderMunicipalityPagesPlugin` emitted and sitemapped all 320 corridor
 *      comuni but its hub linked a 16-name literal (`CANDIDATE_HUB_LINKS`).
 *      304 pages had no inbound link at all.
 *   2. `eventsSeoPagesPlugin` capped its comune hubs at 80 event CARDS and
 *      dropped the tail. In the two buckets over the cap that orphaned 689
 *      event pages — the cap was doing double duty as a page-weight measure
 *      and, unintentionally, as a reachability cliff.
 *   3. The home shell (`index.html`) is the BFS root. `/eventi/` was not on it,
 *      so the whole events family entered one hop lower than it needed to and
 *      130 pages sat past `maxDepth`; the border-comuni hub had exactly ONE
 *      indexable depth-1 inbound (`/vivere-in-ticino/confronta-asili-nido/`),
 *      because its "official" door `/guida-frontaliere/comuni-di-frontiera/` is
 *      `noindex,follow` and `scripts/audit-bfs-depth.mjs` stops at any noindex.
 *
 * These assert the INVARIANT ("every emitted page of the family is linked from
 * its hub"), not the counts of the day, so they keep holding as the corpus
 * grows — which is the point: both defects arrived through growth, not through
 * an edit to the linking code.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHubPatch } from '../build-plugins/borderMunicipalityPagesPlugin';
import { borderMunicipalityPathFor } from '../build-plugins/borderMunicipalityData';
import { renderComunePage, renderOtherEventsPage, pathForEventDetail } from '../build-plugins/eventsSeoPagesPlugin';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = mkdtempSync(path.join(os.tmpdir(), 'bfs-hub-links-'));

/**
 * Every internal `href` in a blob of HTML, de-duplicated.
 *
 * Both quoted and bare attribute values: `buildSeoPageHtml()` runs the finished
 * page through a minifier that drops quotes around values with no whitespace,
 * so a `href="…"`-only pattern silently matches NOTHING on a rendered page —
 * and an emptied `Set` makes every "is X linked" assertion below fail in a way
 * that looks like the fix regressed. Same trap as `data-…="1"`, see MARKER_RE.
 */
function hrefs(html: string): Set<string> {
  const out = new Set<string>();
  for (const m of html.matchAll(/href=(?:"(\/[^"]*)"|(\/[^\s>]+))/g)) out.add(m[1] ?? m[2]);
  return out;
}

/** Matches the overflow-index marker whether or not the minifier kept quotes. */
const MARKER_RE = /data-events-overflow-index=["']?1/;

// ── 1. border comuni hub ────────────────────────────────────────────────────

/**
 * Deliberately includes names that are NOT in `CANDIDATE_HUB_LINKS` and spans
 * two provinces: the old code linked only the shortlist, so a fixture made only
 * of shortlist names would pass against the bug.
 */
const MUNICIPALITIES = [
  { name: 'Como', province: 'CO', lat: 45.808, lng: 9.085, distanceKm: 5.1, fascia: 1 },
  { name: 'Cernobbio', province: 'CO', lat: 45.842, lng: 9.076, distanceKm: 3.4, fascia: 1 },
  { name: 'Grandate', province: 'CO', lat: 45.777, lng: 9.05, distanceKm: 9.8, fascia: 2 },
  { name: 'Olgiate Comasco', province: 'CO', lat: 45.783, lng: 8.968, distanceKm: 12.2, fascia: 2 },
  { name: 'Varese', province: 'VA', lat: 45.821, lng: 8.825, distanceKm: 11.4, fascia: 1 },
  { name: 'Gavirate', province: 'VA', lat: 45.844, lng: 8.716, distanceKm: 18.9, fascia: 2 },
  { name: 'Besozzo', province: 'VA', lat: 45.852, lng: 8.663, distanceKm: 21.3, fascia: 3 },
];

describe('border-comuni hub links every comune the plugin emits (#5434)', () => {
  const html = buildHubPatch(MUNICIPALITIES as never);
  const linked = hrefs(html);

  it('links every input comune, not just the editorial shortlist', () => {
    const missing = MUNICIPALITIES.filter((m) => !linked.has(borderMunicipalityPathFor('it', m.name))).map((m) => m.name);
    expect(missing).toEqual([]);
  });

  it('covers comuni outside CANDIDATE_HUB_LINKS — the actual 304-page regression', () => {
    // Grandate/Olgiate/Gavirate/Besozzo are in no shortlist; before the fix
    // these were emitted, sitemapped, and linked from nowhere.
    for (const name of ['Grandate', 'Olgiate Comasco', 'Gavirate', 'Besozzo']) {
      expect(linked.has(borderMunicipalityPathFor('it', name))).toBe(true);
    }
  });

  it('groups the full index by province', () => {
    expect(html).toContain('data-border-municipality-index="1"');
    expect(html).toContain('>CO ');
    expect(html).toContain('>VA ');
  });

  it('stays in the compact list form — cards for 320 comuni would blow the page-weight budget', () => {
    // MARGINAL cost, not average: the section's fixed chrome (headings, intro
    // copy, the 16 shortlist cards) dwarfs a 7-comune fixture and would make an
    // average-based assertion meaningless. What matters at 320 comuni is what
    // ONE more comune costs, and that number separates a row (~90 B) from a
    // card (~240 B) unambiguously.
    const bigger = buildHubPatch([
      ...MUNICIPALITIES,
      { name: 'Appiano Gentile', province: 'CO', lat: 45.735, lng: 8.978, distanceKm: 15.6, fascia: 3 },
    ] as never);
    const marginal = Buffer.byteLength(bigger) - Buffer.byteLength(html);
    expect(marginal).toBeGreaterThan(0);
    expect(marginal).toBeLessThan(150);
  });
});

// ── 2. events comune hub / other-events sentinel ────────────────────────────

const BASE_EVENT = {
  id: 'e:0',
  title: 'Concerto',
  startDate: '2026-07-04',
  endDate: '2026-07-04',
  category: 'musica',
  venue: 'Sala comunale',
  comune: 'Lugano',
  canton: 'TI',
  url: 'https://example.org/e/0',
  sourceKey: 'guidle',
  sourceName: 'Guidle',
  description: 'Un concerto della stagione estiva con ingresso libero e programma dedicato al repertorio romantico.',
};

/** `EVENT_CARD_CAP` is 80; 95 puts 15 events past it. */
const MANY = Array.from({ length: 95 }, (_, i) => ({
  ...BASE_EVENT,
  id: `e:${i}`,
  title: `Evento numero ${i}`,
  startDate: `2026-07-${String((i % 27) + 1).padStart(2, '0')}`,
}));

const eventDetailHref = (e: { id: string }) => pathForEventDetail('it', 'Lugano', `slug-${e.id.replace(':', '-')}`);

describe('events hubs link their whole event list past the card cap (#5434)', () => {
  it('a comune hub with 95 events links all 95 detail pages', () => {
    const { html } = renderComunePage({
      locale: 'it',
      canton: 'TI',
      comune: 'Lugano',
      events: MANY as never,
      dateStamp: '2026-06-30',
      weekendDays: new Set(['2026-07-04', '2026-07-05']),
      distDir,
      detailHref: eventDetailHref as never,
    });
    const linked = hrefs(html);
    const missing = MANY.filter((e) => !linked.has(eventDetailHref(e))).map((e) => e.id);
    expect(missing).toEqual([]);
    expect(html).toMatch(MARKER_RE);
  });

  it('the other-events sentinel — the largest bucket in the corpus — does the same', () => {
    const { html } = renderOtherEventsPage({
      locale: 'it',
      canton: 'TI',
      events: MANY.map((e) => ({ ...e, comune: undefined })) as never,
      dateStamp: '2026-06-30',
      weekendDays: new Set(['2026-07-04', '2026-07-05']),
      distDir,
      detailHref: eventDetailHref as never,
    });
    const linked = hrefs(html);
    const missing = MANY.filter((e) => !linked.has(eventDetailHref(e))).map((e) => e.id);
    expect(missing).toEqual([]);
  });

  /**
   * The sentinel bucket carries its own, lower `OTHER_EVENTS_CARD_CAP` (24)
   * because 80 cards on the largest page in the corpus were ~111 KB of markup
   * on their own (issue #7331). The cut is a page-WEIGHT decision, so it is
   * only legitimate while reachability is untouched: fewer cards must mean
   * MORE overflow rows, never fewer linked events. That is the #5434 invariant
   * again, and it is precisely what stops "make the page lighter" from being
   * implemented by dropping events.
   */
  it('the sentinel renders a smaller card block than a comune hub, and links the same events', () => {
    const otherEvents = MANY.map((e) => ({ ...e, comune: undefined }));
    const { html: sentinel } = renderOtherEventsPage({
      locale: 'it',
      canton: 'TI',
      events: otherEvents as never,
      dateStamp: '2026-06-30',
      weekendDays: new Set(['2026-07-04', '2026-07-05']),
      distDir,
      detailHref: eventDetailHref as never,
    });
    const { html: hub } = renderComunePage({
      locale: 'it',
      canton: 'TI',
      comune: 'Lugano',
      events: MANY as never,
      dateStamp: '2026-06-30',
      weekendDays: new Set(['2026-07-04', '2026-07-05']),
      distDir,
      detailHref: eventDetailHref as never,
    });

    // Minifier-tolerant on purpose: `class="ev-card group"` keeps its quotes
    // (it has whitespace), `class="ev-lnk"` does NOT — a quoted-only pattern
    // matches zero overflow rows and the invariant below passes vacuously.
    const cards = (html: string) => html.match(/<article class=["']?ev-card/g)?.length ?? 0;
    const overflowRows = (html: string) => html.match(/<a class=["']?ev-lnk/g)?.length ?? 0;

    expect(cards(sentinel)).toBe(24);
    // The hub cap is deliberately NOT lowered — cards are the discovery
    // surface there, and its pages are nowhere near the byte budget.
    expect(cards(hub)).toBe(80);

    // Every event is still exactly once on the page: carded or listed.
    expect(cards(sentinel) + overflowRows(sentinel)).toBe(MANY.length);
    expect(hrefs(sentinel).size).toBeGreaterThanOrEqual(MANY.length);
  });

  it('renders no overflow block when the list fits under the cap', () => {
    const { html } = renderComunePage({
      locale: 'it',
      canton: 'TI',
      comune: 'Lugano',
      events: MANY.slice(0, 12) as never,
      dateStamp: '2026-06-30',
      weekendDays: new Set<string>(),
      distDir,
      detailHref: eventDetailHref as never,
    });
    expect(html).not.toMatch(MARKER_RE);
  });
});

// ── 3. the BFS root ────────────────────────────────────────────────────────

/**
 * `scripts/audit-bfs-depth.mjs` starts its walk at `dist/index.html`, which is
 * built from this file. Both hrefs below are load-bearing depth-1 entry points,
 * NOT decoration — losing either one pushes a whole family back over `maxDepth`
 * (see the header). Kept as a literal string check on the source shell because
 * that is the artefact the audit reads.
 */
describe('the home shell carries the two depth-1 entry points the audit needs (#5434)', () => {
  const INDEX_HTML = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  it('links /eventi/ — /vivere-in-ticino/ is NOT a substitute, it is one hop lower', () => {
    expect(INDEX_HTML).toContain('href="/eventi/"');
  });

  it('links the border-comuni hub directly, so it does not hang off a single inbound', () => {
    expect(INDEX_HTML).toContain('href="/vivere-in-ticino/comuni-di-frontiera/"');
  });
});
