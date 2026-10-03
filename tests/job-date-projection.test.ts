import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localeJobsSplitPlugin } from '../build-plugins/localeJobsSplitPlugin';

const date = '2026-01-01';
describe('additive publication date API projection', () => {
  it.each(['reported', 'unknown', undefined])('preserves %s provenance without backfilling legacy', (postingDateSource) => {
    const root = mkdtempSync(join(tmpdir(), 'date-projection-'));
    try {
      mkdirSync(join(root, 'data'));
      writeFileSync(join(root, 'data/jobs.json'), JSON.stringify([{
        id: 'publication-projection', slug: 'publication-projection', title: 'Infermiere',
        company: 'Example SA', location: 'Lugano', canton: 'TI', description: 'Assistenza ai pazienti.',
        postingDateSource, datePosted: date, postedDate: date,
      }]));
      (localeJobsSplitPlugin(root).closeBundle as () => void)();
      for (const locale of ['it', 'en', 'de', 'fr']) {
        for (const suffix of ['index', 'index-first']) {
          const [record] = JSON.parse(readFileSync(join(root, 'dist/data', `jobs-${locale}-${suffix}.json`), 'utf8'));
          expect(record.postingDateSource).toBe(postingDateSource);
          expect(record.datePosted).toBe(date);
          expect(record.postedDate).toBe(date);
        }
      }
      const detail = JSON.parse(readFileSync(join(root, 'dist/data/job-detail/publication-projection.json'), 'utf8'));
      expect(detail.postingDateSource).toBe(postingDateSource);
      expect(detail.datePosted).toBe(date);
      expect(detail.description).toBe('Assistenza ai pazienti.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
