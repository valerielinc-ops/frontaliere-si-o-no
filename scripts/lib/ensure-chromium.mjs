/**
 * ensure-chromium.mjs — self-healing Playwright Chromium launcher.
 *
 * THE PROBLEM this solves (structural, fleet-wide):
 * ~398/425 dedicated-crawler workflows reach a Playwright browser fallback
 * (the shared crawler enables it by default — `JOBS_BROWSER_FALLBACK_ENABLED`
 * defaults to '1'), but `npm ci` installs the playwright *package* without the
 * *browser binary*. A workflow that lacks an explicit `npx playwright install`
 * step makes `chromium.launch()` throw "Executable doesn't exist"; crawlers
 * caught that and silently returned 0 jobs (lost indexable content with no
 * signal), or hard-failed and opened a `Crawler Failure` issue. The reviewer
 * kept flagging this per-crawler (cambiavalute → colin-cie → eHnv/cnp →
 * pole-sante…), an unbounded manual loop.
 *
 * THE FIX: every launch goes through `launchChromium()`. If the binary is
 * missing, it installs Chromium ON-DEMAND (once per process, memoized) and
 * retries — so the browser is guaranteed available wherever it's actually
 * needed, regardless of whether the workflow remembered the install step. The
 * cost is paid lazily, only when a crawler genuinely hits the fallback (most
 * never do), instead of a wasted install step on every run of 398 workflows.
 *
 * Use `launchChromium(opts)` instead of `chromium.launch(opts)` everywhere.
 */
import { execFileSync } from 'node:child_process';

// Signals that Chromium's binary (or its system libs) is missing — i.e. an
// install would fix it. Anything else (OOM, sandbox, a real bug) is rethrown.
const MISSING_BROWSER_RE =
  /Executable doesn'?t exist|please run the following command to download|playwright install|error while loading shared libraries|cannot open shared object file|libnss3|libatk|host system is missing dependencies/i;

let _chromium = null;
let _installPromise = null;

function isMissingBrowserError(err) {
  return MISSING_BROWSER_RE.test(String(err?.message || err || ''));
}

/** Lazy-import the playwright chromium handle (memoized). */
export async function getChromium() {
  if (!_chromium) {
    const mod = await import('playwright');
    _chromium = mod?.chromium || mod?.default?.chromium || null;
    if (!_chromium) throw new Error('playwright module has no chromium export');
  }
  return _chromium;
}

/**
 * Install the Chromium browser binary on-demand. Memoized: at most one install
 * per process even under concurrent callers. Tries `--with-deps` first (CI
 * runners have passwordless sudo and may lack system libs), then falls back to
 * the binary-only install (dev machines / where sudo is unavailable).
 */
export function ensureChromiumInstalled() {
  if (_installPromise) return _installPromise;
  _installPromise = (async () => {
    const attempts = [
      ['playwright', 'install', '--with-deps', 'chromium'],
      ['playwright', 'install', 'chromium'],
    ];
    let lastErr;
    for (const args of attempts) {
      try {
        console.warn(`🩹 Chromium binary missing — installing on-demand: npx ${args.join(' ')}`);
        execFileSync('npx', args, { stdio: 'inherit', timeout: 6 * 60_000 });
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(`on-demand Chromium install failed: ${lastErr?.message || lastErr}`);
  })();
  return _installPromise;
}

/**
 * Drop-in replacement for `chromium.launch(opts)` that self-heals a missing
 * browser binary by installing it once and retrying. Same return value
 * (Promise<Browser>) and same options as `chromium.launch`.
 */
export async function launchChromium(launchOptions = {}) {
  const chromium = await getChromium();
  try {
    return await chromium.launch(launchOptions);
  } catch (err) {
    if (!isMissingBrowserError(err)) throw err;
    await ensureChromiumInstalled();
    return await chromium.launch(launchOptions);
  }
}

// Exposed for testing the error-classifier in isolation.
export const __test = { isMissingBrowserError };
