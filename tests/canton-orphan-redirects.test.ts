import { describe, expect, it } from 'vitest';

import { enumerateCantonOrphanRedirects } from '../build-plugins/cantonOrphanRedirectsPlugin';

describe('cantonOrphanRedirectsPlugin — enumerateCantonOrphanRedirects', () => {
 const redirects = enumerateCantonOrphanRedirects();

 it('emits a redirect for the originally reported URL', () => {
 // Real GSC orphan that surfaced this whole chain of bugs.
 const hit = redirects.find((r) => r.from === '/cerca-lavoro-basilea/offerte-di-lavoro-ticino-oggi/');
 expect(hit).toBeDefined();
 expect(hit?.to).toBe('/cerca-lavoro-basilea/oggi/');
 expect(hit?.locale).toBe('it');
 expect(hit?.canton).toBe('BASILEA');
 expect(hit?.slot).toBe('today');
 });

 it('emits the GR-form today slug under non-GR cantons', () => {
 const hit = redirects.find((r) => r.from === '/cerca-lavoro-zurigo/offerte-di-lavoro-grigioni-oggi/');
 expect(hit).toBeDefined();
 expect(hit?.to).toBe('/cerca-lavoro-zurigo/oggi/');
 });

 it('emits the short-form slug under TI section (TI long-form is canonical)', () => {
 const hit = redirects.find((r) => r.from === '/cerca-lavoro-ticino/oggi/');
 expect(hit).toBeDefined();
 expect(hit?.to).toBe('/cerca-lavoro-ticino/offerte-di-lavoro-ticino-oggi/');
 expect(hit?.slot).toBe('today');
 });

 it('emits care-cluster TI-form slugs under non-TI sections', () => {
 const clinicsHit = redirects.find((r) => r.from === '/cerca-lavoro-basilea/cliniche-ticino/');
 expect(clinicsHit).toBeDefined();
 expect(clinicsHit?.to).toBe('/cerca-lavoro-basilea/cliniche/');
 expect(clinicsHit?.slot).toBe('clinics');

 const ossHit = redirects.find((r) => r.from === '/cerca-lavoro-vallese/oss-ticino/');
 expect(ossHit).toBeDefined();
 expect(ossHit?.to).toBe('/cerca-lavoro-vallese/oss-vallese/');
 });

 it('emits English / German / French locale variants', () => {
 const en = redirects.find((r) => r.from === '/en/find-jobs-basel/ticino-jobs-today/');
 expect(en).toBeDefined();
 expect(en?.to).toBe('/en/find-jobs-basel/today/');

 const de = redirects.find((r) => r.from === '/de/jobs-in-basel/jobs-tessin-heute/');
 expect(de).toBeDefined();
 expect(de?.to).toBe('/de/jobs-in-basel/heute/');

 const fr = redirects.find((r) => r.from === '/fr/trouver-emploi-bale/offres-emploi-tessin-aujourdhui/');
 expect(fr).toBeDefined();
 expect(fr?.to).toBe('/fr/trouver-emploi-bale/aujourdhui/');
 });

 it('never emits redirect to itself', () => {
 const selfRedirects = redirects.filter((r) => r.from === r.to);
 expect(selfRedirects).toEqual([]);
 });

 it('produces a sensible volume of redirects (sanity bound)', () => {
 // Sanity check: 24 cantons × 4 locales × 7 slots × ~3 alternates = ~2k.
 // The exact number drifts with slug-table edits; we just want to catch
 // accidental enumeration collapses (e.g. empty list, runaway loops).
 expect(redirects.length).toBeGreaterThan(500);
 expect(redirects.length).toBeLessThan(5000);
 });
});
