/**
 * Regression — per-canton job-board sub-pages emitted as static HTML
 * (hub indexes, pagination, per-company hubs, category listings) must
 * parse with `staticOverlay: true` so the SPA click interceptor falls
 * through to a native browser navigation. Without this, clicks from
 * inside the SPA (e.g. from `/cerca-lavoro-basilea/`) treat the
 * trailing slug as a `jobSlug`, JobBoard then renders "Annuncio non
 * trovato", while opening the same URL in a new tab works (browser
 * loads the static HTML directly).
 *
 * Bug: reported 2026-05-18 on `/cerca-lavoro-basilea/settori/` and
 *   `/cerca-lavoro-basilea/aziende/` clicks.
 *
 * Fix: `isCantonStaticOverlaySlug` in `services/router.ts` matches the
 *   3 hub-exact slugs (+ EN/DE/FR variants), pagination prefixes, and
 *   company / category prefixes. The per-canton parser branch then
 *   returns `staticOverlay: true` before the jobSlug fallthrough.
 */

import { describe, it, expect } from 'vitest';
import { parsePath } from '@/services/router';

describe('per-canton static-overlay slugs', () => {
  const HUB_CASES: Array<[string, string]> = [
    ['/cerca-lavoro-basilea/settori/', 'BS hub'],
    ['/cerca-lavoro-basilea/aziende/', 'BS hub'],
    ['/cerca-lavoro-basilea/tutti/', 'BS hub'],
    ['/cerca-lavoro-zurigo/settori/', 'ZH hub'],
    ['/cerca-lavoro-ginevra/aziende/', 'GE hub'],
    ['/en/find-jobs-zurich/sectors/', 'ZH hub EN'],
    ['/en/find-jobs-zurich/companies/', 'ZH hub EN'],
    ['/en/find-jobs-zurich/all/', 'ZH hub EN'],
    ['/de/jobs-in-zurich/branchen/', 'ZH hub DE'],
    ['/de/jobs-in-zurich/unternehmen/', 'ZH hub DE'],
    ['/de/jobs-in-zurich/alle/', 'ZH hub DE'],
    ['/fr/trouver-emploi-geneve/secteurs/', 'GE hub FR'],
    ['/fr/trouver-emploi-geneve/entreprises/', 'GE hub FR'],
    ['/fr/trouver-emploi-geneve/tous/', 'GE hub FR'],
  ];

  for (const [url, label] of HUB_CASES) {
    it(`${url} → staticOverlay (${label})`, () => {
      const parsed = parsePath(url);
      expect(parsed.route.activeTab).toBe('job-board');
      expect(parsed.route.staticOverlay).toBe(true);
      expect(parsed.route.jobSlug).toBeUndefined();
    });
  }

  it('/cerca-lavoro-basilea/pagina-2/ → staticOverlay (IT pagination)', () => {
    const parsed = parsePath('/cerca-lavoro-basilea/pagina-2/');
    expect(parsed.route.staticOverlay).toBe(true);
    expect(parsed.route.jobSlug).toBeUndefined();
  });

  it('/en/find-jobs-zurich/page-5/ → staticOverlay (EN pagination)', () => {
    const parsed = parsePath('/en/find-jobs-zurich/page-5/');
    expect(parsed.route.staticOverlay).toBe(true);
  });

  it('/de/jobs-in-zurich/seite-3/ → staticOverlay (DE pagination)', () => {
    const parsed = parsePath('/de/jobs-in-zurich/seite-3/');
    expect(parsed.route.staticOverlay).toBe(true);
  });

  it('/cerca-lavoro-basilea/azienda-universitatsspital-basel/ → staticOverlay', () => {
    const parsed = parsePath('/cerca-lavoro-basilea/azienda-universitatsspital-basel/');
    expect(parsed.route.staticOverlay).toBe(true);
    expect(parsed.route.jobSlug).toBeUndefined();
  });

  it('/en/find-jobs-zurich/company-google/ → staticOverlay', () => {
    const parsed = parsePath('/en/find-jobs-zurich/company-google/');
    expect(parsed.route.staticOverlay).toBe(true);
  });

  it('/de/jobs-in-zurich/unternehmen-roche/ → staticOverlay (DE company prefix)', () => {
    const parsed = parsePath('/de/jobs-in-zurich/unternehmen-roche/');
    expect(parsed.route.staticOverlay).toBe(true);
  });

  it('/fr/trouver-emploi-geneve/entreprise-nestle/ → staticOverlay (FR company prefix)', () => {
    const parsed = parsePath('/fr/trouver-emploi-geneve/entreprise-nestle/');
    expect(parsed.route.staticOverlay).toBe(true);
  });

  it('/cerca-lavoro-basilea/categoria-sanita/ → staticOverlay (IT category)', () => {
    const parsed = parsePath('/cerca-lavoro-basilea/categoria-sanita/');
    expect(parsed.route.staticOverlay).toBe(true);
    expect(parsed.route.jobSlug).toBeUndefined();
  });

  it('/de/jobs-in-zurich/kategorie-gesundheit/ → staticOverlay (DE category)', () => {
    const parsed = parsePath('/de/jobs-in-zurich/kategorie-gesundheit/');
    expect(parsed.route.staticOverlay).toBe(true);
  });

  it('actual job slug still falls through as jobSlug (no false positive)', () => {
    const parsed = parsePath('/cerca-lavoro-basilea/software-engineer-acme-basel/');
    expect(parsed.route.staticOverlay).toBeFalsy();
    expect(parsed.route.jobSlug).toBe('software-engineer-acme-basel');
  });

  it('ZH city slug still routes to jobBoardCity (no false positive)', () => {
    const parsed = parsePath('/cerca-lavoro-zurigo/zurich/');
    expect(parsed.route.jobBoardCity).toBe('zurich');
    expect(parsed.route.staticOverlay).toBeFalsy();
  });
});
