#!/usr/bin/env node
/**
 * run.mjs — the Playwright robot that publishes the queued Instagram and
 * TikTok carousels from the owner's browser profile on the agents' Mac host.
 *
 *   node scripts/social-robot/run.mjs                    # dry run (default)
 *   node scripts/social-robot/run.mjs --publish          # press, if Remote Config says live
 *   node scripts/social-robot/run.mjs --platform=tiktok  # one platform only
 *   node scripts/social-robot/run.mjs --login            # owner: log in once, then close the window
 *
 * Owner decision of 2026-10-04 (issues 9798 and 7648): automatic publishing
 * through the real web apps, no third-party service and no API app. The
 * owner ACCEPTS the risk that Instagram's and TikTok's terms allow them to
 * restrict or suspend accounts that publish through automation. Hence the
 * cadence limits in lib/cadence.mjs and the rule that the robot never insists.
 *
 * What it publishes: data/<channel>-queue.json on origin/main, filled by the
 * daily posters (see scripts/lib/social-publish-queue.mjs). What it records:
 * nothing in the repository directly — on a confirmed publish it dispatches
 * social-robot-confirm.yml, which writes the ledger on main.
 *
 * Effective mode = the command line AND Remote Config: --publish presses the
 * button only when SOCIAL_ROBOT_MODE is `live`; `off` stops the robot; absent
 * or `dry` → dry run. In a dry run it goes up to the publish button, takes a
 * screenshot and stops.
 *
 * Env:
 *   SOCIAL_ROBOT_MODE          off | dry | live (Remote Config; launchd.sh loads it)
 *   SOCIAL_ROBOT_SITE_REPO     the site checkout whose origin/main holds the queue
 *                              (default: the repository this file is in)
 *   SOCIAL_ROBOT_STATE_DIR     profile, journal, diagnostics
 *                              (default: ~/Library/Application Support/frontaliere/social-robot)
 *   SOCIAL_ROBOT_BROWSER_PATH  browser binary (default: Google Chrome, else cached Chromium)
 *   TRUSTED_GH_BIN / PATH      `gh` = the workspace coordinator shim
 *
 * Install the twice-a-day launchd job: bash scripts/social-robot/launchd.sh install
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createGithubIssue } from '../lib/github-issue-creator.mjs';
import { SOCIAL_CHANNELS, resolveSocialRobotMode } from '../lib/social-publish-queue.mjs';
import { acquireLock, defaultStateDir, diagnosticsDir, downloadsDir, openProfile, resolveBrowserLaunch } from './lib/browser.mjs';
import { START_JITTER_MAX_MS, fileJournalStore, randomBetween } from './lib/cadence.mjs';
import { FLOWS, INSTAGRAM_HOME, TIKTOK_UPLOAD, captureDiagnostics, classifyError, stepTracker } from './lib/flows.mjs';
import { SITE_REPO, downloadEntryFiles, ghConfirmDispatcher, gitMainReader, runRobot } from './lib/robot.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const opts = { mode: 'dry-run', platforms: [...SOCIAL_CHANNELS], login: false, jitter: false, help: false };
  for (const arg of argv) {
    if (arg === '--publish') opts.mode = 'publish';
    else if (arg === '--dry-run') opts.mode = 'dry-run';
    else if (arg === '--login') opts.login = true;
    else if (arg === '--jitter') opts.jitter = true;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg.startsWith('--platform=')) {
      const value = arg.slice('--platform='.length);
      opts.platforms = value === 'all' ? [...SOCIAL_CHANNELS] : value.split(',');
      for (const p of opts.platforms) if (!SOCIAL_CHANNELS.includes(p)) throw new Error(`unknown platform: ${p}`);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

const stamp = (at) => new Date(at).toISOString().replace(/[:.]/g, '-');

async function login({ stateDir, platforms }) {
  const context = await openProfile({ stateDir });
  for (const p of platforms) {
    const page = await context.newPage();
    await page.goto(p === 'instagram' ? INSTAGRAM_HOME : TIKTOK_UPLOAD).catch(() => {});
  }
  console.log('🔑 Log in on every tab, then close the browser window. Nothing is read or saved but the profile itself.');
  await new Promise((resolve) => context.on('close', resolve));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(readUsage());
    return 0;
  }
  const stateDir = defaultStateDir();
  const release = acquireLock(stateDir);
  if (!release) {
    console.log('ℹ️  another robot run holds the profile — skipping');
    return 0;
  }
  try {
    if (opts.login) {
      await login({ stateDir, platforms: opts.platforms });
      return 0;
    }
    const rcMode = resolveSocialRobotMode();
    const launch = resolveBrowserLaunch();
    console.log(`─── social robot — ${opts.mode}, SOCIAL_ROBOT_MODE=${rcMode}, browser ${launch.kind} ───`);
    if (opts.jitter) await new Promise((r) => setTimeout(r, randomBetween(Math.random, { min: 0, max: START_JITTER_MAX_MS })));

    const repoDir = process.env.SOCIAL_ROBOT_SITE_REPO || path.resolve(__dirname, '..', '..');
    let context = null;
    const page = async () => {
      context ||= await openProfile({ stateDir, launch });
      return context.pages()[0] || context.newPage();
    };
    try {
      const { results } = await runRobot({
        cliMode: opts.mode,
        rcMode,
        platforms: opts.platforms,
        reader: gitMainReader({ repoDir }),
        journalStore: fileJournalStore(stateDir),
        fetchImages: (entry) => downloadEntryFiles(entry, path.join(downloadsDir(stateDir), entry.channel, entry.id)),
        // --jitter marks the unattended launchd run: there a queue entry gets
        // one dry run, not one per window; by hand every --dry-run runs.
        repeatDryRun: !opts.jitter,
        diagnosticsFor: (channel, entry, at) => path.join(diagnosticsDir(stateDir), `${stamp(at)}-${channel}-${entry?.id || 'none'}`),
        publishWith: async (channel, entry, files, { dryRun, human, diagnosticsDir: dir }) => {
          const p = await page();
          const step = stepTracker();
          const snap = (label) => captureDiagnostics(p, dir, label, { channel, queueId: entry.id, step: step.get() });
          try {
            return await FLOWS[channel]({ page: p, files, caption: entry.caption, video: entry.video, dryRun, human, snap, step });
          } catch (err) {
            const e = classifyError(err);
            e.step ||= step.get();
            await captureDiagnostics(p, dir, 'error', { channel, queueId: entry.id, step: e.step, errorClass: e.errorClass, message: e.message });
            throw e;
          }
        },
        dispatchConfirm: ghConfirmDispatcher({ ghBin: process.env.TRUSTED_GH_BIN || 'gh' }),
        reportIssue: ({ title, description, labels }) => {
          process.env.GH_REPO ||= SITE_REPO;
          return createGithubIssue({ title, description, priority: 2, labels, workflow: 'social-robot (Mac host)' });
        },
      });
      console.log(JSON.stringify({ results }));
      return results.some((r) => r.outcome === 'error' || r.outcome === 'unconfirmed') ? 1 : 0;
    } finally {
      if (context) await context.close().catch(() => {});
    }
  } finally {
    release();
  }
}

function readUsage() {
  return [
    'node scripts/social-robot/run.mjs [--dry-run | --publish] [--platform=instagram|tiktok|all] [--jitter]',
    'node scripts/social-robot/run.mjs --login [--platform=...]',
    '',
    '--publish presses the button only when Remote Config SOCIAL_ROBOT_MODE=live. See scripts/social-robot/README.md.',
    '--jitter (the launchd job) waits up to 20 minutes first and takes each queue entry to the button once in a dry run.',
  ].join('\n');
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`❌ social robot: ${err.message}`);
      process.exit(1);
    });
}
