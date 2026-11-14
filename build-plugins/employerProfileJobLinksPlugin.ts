/**
 * Final active-detail boundary for employer-profile pages.
 *
 * employerProfilePagesPlugin must run before the jobs producer because the
 * latter awaits the emitted employer identities. That means the profile
 * renderer cannot always see the producer's final all-locale detail registry
 * while it is rendering. This separate post-consumer waits for that registry
 * and removes stale job cards and ItemList entries from the already-emitted
 * profile files.
 *
 * Kept separate from employerProfilePagesLinksPlugin: that plugin owns only
 * the HTML-sitemap block that makes employer hubs crawlable. This plugin owns
 * the independent active-detail consistency pass.
 */
import fs from 'node:fs';
import np from 'node:path';
import type { Plugin } from 'vite';
import { MAX_JOBS_LISTED } from './employerProfilePagesPlugin';
import { filterEmployerProfileJobLinks } from './shared/employerProfileJobLinks';
import {
  employerProfilesFlushed,
  getJobSitemapAllowlist,
  jobsSeoPagesFlushed,
  shouldAwaitJobsSeoPagesFlushed,
  type EmittedEmployerProfile,
} from './shared/buildSignals';

function filterProfileFiles(
  distDir: string,
  profiles: readonly EmittedEmployerProfile[],
  allowlist: ReadonlySet<string>,
): number {
  const filteredPaths = new Set<string>();
  let filteredFiles = 0;
  for (const profile of profiles) {
    if (filteredPaths.has(profile.path)) continue;
    filteredPaths.add(profile.path);
    for (const filePath of [
      np.join(distDir, profile.path, 'index.html'),
      np.join(distDir, profile.path.replace(/\/+$/, '') + '.html'),
    ]) {
      if (!fs.existsSync(filePath)) continue;
      const html = fs.readFileSync(filePath, 'utf-8');
      const filtered = filterEmployerProfileJobLinks(html, allowlist, MAX_JOBS_LISTED);
      if (filtered === html) continue;
      fs.writeFileSync(filePath, filtered, 'utf-8');
      filteredFiles++;
    }
  }
  return filteredFiles;
}

export function employerProfileJobLinksPlugin(rootDir: string): Plugin {
  return {
    name: 'employer-profile-job-links',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_EMPLOYER_PROFILE_PAGES === '1') return;
      if (!shouldAwaitJobsSeoPagesFlushed()) return;

      const [profiles] = await Promise.all([employerProfilesFlushed, jobsSeoPagesFlushed]);
      if (profiles.length === 0) return;

      // jobsSeoPagesPlugin and the profile emitter can create dist while their
      // parallel closeBundle hooks are still running. Check only after both
      // producers have flushed their final outputs.
      const distDir = np.resolve(rootDir, 'dist');
      if (!fs.existsSync(distDir)) return;

      const allowlist = getJobSitemapAllowlist();
      if (allowlist === null) {
        throw new Error(
          '[employer-profile-job-links] jobs producer completed without publishing its detail allowlist',
        );
      }

      const filteredFiles = filterProfileFiles(distDir, profiles, allowlist);
      console.log(
        `\x1b[36m[employer-profile-job-links]\x1b[0m Filtered active-detail links in ${filteredFiles} profile file(s).`,
      );
    },
  };
}
