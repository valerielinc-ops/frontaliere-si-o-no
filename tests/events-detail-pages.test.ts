/**
 * Per-event detail pages (#3125 F1): stable event slug, localized canonical
 * paths, Event JSON-LD that points to OUR page (source as sameAs), an indexable
 * detail page with complete structured data + breadcrumb + ≥ MIN_INDEXABLE_WORDS,
 * and the router recognising the 2-segment detail URL.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { slugifyEvent } from '../scripts/lib/events-utils.mjs';
import {
  eventLd,
  pathForEventDetail,
  renderEventDetailPage,
} from '../build-plugins/eventsSeoPagesPlugin';
import { MIN_INDEXABLE_WORDS } from '../build-plugins/constants';
import { parsePath } from '../services/router';

const EVENT = {
  id: 'tio-agenda:42',
  title: 'Concerto sinfonico al LAC',
  startDate: '2026-07-04',
  endDate: '2026-07-04',
  startTime: '20:00',
  category: 'musica',
  region: 'Luganese',
  venue: 'LAC Lugano Arte e Cultura',
  comune: 'Lugano',
  canton: 'TI',
  url: 'https://www.tio.ch/agenda/day/20260704/42',
  sourceKey: 'tio-agenda',
  sourceName: 'Tio.ch Agenda',
};

describe('slugifyEvent', () => {
  it('builds a stable title-date slug', () => {
    expect(slugifyEvent(EVENT)).toBe('concerto-sinfonico-al-lac-2026-07-04');
  });
  it('is deterministic and diacritic-free', () => {
    const a = slugifyEvent({ title: 'Festa d’Estate à Lugano', startDate: '2026-08-01' });
    expect(a).toBe(slugifyEvent({ title: 'Festa d’Estate à Lugano', startDate: '2026-08-01' }));
    expect(a).toMatch(/^[a-z0-9-]+$/);
    expect(a).toContain('2026-08-01');
  });
});

describe('pathForEventDetail', () => {
  it('uses the localized base segment for each locale', () => {
    const slug = slugifyEvent(EVENT);
    expect(pathForEventDetail('it', 'Lugano', slug)).toBe(`/eventi/ticino/lugano/${slug}/`);
    expect(pathForEventDetail('en', 'Lugano', slug)).toBe(`/en/events/ticino/lugano/${slug}/`);
    expect(pathForEventDetail('de', 'Lugano', slug)).toBe(`/de/veranstaltungen/tessin/lugano/${slug}/`);
    expect(pathForEventDetail('fr', 'Lugano', slug)).toBe(`/fr/evenements/tessin/lugano/${slug}/`);
  });
});

describe('eventLd canonical', () => {
  it('points url at OUR page and keeps the source as sameAs when a canonical is given', () => {
    const canonical = 'https://frontaliereticino.ch/eventi/ticino/lugano/x/';
    const ld = eventLd(EVENT as never, 'it', canonical) as Record<string, unknown>;
    expect(ld.url).toBe(canonical);
    expect(ld.sameAs).toEqual([EVENT.url]);
  });
  it('falls back to the source url on aggregate pages (no canonical)', () => {
    const ld = eventLd(EVENT as never, 'it') as Record<string, unknown>;
    expect(ld.url).toBe(EVENT.url);
    expect(ld.sameAs).toBeUndefined();
  });
});

describe('renderEventDetailPage', () => {
  const distDir = mkdtempSync(path.join(os.tmpdir(), 'events-detail-'));
  const detailHref = (e: { id: string }) =>
    e.id === EVENT.id ? null : pathForEventDetail('it', 'Lugano', 'altro');
  const other = { ...EVENT, id: 'tio-agenda:43', title: 'Mostra fotografica', startTime: undefined };
  const page = renderEventDetailPage({
    locale: 'it',
    event: EVENT as never,
    comune: 'Lugano',
    eventSlug: slugifyEvent(EVENT),
    sameComuneEvents: [EVENT, other] as never,
    dateStamp: '2026-06-30',
    distDir,
    detailHref: detailHref as never,
  });

  it('emits at the canonical per-event path', () => {
    expect(page.urlPath).toBe(`/eventi/ticino/lugano/${slugifyEvent(EVENT)}/`);
  });
  it('is indexable (rich enough body, ≥ MIN_INDEXABLE_WORDS)', () => {
    expect(page.wordCount).toBeGreaterThanOrEqual(MIN_INDEXABLE_WORDS);
    expect(page.html).toContain('robots');
    expect(page.html).toContain('index,follow');
  });
  it('carries the title, an Event JSON-LD with our canonical + sameAs, breadcrumb and FAQ', () => {
    // (HTML is minified — JSON-LD has no spaces after colons)
    expect(page.html).toContain('Concerto sinfonico al LAC');
    expect(page.html).toContain('"@type":"Event"');
    expect(page.html).toContain(`"url":"https://frontaliereticino.ch/eventi/ticino/lugano/${slugifyEvent(EVENT)}/"`);
    expect(page.html).toContain(`"sameAs":["${EVENT.url}"]`);
    expect(page.html).toContain('"@type":"BreadcrumbList"');
    expect(page.html).toContain('"@type":"FAQPage"');
  });
  it('links the source as a nofollow official-site CTA and lists other events in the comune', () => {
    expect(page.html).toContain(EVENT.url);
    expect(page.html).toMatch(/rel="nofollow noopener"/);
    expect(page.html).toContain('Mostra fotografica'); // the other comune event
  });
  it('emits hreflang for all four locales', () => {
    for (const seg of ['/eventi/ticino/lugano/', '/en/events/ticino/lugano/', '/de/veranstaltungen/tessin/lugano/', '/fr/evenements/tessin/lugano/']) {
      expect(page.html).toContain(seg);
    }
  });
});

describe('router recognises per-event detail URLs (staticOverlay)', () => {
  for (const url of [
    '/eventi/ticino/lugano/concerto-sinfonico-al-lac-2026-07-04/',
    '/en/events/ticino/lugano/concerto-sinfonico-al-lac-2026-07-04/',
    '/de/veranstaltungen/tessin/lugano/x-2026-07-04/',
    '/fr/evenements/tessin/lugano/x-2026-07-04/',
  ]) {
    it(`maps ${url} to the vita/places static overlay`, () => {
      const parsed = parsePath(url);
      expect(parsed?.route?.staticOverlay).toBe(true);
      expect(parsed?.route?.activeTab).toBe('vita');
    });
  }
  it('still maps the 1-segment comune page', () => {
    const parsed = parsePath('/eventi/ticino/lugano/');
    expect(parsed?.route?.staticOverlay).toBe(true);
  });
});
