import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPastaHrProvenEmptyResponse } from '../scripts/lib/pastahr-widget-client.mjs';
import { isAuthoritativeEmptySnapshot } from '../scripts/lib/authoritative-empty-snapshot.mjs';
import { fetchAllIgsBernJobs } from '../scripts/lib/igs-bern-job-parser.mjs';
import { fetchAllGzoWetzikonJobs } from '../scripts/lib/gzo-wetzikon-job-parser.mjs';

describe('isPastaHrProvenEmptyResponse', () => {
  it('accepts only success:true with an empty data array', () => {
    expect(isPastaHrProvenEmptyResponse({ success: true, data: [] })).toBe(true);
    expect(isPastaHrProvenEmptyResponse({ success: false, data: [] })).toBe(false);
    expect(isPastaHrProvenEmptyResponse({ data: [] })).toBe(false);
    expect(isPastaHrProvenEmptyResponse({ success: true })).toBe(false);
    expect(isPastaHrProvenEmptyResponse({ success: true, data: null })).toBe(false);
    expect(isPastaHrProvenEmptyResponse({ success: true, data: [{}] })).toBe(false);
    expect(isPastaHrProvenEmptyResponse(null)).toBe(false);
    expect(isPastaHrProvenEmptyResponse('[]')).toBe(false);
  });
});

describe.each([
  ['igs-bern', fetchAllIgsBernJobs],
  ['gzo-wetzikon', fetchAllGzoWetzikonJobs],
])('%s widget empty snapshot', (_name, fetchAll) => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const widget = (payload: unknown) =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

  it('stamps success:true + data:[]', async () => {
    widget({ success: true, data: [] });
    const jobs = await fetchAll();
    expect(jobs).toEqual([]);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(true);
  });

  it('does not stamp success:false', async () => {
    widget({ success: false, data: [] });
    const jobs = await fetchAll();
    expect(jobs).toEqual([]);
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
  });

  it('does not stamp a body without a data array', async () => {
    widget({ success: true });
    const jobs = await fetchAll();
    expect(isAuthoritativeEmptySnapshot(jobs)).toBe(false);
  });
});
