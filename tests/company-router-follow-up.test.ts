// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { parsePath, staticCompanyPathForLocale, updatePathForLocale } from '@/services/router';

describe('company profile router follow-up (#8140)', () => {
  const nativeLocation = window.location;

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: nativeLocation,
      writable: true,
      configurable: true,
    });
  });

  it('keeps /aziende/<slug>/ static after the pharmacy parser branch', () => {
    const { route } = parsePath('/aziende/Acme/');
    const { route: localizedRoute } = parsePath('/en/aziende/Acme/');

    expect(route.staticOverlay).toBe(true);
    expect(localizedRoute.staticOverlay).toBe(true);
    expect(staticCompanyPathForLocale('/aziende/Acme/', 'en')).toBe('/en/aziende/acme/');
    expect(staticCompanyPathForLocale('/en/aziende/Acme/', 'fr')).toBe('/fr/aziende/acme/');
  });

  it('updatePathForLocale invokes the company sibling path and normalizes its slug', () => {
    const assign = (path: string) => {
      expect(path).toBe('/en/aziende/acme/?source=test#jobs');
    };

    Object.defineProperty(window, 'location', {
      value: {
        ...window.location,
        pathname: '/aziende/Acme/',
        search: '?source=test',
        hash: '#jobs',
        assign,
      },
      writable: true,
      configurable: true,
    });

    updatePathForLocale('en');
  });
});
