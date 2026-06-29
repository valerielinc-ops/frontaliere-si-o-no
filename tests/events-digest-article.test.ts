/**
 * Guard the deterministic weekend-digest article content builder
 * (chained feature on #2963): 4-locale payload, per-comune grouping, links,
 * empty-weekend handling, evergreen stable id/slug, valid FAQ JSON.
 */
import { describe, it, expect } from 'vitest';
import {
  buildWeekendDigestArticle,
  DIGEST_ARTICLE_ID,
  DIGEST_ARTICLE_SLUGS,
} from '../scripts/lib/events-digest-content.mjs';
import { EVENTS_BASE_PATH } from '../scripts/lib/events-utils.mjs';

const TODAY = '2027-01-01'; // Friday → weekend window = 2027-01-02 (Sat) .. 2027-01-03 (Sun)
const EVENTS = [
  { id: 'a', title: 'Concerto al LAC', comune: 'Lugano', startDate: '2027-01-02', startTime: '20:00', category: 'musica' },
  { id: 'b', title: "Mercatino dell'usato", comune: 'Bellinzona', startDate: '2027-01-02', category: 'mercato' },
  { id: 'c', title: 'Mostra Hodler', comune: 'Lugano', startDate: '2027-01-03', category: 'cultura' },
  { id: 'far', title: 'Fuori weekend', comune: 'Locarno', startDate: '2027-02-10' },
];

describe('buildWeekendDigestArticle', () => {
  const art = buildWeekendDigestArticle({ events: EVENTS, todayIso: TODAY });

  it('has a stable evergreen id and slugs (no date → no repo flooding)', () => {
    expect(art.id).toBe(DIGEST_ARTICLE_ID);
    expect(art.id).toBe('eventi-weekend-ticino');
    expect(art.slugs).toEqual(DIGEST_ARTICLE_SLUGS);
    expect(art.slugs.it).not.toMatch(/\d/); // no date in slug
  });

  it('counts only events inside the weekend window', () => {
    expect(art.eventCount).toBe(3); // the 2027-02-10 event is excluded
    expect(art.weekendStart).toBe('2027-01-02');
    expect(art.weekendEnd).toBe('2027-01-03');
  });

  it('emits all four locales in the registration data shape', () => {
    for (const loc of ['it', 'en', 'de', 'fr'] as const) {
      const c = art.content[loc];
      expect(c.title.length).toBeGreaterThan(10);
      expect(c.excerpt.length).toBeGreaterThan(20);
      expect(c.body1).toContain('## ');
      // imageAlt lives at the top level (matches create-article buildMetaBlock)
      expect(art.imageAlt[loc].length).toBeGreaterThan(3);
      // faq is an array of {q,a} (not a JSON string) so buildBodyFile consumes it
      expect(Array.isArray(c.faq)).toBe(true);
      expect(c.faq.length).toBeGreaterThanOrEqual(2);
      expect(c.faq[0]).toHaveProperty('q');
      expect(c.faq[0]).toHaveProperty('a');
    }
  });

  it('groups events by comune with locale-correct deep links', () => {
    expect(art.content.it.body2).toContain('### [Lugano](/eventi/ticino/lugano/)');
    expect(art.content.it.body2).toContain('Concerto al LAC');
    expect(art.content.it.body2).toContain('### [Bellinzona](/eventi/ticino/bellinzona/)');
    // busiest comune (Lugano, 2 events) listed before Bellinzona (1 event)
    expect(art.content.it.body2.indexOf('Lugano')).toBeLessThan(art.content.it.body2.indexOf('Bellinzona'));
    // locale-prefixed links use the TRANSLATED base segment (matches the SSG plugin)
    expect(art.content.de.body2).toContain('(/de/veranstaltungen/tessin/lugano/)');
    expect(art.content.fr.body2).toContain('(/fr/evenements/tessin/lugano/)');
  });

  it('handles an empty weekend without inventing events', () => {
    const empty = buildWeekendDigestArticle({ events: [EVENTS[3]], todayIso: TODAY });
    expect(empty.eventCount).toBe(0);
    expect(empty.content.it.body2).toBe('');
    expect(empty.content.it.body1.toLowerCase()).toContain('non risultano eventi');
    // still valid 4-locale payload
    expect(empty.content.en.body1.toLowerCase()).toContain('no events');
  });

  it('deep-links events pages with the locale-correct base path (no /en/eventi/ 404s)', () => {
    // Regression for PR #3088 🔴: the EN/DE/FR base segment is translated
    // (/en/events/ticino, /de/veranstaltungen/tessin, /fr/evenements/tessin).
    // Every events deep link in the body MUST start with the shared base path.
    for (const loc of ['it', 'en', 'de', 'fr'] as const) {
      const body = art.content[loc].body1 + art.content[loc].body2 + art.content[loc].body3;
      const localPrefixed = [...body.matchAll(/\]\((\/(?:en|de|fr)?\/?(?:events|eventi|veranstaltungen|evenements)\/[^)]*)\)/g)];
      expect(localPrefixed.length).toBeGreaterThan(0);
      for (const m of localPrefixed) {
        expect(m[1].startsWith(`${EVENTS_BASE_PATH[loc]}/`)).toBe(true);
      }
      // sanity: IT links never carry a non-IT segment and vice versa
      if (loc !== 'it') expect(body).not.toContain(`(${EVENTS_BASE_PATH.it}/questo-weekend`);
    }
  });

  it('keeps title/excerpt evergreen (no date) but dates the body for the live weekend', () => {
    // meta stays stable across weekly refreshes…
    expect(art.content.it.title).not.toContain('gennaio');
    expect(art.content.it.excerpt).not.toMatch(/\d/);
    // …while the body carries the live weekend range
    expect(art.content.it.body1).toContain('gennaio');
  });
});
