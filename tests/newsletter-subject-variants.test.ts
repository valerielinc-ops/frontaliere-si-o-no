import { describe, expect, it } from 'vitest';

const {
  SUBJECT_VARIANTS,
  DEFAULT_VARIANT_ID,
  listVariantIds,
  getSubjectVariant,
  getVariantFallback,
  getVariantStyleDirective,
  normalizeEmail,
} = await import('@/services/newsletter-subject-variants.mjs');

// assignSubjectVariant lives in the server-only module (node:crypto) so the
// variants module stays browser-safe — see newsletter-subject-assign.mjs.
const { assignSubjectVariant } = await import('@/services/newsletter-subject-assign.mjs');

const { buildSubjectPrompt } = await import('@/services/newsletter-content.mjs');

const LOCALES = ['it', 'en', 'de', 'fr'] as const;

describe('SUBJECT_VARIANTS', () => {
  it('defines at least two distinct variants', () => {
    expect(SUBJECT_VARIANTS.length).toBeGreaterThanOrEqual(2);
    const ids = listVariantIds();
    expect(new Set(ids).size).toBe(ids.length); // unique ids
  });

  it('DEFAULT_VARIANT_ID is a real variant', () => {
    expect(getSubjectVariant(DEFAULT_VARIANT_ID)).not.toBeNull();
  });

  for (const variant of SUBJECT_VARIANTS) {
    describe(`variant ${variant.id}`, () => {
      for (const loc of LOCALES) {
        it(`fallback[${loc}] passes inline-QA gates`, () => {
          const subject: string = variant.fallback[loc];
          expect(subject, `missing fallback ${variant.id}/${loc}`).toBeDefined();
          expect(subject.length).toBeGreaterThanOrEqual(10);
          expect(subject.length).toBeLessThanOrEqual(60);
          expect(subject.endsWith('...')).toBe(false);
          expect(subject.endsWith('…')).toBe(false);
          expect(/[\p{L}]{3,}/u.test(subject)).toBe(true);
        });
        it(`styleDirective[${loc}] is non-empty`, () => {
          expect(getVariantStyleDirective(variant.id, loc).length).toBeGreaterThan(10);
        });
      }
    });
  }
});

describe('assignSubjectVariant', () => {
  it('is deterministic for the same (email, campaign)', () => {
    const a = assignSubjectVariant('User@Example.com', 'weekly_2026-06-16');
    const b = assignSubjectVariant('user@example.com', 'weekly_2026-06-16'); // normalized
    const c = assignSubjectVariant(' user@example.com ', 'weekly_2026-06-16');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('only ever returns a known variant id', () => {
    const ids = new Set(listVariantIds());
    for (let i = 0; i < 200; i++) {
      expect(ids.has(assignSubjectVariant(`u${i}@example.com`, 'weekly_2026-06-16'))).toBe(true);
    }
  });

  it('splits the audience across variants (~balanced, no empty bucket)', () => {
    const counts: Record<string, number> = {};
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const v = assignSubjectVariant(`subscriber${i}@frontaliereticino.ch`, 'weekly_2026-06-16');
      counts[v] = (counts[v] || 0) + 1;
    }
    for (const id of listVariantIds()) {
      const share = (counts[id] || 0) / N;
      // 2 variants → ~0.5 each; allow generous tolerance, just no degenerate split.
      expect(share).toBeGreaterThan(0.30);
      expect(share).toBeLessThan(0.70);
    }
  });

  it('rotates buckets across campaigns for at least some subscribers', () => {
    let flipped = 0;
    for (let i = 0; i < 500; i++) {
      const e = `rot${i}@example.com`;
      if (assignSubjectVariant(e, 'weekly_2026-06-09') !== assignSubjectVariant(e, 'weekly_2026-06-16')) flipped++;
    }
    expect(flipped).toBeGreaterThan(50); // not pinned to one bucket forever
  });
});

describe('getVariantFallback', () => {
  it('degrades safely on unknown variant/locale', () => {
    expect(getVariantFallback('does-not-exist', 'it')).toBe(SUBJECT_VARIANTS[0].fallback.it);
    expect(getVariantFallback(SUBJECT_VARIANTS[0].id, 'xx')).toBe(SUBJECT_VARIANTS[0].fallback.it);
  });
});

describe('getVariantStyleDirective', () => {
  it('returns empty string for unknown variant (callers concat unconditionally)', () => {
    expect(getVariantStyleDirective('nope', 'it')).toBe('');
  });
});

describe('buildSubjectPrompt variant injection', () => {
  const baseCtx = { subscriber: { locale: 'it' }, exchangeRate: { rate: 0.94 }, matchedJobs: [] };

  it('injects the variant directive into the system prompt', () => {
    const variantId = SUBJECT_VARIANTS[0].id;
    const { system } = buildSubjectPrompt({ ...baseCtx, variant: variantId });
    expect(system).toContain(getVariantStyleDirective(variantId, 'it'));
  });

  it('leaves the prompt directive-free when no variant is given', () => {
    const { system } = buildSubjectPrompt(baseCtx);
    for (const v of SUBJECT_VARIANTS) {
      expect(system).not.toContain(getVariantStyleDirective(v.id, 'it'));
    }
  });
});

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Foo@Bar.COM ')).toBe('foo@bar.com');
    expect(normalizeEmail(null)).toBe('');
  });
});
