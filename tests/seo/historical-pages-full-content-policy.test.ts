import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { jobDescriptionTextToHtml } from '../../build-plugins/shared/jobDescription/toHtml';

const root = path.resolve(__dirname, '../..');
const policyPath = path.join(root, 'data/url-pruning-approved-patterns.json');
const jobsSeoPluginPath = path.join(root, 'build-plugins/jobsSeoPagesPlugin.ts');

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

  it('renders the complete archived description in static HTML', () => {
    const source = fs.readFileSync(jobsSeoPluginPath, 'utf8');
    const archivedDescription = `## Mansioni\n\n${'contenuto archiviato '.repeat(180)}\n\nCoda originale oltre il vecchio limite`;
    const rendered = jobDescriptionTextToHtml(archivedDescription);

    expect(source).toContain('const descriptionHtml = plainTextToHtml(jobDescription);');
    expect(source).not.toContain('descText.slice(0, 2000)');
    expect(rendered).toContain('Coda originale oltre il vecchio limite');
  });
});
