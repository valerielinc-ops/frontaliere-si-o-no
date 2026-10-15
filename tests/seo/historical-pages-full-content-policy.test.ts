import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { jobDescriptionTextToHtml } from '../../build-plugins/shared/jobDescription/toHtml';

const root = path.resolve(__dirname, '../..');
const policyPath = path.join(root, 'data/url-pruning-approved-patterns.json');
const jobsSeoPluginPath = path.join(root, 'build-plugins/jobsSeoPagesPlugin.ts');
const descriptionSerializerPath = path.join(root, 'build-plugins/shared/jobDescription/toHtml.ts');

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

  // Since #10937 anonymous static HTML carries the shared description preview
  // (tests/job-description-preview.test.ts); the archive keeps that section
  // instead of dropping it, and signed-in readers still get the full text.
  it('keeps the archived description section through the shared preview gate', () => {
    const source = fs.readFileSync(jobsSeoPluginPath, 'utf8');
    const archivedDescription = `## Mansioni\n\n${'contenuto archiviato '.repeat(180)}\n\nCoda originale oltre il vecchio limite`;
    const rendered = jobDescriptionTextToHtml(archivedDescription);

    expect(source).toMatch(/if \(jobDescription && jobDescription\.length > 30\) \{\s*staticBodyParts\.push\(renderJobDescriptionGate\(jobDescription, locale\)\);/);
    expect(source).not.toContain('descText.slice(0, 2000)');
    expect(rendered).toContain('Coda originale oltre il vecchio limite');
  });

  it('does not retain long archived descriptions in the shared HTML LRU', () => {
    const source = fs.readFileSync(descriptionSerializerPath, 'utf8');

    expect(source).toContain('const JOB_DESC_HTML_CACHE_MAX_INPUT_CHARS = 4_096;');
    expect(source).toContain('if (!cacheable) return result;');
  });
});
