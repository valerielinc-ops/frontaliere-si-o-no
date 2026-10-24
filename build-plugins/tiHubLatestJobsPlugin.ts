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
      // A hub that exists without the slot means staticPagesPlugin stopped
      // emitting it (e.g. a pre-existing index.html took the inject-only
      // path): surface it as a CI annotation. Not a hard failure — this block
      // is a ranking improvement, and a missing listing must not block a deploy.
      const noSlot = results.filter((r) => r.outcome === 'no-slot');
      if (noSlot.length > 0) {
        console.warn(
          `::warning::[ti-hub-latest-jobs] slot missing in ${noSlot.map((r) => r.locale).join(', ')} hub(s): ` +
            'staticPagesPlugin must emit TI_HUB_LATEST_JOBS_SLOT under the job-board hub H1.',
        );
      }
    },
  };
}
