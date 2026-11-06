// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { csvText, datedExportFilename, downloadCsv } from '@/components/admin/lib/csv';
import { clampPage, pageCount, pageSlice } from '@/components/admin/lib/pagination';

describe('admin pagination boundaries', () => {
  it('uses the default page size for zero, negative, fractional and non-finite sizes', () => {
    expect(pageCount(101, 0)).toBe(3);
    expect(pageCount(101, -10)).toBe(3);
    expect(pageCount(101, 1.5)).toBe(3);
    expect(pageCount(101, Number.NaN)).toBe(3);
    expect(pageCount(101, Number.POSITIVE_INFINITY)).toBe(3);
  });

  it('normalizes totals and page numbers before calculating an offset', () => {
    expect(pageCount(-1, 50)).toBe(1);
    expect(pageCount(Number.NaN, 50)).toBe(1);
    expect(pageCount(Number.POSITIVE_INFINITY, 50)).toBe(1);
    expect(clampPage(Number.NaN, 100, 50)).toBe(1);
    expect(clampPage(Number.POSITIVE_INFINITY, 100, 50)).toBe(1);
    expect(clampPage(2.9, 100, 50)).toBe(2);
    expect(pageSlice([1, 2, 3], Number.NaN, 0)).toEqual([1, 2, 3]);
  });
});

describe('admin CSV boundaries', () => {
  it('keeps malformed runtime rows as empty CSV rows', () => {
    expect(csvText(['Name'], [["Ada, Lovelace"], null as unknown as readonly unknown[], { bad: true } as unknown as readonly unknown[]])).toBe(
      'Name\r\n"Ada, Lovelace"\r\n\r\n',
    );
    expect(csvText(null as unknown as readonly unknown[], null as unknown as readonly (readonly unknown[])[])).toBe('');
  });

  it('reports invalid export dates with a domain error', () => {
    expect(() => datedExportFilename('admin', new Date('not-a-date'))).toThrow('CSV export date is invalid');
    expect(datedExportFilename('admin', new Date('2026-10-26T10:00:00Z'))).toMatch(/^admin-2026-10-26\.csv$/);
  });

  it('revokes the object URL even if activating the download fails', async () => {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const createObjectURL = vi.fn(() => 'blob:admin-test');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('download activation failed');
    });

    try {
      expect(() => downloadCsv('admin.csv', ['Name'], [['Ada']])).toThrow('download activation failed');
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      expect(createObjectURL).toHaveBeenCalledOnce();
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:admin-test');
    } finally {
      click.mockRestore();
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreate });
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevoke });
    }
  });
});
