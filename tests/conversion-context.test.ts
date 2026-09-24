import { describe, expect, it } from 'vitest';

import { getContextualConversionContext } from '@/services/conversionContext';

describe('getContextualConversionContext', () => {
  it('localizes a fuel surface and strips locale/query details', () => {
    expect(getContextualConversionContext('/en/fuel-prices/today?utm_source=ai', 'en')).toMatchObject({
      kind: 'fuel',
      source: 'contextual_fuel',
      heading: 'Compare before you leave',
    });
  });

  it('maps editorial and guide surfaces to distinct acquisition sources', () => {
    expect(getContextualConversionContext('/articoli-frontaliere/tasse-2026', 'it')?.kind).toBe('editorial');
    expect(getContextualConversionContext('/fr/guide-frontalier/permis', 'fr')).toMatchObject({
      kind: 'guide',
      source: 'contextual_guide',
      newsletterHeading: 'Nouveautés pratiques pour les frontaliers',
    });
  });

  it('leaves job and calculator routes on their dedicated conversion surfaces', () => {
    expect(getContextualConversionContext('/en/find-jobs-zurich', 'en')).toBeNull();
    expect(getContextualConversionContext('/calcola-stipendio', 'it')).toBeNull();
  });
});
