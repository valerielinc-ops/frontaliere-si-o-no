import { describe, expect, it } from 'vitest';
import {
  parseAltenListingHtml,
  parseAltenDetailHtml,
  isAltenTicinoLocation,
} from '../scripts/lib/alten-job-parser.mjs';

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
});
