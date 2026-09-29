import { describe, expect, it } from 'vitest';
import {
  classifyCantonDiscovery,
  classifyDiscovery,
  discoverSources,
  resolveDiscoveryUrl,
} from '../scripts/plate-auctions/discover-sources.mjs';

describe('plate-auction source discovery', () => {
  it('does not equate a reachable vehicle-office page with an auction feed', () => {
    const result = classifyDiscovery({ status: 200, title: 'Strassenverkehrsamt', body: 'Kontrollschilder bestellen' });
    expect(result.reachable).toBe(true);
    expect(result.recommendation).toBe('candidate-office-page-only');
  });

  it('flags an official page containing auction vocabulary for manual confirmation', () => {
    const result = classifyDiscovery({ status: 200, title: 'Auktion Kontrollschilder', body: 'Aktuelle Angebote' });
    expect(result.auctionSignal).toBe(true);
    expect(result.recommendation).toBe('manual-confirmation-needed');
  });

  it('keeps failed URLs out of activation decisions', () => {
    const result = classifyDiscovery({ status: 503, title: 'Unavailable', body: '' });
    expect(result.reachable).toBe(false);
    expect(result.recommendation).toBe('blocked-or-invalid-url');
  });

  it('requires a current official list before GE can be activated', () => {
    const pageWithoutList = classifyCantonDiscovery({
      key: 'ge',
      status: 200,
      title: 'Vente aux enchères de plaques',
      body: 'Prochaine vente : automne 2026',
    });
    expect(pageWithoutList.officialListSignal).toBe(false);
    expect(pageWithoutList.recommendation).toBe('blocked-until-official-list');

    const pageWithList = classifyCantonDiscovery({
      key: 'ge',
      status: 200,
      title: 'Vente aux enchères de plaques',
      body: '<a href="/node/22794">Liste des numéros proposés à la vente</a>',
    });
    expect(pageWithList.officialListSignal).toBe(true);
    expect(pageWithList.recommendation).toBe('ready-for-connector-check');
  });

  it('keeps ZG non-public while the canton says auctions are suspended', () => {
    const suspended = classifyCantonDiscovery({
      key: 'zg',
      status: 200,
      title: 'Kontrollschilder',
      body: 'Bis auf Weiteres finden keine Auktionen statt.',
    });
    expect(suspended.suspended).toBe(true);
    expect(suspended.recommendation).toBe('no-public-auction');

    const reopened = classifyCantonDiscovery({
      key: 'zg',
      status: 200,
      title: 'Auktion Kontrollschilder',
      body: 'Die nächste Auktion findet im Herbst statt.',
    });
    expect(reopened.suspended).toBe(false);
    expect(reopened.recommendation).toBe('manual-confirmation-needed');
  });

  it('uses official canton alternatives and never probes Ricardo', async () => {
    const requested: string[] = [];
    const results = await discoverSources({
      sources: {
        ju: {
          canton: 'Giura',
          plateCode: 'JU',
          officialUrl: 'https://www.ricardo.ch/fr/shop/OVJ',
        },
        ne: {
          canton: 'Neuchâtel',
          plateCode: 'NE',
          officialUrl: 'https://www.ricardo.ch/de/shop/ENCHERES-PLAQUES-NE/offers/',
        },
        ricardoOnly: {
          canton: 'Test',
          plateCode: 'XX',
          officialUrl: 'https://www.ricardo.ch/shop/test',
        },
      },
      fetcher: async (url) => {
        requested.push(url);
        return {
          status: 200,
          text: async () => '<title>Kontrollschilder</title><body>Vente aux enchères</body>',
        };
      },
    });

    expect(requested.every((url) => !/ricardo\.ch/i.test(url))).toBe(true);
    expect(requested).toEqual([
      'https://www.jura.ch/fr/Autorites/Administration/DEC/OVJ/Vente-de-plaques-JU/Vente-aux-encheres-et-a-prix-fixe-des-plaques-d-immatriculation.html',
      'https://www.scan-ne.ch/vehicule/voitures-motos-scooters-quads/plaques/choisir-mon-numero-de-plaques/',
    ]);
    expect(results.find((entry) => entry.key === 'ju')?.recommendation).toBe('official-feed-request-needed');
    expect(results.find((entry) => entry.key === 'ne')?.recommendation).toBe('official-feed-request-needed');
    expect(results.find((entry) => entry.key === 'ricardoOnly')?.errorCode).toBe('unsafe-or-missing-discovery-url');
  });

  it('rejects non-HTTPS and Ricardo discovery URLs', () => {
    expect(resolveDiscoveryUrl({ plateCode: 'XX', officialUrl: 'http://example.test' })).toBeUndefined();
    expect(resolveDiscoveryUrl({ plateCode: 'XX', officialUrl: 'https://www.ricardo.ch/shop/test' })).toBeUndefined();
  });
});
