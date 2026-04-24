/**
 * Source-level regression tests for the authenticated job-detail sticky sidebar
 * (docs/revenue-optimization-remaining.md §3c).
 *
 * JobBoard.tsx is the single largest component in the repo (~6500 LOC). Source
 * assertions are the only viable way to guard these placements without making
 * the suite brittle against unrelated refactors.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = readFileSync(
  resolve(__dirname, '../../components/community/JobBoard.tsx'),
  'utf8',
);

describe('JobBoard — sticky sidebar on authenticated job detail', () => {
  it('authenticated detail sidebar uses sticky positioning', () => {
    expect(SOURCE).toMatch(/sticky\s+top-20/);
  });

  it('sidebar renders the primary JOBDETAIL_SIDEBAR ad slot', () => {
    expect(SOURCE).toMatch(/AD_SLOTS\.JOBDETAIL_SIDEBAR\.slot/);
  });

  it('sidebar also renders the secondary JOBDETAIL_SIDEBAR_2 ad slot', () => {
    expect(SOURCE).toMatch(/AD_SLOTS\.JOBDETAIL_SIDEBAR_2\b/);
  });

  it('secondary sidebar slot is mounted only when its id is populated', () => {
    // Guards against rendering an orphan placeholder when the slot is unset
    // in future environments (e.g. experiments disabling JOBDETAIL_SIDEBAR_2).
    expect(SOURCE).toMatch(/AD_SLOTS\.JOBDETAIL_SIDEBAR_2\.slot\s*&&/);
  });
});

describe('JobBoard ad-registry invariants', () => {
  it('both sidebar slots resolve to non-empty numeric ids', async () => {
    const { AD_SLOTS } = await import('@/services/adsenseSlots');
    expect(AD_SLOTS.JOBDETAIL_SIDEBAR.slot).toMatch(/^\d+$/);
    expect(AD_SLOTS.JOBDETAIL_SIDEBAR_2.slot).toMatch(/^\d+$/);
    expect(AD_SLOTS.JOBDETAIL_SIDEBAR.slot).not.toBe(AD_SLOTS.JOBDETAIL_SIDEBAR_2.slot);
  });
});
