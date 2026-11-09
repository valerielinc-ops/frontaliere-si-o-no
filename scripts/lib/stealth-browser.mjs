/**
 * stealth-browser.mjs — crawler-only CloakBrowser support. The assisted
 * application runner uses stock Playwright Chromium and hands CAPTCHA and
 * anti-bot challenges to Valerie instead of masking automation.
 *
 * The crawler is the only caller and uses its own CloakBrowser license key
 * (one concurrent session, Remote Config):
 *
 *   purpose    flag (RC → env)           key (RC → env)
 *   crawler    STEALTH_BROWSER_CRAWLER   CLOAKBROWSER_LICENSE_KEY_CRAWLER
 *
 * The flag's safe local default is off ('0'): without Remote Config nothing
 * changes. Activation is per run: the workflow's `node scripts/load-rc-env.mjs`
 * step reads the template once, before the script starts.
 *
 * When the key's only seat is taken (another run holds it, or a crashed one
 * has not released it yet — up to 4 min on a free key), when the key is
 * refused, or when the binary cannot start, the launch falls back to the
 * current Chromium (launchChromium) instead of failing: the run goes on as it
 * did before this file existed.
 */
import { ensureChromiumInstalled, launchChromium, __test as chromiumTest } from './ensure-chromium.mjs';

export const STEALTH_PURPOSES = Object.freeze({
  crawler: Object.freeze({ flag: 'STEALTH_BROWSER_CRAWLER', key: 'CLOAKBROWSER_LICENSE_KEY_CRAWLER' }),
});

// Optional upstream proxy for the stealth browser only (http://, socks5://).
export const STEALTH_PROXY_ENV = 'STEALTH_BROWSER_PROXY';

// A seat over the cap is refused AFTER the CDP handshake: the binary records
// the denial and exits about a second later. Waiting this long before handing
// the browser out turns that late refusal into a fallback, not a dead page.
const DENIAL_WAIT_MS = 2_500;
const DENIAL_POLL_MS = 250;

const ENGINE = Symbol.for('frontaliere.stealthBrowser.engine');

/** Whether `purpose` should use CloakBrowser in this run, and with which key. */
export function stealthConfig(purpose, env = process.env) {
  const spec = STEALTH_PURPOSES[purpose];
  if (!spec) throw new Error(`stealth-browser: unknown purpose "${purpose}"`);
  const flagOn = String(env[spec.flag] ?? '0').trim() === '1';
  const licenseKey = String(env[spec.key] ?? '').trim();
  const reason = !flagOn ? 'disabled' : !/^cb_\w+$/.test(licenseKey) ? 'no_license_key' : null;
  return { enabled: reason === null, reason, licenseKey, proxy: String(env[STEALTH_PROXY_ENV] ?? '').trim() };
}

