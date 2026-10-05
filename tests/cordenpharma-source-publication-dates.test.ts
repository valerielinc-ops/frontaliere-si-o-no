import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllCordenpharmaJobs } from '../scripts/lib/cordenpharma-job-parser.mjs';
const description = 'Our engineering team designs reliable systems and delivers excellent results through careful planning testing documentation collaboration and support for customers. '.repeat(5);
const stamp = `${new Date(Date.now()-5*86400000).toISOString().slice(0,10)}T12:34:56+02:00`;
function publication(startDate: unknown, id = 'one') {
  return { position: 'Systems Engineer', language: 'en', jobPublicationURL: `https://career.cordenpharma.com/en/jobs/${id}`, startDate,
    jobOpening: { createdDate: new Date(Date.now()-10*86400000).toISOString(), startDate: stamp, locations: [{ id: 'LIESTAL', name: 'Liestal', address: { city: 'Liestal' } }] } };
}
function setup(publications: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(String(url).includes('/p/')
    ? `<script>DvinciData = ${JSON.stringify({ jobPublications: publications })};</script>`
    : `<div id="liquidDesignTasksPublication"><p>${description}</p></div>`, { headers: { 'Content-Type': 'text/html' } })));
}
afterEach(() => vi.unstubAllGlobals());
describe('CordenPharma d.vinci publication window provenance', () => {
  for (const [name, raw] of [['timestamp',stamp],['missing',undefined],['invalid','2026-02-30T12:00:00Z'],['future',new Date(Date.now()+10*86400000).toISOString()],['timezone-free',stamp.slice(0,19)]]) {
    it(`${name}: considers publication start, never opening creation or employment start`, async () => {
      setup([publication(raw)]);
      const jobs = await fetchAllCordenpharmaJobs();
      expect(jobs).toHaveLength(1);
      const expected = name === 'timestamp' ? stamp : '';
      expect(jobs[0]).toMatchObject({ datePosted: expected, postedDate: expected, postingDateSource: expected ? 'reported' : 'unknown', canton: 'BL', addressLocality: 'Liestal' });
      expect(jobs[0].description.split(/\s+/).length).toBeGreaterThan(50);
      expect(jobs[0].url).toBe('https://career.cordenpharma.com/en/jobs/one');
    });
  }
  it('keeps separate publication identities and deduplicates repeated site listings', async () => {
    setup([publication(undefined,'unknown'),publication(stamp,'reported')]);
    const jobs = await fetchAllCordenpharmaJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs.find(j => j.url.endsWith('/unknown'))).toMatchObject({ datePosted: '',postedDate: '',postingDateSource:'unknown' });
    expect(jobs.find(j => j.url.endsWith('/reported'))).toMatchObject({ datePosted:stamp,postedDate:stamp,postingDateSource:'reported' });
  });
});
