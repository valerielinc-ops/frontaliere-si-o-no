import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Network only: the vacancy API goes through the template's fetchJson, the
// detail page through global fetch. Parsing and language detection stay real.
const { fetchJson } = vi.hoisted(() => ({ fetchJson: vi.fn() }));
vi.mock('@/scripts/lib/crawler-template.mjs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchJson };
});

import { fetchAllKulmHotelJobs } from '../scripts/lib/kulm-hotel-job-parser.mjs';

// Minimized from https://careers.kulm.com/en/vacancies/723 (2026-09-29).
const detailPage = (intro: string) => `<!doctype html><html><body><main id="main">
<section class="entry container"><div class="relative grid"><div class="lg:col-span-7">
<div class="content-page">
<p>${intro}</p>
<h2>This is what you move with us</h2><p>Where passion meets perfection: In our main kitchen, we create culinary experiences at a 16 GaultMillau points level.<ul><li>Executive Right Hand: Supporting the Executive Chef in daily organization, planning, menu creation, and brigade leadership.</li><li>Quality Assurance: Ensuring the highest presentation and flavor standards for every guest.</li></ul></p>
<h2>This is you</h2><p><ul><li>Qualifications: Completed professional culinary training (EFZ or international equivalent).</li><li>Leadership &amp; Mindset: Strong leadership skills, high stress tolerance and the ability to motivate a large brigade.</li></ul></p>
<h2>Benefits</h2><p>At Kulm Group, our employees are the heart of our success. We offer attractive development opportunities, comfortable accommodations and numerous perks.</p>
</div>
<a href="https://recruitingapp-2983.umantis.com/Vacancies/723/Application" class="btn btn-primary">Apply now</a>
</div></div></section></main></body></html>`;

const ENGLISH_INTRO = 'People at 1800m above sea level are shaping the Luxury Mountain Travel. Our dynamic and international community offers our guests smart Luxury for an inimitable holiday experience.';

describe('kulm-hotel source language (#5253)', () => {
  beforeEach(() => {
    fetchJson.mockReset();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(detailPage(ENGLISH_INTRO), { status: 200 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('labels an English ad by its body, not by a loanword title', async () => {
    fetchJson.mockResolvedValueOnce({
      data: [
        { id: 723, title: 'Sous Chef Main Kitchen | 16 GaultMillau Points (m/w/d)', location: 'Grand Hotel Kronenhof', workload: '100', contract_duration: 'unlimited' },
        { id: 680, title: 'Room Attendant / Zimmerdame / Roomboy - start now (m/w/d)', location: 'Kulm Hotel', workload: '100', contract_duration: 'seasonal' },
      ],
      meta: { last_page: 1 },
    });
    const jobs = await fetchAllKulmHotelJobs();
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job.sourceLang).toBe('en');
      expect(Object.keys(job.descriptionByLocale)).toEqual(['en']);
      expect(Object.keys(job.titleByLocale)).toEqual(['en']);
      expect(job.description).toContain('People at 1800m above sea level');
      // The synthesized facts line speaks the language of the body.
      expect(job.description).toMatch(/Workload: 100%\. Contract: /);
      expect(job.description).not.toMatch(/Pensum:|Vertrag:/);
    }
  });

  it('uses detail publication, keeping the contract start separate', async () => {
    const publication = new Date(Date.now() - 8 * 86400000).toISOString();
    const start = new Date(Date.now() + 40 * 86400000).toISOString();
    for (const datePosted of [publication, '']) {
      fetchJson.mockResolvedValueOnce({ data: [{ id: 723, title: 'Sous Chef', location: 'Kulm Hotel', contract_starts_at: start }], meta: { last_page: 1 } });
      vi.stubGlobal('fetch', vi.fn(async () => new Response(detailPage(ENGLISH_INTRO) + `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', datePosted })}</script>`)));
      const [job] = await fetchAllKulmHotelJobs();
      expect(job).toMatchObject({ jobStartDate: start, datePosted, postedDate: datePosted, postingDateSource: datePosted ? 'reported' : 'unknown' });
    }
  });

  it('keeps the German facts labels for the German fallback text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html><body><main><p>x</p></main></body></html>', { status: 200 })));
    fetchJson.mockResolvedValueOnce({
      data: [{ id: 731, title: 'Demi Chef de Partie (m/w/d)', location: 'Grand Hotel Kronenhof', workload: '80' }],
      meta: { last_page: 1 },
    });
    const [job] = await fetchAllKulmHotelJobs();
    expect(job.sourceLang).toBe('de');
    expect(job.description).toContain('Pensum: 80%.');
    expect(job.description).toContain('Die Kulm Gruppe betreibt');
  });
});
