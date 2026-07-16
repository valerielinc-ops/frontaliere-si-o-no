#!/usr/bin/env -S npx tsx
/**
 * monitor-ti-sector-coverage.mjs — Post-deploy check for TI sector-hub pages
 * (`/cerca-lavoro-ticino/{sector}/`) with zero real Ticino job matches.
 *
 * These pages have no job-count floor (owner decision 2026-07-16: stay
 * live/indexed even at 0 jobs — curated prose keeps them above the
 * thin-content word floor). A sector stuck at 0 real TI jobs is still worth
 * tracking: it usually signals a crawler-coverage gap for that vertical
 * (see #3337) rather than a genuine absence of demand. This opens/updates a
 * single tracking issue instead of silently letting the gap go unnoticed.
 *
 * Reuses the real build-time canton resolver (cantonResolvers.mjs) and
 * sector counter (countSectorJobsByLocale from jobSectorLanding.ts) — same
 * source the SSG plugin uses — so this can never drift from what the live
 * pages actually show.
 *
 * Always exits 0 — non-blocking, alerting only.
 * Usage: npx tsx scripts/monitor-ti-sector-coverage.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const JOBS_PATH = path.join(REPO_ROOT, 'public/data/jobs.json');

function log(emoji, msg) {
  console.log(`${emoji} ${msg}`);
}

async function main() {
  if (!fs.existsSync(JOBS_PATH)) {
    log('⚠️', `${JOBS_PATH} not present — skipping TI sector coverage check`);
    return;
  }

  const cantonSlugFile = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'data/canton-url-slugs.json'), 'utf8'),
  );
  const municipalitiesFile = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'data/canton-municipalities.json'), 'utf8'),
  );
  const { createCantonResolvers } = await import(
    path.join(REPO_ROOT, 'build-plugins/shared/cantonResolvers.mjs')
  );
  const { resolveJobCanton } = createCantonResolvers({ cantonSlugFile, municipalitiesFile });

  const { SECTOR_HUB_KEYS, countSectorJobsByLocale } = await import(
    path.join(REPO_ROOT, 'build-plugins/jobSectorLanding.ts')
  );

  const jobs = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8'));
  const tiJobs = jobs.filter((job) => resolveJobCanton(job) === 'TI');
  const counts = countSectorJobsByLocale(tiJobs);

  const zeroSectors = SECTOR_HUB_KEYS.filter((sector) => (counts.it?.[sector] ?? 0) === 0);

  if (zeroSectors.length === 0) {
    log('✅', 'All TI sector-hub pages have >=1 real job match.');
    return;
  }

  log('⚠️', `${zeroSectors.length} TI sector(s) with 0 real job matches: ${zeroSectors.join(', ')}`);

  const runUrl = process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : '(local run)';

  const description = `## Sector TI a 0 match reali

Le seguenti pagine \`/cerca-lavoro-ticino/{settore}/\` non hanno **nessuna offerta reale** per il canton Ticino in questo deploy. La pagina resta live/indicizzata (decisione owner 2026-07-16: nessuna soglia minima per i settori TI), ma il gap va investigato:

${zeroSectors.map((s) => `- \`/cerca-lavoro-ticino/${s}/\``).join('\n')}

**Possibili cause da verificare:**
- Gap di copertura crawler per questo settore/vertical (vedi #3337 — backlog aziende svizzere non ancora crawlate)
- Regex \`SECTOR_MATCHERS\` (\`build-plugins/jobSectorLanding.ts\`) troppo stretta rispetto ai titoli/categorie reali del settore
- Domanda di lavoro genuinamente scarsa in Ticino per questo settore (verificare vs. altri cantoni)

**Run:** ${runUrl}
**Totale job TI (raw, ${'canton==TI'}):** ${tiJobs.length}`;

  execFileSync('node', [
    path.join(REPO_ROOT, 'scripts/lib/github-issue-creator.mjs'),
    '--title', 'TI sector coverage: settori a 0 match reali',
    '--description', description,
    '--priority', '3',
    '--label', 'bug',
    '--label', 'funnel-seo',
    '--workflow', 'Post-deploy Publish (side-effects + mark good)',
  ], { stdio: 'inherit' });
}

main().catch((err) => {
  console.error('[monitor-ti-sector-coverage] unexpected error (non-blocking):', err);
});
