// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { retainPublishedPastEvents } from '../scripts/assemble-events-dataset.mjs';
import { publishedEventRoutes } from '../scripts/lib/events-retention.mjs';
import { pathForEventDetail, renderEventDetailPage } from '../build-plugins/eventsSeoPagesPlugin';
import { MIN_INDEXABLE_WORDS } from '../build-plugins/constants';
import { readAttr, readTagByAttr } from '../scripts/lib/html-attr.mjs';

type Event = Parameters<typeof renderEventDetailPage>[0]['event'];
const seed = JSON.parse(readFileSync(new URL('../data/events-recovery-archive.json', import.meta.url), 'utf8')) as { events: Event[] };
const fixture = JSON.parse(readFileSync(new URL('./fixtures/gsc-event-archive-routes.json', import.meta.url), 'utf8')) as { routes: [string, string][] };
const locales = ['it', 'en', 'de', 'fr'] as const;
// These are actual historical URLs, not synthetic date-sensitive fixtures.
// Evaluate archive lifecycle after their last observed date, not on a fixed day.
const lastDay = seed.events.map(event => event.endDate || event.startDate).sort().at(-1)!;
const afterEnd = new Date(Date.parse(`${lastDay}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const archived: Event[] = retainPublishedPastEvents([], seed.events, afterEnd);
const assigned = publishedEventRoutes(archived, afterEnd);
const canonicalOwners = new Map<string, string>();
const historyOwners = new Map<string, Set<string>>();
for (const event of archived) {
  const route = assigned.get(event.id)!;
  for (const locale of locales) {
    canonicalOwners.set(pathForEventDetail(locale, route.comune, route.slug, route.canton), event.id);
    for (const previous of event.previousRoutes || []) {
      const path = pathForEventDetail(locale, previous.comune, previous.slug, previous.canton);
      historyOwners.set(path, new Set([...(historyOwners.get(path) || []), event.id]));
    }
  }
}

describe('reported GSC event archive coverage', () => {
  it('keeps every attested reported route attached to its exact public identity', () => {
    expect(fixture.routes).toHaveLength(372);
    expect(new Set(fixture.routes.map(([path]) => path)).size).toBe(fixture.routes.length);
    for (const [path, id] of fixture.routes) {
      const canonical = canonicalOwners.get(path);
      const owners = canonical ? new Set([canonical]) : historyOwners.get(path);
      expect([...(owners || [])], path).toEqual([id]);
    }
  });

  it('renders substantive self-canonical archives rather than generic retired pages', () => {
    const byId = new Map(archived.map(event => [event.id, event]));
    for (const [reportedPath, id] of fixture.routes) {
      const event = byId.get(id)!;
      const route = assigned.get(id)!;
      const locale = locales.find(lang => reportedPath.startsWith(`/${lang}/`)) || 'it';
      const page = renderEventDetailPage({
        locale, event, comune: route.comune, eventSlug: route.slug,
        sameComuneEvents: [], dateStamp: afterEnd, distDir: '', detailHref: () => null,
        isPast: true,
      });
      expect(page.wordCount, reportedPath).toBeGreaterThanOrEqual(MIN_INDEXABLE_WORDS);
      expect(page.html, reportedPath).toContain('index, follow');
      const canonical = readTagByAttr(page.html, 'rel', 'canonical');
      expect(readAttr(canonical, ['href']), reportedPath).toBe(`https://frontaliereticino.ch${page.urlPath}`);
      expect(page.html, reportedPath).not.toContain('Pagina archiviata');
      expect(page.html, reportedPath).not.toMatch(/"@type"\s*:\s*"Event"/);
      expect(page.html, reportedPath).toContain(event.startDate);
    }
  });

  it('keeps a fresh same-ID record authoritative while carrying its attested old URLs', () => {
    const id = fixture.routes[0][1];
    const prior = seed.events.find(event => event.id === id)!;
    const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
    const fresh = { ...prior, title: 'Programma aggiornato dalla fonte', startDate: day(1), endDate: day(2), previousRoutes: [] };
    const [retained] = retainPublishedPastEvents([fresh], [prior], day(0));
    expect(retained).toMatchObject({ title: fresh.title, startDate: fresh.startDate, endDate: fresh.endDate });
    expect(retained.previousRoutes.length).toBeGreaterThan(0);
    expect(retainPublishedPastEvents([], [fresh], day(0))).toEqual([]);
  });
});
