/**
 * Linnea SA crawler parser tests
 *
 * Tests parseAccordionJobs() and htmlToText() using real HTML fixtures
 * mirroring the actual Foundation accordion structure on linnea.ch/careers/.
 *
 * Regression case: "ERP System Administrator and IT Project Lead"
 *   https://www.linnea.ch/careers/?position=1
 */
import { describe, it, expect } from 'vitest';

import { parseAccordionJobs, htmlToText, MIN_DESC_LENGTH } from '@/scripts/lib/linnea-job-parser.mjs';

// ─── Fixture: real accordion HTML structure from linnea.ch/careers/ ───────────
// Mirrors the actual HTML served by WordPress + Foundation on 2026-03-18.

const FIXTURE_ERP_ACCORDION = `
<section id="join">
  <div class="row">
    <div class="large-12 columns">
      <h2>OPEN POSITIONS</h2>
      <hr class="grey">
    </div>
  </div>
  <div class="row">
    <div class="large-12 columns">
      <ul class="accordion" data-accordion="i27gdq-accordion" data-allow-all-closed="true" role="tablist">
        <li class="accordion-item animation animate__fadeIn animate__delay-500ms" data-accordion-item="">
          <a href="#" class="accordion-title" aria-controls="g0jpw3-accordion" role="tab"
             id="g0jpw3-accordion-label" aria-expanded="false" aria-selected="false">
            <h4>ERP System Administrator and IT Project Lead, Indeterminate / Full time, Riazzino, Switzerland</h4>
          </a>
          <div class="accordion-content" data-tab-content="" role="tabpanel"
               aria-labelledby="g0jpw3-accordion-label" aria-hidden="true" id="g0jpw3-accordion">
            <div class="filter">
              <p><a rel="nofollow" class="btn eng white active">ENG</a></p>
            </div>
            <article class="eng active">
              <h3>ERP System Administrator and IT Project Lead</h3>
              <p>We are looking for an <strong>ERP System Administrator and IT Project Lead</strong> to support the implementation, administration, and development of key business applications. The position involves coordination of ERP-related projects and other business tools such as BI, CRM, and digital archiving systems.</p>
              <p><strong>Main Responsibilities:</strong></p>
              <ul>
                <li>Support the Executive management and Head of ICT in the development and execution of the company's ICT strategy and digitalization roadmap.</li>
                <li>Evaluate new applications, tools and technologies to support business efficiency, automation and scalability.</li>
                <li>Lead and coordinate IT projects, including ERP (Microsoft Dynamics AX 2012 or similar), Business Intelligence, Document Digital Archiving, and Customer Relationship Management.</li>
                <li>Act as administrator for ERP and related applications, managing configuration, user access, and system integrity.</li>
                <li>Support business departments in gathering requirements and translating them into technical solutions.</li>
                <li>Oversee project timelines, risk assessments, and change management processes in collaboration with internal teams and external vendors.</li>
                <li>Provide ongoing functional support and act as the point of reference for departments using ERP, BI, Document Digital Archiving, and CRM systems.</li>
                <li>Ensure systems and documentation meet internal standards and regulatory requirements (e.g., GxP, data integrity).</li>
                <li>Participate in audits and collaborate with QA to maintain system validation and compliance.</li>
              </ul>
              <p>&nbsp;</p>
              <p><strong>Requirements:</strong></p>
              <ul>
                <li>At least 5 years of experience with ERP systems (e.g., Dynamics AX, SAP, Oracle).</li>
                <li>Experience managing IT projects in medium-to-large companies; experience in regulated industries is preferred.</li>
                <li>Solid understanding of GxP guidelines and IT compliance in regulated environments.</li>
                <li>Educational background in Computer Science or related fields.</li>
              </ul>
              <ul>
                <li>Ability to work independently and lead cross-department initiatives</li>
              </ul>
              <ul>
                <li>Good command of spoken and written English.</li>
              </ul>
              <p class="apply">
                <a rel="nofollow" class="btn white">Apply</a>
              </p>
            </article>
          </div>
        </li>
      </ul>
    </div>
  </div>
</section>
`;

