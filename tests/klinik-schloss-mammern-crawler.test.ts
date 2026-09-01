/**
 * Klinik Schloss Mammern crawler — sitemap origin/HTTPS boundary.
 *
 * `parseJobsSitemap` used to accept any absolute URL with a `/job/...` path,
 * and `fetchAllKlinikSchlossMammernJobs` forwarded that URL straight to
 * `fetchHtml` before `isTrustedDomain` (an output-only check) could ever
 * intervene. `normalizeKsmJobUrl` now fails closed at both the sitemap
 * parse step and the detail-fetch sink.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const { fetchHtml } = vi.hoisted(() => ({
  fetchHtml: vi.fn(),
}));

vi.mock('@/scripts/lib/hospital-custom-html-helpers.mjs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchHtml };
});

import {
  normalizeKsmJobUrl,
  parseJobsSitemap,
  fetchKsmDetailPage,
  fetchAllKlinikSchlossMammernJobs,
} from '@/scripts/lib/klinik-schloss-mammern-job-parser.mjs';

afterEach(() => {
  fetchHtml.mockReset();
});

describe('normalizeKsmJobUrl', () => {
  it('allows only relative or same-origin HTTPS ksm-jobs.ch job routes', () => {
    const path = '/job/pflegefachperson-hf/';
    expect(normalizeKsmJobUrl(path)).toBe(`https://ksm-jobs.ch${path}`);
    expect(normalizeKsmJobUrl(`https://ksm-jobs.ch${path}`)).toBe(`https://ksm-jobs.ch${path}`);
  });

  it('rejects an off-domain URL with the same job route', () => {
    expect(normalizeKsmJobUrl('https://attacker.example/job/pflegefachperson-hf/')).toBeNull();
  });

  it('rejects a non-HTTPS URL', () => {
    expect(normalizeKsmJobUrl('http://ksm-jobs.ch/job/pflegefachperson-hf/')).toBeNull();
  });

  it('rejects a route outside /job/<slug>/', () => {
    expect(normalizeKsmJobUrl('https://ksm-jobs.ch/ueber-uns/')).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(normalizeKsmJobUrl('')).toBeNull();
    expect(normalizeKsmJobUrl('not a url')).toBeNull();
  });
});

describe('parseJobsSitemap', () => {
  it('extracts same-origin job URLs from CDATA <loc> entries', () => {
    const xml = `<urlset>
      <url><loc><![CDATA[https://ksm-jobs.ch/job/pflegefachperson-hf/]]></loc></url>
    </urlset>`;
    expect(parseJobsSitemap(xml)).toEqual(['https://ksm-jobs.ch/job/pflegefachperson-hf/']);
  });

  it('rejects an off-domain sitemap entry without suppressing a valid job', () => {
    const xml = `<urlset>
      <url><loc><![CDATA[https://attacker.example/job/pflegefachperson-hf/]]></loc></url>
      <url><loc><![CDATA[https://ksm-jobs.ch/job/pflegefachperson-hf/]]></loc></url>
    </urlset>`;
    expect(parseJobsSitemap(xml)).toEqual(['https://ksm-jobs.ch/job/pflegefachperson-hf/']);
  });

  it('rejects a non-HTTPS sitemap entry', () => {
    const xml = `<urlset>
      <url><loc><![CDATA[http://ksm-jobs.ch/job/pflegefachperson-hf/]]></loc></url>
    </urlset>`;
    expect(parseJobsSitemap(xml)).toEqual([]);
  });

  it('skips known evergreen marketing slugs', () => {
    const xml = `<urlset>
      <url><loc><![CDATA[https://ksm-jobs.ch/job/talentierte-fachkraefte/]]></loc></url>
    </urlset>`;
    expect(parseJobsSitemap(xml)).toEqual([]);
  });

  it('deduplicates identical URLs', () => {
    const xml = `<urlset>
      <url><loc><![CDATA[https://ksm-jobs.ch/job/pflegefachperson-hf/]]></loc></url>
      <url><loc><![CDATA[https://ksm-jobs.ch/job/pflegefachperson-hf/]]></loc></url>
    </urlset>`;
    expect(parseJobsSitemap(xml)).toEqual(['https://ksm-jobs.ch/job/pflegefachperson-hf/']);
  });

  it('preserves the raw absolute URL used by the existing identity contract', () => {
    const rawUrl = 'https://ksm-jobs.ch/job/käse+verkäufer/';
    const xml = `<urlset><url><loc><![CDATA[${rawUrl}]]></loc></url></urlset>`;
    expect(normalizeKsmJobUrl(rawUrl))
      .toBe('https://ksm-jobs.ch/job/k%C3%A4se+verk%C3%A4ufer/');
    expect(parseJobsSitemap(xml)).toEqual([rawUrl]);
  });

  it('returns empty for null/empty input', () => {
    expect(parseJobsSitemap('')).toEqual([]);
    expect(parseJobsSitemap(undefined as unknown as string)).toEqual([]);
  });
});

describe('fetchKsmDetailPage', () => {
  it('fails closed before fetch for an off-domain detail URL', async () => {
    await expect(fetchKsmDetailPage('https://attacker.example/job/pflegefachperson-hf/')).resolves.toBeNull();
    expect(fetchHtml).not.toHaveBeenCalled();
  });

  it('fails closed before fetch for a non-HTTPS detail URL', async () => {
    await expect(fetchKsmDetailPage('http://ksm-jobs.ch/job/pflegefachperson-hf/')).resolves.toBeNull();
    expect(fetchHtml).not.toHaveBeenCalled();
  });

  it('fetches and extracts a trusted same-origin detail URL', async () => {
    fetchHtml.mockResolvedValue(
      '<h1 class="elementor-heading-title">Pflegefachperson HF</h1><p>Aufgabengebiet: Pflege der Patienten.</p>'
    );
    const result = await fetchKsmDetailPage('https://ksm-jobs.ch/job/pflegefachperson-hf/');
    expect(fetchHtml).toHaveBeenCalledWith('https://ksm-jobs.ch/job/pflegefachperson-hf/');
    expect(result?.title).toBe('Pflegefachperson HF');
    expect(result?.description).toContain('Pflege der Patienten');
  });

  it('keeps raw +/accent URL identity while fetching its safely encoded form', async () => {
    const rawUrl = 'https://ksm-jobs.ch/job/käse+verkäufer/';
    fetchHtml
      .mockResolvedValueOnce(`<urlset><url><loc><![CDATA[${rawUrl}]]></loc></url></urlset>`)
      .mockResolvedValueOnce(
        '<h1 class="elementor-heading-title">Käse Verkäufer</h1>'
        + '<p>Aufgabengebiet: Pflege und Beratung der Kundinnen und Kunden.</p>'
      );

    const [job] = await fetchAllKlinikSchlossMammernJobs();
    const rawHash = createHash('sha1').update(rawUrl).digest('hex').slice(0, 12);
    expect(job.id).toBe(`klinik-schloss-mammern-${rawHash}`);
    expect(job.url).toBe(rawUrl);
    expect(job.applyUrl).toBe(rawUrl);
    expect(fetchHtml).toHaveBeenNthCalledWith(
      2,
      'https://ksm-jobs.ch/job/k%C3%A4se%2Bverk%C3%A4ufer/'
    );
  });
});
