import { describe, expect, it, vi } from 'vitest';

const { fetchHtml } = vi.hoisted(() => ({ fetchHtml: vi.fn() }));

vi.mock('../scripts/lib/crawler-template.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scripts/lib/crawler-template.mjs')>()),
  fetchHtml,
}));

import {
  fetchAllFondationDomusJobs,
  FONDATION_DOMUS_COMPANY_NAME,
} from '../scripts/lib/fondation-domus-job-parser.mjs';

const CAREER_URL = 'https://www.fondation-domus.ch/emploi-formation/offres-d-emploi';

describe('Fondation Domus transport', () => {
  it('uses the shared resilient HTML transport for the career page', async () => {
    fetchHtml.mockResolvedValueOnce(`
      <html><body>
        <h3>Educateur social</h3>
        <h5>Lieu de travail</h5><div>Ardon</div>
        <h5>Taux d'activité</h5><div>80%</div>
      </body></html>
    `);

    const jobs = await fetchAllFondationDomusJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0].company).toBe(FONDATION_DOMUS_COMPANY_NAME);
    expect(fetchHtml).toHaveBeenCalledTimes(1);
    expect(fetchHtml).toHaveBeenCalledWith(
      CAREER_URL,
      expect.objectContaining({
        timeoutMs: 20_000,
        headers: expect.objectContaining({
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'fr-CH,fr;q=0.9',
        }),
      }),
    );
  });
});
