import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { sourcePostingDateFields, mergeSourcePostingDates } from '../scripts/lib/source-posting-date.mjs';
import { describe, expect, it, vi } from 'vitest';

import {
  inferKnowledgeLabCanton,
  buildKnowledgeLabLocalizedContent,
  isKnowledgeLabSwissRelevant,
  parseKnowledgeLabPublicDetailHtml,
  parseKnowledgeLabPublicListingHtml,
  parseKnowledgeLabListingJson,
} from '../scripts/lib/knowledge-lab-job-parser.mjs';

function daysAgo(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}

describe('Knowledge Lab nationwide location filtering', () => {
  it('keeps Swiss branch cities and rejects foreign cities even with a Swiss state', () => {
    const { items } = parseKnowledgeLabListingJson([
      { id: 1, title: 'Engineer Zurich', branch: { city: 'Zurich', state: 'ZH', country_code: 'CH' } },
      { id: 2, title: 'Engineer abroad', branch: { city: 'Madrid', state: 'ZH', country_code: 'ES' } },
    ]);

    expect(items).toHaveLength(2);
    expect(isKnowledgeLabSwissRelevant(items[0])).toBe(true);
    expect(inferKnowledgeLabCanton(items[0])).toBe('ZH');
    expect(isKnowledgeLabSwissRelevant(items[1])).toBe(false);
    expect(inferKnowledgeLabCanton(items[1])).toBe('');
  });
});

describe('Knowledge Lab public Freshteam portal parsing', () => {
  it('extracts tenant detail links and ignores duplicate or foreign links', () => {
    const { items, recognized } = parseKnowledgeLabPublicListingHtml(`
      <html>
        <head><link rel="canonical" href="https://klab.freshteam.com/jobs/" /></head>
        <body>
          <h1>Open Positions</h1>
          <a href="/jobs/i3GLY8sDKKC5/initiative-application"><h2>Initiative Application</h2></a>
          <a href="/jobs/i3GLY8sDKKC5/initiative-application">Duplicate</a>
          <a href="https://other.example/jobs/not-ours">Ignore</a>
        </body>
      </html>
    `);

    expect(recognized).toBe(true);
    expect(items).toEqual([{
      jobId: 'i3GLY8sDKKC5',
      title: 'Initiative Application',
      detailUrl: 'https://klab.freshteam.com/jobs/i3GLY8sDKKC5/initiative-application',
      applyUrl: 'https://klab.freshteam.com/jobs/i3GLY8sDKKC5/initiative-application',
    }]);
  });

  it('rejects a generic Careers placeholder without a listing contract', () => {
    expect(parseKnowledgeLabPublicListingHtml('<body>Careers</body>')).toEqual({
      items: [],
      recognized: false,
      hasOpenPositionSignals: false,
    });
  });

  it('reads rich JobPosting metadata and rejects thin open details', () => {
    const description = [
      'Knowledge Lab builds digital solutions for banks, insurers, and the public sector.',
      ...Array.from({ length: 12 }, (_, index) => `Requirement ${index + 1} includes meaningful experience, collaboration, and delivery context for this role.`),
    ].join(' ');
    const postedAt = daysAgo(3);
    const detail = parseKnowledgeLabPublicDetailHtml(`
      <html>
        <head>
          <script type="application/ld+json">${JSON.stringify({
            '@type': 'JobPosting',
            description: `<p>${description}</p>`,
            datePosted: postedAt,
            employmentType: 'FULL_TIME',
            jobLocation: { address: {
              addressLocality: 'Zurich',
              postalCode: '8000',
              addressCountry: 'CH',
            } },
          })}</script>
        </head>
        <body>
          <div><span>Services &amp; Delivery</span><h1>Initiative Application</h1><div>Zurich</div><div>Work Type: Full Time</div></div>
        </body>
      </html>
    `, 'https://klab.freshteam.com/jobs/i3GLY8sDKKC5/initiative-application');

    expect(detail.incomplete).toBe(false);
    expect(detail.title).toBe('Initiative Application');
    expect(detail.location).toBe('Zurich');
    expect(detail.postalCode).toBe('8000');
    expect(detail.employmentType).toBe('full-time');
    expect(detail).toMatchObject({ datePosted: postedAt, postedDate: postedAt, postingDateSource: 'reported' });
    expect(detail.descriptionWordCount).toBeGreaterThanOrEqual(50);
    expect(isKnowledgeLabSwissRelevant(detail)).toBe(true);

    const thin = parseKnowledgeLabPublicDetailHtml(
      '<html><body><h1>Short role</h1><p>Zurich</p><p>Apply now.</p></body></html>',
      'https://klab.freshteam.com/jobs/short/short-role',
    );
    expect(thin.incomplete).toBe(true);
  });

  it('prefers JobPosting datePosted over generic page timestamps', () => {
    const publication = daysAgo(5);
    const deadline = daysAgo(-10);
    const detail = parseKnowledgeLabPublicDetailHtml(`
      <html>
        <head>
          <meta property="article:published_time" content="${deadline}" />
          <script type="application/ld+json">${JSON.stringify({
            '@type': 'JobPosting',
            datePosted: publication,
          })}</script>
        </head>
        <body><time datetime="${deadline}">Application deadline</time></body>
      </html>
    `, 'https://klab.freshteam.com/jobs/date-priority/date-priority');

    expect(detail.postedDate).toBe(publication);
  });

  it('keeps missing publication unknown across crawl days without a synthetic sentinel', () => {
    const invalidDateDetail = `
      <html>
        <head><script type="application/ld+json">${JSON.stringify({
          '@type': 'JobPosting',
          datePosted: 'not-a-date',
        })}</script></head>
        <body><h1>Role without a source date</h1></body>
      </html>
    `;

    const reference = Date.now();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(reference);
      const first = parseKnowledgeLabPublicDetailHtml(invalidDateDetail).postedDate;
      vi.setSystemTime(reference + 20 * 86400000);
      const second = parseKnowledgeLabPublicDetailHtml(invalidDateDetail).postedDate;

      expect(first).toBe('');
      expect(second).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats an expired JobPosting validThrough as closed', () => {
    const detail = parseKnowledgeLabPublicDetailHtml(`
      <html>
        <head><script type="application/ld+json">${JSON.stringify({
          '@type': 'JobPosting',
          datePosted: daysAgo(5),
          validThrough: daysAgo(1),
        })}</script></head>
        <body><h1>Expired role</h1><p>This page has no closed banner.</p></body>
      </html>
    `, 'https://klab.freshteam.com/jobs/expired-role/expired-role');

    expect(detail).toEqual({
      closed: true,
      detailUrl: 'https://klab.freshteam.com/jobs/expired-role/expired-role',
    });
  });

  it('treats a closed detail page as terminal instead of a parser failure', () => {
    expect(parseKnowledgeLabPublicDetailHtml(
      '<html><body><p>We are currently not accepting applications for this job.</p></body></html>',
      'https://klab.freshteam.com/jobs/nMw3fT2cfVDY/system-engineer-belgrade-remote',
    )).toEqual({
      closed: true,
      detailUrl: 'https://klab.freshteam.com/jobs/nMw3fT2cfVDY/system-engineer-belgrade-remote',
    });
  });
});


