import { describe, expect, it } from 'vitest';
import { classifyDiscovery } from '../scripts/plate-auctions/discover-sources.mjs';

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
});
