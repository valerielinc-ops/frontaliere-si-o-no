import { describe, expect, it } from 'vitest';

import { buildCompanySearchSlug, getJobBoardCompanyRoutePrefix } from '@/components/community/JobBoard.tsx';

describe('JobBoard company route slugs', () => {
  it('localizes the company prefix by locale', () => {
    expect(getJobBoardCompanyRoutePrefix('it')).toBe('azienda');
    expect(getJobBoardCompanyRoutePrefix('en')).toBe('company');
    expect(getJobBoardCompanyRoutePrefix('de')).toBe('unternehmen');
    expect(getJobBoardCompanyRoutePrefix('fr')).toBe('entreprise');
  });

  it('builds localized company search slugs instead of hardcoded Italian ones', () => {
    expect(buildCompanySearchSlug('USI - Universita della Svizzera italiana', undefined, 'en')).toBe('company-usi-universita-della-svizzera-italiana');
    expect(buildCompanySearchSlug('USI - Universita della Svizzera italiana', undefined, 'de')).toBe('unternehmen-usi-universita-della-svizzera-italiana');
    expect(buildCompanySearchSlug('USI - Universita della Svizzera italiana', undefined, 'fr')).toBe('entreprise-usi-universita-della-svizzera-italiana');
  });
});
