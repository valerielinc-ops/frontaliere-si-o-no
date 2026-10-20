// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { retainPublishedPastEvents } from '../scripts/assemble-events-dataset.mjs';
import { publishedEventRoutes } from '../scripts/lib/events-retention.mjs';
import {
  historicalEventSlugMigrations,
  pathForEventDetail,
  renderEventDetailPage,
  renderEventSlugRedirectPage,
} from '../build-plugins/eventsSeoPagesPlugin';
import { MIN_INDEXABLE_WORDS } from '../build-plugins/constants';
import { readAttr, readTagByAttr } from '../scripts/lib/html-attr.mjs';

type Event = Parameters<typeof renderEventDetailPage>[0]['event'];
const seed = JSON.parse(readFileSync(new URL('../data/events-recovery-archive.json', import.meta.url), 'utf8')) as { events: Event[] };
const fixture = JSON.parse(readFileSync(new URL('./fixtures/gsc-event-archive-routes.json', import.meta.url), 'utf8')) as {
  routes: [string, string][];
  freshExport: { routes: { path: string; id: string; commit: string; evidenceKind: string }[] };
};
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
  it('keeps the additional export routes attributable to exact pinned source observations', () => {
    expect(fixture.freshExport.routes).toHaveLength(309);
    const snapshots = JSON.parse(readFileSync(new URL('../data/events-recovery-archive.json', import.meta.url), 'utf8')).sourceSnapshots as { commit: string }[];
    const commits = new Set(snapshots.map(snapshot => snapshot.commit));
    for (const row of fixture.freshExport.routes) {
      expect(commits.has(row.commit), row.path).toBe(true);
      expect(['assigned-canonical', 'recorded-previous-route', 'native-legacy-slug', 'unique-source-slug-and-observed-legacy-ti-route', 'unique-assigned-canonical-owner', 'primary-occurrence-attestation']).toContain(row.evidenceKind);
      expect(fixture.routes, row.path).toContainEqual([row.path, row.id]);
    }
  });

  it('keeps every attested reported route attached to its exact public identity', () => {
    expect(fixture.routes).toHaveLength(683);
    expect(new Set(fixture.routes.map(([path]) => path)).size).toBe(fixture.routes.length);
    for (const [path, id] of fixture.routes) {
      const canonical = canonicalOwners.get(path);
      const owners = canonical ? new Set([canonical]) : historyOwners.get(path);
      expect([...(owners || [])], path).toEqual([id]);
    }
  });

  it('retains observed legacy TI aliases without relabelling non-TI or unknown source locations', () => {
    const legacy = fixture.freshExport.routes.filter(row => row.evidenceKind === 'unique-source-slug-and-observed-legacy-ti-route');
    expect(legacy).toHaveLength(11);
    for (const row of legacy) {
      const event = seed.events.find(event => event.id === row.id)!;
      expect(event, row.path).toBeDefined();
      expect(event.canton, row.path).not.toBe('TI');
      expect(event.previousRoutes, row.path).toContainEqual({
        canton: 'TI', comune: '__other-events__', slug: row.path.split('/').at(-2),
      });
    }
  });

  it('keeps one attested occurrence owner and does not revive superseded MySwitzerland identities', () => {
    const raw = JSON.parse(readFileSync(new URL('../data/events-recovery-archive.json', import.meta.url), 'utf8'));
    for (const [id, oldId, primaryUrl] of [
      ['guidle:AxJ2Y1d', 'myswitzerland:f39881dc7f2849e39da0a5effee2af01', 'https://www.lucernefestival.ch/de/programm/jorg-widmann-frank-reinecke-experimentalstudio-des-swr-freiburg/2384'],
      ['guidle:Aj2gf4s', 'myswitzerland:bbbf681277584a969da6f3dc8f47987c', 'https://www.terpsycordes.com/fr/agenda'],
      ['ge-agenda:retsina-cola', 'myswitzerland:401b21e3213b4d3d8882aa3cfab263af', 'https://fetedelolivier.ch/retsina-cola-rebetiko/'],
      ['guidle:AkdAR6x', 'myswitzerland:c21ab62f74dd4a2fbd60a8b7bb23c428', 'https://www.guidle.com/it/evenements/musique/villeneuve-vd/jeremie-kisling_AkdAR6x'],
    ]) {
      const record = raw.events.find((event: { id: string }) => event.id === id);
      expect(record, id).toBeDefined();
      expect(record.recoveryEvidence.primaryUrl, id).toBe(primaryUrl);
      expect(raw.events.some((event: { id: string }) => event.id === oldId), oldId).toBe(false);
    }
  });

  it('keeps both attested Panta rhei aliases on one resolved public identity', () => {
    // The museum's programme confirms one lecture on 1 October at 18:00.
    // Both source records claimed the long unknown-canton route; retaining
    // the superseded MySwitzerland seed lets the last writer win that alias.
    const id = 'guidle:AXBsQCr';
    expect(archived.some(event => event.id === 'myswitzerland:f6875e27b20f47b9936e873108d45281')).toBe(false);
    expect(archived.find(event => event.id === id)).toMatchObject({
      canton: 'LU', venue: 'Hans Erni Museum',
      startDate: '2026-10-01', endDate: '2026-10-01', startTime: '18:00',
    });
    const route = assigned.get(id)!;
    expect(pathForEventDetail('de', route.comune, route.slug, route.canton)).toBe(
      '/de/veranstaltungen/luzern/weitere-veranstaltungen/bedrohung-durch-drohnen-und-hybride-kriegsfuhrung-2026-10-01/',
    );
    for (const locale of locales) for (const slug of [
      'bedrohung-durch-drohnen-und-hybride-kriegsfuhrung-panta-rhei-2026-10-01',
      'bedrohung-durch-drohnen-und-hybride-kriegsfuhrung-2026-10-01',
    ]) {
      const alias = pathForEventDetail(locale, '__other-events__', slug, '__UNRESOLVED-CANTON__');
      expect(canonicalOwners.has(alias), alias).toBe(false);
      expect([...(historyOwners.get(alias) || [])], alias).toEqual([id]);
    }
  });

  it('corrects the Geneva cycling-tour date and bridges the reported 2027 URL', () => {
    const id = 'ge-agenda:tournee-estivale-communes-samedis-velo-11-juillet';
    const event = archived.find(candidate => candidate.id === id)!;
    expect(event).toMatchObject({
      title: 'Tournée estivale des Communes - Samedis du Vélo 11 juillet',
      startDate: '2026-07-04', endDate: '2026-07-11',
      venue: 'Place de Pont Rouge sous le gigantesque totem à horloge rouge',
      url: 'https://www.pro-velo-geneve.ch/tourn_e_samedi_du_v_lo_lancy_en_juillet',
      canton: 'GE', comune: 'Lancy',
    });

    const route = assigned.get(id)!;
    const canonicalPath = pathForEventDetail('fr', route.comune, route.slug, route.canton);
    const reportedPath = '/fr/evenements/geneve/geneve/tournee-estivale-des-communes-samedis-du-velo-11-juillet-2027-07-04/';
    expect(canonicalPath).toBe('/fr/evenements/geneve/lancy/tournee-estivale-des-communes-samedis-du-velo-11-2026-07-04/');
    expect([...(historyOwners.get(reportedPath) || [])]).toEqual([id]);

    const [migration] = historicalEventSlugMigrations([event] as never, 'GE', 'Lancy', new Map([[id, route.slug]]));
    expect(migration).toMatchObject({
      eventId: id,
      fromSlug: 'tournee-estivale-des-communes-samedis-du-velo-11-juillet-2027-07-04',
      comune: 'Lancy',
      toSlug: route.slug,
      fromCanton: 'GE', fromComune: 'Genève',
    });
    const bridge = renderEventSlugRedirectPage('fr', canonicalPath, event);
    expect(bridge).toContain(`<link rel="canonical" href="https://frontaliereticino.ch${canonicalPath}">`);
    expect(bridge).toContain(`http-equiv="refresh" content="0; url=https://frontaliereticino.ch${canonicalPath}"`);
    expect(bridge).toContain(event.title);
    expect(bridge).not.toContain('noindex');
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
