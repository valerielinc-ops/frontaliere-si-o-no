import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractPersonioRenderedJob,
  fetchPersonioJobs,
  preferRenderedPersonioContent,
  withRenderedPersonioPage,
} from '../scripts/lib/ats-clients/personio-client.mjs';
import { stripHtml } from '../scripts/lib/crawler-template.mjs';

// Real page, minimised: https://felfel.jobs.personio.de/job/2798583.
const FELFEL_PAGE = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'personio', 'felfel-job-2798583.html'),
  'utf8',
);

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

describe('extractPersonioRenderedJob (#5253)', () => {
  it('reads every rendered section plus the company block, in page order', () => {
    const { title, descriptionHtml } = extractPersonioRenderedJob(FELFEL_PAGE);
    expect(title).toBe('Sales Representative');
    const headings = [...descriptionHtml.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(['IN KÜRZE', 'DEINE VERANTWORTUNGEN', 'WAS DU MITBRINGST', 'WAS WIR BIETEN', 'Über uns']);
    const text = stripHtml(descriptionHtml);
    // The company block the XML feed never returned.
    expect(text).toContain('FELFEL ist ein Familienunternehmen, das 2013 gegründet wurde.');
    // Nested markup inside a section does not truncate it: the closing line
    // of the benefits section, after its nested list, survives.
    expect(text).toContain('• Tolle Team-Events, wie z.B. unsere bekannten FELFEL Summer-Outings');
    expect(text).toContain('Wenn das der richtige Job für dich ist, dann bewirb dich jetzt');
    // Page chrome stays out.
    expect(text).not.toContain('Powered by Personio');
  });

  it('returns an empty body for a page without Personio content blocks', () => {
    expect(extractPersonioRenderedJob('<html><h1>Jobs</h1><p>Nothing here</p></html>'))
      .toEqual({ title: '', descriptionHtml: '' });
  });
});

describe('preferRenderedPersonioContent', () => {
  it('prefers the rendered page body and title over the feed fields', () => {
    expect(preferRenderedPersonioContent(
      { title: 'Field Service Associate', renderedDescriptionHtml: '## IN SHORT\n\n<p>English body</p>', descriptionHtml: 'ld' },
      { title: 'Servicemitarbeitende im Aussendienst', descriptionHtml: '## IN KÜRZE\n\n<p>Deutscher Text</p>' },
    )).toEqual({ title: 'Field Service Associate', descriptionHtml: '## IN SHORT\n\n<p>English body</p>' });
  });

  it('keeps the feed fields when the page rendered nothing, JSON-LD only filling an empty feed body', () => {
    expect(preferRenderedPersonioContent({ title: '', renderedDescriptionHtml: '', descriptionHtml: 'ld' }, { title: 'T', descriptionHtml: 'feed' }))
      .toEqual({ title: 'T', descriptionHtml: 'feed' });
    expect(preferRenderedPersonioContent({ title: '', renderedDescriptionHtml: '', descriptionHtml: 'ld' }, { title: 'T', descriptionHtml: '' }))
      .toEqual({ title: 'T', descriptionHtml: 'ld' });
  });
});

describe('rendered page as the published description', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetchPersonioJobs replaces the feed sections with the rendered job page', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(`
        <workzag-jobs><position>
          <id>2798583</id><name>Sales Representative</name><office>Zürich</office>
          <jobDescriptions><jobDescription><name>IN KÜRZE</name><value>Nur der Feed.</value></jobDescription></jobDescriptions>
        </position></workzag-jobs>
      `, { status: 200 }))
      .mockResolvedValueOnce(new Response(FELFEL_PAGE, { status: 200 }));

    const [job] = await fetchPersonioJobs('felfel');

    expect(job.title).toBe('Sales Representative');
    expect(job.descriptionHtml).toContain('## Über uns');
    expect(job.descriptionHtml).not.toContain('Nur der Feed.');
  });

  it('withRenderedPersonioPage fills a search.json record whose description is empty in the requested language', async () => {
    // kellerhals-carrard 2811560: `search.json?language=de` returns an empty
    // description for an English-only position; the parser used to publish a
    // 231-character placeholder instead of the vacancy.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(`
      <h1 class="page_jobTitle__x detail-title job-position-title">Business Development &amp; Data Analytics Manager (80-100%)</h1>
      <div class="page_jobDescription__x detail-content-block">
        <div class="page_jobDescriptionItem__x jb-description-item"><h2 class="page_jobDescriptionItemTitle__x detail-block-title">Your mission</h2>
          <div class="page_richTextContent__x rich-text-content detail-block-description"><ul><li><div>Shape business development</div></li></ul></div></div>
      </div>
      <div class="page_jobDescriptionItem__x detail-content-block detail-content-block-about-us"><h2 class="page_jobDescriptionItemTitle__x detail-block-title">About us</h2>
        <div class="page_richTextContent__x rich-text-content detail-block-description"><p>Six locations in all language regions.</p></div></div>
    `, { status: 200 }));

    const record = await withRenderedPersonioPage(
      { id: 2811560, name: 'Business Development & Data Analytics Manager (80-100%)', description: '', office: 'Bern,Zürich' },
      'https://kellerhals-carrard.jobs.personio.com/job/2811560',
    );

    expect(record.office).toBe('Bern,Zürich');
    expect(record.name).toBe('Business Development & Data Analytics Manager (80-100%)');
    expect(stripHtml(record.description)).toContain('Shape business development');
    expect(record.description).toContain('## About us');
  });

  it('withRenderedPersonioPage keeps the listing record when the page cannot be read', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('gone', { status: 404 }));
    const record = { id: 1, name: 'Role', description: '<p>Listing body</p>' };
    await expect(withRenderedPersonioPage(record, 'https://x.jobs.personio.com/job/1')).resolves.toEqual({
      ...record, datePosted: '', postedDate: '', postingDateSource: 'unknown', postedAt: null,
    });
  });
});
