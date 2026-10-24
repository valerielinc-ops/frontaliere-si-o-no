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
 * A missing hub or slot fails the build for IT and warns for en/de/fr (see below).
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

/** Locales whose hub is known to carry the slot; a gap there fails the build. */
const FAIL_CLOSED_LOCALES: ReadonlySet<JobBoardLocale> = new Set<JobBoardLocale>(['it']);

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
      // Same contract as sectorHubLinksPlugin for the locale whose slot is
      // proven in production (IT hub, deploy 40087494526: it=inserted): a
      // missing file or slot fails the build. The en/de/fr hubs are rewritten
      // by staticPagesPlugin's locale-variant pass, which does not carry the
      // slot yet (same run: de/fr/en=no-slot), so for them it stays a warning
      // until that pass emits it; failing there blocked every deploy.
      const isGap = (r: (typeof results)[number]) => r.outcome === 'missing-file' || r.outcome === 'no-slot';
      const fatal = results.filter((r) => isGap(r) && FAIL_CLOSED_LOCALES.has(r.locale));
      const soft = results.filter((r) => isGap(r) && !FAIL_CLOSED_LOCALES.has(r.locale));
      if (soft.length > 0) {
        console.warn(
          `::warning::[ti-hub-latest-jobs] ${soft.map((r) => `${r.locale}=${r.outcome}`).join(', ')}: hub shipped without the latest-jobs block`,
        );
      }
      if (fatal.length > 0) {
        throw new Error(
          `[ti-hub-latest-jobs] ${fatal.map((r) => `${r.locale}=${r.outcome}`).join(', ')}: ` +
            'staticPagesPlugin must write each emitted Ticino job-board hub with TI_HUB_LATEST_JOBS_SLOT under the H1 ' +
            'before resolving staticPagesFlushed (build-plugins/shared/tiHubLatestJobs.ts).',
        );
      }
    },
  };
}
