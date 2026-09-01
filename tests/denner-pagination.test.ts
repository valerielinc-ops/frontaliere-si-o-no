import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { launchChromiumMock } = vi.hoisted(() => ({ launchChromiumMock: vi.fn() }));
vi.mock('../scripts/lib/ensure-chromium.mjs', () => ({
  launchChromium: launchChromiumMock,
}));

import { fetchDennerJobUrls, main as runDennerCrawler } from '../scripts/update-denner-jobs.mjs';
import { fetchMigrolinoListingHrefs } from '../scripts/lib/migrolino-job-parser.mjs';
import { crawlerScratchPathFor } from '../scripts/lib/crawler-scratch-path.mjs';

afterEach(() => {
  launchChromiumMock.mockReset();
  delete process.env.JOBS_DENNER_PAGINATION_TIMEOUT_MS;
  delete process.env.JOBS_DENNER_PAGINATION_STALL_POLLS;
  delete process.env.JOBS_MIGROLINO_PAGINATION_TIMEOUT_MS;
  delete process.env.JOBS_MIGROLINO_PAGINATION_STALL_POLLS;
  vi.restoreAllMocks();
});

function mockStalledBrowser(detailHref: string, clickError?: Error) {
  const consent = {
    isVisible: vi.fn().mockResolvedValue(false),
  };
  const nextButton = {
    isVisible: vi.fn().mockResolvedValue(true),
    isDisabled: vi.fn().mockResolvedValue(false),
    scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
    click: clickError
      ? vi.fn().mockRejectedValue(clickError)
      : vi.fn().mockResolvedValue(undefined),
  };
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue([detailHref]),
    locator: vi.fn((selector: string) => ({
      first: () => selector.includes('Akzeptieren') ? consent : nextButton,
    })),
  };
  launchChromiumMock.mockResolvedValue({
    newContext: vi.fn().mockResolvedValue({
      newPage: vi.fn().mockResolvedValue(page),
    }),
    close: vi.fn().mockResolvedValue(undefined),
  });
  return nextButton;
}

describe('Denner Playwright pagination', () => {
  it('rejects a non-authoritative snapshot when pagination stalls', async () => {
    process.env.JOBS_DENNER_PAGINATION_TIMEOUT_MS = '1';
    process.env.JOBS_DENNER_PAGINATION_STALL_POLLS = '1';

    const detailHref = '/it/le-nostre-imprese/job/denner-sa/vendita/example-id';
    mockStalledBrowser(detailHref);

    await expect(fetchDennerJobUrls()).rejects.toThrow(
      'Denner discovery incomplete: page 2 stalled',
    );
  });

  it('preserves an existing job route when the stalled crawl aborts', async () => {
    process.env.JOBS_DENNER_PAGINATION_TIMEOUT_MS = '1';
    process.env.JOBS_DENNER_PAGINATION_STALL_POLLS = '1';
    const scratchPath = crawlerScratchPathFor('denner');
    const previous = fs.existsSync(scratchPath) ? fs.readFileSync(scratchPath, 'utf8') : null;
    const existing = JSON.stringify([{
      id: 'denner-existing',
      slug: 'existing-denner-route',
      company: 'Denner',
      companyKey: 'denner',
      url: 'https://jobs.migros.ch/it/le-nostre-imprese/job/denner-sa/existing/existing-id',
    }]);
    fs.writeFileSync(scratchPath, existing);
    mockStalledBrowser('/it/le-nostre-imprese/job/denner-sa/vendita/new-id');

    try {
      await expect(runDennerCrawler()).rejects.toThrow('Denner discovery incomplete');
      expect(fs.readFileSync(scratchPath, 'utf8')).toBe(existing);
    } finally {
      if (previous == null) fs.rmSync(scratchPath, { force: true });
      else fs.writeFileSync(scratchPath, previous);
    }
  });

  it('rejects a Denner snapshot when the next-page click fails', async () => {
    const detailHref = '/it/le-nostre-imprese/job/denner-sa/vendita/example-id';
    mockStalledBrowser(detailHref, new Error('detached'));

    await expect(fetchDennerJobUrls()).rejects.toThrow(
      'Denner discovery incomplete at page 1: next control click failed (detached)',
    );
  });

  it('rejects the sibling migrolino snapshot instead of stopping silently', async () => {
    process.env.JOBS_MIGROLINO_PAGINATION_TIMEOUT_MS = '1';
    process.env.JOBS_MIGROLINO_PAGINATION_STALL_POLLS = '1';
    const detailHref = '/de/unsere-unternehmen/job/migrolino/verkauf/00000000-0000-4000-8000-000000000001';
    mockStalledBrowser(detailHref);

    await expect(fetchMigrolinoListingHrefs()).rejects.toThrow(
      'migrolino discovery incomplete: page 2 stalled',
    );
  });

  it('rejects a migrolino snapshot when the next-page click fails', async () => {
    const detailHref = '/de/unsere-unternehmen/job/migrolino/verkauf/00000000-0000-4000-8000-000000000001';
    mockStalledBrowser(detailHref, new Error('detached'));

    await expect(fetchMigrolinoListingHrefs()).rejects.toThrow(
      'migrolino discovery incomplete at page 1: next control click failed (detached)',
    );
  });
});
