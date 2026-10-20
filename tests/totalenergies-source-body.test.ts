import { beforeEach, describe, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({ detail: '', fail: false }));
vi.mock('../scripts/lib/crawler-template.mjs', async (importOriginal) => ({
  ...await importOriginal<typeof import('../scripts/lib/crawler-template.mjs')>(),
  fetchHtml: async (url: string) => {
    if (url.includes('/JobDetail/')) {
      if (transport.fail) throw new Error('Fixture source unavailable');
      return transport.detail;
    }
    return '<div class="list-controls__text__legend">1 result</div><div class="article article--result"><h3><a href="https://jobs.totalenergies.com/en_US/careers/JobDetail/Engineer/123">Engineer</a></h3><li class="list-item-jobCountry">Switzerland</li></div>';
  },
}));
import { fetchAllTotalEnergiesJobs } from '../scripts/lib/totalenergies-job-parser.mjs';
const detail = (body: string) => `<dt class="field__label">Country</dt><dd class="field__value">Switzerland</dd><h3 class="title--04"><strong>Activities</strong></h3><dd class="field__value">${body}</dd>`;
beforeEach(() => { transport.detail = ''; transport.fail = false; });

describe('TotalEnergies authentic source body', () => {
  it.each(['', 'Apply now for this position.', Array.from({ length: 48 }, () => 'responsibility').join(' ')])('does not publish empty, placeholder or sub-floor source text', async (body) => {
    transport.detail = detail(body);
    expect(await fetchAllTotalEnergiesJobs()).toEqual([]);
  });
  it('does not manufacture a body when the detail fetch fails', async () => {
    transport.fail = true;
    expect(await fetchAllTotalEnergiesJobs()).toEqual([]);
  });
  it('accepts exactly the shared 50-word floor without adding company prose', async () => {
    const body = Array.from({ length: 49 }, () => 'responsibility').join(' ');
    transport.detail = detail(body);
    const [job] = await fetchAllTotalEnergiesJobs();
    expect(job.description).toBe(`Activities: ${body}`);
    expect(job.descriptionByLocale[job.sourceLang]).toBe(job.description);
    expect(job.description).not.toContain('multinazionale');
  });
  it('keeps the actual English vacancy text in its source-language slot', async () => {
    const body = 'The successful candidate will work with the team to deliver reliable services for our customers. You will review project requirements and support the development of clear technical specifications. We are looking for experience in engineering, a strong understanding of safety procedures, and the ability to communicate with colleagues across different teams and locations.';
    transport.detail = detail(body);
    const [job] = await fetchAllTotalEnergiesJobs();
    expect(job.sourceLang).toBe('en');
    expect(job.descriptionByLocale.en).toBe(`Activities: ${body}`);
    expect(job.descriptionByLocale.it).toBeUndefined();
  });
});
