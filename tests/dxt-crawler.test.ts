/**
 * DXT Commodities S.A. crawler parser tests
 *
 * Tests parseWpsmAccordionPanels(), titleOverlap(), and htmlToText()
 * using HTML fixtures mirroring the actual WPSM accordion structure on
 * dxt.com/careers/.
 *
 * Regression case: "junior-legal-dxt" at https://dxt.com/careers/?panel=20897_1
 *   — title heading in panel body (h1) must be stripped from description text
 *   — tab title from <a> must match content-title with overlap >= 0.7
 */
import { describe, it, expect } from 'vitest';

import {
  parseWpsmAccordionPanels,
  findLuganoAccordionIds,
  titleOverlap,
  htmlToText,
  MIN_DESC_LENGTH,
  MIN_TITLE_OVERLAP,
} from '@/scripts/lib/dxt-job-parser.mjs';

// ─── Fixtures ────────────────────────────────────────────────────────────────
// Mirrors the actual HTML structure served by dxt.com/careers/ on 2026-03-18.
// Key structural features:
//   - Two accordion_pro_20897 elements: one "noresults" (display:none), one real
//   - Tab title contains <i> icon that must be stripped
//   - Panel body starts with <h1>Junior Legal</h1> (content title)
//   - After stripping h1, description must be >= MIN_DESC_LENGTH

const FIXTURE_LUGANO_ACCORDION = `
<h3 id="lugano">LUGANO-SWITZERLAND</h3>

<!-- Hidden "no results" placeholder — must be ignored -->
<div class="noresults_20897 wpsm_panel-group" style="display:none" id="accordion_pro_20897" role="tablist" aria-multiselectable="true">
  <div class="wpsm_panel panel" id="offset_20897">
    <div class="wpsm_panel-heading" role="tab" id="heading_20897">
      <h4 class="wpsm_panel-title"><p>No Result</p></h4>
    </div>
  </div>
</div>

<!-- Real accordion group -->
<div class="wpsm_panel-group" id="accordion_pro_20897" role="tablist" aria-multiselectable="true">
  <div class="wpsm_panel panel wpsm_panel-default" id="offset_20897_1">
    <div class="wpsm_panel-heading" role="tab" id="heading_20897_1">
      <h4 class="wpsm_panel-title">
        <a role="button" data-toggle="collapse" data-parent="#accordion_pro_20897"
           href="#collapse_20897_1" aria-expanded="true" aria-controls="collapse_20897_1"
           class="collapsed nitro-lazy">
          <i class="fa fa fa-laptop ac_title_icon nitro-lazy"></i> Junior Legal
        </a>
      </h4>
    </div>
    <div id="collapse_20897_1" class="wpsm_panel-collapse collapse" role="tabwpsm_panel" aria-labelledby="heading_20897_1">
      <div class="wpsm_panel-body">
        <div id="#wpsm_acc_desc_20897_1" class="wpsm_panel-body_inner animated fadeIn">
          <h1><strong><span lang="EN-US">Junior Legal</span></strong></h1>
          <p class="MsoNormal"><span lang="EN-US">We are seeking to hire a Junior Legal to join our growing Legal department, based in Lugano Switzerland. You will have the right blend of ability to work as part of a team and autonomously within a tight-knit group, operating in an international landscape. We offer a full-time permanent position with a competitive salary. You will also be eligible for our benefits and wellness programs. Full on-the-job training will be given by your mentor and colleagues in a fast-moving professional environment. Individual growth and development support is provided by the Duferco Academy.</span></p>
          <p class="MsoNormal"><strong><span lang="EN-US">Job Description</span></strong></p>
          <p class="MsoNormal"><span lang="EN-US">The candidate will perform the following tasks working in a challenging environment:</span></p>
          <ul>
            <li><span lang="EN-US">Assistance in drafting, reviewing and supporting the negotiation of a wide range of agreements including Power Purchase Agreement (both long and short term), Battery Energy Storage System Agreement and related documentation; Power EFET standard agreements, appendices and individual contracts, parent company guarantees and confidentiality agreements.</span></li>
            <li><span lang="EN-US">Conducting legal research on legal matters in the energy regulatory sector and international trades in various commodities.</span></li>
            <li><span lang="EN-US">Supporting the Legal team in managing legal paperwork (questionnaire, applications, forms, letters, power of attorney, internal policies and procedures).</span></li>
            <li><span lang="EN-US">Managing Know Your Customer (KYC) procedure and documents by reviewing content, confirming accuracy, suggesting additional information, and updating information.</span></li>
          </ul>
          <p class="MsoNormal"><strong><span lang="EN-US">Desired Skills and Experience</span></strong></p>
          <ul>
            <li><span lang="EN-US">Degree in Law with excellent grades.</span></li>
            <li><span lang="EN-US">1&#8211;3 years of experience in a law firm and/or in-house similar role.</span></li>
            <li><span lang="EN-US">Understanding of energy and financial regulatory aspects and/or European tax legislation would be beneficial.</span></li>
            <li><span lang="EN-US">Experience in an energy trading company is a plus.</span></li>
            <li><span lang="EN-US">Excellent knowledge of Italian and English; every other language is a plus.</span></li>
            <li><span lang="EN-US">Ability to meet tight deadlines.</span></li>
            <li><span lang="EN-US">Highly motivated and precise person.</span></li>
            <li><span lang="EN-US">Reliable person with the ability to work under pressure.</span></li>
          </ul>
          <p class="MsoNormal"><span lang="EN-US">Please send your updated CV together with a cover letter to: hr.legal@dxt.com. Only suitable profiles will be contacted.</span></p>
        </div>
      </div>
    </div>
  </div>
</div>
`;

