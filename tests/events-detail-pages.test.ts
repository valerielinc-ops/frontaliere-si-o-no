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
  renderHubPage,
  renderComunePage,
  renderDigestPage,
  DIGESTS,
} from '../build-plugins/eventsSeoPagesPlugin';
import { SITE_LICENSE_PAGE } from '../services/seo/imageObjectLd';
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

describe('eventLd nationwide fields (#3125)', () => {
  it('uses the per-EVENT_SOURCES organizer, not a single hardcoded source', () => {
    const guidleEvent = { ...EVENT, id: 'guidle:abc', sourceKey: 'guidle', sourceName: 'Guidle' };
    const ld = eventLd(guidleEvent as never, 'it') as Record<string, any>;
    expect(ld.organizer.url).toBe('https://www.guidle.com');
    expect(ld.organizer.name).toBe('Guidle');
  });

  it('falls back to the tio-agenda source when sourceKey is unknown (defensive)', () => {
    const unknownSource = { ...EVENT, sourceKey: 'does-not-exist' };
    const ld = eventLd(unknownSource as never, 'it') as Record<string, any>;
    expect(ld.organizer.url).toBe('https://www.tio.ch/agenda');
  });

  it('prefers a real crawled description over the synthesized one when long enough', () => {
    const withDescription = {
      ...EVENT,
      description: 'Una serata di grande musica sinfonica con orchestra internazionale al LAC di Lugano.',
    };
    const ld = eventLd(withDescription as never, 'it') as Record<string, any>;
    expect(ld.description).toBe(withDescription.description);
  });

  it('emits location.geo when the event has coordinates', () => {
    const withGeo = { ...EVENT, geo: { lat: 46.005, lng: 8.951 } };
    const ld = eventLd(withGeo as never, 'it') as Record<string, any>;
    expect(ld.location.geo).toEqual({ '@type': 'GeoCoordinates', latitude: 46.005, longitude: 8.951 });
  });

  it('emits address.streetAddress/postalCode when known', () => {
    const withAddress = { ...EVENT, address: { street: 'Piazza Bernardino Luini 6', postalCode: '6900' } };
    const ld = eventLd(withAddress as never, 'it') as Record<string, any>;
    expect(ld.location.address.streetAddress).toBe('Piazza Bernardino Luini 6');
    expect(ld.location.address.postalCode).toBe('6900');
  });

  it('omits offers entirely when price is unknown (never a partial offers object)', () => {
    const ld = eventLd(EVENT as never, 'it') as Record<string, any>;
    expect(ld.offers).toBeUndefined();
  });

  it('emits a complete offers object for a free event', () => {
    const freeEvent = { ...EVENT, price: { amount: null, currency: 'CHF', isFree: true } };
    const ld = eventLd(freeEvent as never, 'it') as Record<string, any>;
    expect(ld.offers).toMatchObject({
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'CHF',
      availability: 'https://schema.org/InStock',
      validFrom: EVENT.startDate,
    });
    expect(ld.offers.url).toBeTruthy();
  });

  it('emits a complete offers object for a paid event', () => {
    const paidEvent = { ...EVENT, price: { amount: 25, currency: 'CHF', isFree: false } };
    const ld = eventLd(paidEvent as never, 'it') as Record<string, any>;
    expect(ld.offers.price).toBe('25');
    expect(ld.offers.priceCurrency).toBe('CHF');
  });

  it('emits an ImageObject (GSC licensable-image quintet) with the mirrored image path, absolute-ized', () => {
    const withImage = { ...EVENT, imageUrl: '/images/events/guidle-abc.jpg', sourceName: 'Guidle' };
    const ld = eventLd(withImage as never, 'it') as Record<string, any>;
    expect(ld.image['@type']).toBe('ImageObject');
    expect(ld.image.contentUrl).toBe('https://frontaliereticino.ch/images/events/guidle-abc.jpg');
    expect(ld.image.url).toBe('https://frontaliereticino.ch/images/events/guidle-abc.jpg');
    // Attribution IS honestly known (the crawl source) — credited.
    expect(ld.image.creditText).toBe('Guidle');
    // No third-party license is ever scraped (issue #3036 item 3) — never
    // fabricate one; fall back to the site's OWN terms page + Organization,
    // never a claim of the third party's copyright.
    expect(ld.image.license).toBe(SITE_LICENSE_PAGE);
    expect(ld.image.acquireLicensePage).toBe(SITE_LICENSE_PAGE);
    expect(ld.image.creator).toEqual({
      '@type': 'Organization',
      name: 'Frontaliere Ticino',
      url: 'https://frontaliereticino.ch',
    });
    expect(ld.image.copyrightNotice).toBeTruthy();
  });

  it('falls back to the plain site image URL when the event has no image', () => {
    const withoutImage = eventLd(EVENT as never, 'it') as Record<string, any>;
    expect(withoutImage.image).toBe('https://frontaliereticino.ch/og-image.png');
  });

  it('never hotlinks a raw non-mirrored third-party image URL — degrades to the site image instead', () => {
    // Defense-in-depth: every crawler is contracted to only ever store a
    // mirrored `/images/events/...` path (or leave imageUrl unset), but a
    // stale pre-mirroring dataset snapshot could still carry a raw URL. That
    // must NEVER be embedded (hotlinked) into production JSON-LD.
    const hotlinked = { ...EVENT, imageUrl: 'https://biglietteria.ch/files/flyer.jpg' };
    const ld = eventLd(hotlinked as never, 'it') as Record<string, any>;
    expect(ld.image).toBe('https://frontaliereticino.ch/og-image.png');
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

  // Canton rollout (#3125): the matcher must recognise ANY canton's URL
  // slug from data/canton-url-slugs.json, not just the legacy hardcoded
  // ticino/tessin literal — proves the generalization is real, not a
  // same-behavior refactor.
  for (const url of [
    '/eventi/zurigo/',
    '/eventi/zurigo/zurigo/',
    '/en/events/zurich/zurich/',
    '/de/veranstaltungen/zurich/zurich/',
    '/fr/evenements/zurich/zurich/',
  ]) {
    it(`recognises a non-Ticino canton hub/comune page: ${url}`, () => {
      const parsed = parsePath(url);
      expect(parsed?.route?.staticOverlay).toBe(true);
      expect(parsed?.route?.activeTab).toBe('vita');
    });
  }

  it('rejects a first segment that is not a known canton slug (falls through, no false match)', () => {
    const parsed = parsePath('/eventi/not-a-real-canton/');
    expect(parsed?.route?.staticOverlay).not.toBe(true);
  });
});

// #3125 Task C: price / address / map / recurring / real description rendered
// VISIBLY in the detail page body, not only inside the Event JSON-LD.
describe('renderEventDetailPage nationwide fields (#3125 Task C)', () => {
  const distDir = mkdtempSync(path.join(os.tmpdir(), 'events-detail-fields-'));
  const richEvent = {
    ...EVENT,
    id: 'guidle:rich',
    description: 'Descrizione reale raccolta dal crawler, con dettagli sul programma della serata.',
    price: { amount: 25, currency: 'CHF', isFree: false },
    address: { street: 'Piazza Bernardino Luini 6', postalCode: '6900' },
    geo: { lat: 46.005, lng: 8.951 },
    recurring: true,
  };
  const page = renderEventDetailPage({
    locale: 'it',
    event: richEvent as never,
    comune: 'Lugano',
    eventSlug: slugifyEvent(richEvent),
    sameComuneEvents: [richEvent] as never,
    dateStamp: '2026-06-30',
    distDir,
    detailHref: (() => null) as never,
  });

  it('renders a price line (paid event)', () => {
    expect(page.html).toContain('Prezzo');
    expect(page.html).toContain('CHF 25');
  });

  it('renders the address (street + postal code)', () => {
    expect(page.html).toContain('Indirizzo');
    expect(page.html).toContain('Piazza Bernardino Luini 6');
    expect(page.html).toContain('6900');
  });

  it('renders a plain OpenStreetMap link (no third-party embed/tracker), accessible', () => {
    // esc() HTML-escapes the "&" in the href attribute (&amp;).
    expect(page.html).toContain('openstreetmap.org/?mlat=46.005&amp;mlon=8.951');
    expect(page.html).toContain('rel="nofollow noopener"');
    expect(page.html).not.toMatch(/google\.com\/maps|<iframe/i);
    // Accessible name on the map link (not just an icon).
    expect(page.html).toMatch(/aria-label="Apri [^"]+ su OpenStreetMap"/);
  });

  it('renders the recurring badge when event.recurring is true', () => {
    expect(page.html).toContain('Evento ricorrente');
  });

  it('renders the real crawled description as visible prose, alongside the synthesized paragraph', () => {
    expect(page.html).toContain('Descrizione reale raccolta dal crawler');
    expect(page.html).toContain('Descrizione'); // descriptionTitle
    // The synthesized dc.about(...) paragraph is still present (never removed).
    expect(page.html).toContain('è un evento di tipo');
  });

  it('renders "Gratis" for a free event', () => {
    const freeEvent = { ...EVENT, id: 'guidle:free', price: { amount: null, currency: 'CHF', isFree: true } };
    const freePage = renderEventDetailPage({
      locale: 'it',
      event: freeEvent as never,
      comune: 'Lugano',
      eventSlug: slugifyEvent(freeEvent),
      sameComuneEvents: [freeEvent] as never,
      dateStamp: '2026-06-30',
      distDir,
      detailHref: (() => null) as never,
    });
    expect(freePage.html).toContain('Gratis');
  });

  it('omits price/address/recurring markup entirely when the fields are unknown (TI regression guard)', () => {
    expect(page.wordCount).toBeGreaterThanOrEqual(MIN_INDEXABLE_WORDS);
    const baselinePage = renderEventDetailPage({
      locale: 'it',
      event: EVENT as never,
      comune: 'Lugano',
      eventSlug: slugifyEvent(EVENT),
      sameComuneEvents: [EVENT] as never,
      dateStamp: '2026-06-30',
      distDir,
      detailHref: (() => null) as never,
    });
    expect(baselinePage.html).not.toContain('Evento ricorrente');
    expect(baselinePage.html).not.toContain('Indirizzo');
  });
});

// #3125 Task B: multi-source attribution — the footer must list every DISTINCT
// source actually present among the events shown on that page, not a single
// hardcoded SOURCE.
describe('multi-source attribution (#3125 Task B)', () => {
  const distDir = mkdtempSync(path.join(os.tmpdir(), 'events-sources-'));
  const tioEvent = { ...EVENT, id: 'tio-agenda:1', sourceKey: 'tio-agenda' };
  const guidleEvent = { ...EVENT, id: 'guidle:1', comune: 'Lugano', sourceKey: 'guidle', sourceName: 'Guidle' };
  const myswEvent = { ...EVENT, id: 'myswitzerland:1', comune: 'Lugano', sourceKey: 'myswitzerland', sourceName: 'MySwitzerland' };
  const mixed = [tioEvent, guidleEvent, myswEvent];
  const byComune = new Map([['Lugano', mixed]]);

  it('hub page lists every distinct source among the shown events, each linking to its own homepage', () => {
    const page = renderHubPage({
      locale: 'it',
      canton: 'TI',
      events: mixed as never,
      byComune: byComune as never,
      dateStamp: '2026-06-30',
      weekendDays: new Set(),
      distDir,
    });
    expect(page.html).toContain('https://www.tio.ch/agenda');
    expect(page.html).toContain('https://www.guidle.com');
    expect(page.html).toContain('https://www.myswitzerland.com');
    expect(page.html).toMatch(/rel="nofollow noopener"/);
  });

  it('comune page lists every distinct source among the shown events', () => {
    const page = renderComunePage({
      locale: 'it',
      canton: 'TI',
      comune: 'Lugano',
      events: mixed as never,
      dateStamp: '2026-06-30',
      weekendDays: new Set(),
      distDir,
    });
    expect(page.html).toContain('https://www.tio.ch/agenda');
    expect(page.html).toContain('https://www.guidle.com');
    expect(page.html).toContain('https://www.myswitzerland.com');
  });

  it('digest page lists every distinct source among the shown events', () => {
    const def = DIGESTS.find((d) => d.key === 'weekend')!;
    const page = renderDigestPage({
      def,
      locale: 'it',
      canton: 'TI',
      events: mixed as never,
      dateStamp: '2026-06-30',
      distDir,
    });
    expect(page.html).toContain('https://www.tio.ch/agenda');
    expect(page.html).toContain('https://www.guidle.com');
    expect(page.html).toContain('https://www.myswitzerland.com');
  });

  it('a single-source (TI-only) page still links only that one source, unchanged from before', () => {
    const page = renderComunePage({
      locale: 'it',
      canton: 'TI',
      comune: 'Lugano',
      events: [tioEvent] as never,
      dateStamp: '2026-06-30',
      weekendDays: new Set(),
      distDir,
    });
    expect(page.html).toContain('https://www.tio.ch/agenda');
    expect(page.html).not.toContain('guidle.com');
    expect(page.html).not.toContain('myswitzerland.com');
  });
});

// #3125 Task A: hub/comune pages generalize to any canton, matching TI richness
// (breadcrumbs, JSON-LD ItemList, stats) with the correct per-canton base path.
describe('renderHubPage / renderComunePage generalize to a non-TI canton (#3125 Task A)', () => {
  const distDir = mkdtempSync(path.join(os.tmpdir(), 'events-canton-'));
  const zhEvent = { ...EVENT, id: 'guidle:zh1', canton: 'ZH', comune: 'Zürich', sourceKey: 'guidle', sourceName: 'Guidle' };
  const byComune = new Map([['Zürich', [zhEvent]]]);

  it('hub page uses the per-canton base path and canton-agnostic copy (no literal "Ticino")', () => {
    const page = renderHubPage({
      locale: 'it',
      canton: 'ZH',
      events: [zhEvent] as never,
      byComune: byComune as never,
      dateStamp: '2026-06-30',
      weekendDays: new Set(),
      distDir,
    });
    expect(page.urlPath).toBe('/eventi/zurigo/');
    expect(page.html).toContain('"@type":"ItemList"');
    expect(page.html).toContain('"@type":"BreadcrumbList"');
    expect(page.html).toContain('Zurigo');
    // The COPY-owned strings (lede/header/methodology) must be substituted to
    // the canton, not the literal TI phrase. (The sitewide "Esplora anche"
    // crosslinks block still legitimately points at Ticino-specific site
    // sections like job search — that's a separate, out-of-scope feature, so
    // we don't assert "Ticino" is absent from the WHOLE page, only from the
    // hub's own lede/header text.)
    expect(page.html).toContain('Eventi in Zurigo, comune per comune');
    expect(page.html).not.toMatch(/agenda di Ticino|in tutto il Ticino/);
  });

  it('comune page under the ZH hub uses the canton-scoped path', () => {
    const page = renderComunePage({
      locale: 'it',
      canton: 'ZH',
      comune: 'Zürich',
      events: [zhEvent] as never,
      dateStamp: '2026-06-30',
      weekendDays: new Set(),
      distDir,
    });
    expect(page.urlPath).toBe('/eventi/zurigo/zurich/');
    expect(page.html).toContain('Zürich e nella sua regione');
    expect(page.html).not.toMatch(/del Ticino\b/);
  });

  it('detail page under a ZH comune resolves to the ZH-scoped canonical path', () => {
    const page = renderEventDetailPage({
      locale: 'it',
      event: zhEvent as never,
      comune: 'Zürich',
      eventSlug: slugifyEvent(zhEvent),
      sameComuneEvents: [zhEvent] as never,
      dateStamp: '2026-06-30',
      distDir,
      detailHref: (() => null) as never,
    });
    expect(page.urlPath).toBe(`/eventi/zurigo/zurich/${slugifyEvent(zhEvent)}/`);
    // The event's own lede/about text is canton-substituted ("in Zurigo", not
    // "in Ticino"); the sitewide crosslinks block is intentionally untouched
    // (see comment on the hub-page assertion above).
    expect(page.html).toContain(', in Zurigo.');
    expect(page.html).not.toMatch(/, in Ticino\./);
  });

  it('TI hub/comune pages stay byte-identical to the literal COPY (regression guard)', () => {
    const tiPage = renderComunePage({
      locale: 'it',
      canton: 'TI',
      comune: 'Lugano',
      events: [EVENT] as never,
      dateStamp: '2026-06-30',
      weekendDays: new Set(),
      distDir,
    });
    expect(tiPage.urlPath).toBe('/eventi/ticino/lugano/');
    expect(tiPage.html).toContain('in Ticino');
  });
});
