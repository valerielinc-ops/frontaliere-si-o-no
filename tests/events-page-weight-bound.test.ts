/**
 * Byte-budget gate for the events bucket pages (issue #7330).
 *
 * WHY THIS FILE EXISTS. Nothing in the repo limited the WEIGHT of the pages
 * `renderOtherEventsPage()` / `renderComunePage()` emit. The only observer was
 * the post-deploy `audit:page-weight` run, and it measures the dataset OF THAT
 * DAY: after a trim the page lands under budget, the gate goes green, and then
 * it silently crosses back over as the corpus grows — which is exactly what
 * happened on `/eventi/altri-cantoni/altri-eventi/` (683 upcoming events on
 * 2026-08-09 → 1235 on 2026-09-04, +81 % in 26 days) and why the gate came
 * back red on the same path in 4 runs out of 6. `tests/seo/
 * job-sector-page-weight.test.ts` does this job for the job-board landings;
 * the events tree had no equivalent.
 *
 * WHAT IT ASSERTS, AND WHY IT IS TWO THINGS. "Under budget today" and "under
 * budget by construction" are different properties, and only the second one
 * survives corpus growth:
 *
 *   1. BUDGET — rendered with THREE TIMES the current bucket (3 × 1235 ≈ 3700
 *      events, strings sized to the corpus's real p90), the page stays inside
 *      `MAX_HTML_BYTES`. Three years of the measured growth rate, in one
 *      assertion.
 *   2. SCALE LAW — the same page rendered with N and with 3N must differ by
 *      less than a small constant. This is the property the audit gate can
 *      never observe (it only ever sees one N) and the one that makes the
 *      budget hold for a corpus size nobody has measured yet. A page whose
 *      weight is linear in the dataset passes (1) by luck and fails (2) by
 *      construction.
 *
 * The budget is IMPORTED from `scripts/audit-page-weight.mjs`, never copied:
 * a literal here would keep guarding 260 KB after the gate moved on.
 *
 * The comune hub is covered alongside the sentinel bucket because both render
 * the very same unbounded block — `renderOverflowIndex()`. Guarding one and
 * leaving the other is guarding half a defect: `/eventi/ginevra/geneve/` is
 * the second bucket over the card cap and grows from the same pipeline.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderOtherEventsPage, renderComunePage, pathForEventDetail } from '../build-plugins/eventsSeoPagesPlugin';
import { MAX_HTML_BYTES } from '../scripts/audit-page-weight.mjs';

const distDir = mkdtempSync(path.join(os.tmpdir(), 'events-page-weight-'));

/**
 * Upcoming events in the comune-less `altri-cantoni/altri-eventi` bucket,
 * measured on the live dataset 2026-09-04. The multiplier below is applied to
 * THIS number, so the test's meaning ("three times the largest page we have")
 * stays stable even as the real bucket moves.
 */
const BUCKET_TODAY = 1235;

/**
 * Three times the largest bucket. At the measured +81 %/26 days this is well
 * past any corpus the pipeline can produce before someone looks at it again;
 * below that a bounded page and a linear one are hard to tell apart.
 */
const GROWTH_FACTOR = 3;

/**
 * Byte slack allowed between the N-event page and the 3N-event page. A bounded
 * page still moves a little with N: the three `<dl>` metrics print the counts
 * themselves, the attribution line names more sources, and the overflow copy
 * interpolates a row count. That is a handful of digits and a few source
 * names, not a kilobyte per thousand events — so 8 KB is generous for
 * "constant" and nowhere near the ~340 KB a linear page adds over the same
 * span.
 */
const SCALE_SLACK_BYTES = 8 * 1024;

/**
 * Corpus-realistic string lengths (computed over `data/events.json`,
 * 2026-09-04: 7941 events). Titles p50 29 / p90 56, descriptions p50 100 /
 * p90 187. p90 rather than p50 because a byte budget is a worst-case
 * question, and rather than the max (137 / much longer) because a page made
 * entirely of the longest event in the corpus is not a page that exists.
 */
const TITLE_CHARS = 56;
const DESCRIPTION_CHARS = 187;

