import { afterEach, describe, expect, it, vi } from 'vitest';

const { launchChromiumMock } = vi.hoisted(() => ({ launchChromiumMock: vi.fn() }));
vi.mock('../scripts/lib/ensure-chromium.mjs', () => ({
  launchChromium: launchChromiumMock,
}));

import { fetchDennerJobUrls } from '../scripts/update-denner-jobs.mjs';
import { fetchMigrolinoListingHrefs } from '../scripts/lib/migrolino-job-parser.mjs';

afterEach(() => {
  launchChromiumMock.mockReset();
  delete process.env.JOBS_DENNER_PAGINATION_TIMEOUT_MS;
  delete process.env.JOBS_DENNER_PAGINATION_STALL_POLLS;
  delete process.env.JOBS_MIGROLINO_PAGINATION_TIMEOUT_MS;
  delete process.env.JOBS_MIGROLINO_PAGINATION_STALL_POLLS;
  vi.restoreAllMocks();
});

function mockStalledBrowser(detailHref: string) {
  const consent = {
    isVisible: vi.fn().mockResolvedValue(false),
  };
  const nextButton = {
    isVisible: vi.fn().mockResolvedValue(true),
    isDisabled: vi.fn().mockResolvedValue(false),
    scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
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
  it('warns when a clickable next control yields no new job URLs', async () => {
    process.env.JOBS_DENNER_PAGINATION_TIMEOUT_MS = '1';
    process.env.JOBS_DENNER_PAGINATION_STALL_POLLS = '1';

    const detailHref = '/it/le-nostre-imprese/job/denner-sa/vendita/example-id';
    const nextButton = mockStalledBrowser(detailHref);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(fetchDennerJobUrls()).resolves.toEqual([
      `https://jobs.migros.ch${detailHref}`,
    ]);
    expect(nextButton.click).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(
      'Denner pagination stalled after page 2',
    ));
  });

  it('warns for the sibling migrolino portal instead of stopping silently', async () => {
    process.env.JOBS_MIGROLINO_PAGINATION_TIMEOUT_MS = '1';
    process.env.JOBS_MIGROLINO_PAGINATION_STALL_POLLS = '1';
    const detailHref = '/de/unsere-unternehmen/job/migrolino/verkauf/00000000-0000-4000-8000-000000000001';
    const nextButton = mockStalledBrowser(detailHref);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(fetchMigrolinoListingHrefs()).resolves.toEqual([detailHref]);
    expect(nextButton.click).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(
      'migrolino pagination stalled after page 2',
    ));
  });
});
