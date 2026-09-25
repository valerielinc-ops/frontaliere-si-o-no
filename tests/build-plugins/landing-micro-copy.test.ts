import { describe, it, expect } from 'vitest';
import {
  pickEmptyState,
  pickCtaAllJobs,
  EMPTY_FEATURED_JOBS,
  CTA_ALL_JOBS,
} from '../../build-plugins/shared/landingMicroCopy';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;

describe('landingMicroCopy length budget', () => {
  it('every empty-state message ≤140 chars', () => {
    for (const loc of LOCALES) {
      for (const msg of EMPTY_FEATURED_JOBS[loc]) {
        expect(msg.length, `empty/${loc}: "${msg}"`).toBeLessThanOrEqual(140);
      }
    }
  });

  it('every CTA, rendered with N=99, ≤80 chars', () => {
    for (const loc of LOCALES) {
      for (const tpl of CTA_ALL_JOBS[loc]) {
        const out = tpl(99);
        expect(out.length, `cta/${loc}: "${out}"`).toBeLessThanOrEqual(80);
        expect(out, `cta/${loc} missing N`).toContain('99');
      }
    }
  });
});

describe('deterministic selection', () => {
  it('same (id, locale) always picks same empty message', () => {
    const a = pickEmptyState('educatore', 'it');
    const b = pickEmptyState('educatore', 'it');
    expect(a).toBe(b);
  });

  it('same (id, locale, count) always picks same CTA', () => {
    const a = pickCtaAllJobs('educatore', 'it', 47);
    const b = pickCtaAllJobs('educatore', 'it', 47);
    expect(a).toBe(b);
    expect(a).toContain('47');
  });

  it('different ids may pick different messages (variety check)', () => {
    const ids = ['infermiere', 'operaio', 'impiegato', 'ingegnere', 'educatore', 'autista', 'muratore', 'cuoco', 'cameriere', 'elettricista'];
    const picks = new Set(ids.map((id) => pickEmptyState(id, 'it')));
    expect(picks.size, 'expected at least 2 distinct empty messages across 10 ids').toBeGreaterThanOrEqual(2);
  });
});
