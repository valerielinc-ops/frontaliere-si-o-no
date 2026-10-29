import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import ts from 'typescript';
import { hasRecordedJobIdentity } from '../build-plugins/shared/jobArchiveEvidence';

describe('original content retained by orphan enrichment', () => {
  it('keeps localized requirements and posting provenance when search-only signals follow', () => {
    const source = fs.readFileSync('build-plugins/jobsSeoPagesPlugin.ts', 'utf8');
    const start = source.indexOf(' const orphanGscData = new Map<string, OrphanEnriched>();');
    const end = source.indexOf(' // 2. Load expired job data', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const code = ts.transpileModule(source.slice(start, end) + '\nreturn orphanGscData;', {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const original = {
      slug: 'original-job', source: ['translation-cache'], titleByLocale: { en: 'Original job title' },
      requirements: ['IT', 'Go'], requirementsByLocale: { en: ['Original complete requirement'] },
      postingDateSource: 'employer', descriptionByLocale: { en: 'Original source description' },
    };
    const entries = [original, { slug: original.slug, queries: ['stronger search signal'], totalImpressions: 100 }];
    const run = new Function('jobsSeoMemContext', 'readOrphanEnriched', 'rootDir', 'hasRecordedJobIdentity', 'console', code);
    const retained = run({}, () => entries, '.', hasRecordedJobIdentity, { log() {} }).get(original.slug);
    expect(retained).toMatchObject({
      recordedIdentity: true, requirements: original.requirements,
      requirementsByLocale: original.requirementsByLocale, postingDateSource: original.postingDateSource,
      descriptionByLocale: original.descriptionByLocale, totalImpressions: 100,
    });
  });
});
