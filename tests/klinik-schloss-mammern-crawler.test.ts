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
});
