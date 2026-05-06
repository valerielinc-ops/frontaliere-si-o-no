import { describe, it, expect } from 'vitest';
import { htmlToStructuredText, parseJobCards, parseDetailPage } from '../../scripts/lib/pdgr-job-parser.mjs';

describe('htmlToStructuredText', () => {
  it('preserves <li> bullets on separate lines', () => {
    const out = htmlToStructuredText('<ul><li>A</li><li>B</li></ul>');
    expect(out).toContain('- A');
    expect(out).toContain('- B');
    // Bullets must be on separate lines
    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
    expect(lines).toContain('- A');
    expect(lines).toContain('- B');
  });

  it('converts <br> to newlines inside paragraphs', () => {
    const out = htmlToStructuredText('<p>Hello<br>World</p>');
    expect(out).toContain('Hello');
    expect(out).toContain('World');
    const idxHello = out.indexOf('Hello');
    const idxWorld = out.indexOf('World');
    expect(idxHello).toBeLessThan(idxWorld);
    // There must be a newline between Hello and World
    expect(out.slice(idxHello, idxWorld)).toContain('\n');
  });

  it('decodes basic HTML entities', () => {
    expect(htmlToStructuredText('A &amp; B')).toBe('A & B');
    expect(htmlToStructuredText('&quot;hi&quot;')).toBe('"hi"');
  });
});

describe('parseJobCards', () => {
  function makeCard(href: string, title = 'Some Job') {
    // Mirrors the shape parseJobCards expects: jobs-post grid-item div with
    // data-efrom/data-eto, an <a href>, and a job-title <p>.
    return `
<div class="jobs-post grid-item medizin chur" data-efrom="80" data-eto="100">
  <div class="jobs-post-content">
    <a href="${href}">
      <p class="mb-0 job-title"><b>${title}</b></p>
      <p class="mb-0"><span>Department</span></p>
      <p class="mb-0 jobs-area-txt"><span>Facility</span> | <span>Arbeitsort: Chur</span> | <span class="jobs-employment">Pensum: 80 - 100%</span></p>
    </a>
  </div>
</div>`;
  }

  it('skips non-job CTA cards pointing to /jobs-uebersicht/', () => {
    const html = makeCard(
      'https://www.pdgr.ch/jobs-uebersicht/freiwilligenarbeit/#Bewerbung',
      'Freiwilligenarbeit',
    );
    const cards = parseJobCards(html);
    expect(cards).toHaveLength(0);
  });

  it('accepts real job detail URLs of shape /jobs/{slug}/', () => {
    const html = makeCard('https://www.pdgr.ch/jobs/some-real-slug/', 'Pflegefachperson HF');
    const cards = parseJobCards(html);
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe('Pflegefachperson HF');
    expect(cards[0].detailUrl).toBe('https://www.pdgr.ch/jobs/some-real-slug/');
  });

  it('mixes real + non-job cards and only keeps real ones', () => {
    const html = [
      makeCard('https://www.pdgr.ch/jobs-uebersicht/freiwilligenarbeit/#Bewerbung', 'Freiwilligenarbeit'),
      makeCard('https://www.pdgr.ch/jobs/oberarzt-psychiatrie/', 'Oberarzt Psychiatrie'),
      makeCard('https://www.pdgr.ch/jobs-uebersicht/praktikum/#Bewerbung', 'Praktikum Info'),
    ].join('\n');
    const cards = parseJobCards(html);
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe('Oberarzt Psychiatrie');
  });
});

describe('parseDetailPage', () => {
  it('preserves <ul><li> bullets in description', () => {
    const html = `
<html><body>
  <span id="acf_jobs_duties"><ul><li>foo</li><li>bar</li></ul></span>
</body></html>`;
    const result = parseDetailPage(html);
    expect(result.description).toContain('\n- foo');
    expect(result.description).toContain('\n- bar');
    expect(result.description).toContain('Ihre Aufgaben:');
  });

  it('joins multiple ACF sections with double newlines', () => {
    const html = `
<span id="acf_jobs_duties"><ul><li>duty1</li><li>duty2</li></ul></span>
<span id="acf_jobs_requirements"><ul><li>req1</li><li>req2</li></ul></span>`;
    const result = parseDetailPage(html);
    expect(result.description).toContain('Ihre Aufgaben:');
    expect(result.description).toContain('Unser Anforderungsprofil:');
    expect(result.description).toContain('\n- duty1');
    expect(result.description).toContain('\n- req1');
    // Sections separated by blank line
    expect(result.description).toContain('\n\n');
  });
});