const TITLE = 'Festa patronale con concerto bandistico e mercatino'.padEnd(TITLE_CHARS, 'o');
const DESCRIPTION =
  'Una giornata di musica, gastronomia e intrattenimento per tutte le eta con ingresso libero e programma dettagliato'.padEnd(
    DESCRIPTION_CHARS,
    'o',
  );

/**
 * One event at the heaviest realistic profile: every optional field the card
 * and the JSON-LD read is populated, and all four locale variants are present
 * (96 % of the corpus carries `titleByLocale`), so no render path degrades to
 * a cheaper shape and under-counts the page.
 */
function makeEvent(index: number, comune?: string) {
  const title = `${TITLE} ${index}`;
  const description = `${DESCRIPTION} ${index}`;
  return {
    id: `e:${index}`,
    title,
    startDate: `2026-07-${String((index % 27) + 1).padStart(2, '0')}`,
    endDate: `2026-07-${String((index % 27) + 1).padStart(2, '0')}`,
    startTime: '20:30',
    category: 'musica',
    venue: 'Centro polivalente comunale',
    comune,
    canton: comune ? 'TI' : 'ZH',
    url: `https://example.org/eventi/${index}`,
    imageUrl: `/assets/events/evento-${index}.webp`,
    sourceKey: 'guidle',
    sourceName: 'Guidle',
    description,
    titleByLocale: { it: title, en: title, de: title, fr: title },
    descriptionByLocale: { it: description, en: description, de: description, fr: description },
  };
}

const detailHref = (event: { id: string }) =>
  pathForEventDetail('it', 'altri-eventi', `slug-${event.id.replace(':', '-')}`, 'altri-cantoni');

function bucketPageBytes(count: number): number {
  const events = Array.from({ length: count }, (_, i) => makeEvent(i));
  const { html } = renderOtherEventsPage({
    locale: 'it',
    canton: 'altri-cantoni',
    events: events as never,
    dateStamp: '2026-09-04',
    weekendDays: new Set(['2026-07-04', '2026-07-05']),
    distDir,
    detailHref: detailHref as never,
  });
  return Buffer.byteLength(html, 'utf8');
}

function comuneHubBytes(count: number): number {
  const events = Array.from({ length: count }, (_, i) => makeEvent(i, 'Lugano'));
  const { html } = renderComunePage({
    locale: 'it',
    canton: 'TI',
    comune: 'Lugano',
    events: events as never,
    dateStamp: '2026-09-04',
    weekendDays: new Set(['2026-07-04', '2026-07-05']),
    distDir,
    detailHref: detailHref as never,
  });
  return Buffer.byteLength(html, 'utf8');
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

describe.each([
  { name: 'the comune-less sentinel bucket (/eventi/altri-cantoni/altri-eventi/)', render: bucketPageBytes },
  { name: 'a comune hub over the card cap (/eventi/ginevra/geneve/)', render: comuneHubBytes },
])('$name stays inside the audit:page-weight budget', ({ render }) => {
  it(`holds at ${GROWTH_FACTOR}x the current bucket (${GROWTH_FACTOR * BUCKET_TODAY} events)`, () => {
    const bytes = render(GROWTH_FACTOR * BUCKET_TODAY);
    expect(
      bytes,
      `${kb(bytes)} exceeds the ${kb(MAX_HTML_BYTES)} audit:page-weight budget at ${GROWTH_FACTOR * BUCKET_TODAY} events. ` +
        'Do NOT fix this by dropping events from the overflow index — that re-orphans them (#5434). Bound the block.',
    ).toBeLessThanOrEqual(MAX_HTML_BYTES);
  });

  it('costs a bounded number of bytes as the dataset grows (N vs 3N)', () => {
    const atN = render(BUCKET_TODAY);
    const at3N = render(GROWTH_FACTOR * BUCKET_TODAY);
    const growth = at3N - atN;
    expect(
      growth,
      `the page grew ${kb(growth)} going from ${BUCKET_TODAY} to ${GROWTH_FACTOR * BUCKET_TODAY} events ` +
        `(${kb(atN)} → ${kb(at3N)}): its weight is linear in the corpus, so it is under budget only until the ` +
        'next crawl. audit:page-weight cannot see this — it only ever measures one N.',
    ).toBeLessThan(SCALE_SLACK_BYTES);
  });
});
