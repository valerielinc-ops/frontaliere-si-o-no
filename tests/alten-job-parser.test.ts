import { describe, expect, it } from 'vitest';
import {
  parseAltenListingHtml,
  parseAltenDetailHtml,
  isAltenTicinoLocation,
} from '../scripts/lib/alten-job-parser.mjs';
import { SWISS_LOCALITY_SENTENCE_SPLIT_RX } from '../scripts/lib/swiss-locality-sentence-split.mjs';

describe('alten-job-parser', () => {
  it('recognizes ticino locations', () => {
    expect(isAltenTicinoLocation('Ticino')).toBe(true);
    expect(isAltenTicinoLocation('Switzerland Ticino')).toBe(true);
    // Cathedral 2026-05-10: TARGET_CANTONS expanded to all 26 CH cantons;
    // Bern (BE) is now a target, only truly foreign locations are false.
    expect(isAltenTicinoLocation('Bern')).toBe(true);
    expect(isAltenTicinoLocation('Tokyo')).toBe(false); // foreign city, not CH
  });

  it('parses ticino listing cards', () => {
    const html = `
      <div class="wp-block-webfactory-card">
        <div class="card-inner row align-items-center justify-content-between offer-item offer-list-item h-100 px-3 px-md-1">
          <a class="card-title" href="https://www.alten.ch/jobs/875-it-generic-net-software-developer/"><b>Full Stack .Net Developer</b></a>
          <div class="card-location"><span class="location-list">Ticino</span></div>
          <div class="card-date"><span class="mx-2">03/03/2026</span></div>
        </div>
      </div>
      <div class="wp-block-webfactory-card">
        <div class="card-inner row align-items-center justify-content-between offer-item offer-list-item h-100 px-3 px-md-1">
          <a class="card-title" href="https://www.alten.ch/jobs/884-business-analyst/"><b>Business Analyst</b></a>
          <div class="card-location"><span class="location-list">Bern</span></div>
          <div class="card-date"><span class="mx-2">04/03/2026</span></div>
        </div>
      </div>`;
    // Cathedral 2026-05-10: Bern (BE) is now a target canton — both listings pass the filter.
    const parsed = parseAltenListingHtml(html);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].title).toBe('Full Stack .Net Developer');
    expect(parsed[0].location).toBe('Ticino');
  });

  it('parses detail body into description blocks', () => {
    const html = `
      <div class="entry-content wp-block-post-content is-layout-flow wp-block-post-content-is-layout-flow">
        <div class="wp-block-jobboard-offer">
          <h1>Full Stack .Net Developer</h1>
          <div class="wp-block-jobboard-offer-meta"><div class="block--inner" title="intro"><span><p><strong>ALTEN Group</strong></p><p>Engineering and IT services.</p></span></div></div>
          <div class="wp-block-jobboard-offer-meta"><div class="block--inner" title="tasks"><span><p><strong>Responsibilities</strong></p><ul><li>Build APIs</li></ul></span></div></div>
          <div class="wp-block-jobboard-offer-meta"><div class="block--inner" title="requirements"><span><p><strong>Requirements</strong></p><ul><li>.NET</li></ul><p><strong>What we offer you</strong></p><p>Permanent contract.</p></span></div></div>
          <a href="https://www.alten.ch/jobs/875-it-generic-net-software-developer/apply">APPLY</a>
          <div>Job info <div>Location Ticino</div><div>03/03/2026</div></div>
        </div>
      </div>`;
    const parsed = parseAltenDetailHtml(html, 'https://www.alten.ch/jobs/875-it-generic-net-software-developer/');
    expect(parsed.title).toBe('Full Stack .Net Developer');
    expect(parsed.applyUrl).toContain('/apply');
    expect(parsed.location).toContain('Ticino');
    expect(parsed.description).toContain('## Intro');
    expect(parsed.description).toContain('Responsibilities');
    expect(parsed.slug).toContain('sviluppatore-full-stack-net');
  });

  // Regression for #1451 / verification of #1457: the location cut must preserve
  // the abbreviation period in Swiss city names beginning with "St." (St. Moritz,
  // St. Gallen). A blanket "." split truncated these to "St", which then failed
  // the Swiss-municipality whitelist downstream and silently dropped the jobs from
  // the dataset. End-to-end through the parser, with trailing prose run into the
  // same node (no newline before the next sentence).
  it.each([
    ['St. Moritz, Switzerland', 'St. Moritz, Switzerland'],
    ['St. Gallen, Switzerland', 'St. Gallen, Switzerland'],
  ])('preserves the "St." period in %s and cuts trailing prose', (city, expected) => {
    const html = `
      <div class="wp-block-jobboard-offer">
        <h1>Cloud Engineer</h1>
        <div class="block--inner">Location: ${city}.Availability to work on-site is required. What we offer you…</div>
        <a href="https://www.alten.ch/jobs/999-cloud-engineer/apply">APPLY</a>
      </div>`;
    const parsed = parseAltenDetailHtml(html, 'https://www.alten.ch/jobs/999-cloud-engineer/');
    expect(parsed.location).toBe(expected);
  });

  // Verification of #1457: the variable-length negative lookbehind in the shared
  // split constant runs in the MAIN Node V8 (the crawler hands page.content() to
  // parseAltenDetailHtml as a plain string — NOT inside page.evaluate / a vm
  // sandbox), so it is fully supported. Assert the shared regex directly so any
  // drift in either call site (alten-job-parser / assemble-jobs-dataset) is caught,
  // including "Ste." which the alten whitelist does not currently accept.
  it.each([
    ['St. Moritz, Switzerland. Availability…', 'St. Moritz, Switzerland'],
    ['St. Gallen.Trailing prose', 'St. Gallen'],
    ['Ste. Croix, Switzerland. More text', 'Ste. Croix, Switzerland'],
    ['Ticino, Switzerland.Availability', 'Ticino, Switzerland'],
  ])('SWISS_LOCALITY_SENTENCE_SPLIT_RX cuts %s to the bare locality', (input, expected) => {
    expect(input.split(SWISS_LOCALITY_SENTENCE_SPLIT_RX)[0].trim()).toBe(expected);
  });
});