// Fixture: no open positions panel — should produce 0 jobs
const FIXTURE_NO_OPENINGS = `
<div class="wpsm_panel-group" id="accordion_pro_21045" role="tablist" aria-multiselectable="true">
  <div class="wpsm_panel panel wpsm_panel-default" id="offset_21045_1">
    <div class="wpsm_panel-heading" role="tab" id="heading_21045_1">
      <h4 class="wpsm_panel-title">
        <a class="collapsed"><i class="fa fa-briefcase"></i> No open positions</a>
      </h4>
    </div>
    <div id="collapse_21045_1" class="wpsm_panel-collapse collapse">
      <div class="wpsm_panel-body">
        <div id="#wpsm_acc_desc_21045_1" class="wpsm_panel-body_inner">
          <p>No open positions at this time. Please check back later.</p>
        </div>
      </div>
    </div>
  </div>
</div>
`;

// Fixture: tab title mismatch — content title differs with overlap < 0.7
// Tab title: "LUGANO-SWITZERLAND" (section heading mistakenly used as tab label)
// Content title: "Data Analyst" (the real job title)
// This tests the overlap guard: overlap("lugano switzerland", "data analyst") < 0.7
const FIXTURE_TITLE_MISMATCH = `
<div class="wpsm_panel-group" id="accordion_pro_99999" role="tablist" aria-multiselectable="true">
  <div class="wpsm_panel panel wpsm_panel-default" id="offset_99999_1">
    <div class="wpsm_panel-heading" role="tab" id="heading_99999_1">
      <h4 class="wpsm_panel-title">
        <a class="collapsed"><i class="fa fa-briefcase"></i> LUGANO-SWITZERLAND</a>
      </h4>
    </div>
    <div id="collapse_99999_1" class="wpsm_panel-collapse collapse">
      <div class="wpsm_panel-body">
        <div id="#wpsm_acc_desc_99999_1" class="wpsm_panel-body_inner">
          <h2>Data Analyst</h2>
          <p>We are looking for an experienced Data Analyst to join our Lugano team. The successful candidate will work closely with our trading and risk management teams to design and maintain analytical dashboards, build data pipelines, and produce actionable insights from large datasets.</p>
          <p><strong>Key Responsibilities:</strong></p>
          <ul>
            <li>Design and maintain BI dashboards using Power BI or Tableau for front and back office teams.</li>
            <li>Develop and maintain ETL pipelines to ingest and transform trading data from multiple sources.</li>
            <li>Collaborate with traders and risk managers to define key performance indicators and metrics.</li>
            <li>Perform ad-hoc data analysis and provide insights to senior management.</li>
            <li>Ensure data quality, accuracy, and integrity across all reporting systems.</li>
          </ul>
          <p><strong>Requirements:</strong></p>
          <ul>
            <li>Degree in Statistics, Mathematics, Computer Science, or related quantitative field.</li>
            <li>3+ years of experience in a data analysis or business intelligence role.</li>
            <li>Proficiency in SQL, Python or R for data manipulation and analysis.</li>
            <li>Experience with BI tools (Power BI, Tableau, or similar).</li>
            <li>Strong communication skills in English; Italian is an advantage.</li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</div>
`;

