/**
 * Closes review ❓s left open by the slug-pin PRs:
 *  1. fingerprintJob URL→registry-key derivation
 *     (id|recruitingapp-<tenant>.umantis.com|<id> — per-tenant full host since
 *     the 2026-07-11 cross-tenant collision fix) — the mapping the
 *     harden/merge pins rely on, previously only assumed.
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
  // Umantis vacancy ids are PER-TENANT sequences: since the cross-tenant
  // collision fix (extractJobIdentityFromUrl keys on the FULL
  // recruitingapp-<tenant>.umantis.com host, mirroring the Workday rule and
  // mergeUrlKey Rule U), two employers sharing a vacancy number no longer
  // collapse onto one registry entry.
  it('derives id|recruitingapp-<tenant>.umantis.com|<id> from a umantis vacancy URL', () => {
    const fp = fingerprintJob({
      url: 'https://recruitingapp-2908.umantis.com/Vacancies/3164/Description/1',
    });
    expect(fp).toBe('id|recruitingapp-2908.umantis.com|3164');
  });

  it('is stable across the trailing path of the same vacancy, distinct across tenants', () => {
    const a = fingerprintJob({ url: 'https://recruitingapp-2908.umantis.com/Vacancies/3164/Description/1' });
    const b = fingerprintJob({ url: 'https://recruitingapp-2908.umantis.com/Vacancies/3164/Application' });
    const otherTenant = fingerprintJob({ url: 'https://recruitingapp-9999.umantis.com/Vacancies/3164/Application' });
    expect(a).toBe(b);
    expect(a).toBe('id|recruitingapp-2908.umantis.com|3164');
    // Same vacancy NUMBER on a different tenant is a DIFFERENT job — the exact
    // cross-tenant collision (GKB vs KSA) the full-host keying exists to prevent.
    expect(otherTenant).toBe('id|recruitingapp-9999.umantis.com|3164');
    expect(otherTenant).not.toBe(a);
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
      .toBe('id|recruitingapp-2908.umantis.com|3164');
    expect(fingerprintJob({ url: 'https://example.com/jobs/123456' }))
      .toBe('id|example.com|123456');
  });

  it('keys a numeric-then-text id by the leading number (not collapsed by the UUID guard)', () => {
    // teamtailor `7887338-projektleiter`, hilti `17627-fr` — the digits ARE the
    // stable id; the leaf is not UUID-shaped so the numeric path rule still wins.
    expect(fingerprintJob({ url: 'https://ckw.teamtailor.com/jobs/7887338-projektleiter-in' }))
      .toBe('id|teamtailor.com|7887338');
    expect(fingerprintJob({ url: 'https://careers.hilti.group/en/jobs/17627-fr/conseiller' }))
      .toBe('id|hilti.group|17627');
  });

  it('keys an ancestor+leaf double-UUID URL by the LEAF (per-job) UUID, not the shared ancestor', () => {
    // cseb shape `…/job-advertisement/<board-uuid>/<job-uuid>`: a blind first-UUID
    // scan of the whole URL would grab the shared board uuid and collapse every
    // cseb job onto one key. Leaf-scoped extraction keeps siblings distinct.
    const a = fingerprintJob({ url: 'https://www.cseb.ch/job-advertisement/aaaaaaaa-1111-4111-8111-111111111111/bbbbbbbb-2222-4222-8222-222222222222' });
    const b = fingerprintJob({ url: 'https://www.cseb.ch/job-advertisement/aaaaaaaa-1111-4111-8111-111111111111/cccccccc-3333-4333-8333-333333333333' });
    expect(a).toBe('id|cseb.ch|bbbbbbbb-2222-4222-8222-222222222222');
    expect(b).toBe('id|cseb.ch|cccccccc-3333-4333-8333-333333333333');
    expect(a).not.toBe(b);
  });

  // #3257: jobs.solina.ch is `/offene-stellen/{category}/details/{hash}` — 3
  // path segments after `offene-stellen/`. The unanchored coop-path rule
  // matched the FIRST 2 segments in from any depth, so it captured the
  // constant literal "details" (the segment right after the category) for
  // every job, regardless of category or hash. All 23 live Solina jobs
  // fingerprinted identically and collapsed onto ONE entry during merge,
  // tripping the 23→1 shrink guard.
  it('#3257: does not collapse Solina TYPO3 jobs onto the literal "details" segment', () => {
    const a = fingerprintJob({ url: 'https://jobs.solina.ch/offene-stellen/pflege-betreuung/details/abc123' });
    const b = fingerprintJob({ url: 'https://jobs.solina.ch/offene-stellen/pflege-betreuung/details/def456' });
    const c = fingerprintJob({ url: 'https://jobs.solina.ch/offene-stellen/hotellerie-gastronomie/details/ghi789' });
    expect(a).not.toBe('id|solina.ch|details');
    expect(a).toBe('id|solina.ch|abc123');
    expect(b).toBe('id|solina.ch|def456');
    expect(c).toBe('id|solina.ch|ghi789');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('still keys the flat 2-segment `/offene-stellen/{leaf}/{id}` shape (gemeinde-st-moritz)', () => {
    // gemeinde-st-moritz genuinely terminates 2 segments after `offene-stellen/`
    // (`/aktuelles/aktuelles/offene-stellen/detail/{slug}`) — must keep working
    // via the same (now anchored) coop-path rule since there is no 3rd segment.
    const a = fingerprintJob({ url: 'https://www.gemeinde-stmoritz.ch/aktuelles/aktuelles/offene-stellen/detail/pflegefachperson-fa' });
    const b = fingerprintJob({ url: 'https://www.gemeinde-stmoritz.ch/aktuelles/aktuelles/offene-stellen/detail/lehrperson-primar' });
    expect(a).toBe('id|gemeinde-stmoritz.ch|pflegefachperson-fa');
    expect(b).toBe('id|gemeinde-stmoritz.ch|lehrperson-primar');
    expect(a).not.toBe(b);
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
    expect((registry['id|recruitingapp-1.umantis.com|100'] as { canonicalSlug: string }).canonicalSlug).toBe('first-slug');
  });

  it('does NOT enforce global per-locale uniqueness across fingerprints', () => {
    const registry: Record<string, unknown> = {};
    // Two DISTINCT jobs (different fingerprints) registering the SAME en slug.
    registerJobSlug({ url: 'https://recruitingapp-1.umantis.com/Vacancies/100/Description/1', slug: 'a-it', slugByLocale: { it: 'a-it', en: 'shared-en' } }, registry);
    registerJobSlug({ url: 'https://recruitingapp-1.umantis.com/Vacancies/200/Description/1', slug: 'b-it', slugByLocale: { it: 'b-it', en: 'shared-en' } }, registry);
    // Both are registered; the duplicate en slug is NOT rejected at registration.
    // (Cross-job per-locale uniqueness is enforced downstream, not here.)
    expect(Object.keys(registry)).toHaveLength(2);
    expect((registry['id|recruitingapp-1.umantis.com|100'] as { slugByLocale: Record<string, string> }).slugByLocale.en).toBe('shared-en');
    expect((registry['id|recruitingapp-1.umantis.com|200'] as { slugByLocale: Record<string, string> }).slugByLocale.en).toBe('shared-en');
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
