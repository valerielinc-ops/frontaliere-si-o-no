import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { detectLanguageWithConfidence } from '../scripts/lib/detect-language.mjs';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;
const DATA_JOBS_PATH = path.resolve(__dirname, '..', 'data', 'jobs.json');

interface Job {
  company?: string;
  slug?: string;
  descriptionByLocale?: Record<string, string>;
}

describe('job-locale-consistency', () => {
  const jobs: Job[] = JSON.parse(fs.readFileSync(DATA_JOBS_PATH, 'utf-8'));

  it('localized descriptions are not stored under the wrong locale', { timeout: 20000 }, () => {
    const mismatches: string[] = [];

    for (const job of jobs) {
      for (const locale of LOCALES) {
        const description = String(job.descriptionByLocale?.[locale] || '').trim();
        if (description.length < 120) continue;

        const detected = detectLanguageWithConfidence(description, locale);
        if (detected.confidence >= 0.50 && detected.lang !== locale) {
          mismatches.push(
            `${job.company || '?'}/${job.slug || '?'} [${locale}] => ${detected.lang} (${detected.confidence.toFixed(2)})`
          );
        }
      }
    }

    // FRO-321: tightened to 105 — actual count 103 at 2026-03-23, will decrease with more crawler runs.
    expect(
      mismatches.length,
      `Descriptions stored under the wrong locale:\n${mismatches.slice(0, 20).join('\n')}`
    ).toBeLessThanOrEqual(105);
  });
});
