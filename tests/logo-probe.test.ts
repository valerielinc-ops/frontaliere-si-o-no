import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeCompanyLogo } from '../scripts/lib/prospector/logo-probe.mjs';

function pngBytes(width = 128, height = 128) {
  const bytes = Buffer.alloc(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function imageResponse(status = 200) {
  return new Response(status === 200 ? pngBytes() : null, {
    status,
    headers: { 'content-type': 'image/png' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('logo-probe', () => {
  it('validates a favicon served by the candidate domain', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).not.toContain('google.com');
      return imageResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(probeCompanyLogo('acme.test')).resolves.toMatchObject({
      found: true,
      domain: 'acme.test',
      source: 'https://acme.test/favicon.ico',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('tries the www host without leaving the official domain family', async () => {
    const fetchMock = vi.fn(async (url: string) => (
      url === 'https://www.acme.test/favicon.ico' ? imageResponse() : imageResponse(404)
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(probeCompanyLogo('acme.test')).resolves.toMatchObject({
      found: true,
      source: 'https://www.acme.test/favicon.ico',
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://acme.test/favicon.ico',
      'https://www.acme.test/favicon.ico',
    ]);
  });
});
