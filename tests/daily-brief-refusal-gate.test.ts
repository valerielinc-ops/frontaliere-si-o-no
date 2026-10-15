// #5714 item 3 — the refusal gate must ask the SAME question the template
// answers ("how many blocks will a recipient actually see"), not trust a
// number the corpus PUBLISHES alongside `brief.blocks` without this repo ever
// deriving it from those blocks. Before this fix `loadDayPayload()` read
// `brief.counts.availableBlocks` verbatim: an inflated claim could let a
// near-empty edition past the "too thin" refusal, and a deflated claim could
// needlessly skip a send that had real content. `briefSections()` is the SAME
// function `daily-brief-template.mjs` calls to decide what to print, so
// counting its output is asking the render itself, not a second opinion of it.
import { describe, expect, it, vi } from 'vitest';

import { loadDayPayload } from '@/scripts/send-daily-brief.mjs';

const MANIFEST = { counts: { dailyBriefBlocks: 40 } };
const EDITION_ID = 'bollettino-frontaliere-2026-08-13';
const SLUGS = { blog: { [EDITION_ID]: { it: EDITION_ID, en: EDITION_ID, de: EDITION_ID, fr: EDITION_ID } } };

/** All four blocks genuinely renderable — the "everything is fine" baseline. */
const fullBrief = (overrides = {}) => ({
  dateIso: '2026-08-13',
  counts: { availableBlocks: 4 },
  blocks: {
    borderWait: { available: true, count: 10, zeroWaitCount: 5, worst: { name: 'Chiasso', waitMinutes: 3 } },
    fuel: { available: true, cheapestItaly: [{ municipality: 'Livigno', minPriceEur: 1.5 }], bestSavings: [] },
    exchange: { available: true, rate: 1.07, prevRate: 1.07, delta1d: 0 },
    jobs: { available: true, activeJobs: 100, activeCompanies: 10, yesterdayAdded: 5 },
  },
  ...overrides,
});

function fetchImplFor(brief: any) {
  return async (name: string) => {
    if (name === 'manifest.json') return MANIFEST;
    if (name === 'daily-brief.json') return brief;
    if (name === 'slugs.json') return SLUGS;
    throw new Error(`unexpected fetch ${name}`);
  };
}

describe('loadDayPayload reconciles counts.availableBlocks with what briefSections() actually renders (#5714 item 3)', () => {
  it('refuses on an INFLATED claim: payload says 4, only 1 block can actually render', async () => {
    const brief = fullBrief({
      counts: { availableBlocks: 4 }, // the corpus's claim — wrong on purpose
      blocks: {
        borderWait: { available: false, reason: 'not enough data' },
        fuel: { available: false },
        exchange: { available: true, rate: 1.07, prevRate: 1.07, delta1d: 0 },
        jobs: { available: false },
      },
    });
    const { refusal } = await loadDayPayload('2026-08-13', { fetchImpl: fetchImplFor(brief) });
    expect(refusal).not.toBeNull();
    expect(refusal).toMatch(/too thin/);
    expect(refusal).toMatch(/^only 1 available blocks actually render/);
  });

  it('does NOT refuse on a DEFLATED claim: payload says 1, but the template really renders all 4', async () => {
    const brief = fullBrief({ counts: { availableBlocks: 1 } }); // the corpus's claim — wrong on purpose
    const { refusal, brief: returned } = await loadDayPayload('2026-08-13', { fetchImpl: fetchImplFor(brief) });
    expect(refusal).toBeNull();
    expect(returned?.counts?.availableBlocks).toBe(4);
  });

  it('overwrites brief.counts.availableBlocks with the rendered count, so every downstream reader in this file agrees', async () => {
    // applyCadence() (scripts/send-daily-brief.mjs) reads brief.counts.availableBlocks
    // straight off the SAME object this function returns — it has no call site
    // of its own to fix, which is the point: reconciling once, at the source,
    // means a second consumer cannot reintroduce the divergence by omission.
    const brief = fullBrief({
      counts: { availableBlocks: 4 },
      blocks: {
        borderWait: { available: true, count: 10, zeroWaitCount: 5, worst: { name: 'Chiasso', waitMinutes: 3 } },
        fuel: { available: false },
        exchange: { available: true, rate: 1.07, prevRate: 1.07, delta1d: 0 },
        jobs: { available: false },
      },
    });
    const { brief: returned } = await loadDayPayload('2026-08-13', { fetchImpl: fetchImplFor(brief) });
    expect(returned?.counts?.availableBlocks).toBe(2); // borderWait + exchange only
  });

  it('agrees when the payload is honest: no divergence, no surprise refusal', async () => {
    const brief = fullBrief();
    const { refusal, brief: returned } = await loadDayPayload('2026-08-13', { fetchImpl: fetchImplFor(brief) });
    expect(refusal).toBeNull();
    expect(returned?.counts?.availableBlocks).toBe(4);
  });

  it('logs the divergence instead of failing silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const brief = fullBrief({
        counts: { availableBlocks: 4 },
        blocks: { ...fullBrief().blocks, borderWait: { available: false } }, // only 3 really render
      });
      await loadDayPayload('2026-08-13', { fetchImpl: fetchImplFor(brief) });
      expect(warn.mock.calls.some((call) => String(call[0]).includes('disagrees'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