// Fixture: short description — should be rejected by MIN_DESC_LENGTH guard
const FIXTURE_SHORT_DESC = `
<div class="wpsm_panel-group" id="accordion_pro_55555" role="tablist" aria-multiselectable="true">
  <div class="wpsm_panel panel wpsm_panel-default" id="offset_55555_1">
    <div class="wpsm_panel-heading" role="tab" id="heading_55555_1">
      <h4 class="wpsm_panel-title">
        <a class="collapsed">Intern</a>
      </h4>
    </div>
    <div id="collapse_55555_1" class="wpsm_panel-collapse collapse">
      <div class="wpsm_panel-body">
        <div id="#wpsm_acc_desc_55555_1" class="wpsm_panel-body_inner">
          <p>TBD.</p>
        </div>
      </div>
    </div>
  </div>
</div>
`;

// ─── parseWpsmAccordionPanels — Lugano Junior Legal regression ────────────────

describe('parseWpsmAccordionPanels — Junior Legal regression', () => {
  it('finds exactly one job', () => {
    const jobs = parseWpsmAccordionPanels(FIXTURE_LUGANO_ACCORDION, '20897');
    expect(jobs).toHaveLength(1);
  });

  it('extracts the correct title (icon stripped from tab title)', () => {
    const [job] = parseWpsmAccordionPanels(FIXTURE_LUGANO_ACCORDION, '20897');
    expect(job.title).toBe('Junior Legal');
  });

  it('assigns the correct panelId', () => {
    const [job] = parseWpsmAccordionPanels(FIXTURE_LUGANO_ACCORDION, '20897');
    expect(job.panelId).toBe('20897_1');
  });

  it(`description is >= ${MIN_DESC_LENGTH} characters`, () => {
    const [job] = parseWpsmAccordionPanels(FIXTURE_LUGANO_ACCORDION, '20897');
    expect(job.descriptionText.length).toBeGreaterThanOrEqual(MIN_DESC_LENGTH);
  });

  it('description does NOT begin with the job title heading', () => {
    // The <h1>Junior Legal</h1> heading must be stripped from the description
    const [job] = parseWpsmAccordionPanels(FIXTURE_LUGANO_ACCORDION, '20897');
    expect(job.descriptionText).not.toMatch(/^Junior Legal\s*$/m);
  });

  it('description contains key responsibilities content', () => {
    const [job] = parseWpsmAccordionPanels(FIXTURE_LUGANO_ACCORDION, '20897');
    expect(job.descriptionText).toContain('Power Purchase Agreement');
    expect(job.descriptionText).toContain('Know Your Customer');
    expect(job.descriptionText).toContain('Degree in Law');
  });

  it('description does not contain HTML tags', () => {
    const [job] = parseWpsmAccordionPanels(FIXTURE_LUGANO_ACCORDION, '20897');
    expect(job.descriptionText).not.toMatch(/<[a-z]/i);
  });

  it('description decodes HTML entities (em-dash)', () => {
    const [job] = parseWpsmAccordionPanels(FIXTURE_LUGANO_ACCORDION, '20897');
    expect(job.descriptionText).toContain('1–3 years');
  });

  it('ignores the noresults accordion (display:none placeholder)', () => {
    // The noresults element must be skipped — only 1 real job expected
    const jobs = parseWpsmAccordionPanels(FIXTURE_LUGANO_ACCORDION, '20897');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].title).toBe('Junior Legal');
  });
});

// ─── parseWpsmAccordionPanels — no open positions ─────────────────────────────

describe('parseWpsmAccordionPanels — guards', () => {
  it('skips panel with "no open positions" in body', () => {
    const jobs = parseWpsmAccordionPanels(FIXTURE_NO_OPENINGS, '21045');
    expect(jobs).toHaveLength(0);
  });

  it('skips panel whose description is shorter than MIN_DESC_LENGTH', () => {
    const jobs = parseWpsmAccordionPanels(FIXTURE_SHORT_DESC, '55555');
    expect(jobs).toHaveLength(0);
  });

  it('returns empty array for missing accordion group ID', () => {
    expect(parseWpsmAccordionPanels(FIXTURE_LUGANO_ACCORDION, '')).toHaveLength(0);
  });

  it('returns empty array for empty HTML', () => {
    expect(parseWpsmAccordionPanels('', '20897')).toHaveLength(0);
  });

  it('returns empty array when accordion group is not found', () => {
    expect(parseWpsmAccordionPanels(FIXTURE_LUGANO_ACCORDION, '99000')).toHaveLength(0);
  });
});

