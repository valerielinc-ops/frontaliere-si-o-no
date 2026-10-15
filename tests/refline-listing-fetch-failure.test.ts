import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchHtml } = vi.hoisted(() => ({ fetchHtml: vi.fn() }));

vi.mock('../scripts/lib/hospital-custom-html-helpers.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/hospital-custom-html-helpers.mjs')>()),
  fetchHtml,
}));

import { fetchAllMedicsLaborJobs } from '../scripts/lib/medics-labor-job-parser.mjs';

describe('shared Refline listing fetch', () => {
  beforeEach(() => {
    fetchHtml.mockRejectedValue(new Error('listing unavailable'));
  });

  it('propagates an unread listing instead of reporting an empty source', async () => {
    await expect(fetchAllMedicsLaborJobs()).rejects.toThrow('listing unavailable');
  });
});
