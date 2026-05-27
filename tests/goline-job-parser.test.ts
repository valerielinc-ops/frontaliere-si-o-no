import { describe, expect, it } from 'vitest';
import { parseGolineOpportunitiesPage, buildGolineLocalizedContent } from '../scripts/lib/goline-job-parser.mjs';

const HTML = `
<section class="inner-page">
  <h2>Web Full Stack Developer (Backend &amp; Frontend) – Explore Opportunities</h2>
  <h3>Exciting Opportunities for Growth and Development in Tech</h3>
  <p>GOLINE SA is seeking talented <strong>Full Stack Developers</strong> to work on both frontend and backend development.</p>
  <h3>Key Responsibilities</h3>
  <ul>
    <li>Create <strong>websites, web applications, and APIs</strong>.</li>
    <li>Maintain and optimize existing <strong>Laravel (PHP)</strong> and <strong>WordPress</strong> solutions.</li>
  </ul>
  <h3>Required Skills and Experience</h3>
  <ul>
    <li><strong>5+ years of experience</strong> in <strong>JavaScript</strong> and <strong>PHP</strong>.</li>
    <li><strong>English (minimum B1)</strong> and <strong>fluent Italian</strong> (essential).</li>
  </ul>
  <h3>Work Environment</h3>
  <ul>
    <li><strong>Location:</strong> Stabio, Canton of Ticino, Switzerland.</li>
    <li><strong>Contract:</strong> Indefinite term.</li>
  </ul>
  <p><a href="https://www.goline.ch/self-application/">Click to send your resume</a></p>
</section>
`;

describe('goline-job-parser', () => {
  it('parses the opportunities page and extracts the active role', () => {
    const role = parseGolineOpportunitiesPage(HTML);
    expect(role.title).toContain('Web Full Stack Developer');
    expect(role.location).toBe('Stabio');
    expect(role.applyUrl).toBe('https://www.goline.ch/self-application/');
    expect(role.sections.some((section) => /Key Responsibilities/i.test(section.heading))).toBe(true);
  });

  it('builds localized content with locale-specific slugs', () => {
    const role = parseGolineOpportunitiesPage(HTML);
    const localized = buildGolineLocalizedContent(role);
    expect(localized.it.title).toContain('Sviluppatore');
    expect(localized.de.slug).toContain('web-full-stack-entwickler');
    expect(localized.fr.description).toContain('GOLINE SA recherche');
  });
});
