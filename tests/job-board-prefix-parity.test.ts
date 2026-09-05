import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  JOB_BOARD_PREFIX,
  JOB_BOARD_PREFIX_LEGACY_DE,
  parseJobBoardSlug,
  getJobBoardSlugForCanton,
} from '../services/jobBoardSlugs';
import { CANTON_JOB_BOARD_PREFIX } from '../build-plugins/shared/cantonJobBoardPrefix';
import { CH_CANTON_SNAPSHOT_LOCALES, CH_CANTON_SNAPSHOT_CANTON_KEYS, buildCantonSnapshotPath } from '../build-plugins/jobMarketSnapshotChCantonPathsData';
import { SALARY_STATS_CANTON_SLUGS } from '../build-plugins/salaryStatsData';
import { JOB_BOARD_SECTION_PREFIX_SOURCE } from '../scripts/lib/jobBoardSections.mjs';

/**
 * Job-board prefix parity — issue #7306.
 *
 * The issue counted four literal copies of the same prefix table. Measured on
 * origin/main 2026-09-05 there are ELEVEN, in two live forms that differ only in
 * the DE prefix — which is why nobody noticed: each author copied whichever
 * neighbour they were reading.
 *
 * Router form (`de: 'jobs-in'`):
 *   1. services/jobBoardSlugs.ts               — canonical, the router reads it
 *   2. functions/src/lib/jobBoardUrlCanton.js  — hand-kept port; a Cloud
 *      Function cannot import a `.ts` module, so parity is all we can enforce
 *   3. build-plugins/shared/cantonResolvers.mjs
 *   4. scripts/ingest-gsc-job-orphans.mjs
 *   5. scripts/cathedral-noindex-flip.mjs
 *   6. scripts/ingest-gsc-company-hubs.mjs
 *   7. scripts/ingest-gsc-location-hubs.mjs
 *   8. scripts/ingest-gsc-orphans-into-candidates.mjs
 *
 * CH-canton page form (`de: 'jobs-im'`, the URLs production actually serves):
 *   9. build-plugins/shared/cantonJobBoardPrefix.ts — now DERIVES from (1)
 *  10. scripts/lib/orphan-canton-paths.mjs     — `sync-gsc-orphans.yml` runs
 *      its consumer under plain `node`, not `tsx`: it cannot import (1) either
 *
 * And the alternation of both:
 *  11. scripts/lib/jobBoardSections.mjs        — regex form for the GSC audit
 *      classifiers
 *
 * (9) can no longer drift by construction. The rest can, and this file is what
 * stops them: the assertions below read their real source and fail with the
 * exact string that must change — and, more usefully, force the next author to
 * declare WHICH of the two forms their copy belongs to.
 */

const REPO_ROOT = path.resolve(__dirname, '..');
const FUNCTIONS_COPY = path.join(REPO_ROOT, 'functions/src/lib/jobBoardUrlCanton.js');

/** Pull an object literal `{ it: '…', en: '…', de: '…', fr: '…' }` out of JS source. */
function extractPrefixTable(source: string, constName: string): Record<string, string> {
  const block = new RegExp(`const\\s+${constName}\\s*=\\s*(?:Object\\.freeze\\()?\\{([\\s\\S]*?)\\}`).exec(source);
  expect(block, `${constName} not found in that copy — did it get renamed?`).toBeTruthy();
  const out: Record<string, string> = {};
  for (const [, locale, value] of block![1].matchAll(/(\w+)\s*:\s*'([^']*)'/g)) out[locale] = value;
  return out;
}

function extractStringConst(source: string, constName: string): string {
  const m = new RegExp(`const\\s+${constName}\\s*=\\s*'([^']*)'`).exec(source);
  expect(m, `${constName} not found in that copy — did it get renamed?`).toBeTruthy();
  return m![1];
}

