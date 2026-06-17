/**
 * Closes review ❓s left open by the slug-pin PRs:
 *  1. fingerprintJob URL→registry-key derivation (id|umantis.com|<id>) — the
 *     mapping the harden/merge pins rely on, previously only assumed.
 *  2. registerJobSlug does NOT enforce GLOBAL per-locale slug uniqueness across
 *     fingerprints — it is per-fingerprint immutable only. Documents that
 *     cross-job per-locale uniqueness is a downstream concern (usedSlugs in
 *     mergeAndDeduplicate / regenerate-slugs), not a registration guarantee.
 *  3. registryPinnedLocaleSlug's source-copy decision is fully governed by the
 *     passed sourceLang — a mislabeled source flips the over/under-pin outcome.
 */
import { describe, expect, it } from 'vitest';
import {
  fingerprintJob,
  registerJobSlug,
  registryPinnedLocaleSlug,
} from '../scripts/lib/dedicated-crawler-common.mjs';

describe('fingerprintJob → registry key', () => {
  it('derives id|umantis.com|<id> from a umantis vacancy URL', () => {
    const fp = fingerprintJob({
      url: 'https://recruitingapp-2908.umantis.com/Vacancies/3164/Description/1',
    });
    expect(fp).toBe('id|umantis.com|3164');
  });

  it('is stable across the subdomain / trailing path of the same vacancy', () => {
    const a = fingerprintJob({ url: 'https://recruitingapp-2908.umantis.com/Vacancies/3164/Description/1' });
    const b = fingerprintJob({ url: 'https://recruitingapp-9999.umantis.com/Vacancies/3164/Application' });
    expect(a).toBe(b);
    expect(a).toBe('id|umantis.com|3164');
  });

  it('falls back to a tl| signature when the URL has no extractable identity', () => {
    const fp = fingerprintJob({ url: '', title: 'Nurse', location: 'Bern', company: 'X' });
    expect(fp.startsWith('tl|')).toBe(true);
  });

  // #2330 item 1: a full UUID slug must NOT collapse onto its leading-digit
  // prefix. Previously `/\/jobs\/(\d+)/` captured `69` from
  // `…/jobs/69b0fccf-…`, collapsing every prospective.ch UUID job sharing that
  // digit run onto ONE registry key (`prospective.ch|69`) — cross-job slug
  // contamination via registryPinnedLocaleSlug.
  it('keys a /jobs/<uuid> URL by the full UUID, not its leading digit prefix', () => {
    const a = fingerprintJob({ url: 'https://ohws.prospective.ch/public/v1/jobs/69b0fccf-bb38-4f6a-b75d-1f4b21e776a0' });
    const b = fingerprintJob({ url: 'https://ohws.prospective.ch/public/v1/jobs/69a1b2c3-1111-4f6a-b75d-aaaaaaaaaaaa' });
    expect(a).toBe('id|prospective.ch|69b0fccf-bb38-4f6a-b75d-1f4b21e776a0');
    expect(a).not.toBe('id|prospective.ch|69');
    // Two distinct UUID jobs sharing a leading-digit prefix stay distinct.
    expect(a).not.toBe(b);
  });

  it('still keys a plain numeric vacancy id (no UUID present) by that number', () => {
    expect(fingerprintJob({ url: 'https://recruitingapp-2908.umantis.com/Vacancies/3164/Description/1' }))
      .toBe('id|umantis.com|3164');
    expect(fingerprintJob({ url: 'https://example.com/jobs/123456' }))
      .toBe('id|example.com|123456');
  });
});

describe('registerJobSlug', () => {
  it('is per-fingerprint immutable — never overwrites an existing entry', () => {
    const registry: Record<string, unknown> = {};
    const job = {
      url: 'https://recruitingapp-1.umantis.com/Vacancies/100/Description/1',
      slug: 'first-slug',
      slugByLocale: { it: 'first-slug', en: 'first-en' },
    };
    registerJobSlug(job, registry);
    registerJobSlug({ ...job, slug: 'second-slug', slugByLocale: { it: 'second-slug', en: 'second-en' } }, registry);
    expect((registry['id|umantis.com|100'] as { canonicalSlug: string }).canonicalSlug).toBe('first-slug');
  });

  it('does NOT enforce global per-locale uniqueness across fingerprints', () => {
    const registry: Record<string, unknown> = {};
    // Two DISTINCT jobs (different fingerprints) registering the SAME en slug.
    registerJobSlug({ url: 'https://recruitingapp-1.umantis.com/Vacancies/100/Description/1', slug: 'a-it', slugByLocale: { it: 'a-it', en: 'shared-en' } }, registry);
    registerJobSlug({ url: 'https://recruitingapp-1.umantis.com/Vacancies/200/Description/1', slug: 'b-it', slugByLocale: { it: 'b-it', en: 'shared-en' } }, registry);
    // Both are registered; the duplicate en slug is NOT rejected at registration.
    // (Cross-job per-locale uniqueness is enforced downstream, not here.)
    expect(Object.keys(registry)).toHaveLength(2);
    expect((registry['id|umantis.com|100'] as { slugByLocale: Record<string, string> }).slugByLocale.en).toBe('shared-en');
    expect((registry['id|umantis.com|200'] as { slugByLocale: Record<string, string> }).slugByLocale.en).toBe('shared-en');
  });
});

describe('registryPinnedLocaleSlug — sourceLang sensitivity', () => {
  // Registry where the EN slot is a byte copy of the DE (source) slot — i.e. no
  // real EN translation was registered (a pre-localization entry).
  const sourceCopyReg = { slugByLocale: { de: 'pflegefachperson-spital', en: 'pflegefachperson-spital' } };

  it('correctly detects the source copy and does NOT pin when sourceLang is right', () => {
    expect(registryPinnedLocaleSlug(sourceCopyReg, 'en', 'de')).toBeNull();
  });

  it('OVER-pins the source copy when sourceLang is mislabeled', () => {
    // Mislabeled source 'it': regSrc = registry.it (absent) → source-copy guard
    // cannot fire → the EN source-copy is wrongly treated as a real translation.
    // Documents why correct titleSourceLang detection matters for the guard.
    expect(registryPinnedLocaleSlug(sourceCopyReg, 'en', 'it')).toBe('pflegefachperson-spital');
  });
});
