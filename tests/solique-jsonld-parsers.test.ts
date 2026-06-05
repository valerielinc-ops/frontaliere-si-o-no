import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs crawler libs, no type declarations
import { parseSoliqueListing, parseSoliqueApiListing, extractSoliqueDetailContent } from '../scripts/lib/solique-common.mjs';
// @ts-expect-error — plain .mjs
import { extractJobPostingLd, jobPostingDescriptionText, jobPostingAddress } from '../scripts/lib/jsonld-jobposting.mjs';

const SOLIQUE_SSR = `
<div class="job">
  <a id="3994586" href="job/details/3994586" target="_blank">
    <div class="jobtitle_workload">
      <div class="jobtitle">Assistent/in Gesundheit und Soziales</div>
      <span class="min workload_from">70</span><span class="max workload_to">100</span>
    </div>
    <div class="job-info"><div class="location">Basel</div></div>
  </a>
</div>`;

const SOLIQUE_API = {
  jobs: [
    { title: { value: 'Assistenzärztin / Assistenzarzt', id: '4006969' }, link: 'jobs/Assistenzaerztin---Assistenzarzt--4006969', location: { value: 'Winterthur' }, from: { value: '60' }, to: { value: '80' } },
    { title: { value: '', id: '4004323' }, link: 'jobs/--4004323', location: { value: 'Winterthur' } }, // placeholder, must be skipped
  ],
};

// "job-introduction" + "content" template (adullam/ipw migrated boards). The
// intro must NOT swallow the content block (would duplicate the prose).
const SOLIQUE_DETAIL = `<div class="job-introduction">Gute Pflege lebt von Beziehung und Vertrauen zwischen Menschen jeden Alters.</div>
<div class="content"><ul><li>Aufgabe eins im Team</li><li>Aufgabe zwei mit Verantwortung</li></ul></div>
<div class="apply-button">Bewerben</div>`;

const JSONLD_DETAIL = `<script type="application/ld+json">
{"@context":"https://schema.org/","@type":"JobPosting","title":"Pflegefachperson HF",
"description":"<p>Ihre Aufgaben</p><ul><li>Pflege</li><li>Betreuung</li></ul>",
"employmentType":"PART_TIME","datePosted":"2026-06-05",
"jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","addressLocality":"Zofingen","addressRegion":"Aargau","streetAddress":"Mühlethalstrasse 27","postalCode":"4800"}}}
</script>`;

describe('Solique listing parsers (consolidated solique-common)', () => {
  it('parses the flat SSR board (adullam variant)', () => {
    const rows = parseSoliqueListing(SOLIQUE_SSR);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: '3994586',
      title: 'Assistent/in Gesundheit und Soziales',
      location: 'Basel',
      minPct: 70,
      maxPct: 100,
    });
  });

  it('parses the JSON API board (ipw variant) and skips empty-title placeholders', () => {
    const rows = parseSoliqueApiListing(SOLIQUE_API, 'ipw', 'de');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: '4006969',
      title: 'Assistenzärztin / Assistenzarzt',
      location: 'Winterthur',
      minPct: 60,
      maxPct: 80,
      detailUrl: 'https://live.solique.ch/ipw/de/jobs/Assistenzaerztin---Assistenzarzt--4006969',
    });
  });

  it('extracts the job-introduction + content template without duplicating prose', () => {
    const text = extractSoliqueDetailContent(SOLIQUE_DETAIL);
    expect(text).toContain('Gute Pflege lebt von Beziehung');
    expect(text).toContain('• Aufgabe eins im Team');
    // intro sentence must appear exactly once (no swallow-and-re-extract)
    const occurrences = text.split('Gute Pflege lebt von Beziehung').length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('JSON-LD JobPosting helper', () => {
  it('extracts JobPosting fields', () => {
    const ld = extractJobPostingLd(JSONLD_DETAIL);
    expect(ld?.title).toBe('Pflegefachperson HF');
    expect(ld?.employmentType).toBe('PART_TIME');
    const desc = jobPostingDescriptionText(ld.description);
    expect(desc).toContain('Ihre Aufgaben');
    expect(desc).toContain('• Pflege');
    expect(jobPostingAddress(ld)).toMatchObject({
      addressLocality: 'Zofingen', addressRegion: 'Aargau', postalCode: '4800', streetAddress: 'Mühlethalstrasse 27',
    });
  });
});