describe('job-board prefix parity (issue #7306)', () => {
  const functionsSource = fs.readFileSync(FUNCTIONS_COPY, 'utf-8');

  it('the Cloud Functions port carries the same prefixes as services/jobBoardSlugs.ts', () => {
    // The deploy boundary forbids the import, so the copy is enforced here.
    // If this fails: copy the values from services/jobBoardSlugs.ts into
    // functions/src/lib/jobBoardUrlCanton.js — the canonical table wins.
    expect(extractPrefixTable(functionsSource, 'JOB_BOARD_PREFIX')).toEqual(JOB_BOARD_PREFIX);
    expect(extractStringConst(functionsSource, 'JOB_BOARD_PREFIX_LEGACY_DE'))
      .toBe(JOB_BOARD_PREFIX_LEGACY_DE);
  });

  it('the GSC orphan resolver carries the same canton-form table', () => {
    // scripts/lib/orphan-canton-paths.mjs rebuilds `/{prefix}-{cantonSlug}/…`
    // to decide which canton an orphaned GSC path belongs to. Its consumer
    // (scripts/sync-gsc-orphans.mjs) is launched as `node …`, not `npx tsx`, so
    // it cannot import the derived table — but a drift here silently
    // misattributes orphan URLs, so the copy is pinned instead.
    const orphanSource = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts/lib/orphan-canton-paths.mjs'), 'utf-8',
    );
    expect(extractPrefixTable(orphanSource, 'JOB_BOARD_PREFIX')).toEqual(CANTON_JOB_BOARD_PREFIX);
  });

  // The three below carry the ROUTER form of the same canton table
  // (`de: 'jobs-in'`), not the legacy form the two CH-canton page families use.
  // Both forms are live and neither is a typo — which is precisely why every
  // copy has to declare, by failing this test, which family it belongs to.
  const ROUTER_FORM_COPIES = [
    ['build-plugins/shared/cantonResolvers.mjs', 'SECTION_PREFIX_BY_LOCALE'],
    ['scripts/ingest-gsc-job-orphans.mjs', 'SECTION_PREFIX'],
    ['scripts/cathedral-noindex-flip.mjs', 'SECTION_PREFIX_BY_LOCALE'],
    ['scripts/ingest-gsc-company-hubs.mjs', 'SECTION_PREFIX_BY_LOCALE'],
    ['scripts/ingest-gsc-location-hubs.mjs', 'SECTION_PREFIX_BY_LOCALE'],
    ['scripts/ingest-gsc-orphans-into-candidates.mjs', 'SECTION_PREFIX'],
  ] as const;

  it.each(ROUTER_FORM_COPIES)('%s keeps the router-form canton prefixes', (file, constName) => {
    const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf-8');
    expect(extractPrefixTable(source, constName)).toEqual({
      it: JOB_BOARD_PREFIX.it.replace(/-$/, ''),
      en: JOB_BOARD_PREFIX.en.replace(/-$/, ''),
      de: JOB_BOARD_PREFIX.de.replace(/-$/, ''),
      fr: JOB_BOARD_PREFIX.fr.replace(/-$/, ''),
    });
  });

  it('the audit alternation lists exactly the prefixes that exist', () => {
    // scripts/lib/jobBoardSections.mjs classifies discovered GSC path segments.
    // A prefix missing from the alternation silently drops a whole family out
    // of the SEO reports; an extra one classifies foreign paths as job-board.
    const alternation = JOB_BOARD_SECTION_PREFIX_SOURCE.split('|').sort();
    const expected = [
      ...Object.values(JOB_BOARD_PREFIX),
      JOB_BOARD_PREFIX_LEGACY_DE,
    ].map((p) => p.replace(/-$/, '')).sort();
    expect(alternation).toEqual(expected);
  });

  it('the CH-canton page families derive their prefixes and do not re-declare them', () => {
    // build-plugins/shared/cantonJobBoardPrefix.ts must stay a derivation of
    // the canonical table, minus the trailing dash it joins itself.
    expect(CANTON_JOB_BOARD_PREFIX.it).toBe(JOB_BOARD_PREFIX.it.replace(/-$/, ''));
    expect(CANTON_JOB_BOARD_PREFIX.en).toBe(JOB_BOARD_PREFIX.en.replace(/-$/, ''));
    expect(CANTON_JOB_BOARD_PREFIX.fr).toBe(JOB_BOARD_PREFIX.fr.replace(/-$/, ''));
    // …and DE stays pinned to the LEGACY form, which is the one production
    // serves for these two families. Measured 2026-09-05:
    //   /de/jobs-im-zurich/snapshot/ → the real page (noindex,follow bridge)
    //   /de/jobs-in-zurich/snapshot/ → the SPA job-board shell, no such page
    // Flipping this to JOB_BOARD_PREFIX.de moves every emitted DE canton path.
    expect(CANTON_JOB_BOARD_PREFIX.de).toBe(JOB_BOARD_PREFIX_LEGACY_DE.replace(/-$/, ''));
    expect(CANTON_JOB_BOARD_PREFIX.de).toBe('jobs-im');
  });

  it('every emitted CH-canton snapshot path keeps its published shape', () => {
    // The literal pin: a change to the prefix table that reaches these two
    // families shows up here as a diff of real URLs, not as a constant edit.
    expect(buildCantonSnapshotPath('de', SALARY_STATS_CANTON_SLUGS.ZH.de)).toBe('/de/jobs-im-zurich/snapshot/');
    expect(buildCantonSnapshotPath('de', SALARY_STATS_CANTON_SLUGS.AG.de)).toBe('/de/jobs-im-aargau/snapshot/');
    expect(buildCantonSnapshotPath('it', SALARY_STATS_CANTON_SLUGS.ZH.it)).toBe('/cerca-lavoro-zurigo/snapshot/');
    expect(buildCantonSnapshotPath('en', SALARY_STATS_CANTON_SLUGS.ZH.en)).toBe('/en/find-jobs-zurich/snapshot/');
    expect(buildCantonSnapshotPath('fr', SALARY_STATS_CANTON_SLUGS.ZH.fr)).toBe('/fr/trouver-emploi-zurich/snapshot/');

    // And no path is empty or double-slashed for any (locale, canton) pair.
    for (const locale of CH_CANTON_SNAPSHOT_LOCALES) {
      for (const cantonKey of CH_CANTON_SNAPSHOT_CANTON_KEYS) {
        const p = buildCantonSnapshotPath(locale, SALARY_STATS_CANTON_SLUGS[cantonKey][locale]);
        expect(p, `${locale}/${cantonKey}`).toMatch(/^\/(?:en\/|de\/|fr\/)?[a-z][a-z0-9-]*\/snapshot\/$/);
      }
    }
  });

  it('documents which canton segments the router does and does not parse', () => {
    // Not a wish, a record of today's split. The router parses the job-board
    // segments it emits itself; the CH-canton snapshot/employers segments are
    // resolved by their own PATH_INDEX, which is why `jobs-im-zurich` being
    // unparseable here is not a broken route.
    expect(getJobBoardSlugForCanton('ZH', 'de')).toBe('jobs-in-zurich');
    expect(parseJobBoardSlug('jobs-in-zurich', 'de')).toEqual({ cantonCode: 'ZH', isAggregator: false });
    expect(parseJobBoardSlug('jobs-im-tessin', 'de')).toEqual({ cantonCode: 'TI', isAggregator: false });
    expect(parseJobBoardSlug('jobs-im-zurich', 'de')).toBeNull();
  });
});
