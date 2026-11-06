/**
 * browser.mjs — the owner's persistent browser profile for the social robot.
 *
 * The profile (cookies, the Instagram and TikTok sessions) lives outside the
 * repository, in the robot's state folder on the Mac host. The owner logs in
 * once (`run.mjs --login`); the robot never sees a password, and nothing of
 * the profile is ever committed.
 *
 * Browser: the real Google Chrome when installed (`channel: 'chrome'`), else
 * the newest Chromium already in Playwright's cache — never an on-demand
 * download from a launchd job. SOCIAL_ROBOT_BROWSER_PATH overrides both.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, rmdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const STATE_DIR_ENV = 'SOCIAL_ROBOT_STATE_DIR';
export const BROWSER_PATH_ENV = 'SOCIAL_ROBOT_BROWSER_PATH';
export const CHROME_APP_BINARY = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const LOCK_STALE_MS = 3 * 3600_000;

export function defaultStateDir(env = process.env, home = homedir()) {
  const configured = String(env[STATE_DIR_ENV] || '').trim();
  return configured || path.join(home, 'Library', 'Application Support', 'frontaliere', 'social-robot');
}

export const profileDir = (stateDir) => path.join(stateDir, 'profile');
export const diagnosticsDir = (stateDir) => path.join(stateDir, 'diagnostics');
export const downloadsDir = (stateDir) => path.join(stateDir, 'downloads');
export const DIAGNOSTIC_RETENTION_MS = 14 * 24 * 3600_000;
export const MAX_DIAGNOSTIC_RUNS = 40;

/**
 * Keep host-only robot artifacts bounded. Downloads are transient: Playwright
 * has consumed them when a queue entry finishes, while diagnostics remain
 * useful for a short, bounded window after a failure.
 */
export function pruneRobotState(stateDir, {
  now = Date.now(),
  diagnosticRetentionMs = DIAGNOSTIC_RETENTION_MS,
  maxDiagnosticRuns = MAX_DIAGNOSTIC_RUNS,
} = {}) {
  const errors = [];
  const removed = { downloads: false, diagnostics: 0 };
  try {
    rmSync(downloadsDir(stateDir), { recursive: true, force: true });
    removed.downloads = true;
  } catch (error) {
    errors.push(`downloads cleanup failed: ${error?.message || error}`);
  }

  const root = diagnosticsDir(stateDir);
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const directory = path.join(root, entry.name);
        return { directory, mtimeMs: statSync(directory).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch (error) {
    if (error?.code !== 'ENOENT') errors.push(`diagnostics inventory failed: ${error?.message || error}`);
    return { removed, errors };
  }

  const cutoff = now - diagnosticRetentionMs;
  entries.forEach((entry, index) => {
    if (entry.mtimeMs >= cutoff && index < maxDiagnosticRuns) return;
    try {
      rmSync(entry.directory, { recursive: true, force: true });
      removed.diagnostics += 1;
    } catch (error) {
      errors.push(`diagnostics cleanup failed for ${path.basename(entry.directory)}: ${error?.message || error}`);
    }
  });
  return { removed, errors };
}

const CACHED_BINARIES = [
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  'chrome-linux/chrome',
  'chrome-linux64/chrome',
];

/**
 * How to launch: `{ channel: 'chrome' }`, `{ executablePath }` or `{}`
 * (Playwright's own default), plus a `kind` for the log.
 */
export function resolveBrowserLaunch({ env = process.env, exists = existsSync, listDir = readdirSync, home = homedir(), platform = process.platform } = {}) {
  const explicit = String(env[BROWSER_PATH_ENV] || '').trim();
  if (explicit) return { executablePath: explicit, kind: 'explicit' };
  if (platform === 'darwin' && exists(CHROME_APP_BINARY)) return { channel: 'chrome', kind: 'chrome' };
  const cache = platform === 'darwin' ? path.join(home, 'Library', 'Caches', 'ms-playwright') : path.join(home, '.cache', 'ms-playwright');
  let dirs = [];
  try {
    dirs = listDir(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  } catch {
    dirs = [];
  }
  for (const dir of dirs) {
    for (const rel of CACHED_BINARIES) {
      const candidate = path.join(cache, dir, rel);
      if (exists(candidate)) return { executablePath: candidate, kind: 'cached-chromium' };
    }
  }
  return { kind: 'playwright-default' };
}

/**
 * Open the persistent profile. Never headless on the Mac host: the platforms
 * treat headless browsers as bots, and the owner must be able to watch.
 */
export async function openProfile({ stateDir, headless = false, launch = resolveBrowserLaunch(), chromium = null }) {
  const pw = chromium || (await import('playwright')).chromium;
  const dir = profileDir(stateDir);
  mkdirSync(dir, { recursive: true });
  const { kind, ...how } = launch;
  return pw.launchPersistentContext(dir, {
    ...how,
    headless,
    viewport: { width: 1280, height: 900 },
    locale: 'it-IT',
    timezoneId: 'Europe/Zurich',
    acceptDownloads: false,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
}

/**
 * One robot at a time per profile (Chrome refuses a profile already open, and
 * two robots would double the cadence). A lock older than LOCK_STALE_MS
 * belongs to a run that died and is taken over.
 */
export function acquireLock(stateDir, now = Date.now()) {
  mkdirSync(stateDir, { recursive: true });
  const lock = path.join(stateDir, 'run.lock');
  try {
    mkdirSync(lock);
  } catch {
    let age = 0;
    try {
      age = now - statSync(lock).mtimeMs;
    } catch {
      age = Infinity;
    }
    if (age < LOCK_STALE_MS) return null;
    try {
      rmdirSync(lock);
      mkdirSync(lock);
    } catch {
      return null;
    }
  }
  return () => {
    try {
      rmdirSync(lock);
    } catch {
      // already gone
    }
  };
}
