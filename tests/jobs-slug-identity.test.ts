import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendSlugDisambiguator,
  mergePreserveLocaleData,
} from '../scripts/lib/dedicated-crawler-common.mjs';
import { MAX_SLUG_LENGTH } from '../scripts/lib/regenerate-slugs-helpers.mjs';
import { restoreExistingSlugIdentity } from '../scripts/lib/slug-history-journal.mjs';

const PARSER_FILES = [
  'accor-job-parser.mjs',
  'ete-job-parser.mjs',
  'gmo-job-parser.mjs',
  'michaelpage-job-parser.mjs',
  'okjob-job-parser.mjs',
  'recruitingapp-2649-job-parser.mjs',
];

describe('dedicated parser slug identity (#8016)', () => {
  it('routes every prospected parser through the stable URL disambiguator', () => {
    for (const file of PARSER_FILES) {
      const source = fs.readFileSync(path.join(process.cwd(), 'scripts', 'lib', file), 'utf8');
      expect(source, file).toContain('appendSlugDisambiguator');
      expect(source, file).toContain('slugDisambiguator');
      expect(source, file).toMatch(/const urlHash = createHash\('sha1'\)/);
      expect(source, file).toContain('slug: jobSlug');
    }
  });

  it('keeps same-title postings distinct and within the canonical length cap', () => {
    const base = 'senior project manager acme ch ' + 'long-title-segment '.repeat(20);
    const first = appendSlugDisambiguator(base, '01234567');
    const second = appendSlugDisambiguator(base, '89abcdef');

    expect(first).not.toBe(second);
    expect(first).toMatch(/-01234567$/);
    expect(second).toMatch(/-89abcdef$/);
    expect(first.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(second.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
  });

  it('migrates a live base slug once and retains it as a redirect', () => {
    const oldSlug = 'role-acme-ch';
    const disambiguator = '01234567';
    const old = {
      id: 'acme-1',
      url: 'https://acme.example/jobs/1',
      company: 'Acme',
      companyKey: 'acme',
      title: 'Role',
      location: 'Lugano',
      sourceLang: 'en',
      slug: oldSlug,
      slugByLocale: { en: oldSlug },
      previousSlugs: ['older-role-acme-ch'],
      previousSlugsByLocale: { en: ['older-role-acme-ch'] },
    };
    const fresh = {
      ...old,
      slug: `${oldSlug}-${disambiguator}`,
      slugByLocale: { en: `${oldSlug}-${disambiguator}` },
      slugDisambiguator: disambiguator,
      previousSlugs: undefined,
      previousSlugsByLocale: undefined,
    };

    const merged = mergePreserveLocaleData([old], [fresh], { matchKey: (job: { id: string }) => job.id });
    const migrated = restoreExistingSlugIdentity([old], merged).jobs[0];

    expect(migrated.slug).toBe(`${oldSlug}-${disambiguator}`);
    expect(migrated.previousSlugs).toEqual(expect.arrayContaining([
      oldSlug,
      'older-role-acme-ch',
    ]));
    expect(migrated.previousSlugsByLocale.en).toContain(oldSlug);
  });
});
