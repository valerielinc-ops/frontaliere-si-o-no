import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const policyPath = path.join(root, 'data/url-pruning-approved-patterns.json');

describe('historical job page content policy', () => {
  it('never approves thinning for archived job URL classes', () => {
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as {
      patterns?: Array<{ urlClass?: string }>;
    };
    const historicalClasses = new Set(['previousSlug', 'soft-landing-expired']);
    const configuredHistoricalPatterns = (policy.patterns ?? [])
      .filter((pattern) => historicalClasses.has(String(pattern.urlClass)));

    expect(configuredHistoricalPatterns).toEqual([]);
  });
});
