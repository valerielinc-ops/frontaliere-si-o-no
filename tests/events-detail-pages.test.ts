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
import { slugifyEvent, OTHER_EVENTS_COMUNE_KEY } from '../scripts/lib/events-utils.mjs';
import {
  eventLd,
  pathForEventDetail,
  renderEventDetailPage,
  renderHubPage,
  renderComunePage,
  renderDigestPage,
  renderOtherEventsPage,
  DIGESTS,
  assignEventSlugs,
  reserveLiveSiblingSlugs,
  categoryLabel,
  normalizeCategoryKey,
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

// Issue #3742: myswitzerland ships English schema.org-derived categories
// ("Event", "Music", "Sports", "Theater", "Food", "Exhibition", "Festival")
// and guidle ships free-text German/Italian sub-genres ("Rock generalmente",
// "Teatro: improvisazione", …) — neither matches the IT taxonomy keys, so
// both used to fall through to a raw, wrong-language passthrough. Verified
// live: 667/1084 (61.5%) events landed in the generic bucket, most literally
// showing the English word "Event" on every locale.
describe('normalizeCategoryKey', () => {
  it('is a no-op for an already-valid taxonomy key (tio-agenda categories)', () => {
    for (const key of ['arte', 'musica', 'teatro', 'cinema', 'feste', 'musei', 'conferenze', 'sport', 'appuntamenti', 'sociale', 'altro']) {
      expect(normalizeCategoryKey(key)).toBe(key);
    }
  });

  it('maps every myswitzerland humanizeCategory() output seen live', () => {
    expect(normalizeCategoryKey('Event')).toBe('altro'); // 778/1006 (77%) — the highest-impact case
    expect(normalizeCategoryKey('Music')).toBe('musica');
    expect(normalizeCategoryKey('Sports')).toBe('sport');
    expect(normalizeCategoryKey('Theater')).toBe('teatro');
    expect(normalizeCategoryKey('Food')).toBe('feste');
    expect(normalizeCategoryKey('Exhibition')).toBe('musei');
    expect(normalizeCategoryKey('Festival')).toBe('feste');
  });

  it('maps guidle free-text sub-genres seen live', () => {
    expect(normalizeCategoryKey('Rock generalmente')).toBe('musica');
    expect(normalizeCategoryKey('Pop generalmente')).toBe('musica');
    expect(normalizeCategoryKey('Teatro: improvisazione')).toBe('teatro');
    expect(normalizeCategoryKey('Sperimentale')).toBe('musica');
    expect(normalizeCategoryKey('Ambient / Electronica')).toBe('musica');
    expect(normalizeCategoryKey('Barocco')).toBe('musica');
    expect(normalizeCategoryKey("L'arte in generale")).toBe('arte');
    expect(normalizeCategoryKey('Festival del teatro')).toBe('teatro');
    expect(normalizeCategoryKey('Commedia')).toBe('teatro');
    expect(normalizeCategoryKey('Musical')).toBe('teatro'); // overlaps "music" but must resolve to teatro
    expect(normalizeCategoryKey('Film festival')).toBe('cinema');
    expect(normalizeCategoryKey('Escursionismo')).toBe('sport');
  });

  it('leaves genuinely ambiguous long-tail categories unmapped (caller falls back to raw passthrough)', () => {
    expect(normalizeCategoryKey('Contemplazione / Meditazione')).toBeUndefined();
    expect(normalizeCategoryKey('Danza libera')).toBeUndefined();
    expect(normalizeCategoryKey('Assistanza nella vita quotidiana')).toBeUndefined();
  });

  it('returns undefined for missing/blank input', () => {
    expect(normalizeCategoryKey(undefined)).toBeUndefined();
    expect(normalizeCategoryKey('')).toBeUndefined();
    expect(normalizeCategoryKey('   ')).toBeUndefined();
  });
});

describe('categoryLabel', () => {
  it('renders the correct per-locale label for a normalized myswitzerland/guidle category', () => {
    expect(categoryLabel('Event', 'it')).toBe('Eventi');
    expect(categoryLabel('Event', 'en')).toBe('Events');
    expect(categoryLabel('Music', 'it')).toBe('Musica');
    expect(categoryLabel('Music', 'de')).toBe('Musik');
    expect(categoryLabel('Rock generalmente', 'fr')).toBe('Musique');
    expect(categoryLabel('Teatro: improvisazione', 'en')).toBe('Theatre');
  });

  it('still title-cases a genuinely unmapped raw category (unchanged pre-existing fallback)', () => {
    expect(categoryLabel('Contemplazione / Meditazione', 'it')).toBe('Contemplazione / Meditazione');
  });

  it('falls back to the "altro" label for missing/blank category, in every locale', () => {
    expect(categoryLabel(undefined, 'it')).toBe('Eventi');
    expect(categoryLabel(undefined, 'en')).toBe('Events');
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
      url: 'https://frontaliereticino.ch/',
    });
    expect(ld.image.copyrightNotice).toBeTruthy();
  });

  it('falls back to the per-category catalog image (F4) when the event has no image', () => {
    // F4 (#3646): no direct photo → real, site-owned, category-scoped
    // catalog image (width/height/alt-ready ImageObject), not the generic
    // site OG placeholder.
    const withoutImage = eventLd(EVENT as never, 'it') as Record<string, any>;
    expect(withoutImage.image).toMatchObject({
      '@type': 'ImageObject',
      contentUrl: 'https://frontaliereticino.ch/images/events/catalog/musica.svg',
      url: 'https://frontaliereticino.ch/images/events/catalog/musica.svg',
      width: 1200,
      height: 675,
    });
  });

  it('never hotlinks a raw non-mirrored third-party image URL — degrades to the catalog image instead', () => {
    // Defense-in-depth: every crawler is contracted to only ever store a
    // mirrored `/images/events/...` path (or leave imageUrl unset), but a
    // stale pre-mirroring dataset snapshot could still carry a raw URL. That
    // must NEVER be embedded (hotlinked) into production JSON-LD.
    const hotlinked = { ...EVENT, imageUrl: 'https://biglietteria.ch/files/flyer.jpg' };
    const ld = eventLd(hotlinked as never, 'it') as Record<string, any>;
    expect(ld.image).toMatchObject({
      '@type': 'ImageObject',
      contentUrl: 'https://frontaliereticino.ch/images/events/catalog/musica.svg',
    });
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

  it('truncates an overlong crawled event title (word-aware) so <title> stays within the 66-char SERP cap, keeping the comune suffix (audit:title-length regression: eventi 707>340 offenders)', () => {
    const longTitle =
      'Concerto sinfonico straordinario di beneficenza con orchestra e coro per la giornata mondiale della musica al LAC';
    const longEvent = { ...EVENT, id: 'tio-agenda:99', title: longTitle };
    const longPage = renderEventDetailPage({
      locale: 'it',
      event: longEvent as never,
      comune: 'Lugano',
      eventSlug: slugifyEvent(longEvent),
      sameComuneEvents: [longEvent] as never,
      dateStamp: '2026-06-30',
      distDir,
      detailHref: (() => null) as never,
    });
    const titleTag = /<title>([^<]*)<\/title>/.exec(longPage.html)?.[1] ?? '';
    expect(titleTag.length).toBeLessThanOrEqual(66);
    expect(titleTag).toContain('…');
    expect(titleTag).toContain('Lugano (Ticino) | Eventi');
    // Never a naive hard cut mid-word or a dangling separator before the ellipsis.
    expect(titleTag).not.toMatch(/[\s—–\-·|,;:&(]…/);
  });

  it('budgets/truncates the crawled title on the ESCAPED length so an `&`/`<`/`>`/`"` in the title cannot push <title> past the 66-char cap post-escape (#3589 item 1: audit:title-length false-green)', () => {
    // 39 raw chars (fits the pre-fix raw-length budget untruncated) + the
    // 27-char it-locale "Lugano" suffix = 66 raw chars — but the one `&`
    // expands to `&amp;` on escape, which is what both `htmlTemplate.ts`
    // (`<title>${esc(title)}</title>`) and `audit-title-length.mjs` (raw
    // HTML source) actually measure. Pre-fix this produced a 70-char
    // escaped <title>, re-tripping the very gate PR #3581 fixed.
    const ampTitle = 'Rock & Blues Night Festival Estivo 2026';
    expect(ampTitle.length).toBe(39);
    const ampEvent = { ...EVENT, id: 'tio-agenda:100', title: ampTitle };
    const ampPage = renderEventDetailPage({
      locale: 'it',
      event: ampEvent as never,
      comune: 'Lugano',
      eventSlug: slugifyEvent(ampEvent),
      sameComuneEvents: [ampEvent] as never,
      dateStamp: '2026-06-30',
      distDir,
      detailHref: (() => null) as never,
    });
    const titleTag = /<title>([^<]*)<\/title>/.exec(ampPage.html)?.[1] ?? '';
    expect(titleTag.length).toBeLessThanOrEqual(66);
    expect(titleTag).toContain('Lugano (Ticino) | Eventi');
    expect(titleTag).not.toMatch(/[\s—–\-·|,;:&(]…/);
  });

  it('clamps the truncation budget to a positive floor so a comune suffix long enough to overflow the cap alone cannot make the headline collapse to an empty/blank <title> (#3589 item 2, contract updated by #3799)', () => {
    // Synthetic long comune name pushes the FULL suffix well past
    // TITLE_MAX_CHARS on its own. Pre-#3799 the oversized suffix was kept
    // verbatim (title clamped to a bounded "…" but the total silently blew
    // the cap); now the suffix cascade drops the region/brand boilerplate,
    // keeps the comune (the never-dropped local-SEO token) and the cap
    // ALWAYS holds.
    const longComune = 'Castel San Pietro Sopra La Montagna Bellissima Ticinese';
    const longComunePage = renderEventDetailPage({
      locale: 'it',
      event: EVENT as never,
      comune: longComune,
      eventSlug: slugifyEvent(EVENT),
      sameComuneEvents: [EVENT] as never,
      dateStamp: '2026-06-30',
      distDir,
      detailHref: (() => null) as never,
    });
    const titleTag = /<title>([^<]*)<\/title>/.exec(longComunePage.html)?.[1] ?? '';
    expect(titleTag.length).toBeGreaterThan(0);
    expect(titleTag.length).toBeLessThanOrEqual(66);
    expect(titleTag).toContain('…');
    expect(titleTag).not.toContain(EVENT.title);
    // Comune preserved; region/brand boilerplate sacrificed under pressure.
    expect(titleTag).toContain(`— ${longComune}`);
    expect(titleTag).not.toContain('(Ticino)');
  });

  it('keeps <title> within the 66-char cap on the degenerate comune-less "other events" bucket, where the comune IS the canton display label (#3799: fr/AI+AR suffix alone was 75 chars, 9 past the cap)', () => {
    // `renderEventDetailPage` maps `comune === OTHER_EVENTS_COMUNE_KEY` to
    // `displayComune = cantonDisplayLabel(canton, locale)`, so the suffix
    // doubles the canton name: ` — Appenzell Rhodes-Extérieures (Appenzell
    // Rhodes-Extérieures) | Événements`. Pre-#3799 the budget clamped to 1
    // and the emitted <title> was `'…' + suffix` — up to 76 chars. The
    // suffix cascade must degrade (drop the region parenthetical) instead.
    for (const [locale, canton] of [['fr', 'AI'], ['fr', 'AR'], ['de', 'AR'], ['de', 'AI']] as const) {
      const bucketEvent = { ...EVENT, id: `guidle:${canton}-${locale}`, canton, comune: undefined };
      const page = renderEventDetailPage({
        locale,
        event: bucketEvent as never,
        comune: OTHER_EVENTS_COMUNE_KEY,
        eventSlug: slugifyEvent(bucketEvent),
        sameComuneEvents: [bucketEvent] as never,
        dateStamp: '2026-06-30',
        distDir,
        detailHref: (() => null) as never,
      });
      const titleTag = /<title>([^<]*)<\/title>/.exec(page.html)?.[1] ?? '';
      expect(titleTag.length).toBeGreaterThan(0);
      expect(titleTag.length).toBeLessThanOrEqual(66);
      // The place label (canton display name) is the local-SEO token and
      // must survive the degradation.
      expect(titleTag).toContain('Appenzell');
    }
  });

  it('degrades the suffix instead of the event title when the full suffix leaves a near-zero budget, so the title never collapses to a bare "…" stub (#3799 minimum-budget guard)', () => {
    // fr/AI + "Schlatt-Haslen" leaves only 5 chars for the event title under
    // the full suffix (worst real-gazetteer case) — pre-#3799 the <title>
    // opened with a meaningless 5-char stub. With the min-budget guard the
    // region parenthetical is dropped and a meaningful fragment (≥ 12 chars)
    // of the event title survives.
    const aiEvent = { ...EVENT, id: 'guidle:ai-schlatt', canton: 'AI', comune: 'Schlatt-Haslen' };
    const page = renderEventDetailPage({
      locale: 'fr',
      event: aiEvent as never,
      comune: 'Schlatt-Haslen',
      eventSlug: slugifyEvent(aiEvent),
      sameComuneEvents: [aiEvent] as never,
      dateStamp: '2026-06-30',
      distDir,
      detailHref: (() => null) as never,
    });
    const titleTag = /<title>([^<]*)<\/title>/.exec(page.html)?.[1] ?? '';
    expect(titleTag.length).toBeLessThanOrEqual(66);
    expect(titleTag).toContain(EVENT.title); // 25 chars — fits once the region is dropped
    expect(titleTag).toContain('— Schlatt-Haslen');
  });

  it('keeps <title> within the 66-char cap for a non-TI canton with a long display name (regression: issue #3772 recurrence — validate-dist still failing on `eventi` after PR #3786)', () => {
    // The old `detailCopyFor.metaTitle` substituted the real canton name
    // into the string `eventDetailMetaTitle` had ALREADY budgeted/truncated
    // assuming the short "Ticino"/"Tessin" placeholder — with no re-check.
    // fr/AR ("Appenzell Rhodes-Extérieures", 28 chars vs "Tessin"'s 6) is
    // the worst observed case, pushing the pre-fix <title> ~20 chars over
    // budget for every event in that canton, nationwide.
    const arEvent = { ...EVENT, id: 'guidle:ar1', canton: 'AR', comune: 'Herisau' };
    const page = renderEventDetailPage({
      locale: 'fr',
      event: arEvent as never,
      comune: 'Herisau',
      eventSlug: slugifyEvent(arEvent),
      sameComuneEvents: [arEvent] as never,
      dateStamp: '2026-06-30',
      distDir,
      detailHref: (() => null) as never,
    });
    const titleTag = /<title>([^<]*)<\/title>/.exec(page.html)?.[1] ?? '';
    expect(titleTag.length).toBeGreaterThan(0);
    expect(titleTag.length).toBeLessThanOrEqual(66);
    expect(titleTag).toContain('Appenzell Rhodes-Extérieures');
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

  it('renders a plain OpenStreetMap link (no Google Maps, no tracker script), accessible', () => {
    // esc() HTML-escapes the "&" in the href attribute (&amp;).
    expect(page.html).toContain('openstreetmap.org/?mlat=46.005&amp;mlon=8.951');
    expect(page.html).toContain('rel="nofollow noopener"');
    expect(page.html).not.toMatch(/google\.com\/maps/i);
    // Accessible name on the map link (not just an icon).
    expect(page.html).toMatch(/aria-label="Apri [^"]+ su OpenStreetMap"/);
  });

  it('embeds a plain OpenStreetMap iframe when the event has coordinates (no API key, no Google Maps)', () => {
    expect(page.html).toMatch(/<iframe[^>]+src="[^"]*openstreetmap\.org\/export\/embed\.html[^"]*"/);
    expect(page.html).not.toMatch(/google\.com\/maps/i);
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
    // No coordinates on the baseline event → no fabricated map embed.
    expect(baselinePage.html).not.toMatch(/<iframe/i);
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

  it('hub-page <title> stays within the 66-char cap for a long-name canton in every locale (regression: issue #3772 recurrence — validate-dist still failing on `eventi` after PR #3786)', () => {
    // AR ("Appenzell Rhodes-Extérieures" in fr, 28 chars) is the worst case
    // vs. the short "Ticino"/"Tessin" (6 chars) the old code budgeted for.
    const arEvent = { ...EVENT, id: 'guidle:ar-hub', canton: 'AR', comune: 'Herisau' };
    const arByComune = new Map([['Herisau', [arEvent]]]);
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const page = renderHubPage({
        locale,
        canton: 'AR',
        events: [arEvent] as never,
        byComune: arByComune as never,
        dateStamp: '2026-06-30',
        weekendDays: new Set(),
        distDir,
      });
      const titleTag = /<title>([^<]*)<\/title>/.exec(page.html)?.[1] ?? '';
      expect(titleTag.length).toBeGreaterThan(0);
      expect(titleTag.length).toBeLessThanOrEqual(66);
    }
  });
});

describe('digest-page <title> budget for a long-name canton (regression: issue #3772 recurrence)', () => {
  const distDir = mkdtempSync(path.join(os.tmpdir(), 'events-digest-title-'));
  // Saturday 2026-07-04 falls inside both the weekend window and the
  // this-week window when todayIso is 2026-07-01 (Wednesday).
  const arEvent = { ...EVENT, id: 'guidle:ar-digest', canton: 'AR', comune: 'Herisau', startDate: '2026-07-04' };
  const weekendDef = DIGESTS.find((d) => d.key === 'weekend')!;
  const weekDef = DIGESTS.find((d) => d.key === 'week')!;

  it('keeps both the weekend and this-week digest <title> within the 66-char cap, distinct from each other, for every locale', () => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const weekendPage = renderDigestPage({
        def: weekendDef,
        locale,
        canton: 'AR',
        events: [arEvent] as never,
        dateStamp: '2026-07-01',
        distDir,
      });
      const weekPage = renderDigestPage({
        def: weekDef,
        locale,
        canton: 'AR',
        events: [arEvent] as never,
        dateStamp: '2026-07-01',
        distDir,
      });
      const weekendTitle = /<title>([^<]*)<\/title>/.exec(weekendPage.html)?.[1] ?? '';
      const weekTitle = /<title>([^<]*)<\/title>/.exec(weekPage.html)?.[1] ?? '';
      expect(weekendTitle.length).toBeGreaterThan(0);
      expect(weekendTitle.length).toBeLessThanOrEqual(66);
      expect(weekTitle.length).toBeGreaterThan(0);
      expect(weekTitle.length).toBeLessThanOrEqual(66);
      expect(weekendTitle).not.toBe(weekTitle);
    }
  });
});

// #3141 item 2: the tio-agenda MVP source never crawls a real per-event
// description, so the "about" paragraph is templated boilerplate shared by
// every event in the same comune+category — a near-duplicate/thin-content
// risk that grows with event volume per comune. `venue` is present on ~98%
// of live events and highly distinct even within one comune, so folding it
// into the sentence gives each page a real, data-backed differentiator.
describe('renderEventDetailPage about-paragraph venue differentiation (#3141 item 2)', () => {
  const distDir = mkdtempSync(path.join(os.tmpdir(), 'events-detail-venue-'));

  it('includes the venue in the about paragraph when present', () => {
    const page = renderEventDetailPage({
      locale: 'it',
      event: EVENT as never,
      comune: 'Lugano',
      eventSlug: slugifyEvent(EVENT),
      sameComuneEvents: [EVENT] as never,
      dateStamp: '2026-06-30',
      distDir,
      detailHref: (() => null) as never,
    });
    expect(page.html).toContain('è un evento di tipo');
    expect(page.html).toContain('LAC Lugano Arte e Cultura');
  });

  it('produces a different about paragraph for two otherwise-identical events at different venues (collision case)', () => {
    const eventA = { ...EVENT, id: 'tio-agenda:100', venue: 'Teatro Cittadella' };
    const eventB = { ...EVENT, id: 'tio-agenda:200', venue: 'Piazza Riforma' };
    const pageA = renderEventDetailPage({
      locale: 'it',
      event: eventA as never,
      comune: 'Lugano',
      eventSlug: slugifyEvent(eventA),
      sameComuneEvents: [eventA] as never,
      dateStamp: '2026-06-30',
      distDir,
      detailHref: (() => null) as never,
    });
    const pageB = renderEventDetailPage({
      locale: 'it',
      event: eventB as never,
      comune: 'Lugano',
      eventSlug: slugifyEvent(eventB),
      sameComuneEvents: [eventB] as never,
      dateStamp: '2026-06-30',
      distDir,
      detailHref: (() => null) as never,
    });
    expect(pageA.html).toContain('Teatro Cittadella');
    expect(pageB.html).toContain('Piazza Riforma');
    expect(pageA.html).not.toContain('Piazza Riforma');
    expect(pageB.html).not.toContain('Teatro Cittadella');
  });

  it('falls back gracefully (no dangling separator) when venue is missing', () => {
    const noVenueEvent = { ...EVENT, venue: undefined };
    const page = renderEventDetailPage({
      locale: 'it',
      event: noVenueEvent as never,
      comune: 'Lugano',
      eventSlug: slugifyEvent(noVenueEvent),
      sameComuneEvents: [noVenueEvent] as never,
      dateStamp: '2026-06-30',
      distDir,
      detailHref: (() => null) as never,
    });
    expect(page.html).toContain('a Lugano, in Ticino');
    expect(page.html).not.toContain('a Lugano – ');
    expect(page.wordCount).toBeGreaterThanOrEqual(MIN_INDEXABLE_WORDS);
  });
});

// #3508: aggregate ItemList markup quality — no expired events marked
// EventScheduled, no fabricated Ticino address on canton-less nationwide
// events. All dates are anchored to the injected dateStamp (deterministic,
// no wall-clock dependency).
describe('events schema data quality (#3508)', () => {
  const distDir = mkdtempSync(path.join(os.tmpdir(), 'events-3508-'));

  it('eventLd uses the real crawled venue for canton-less events instead of stamping Ticino/TI', () => {
    const glarus = {
      ...EVENT,
      id: 'myswitzerland:9',
      canton: '',
      comune: null,
      region: null,
      venue: 'Niederurnen',
      sourceKey: 'myswitzerland',
      sourceName: 'MySwitzerland',
      geo: { lat: 47.125875, lng: 9.058327 },
    };
    const ld = eventLd(glarus as never, 'it') as {
      location: { address: Record<string, unknown> };
      description: string;
    };
    expect(ld.location.address.addressLocality).toBe('Niederurnen');
    expect(ld.location.address.addressRegion).toBeUndefined();
    // Validator contract: description stays >= 30 chars without a canton name.
    expect(String(ld.description).trim().length).toBeGreaterThanOrEqual(30);
  });

  it('eventLd keeps comune + canton for canton-resolved events', () => {
    const ld = eventLd(EVENT as never, 'it') as { location: { address: Record<string, unknown> } };
    expect(ld.location.address.addressLocality).toBe('Lugano');
    expect(ld.location.address.addressRegion).toBe('TI');
  });

  it('hub ItemList markup excludes events whose startDate is already past, page HTML keeps them', () => {
    const dateStamp = '2026-06-30';
    const stale = { ...EVENT, id: 'myswitzerland:10', title: 'Chilbi Vecchia', startDate: '2025-09-06', endDate: '2026-09-06' };
    const fresh = { ...EVENT, id: 'tio-agenda:11', title: 'Concerto Futuro', startDate: '2026-07-02', endDate: '2026-07-02' };
    const events = [stale, fresh];
    const page = renderHubPage({
      locale: 'it',
      canton: 'TI',
      events: events as never,
      byComune: new Map([['Lugano', events]]) as never,
      dateStamp,
      weekendDays: new Set<string>(),
      distDir,
    });
    const itemLists = [...page.html.matchAll(/<script type="application\/ld\+json">(\{"@context":"https:\/\/schema\.org","@type":"ItemList".*?\})<\/script>/g)];
    expect(itemLists.length).toBeGreaterThan(0);
    const parsed = JSON.parse(itemLists[0][1]) as { itemListElement: Array<{ item: { name: string } }> };
    const names = parsed.itemListElement.map((li) => li.item.name);
    expect(names).toContain('Concerto Futuro');
    expect(names).not.toContain('Chilbi Vecchia');
    // Markup-only filter: the stale event must still be visible in the HTML list.
    expect(page.html).toContain('Chilbi Vecchia');
  });
});

describe('assignEventSlugs (issue #3700 — past-bridge slug collision)', () => {
  it('assigns the bare slugifyEvent() base when there is no collision', () => {
    const list = [{ ...EVENT, id: 'a', title: 'Sagra', startDate: '2026-08-01' }];
    const slugs = assignEventSlugs(list as never);
    expect(slugs.get('a')).toBe('sagra-2026-08-01');
  });

  it('same title+date collision within the list gets a stable -2 suffix, id order breaks the tie', () => {
    const evA = { ...EVENT, id: 'tio-agenda:100', title: 'Sagra', startDate: '2026-08-01' };
    const evB = { ...EVENT, id: 'tio-agenda:200', title: 'Sagra', startDate: '2026-08-01' };
    // Feed both orders — callers (upcomingEvents/recentlyEndedEvents) already
    // sort ties on id, so assignEventSlugs itself must not depend on the
    // caller's insertion order beyond what it's given; here we assert the
    // *given* order determines the suffix (matches how the caller's
    // pre-sorted list drives it).
    const forward = assignEventSlugs([evA, evB] as never);
    expect(forward.get('tio-agenda:100')).toBe('sagra-2026-08-01');
    expect(forward.get('tio-agenda:200')).toBe('sagra-2026-08-01-2');
  });

  it('reservedBaseSlugs forces the decorated suffix even with zero in-list collisions (the actual #3700 gap)', () => {
    // The past-bridge loop calls assignEventSlugs(pastList, reservedBaseSlugs)
    // where reservedBaseSlugs is seeded from the STILL-LIVE siblings in the
    // same comune. A still-live multi-day event (later endDate, so it never
    // entered the past list at all) must not have its bare/indexed slug
    // silently reused by a same-title+date event that just became past.
    const pastEvent = { ...EVENT, id: 'tio-agenda:300', title: 'Mercatino di Natale', startDate: '2026-12-01' };
    const liveSiblingBase = 'mercatino-di-natale-2026-12-01'; // slugifyEvent() of the still-live sibling
    const slugs = assignEventSlugs([pastEvent] as never, new Set([liveSiblingBase]));
    expect(slugs.get('tio-agenda:300')).not.toBe(liveSiblingBase);
    expect(slugs.get('tio-agenda:300')).toBe('mercatino-di-natale-2026-12-01-2');
  });

  it('reservedBaseSlugs does not affect events whose base slug does not collide', () => {
    const pastEvent = { ...EVENT, id: 'tio-agenda:400', title: 'Concerto', startDate: '2026-05-01' };
    const slugs = assignEventSlugs([pastEvent] as never, new Set(['some-other-event-2026-01-01']));
    expect(slugs.get('tio-agenda:400')).toBe('concerto-2026-05-01');
  });
});

describe('reserveLiveSiblingSlugs (issue #3715 — reviewer-found collision)', () => {
  it('reserves the ACTUAL assigned slug for each live sibling, not the collapsed raw base', () => {
    // Two still-live events sharing title+date in the same comune: assignEventSlugs
    // gives them 'base' and 'base-2'. Reserving raw slugifyEvent() bases would
    // collapse both to the same 'base' string, leaving the second sibling's real
    // URL ('base-2') completely unprotected against a same-title+date past-bridge
    // page landing on it.
    const liveA = { ...EVENT, id: 'tio-agenda:500', title: 'Mercato di Natale', startDate: '2026-12-05' };
    const liveB = { ...EVENT, id: 'tio-agenda:600', title: 'Mercato di Natale', startDate: '2026-12-05' };
    const slugs = assignEventSlugs([liveA, liveB] as never);
    expect(slugs.get('tio-agenda:500')).toBe('mercato-di-natale-2026-12-05');
    expect(slugs.get('tio-agenda:600')).toBe('mercato-di-natale-2026-12-05-2');

    // `reserveLiveSiblingSlugs` reads from the real `detailSlugs` shape
    // (Map<string, { canton, comune, slug }>), not the bare slug-string map
    // `assignEventSlugs` returns.
    const detailSlugs = new Map(
      [liveA, liveB].map((ev) => [ev.id, { canton: 'TI', comune: 'Lugano', slug: slugs.get(ev.id)! }]),
    );
    const reserved = reserveLiveSiblingSlugs([liveA, liveB] as never, detailSlugs);
    expect(reserved.has('mercato-di-natale-2026-12-05')).toBe(true);
    expect(reserved.has('mercato-di-natale-2026-12-05-2')).toBe(true);
    expect(reserved.size).toBe(2);
  });

  it('a past-bridge event colliding with the SECOND live sibling still gets pushed to a free slug', () => {
    const liveA = { ...EVENT, id: 'tio-agenda:500', title: 'Mercato di Natale', startDate: '2026-12-05' };
    const liveB = { ...EVENT, id: 'tio-agenda:600', title: 'Mercato di Natale', startDate: '2026-12-05' };
    const slugs = assignEventSlugs([liveA, liveB] as never);
    const detailSlugs = new Map(
      [liveA, liveB].map((ev) => [ev.id, { canton: 'TI', comune: 'Lugano', slug: slugs.get(ev.id)! }]),
    );
    const reserved = reserveLiveSiblingSlugs([liveA, liveB] as never, detailSlugs);

    const pastEvent = { ...EVENT, id: 'tio-agenda:700', title: 'Mercato di Natale', startDate: '2026-12-05' };
    const pastSlugs = assignEventSlugs([pastEvent] as never, reserved);
    // Must land on a third slug — neither live sibling's real URL is reused.
    expect(pastSlugs.get('tio-agenda:700')).toBe('mercato-di-natale-2026-12-05-3');
  });
});

describe('other-events-page <title> budget for a long-name canton (regression: issue #3772 recurrence)', () => {
  it('keeps <title> within the 66-char cap for a long-name canton in every locale', () => {
    const distDir = mkdtempSync(path.join(os.tmpdir(), 'events-other-title-'));
    // de/AR ("Appenzell Ausserrhoden") was the confirmed overflow instance
    // (67 chars) for otherEventsCopyFor.metaTitle before this fix.
    const arEvent = { ...EVENT, id: 'guidle:ar-other', canton: 'AR', comune: 'Herisau' };
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const page = renderOtherEventsPage({
        locale,
        canton: 'AR',
        events: [arEvent] as never,
        dateStamp: '2026-06-30',
        weekendDays: new Set(),
        distDir,
      });
      const titleTag = /<title>([^<]*)<\/title>/.exec(page.html)?.[1] ?? '';
      expect(titleTag.length).toBeGreaterThan(0);
      expect(titleTag.length).toBeLessThanOrEqual(66);
    }
  });
});
