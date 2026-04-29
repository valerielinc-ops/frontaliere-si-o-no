/**
 * Regression: the "Vedi offerte ..." CTA on every nursing/healthcare SEO
 * landing must point to the FILTERED sector hub, not the unfiltered job-board
 * landing. Reported 2026-04-29 via Microsoft Clarity:
 *
 *   https://frontaliereticino.ch/lavoro-infermieri-svizzera/
 *   "Vedi offerte infermieri in Ticino" → /cerca-lavoro-ticino/
 *                                          ^^ unfiltered, lists every job
 *
 * The fix wires each landing id to a target sector key (`nurses` →
 * `infermieri`, `oss` → `case-anziani`) and resolves the URL through
 * buildSectorHubPath so locale variants stay correct.
 *
 * Exception: `healthcare-ticino` keeps the unfiltered hub because its
 * copy explicitly says "all healthcare openings" / "tutte le offerte
 * sanitarie" — there is no single sector that covers that promise.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildSectorHubPath,
  SECTOR_HUB_KEYS,
  type SectorHubKey,
} from '@/build-plugins/jobSectorLanding';
import { NURSING_LANDING_COPY } from '@/build-plugins/nursingLandingsCopy';

const PLUGIN_SRC = readFileSync(
  resolve(__dirname, '..', 'build-plugins', 'nursingLandingsPlugin.ts'),
  'utf8',
);

describe('nursingLandingsPlugin — CTA target sector map', () => {
  it('maps each landing id to a known sector key (or null for the catch-all)', () => {
    const match = PLUGIN_SRC.match(/CTA_SECTOR:[^=]+=\s*\{([\s\S]*?)\};/);
    expect(match, 'CTA_SECTOR map not found in plugin source').not.toBeNull();
    const body = match![1];

    // Match only the values of `key: 'value'` or `'key': 'value'` (right side
    // of the colon). null values are valid and skipped.
    const valueRefs = [
      ...body.matchAll(/(?:^|\s|,)['a-z-]+\s*:\s*'([a-z-]+)'/g),
    ].map((m) => m[1]);
    expect(valueRefs.length).toBeGreaterThan(0);
    for (const ref of valueRefs) {
      expect(SECTOR_HUB_KEYS).toContain(ref as SectorHubKey);
    }
  });

  it('uses ctaJobsUrl (the filtered URL) on the primary CTA, never the unfiltered jobBoardUrl', () => {
    // Source guard: the primary CTA <a> must reference ctaJobsUrl, not jobBoardUrl.
    expect(PLUGIN_SRC).toMatch(
      /<a href="\$\{esc\(ctaJobsUrl\)\}" style="\$\{CTA_PRIMARY_STYLE\}">/,
    );
    expect(PLUGIN_SRC).not.toMatch(
      /<a href="\$\{esc\(jobBoardUrl\)\}" style="\$\{CTA_PRIMARY_STYLE\}">/,
    );
  });
});

describe('nursingLandingsPlugin — sector hub URLs resolve correctly per locale', () => {
  // The IT canonical paths the user actually sees. Other locales mirror.
  it('IT nurses CTA points to /cerca-lavoro-ticino/infermieri/', () => {
    expect(buildSectorHubPath('it', 'infermieri')).toBe('/cerca-lavoro-ticino/infermieri/');
  });

  it('IT oss CTA points to /cerca-lavoro-ticino/case-anziani/', () => {
    expect(buildSectorHubPath('it', 'case-anziani')).toBe('/cerca-lavoro-ticino/case-anziani/');
  });

  it('EN nurses CTA points to /en/find-jobs-ticino/nurses/', () => {
    expect(buildSectorHubPath('en', 'infermieri')).toBe('/en/find-jobs-ticino/nurses/');
  });

  it('DE nurses CTA points to /de/jobs-im-tessin/pflegepersonal/', () => {
    expect(buildSectorHubPath('de', 'infermieri')).toBe('/de/jobs-im-tessin/pflegepersonal/');
  });

  it('FR nurses CTA points to /fr/trouver-emploi-tessin/infirmiers/', () => {
    expect(buildSectorHubPath('fr', 'infermieri')).toBe('/fr/trouver-emploi-tessin/infirmiers/');
  });
});

describe('nursingLandingsPlugin — CTA copy still matches the target sector', () => {
  // If somebody changes the CTA copy in nursingLandingsCopy.ts, this test
  // doesn't fail (copy is editorial), but it pins the IT samples that
  // motivated the fix so a regression is at least loud in code review.
  it('IT nurses CTA copy still talks about infermieri', () => {
    const cta = NURSING_LANDING_COPY.it.nurses.ctaJobs;
    expect(cta.toLowerCase()).toContain('infermier');
  });

  it('IT oss CTA copy still talks about case anziani / OSS', () => {
    const cta = NURSING_LANDING_COPY.it.oss.ctaJobs.toLowerCase();
    expect(cta).toMatch(/oss|case anziani/);
  });

  it('IT healthcare-ticino CTA copy says "all/tutte" — justifies unfiltered URL', () => {
    const cta = NURSING_LANDING_COPY.it['healthcare-ticino'].ctaJobs.toLowerCase();
    expect(cta).toContain('tutte');
  });
});
