/**
 * Regression tests for Semrush 4xx batch (2026-04-23).
 *
 * Two goals:
 *   1. Multi-locale city-hub URLs (Cluster C) resolve to valid job-board
 *      routes in all 4 locales for the 5 supported Ticino cities.
 *   2. Legacy FR paths (Cluster B) are registered in the
 *      `legacyRedirectsPlugin` redirect table, so the build emits
 *      bridge pages at those URLs pointing to the canonical target.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parsePath } from '@/services/router';

const CITY_HUB_CASES: Array<{ path: string; city: string; locale: string }> = [
  { path: '/cerca-lavoro-ticino/locarno/', city: 'locarno', locale: 'it' },
  { path: '/cerca-lavoro-ticino/chiasso/', city: 'chiasso', locale: 'it' },
  { path: '/en/find-jobs-ticino/locarno/', city: 'locarno', locale: 'en' },
  { path: '/en/find-jobs-ticino/chiasso/', city: 'chiasso', locale: 'en' },
  { path: '/de/jobs-im-tessin/locarno/', city: 'locarno', locale: 'de' },
  { path: '/de/jobs-im-tessin/chiasso/', city: 'chiasso', locale: 'de' },
  { path: '/fr/trouver-emploi-tessin/locarno/', city: 'locarno', locale: 'fr' },
  { path: '/fr/trouver-emploi-tessin/chiasso/', city: 'chiasso', locale: 'fr' },
  { path: '/fr/trouver-emploi-tessin/lugano/', city: 'lugano', locale: 'fr' },
  { path: '/fr/trouver-emploi-tessin/mendrisio/', city: 'mendrisio', locale: 'fr' },
  { path: '/fr/trouver-emploi-tessin/bellinzona/', city: 'bellinzona', locale: 'fr' },
];

describe('Cluster C — multi-locale city hubs', () => {
  beforeEach(() => {
    vi.stubGlobal('history', {
      pushState: vi.fn(),
      replaceState: vi.fn(),
      state: null,
    });
    vi.stubGlobal('window', {
      ...((globalThis as unknown as { window?: Record<string, unknown> }).window || {}),
      location: { pathname: '/', search: '', hash: '' },
      history: (globalThis as unknown as { history?: unknown }).history,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      scrollTo: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const { path: urlPath, city, locale } of CITY_HUB_CASES) {
    it(`parses ${urlPath} → job-board city=${city} locale=${locale}`, () => {
      const parsed = parsePath(urlPath);
      expect(parsed.locale).toBe(locale);
      expect(parsed.route.activeTab).toBe('job-board');
      expect(parsed.route.jobBoardCity).toBe(city);
      expect(parsed.notFoundPath).toBeUndefined();
    });
  }
});

describe('Cluster B — FR legacy slug redirects', () => {
  // Load the plugin source so we can assert on the redirect table without
  // actually running the Vite build. This keeps the test hermetic and fast.
  const pluginSource = fs.readFileSync(
    path.resolve(__dirname, '../build-plugins/legacyRedirectsPlugin.ts'),
    'utf-8',
  );

  const requiredRedirects: Array<[from: string, to: string]> = [
    ['/fr/glossaire/', '/fr/glossaire-frontalier/'],
    ['/fr/comparer-services/assurance-maladie/', '/fr/comparer-services/comparer-caisses-maladie/'],
    ['/fr/salaires-frontaliers-tessin/', '/fr/statistiques/comparer-salaires/'],
    ['/fr/primes-assurance-maladie/ticino/', '/fr/primes-assurance-maladie-communes/ticino/'],
    ['/fr/prix-diesel/aujourdhui/', '/fr/prix-gasoil-suisse/aujourd-hui/'],
    ['/fr/prix-diesel/aujourd-hui/', '/fr/prix-gasoil-suisse/aujourd-hui/'],
    ['/fr/trouver-emploi-tessin/3-derniers-jours/', '/fr/trouver-emploi-tessin/derniers-3-jours/'],
  ];

  for (const [from, to] of requiredRedirects) {
    it(`registers redirect ${from} → ${to}`, () => {
      // Source stores entries as '<from>': '<to>' — match literally.
      const literal = `'${from}': '${to}'`;
      expect(pluginSource).toContain(literal);
    });
  }
});