describe('Knowledge Lab publication provenance', () => {
  const unknown = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };
  it('does not treat Freshteam record creation as publication in the compatibility parser', () => {
    for (const created_at of ['', daysAgo(7)]) {
      expect(parseKnowledgeLabListingJson([{ id: 'fixture', title: 'Engineer', created_at }]).items[0]).toMatchObject(unknown);
    }
  });
  it('accepts explicit publication microdata, while an unrelated page timestamp remains unknown', () => {
    const date = daysAgo(4);
    expect(parseKnowledgeLabPublicDetailHtml(`<meta itemprop="datePosted" content="${date}">`)).toMatchObject({ datePosted: date, postedDate: date, postingDateSource: 'reported' });
    expect(parseKnowledgeLabPublicDetailHtml(`<meta property="article:published_time" content="${date}"><time datetime="${date}">Application deadline</time>`)).toMatchObject(unknown);
  });
  it('preserves and validates the original timestamp before calendar rollover or day truncation', () => {
    const today = new Date().toISOString().slice(0, 10);
    const year = new Date().getUTCFullYear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${today}T12:00:00Z`));
    try {
      for (const datePosted of [`${today}T23:00:00Z`, `${year}-02-30T01:00:00Z`, `${today}Tinvalid`]) {
        expect(parseKnowledgeLabPublicDetailHtml(`<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', datePosted })}</script>`)).toMatchObject(unknown);
      }
    } finally { vi.useRealTimers(); }
  });
});


