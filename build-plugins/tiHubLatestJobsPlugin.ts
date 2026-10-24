/**
 * Ticino job-board hub — fill the "latest jobs" data area.
 *
 * Sibling of {@link sectorHubLinksPlugin}: staticPagesPlugin writes the four
 * TI hubs (`/cerca-lavoro-ticino/`, `/en/find-jobs-ticino/`,
 * `/de/jobs-im-tessin/`, `/fr/trouver-emploi-tessin/`) with an empty
 * `TI_HUB_LATEST_JOBS_SLOT` under the H1; jobsSeoPagesPlugin renders the
 * per-locale block from the active-detail registry. This plugin waits for both
 * producers' explicit signals (closeBundle hooks run in parallel) and swaps
 * the slot for the block with a synchronous read+write, so it cannot interleave
 * with the other hub patchers. See build-plugins/shared/tiHubLatestJobs.ts.
 *
 * FAST_BUILD omits jobsSeoPagesPlugin: there the slot is simply removed.
 * A missing hub or slot for an emitted locale fails the build (see below).
 */

import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import type { JobBoardLocale } from './jobBoardSeoPure';
import {
  getTiHubLatestJobsBlocks,
  jobsSeoPagesFlushed,
  shouldAwaitJobsSeoPagesFlushed,
  staticPagesFlushed,
} from './shared/buildSignals';
import { shouldEmitLocale } from './shared/localeEmitFilter';
import { SECTION_LEGACY_TI_ROOT } from './shared/cantonSection';
import { applyTiHubLatestJobsSlot, type TiHubSlotOutcome } from './shared/tiHubLatestJobs';

const LOCALES: ReadonlyArray<JobBoardLocale> = ['it', 'en', 'de', 'fr'];

/** `dist/<hub>/index.html` for each locale's Ticino hub. */
export function tiHubIndexPath(distDir: string, locale: JobBoardLocale): string {
  return np.join(distDir, SECTION_LEGACY_TI_ROOT[locale].slice(1), 'index.html');
}

/** Patch one hub file. Exported for tests. */
export function patchTiHubFile(indexPath: string, block: string): TiHubSlotOutcome | 'missing-file' {
  if (!fs.existsSync(indexPath)) return 'missing-file';
  const html = fs.readFileSync(indexPath, 'utf-8');
  const { html: next, outcome } = applyTiHubLatestJobsSlot(html, block);
  if (outcome === 'inserted' || outcome === 'cleared') fs.writeFileSync(indexPath, next, 'utf-8');
  return outcome;
}

export function tiHubLatestJobsPlugin(rootDir: string): Plugin {
  return {
    name: 'ti-hub-latest-jobs',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;
      await (shouldAwaitJobsSeoPagesFlushed()
        ? Promise.all([staticPagesFlushed, jobsSeoPagesFlushed])
        : staticPagesFlushed);
      const blocks = getTiHubLatestJobsBlocks();
      const results = LOCALES.filter((locale) => shouldEmitLocale(locale)).map((locale) => ({
        locale,
        outcome: patchTiHubFile(tiHubIndexPath(distDir, locale), blocks?.[locale] ?? ''),
      }));
      const summary = results.map((r) => `${r.locale}=${r.outcome}`).join(' ');
      console.log(`\x1b[36m[ti-hub-latest-jobs]\x1b[0m ${summary}${blocks ? '' : ' (no producer block: slot cleared)'}`);
      // Same contract as sectorHubLinksPlugin: every hub this build emits
      // (BUILD_LOCALE already filtered above) must exist after the producer
      // signals AND carry the slot. A missing file is a producer race; a
      // missing slot means staticPagesPlugin stopped emitting it (e.g. the
      // inject-only path for a pre-existing index.html). Either would ship
      // the hub without its job links again, so the build fails.
      const failures = results.filter((r) => r.outcome === 'missing-file' || r.outcome === 'no-slot');
      if (failures.length > 0) {
        throw new Error(
          `[ti-hub-latest-jobs] ${failures.map((r) => `${r.locale}=${r.outcome}`).join(', ')}: ` +
            'staticPagesPlugin must write each emitted Ticino job-board hub with TI_HUB_LATEST_JOBS_SLOT under the H1 ' +
            'before resolving staticPagesFlushed (build-plugins/shared/tiHubLatestJobs.ts).',
        );
      }
    },
  };
}
