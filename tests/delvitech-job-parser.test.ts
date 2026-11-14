import { describe, expect, it } from 'vitest';
import {
  parseDelvitechCareerPage,
  parseDelvitechCareerWidgetConfig,
  parseDelvitechZohoListings,
  isDelvitechRecruitSite,
  isDelvitechCompanyJob,
  parseDelvitechJobDetail,
  isDelvitechTicinoJob,
} from '../scripts/lib/delvitech-job-parser.mjs';
import {
  evaluateDelvitechAuthoritativeSnapshot,
  isTargetJob,
  shouldPreserveDelvitechSnapshot,
} from '../scripts/update-delvitech-jobs.mjs';

describe('Delvitech job parser', () => {
  it('extracts vacancy links from the career page cards', () => {
    const html = `
      <div class="post-content">
        <a class="fusion-column-anchor" href="https://legacy.delvi.tech/application-engineer-2/"></a>
        <div class="fusion-layout-column"><h5>Application Engineer</h5></div>
        <a class="fusion-column-anchor" href="https://legacy.delvi.tech/customer-support-manager/"></a>
        <div class="fusion-layout-column"><h5>Customer Support Manager</h5></div>
      </div>
    `;
    const jobs = parseDelvitechCareerPage(html);
    expect(jobs).toHaveLength(2);
    expect(jobs[0].href).toContain('/application-engineer-2/');
  });

  it('accepts relative and same-company detail links after the source changes URL form', () => {
    const html = `
      <div class="post-content">
        <a class="fusion-column-anchor" href="/application-engineer-2/"></a>
        <div class="fusion-layout-column"><h5>Application Engineer</h5></div>
        <a class="fusion-column-anchor" href="https://delvi.tech/customer-support-manager/"></a>
        <div class="fusion-layout-column"><h5>Customer Support Manager</h5></div>
        <a class="fusion-column-anchor" href="https://jobs.example.invalid/unrelated/"></a>
        <div class="fusion-layout-column"><h5>Unrelated role</h5></div>
      </div>
    `;
    const jobs = parseDelvitechCareerPage(html, 'https://delvi.tech/careers/');
    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.href)).toEqual([
      'https://delvi.tech/application-engineer-2/',
      'https://delvi.tech/customer-support-manager/',
    ]);
    expect(jobs.delvitechListingMarkupSeen).toBe(true);
    expect(jobs.delvitechListingRecordCount).toBe(2);
  });

  it('accepts a path-relative detail link under the career listing path', () => {
    const html = `
      <div class="post-content">
        <div class="fusion-layout-column">
          <a class="fusion-column-anchor" href="job-123"></a>
          <h5>Engineer</h5>
        </div>
      </div>
    `;
    const jobs = parseDelvitechCareerPage(html);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      href: 'https://legacy.delvi.tech/career/job-123',
      title: 'Engineer',
    });
  });

  it('reads semantic open-role cards from the canonical careers page', () => {
    const html = `
      <main>
        <section id="open-roles">
          <article class="role-card">
            <h3>Application Engineer</h3>
            <a href="/application-engineer-2/">View role</a>
          </article>
          <article class="role-card">
            <a href="/customer-support-manager/">Customer Support Manager</a>
          </article>
        </section>
        <a href="/careers/">See open roles</a>
        <a href="/news/company-update/">News</a>
      </main>
    `;
    const jobs = parseDelvitechCareerPage(html, 'https://delvi.tech/careers/');
    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.href)).toEqual([
      'https://delvi.tech/application-engineer-2/',
      'https://delvi.tech/customer-support-manager/',
    ]);
    expect(jobs.map((job) => job.title)).toEqual([
      'Application Engineer',
      'Customer Support Manager',
    ]);
    expect(jobs.delvitechListingMarkupSeen).toBe(true);
    expect(jobs.delvitechListingRecordCount).toBe(2);
  });

  it('ignores same-company navigation links outside explicit role cards', () => {
    const html = `
      <main>
        <h2>Open roles</h2>
        <ul>
          <li><a href="/privacy/">Privacy</a></li>
          <li>
            <article>
              <h3>Engineer</h3>
              <a href="/careers/engineer">Apply</a>
            </article>
          </li>
        </ul>
      </main>
    `;
    const jobs = parseDelvitechCareerPage(html, 'https://delvi.tech/careers/');
    expect(jobs.map((job) => job.href)).toEqual([
      'https://delvi.tech/careers/engineer',
    ]);
  });

  it('does not let a malformed semantic row suppress its structured JobPosting', () => {
    const html = `
      <main>
        <section id="open-roles">
          <article class="role-card">
            <a href="/careers/engineer" aria-label="Open Engineer role"><svg aria-hidden="true"></svg></a>
          </article>
        </section>
      </main>
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'JobPosting',
        title: 'Engineer',
        url: 'https://delvi.tech/careers/engineer',
      })}</script>
    `;
    const jobs = parseDelvitechCareerPage(html, 'https://delvi.tech/careers/');
    expect(jobs).toEqual([{
      href: 'https://delvi.tech/careers/engineer',
      title: 'Engineer',
    }]);
  });

  it('accepts same-company JobPosting links when the canonical page exposes structured listings', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'E2E Test Engineer',
      url: 'https://delvi.tech/e2e-test-engineer/',
    })}</script>`;
    const jobs = parseDelvitechCareerPage(html);
    expect(jobs).toEqual([{
      href: 'https://delvi.tech/e2e-test-engineer/',
      title: 'E2E Test Engineer',
    }]);
    expect(jobs.delvitechListingMarkupSeen).toBe(true);
  });

  it('reads the public Zoho Recruit widget configuration from the canonical shell', () => {
    const html = `
      <section class="tx-jobs-section">
        <div id="rec_job_listing_div"></div>
        <script>
          rec_embed_js.load({
            widget_id: "rec_job_listing_div",
            page_name: "Careers",
            source: "CareerSite",
            site: "https://delvi.zohorecruit.eu",
            empty_job_msg: "No current Openings"
          });
        </script>
      </section>
    `;
    expect(parseDelvitechCareerWidgetConfig(html)).toEqual({
      site: 'https://delvi.zohorecruit.eu',
      pageName: 'Careers',
      source: 'CareerSite',
      emptyJobMessage: 'No current Openings',
      emptyJobMessageLooksAuthoritative: true,
    });
    expect(isDelvitechRecruitSite('https://delvi.zohorecruit.eu')).toBe(true);
    expect(isDelvitechRecruitSite('https://example.invalid')).toBe(false);
  });

  it('does not claim another employer on the shared Zoho Recruit host', () => {
    expect(isDelvitechCompanyJob({
      companyKey: 'other-company',
      company: 'Other',
      url: 'https://jobs.zohorecruit.eu/public/other',
    })).toBe(false);
    expect(isDelvitechCompanyJob({
      companyKey: 'delvitech-sa',
      company: 'Delvitech SA',
      url: 'https://delvi.zohorecruit.eu/jobs/Careers/123',
    })).toBe(true);
    expect(isDelvitechCompanyJob({
      url: 'https://legacy.delvi.tech/application-engineer-2/',
    })).toBe(true);
  });

  it('maps a successful Zoho Recruit feed and keeps source completeness evidence', () => {
    const listings = parseDelvitechZohoListings({
      code: 'success',
      data: [{
        '$url': 'https://delvi.zohorecruit.eu/jobs/Careers/123/Pre-Sales-Engineer?source=CareerSite',
        Posting_Title: 'Pre-Sales Engineer',
        City: 'Mendrisio',
        State: 'Ticino',
        Country: 'Switzerland',
        Job_Description: '<p>Present and demo inspection systems.</p>',
        Date_Opened: '10/01/2026',
      }],
    });
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({
      href: 'https://delvi.zohorecruit.eu/jobs/Careers/123/Pre-Sales-Engineer?source=CareerSite',
      title: 'Pre-Sales Engineer',
      source: 'zoho-api',
      detail: {
        location: 'Mendrisio, Ticino, Switzerland',
        description: 'Present and demo inspection systems.',
        datePublished: '2026-10-01',
      },
    });
    expect(listings.delvitechListingRecordCount).toBe(1);
    expect(listings.delvitechListingSkippedMalformedRows).toBe(0);
    expect(listings.delvitechListingEmptyStateObserved).toBe(false);
  });

  it('does not hide malformed Zoho rows from the completeness guard', () => {
    const listings = parseDelvitechZohoListings({
      code: 'success',
      data: [{
        '$url': 'https://delvi.zohorecruit.eu/jobs/Careers/123/Engineer',
        Posting_Title: 'Engineer',
        City: 'Mendrisio',
        State: 'Ticino',
        Country: 'Switzerland',
        Job_Description: 'Description',
      }, {
        '$url': 'https://delvi.zohorecruit.eu/jobs/Careers/124/Unknown',
        Posting_Title: 'Unknown',
        Country: 'Switzerland',
      }],
    });
    expect(listings).toHaveLength(1);
    expect(listings.delvitechListingRecordCount).toBe(2);
    expect(listings.delvitechListingSkippedMalformedRows).toBe(1);
  });

  it('counts null provider rows as malformed without discarding valid rows', () => {
    const listings = parseDelvitechZohoListings({
      code: 'success',
      data: [null, {
        '$url': 'https://delvi.zohorecruit.eu/jobs/Careers/123/Engineer',
        Posting_Title: 'Engineer',
        City: 'Mendrisio',
        State: 'Ticino',
        Country: 'Switzerland',
        Job_Description: 'Description',
      }],
    });
    expect(listings).toHaveLength(1);
    expect(listings.delvitechListingRecordCount).toBe(2);
    expect(listings.delvitechListingSkippedMalformedRows).toBe(1);
  });

  it('does not treat a shared Zoho URL as Delvitech ownership', () => {
    const otherCompany = {
      companyKey: 'other-company',
      company: 'Other',
      url: 'https://jobs.zohorecruit.eu/public/other',
    };
    expect(isTargetJob(otherCompany)).toBe(false);
    expect([otherCompany].filter(isTargetJob)).toEqual([]);
  });

  it('keeps an API-empty result non-authoritative without rendered evidence', () => {
    const apiEmpty = parseDelvitechZohoListings({ code: 'success', data: [] });
    expect(apiEmpty.delvitechListingEmptyStateObserved).toBe(false);

    const jobs = [];
    Object.defineProperty(jobs, 'delvitechSourceReadComplete', { value: false });
    expect(shouldPreserveDelvitechSnapshot(jobs)).toBe(true);
    expect(evaluateDelvitechAuthoritativeSnapshot(jobs)).toMatchObject({
      authoritativeEmptySnapshot: false,
      authoritativeSnapshotVerified: false,
    });
  });

  it('does not count external-only anchors as Delvitech listing records', () => {
    const html = `
      <div class="post-content">
        <a class="fusion-column-anchor" href="https://external.example/jobs/1"></a>
      </div>
    `;
    const jobs = parseDelvitechCareerPage(html);
    expect(jobs).toHaveLength(0);
    expect(jobs.delvitechListingRecordCount).toBe(0);
  });

  it('parses detail sections and apply email', () => {
    const html = `
      <script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage', url: 'https://legacy.delvi.tech/application-engineer-2/', datePublished: '2025-04-17T06:46:33+00:00' }] })}</script>
      <div class="post-content">
        <div class="fusion-fullwidth">
          <div class="fusion-text"><h1>Application Engineer</h1></div>
          <div class="fusion-text"><p><strong>ABOUT DELVITECH</strong></p></div>
          <div class="fusion-text"><p>This role is based at our headquarters in Mendrisio.</p></div>
          <div class="fusion-text"><p><strong>KEY RESPONSIBILITIES</strong></p></div>
          <div class="fusion-text"><ul><li>Support customers</li><li>Travel onsite</li></ul></div>
          <div class="fusion-text"><p>Please send your CV to <a href="mailto:career@delvi.tech">career@delvi.tech</a></p></div>
        </div>
      </div>
    `;
    const detail = parseDelvitechJobDetail(html, 'https://legacy.delvi.tech/application-engineer-2/');
    expect(detail.title).toBe('Application Engineer');
    expect(detail.location).toBe('Mendrisio');
    expect(detail.email).toBe('career@delvi.tech');
    expect(detail.description).toContain('## ABOUT DELVITECH');
    expect(detail.description).toContain('- Support customers');
    expect(detail.datePublished).toBe('2025-04-17T06:46:33+00:00');
  });

  it('rejects a publication date from an unrelated WebPage node', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'WebPage', url: 'https://legacy.delvi.tech/other/', datePublished: '2025-04-17' })}</script><div class="post-content"><h1>Application Engineer</h1></div>`;
    expect(parseDelvitechJobDetail(html, 'https://legacy.delvi.tech/application-engineer-2/').datePublished).toBe('');
    const ambiguousHtml = `<script type="application/ld+json">${JSON.stringify([
      { '@type': 'JobPosting', title: 'First role', description: '<p>First</p>' },
      { '@type': 'JobPosting', title: 'Second role', description: '<p>Second</p>' },
    ])}</script><main></main>`;
    expect(parseDelvitechJobDetail(ambiguousHtml, 'https://delvi.tech/unknown-role/')).toMatchObject({
      title: '',
      location: '',
      description: '',
      datePublished: '',
    });
  });

  it('falls back to canonical JobPosting metadata on a redesigned detail page', () => {
    const html = `
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'JobPosting',
        title: 'E2E Test Engineer',
        description: '<p>Build and maintain automated tests.</p>',
        datePosted: '2026-11-01',
        jobLocation: { address: { addressLocality: 'Mendrisio', addressRegion: 'TI', addressCountry: 'CH' } },
      })}</script>
      <main><p>The role is part of the engineering team.</p></main>
    `;
    const detail = parseDelvitechJobDetail(html, 'https://delvi.tech/e2e-test-engineer/');
    expect(detail).toMatchObject({
      title: 'E2E Test Engineer',
      location: 'Mendrisio',
      datePublished: '2026-11-01',
    });
    expect(detail.description).toContain('Build and maintain automated tests.');
  });

  it('filters out the explicit Germany role', () => {
    expect(isDelvitechTicinoJob({
      title: 'Office Manager Germany',
      location: 'Germany',
      description: 'Based in Germany',
    })).toBe(false);
    expect(isDelvitechTicinoJob({
      title: 'Customer Support Manager',
      location: 'Mendrisio',
      description: 'Based at our headquarters in Mendrisio',
    })).toBe(true);
  });

  it('uses only the source location for geographic filtering', () => {
    expect(isDelvitechTicinoJob({
      title: 'Application Engineer',
      location: 'Mendrisio, Switzerland',
      description: 'Collaborate with our Germany and Italy offices on shared projects.',
    })).toBe(true);
    expect(isDelvitechTicinoJob({
      title: 'Application Engineer',
      location: 'Germany',
      description: 'Based at our headquarters in Mendrisio.',
    })).toBe(false);
    expect(isDelvitechTicinoJob({
      title: 'Germany Site Lead',
      location: 'Mendrisio, Switzerland',
      description: 'The role collaborates with teams in Milan and Munich.',
    })).toBe(true);
  });
});
