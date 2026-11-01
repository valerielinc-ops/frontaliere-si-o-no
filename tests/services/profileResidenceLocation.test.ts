import { describe, expect, it } from 'vitest';
import { resolveEnrichmentProfileFields } from '@/services/profileFirestore';

describe('profile residence location provenance', () => {
  it('keeps legacy municipality available but never upgrades it to a verified residence', () => {
    const fields = resolveEnrichmentProfileFields(null, {
      municipality: 'Como (CO)',
      residenceLocation: 'Como, Italia',
    });

    expect(fields.municipality).toBe('Como (CO)');
    expect(fields.residenceLocation).toBe('');
    expect(fields.residenceCountry).toBe('');
  });

  it('uses only a country-qualified residence explicitly saved in the private profile', () => {
    const fields = resolveEnrichmentProfileFields({
      municipality: 'Como (CO)',
      residenceLocation: 'Como, Italia',
      residenceCountry: 'IT',
    }, {
      municipality: 'Lugano (TI)',
      residenceLocation: 'Lugano, Svizzera',
      residenceCountry: 'CH',
    });

    expect(fields.municipality).toBe('Como (CO)');
    expect(fields.residenceLocation).toBe('Como, Italia');
    expect(fields.residenceCountry).toBe('IT');
  });

  it('keeps a city-only private value unconfirmed and preserves manual fallback', () => {
    const fields = resolveEnrichmentProfileFields({
      municipality: 'Baden',
      residenceLocation: 'Unlisted village',
    }, null);

    expect(fields.municipality).toBe('Baden');
    expect(fields.residenceLocation).toBe('');
    expect(fields.residenceCountry).toBe('');
  });

  it('does not treat a country name typed into free text as explicit country selection', () => {
    const fields = resolveEnrichmentProfileFields({
      municipality: '',
      residenceLocation: 'Como, Italia',
      residenceCountry: '',
    }, null);

    expect(fields.residenceLocation).toBe('');
    expect(fields.residenceCountry).toBe('');
  });
});
