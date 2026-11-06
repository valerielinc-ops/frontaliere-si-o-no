import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCantonResolvers, SECTION_LEGACY_TI } from '../../build-plugins/shared/cantonResolvers.mjs';
import cantonSlugFile from '../../data/canton-url-slugs.json';
import municipalitiesFile from '../../data/canton-municipalities.json';

/**
 * Regression for follow-up 6418 items 3-4: expired-job "similar jobs"
 * copy used to hardcode the Ticino hub and a dead DE slug
 * `/de/job-suche-tessin/`. The shipped renderer now builds
 * `listingPath` from `buildCantonAwareSection(locale, jobCanton)`.
 *
 * The plugin cannot be imported in a sparse worktree (it pulls `data/jobs`
 * at module scope). This test drives the same resolver the plugin calls
 * and pins the source of the call site.
 */
const PLUGIN_SRC = readFileSync(
  path.join(process.cwd(), 'build-plugins/jobsSeoPagesPlugin.ts'),
  'utf8',
);

describe('expired-job similar-jobs listing path', () => {
  const { resolveCantonSection } = createCantonResolvers({
    cantonSlugFile,
    municipalitiesFile,
  });

  it('DE Ticino hub is jobs-im-tessin, never the dead job-suche-tessin href', () => {
    expect(resolveCantonSection('de', 'TI')).toBe(SECTION_LEGACY_TI.de);
    expect(SECTION_LEGACY_TI.de).toBe('jobs-im-tessin');
    expect(PLUGIN_SRC).not.toMatch(/href="\/de\/job-suche-tessin\//);
    expect(PLUGIN_SRC).not.toMatch(/href="\/fr\/recherche-emploi-tessin\//);
  });

  it('a Zurich job resolves to the Zurich section, not the Ticino hub', () => {
    expect(resolveCantonSection('it', 'ZH')).toBe('cerca-lavoro-zurigo');
    expect(resolveCantonSection('de', 'ZH')).not.toBe('jobs-im-tessin');
  });

  it('the expired-job renderer assigns listingPath from buildCantonAwareSection(locale, jobCanton)', () => {
    expect(PLUGIN_SRC).toMatch(
      /const listingPath = `\$\{localePrefix\[locale\]\}\/\$\{buildCantonAwareSection\(locale, jobCanton\)\}\/`/,
    );
    expect(PLUGIN_SRC).toMatch(/href="\$\{listingPath\}"/);
  });
});
