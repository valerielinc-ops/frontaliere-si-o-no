import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { normalizeDomain, resolveCompanyWebsite, resolveCompanyWebsites, run } from '../scripts/resolve-company-website.mjs';

describe('company website resolver', () => {
  it('normalizes a website to its registrable lookup domain', () => {
    expect(normalizeDomain('https://WWW.Example.CH/careers')).toBe('example.ch');
    expect(normalizeDomain('mailto:jobs@example.ch')).toBeNull();
  });

  it('uses HEAD for bare and www and accepts one shared redirect destination', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, url: 'https://example.ch/' });
    await expect(resolveCompanyWebsite('example.ch', { fetchImpl })).resolves.toBe('https://example.ch/');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual(['HEAD', 'HEAD']);
  });

  it('falls back to GET only when HEAD is unsupported', async () => {
    const fetchImpl = vi.fn((_url, init) => init.method === 'HEAD'
      ? Promise.resolve({ ok: false, status: 405 })
      : Promise.resolve({ ok: true, url: 'https://example.ch/' }));
    await expect(resolveCompanyWebsite('example.ch', { fetchImpl })).resolves.toBe('https://example.ch/');
    expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual(['HEAD', 'HEAD', 'GET', 'GET']);
  });

  it('fails closed for a network error or an ambiguous destination', async () => {
    const networkError = vi.fn().mockRejectedValue(new Error('timeout'));
    await expect(resolveCompanyWebsite('example.ch', { fetchImpl: networkError })).resolves.toBeNull();
    const ambiguous = vi.fn()
      .mockResolvedValueOnce({ ok: true, url: 'https://example.ch/' })
      .mockResolvedValueOnce({ ok: true, url: 'https://www.example.ch/' });
    await expect(resolveCompanyWebsite('example.ch', { fetchImpl: ambiguous })).resolves.toBeNull();
  });

  it('produces a sorted, duplicate-free domain registry', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, url: 'https://example.ch/' });
    await expect(resolveCompanyWebsites([
      { website: 'https://www.example.ch/jobs' },
      { website: 'https://example.ch/' },
      { website: 'not a url' },
    ], { fetchImpl })).resolves.toEqual({ 'example.ch': 'https://example.ch/' });
  });

  it('does not rewrite an unchanged registry', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'company-website-resolver-'));
    const inputPath = path.join(root, 'companies.json');
    const outputPath = path.join(root, 'resolved.json');
    writeFileSync(inputPath, JSON.stringify([{ website: 'https://example.ch' }]));
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, url: 'https://example.ch/' });
    const first = await run({ inputPath, outputPath, fetchImpl });
    const firstContents = readFileSync(outputPath, 'utf8');
    const second = await run({ inputPath, outputPath, fetchImpl });
    expect(second).toEqual(first);
    expect(readFileSync(outputPath, 'utf8')).toBe(firstContents);
  });
});
