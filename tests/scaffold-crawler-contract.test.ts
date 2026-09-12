import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  path.resolve(__dirname, '../scripts/scaffold-crawler.mjs'),
  'utf8',
);

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
});