// The CLI starts a crawl on import; inject I/O into its actual declarations.
function runnerFunction(name: string, dependencies: Record<string, unknown>) {
  const file = 'update-knowledge-lab-jobs.mjs';
  const source = readFileSync(new URL(`../scripts/${file}`, import.meta.url), 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const node = tree.statements.find((item): item is ts.FunctionDeclaration => ts.isFunctionDeclaration(item) && item.name?.text === name);
  if (!node) throw new Error(`Missing ${name}`);
  return new Function(...Object.keys(dependencies), `return (${node.getText(tree)});`)(...Object.values(dependencies));
}

describe('Knowledge Lab date evidence through writer and adapter', () => {
  const unknown = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };
  const build = runnerFunction('buildKnowledgeLabJob', {
    sourcePostingDateFields, detectLang: () => 'en', buildKnowledgeLabLocalizedContent, inferKnowledgeLabCanton,
    inferCategory: () => 'engineering', inferSector: () => 'consulting', COMPANY_NAME: 'Knowledge Lab',
    COMPANY_KEY: 'knowledge-lab', COMPANY_DOMAIN: 'knowledge-lab.ch', CAREERS_URL: 'https://knowledge-lab.ch/en/who-we-are/careers',
  });
  const row = { title: 'Engineer', description: 'Source responsibilities and skills.', location: 'Zurich', applyUrl: 'https://klab.freshteam.com/jobs/example/engineer' };
  it('never promotes the legacy placeholder or creation date to reported in the builder or adapter', () => {
    const fresh = build({ ...row, postedDate: '2000-01-01' });
    expect(fresh).toMatchObject(unknown);
    const source = daysAgo(4);
    const verified = build({ ...row, ...sourcePostingDateFields(source) });
    expect(verified).toMatchObject({ postedDate: source, datePosted: source, postingDateSource: 'reported' });
    let output: any;
    const updateAdapter = runnerFunction('updateAdapterConfig', {
      sourcePostingDateFields, writeJson: (_path: string, value: unknown) => { output = value; },
      ADAPTER_PATH: 'scratch-adapter', COMPANY_KEY: 'knowledge-lab', COMPANY_NAME: 'Knowledge Lab', COMPANY_HOST: 'knowledge-lab.ch',
      CAREERS_URL: 'https://knowledge-lab.ch/en/who-we-are/careers', KNOWLEDGE_LAB_FRESHTEAM_JOBS_URL: 'https://klab.freshteam.com/jobs/',
    });
    updateAdapter([fresh]);
    expect(output.seedMetaByUrl[fresh.url]).toMatchObject(unknown);
    updateAdapter([verified]);
    expect(output.seedMetaByUrl[verified.url]).toMatchObject({ datePosted: source, postedDate: source, postingDateSource: 'reported' });
  });
  it('clears an unmarked sentinel during merge and preserves only earlier reported evidence', () => {
    const fresh = build({ ...row, ...unknown });
    let existing: any[] = [];
    let written: any[] = [];
    const merge = runnerFunction('mergeJobs', {
      readExistingCrawlerJobs: () => existing, COMPANY_KEY: 'knowledge-lab', DATA_JOBS: 'scratch', PUBLIC_JOBS: 'scratch-public',
      isTargetJob: () => true, dropKnowledgeLabFabricatedText: () => false, snapshotJobSlugs: () => ({}),
      jobMatchKey: (job: any) => job.url, mergeSourcePostingDates, mergeLocaleTextMap: (_old: unknown, next: unknown) => next,
      captureLostSlugs: () => {}, writeJson: (_path: string, jobs: any[]) => { written = jobs; }, computeCrawlDiff: () => ({}),
      printCrawlChangeSummary: () => {}, writeCrawlChangeSummaryToGH: () => {}, writeJobsSummary: () => {}, printPublishedJobUrls: () => {},
    });
    existing = [{ ...fresh, datePosted: '2000-01-01', postedDate: '2000-01-01', postingDateSource: undefined }];
    merge([fresh]);
    expect(written[0]).toMatchObject(unknown);
    const prior = daysAgo(10);
    existing = [{ ...fresh, ...sourcePostingDateFields(prior) }];
    merge([fresh]);
    expect(written[0]).toMatchObject({ datePosted: prior, postedDate: prior, postingDateSource: 'reported' });
    merge([build({ ...row, ...sourcePostingDateFields(daysAgo(2)) })]);
    expect(written[0]).toMatchObject({ datePosted: prior, postingDateSource: 'reported' });
  });
});