/** Why a CloakBrowser launch did not give a usable browser (never the key). */
export function classifyStealthFailure(error) {
  const text = String(error?.message || error || '');
  if (/session limit reached/i.test(text)) return 'session_in_use';
  if (/invalid, expired, or missing|invalid or expired|no cloakbrowser license key/i.test(text)) return 'license_invalid';
  if (/couldn't verify your license|could not be validated|server unreachable/i.test(text)) return 'license_unreachable';
  if (/Cannot find (?:module|package) ['"]?cloakbrowser|ERR_MODULE_NOT_FOUND.*cloakbrowser/i.test(text)) return 'not_installed';
  if (chromiumTest.isMissingBrowserError(error)) return 'missing_system_libs';
  return 'launch_error';
}

/** A desktop Chrome user agent used only by the separately scoped crawler. */
export function chromeUserAgent(version, platform = process.platform) {
  const system = platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
  const major = /^\d+/.exec(String(version || ''))?.[0] || '140';
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** 'cloakbrowser' or 'chromium', and why Chromium when it is the fallback. */
export function browserEngine(browser) {
  return browser?.[ENGINE] || { engine: 'chromium', reason: 'unmarked' };
}

export const isStealthBrowser = (browser) => browserEngine(browser).engine === 'cloakbrowser';

function mark(browser, engine, reason = null) {
  if (browser && typeof browser === 'object') {
    Object.defineProperty(browser, ENGINE, { value: Object.freeze({ engine, reason }), configurable: true });
  }
  return browser;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function lateDenial(cloak, browser, waitMs) {
  if (typeof cloak.licenseDenial !== 'function') return null;
  for (let waited = 0; ; waited += DENIAL_POLL_MS) {
    const denial = cloak.licenseDenial(browser);
    if (denial) return denial;
    if (browser?.isConnected && !browser.isConnected()) return new Error('cloakbrowser disconnected right after launch');
    if (waited >= waitMs) return null;
    await sleep(DENIAL_POLL_MS);
  }
}

/**
 * Launch CloakBrowser for `purpose` when its flag and key allow it, otherwise
 * (or when it cannot start) the usual Chromium. Always resolves to a
 * Playwright Browser; `browserEngine(browser)` says which one it is.
 *
 * Under CloakBrowser, locale and timezone are binary flags: callers must NOT
 * set userAgent, locale or timezoneId on the context (CDP emulation is itself
 * a tell), and should pass viewport: null so the page follows the window.
 *
 * @param {object} options
 * @param {'crawler'} options.purpose
 * @param {boolean} [options.headless=true]
 * @param {string} [options.locale] e.g. 'de-CH'
 * @param {string} [options.timezone='Europe/Zurich']
 * @param {string[]} [options.args] extra Chromium args for CloakBrowser
 * @param {boolean} [options.humanize=false] CloakBrowser's human-like input layer
 * @param {object} [options.fallbackOptions] launchChromium options (default { headless })
 * @param {object} [options.env=process.env]
 * @param {(line: string) => void} [options.log]
 * @param {object} [options.deps] tests: { cloak, launchChromium, ensureChromiumInstalled, denialWaitMs }
 */
export async function launchStealthOrChromium({
  purpose,
  headless = true,
  locale,
  timezone = 'Europe/Zurich',
  args = [],
  humanize = false,
  fallbackOptions,
  env = process.env,
  log = (line) => process.stderr.write(`${line}\n`),
  deps = {},
} = {}) {
  const config = stealthConfig(purpose, env);
  const fallback = async (reason) => {
    const browser = await (deps.launchChromium || launchChromium)(fallbackOptions ?? { headless });
    return mark(browser, 'chromium', reason);
  };
  if (!config.enabled) return fallback(config.reason);

  let cloak;
  try {
    cloak = deps.cloak || (await import('cloakbrowser'));
  } catch (error) {
    log(`[stealth-browser] ${purpose}: CloakBrowser not installed (${classifyStealthFailure(error)}) → Chromium`);
    return fallback('not_installed');
  }

  const launchOptions = {
    licenseKey: config.licenseKey,
    headless,
    timezone,
    ...(locale ? { locale } : {}),
    ...(args.length ? { args } : {}),
    ...(humanize ? { humanize: true } : {}),
    ...(config.proxy ? { proxy: config.proxy } : {}),
  };
  const attempt = async () => {
    const browser = await cloak.launch(launchOptions);
    const denial = await lateDenial(cloak, browser, deps.denialWaitMs ?? DENIAL_WAIT_MS);
    if (denial) {
      await browser.close().catch(() => {});
      throw denial;
    }
    return browser;
  };

  let reason;
  try {
    const browser = await attempt();
    log(`[stealth-browser] ${purpose}: CloakBrowser`);
    return mark(browser, 'cloakbrowser');
  } catch (error) {
    reason = classifyStealthFailure(error);
    // A fresh runner may lack Chromium's system libraries: the same install
    // that heals launchChromium heals CloakBrowser, then one more try.
    if (reason === 'missing_system_libs') {
      try {
        await (deps.ensureChromiumInstalled || ensureChromiumInstalled)();
        const browser = await attempt();
        log(`[stealth-browser] ${purpose}: CloakBrowser (after installing system libraries)`);
        return mark(browser, 'cloakbrowser');
      } catch (retryError) {
        reason = classifyStealthFailure(retryError);
      }
    }
  }
  log(`[stealth-browser] ${purpose}: CloakBrowser unavailable (${reason}) → Chromium`);
  return fallback(reason);
}
