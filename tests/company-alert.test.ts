/**
 * CompanyAlert — issue #5012.
 *
 * The employer pin (`specificCompanyKey`) has been a hard filter in the matcher
 * since day one and was completely inert: every write path passed `null`,
 * `getUserAlerts()` never read it back, `updateAlert()` had no branch for it,
 * and the token-mode Cloud Function rejected a company-only alert with
 * `missing_filters`. These tests pin the round-trip end to end plus the ONE
 * company-slug normalisation the whole feature depends on.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { baseCompanySlug, canonicalCompanyProfileSlug, rawCompanySlug } from '../build-plugins/shared/companyProfileSlug.mjs';
import { canonicalEmployerBrandKey } from '@/services/employerBrands';
import { canonicalCompanySlug } from '../build-plugins/weeklyEmployersData';
import { buildAlertProfile, scoreJobForAlert } from '@/services/jobAlertMatching.mjs';
import { MAX_ALERTS_PER_USER } from '@/services/jobAlertService';

const repoRoot = path.resolve(__dirname, '..');
const readRepoFile = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf-8');

describe('one company-slug normalisation (#5012, Non-Negotiable #6)', () => {
  const cases: Array<[string, string | undefined]> = [
    ['Board International', undefined],
    ['Migros Ticino', undefined],
    ['Lidl Svizzera', 'lidl-ch'],
    ['Coop Genossenschaft', undefined],
    ['Ente Ospedaliero Cantonale', 'eoc'],
    ['  Bürgenstock  Hotels & Resort ', undefined],
  ];

  it.each(cases)('canonicalEmployerBrandKey delegates to baseCompanySlug for %s', (name, key) => {
    expect(canonicalEmployerBrandKey(name, key)).toBe(baseCompanySlug(name, key));
  });

  it.each(cases)('canonicalCompanySlug delegates to baseCompanySlug for %s', (name, key) => {
    expect(canonicalCompanySlug(name, key)).toBe(baseCompanySlug(name, key));
  });

  it('keeps the historical shape: accents stripped, runs collapsed, Lidl folded', () => {
    expect(baseCompanySlug('Bürgenstock Hotels & Resort')).toBe('burgenstock-hotels-resort');
    expect(baseCompanySlug('Lidl Schweiz AG')).toBe('lidl');
    expect(baseCompanySlug('', 'lidl-ch')).toBe('lidl');
    expect(baseCompanySlug('')).toBe('');
  });

  it('only canonicalCompanyProfileSlug folds brand aliases (the alert key does)', () => {
    expect(baseCompanySlug('Migros Ticino')).toBe('migros-ticino');
    expect(canonicalCompanyProfileSlug('Migros Ticino')).toBe('migros');
  });

  it('no file re-implements the slugify literal any more', () => {
    const literal = "replace(/[^a-z0-9]+/g, ' ')";
    for (const rel of [
      'services/employerBrands.ts',
      'build-plugins/weeklyEmployersData.ts',
      'scripts/refresh-weekly-employers-top-pairs.mjs',
      'services/jobAlertMatching.mjs',
    ]) {
      expect(readRepoFile(rel).includes(literal), `${rel} still re-implements the slugify`).toBe(false);
    }
  });

  it('the Lidl fold lives in exactly one module', () => {
    // Widened after review: the extraction above MISSED two copies —
    // `canonicalCompanySlugBuild` in jobsSeoPagesPlugin.ts, the plugin that emits the
    // indexed /aziende/<slug>/ pages (its own comment called it "Mirror runtime
    // canonicalCompanyRouteSlug logic"), and `canonicalCompanyRouteSlug` in JobBoard.tsx,
    // the very file this feature mounts its CTA in. If either drifts, the hub URL and the
    // token CompanyAlert persists stop agreeing — silently, no error, user convinced they
    // are subscribed. That is the failure this feature exists to prevent.
    //
    // The generic slugify literal is the WRONG fingerprint for these two: both files also
    // contain unrelated text normalisers that share it (jobsSeoPagesPlugin's
    // `normalizeSearchTerm` matches search-landing queries, not company URLs), so asserting
    // on it would fail for a file that is perfectly clean. The Lidl special-case is
    // specific to the company-slug normalisation, so it is the fingerprint that actually
    // means "somebody re-implemented this".
    const fold = "includes('lidl')";
    expect(readRepoFile('build-plugins/shared/companyProfileSlug.mjs').includes(fold)).toBe(true);
    for (const rel of [
      'build-plugins/jobsSeoPagesPlugin.ts',
      'components/community/JobBoard.tsx',
      'services/employerBrands.ts',
      'build-plugins/weeklyEmployersData.ts',
      'scripts/refresh-weekly-employers-top-pairs.mjs',
      'services/jobAlertMatching.mjs',
    ]) {
      expect(readRepoFile(rel).includes(fold), `${rel} re-implements the company-slug Lidl fold`).toBe(false);
    }
  });

  it('the raw (un-folded) slug is shared too, and still differs from the canonical', () => {
    // rawCompanySlug is NOT an internal detail of baseCompanySlug: the router and the hub
    // builder keep it alongside the canonical so already-indexed alias URLs still resolve.
    // Collapsing the two would 404 them, so the distinction is asserted, not assumed.
    expect(rawCompanySlug('Lidl Schweiz AG')).toBe('lidl-schweiz-ag');
    expect(baseCompanySlug('Lidl Schweiz AG')).toBe('lidl');
    expect(rawCompanySlug('Bürgenstock Hotels & Resort')).toBe('burgenstock-hotels-resort');
    expect(rawCompanySlug('')).toBe('');
  });

  it('the migrated build/router copies still agree with the shared function', () => {
    // Behaviour-preservation check for the review fix: the two hand-written copies were
    // byte-equivalent to baseCompanySlug, so delegating must not move a single slug.
    // These are the shapes that actually occur in the crawled corpus.
    for (const [name, key] of [
      ['Coop Genossenschaft', undefined],
      ['Migros Ticino', 'migros-ti'],
      ['Lidl Svizzera DL AG', 'lidl-ch'],
      ['Bürgenstock Hotels & Resort', undefined],
      ['  Ospedale  Regionale   di Lugano ', 'orl'],
      ['', ''],
    ] as const) {
      const expected =
        String(key || '').toLowerCase().includes('lidl') || String(name).toLowerCase().includes('lidl')
          ? 'lidl'
          : String(name)
              .toLowerCase()
              .normalize('NFD')
              .replace(/[̀-ͯ]/g, '')
              .replace(/[^a-z0-9]+/g, ' ')
              .trim()
              .replace(/\s+/g, '-');
      expect(baseCompanySlug(name, key)).toBe(expected);
    }
  });
});

describe('matcher pin still fires with the shared normalisation (#5012)', () => {
  function alertFor(companyKey: string) {
    return buildAlertProfile(
      {
        keywords: [],
        locations: [],
        sectors: [],
        contractTypes: [],
        cantonFilter: null,
        specificCompanyKey: companyKey,
      },
      {},
    );
  }

  it('matches a job of the pinned employer and nothing else', () => {
    const profile = alertFor(canonicalCompanyProfileSlug('Board International'));
    const hit = { id: 'a', title: 'Sviluppatore', company: 'Board International SA', canton: 'TI' };
    const miss = { id: 'b', title: 'Sviluppatore', company: 'Medacta International SA', canton: 'TI' };
    expect(scoreJobForAlert(hit, profile)).toBeGreaterThan(0);
    expect(scoreJobForAlert(miss, profile)).toBe(0);
  });

  it('matches across the Lidl legal-entity variants the slug folds', () => {
    const profile = alertFor(canonicalCompanyProfileSlug('Lidl Svizzera'));
    for (const company of ['Lidl Schweiz AG', 'Lidl Svizzera SA', 'LIDL Suisse']) {
      expect(scoreJobForAlert({ id: 'x', title: 'Venditore', company, canton: 'AG' }, profile)).toBeGreaterThan(0);
    }
  });
});

describe('alert cap parity across the three enforcement points (#5012)', () => {
  it('client, token Cloud Function and backfill agree', () => {
    const cf = readRepoFile('functions/src/newsletterSubscriptionManagement.js');
    const backfill = readRepoFile('functions/src/jobAlertBackfillCore.js');
    const cfCap = Number(/const MAX_ALERTS_PER_USER = (\d+)/.exec(cf)?.[1]);
    const backfillCap = Number(/MAX_ALERTS_PER_USER = (\d+)/.exec(backfill)?.[1]);
    expect(cfCap).toBe(MAX_ALERTS_PER_USER);
    expect(backfillCap).toBe(MAX_ALERTS_PER_USER);
  });
});

describe('token-mode Cloud Function accepts a company-only alert (#5012)', () => {
  const cf = readRepoFile('functions/src/newsletterSubscriptionManagement.js');

  it('does not reject a create with only a company pin', () => {
    expect(cf).toContain('!companyPin && !jobPin');
  });

  it('serializes the pin back to the client', () => {
    expect(cf).toContain('specificCompanyKey: typeof data?.specificCompanyKey');
  });

  it('mirrors baseCompanySlug exactly (bundle cannot import outside functions/)', () => {
    const fn = /function normalizeCompanyAlertKey\(value\) \{[\s\S]*?\n\}/.exec(cf)?.[0] || '';
    expect(fn).toBeTruthy();
    // eslint-disable-next-line no-new-func
    const mirror = new Function(`${fn}; return normalizeCompanyAlertKey;`)() as (v: string) => string;
    for (const name of ['Board International', 'Bürgenstock Hotels & Resort', 'Lidl Schweiz AG', 'Coop', '']) {
      expect(mirror(name)).toBe(baseCompanySlug(name, name));
    }
  });
});

describe('HTTP entrypoint forwards every field the handler accepts (#5012)', () => {
  const index = readRepoFile('functions/index.js');

  it.each(['paused', 'specificCompanyKey', 'specificJobId'])(
    'forwards %s (an accepted-but-never-forwarded field is an inert feature)',
    (field) => {
      expect(index).toContain(`\n ${field},`);
    },
  );
});
