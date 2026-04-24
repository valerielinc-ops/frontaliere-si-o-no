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

describe('JobBoard — ItemList JSON-LD (docs/seo-action-plan-apr2026.md)', () => {
  it('builds an ItemList schema on the list view (skipped on detail)', () => {
    expect(SOURCE).toMatch(/ITEMLIST_ID\s*=\s*['"]jobboard-itemlist-jsonld['"]/);
    expect(SOURCE).toMatch(/@type['"]:\s*['"]ItemList['"]/);
    expect(SOURCE).toMatch(/@type['"]:\s*['"]ListItem['"]/);
    expect(SOURCE).toMatch(/itemListElement/);
    expect(SOURCE).toMatch(/numberOfItems/);
  });

  it('skips injection on the detail view', () => {
    // The effect must early-return when selectedJob or initialJobSlug is set.
    expect(SOURCE).toMatch(/if\s*\(selectedJob\s*\|\|\s*initialJobSlug\)/);
  });

  it('caps the list at 20 items to keep the payload small', () => {
    expect(SOURCE).toMatch(/MAX_ITEMS\s*=\s*20/);
  });

  it('cleans up the injected <script> on effect teardown', () => {
    expect(SOURCE).toMatch(/getElementById\(ITEMLIST_ID\)/);
  });

  it('localizes list-item URLs via buildPath + locale', () => {
    // Sanity: the effect must call buildPath with the locale argument so the
    // emitted URLs match the canonical per-locale slug.
    const itemListBlock = SOURCE.split('jobboard-itemlist-jsonld')[1] ?? '';
    expect(itemListBlock).toMatch(/buildPath\(/);
    expect(itemListBlock).toMatch(/deriveLocalizedJobSlug\(job,\s*locale\)/);
  });
});
