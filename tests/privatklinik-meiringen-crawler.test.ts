import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchAllPrivatklinikMeiringenJobs,
  PRIVATKLINIK_MEIRINGEN_KEY,
} from '../scripts/lib/privatklinik-meiringen-job-parser.mjs';

const LISTING_URL = 'https://my.jobalino.ch/custel_jobExternalList/privatklinik-meiringen';

function textResponse(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

function listingJsonp(tilesHtml: string) {
  const payload = JSON.stringify({ error: '', html: `<div>${tilesHtml}</div>` });
  return `jb_ShowJsonHtml(${payload}, 'privatklinik-meiringen');`;
}

function tile() {
  return `<a href="https://my.jobalino.ch/job/abcdef0123456789/test-position" class="reflink">
    <span class="title">Test Pflegefachperson</span>
    <span class="workload">80% - 100%</span>
    <span class="jobtype">Festanstellung</span>
    <span class="company">Privatklinik Meiringen</span>
    <span class="zip">3860</span>
    <span class="city">Meiringen</span>
    <span class="country">Schweiz</span>
    <span class="filter3">Pflege- und Betreuungsberufe</span>
  </a>`;
}

function detailHtml() {
  const jsonLd = {
    '@type': 'JobPosting',
    title: 'Test Pflegefachperson',
    description: '<p>Eine echte Testbeschreibung aus der öffentlichen Jobalino-Detailseite.</p>',
    datePosted: '2026-09-12T08:00:00+00:00',
  };
  return `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Privatklinik Meiringen Jobalino parser', () => {
  it('does not send the stale filter5=Ja that makes the live tenant look empty (#5971)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === `${LISTING_URL}?additional_company_names=michel-gruppe-ag&filter5=Ja`) {
        return textResponse(200, listingJsonp(''));
      }
      if (url.startsWith(`${LISTING_URL}?additional_company_names=michel-gruppe-ag`)) {
        return textResponse(200, listingJsonp(tile()));
      }
      if (url.includes('/job/abcdef0123456789/')) return textResponse(200, detailHtml());
      return textResponse(404, '');
    });
    vi.stubGlobal('fetch', fetchMock);

    const jobs = await fetchAllPrivatklinikMeiringenJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0].companyKey).toBe(PRIVATKLINIK_MEIRINGEN_KEY);
    expect(jobs[0].location).toBe('Meiringen');
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${LISTING_URL}?additional_company_names=michel-gruppe-ag`,
    );
    expect(fetchMock.mock.calls[0][0]).not.toContain('filter5=Ja');
  });
});
