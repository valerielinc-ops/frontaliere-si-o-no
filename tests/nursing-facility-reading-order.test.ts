import { describe, expect, it } from 'vitest';
import { injectNursingFacilityLinks, NURSING_FACILITIES_ANCHOR } from '../build-plugins/shared/nursingFacilityLinks';

describe('nursing guide reading order', () => {
 const marker = 'data-health-facility-links';
 const block = `<aside ${marker}><a href="/strutture-sanitarie/demo/">Structure</a></aside>`;
 it('keeps the H1, actual jobs and full guide ahead of related facilities', () => {
  const html = `<main><h1>OSS</h1><section>Jobs</section><article>Guide</article>${NURSING_FACILITIES_ANCHOR}<section>FAQ</section></main>`;
  const result = injectNursingFacilityLinks(html, block, marker);
  expect(result.outcome).toBe('inserted');
  expect(result.html.indexOf(marker)).toBeGreaterThan(result.html.indexOf('</article>'));
  expect(result.html.indexOf(marker)).toBeLessThan(result.html.indexOf('FAQ'));
  expect(injectNursingFacilityLinks(result.html, block, marker)).toEqual({ html: result.html, outcome: 'duplicate' });
 });
 it('appends links to older main shells without displacing their first content', () => {
  expect(injectNursingFacilityLinks('<main><h1>OSS</h1></main>', block, marker).html).toBe(`<main><h1>OSS</h1>${block}</main>`);
  expect(injectNursingFacilityLinks('<div>no main</div>', block, marker).outcome).toBe('no-anchor');
 });
});
