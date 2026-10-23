import { describe, expect, it, vi } from 'vitest';

import { fetchTicinoPdfBuffer } from '../scripts/import-pharmacies-border.mjs';
import {
  TICINO_PHARMACY_PDF_MIRROR_URL,
  TICINO_PHARMACY_PDF_URL,
} from '../scripts/lib/pharmacy-border-parser.mjs';

describe('Ticino pharmacy PDF source fallback', () => {
  it('uses the official mirror after the primary transport budget is exhausted', async () => {
    const calls: string[] = [];
    const fetchSource = vi.fn(async (url: string) => {
      calls.push(url);
      if (calls.length === 1) {
        throw Object.assign(new Error('primary timeout'), { retryBudgetExhausted: true });
      }
      return Buffer.from('%PDF');
    });

    await expect(fetchTicinoPdfBuffer(fetchSource)).resolves.toEqual(Buffer.from('%PDF'));
    expect(calls).toEqual([TICINO_PHARMACY_PDF_URL, TICINO_PHARMACY_PDF_MIRROR_URL]);
  });

  it('does not reinterpret a persistent source error as a mirror fallback', async () => {
    const error = Object.assign(new Error('HTTP 404'), { status: 404 });
    const fetchSource = vi.fn().mockRejectedValue(error);

    await expect(fetchTicinoPdfBuffer(fetchSource)).rejects.toBe(error);
    expect(fetchSource).toHaveBeenCalledOnce();
    expect(fetchSource).toHaveBeenCalledWith(TICINO_PHARMACY_PDF_URL);
  });
});
