// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { retainPublishedPastEvents } from '../scripts/assemble-events-dataset.mjs';
import { eventDateIssues } from '../scripts/lib/events-date-quality.mjs';
import { publishedEventRoutes } from '../scripts/lib/events-retention.mjs';
import { pathForEventDetail } from '../build-plugins/eventsSeoPagesPlugin';

// Events that were published and clicked from Google, then left the dataset
// before the permanent archive existed. Their records are restored verbatim
// from pinned public snapshots; the archive then emits every locale URL.
type Row = {
  id: string; startDate: string; endDate?: string; canton?: string; comune?: string; url: string;
  previousRoutes?: { canton: string; comune: string; slug: string }[];
  recoveryEvidence?: { sourceSnapshot: string; sourceGeneratedAt: string };
};
const seed = JSON.parse(readFileSync(new URL('../data/events-recovery-archive.json', import.meta.url), 'utf8')) as {
  sourceSnapshots: { commit: string }[]; events: Row[];
};
const fixture = JSON.parse(readFileSync(new URL('./fixtures/gsc-event-archive-lost-before-retention.json', import.meta.url), 'utf8')) as {
  routes: [string, string][];
};
const locales = ['it', 'en', 'de', 'fr'] as const;
// Real historical URLs, not date-sensitive fixtures: evaluate the archive
// lifecycle after the last observed date, not on a fixed day.
const lastDay = seed.events.map((event) => event.endDate || event.startDate).sort().at(-1)!;
const afterEnd = new Date(Date.parse(`${lastDay}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const archived = retainPublishedPastEvents([], seed.events, afterEnd) as Row[];
const routes = publishedEventRoutes(archived, afterEnd);
const canonicalOwners = new Map<string, string>();
const historyOwners = new Map<string, Set<string>>();
for (const event of archived) {
  const route = routes.get(event.id)!;
  for (const locale of locales) {
    canonicalOwners.set(pathForEventDetail(locale, route.comune, route.slug, route.canton), event.id);
    for (const previous of event.previousRoutes || []) {
      const path = pathForEventDetail(locale, previous.comune, previous.slug, previous.canton);
      historyOwners.set(path, new Set([...(historyOwners.get(path) || []), event.id]));
    }
  }
}

describe('events that left the dataset before the permanent archive', () => {
  it('serves every reported route from exactly its own restored identity', () => {
    expect(fixture.routes).toHaveLength(39);
    expect(new Set(fixture.routes.map(([path]) => path)).size).toBe(fixture.routes.length);
    for (const [path, id] of fixture.routes) {
      const canonical = canonicalOwners.get(path);
      const owners = canonical ? new Set([canonical]) : historyOwners.get(path);
      expect([...(owners || [])], path).toEqual([id]);
    }
  });

  it('emits the four locale URLs of each restored event, not only the reported one', () => {
    for (const [, id] of fixture.routes) {
      const route = routes.get(id)!;
      for (const locale of locales) {
        expect(canonicalOwners.get(pathForEventDetail(locale, route.comune, route.slug, route.canton)), `${id} ${locale}`).toBe(id);
      }
    }
  });

  it('pins each restored record to a listed public snapshot and keeps it past and valid', () => {
    const commits = new Set(seed.sourceSnapshots.map((snapshot) => snapshot.commit));
    for (const [, id] of fixture.routes) {
      const record = seed.events.find((event) => event.id === id)!;
      expect(record, id).toBeDefined();
      expect(commits.has(record.recoveryEvidence!.sourceSnapshot), id).toBe(true);
      expect(eventDateIssues(record), id).toEqual([]);
      expect(retainPublishedPastEvents([], [record], afterEnd).map((event: { id: string }) => event.id), id).toEqual([id]);
    }
  });

  it('keeps the two routes published under the older slug truncation as explicit aliases', () => {
    const aliased = fixture.routes.filter(([path]) => /kantonspolizei-2026-09-20|vernissage-2026-09-22/.test(path));
    expect(aliased).toHaveLength(2);
    for (const [path, id] of aliased) {
      expect([...(historyOwners.get(path) || [])], path).toEqual([id]);
      expect(canonicalOwners.has(path), path).toBe(false);
    }
  });

  it('does not revive the cross-source twins superseded by the kept identity', () => {
    for (const id of ['myswitzerland:76ff8f5dc2534f9f85adf31a0daa234f', 'myswitzerland:e8f27d226cbe4d02b21415a057db3aad']) {
      expect(seed.events.some((event) => event.id === id), id).toBe(false);
    }
  });
});
