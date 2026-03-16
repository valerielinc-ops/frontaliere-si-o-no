import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('FART PDF crawler integration', () => {
  it('uses the shared PDF extraction pipeline for job descriptions', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'scripts/update-fart-jobs.mjs'),
      'utf-8',
    );

    expect(source).toContain("from './lib/pdf-job-content.mjs'");
    expect(source).toContain('extractPdfJobContentFromUrl(listing.pdfUrl)');
    expect(source).toContain('buildPdfBackedDescription({');
    expect(source).toContain("adapter.crawlerModes = ['html', 'pdf']");
  });
});