// Minimal fixture with two jobs to test multi-job parsing.
// Descriptions are intentionally realistic and >= 350 chars after extraction.
const FIXTURE_TWO_JOBS = `
<h2>OPEN POSITIONS</h2>
<ul class="accordion" data-accordion>
  <li class="accordion-item" data-accordion-item="">
    <a href="#" class="accordion-title"><h4>Quality Assurance Specialist, Full time, Riazzino, Switzerland</h4></a>
    <div class="accordion-content" data-tab-content="">
      <article class="eng active">
        <h3>Quality Assurance Specialist</h3>
        <p>We are looking for a Quality Assurance Specialist to join our GMP-certified manufacturing team in Riazzino, Ticino. The successful candidate will be responsible for maintaining and improving our quality management system in line with Swiss and European pharmaceutical regulations.</p>
        <p><strong>Key responsibilities:</strong></p>
        <ul>
          <li>Develop and maintain quality systems in accordance with GMP requirements and ICH guidelines.</li>
          <li>Conduct internal audits, support regulatory inspections and customer audits.</li>
          <li>Review batch records, analytical results and certificates of analysis to ensure compliance.</li>
          <li>Manage deviations, CAPAs, change controls and out-of-specification investigations.</li>
          <li>Collaborate with production and analytical development teams to resolve quality issues.</li>
          <li>Maintain documentation in the quality management system and ensure version control.</li>
        </ul>
        <p><strong>Requirements:</strong></p>
        <ul>
          <li>Degree in Chemistry, Pharmacy, Biology, or related scientific field.</li>
          <li>Minimum 3 years of QA experience in a pharmaceutical or biotech environment.</li>
          <li>Knowledge of ICH guidelines and Swiss/EU GMP regulations (Swissmedic, EMA).</li>
          <li>Fluent in English; Italian or German is a strong advantage.</li>
        </ul>
        <p class="apply"><a class="btn white">Apply</a></p>
      </article>
    </div>
  </li>
  <li class="accordion-item" data-accordion-item="">
    <a href="#" class="accordion-title"><h4>Production Operator, Part time, Riazzino, Switzerland</h4></a>
    <div class="accordion-content" data-tab-content="">
      <article class="eng active">
        <h3>Production Operator</h3>
        <p>We are seeking a Production Operator to support our botanical extraction and active pharmaceutical ingredient (API) manufacturing processes at our Riazzino site. The role is part-time and involves hands-on work in a GMP-regulated production environment.</p>
        <p><strong>Responsibilities:</strong></p>
        <ul>
          <li>Operate and maintain production equipment according to validated SOPs and batch instructions.</li>
          <li>Accurately record production data, measurements and in-process controls in batch records.</li>
          <li>Ensure cleanliness, orderliness and GMP compliance of the production area at all times.</li>
          <li>Report deviations promptly and participate in root-cause analysis and troubleshooting activities.</li>
          <li>Support cleaning validation activities and equipment qualification programs.</li>
        </ul>
        <p><strong>Requirements:</strong></p>
        <ul>
          <li>Technical diploma (CFC) or equivalent relevant production experience in a regulated industry.</li>
          <li>Previous experience in pharmaceutical, chemical or food manufacturing is preferred.</li>
          <li>Strong attention to detail and discipline in following written procedures and GMP standards.</li>
          <li>Good communication skills in Italian; knowledge of English is an advantage.</li>
        </ul>
        <p class="apply"><a class="btn white">Apply</a></p>
      </article>
    </div>
  </li>
</ul>
`;

// Short content fixture — should be rejected by the MIN_DESC_LENGTH guard
const FIXTURE_SHORT_DESC = `
<h2>OPEN POSITIONS</h2>
<ul class="accordion" data-accordion>
  <li class="accordion-item" data-accordion-item="">
    <a href="#" class="accordion-title"><h4>Intern, Internship, Riazzino, Switzerland</h4></a>
    <div class="accordion-content" data-tab-content="">
      <article class="eng active">
        <h3>Intern</h3>
        <p>TBD.</p>
        <p class="apply"><a class="btn white">Apply</a></p>
      </article>
    </div>
  </li>
</ul>
`;

// ─── parseAccordionJobs tests ──────────────────────────────────────────────────

