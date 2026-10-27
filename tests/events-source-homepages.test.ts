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

  it('falls back from verified expired event details to official source homepages', () => {
    const staleEvents = [
      {
        sourceKey: 'ge-agenda',
        id: 'cafe-quartier-initiation-gout-pain-pain-artisanal-industriel-differences',
        rawUrl: 'https://www.geneve.ch/agenda/cafe-quartier-initiation-gout-pain-pain-artisanal-industriel-differences',
      },
      {
        sourceKey: 'guidle',
        id: 'don-toliver-nitrous-octane-world-tour-leg-2_A2e1GAw',
        rawUrl: 'https://www.guidle.com/it/veranstaltungen/musik/zuerich/don-toliver-nitrous-octane-world-tour-leg-2_A2e1GAw',
      },
      { sourceKey: 'nw-agenda', id: '94120', rawUrl: 'https://www.nw.ch/anlaesseaktuelles/94120' },
      { sourceKey: 'nw-agenda', id: '94123', rawUrl: 'https://www.nw.ch/anlaesseaktuelles/94123' },
    ] as const;

    for (const { sourceKey, id, rawUrl } of staleEvents) {
      const event = { id: `${sourceKey}:${id}`, sourceKey };
      expect(eventSourceUrl(rawUrl, event)).toBe(EVENT_SOURCES[sourceKey].homepage);
      expect(eventReferralUrl(rawUrl, event)).toContain(`${EVENT_SOURCES[sourceKey].homepage}?utm_source=frontaliereticino`);
      expect(eventReferralUrl(rawUrl, event)).not.toContain(new URL(rawUrl).pathname);
    }
  });
});
