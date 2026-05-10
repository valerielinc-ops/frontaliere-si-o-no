import { describe, expect, it } from 'vitest';
import {
  parseBoardListings,
  isBoardTargetLocation,
  parseBoardJobDetail,
} from '../scripts/lib/board-job-parser.mjs';

const LISTING_HTML = `
  <section>
    <article class="card card--career">
      <div class="card-body">
        <p class="card-title visual-h5">UX Designer</p>
        <div class="location-with-pin"><strong>Chiasso, Switzerland</strong></div>
        <a class="btn-link btn-link--primary" href="https://boardinternationalsa.applytojob.com/apply/VAUNIdK4v9">Learn more and apply</a>
      </div>
    </article>
    <article class="card card--career">
      <div class="card-body">
        <p class="card-title visual-h5">Sr. Account Manager</p>
        <div class="location-with-pin"><strong>Zürich, Switzerland</strong></div>
        <a class="btn-link btn-link--primary" href="https://boardinternationalsa.applytojob.com/apply/demo">Learn more and apply</a>
      </div>
    </article>
  </section>
`;

const DETAIL_HTML = `
  <link rel="canonical" href="https://boardinternationalsa.applytojob.com/apply/VAUNIdK4v9/UX-Designer" />
  <script type="application/ld+json">
  {
    "@type": "JobPosting",
    "title": "UX Designer",
    "datePosted": "2026-03-09",
    "validThrough": "2026-06-07",
    "employmentType": "FULL_TIME",
    "experienceRequirements": "Mid Level",
    "jobLocation": {
      "@type": "Place",
      "address": {
        "@type": "PostalAddress",
        "addressLocality": "Chiasso",
        "addressRegion": "Ticino"
      }
    }
  }
  </script>
  <div class="job-header">
    <h2>UX Designer</h2>
    <div class="job-attributes-container">
      <div title="Location">Chiasso, Ticino, Switzerland</div>
      <div id="resumator-job-employment">Full Time</div>
      <div title="Department">Strategy &amp; Operations</div>
      <div id="resumator-job-experience">Mid Level</div>
    </div>
  </div>
  <div id="job-description">
    <p>At Board, we help enterprises plan smarter.</p>
    <strong>Your responsibilities will include:</strong>
    <ul><li>Collaborating with product and engineering.</li><li>Designing intuitive workflows.</li></ul>
    <strong>What we look for:</strong>
    <ul><li>Figma proficiency.</li></ul>
  </div>
`;

describe('parseBoardListings', () => {
  it('extracts listing cards and target location detection works', () => {
    const rows = parseBoardListings(LISTING_HTML);
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe('UX Designer');
    expect(rows[0].location).toBe('Chiasso, Switzerland');
    expect(isBoardTargetLocation(rows[0].location)).toBe(true);
    // Cathedral 2026-05-10: Zürich (ZH) is now a target canton — rows[1] location "Zürich, Switzerland" passes.
    expect(isBoardTargetLocation(rows[1].location)).toBe(true);
  });
});

describe('parseBoardJobDetail', () => {
  it('extracts title, location, metadata and markdown-like description', () => {
    const detail = parseBoardJobDetail(DETAIL_HTML);
    expect(detail.title).toBe('UX Designer');
    expect(detail.location).toContain('Chiasso');
    expect(detail.employmentType).toBe('Full Time');
    expect(detail.department).toBe('Strategy & Operations');
    expect(detail.experience).toBe('Mid Level');
    expect(detail.canonicalUrl).toContain('/UX-Designer');
    expect(detail.description).toContain('At Board, we help enterprises plan smarter.');
    expect(detail.description).toContain('## Your responsibilities will include:');
    expect(detail.description).toContain('- Collaborating with product and engineering.');
  });
});
