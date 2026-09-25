/**
 * SEO Description Length Test — Ensures meta descriptions are within Google's display limits.
 *
 * Google typically truncates meta descriptions outside ~155-160 characters.
 * This test enforces:
 *   - HARD limits: 80-170 characters (test FAILS outside this range)
 *   - SOFT limits: 130-165 characters (test WARNS outside this range)
 *
 * Run: npx vitest run tests/seo-description-length.test.ts
 */
import { describe, it, expect, vi } from 'vitest';

// Import SEO_METADATA bypassing the global mock from setup.tsx
const { getAllSeoMetadata } = await vi.importActual<typeof import('@/services/seoService')>('@/services/seoService');
const SEO_METADATA = await getAllSeoMetadata();

// ── Thresholds ────────────────────────────────────────────────────────────────

const HARD_MIN = 80;
const HARD_MAX = 170;
const SOFT_MIN = 130;
const SOFT_MAX = 165;

// ── Test ──────────────────────────────────────────────────────────────────────

describe('SEO meta description length', () => {
  const entries = Object.entries(SEO_METADATA);

  it('should have SEO metadata entries to validate', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it(`all descriptions must be between ${HARD_MIN} and ${HARD_MAX} characters`, () => {
    const tooShort: { key: string; len: number }[] = [];
    const tooLong: { key: string; len: number }[] = [];
    const softWarnings: { key: string; len: number; issue: string }[] = [];

    for (const [key, meta] of entries) {
      const desc = (meta as any).description;
      if (!desc || typeof desc !== 'string') continue;

      const len = desc.length;

      // Hard-limit violations → will fail the test
      if (len < HARD_MIN) {
        tooShort.push({ key, len });
      } else if (len > HARD_MAX) {
        tooLong.push({ key, len });
      }

      // Soft-limit violations → warn only
      if (len >= HARD_MIN && len < SOFT_MIN) {
        softWarnings.push({ key, len, issue: `short (${len} < ${SOFT_MIN})` });
      } else if (len > SOFT_MAX && len <= HARD_MAX) {
        softWarnings.push({ key, len, issue: `long (${len} > ${SOFT_MAX})` });
      }
    }

    // Emit soft warnings (do not fail)
    if (softWarnings.length > 0) {
      console.warn(
        `\n⚠️  ${softWarnings.length} descriptions outside ideal ${SOFT_MIN}-${SOFT_MAX} range:\n` +
          softWarnings
            .slice(0, 20)
            .map(w => `   ${w.key}: ${w.len} chars (${w.issue})`)
            .join('\n') +
          (softWarnings.length > 20 ? `\n   ... and ${softWarnings.length - 20} more` : ''),
      );
    }

    // Hard-limit failures
    const failures: string[] = [];
    if (tooShort.length > 0) {
      failures.push(
        `${tooShort.length} descriptions too short (< ${HARD_MIN} chars):\n` +
          tooShort.map(e => `  ${e.key}: ${e.len} chars`).join('\n'),
      );
    }
    if (tooLong.length > 0) {
      failures.push(
        `${tooLong.length} descriptions too long (> ${HARD_MAX} chars):\n` +
          tooLong.map(e => `  ${e.key}: ${e.len} chars`).join('\n'),
      );
    }

    if (failures.length > 0) {
      expect.fail(failures.join('\n\n'));
    }
  });
});