// ─── parseWpsmAccordionPanels — title overlap guard ──────────────────────────

describe('parseWpsmAccordionPanels — title overlap guard', () => {
  it(`uses content title when tab title overlaps < ${MIN_TITLE_OVERLAP} with h1/h2/h3`, () => {
    // Tab title is "LUGANO-SWITZERLAND", content h2 is "Data Analyst"
    // Word overlap is 0 — below threshold → must use content title
    const jobs = parseWpsmAccordionPanels(FIXTURE_TITLE_MISMATCH, '99999');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].title).toBe('Data Analyst');
  });

  it('description after mismatch recovery does not start with the content heading', () => {
    const [job] = parseWpsmAccordionPanels(FIXTURE_TITLE_MISMATCH, '99999');
    expect(job.descriptionText).not.toMatch(/^Data Analyst\s*$/m);
  });

  it('description after mismatch recovery contains real job content', () => {
    const [job] = parseWpsmAccordionPanels(FIXTURE_TITLE_MISMATCH, '99999');
    expect(job.descriptionText).toContain('Power BI');
    expect(job.descriptionText).toContain('ETL');
  });
});

// ─── titleOverlap ────────────────────────────────────────────────────────────

describe('titleOverlap', () => {
  it('returns 1 for identical strings', () => {
    expect(titleOverlap('Junior Legal', 'Junior Legal')).toBe(1);
  });

  it('returns 1 for same words in different case', () => {
    expect(titleOverlap('Junior Legal', 'junior legal')).toBe(1);
  });

  it('returns high overlap for near-identical titles', () => {
    // "Application Support Engineer" vs "Application Support Engineer (Stamford)"
    const overlap = titleOverlap('Application Support Engineer', 'Application Support Engineer Stamford');
    expect(overlap).toBeGreaterThanOrEqual(0.7);
  });

  it('returns low overlap for unrelated titles', () => {
    const overlap = titleOverlap('LUGANO-SWITZERLAND', 'Data Analyst');
    expect(overlap).toBeLessThan(MIN_TITLE_OVERLAP);
  });

  it('returns 0 for one empty string', () => {
    expect(titleOverlap('', 'Data Analyst')).toBe(0);
    expect(titleOverlap('Junior Legal', '')).toBe(0);
  });

  it('returns 1 for both empty strings', () => {
    expect(titleOverlap('', '')).toBe(1);
  });

  it('is case and punctuation insensitive', () => {
    expect(titleOverlap('Junior Legal (Lugano)', 'Junior Legal')).toBeGreaterThan(0.5);
  });
});

// ─── findLuganoAccordionIds ──────────────────────────────────────────────────

describe('findLuganoAccordionIds', () => {
  it('finds accordion ID from h3 with Lugano text', () => {
    const ids = findLuganoAccordionIds(FIXTURE_LUGANO_ACCORDION);
    expect(ids).toContain('20897');
  });

  it('is case-insensitive for Lugano/Switzerland keywords', () => {
    const html = `<h3>LUGANO – SWITZERLAND</h3>
    <div id="accordion_pro_12345"></div>`;
    const ids = findLuganoAccordionIds(html);
    expect(ids).toContain('12345');
  });

  it('returns empty array when no Lugano section is found', () => {
    const ids = findLuganoAccordionIds('<h3>LONDON-UK</h3><div id="accordion_pro_99"></div>');
    expect(ids).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(findLuganoAccordionIds('')).toHaveLength(0);
  });
});

// ─── htmlToText ──────────────────────────────────────────────────────────────

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

  it('converts block elements to newlines', () => {
    const result = htmlToText('<p>First</p><p>Second</p>');
    expect(result).toContain('\n');
    expect(result).toMatch(/First[\s\S]*Second/);
  });

  it('decodes HTML entities', () => {
    const result = htmlToText('AT&amp;T &lt;test&gt; &nbsp;space &#8211;dash');
    expect(result).toContain('AT&T');
    expect(result).toContain('<test>');
    expect(result).toContain('–dash');
  });

  it('removes script and style content', () => {
    const result = htmlToText('<script>alert("xss")</script><style>.foo{}</style><p>Safe</p>');
    expect(result).not.toContain('alert');
    expect(result).not.toContain('.foo');
    expect(result).toContain('Safe');
  });

  it('returns empty string for empty input', () => {
    expect(htmlToText('')).toBe('');
    expect(htmlToText(null as any)).toBe('');
  });
});
