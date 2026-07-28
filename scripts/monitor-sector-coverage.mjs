#!/usr/bin/env -S npx tsx
/**
 * monitor-sector-coverage.mjs — Post-deploy check for job-matching coverage
 * gaps across every canton×profession page family, not just Ticino.
 *
 * frontaliere-si-o-no ships job data exclusively via 580+ per-employer
 * crawlers (docs/CRAWLERS.md) — there is no generic multi-employer job
 * board source (job-room.ch/SECO was investigated and is blocked: 401 on
 * its API, no SSR — see #3337). Any profession/sector whose local
 * employers aren't individually onboarded shows 0 real matches, in ANY
 * canton. That is the root cause behind issue #4824
 * ("/cerca-lavoro-ticino/camerieri/" 0 match) — but it was only VISIBLE
 * for Ticino because only a TI-only monitor existed. Identical gaps in
 * GR/VS/VD/ZH/etc were invisible to CI. This script generalizes detection
 * to every canton×profession page family so the class of bug (not just
 * the one Ticino instance) gets tracked.
 *
 * Checks three independently-gated page families and opens/updates one
 * tracking issue per family (dedup by stable title via
 * github-issue-creator.mjs):
 *
 *   A. TI sector hubs (`/cerca-lavoro-ticino/{settore}/`,
 *      jobSectorLanding.ts / jobSectorPagesPlugin.ts) — no job-count floor
 *      (owner decision 2026-07-16), pages stay indexed even at 0 real
 *      matches. Original #4824 check, behavior unchanged.
 *   B. TI legacy profession pages (`/lavoro-ticino-{ruolo}/`,
 *      professionLandingsData.ts / professionLandingsPlugin.ts) — same
 *      no-floor treatment as A, different subsystem, 24 roles.
 *   C. All-canton profession-canton pages (`/lavoro-{cantone}-{ruolo}/`,
 *      professionCantonLandings.ts, every canton except TI) — these DO
 *      have a MIN_JOBS floor + automatic noindex bridge, so a 0-match pair
 *      is never a thin-content risk there. Still worth surfacing: a
 *      profession with 0 matches in EVERY canton nationally (incl. TI) is
 *      a pure crawler-category gap — same root cause as A/B, just masked
 *      by the bridge instead of showing up as a live empty page. A
 *      profession missing in only some cantons is a lower-priority
 *      coverage signal for crawler-onboarding backlog triage.
 *
 * Reuses the real build-time aggregators (aggregateProfessionJobs,
 * aggregateProfessionJobsByCanton from professionJobsAggregate.ts) so
 * counts never drift from what the live pages actually show. Those
 * aggregators hardcode reading `<rootDir>/data/jobs.json`; this post-deploy
 * job only restores `public/data/jobs.json` (data/jobs.json is gitignored
 * and absent in that checkout), so we symlink it into a scratch `data/`
 * dir rather than duplicating the matching logic here.
 *
 * Always exits 0 — non-blocking, alerting only.
 * Usage: npx tsx scripts/monitor-sector-coverage.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const JOBS_PATH = path.join(REPO_ROOT, 'public/data/jobs.json');

// Mirrors MIN_JOBS in build-plugins/professionCantonLandings.ts — the floor
// below which a profession-canton page falls back to a noindex bridge.
const MIN_JOBS = 3;

function log(emoji, msg) {
  console.log(`${emoji} ${msg}`);
}

function runUrl() {
  return process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : '(local run)';
}

function createIssue({ title, description, labels }) {
  const args = [
    path.join(REPO_ROOT, 'scripts/lib/github-issue-creator.mjs'),
    '--title', title,
    '--description', description,
    '--priority', '3',
    '--workflow', 'Post-deploy Publish (side-effects + mark good)',
  ];
  for (const label of labels) args.push('--label', label);
  execFileSync('node', args, { stdio: 'inherit' });
}

async function checkTiSectorHubs({ resolveJobCanton, jobs }) {
  const { SECTOR_HUB_KEYS, countSectorJobsByLocale } = await import(
    path.join(REPO_ROOT, 'build-plugins/jobSectorLanding.ts')
  );

  const tiJobs = jobs.filter((job) => resolveJobCanton(job) === 'TI');
  const counts = countSectorJobsByLocale(tiJobs);
  const zeroSectors = SECTOR_HUB_KEYS.filter((sector) => (counts.it?.[sector] ?? 0) === 0);

  if (zeroSectors.length === 0) {
    log('✅', 'All TI sector-hub pages have >=1 real job match.');
    return;
  }

  log('⚠️', `${zeroSectors.length} TI sector(s) with 0 real job matches: ${zeroSectors.join(', ')}`);

  const description = `## Sector TI 0 match reali

Le seguenti pagine \`/cerca-lavoro-ticino/{settore}/\` non hanno **nessuna offerta reale** per il canton Ticino in questo deploy. La pagina resta live/indicizzata (decisione owner 2026-07-16: nessuna soglia minima per i settori TI), ma il gap va investigato:

${zeroSectors.map((s) => `- \`/cerca-lavoro-ticino/${s}/\``).join('\n')}

**Possibili cause da verificare:**
- Gap di copertura crawler per questo settore/vertical (vedi #3337 — backlog aziende svizzere non ancora crawlate)
- Regex \`SECTOR_MATCHERS\` (\`build-plugins/jobSectorLanding.ts\`) troppo stretta rispetto ai titoli/categorie reali del settore
- Domanda di lavoro genuinamente scarsa in Ticino per questo settore (verificare vs. altri cantoni)

**Run:** ${runUrl()}
**Totale job TI (raw, canton==TI):** ${tiJobs.length}`;

  createIssue({
    title: 'TI sector coverage: settori a 0 match reali',
    description,
    labels: ['bug', 'funnel-seo'],
  });
}

async function checkTiLegacyProfessions(stagingRoot) {
  const { aggregateProfessionJobs } = await import(
    path.join(REPO_ROOT, 'build-plugins/professionJobsAggregate.ts')
  );
  const { PROFESSION_IDS } = await import(
    path.join(REPO_ROOT, 'build-plugins/professionLandingsData.ts')
  );

  const snapshots = aggregateProfessionJobs(stagingRoot);
  const zeroIds = PROFESSION_IDS.filter((id) => (snapshots[id]?.liveCount ?? 0) === 0);

  if (zeroIds.length === 0) {
    log('✅', 'All TI legacy profession pages have >=1 real job match.');
    return;
  }

  log('⚠️', `${zeroIds.length} TI legacy profession page(s) with 0 real job matches: ${zeroIds.join(', ')}`);

  const description = `## Professioni TI (legacy) a 0 match reali

Le seguenti pagine \`/lavoro-ticino-{ruolo}/\` non hanno **nessuna offerta reale** in questo deploy. Come i sector-hub (#4824), restano live/indicizzate senza soglia minima — stessa classe di bug, sottosistema diverso (\`professionLandingsData.ts\` / \`professionLandingsPlugin.ts\`).

${zeroIds.map((id) => `- \`/lavoro-ticino-${id}/\``).join('\n')}

**Causa più probabile:** gap di copertura crawler per il ruolo/vertical in Ticino (vedi #3337) — stessa diagnosi di #4824, non un problema di regex/matching.

**Run:** ${runUrl()}`;

  createIssue({
    title: 'TI profession coverage (legacy): ruoli a 0 match reali',
    description,
    labels: ['bug', 'funnel-seo'],
  });
}

async function checkAllCantonProfessions(stagingRoot) {
  const { aggregateProfessionJobs, aggregateProfessionJobsByCanton } = await import(
    path.join(REPO_ROOT, 'build-plugins/professionJobsAggregate.ts')
  );
  const { ALL_CANTON_PROFESSION_IDS } = await import(
    path.join(REPO_ROOT, 'build-plugins/professionLandingsData.ts')
  );
  const { PROFESSION_CANTON_KEYS } = await import(
    path.join(REPO_ROOT, 'build-plugins/professionCantonData.ts')
  );
  const { getCantonDisplayName } = await import(
    path.join(REPO_ROOT, 'build-plugins/shared/cantonDisplay.ts')
  );

  const byCanton = aggregateProfessionJobsByCanton(stagingRoot);
  // TI runs its own page family (checkTiLegacyProfessions above) with its
  // own floor rules, but still counts toward the *national* zero check
  // below — a profession genuinely absent everywhere must include TI too.
  const tiSnapshots = aggregateProfessionJobs(stagingRoot);

  const nationalZero = [];
  const belowFloorByProfession = new Map();

  for (const id of ALL_CANTON_PROFESSION_IDS) {
    let nationalTotal = tiSnapshots[id]?.liveCount ?? 0;
    const belowFloor = [];
    for (const cantonKey of PROFESSION_CANTON_KEYS) {
      const liveCount = byCanton[cantonKey]?.[id]?.liveCount ?? 0;
      nationalTotal += liveCount;
      if (liveCount < MIN_JOBS) belowFloor.push({ cantonKey, liveCount });
    }
    if (nationalTotal === 0) nationalZero.push(id);
    else if (belowFloor.length > 0) belowFloorByProfession.set(id, belowFloor);
  }

  if (nationalZero.length === 0 && belowFloorByProfession.size === 0) {
    log('✅', 'Every profession has >=1 real match nationally, at/above floor in every canton.');
    return;
  }

  log(
    '⚠️',
    `${nationalZero.length} profession(s) with 0 national matches; ${belowFloorByProfession.size} profession(s) below floor in >=1 canton.`,
  );

  const nonTiCantonCount = PROFESSION_CANTON_KEYS.length;
  const topOffenders = [...belowFloorByProfession.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 15);

  const description = `## Copertura professioni per cantone: gap sistemici rilevati

Generalizzazione di #4824 a tutti i cantoni (non solo Ticino) — stessa root cause: 580+ crawler sono tutti **per-azienda**, nessuna fonte generica multi-employer copre tutti i settori/cantoni (job-room.ch/SECO bloccato, vedi #3337). Le pagine \`/lavoro-{cantone}-{ruolo}/\` restano sicure (soglia MIN_JOBS=${MIN_JOBS} + bridge noindex sotto soglia, \`professionCantonLandings.ts\`) — nessun rischio thin-content — ma il gap di dati sottostante resta e va tracciato per priorità crawler-onboarding.
${nationalZero.length > 0 ? `
### Gap di categoria: 0 match in OGNI cantone (incl. TI)

Nessun crawler copre affatto questi ruoli, in nessun cantone — priorità massima per onboarding:

${nationalZero.map((id) => `- \`${id}\``).join('\n')}
` : ''}${topOffenders.length > 0 ? `
### Top gap per-cantone (professioni sotto soglia in più cantoni, su ${nonTiCantonCount} cantoni non-TI)

${topOffenders.map(([id, entries]) => `- \`${id}\` — sotto soglia in ${entries.length}/${nonTiCantonCount}: ${entries.map((e) => getCantonDisplayName(e.cantonKey, 'it')).join(', ')}`).join('\n')}
` : ''}
**Run:** ${runUrl()}`;

  createIssue({
    title: 'Copertura professioni per cantone: gap sistemici rilevati',
    description,
    labels: ['bug', 'funnel-seo'],
  });
}

async function main() {
  if (!fs.existsSync(JOBS_PATH)) {
    log('⚠️', `${JOBS_PATH} not present — skipping sector coverage check`);
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

  const jobs = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8'));

  // Symlink (not copy) — instant, no 300MB+ duplicate read/write of the
  // jobs corpus just to satisfy the aggregators' hardcoded data/ path.
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sector-coverage-'));
  fs.mkdirSync(path.join(stagingRoot, 'data'), { recursive: true });
  fs.symlinkSync(JOBS_PATH, path.join(stagingRoot, 'data', 'jobs.json'));

  await checkTiSectorHubs({ resolveJobCanton, jobs });
  await checkTiLegacyProfessions(stagingRoot);
  await checkAllCantonProfessions(stagingRoot);
}

main().catch((err) => {
  console.error('[monitor-sector-coverage] unexpected error (non-blocking):', err);
});
