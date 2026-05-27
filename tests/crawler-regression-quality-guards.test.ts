/**
 * Regression tests for the shared crawler quality guards
 * (docs/copilot-crawler-fix-prompts.md).
 *
 * These guards are the single chokepoint that filters thin-content, wrong-
 * company, or boilerplate-only job records across ~30 dedicated crawlers.
 * Breaking any of them would silently let low-quality data into jobs.json —
 * hence the source-level coverage plus unit tests for each predicate.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  titleOverlap,
  checkMinDescription,
  checkCompanyNameSanity,
  runQualityGuards,
  DEFAULT_MIN_DESCRIPTION,
  DEFAULT_MIN_TITLE_OVERLAP,
} from '../scripts/lib/crawler-quality-guards.mjs';
import {
  getCantonDisplayName,
  getCantonForLocation,
  HQ_REGISTRY,
  COMPANY_HQ,
} from '../scripts/lib/crawler-location-config.mjs';

describe('titleOverlap()', () => {
  it('returns 1 for identical inputs (modulo case/accents/punctuation)', () => {
    expect(titleOverlap('Impiegato Commerciale', 'impiegato commerciale')).toBe(1);
    expect(titleOverlap('Addetto Vendita', 'Addetto vendita!')).toBe(1);
  });

  it('returns 0 for completely different tokens', () => {
    expect(titleOverlap('Cashier Lugano', 'Panettiere Biasca')).toBe(0);
  });

  it('returns a ratio in [0,1] for partial overlap', () => {
    const ov = titleOverlap('Cashier Lugano part-time', 'Cashier full-time Bellinzona');
    expect(ov).toBeGreaterThan(0);
    expect(ov).toBeLessThan(1);
  });

  it('ignores short stopword-length tokens', () => {
    expect(titleOverlap('a b c', 'd e f')).toBe(0);
  });
});

describe('checkMinDescription()', () => {
  it('accepts a description at or above the threshold', () => {
    const job = { description: 'x'.repeat(DEFAULT_MIN_DESCRIPTION) };
    expect(checkMinDescription(job).ok).toBe(true);
  });

  it('rejects a too-short description with a diagnostic reason', () => {
    const res = checkMinDescription({ description: 'too short' });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/too short/i);
  });

  it('honours a custom minimum length', () => {
    expect(checkMinDescription({ description: 'x'.repeat(50) }, 40).ok).toBe(true);
    expect(checkMinDescription({ description: 'x'.repeat(50) }, 80).ok).toBe(false);
  });
});

describe('checkCompanyNameSanity()', () => {
  it('accepts when the actual name matches the expected canonical name', () => {
    expect(checkCompanyNameSanity({ company: 'Coop' }, 'Coop').ok).toBe(true);
  });

  it('accepts case-insensitive and accent-insensitive aliases', () => {
    expect(
      checkCompanyNameSanity({ company: 'Società Cooperativa Coop' }, ['Coop', 'Coop Società']).ok,
    ).toBe(true);
  });

  it('accepts when actual name contains the expected alias as a substring', () => {
    expect(checkCompanyNameSanity({ company: 'Migros Aare SA' }, 'Migros').ok).toBe(true);
  });

  it('rejects when company name is missing', () => {
    expect(checkCompanyNameSanity({ company: '' }, 'Coop').ok).toBe(false);
  });

  it('rejects when company name is a different brand', () => {
    const res = checkCompanyNameSanity({ company: 'Denner SA' }, 'Coop');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/Denner/i);
  });
});

describe('runQualityGuards()', () => {
  const makeJob = (over: Partial<{ id: string; title: string; company: string; description: string }> = {}) => ({
    id: over.id ?? `job-${Math.random().toString(36).slice(2, 8)}`,
    title: over.title ?? 'Commesso vendita',
    company: over.company ?? 'Coop',
    description: over.description ?? 'd'.repeat(DEFAULT_MIN_DESCRIPTION + 50),
  });

  it('keeps valid jobs and mutates the array in place when rejecting bad ones', () => {
    const jobs = [
      makeJob(),
      makeJob({ id: 'short', description: 'nope' }),
      makeJob({ id: 'wrong-brand', company: 'Lidl' }),
    ];
    const res = runQualityGuards(jobs, {
      companyName: 'Coop',
      minDescription: DEFAULT_MIN_DESCRIPTION,
    });
    expect(res.kept).toBe(1);
    expect(res.rejected).toBe(2);
    expect(res.reasons.min_description).toBe(1);
    expect(res.reasons.company_name).toBe(1);
    expect(jobs).toHaveLength(1);
  });

  it('respects the DEFAULT_MIN_TITLE_OVERLAP constant when provided a ref field', () => {
    expect(DEFAULT_MIN_TITLE_OVERLAP).toBeGreaterThan(0);
    const jobs = [
      // overlap ~1.0 — same tokens in different order → kept
      { ...makeJob({ title: 'Cassiere Lugano part-time' }), jsonLdTitle: 'Part-time Cassiere Lugano' },
      // overlap 0 — no tokens in common → rejected
      { ...makeJob({ title: 'Fioraio' }), jsonLdTitle: 'Ingegnere Software' },
    ];
    const res = runQualityGuards(jobs, {
      expectedTitleRefField: 'jsonLdTitle',
      minTitleOverlap: DEFAULT_MIN_TITLE_OVERLAP,
    });
    expect(res.kept).toBe(1);
    expect(res.rejected).toBe(1);
    expect(res.reasons.title_overlap).toBe(1);
  });

  it('is a no-op on an empty or non-array input', () => {
    expect(runQualityGuards([] as never[]).kept).toBe(0);
    expect(runQualityGuards(null as unknown as never[]).kept).toBe(0);
  });

  it('can be bypassed by providing no guards', () => {
    const jobs = [{ description: 'short', company: 'Anything' }];
    const res = runQualityGuards(jobs, { minDescription: 0 });
    expect(res.kept).toBe(1);
    expect(res.rejected).toBe(0);
  });
});

describe('crawler-location-config — HQ_REGISTRY alias + canton helpers', () => {
  it('HQ_REGISTRY is the same object as COMPANY_HQ (docs/crawler-parametrizzazione-plan.md)', () => {
    expect(HQ_REGISTRY).toBe(COMPANY_HQ);
  });

  it('getCantonForLocation resolves free-text locations to 2-letter codes', () => {
    expect(getCantonForLocation('Lugano, Ticino')).toBe('TI');
    expect(getCantonForLocation('Chur, Graubünden')).toBe('GR');
    expect(getCantonForLocation('Sion, Valais')).toBe('VS');
    expect(getCantonForLocation('')).toBe('');
    expect(getCantonForLocation('Atlantis')).toBe('');
  });

  it('getCantonDisplayName returns locale-appropriate names for canton codes', () => {
    expect(getCantonDisplayName('TI', 'it')).toBe('Ticino');
    expect(getCantonDisplayName('TI', 'de')).toBe('Tessin');
    expect(getCantonDisplayName('GR', 'it')).toBe('Grigioni');
    expect(getCantonDisplayName('GR', 'de')).toBe('Graubünden');
    expect(getCantonDisplayName('VS', 'it')).toBe('Vallese');
    expect(getCantonDisplayName('VS', 'fr')).toBe('Valais');
  });

  it('getCantonDisplayName falls back gracefully on unknown codes', () => {
    expect(getCantonDisplayName('ZZ', 'it')).toBe('ZZ');
  });
});

describe('Crawler wiring — Coop and Migros import the shared guards', () => {
  it.each([
    ['scripts/update-coop-jobs.mjs'],
    ['scripts/update-migros-jobs.mjs'],
  ])('%s imports runQualityGuards from the shared module', (relPath) => {
    const src = readFileSync(resolve(__dirname, '..', relPath), 'utf8');
    expect(src).toMatch(/from '\.\/lib\/crawler-quality-guards\.mjs'/);
    expect(src).toMatch(/runQualityGuards\(/);
  });

  it('Coop crawler keeps its existing title-overlap guard (≥0.6)', () => {
    const src = readFileSync(resolve(__dirname, '..', 'scripts/update-coop-jobs.mjs'), 'utf8');
    expect(src).toMatch(/overlap\s*<\s*0\.6/);
  });

  it('VOLG crawler keeps the body-ratio + title-overlap guards (reference)', () => {
    const src = readFileSync(resolve(__dirname, '..', 'scripts/update-volg-jobs.mjs'), 'utf8');
    expect(src).toMatch(/MIN_TITLE_OVERLAP/);
    expect(src).toMatch(/MIN_BODY_RATIO/);
  });
});