describe('parseAccordionJobs — ERP regression fixture', () => {
  it('finds exactly one job', () => {
    const jobs = parseAccordionJobs(FIXTURE_ERP_ACCORDION);
    expect(jobs).toHaveLength(1);
  });

  it('extracts the correct title', () => {
    const [job] = parseAccordionJobs(FIXTURE_ERP_ACCORDION);
    expect(job.title).toBe('ERP System Administrator and IT Project Lead');
  });

  it('extracts the contract type', () => {
    const [job] = parseAccordionJobs(FIXTURE_ERP_ACCORDION);
    expect(job.contractType).toMatch(/indeterminate|full time/i);
  });

  it('extracts location as Riazzino', () => {
    const [job] = parseAccordionJobs(FIXTURE_ERP_ACCORDION);
    expect(job.location).toBe('Riazzino');
  });

  it(`description is >= ${MIN_DESC_LENGTH} characters`, () => {
    const [job] = parseAccordionJobs(FIXTURE_ERP_ACCORDION);
    expect(job.descriptionText.length).toBeGreaterThanOrEqual(MIN_DESC_LENGTH);
  });

  it('description contains key responsibilities text', () => {
    const [job] = parseAccordionJobs(FIXTURE_ERP_ACCORDION);
    expect(job.descriptionText).toContain('ERP System Administrator');
    expect(job.descriptionText).toContain('Main Responsibilities');
    expect(job.descriptionText).toContain('GxP');
    expect(job.descriptionText).toContain('Dynamics AX');
  });

  it('description does not contain the apply button text', () => {
    const [job] = parseAccordionJobs(FIXTURE_ERP_ACCORDION);
    expect(job.descriptionText).not.toContain('Apply');
  });

  it('description does not contain HTML tags', () => {
    const [job] = parseAccordionJobs(FIXTURE_ERP_ACCORDION);
    expect(job.descriptionText).not.toMatch(/<[a-z]/i);
  });

  it('description does not duplicate the job title heading', () => {
    // The <h3> title is stripped — should not appear at the very start
    const [job] = parseAccordionJobs(FIXTURE_ERP_ACCORDION);
    expect(job.descriptionText).not.toMatch(/^ERP System Administrator and IT Project Lead\s*$/m);
  });
});

describe('parseAccordionJobs — multi-job fixture', () => {
  it('finds two jobs', () => {
    const jobs = parseAccordionJobs(FIXTURE_TWO_JOBS);
    expect(jobs).toHaveLength(2);
  });

  it('assigns sequential idx starting at 1', () => {
    const jobs = parseAccordionJobs(FIXTURE_TWO_JOBS);
    expect(jobs[0].idx).toBe(1);
    expect(jobs[1].idx).toBe(2);
  });

  it('extracts distinct titles', () => {
    const jobs = parseAccordionJobs(FIXTURE_TWO_JOBS);
    expect(jobs[0].title).toBe('Quality Assurance Specialist');
    expect(jobs[1].title).toBe('Production Operator');
  });

  it('each job description meets minimum length', () => {
    const jobs = parseAccordionJobs(FIXTURE_TWO_JOBS);
    for (const job of jobs) {
      expect(job.descriptionText.length).toBeGreaterThanOrEqual(MIN_DESC_LENGTH);
    }
  });

  it('correctly detects part-time contract type', () => {
    const jobs = parseAccordionJobs(FIXTURE_TWO_JOBS);
    expect(jobs[1].contractType).toMatch(/part time/i);
  });
});

describe('parseAccordionJobs — guards', () => {
  it('returns empty array when OPEN POSITIONS section is missing', () => {
    const jobs = parseAccordionJobs('<html><body><p>No jobs here.</p></body></html>');
    expect(jobs).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(parseAccordionJobs('')).toHaveLength(0);
  });

  it('skips items whose description is shorter than MIN_DESC_LENGTH', () => {
    const jobs = parseAccordionJobs(FIXTURE_SHORT_DESC);
    expect(jobs).toHaveLength(0);
  });
});

// ─── htmlToText tests ──────────────────────────────────────────────────────────

describe('htmlToText', () => {
  it('strips all HTML tags', () => {
    const result = htmlToText('<p>Hello <strong>world</strong></p>');
    expect(result).not.toMatch(/<[a-z]/i);
  });

  it('preserves text content', () => {
    const result = htmlToText('<p>Hello <strong>world</strong></p>');
    expect(result).toContain('Hello');
    expect(result).toContain('world');
  });

  it('converts block elements to newlines (preserves structure)', () => {
    const result = htmlToText('<p>First paragraph</p><p>Second paragraph</p>');
    expect(result).toMatch(/First paragraph[\s\S]*Second paragraph/);
    expect(result).toContain('\n');
  });

  it('decodes common HTML entities', () => {
    const result = htmlToText('AT&amp;T &lt;test&gt; &nbsp;space');
    expect(result).toContain('AT&T');
    expect(result).toContain('<test>');
    expect(result).toContain('space');
  });

  it('returns empty string for empty input', () => {
    expect(htmlToText('')).toBe('');
    expect(htmlToText(null as any)).toBe('');
  });

  it('removes script and style content', () => {
    const result = htmlToText('<script>alert("xss")</script><style>.foo{}</style><p>Safe</p>');
    expect(result).not.toContain('alert');
    expect(result).not.toContain('.foo');
    expect(result).toContain('Safe');
  });
});
