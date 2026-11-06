import { afterEach, describe, expect, it, vi } from 'vitest';
import { employerLogoDomain, employerSiteName, probeCompanyLogo } from '../scripts/lib/prospector/logo-probe.mjs';

function pngBytes(width = 128, height = 128) {
  const bytes = Buffer.alloc(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function imageResponse(status = 200, size = 128) {
  return new Response(status === 200 ? pngBytes(size, size) : null, {
    status,
    headers: { 'content-type': 'image/png' },
  });
}

/** A homepage that does not answer: only `/favicon.ico` is left to try. */
const noHomepage = { fetchPage: async () => ({ ok: false, status: 404, url: '', body: '' }) };

function homepage(body: string) {
  return { fetchPage: async (url: string) => ({ ok: true, status: 200, url, body }) };
}

afterEach(() => vi.unstubAllGlobals());

describe('logo-probe', () => {
  it('validates a favicon served by the candidate domain', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).not.toContain('google.com');
      return imageResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(probeCompanyLogo('acme.test', noHomepage)).resolves.toMatchObject({
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

    await expect(probeCompanyLogo('acme.test', noHomepage)).resolves.toMatchObject({
      found: true,
      source: 'https://www.acme.test/favicon.ico',
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://acme.test/favicon.ico',
      'https://www.acme.test/favicon.ico',
    ]);
  });

  it('finds the icon a homepage declares when /favicon.ico is missing', async () => {
    // Measured 2026-10-23: 31 of 65 validations failed `logo` this way.
    const fetchMock = vi.fn(async (url: string) => (
      url === 'https://acme.test/assets/apple-touch-icon.png' ? imageResponse() : imageResponse(404)
    ));
    vi.stubGlobal('fetch', fetchMock);
    const page = homepage('<head><link rel="apple-touch-icon" href="/assets/apple-touch-icon.png"></head>');

    await expect(probeCompanyLogo('acme.test', page)).resolves.toMatchObject({
      found: true,
      source: 'https://acme.test/assets/apple-touch-icon.png',
      qualityStatus: 'good',
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain('https://acme.test/favicon.ico');
  });

  it('prefers a good declared asset over a tiny one and never reads a proxy', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).not.toContain('google.com');
      if (url === 'https://acme.test/favicon-16.png') return imageResponse(200, 16);
      if (url === 'https://acme.test/logo.png') return imageResponse(200, 240);
      return imageResponse(404);
    });
    vi.stubGlobal('fetch', fetchMock);
    const page = homepage('<link rel="icon" href="/favicon-16.png"><img class="site-logo" src="/logo.png">');

    await expect(probeCompanyLogo('acme.test', page)).resolves.toMatchObject({
      found: true,
      source: 'https://acme.test/logo.png',
      qualityStatus: 'good',
    });
  });

  it('reports no logo when only the ATS vendor domain is known', async () => {
    await expect(probeCompanyLogo('')).resolves.toMatchObject({ found: false });
  });
});

describe('employerLogoDomain', () => {
  it('uses the employer domain, not the ATS host, for a hosted tenant', () => {
    // `my.jobalino.ch` serves many employers: its favicon is jobalino's brand.
    expect(employerLogoDomain(
      { domain: 'ibbrugg.ch', platform: 'jobalino.ch' },
      { companyHost: 'my.jobalino.ch', platform: 'jobalino.ch' },
    )).toBe('ibbrugg.ch');
  });

  it('has no employer logo domain when the only domain known is the vendor', () => {
    expect(employerLogoDomain(
      { domain: 'community.personio.de', platform: 'personio.de' },
      { companyHost: 'community.personio.de', platform: 'personio.de' },
    )).toBe('');
  });

  it('keeps the crawler host for a self-hosted careers page', () => {
    expect(employerLogoDomain({ platform: '' }, { companyHost: 'karriere.acme.ch' })).toBe('karriere.acme.ch');
    expect(employerLogoDomain(null, { companyHost: 'acme.ch' })).toBe('acme.ch');
  });
});

describe('employerSiteName', () => {
  it('reads the name the homepage declares when it names the domain', () => {
    expect(employerSiteName('<meta property="og:site_name" content="Garage Service Kuhn AG">', 'servicekuhn.ch'))
      .toBe('Garage Service Kuhn AG');
    expect(employerSiteName('<script type="application/ld+json">{"@type":"Organization","name":"BENU Apotheken"}</script>', 'benu.ch'))
      .toBe('BENU Apotheken');
    // Umlauts are spelled out in domains; the brand may sit after "Home".
    expect(employerSiteName('<title>Home - Müller Frauenfeld AG</title>', 'mueller-frauenfeld.ch'))
      .toBe('Müller Frauenfeld AG');
  });

  it('refuses CMS defaults and names that do not name the domain', () => {
    expect(employerSiteName('<title>Willkommen | WordPress</title>', 'benu.ch')).toBe('');
    expect(employerSiteName('<meta property="og:site_name" content="SBB CFF FFS">', 'elvetino.ch')).toBe('');
  });
});
