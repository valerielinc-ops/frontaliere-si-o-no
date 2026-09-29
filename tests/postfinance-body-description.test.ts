import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractPostFinanceBodyDescription } from '../scripts/update-postfinance-jobs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures');

/**
 * Verifies the PostFinance body-description extractor that pulls the full
 * job description from SuccessFactors `joblayouttoken` blocks instead of
 * the SEO-truncated `<meta name="description">` tag.
 *
 * The legacy `job.post.ch/PostFinance/job/...` pages render every job
 * field inside `<span class="rtltextaligneligible">` elements; the
 * description is the only span containing rich HTML (`<p>`, `<ul>`).
 */
describe('PostFinance body-description extractor', () => {
  it('extracts the full description from a real Compliance Officer page', () => {
    const fixturePath = path.join(FIXTURE_DIR, 'postfinance-compliance-officer.html');
    const html = fs.readFileSync(fixturePath, 'utf-8');

    const description = extractPostFinanceBodyDescription(html);

    expect(description.length).toBeGreaterThanOrEqual(150);
    expect(description.toLowerCase()).toContain('compliance');
    expect(description.toLowerCase()).toContain('postfinance');
    // Make sure HTML tags were stripped.
    expect(description).not.toMatch(/<\/?p>/i);
    expect(description).not.toMatch(/<\/?li>/i);
  });

  it('returns an empty string for empty HTML', () => {
    expect(extractPostFinanceBodyDescription('<html></html>')).toBe('');
    expect(extractPostFinanceBodyDescription('')).toBe('');
  });

  it('returns an empty string when no rtltextaligneligible spans are present', () => {
    const html = `
      <html><head>
        <meta name="description" content="just a meta tag" />
        <title>Job Page</title>
      </head><body><p>nothing relevant</p></body></html>
    `;
    expect(extractPostFinanceBodyDescription(html)).toBe('');
  });

  it('decodes HTML entities and strips inline tags', () => {
    const longBody = 'A'.repeat(160);
    const html = `
      <div class="joblayouttoken">
        <span lang="it-IT" class="rtltextaligneligible">
          <p>Smith &amp; Co. &#39;welcomes&#39; you &mdash; ${longBody}</p>
          <ul><li>R&amp;D role</li></ul>
        </span>
      </div>
    `;
    const result = extractPostFinanceBodyDescription(html);
    expect(result).toContain('Smith & Co.');
    expect(result).toContain("'welcomes'");
    expect(result).toContain('R&D role');
    expect(result).not.toContain('&amp;');
    expect(result).not.toContain('&#39;');
    expect(result).not.toMatch(/<\/?p>/i);
  });

  it('prefers paragraph-style spans over short single-value spans', () => {
    const longBody = 'B'.repeat(200);
    const html = `
      <span class="rtltextaligneligible">Bellinzona</span>
      <span class="rtltextaligneligible">01.05.2026</span>
      <span class="rtltextaligneligible">75.000,00</span>
      <span class="rtltextaligneligible"><p>${longBody}</p></span>
      <span class="rtltextaligneligible">Sì</span>
    `;
    const result = extractPostFinanceBodyDescription(html);
    expect(result).toBe(longBody);
  });

  it('reads the body to its balanced closing tag and keeps list items as bullets (job 74128)', () => {
    // Minimised from https://jobs.postfinance.ch/job/Senior-DevOps-Software-&-Specification-Engineer-%28wmd%29/74128-de_DE:
    // the intro sits in an inline <span>, so a non-greedy `…</span>` match
    // published only that paragraph; the recruiter contact block is the page's
    // only itemprop="description" span and must not win.
    const html = `
      <div class="joblayouttoken"><span class="rtltextaligneligible">Bern|Bern|BE|Schweiz|CHE</span></div>
      <div class="joblayouttoken"><span xml:lang="de-DE" lang="de-DE" class="rtltextaligneligible"><p><span>Bei PostFinance betreiben und entwickeln wir unsere Requirements-Management-Plattform Polarion ALM weiter und gestalten gleichzeitig den Aufbau eines modernen Specification-as-Code Ansatzes. Wir sind ein Team im Aufbau und suchen dich als Senior DevOps Software &amp; Specification Engineer.</span></p>\r\n<p><strong>Das kannst du bewirken</strong></p>\r\n<ul>\r\n<li>Du übernimmst Verantwortung für den Betrieb, die Wartung und die Weiterentwicklung unserer Requirements-Management-Plattformen</li>\r\n<li>Du betreibst unser etabliertes Requirements-Management-Tool Polarion</li>\r\n</ul>\r\n<p><strong>Das bringst du mit</strong></p>\r\n<ul>\r\n<li>Mehrjährige Erfahrung als Software Engineer mit DevOps-Mindset</li>\r\n</ul></span></div>
      <div class="joblayouttoken"><span xml:lang="de-DE" lang="de-DE" itemprop="description" class="rtltextaligneligible"><div id="contactDetails"><div>PF</div><div class="contactOne"><div class="cName">Ansprechperson</div><div class="cPhone">[[cust_secondRecruiterPhone]]</div></div></div></span></div>
    `;

    const result = extractPostFinanceBodyDescription(html);

    expect(result).toContain('Senior DevOps Software & Specification Engineer.');
    expect(result).toContain('Das kannst du bewirken');
    expect(result).toContain('\n- Du übernimmst Verantwortung für den Betrieb');
    expect(result).toContain('\n- Du betreibst unser etabliertes Requirements-Management-Tool Polarion');
    expect(result).toContain('Das bringst du mit');
    expect(result).toContain('\n- Mehrjährige Erfahrung als Software Engineer');
    expect(result).not.toContain('cust_secondRecruiterPhone');
    expect(result).not.toMatch(/[\r<>]/);
  });
});
