/**
 * scripts/migrate-umantis-registry-fingerprints.mjs — pure-function coverage.
 *
 * The umantis identity fix (extractJobIdentityFromUrl keys on the full tenant
 * host) orphans every persisted `id|umantis.com|<vid>` slug-registry entry.
 * The migration rewrites healthy entries under the owner tenant's full-host
 * key, splits contested vacancy ids per tenant when values are unambiguous,
 * and drops ambiguous pins for the writer guards to re-register.
 */
import { describe, expect, it } from 'vitest';
import {
  migrateUmantisRegistry,
  buildUmantisJobIndex,
} from '../scripts/migrate-umantis-registry-fingerprints.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Candidate = { tenant: string; file: string; slugSet: Set<string>; companyTokens: Set<string> };

function index(entries: Array<[string, Candidate[]]>) {
  return new Map(entries);
}

const cand = (tenant: string, slugs: string[], company = ''): Candidate => ({
  tenant,
  file: 'x.json',
  slugSet: new Set(slugs),
  companyTokens: new Set(
    company.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4),
  ),
});

describe('migrateUmantisRegistry', () => {
  it('migrates a single-owner entry whole to the full-host key, preserving createdAt', () => {
    const registry = {
      'id|umantis.com|5105': {
        canonicalSlug: 'dipl-pflegefachfrau-pflegefachmann-ksa-ch',
        canton: 'AG',
        createdAt: '2026-04-13',
        slugByLocale: { de: 'dipl-pflegefachfrau-pflegefachmann-ksa-ch' },
      },
      'id|example.com|1': { canonicalSlug: 'untouched', canton: 'TI', createdAt: '2026-01-01' },
    };
    const idx = index([
      ['5105', [cand('122706', ['dipl-pflegefachfrau-pflegefachmann-ksa-ch'], 'Kantonsspital Aarau (KSA)')]],
    ]);
    const { registry: out, stats } = migrateUmantisRegistry(registry, idx);
    expect(out['id|umantis.com|5105']).toBeUndefined();
    expect(out['id|recruitingapp-122706.umantis.com|5105']).toEqual(registry['id|umantis.com|5105']);
    expect(out['id|recruitingapp-122706.umantis.com|5105'].createdAt).toBe('2026-04-13');
    expect(out['id|example.com|1']).toEqual(registry['id|example.com|1']);
    expect(stats.migratedWhole).toBe(1);
    expect(stats.contested).toBe(0);
  });

  it('migrates a drifted entry to the only candidate tenant even when no slug matches', () => {
    const registry = {
      'id|umantis.com|42': {
        canonicalSlug: 'totally-drifted-slug', canton: 'TI', createdAt: '2026-02-02', slugByLocale: {},
      },
    };
    const idx = index([['42', [cand('2607', ['current-live-slug'], 'GKB')]]]);
    const { registry: out, stats } = migrateUmantisRegistry(registry, idx);
    expect(out['id|recruitingapp-2607.umantis.com|42']).toBeDefined();
    expect(stats.migratedWhole).toBe(1);
  });

  it('splits a contested vacancy id per tenant and drops ambiguous pins (GKB vs KSA incident shape)', () => {
    // Mixed poisoned entry: canonical+de belong to tenant A, it belongs to tenant B,
    // fr belongs to nobody (stale) → A gets a split entry, B gets one too, fr dropped.
    const registry = {
      'id|umantis.com|1910': {
        canonicalSlug: 'immobilienbewerter-in-80-100-graubundner-kantonalbank-chur',
        canton: 'GR',
        createdAt: '2026-04-13',
        slugByLocale: {
          de: 'immobilienbewerter-in-80-100-graubundner-kantonalbank-chur',
          it: 'pflegefachfrau-pflegefachmann-in-ausbildung-zusatzmodul-b-oder-c-ksa-ch',
          fr: 'stale-slug-owned-by-nobody',
        },
      },
    };
    const idx = index([
      ['1910', [
        cand('2607', ['immobilienbewerter-in-80-100-graubundner-kantonalbank-chur'], 'Graubündner Kantonalbank'),
        cand('122706', ['pflegefachfrau-pflegefachmann-in-ausbildung-zusatzmodul-b-oder-c-ksa-ch'], 'Kantonsspital Aarau (KSA)'),
      ]],
    ]);
    const { registry: out, stats } = migrateUmantisRegistry(registry, idx);
    expect(out['id|umantis.com|1910']).toBeUndefined();
    // GKB side keeps canonical + its own de pin
    expect(out['id|recruitingapp-2607.umantis.com|1910']).toMatchObject({
      canonicalSlug: 'immobilienbewerter-in-80-100-graubundner-kantonalbank-chur',
      slugByLocale: { de: 'immobilienbewerter-in-80-100-graubundner-kantonalbank-chur' },
    });
    // KSA side is dropped (canonicalSlug not attributable to it) — guards re-register
    expect(out['id|recruitingapp-122706.umantis.com|1910']).toBeUndefined();
    expect(stats.contested).toBe(1);
    expect(stats.splitEntriesCreated).toBe(1);
    expect(stats.droppedPinValues).toBeGreaterThanOrEqual(1); // the stale fr pin
  });

  it('breaks slice-membership ties with company tokens (poisoned copy present in both slices)', () => {
    const registry = {
      'id|umantis.com|5447': {
        canonicalSlug: 'manutenzione-stradale-artigianale-100-kanton-aargau-aarau',
        canton: 'AG',
        createdAt: '2026-06-01',
        slugByLocale: { it: 'manutenzione-stradale-artigianale-100-kanton-aargau-aarau' },
      },
    };
    // The poisoned KSA job still lists the aargau slug in its slugSet, but the
    // slug text names Kanton Aargau — the tie-break assigns it there.
    const idx = index([
      ['5447', [
        cand('12705', ['manutenzione-stradale-artigianale-100-kanton-aargau-aarau'], 'Kanton Aargau'),
        cand('122706', ['manutenzione-stradale-artigianale-100-kanton-aargau-aarau'], 'Kantonsspital Aarau (KSA)'),
      ]],
    ]);
    const { registry: out } = migrateUmantisRegistry(registry, idx);
    expect(out['id|recruitingapp-12705.umantis.com|5447']).toBeDefined();
    expect(out['id|recruitingapp-122706.umantis.com|5447']).toBeUndefined();
  });

  it('leaves orphan entries (vacancy id in no slice) untouched under the old inert key', () => {
    const registry = {
      'id|umantis.com|9999': { canonicalSlug: 'gone-job', canton: 'TI', createdAt: '2026-03-03' },
    };
    const { registry: out, stats } = migrateUmantisRegistry(registry, index([]));
    expect(out['id|umantis.com|9999']).toEqual(registry['id|umantis.com|9999']);
    expect(stats.orphansLeft).toBe(1);
  });

  it('never overwrites an existing (immutable) destination entry', () => {
    const registry = {
      'id|umantis.com|7': { canonicalSlug: 'old-form', canton: 'TI', createdAt: '2026-01-01' },
      'id|recruitingapp-111.umantis.com|7': { canonicalSlug: 'post-fix-form', canton: 'TI', createdAt: '2026-07-10' },
    };
    const idx = index([['7', [cand('111', ['old-form'], 'Acme')]]]);
    const { registry: out, stats } = migrateUmantisRegistry(registry, idx);
    expect(out['id|recruitingapp-111.umantis.com|7'].canonicalSlug).toBe('post-fix-form');
    expect(out['id|umantis.com|7']).toBeUndefined();
    expect(stats.destConflicts).toBe(1);
  });
});

describe('buildUmantisJobIndex', () => {
  it('indexes active + expired slices by vacancy id with tenant and full slug set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'umantis-idx-'));
    fs.writeFileSync(path.join(dir, 'ksa.json'), JSON.stringify({
      jobs: [{
        url: 'https://recruitingapp-122706.umantis.com/Vacancies/1910/Application/CheckLogin/1',
        company: 'Kantonsspital Aarau (KSA)',
        slug: 'active-slug',
        slugByLocale: { de: 'de-slug' },
        previousSlugs: ['old-slug'],
        previousSlugsByLocale: { it: ['old-it-slug'] },
      }],
    }));
    const idx = buildUmantisJobIndex([dir]);
    expect(idx.size).toBe(1);
    const [c] = idx.get('1910')!;
    expect(c.tenant).toBe('122706');
    for (const s of ['active-slug', 'de-slug', 'old-slug', 'old-it-slug']) {
      expect(c.slugSet.has(s)).toBe(true);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
