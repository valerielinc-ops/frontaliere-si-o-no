import { describe, expect, it } from 'vitest';
import { buildPath, getSeoSection, parsePath } from '@/services/router';
import { STABIO_DOSSO_PETITION_PATHS } from '@/services/petitionRoute';

describe('Stabio-Gaggiolo petition routes', () => {
  for (const [locale, path] of Object.entries(STABIO_DOSSO_PETITION_PATHS)) {
    it(`round-trips the canonical ${locale} path`, () => {
      const route = { activeTab: 'petition' as const };
      expect(buildPath(route, locale as 'it' | 'en' | 'de' | 'fr')).toBe(path);
      expect(parsePath(path)).toMatchObject({
        locale,
        route,
      });
      expect(parsePath(path.replace(/\/$/, ''))).toMatchObject({
        locale,
        route,
      });
      expect(getSeoSection(route)).toBe('petition');
    });
  }
});
