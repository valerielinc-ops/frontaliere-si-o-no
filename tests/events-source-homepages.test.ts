import { describe, expect, it } from 'vitest';
import { EVENT_SOURCES, eventReferralUrl, eventSourceUrl } from '../scripts/lib/events-utils.mjs';

describe('event source homepages', () => {
  it('uses an explicit MySwitzerland locale path for the crawler-facing link', () => {
    expect(EVENT_SOURCES.myswitzerland.homepage).toBe('https://www.myswitzerland.com/en/');
  });

  it('uses canonical landing pages for sources whose agenda URLs redirect or disappeared', () => {
    expect(EVENT_SOURCES.guidle.homepage).toBe('https://www.guidle.com/de');
    expect(EVENT_SOURCES['nw-agenda'].homepage).toBe('https://www.nw.ch/');
    expect(EVENT_SOURCES['ow-agenda'].homepage).toBe('https://www.ow.ch/');
    expect(EVENT_SOURCES['lu-stadt-agenda'].homepage).toBe('https://www.stadtluzern.ch/aktuelles');
    expect(EVENT_SOURCES.openagenda.homepage).toBe('https://openagenda.com/fr');
  });

  it('falls back from a verified expired event detail to the official source homepage', () => {
    const event = { id: 'nw-agenda:94123', sourceKey: 'nw-agenda' };
    const stale = 'https://www.nw.ch/anlaesseaktuelles/94123';
    expect(eventSourceUrl(stale, event)).toBe(EVENT_SOURCES['nw-agenda'].homepage);
    expect(eventReferralUrl(stale, event)).toContain('https://www.nw.ch/?utm_source=frontaliereticino');
    expect(eventReferralUrl(stale, event)).not.toContain('/anlaesseaktuelles/94123');
  });
});
