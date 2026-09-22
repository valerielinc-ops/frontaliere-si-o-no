import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPersonioJobs } from '../scripts/lib/ats-clients/personio-client.mjs';

describe('fetchPersonioJobs structured detail enrichment', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches the detail address even when the XML feed already has a description', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(`
        <workzag-jobs>
          <position>
            <id>42</id>
            <name>Data Engineer</name>
            <office>Zürich Hybrid</office>
            <createdAt>2026-09-22T00:00:00Z</createdAt>
            <jobDescriptions>
              <jobDescription><name>Role</name><value>Existing feed description.</value></jobDescription>
            </jobDescriptions>
          </position>
        </workzag-jobs>
      `, { status: 200 }))
      .mockResolvedValueOnce(new Response(`
        <script type="application/ld+json">
          {"@type":"JobPosting","description":"Detail description.","jobLocation":{"address":{"addressLocality":"Pfäffikon SZ","postalCode":"8808","streetAddress":"Churerstrasse 135","addressCountry":"CH"}}}
        </script>
      `, { status: 200 }));

    const jobs = await fetchPersonioJobs('example');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(jobs[0].descriptionHtml).toContain('Existing feed description.');
    expect(jobs[0].locationDetail).toEqual({
      locality: 'Pfäffikon SZ',
      postalCode: '8808',
      streetAddress: 'Churerstrasse 135',
      addressCountry: 'CH',
    });
  });
});
