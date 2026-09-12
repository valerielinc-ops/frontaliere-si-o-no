import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  path.resolve(__dirname, '../scripts/scaffold-crawler.mjs'),
  'utf8',
);

const SPEC_BACKED_PARSERS = [
  'sta',
  'stellentreff',
  'stellenpartner',
  'okjob',
  'ete',
  'anker-swiss',
  'accor',
  'gmo',
  'michaelpage',
  'recruitingapp-2649',
];

describe('scaffold-crawler — generated contract follows employmentType', () => {
  it('does not emit a hardcoded full-time contract beside a calculated type', () => {
    const generatedJob = source.slice(
      source.indexOf('const employmentType = detectEmploymentType(listing.timeType || title);'),
      source.indexOf('jobs.push(job);', source.indexOf('const employmentType = detectEmploymentType(listing.timeType || title);')),
    );

    expect(generatedJob).toContain("contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time'");
    expect(generatedJob).toContain('employmentType,');
    expect(generatedJob).not.toContain("contract: 'full-time'");
  });

  it('keeps all ten spec-backed parser emissions aligned with the template', () => {
    for (const parser of SPEC_BACKED_PARSERS) {
      const parserSource = fs.readFileSync(
        path.resolve(__dirname, `../scripts/lib/${parser}-job-parser.mjs`),
        'utf8',
      );

      expect(parserSource, parser).toContain(
        'const employmentType = detectEmploymentType(listing.timeType || title);',
      );
      expect(parserSource, parser).toContain(
        "contract: employmentType === 'PART_TIME' ? 'part-time' : 'full-time',",
      );
      expect(parserSource, parser).toContain('employmentType,');
      expect(parserSource, parser).not.toMatch(
        /contract: 'full-time',\n\s+employmentType: detectEmploymentType\(listing\.timeType \|\| title\),/,
      );
    }
  });
});
