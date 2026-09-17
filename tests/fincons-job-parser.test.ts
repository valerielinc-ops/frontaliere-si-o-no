import { describe, expect, it } from 'vitest';
import {
  parseFinconsListingsPage,
  parseFinconsJobDetail,
  buildFinconsLocalizedContent,
} from '../scripts/lib/fincons-job-parser.mjs';

describe('fincons-job-parser', () => {
  it('parses Lugano listing rows', () => {
    const html = `
      <table id="jobs_table">
        <tr id="row_job_1">
          <td>
            <a class="job_title_link" href="/apply/jobs/details/RJq7pkxbLu?city=lugano&">Angular / Java - Senior Full-Stack Developer</a>
            <br /><span class="resumator_department">Lugano</span>
          </td>
          <td>Lugano, Ticino, Switzerland</td>
        </tr>
        <tr id="row_job_2">
          <td>
            <a class="job_title_link" href="/apply/jobs/details/mr9JiUnS9N?city=lugano&">QA/Test Automation Engineer</a>
          </td>
          <td>Lugano, Ticino, Switzerland</td>
        </tr>
      </table>
    `;
    const rows = parseFinconsListingsPage(html);
    expect(rows).toHaveLength(2);
    expect(rows.finconsListingReadComplete).toBe(true);
    expect(rows.finconsListingSourceRowCount).toBe(2);
    expect(rows[0].title).toBe('Angular / Java - Senior Full-Stack Developer');
    expect(rows[0].location).toBe('Lugano, Ticino, Switzerland');
  });

  it('does not prove an empty snapshot when the row selector misses source markup', () => {
    const html = `
      <table id="jobs_table">
        <tr id="row_job_1">
          <td><a class="job-title-link" href="/apply/jobs/details/selector-drift">Role</a></td>
          <td>Lugano, Ticino, Switzerland</td>
        </tr>
      </table>
    `;

    const rows = parseFinconsListingsPage(html);

    expect(rows).toHaveLength(0);
    expect(rows.finconsListingSourceRowCount).toBe(1);
    expect(rows.finconsListingReadComplete).toBe(false);
  });

  it('proves a legitimate empty snapshot only with an explicit listing marker', () => {
    const html = `
      <table id="jobs_table">
        <tbody><tr><td>No open positions are currently available.</td></tr></tbody>
      </table>
    `;

    const rows = parseFinconsListingsPage(html);

    expect(rows).toHaveLength(0);
    expect(rows.finconsListingSourceRowCount).toBe(0);
    expect(rows.finconsListingEmptyStateObserved).toBe(true);
    expect(rows.finconsListingReadComplete).toBe(true);
  });

  it('does not prove an empty snapshot from hidden listing template copy', () => {
    const rows = parseFinconsListingsPage(`
      <table id="jobs_table">
        <tbody><tr><td><template>No open positions are currently available.</template></td></tr></tbody>
      </table>
    `);

    expect(rows).toHaveLength(0);
    expect(rows.finconsListingEmptyStateObserved).toBe(false);
    expect(rows.finconsListingReadComplete).toBe(false);
  });

  it('does not prove an empty snapshot from unrelated body copy without the listing container', () => {
    const rows = parseFinconsListingsPage(`
      <main><p>No open positions are currently available.</p></main>
    `);

    expect(rows).toHaveLength(0);
    expect(rows.finconsListingEmptyStateObserved).toBe(false);
    expect(rows.finconsListingReadComplete).toBe(false);
  });

  it('parses detail page and JSON-LD fields', () => {
    const html = `
      <link rel="canonical" href="https://fincons.applytojob.com/apply/RJq7pkxbLu/Angular-Java-Senior-FullStack-Developer" />
      <script type="application/ld+json">
      {
        "@type":"JobPosting",
        "title":"Angular / Java - Senior Full-Stack Developer",
        "datePosted":"2026-02-20",
        "validThrough":"2026-05-21",
        "employmentType":"FULL_TIME",
        "experienceRequirements":"Experienced",
        "uniqueJobCode":"job_20260220112408_6XP4TQFMRVG7NLCL",
        "jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","addressLocality":"Lugano","addressRegion":"Ticino","postalCode":"6900"}}
      }
      </script>
      <div class="job_header">
        <h2 class="job_company">Fincons Group</h2>
        <h1 class="job_title">Angular / Java - Senior Full-Stack Developer</h1>
        <h3 class="job_meta">Lugano - Lugano, Ticino, Switzerland - Full Time</h3>
      </div>
      <div class="job_description">
        <p>Fincons Group is an IT business consulting company.</p>
        <p><strong>What you'll do:</strong></p>
        <ul><li>Design and develop web applications</li></ul>
        <p><strong>What you bring:</strong></p>
        <ul><li>5+ years of experience</li></ul>
      </div>
    `;
    const detail = parseFinconsJobDetail(html);
    expect(detail.title).toBe('Angular / Java - Senior Full-Stack Developer');
    expect(detail.location).toBe('Lugano, Ticino, Switzerland');
    expect(detail.postalCode).toBe('6900');
    expect(detail.description).toContain('## What you\'ll do');
    expect(detail.description).toContain('- Design and develop web applications');

    const localized = buildFinconsLocalizedContent(detail);
    expect(localized.titleByLocale.en).toBe('Angular / Java - Senior Full-Stack Developer');
    expect(localized.slugByLocale.en).toContain('angular-java-senior-full-stack-developer-fincons-group-lugano-ticino-switzerland');
  });
});
