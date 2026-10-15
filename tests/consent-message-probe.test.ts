/**
 * scripts/probe-live-consent-message.mjs asks the LIVE Funding Choices
 * whether a new visitor is offered the GDPR consent message. These tests pin
 * its two offline halves:
 * - the verdict (scripts/lib/consent-message-probe.mjs);
 * - the in-page recorder, executed next to the REAL Offerwall gate (both
 *   copies) against a fake Funding Choices, so the probe provably reads the
 *   decision the gate gives, and fails on the 2026-09-27 regression (#9974:
 *   a number-only enum check answered proceed(false) to the string enum).
 * Plus the workflow wiring: the probe is a failing step of validate-live.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { BOT_GATE_FN, FC_JOBBOARD_OFFERWALL_GATE_JS } from '@/build-plugins/constants';
import {
  BROWSER_FINGERPRINT_JS,
  CMF_RECORDER_INIT_JS,
  FC_PREVIEW_QUERY,
  bestVerdict,
  botFingerprintVerdict,
  classifyConsentProbe,
  navigationErrorVerdict,
} from '../scripts/lib/consent-message-probe.mjs';
import { probeUrl } from '../scripts/probe-live-consent-message.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(resolve(REPO_ROOT, 'index.html'), 'utf8');
const validateLive = readFileSync(resolve(REPO_ROOT, '.github/workflows/post-deploy-validate-live.yml'), 'utf8');
const probeSrc = readFileSync(resolve(REPO_ROOT, 'scripts/probe-live-consent-message.mjs'), 'utf8');

function extractIndexHtmlGate(): string {
  const m = indexHtml.match(/<script>((?:(?!<\/script>)[\s\S])*__ftOfferwallGate[\s\S]*?)<\/script>/);
  if (!m) throw new Error('index.html no longer contains the __ftOfferwallGate script');
  return m[1];
}

// Re-introduce the #9974 check (number only) in a copy of the gate.
function numberOnly(src: string): string {
  const broken = src.replace(/\s*&&\s*typeof E\.OFFERWALL\s*!==\s*'string'/, '');
  if (broken === src) throw new Error('gate no longer carries the string clause this test removes');
  return broken;
}

type Call = { enumKeys: number; offerwallType: string; decision: { allow: boolean; types: unknown[] | null } | null };
type Msg = { proceed: (...args: unknown[]) => void };
type Win = {
  location: { pathname: string };
  history: { pushState: () => void; replaceState: () => void };
  addEventListener: () => void;
  localStorage: { getItem: () => string | null };
  document: { cookie: string };
  googlefc?: { MessageTypeEnum?: Record<string, string | number>; controlledMessagingFunction?: (m: Msg) => void };
  __ftConsentProbe?: { calls: Call[] };
};

// A clean browser profile, as the probe uses: no consent decision anywhere.
function visit(gateSrc: string, pathname: string, ENUM: Record<string, string | number>): Call[] {
  const win: Win = {
    location: { pathname },
    history: { pushState: () => {}, replaceState: () => {} },
    addEventListener: () => {},
    localStorage: { getItem: () => null },
    document: { cookie: '' },
  };
  // eslint-disable-next-line no-new-func
  new Function('window', CMF_RECORDER_INIT_JS)(win);
  // eslint-disable-next-line no-new-func
  new Function('window', gateSrc)(win);
  const fc = win.googlefc!;
  // Funding Choices calls twice: first with an empty enum, then populated.
  fc.controlledMessagingFunction!({ proceed: () => {} });
  fc.MessageTypeEnum = ENUM;
  fc.controlledMessagingFunction!({ proceed: () => {} });
  return win.__ftConsentProbe!.calls;
}

const COPIES: Array<[string, string]> = [
  ['index.html inline copy', extractIndexHtmlGate()],
  ['FC_JOBBOARD_OFFERWALL_GATE_JS', FC_JOBBOARD_OFFERWALL_GATE_JS],
];
const LIVE_ENUM = { OFFERWALL: 'offerwall', AD_BLOCKING: 'ad_blocking' };
const NUMERIC_ENUM = { OFFERWALL: 1, AD_BLOCKING: 2 };
const PATHS = ['/', '/cerca-lavoro-ticino/', '/cerca-lavoro-zurigo/'];

describe('recorder next to the real gate', () => {
  for (const [copy, src] of COPIES) {
    for (const [shape, ENUM] of [['string enum', LIVE_ENUM], ['numeric enum', NUMERIC_ENUM]] as const) {
      for (const path of PATHS) {
        it(`${copy}, ${shape}, ${path}: records one call per Funding Choices call and no fail`, () => {
          const calls = visit(src, path, ENUM);
          expect(calls).toHaveLength(2);
          expect(calls[0]).toMatchObject({ enumKeys: 0, decision: { allow: true, types: null } });
          expect(calls[1]).toMatchObject({ enumKeys: 2, decision: { allow: false, types: [ENUM.OFFERWALL] } });
          // Offline there is no dialog to see; the verdict must still not fail.
          expect(classifyConsentProbe({ calls, fcRequested: true, dialogVisible: false }).verdict).toBe('inconclusive');
          expect(classifyConsentProbe({ calls, fcRequested: true, dialogVisible: true }).verdict).toBe('pass');
        });
      }
    }

    it(`${copy}: the #9974 number-only check fails the probe on the live string enum`, () => {
      for (const path of PATHS) {
        const calls = visit(numberOnly(src), path, LIVE_ENUM);
        expect(calls[1]).toMatchObject({ enumKeys: 2, offerwallType: 'string', decision: { allow: false, types: null } });
        const v = classifyConsentProbe({ calls, fcRequested: true, dialogVisible: false });
        expect(v.verdict, path).toBe('fail');
        expect(v.reason).toBe('blanket_suppression');
      }
    });
  }

  it('records only the outermost function when the page composes callbacks', () => {
    const win: Win = {
      location: { pathname: '/' },
      history: { pushState: () => {}, replaceState: () => {} },
      addEventListener: () => {},
      localStorage: { getItem: () => null },
      document: { cookie: '' },
    };
    // eslint-disable-next-line no-new-func
    new Function('window', CMF_RECORDER_INIT_JS)(win);
    const fc = win.googlefc!;
    fc.controlledMessagingFunction = (m: Msg) => m.proceed(true);
    const inner = fc.controlledMessagingFunction!;
    fc.controlledMessagingFunction = (m: Msg) => inner(m);
    fc.MessageTypeEnum = LIVE_ENUM;
    fc.controlledMessagingFunction!({ proceed: () => {} });
    expect(win.__ftConsentProbe!.calls).toEqual([{ enumKeys: 2, offerwallType: 'string', decision: { allow: true, types: null } }]);
  });
});

describe('classifyConsentProbe', () => {
  const populated = (decision: Call['decision']): Call => ({ enumKeys: 2, offerwallType: 'string', decision });
  const bootstrap: Call = { enumKeys: 0, offerwallType: 'undefined', decision: { allow: true, types: null } };

  it('fails a blanket suppression even when a dialog is somehow visible', () => {
    const v = classifyConsentProbe({ calls: [bootstrap, populated({ allow: false, types: [] })], fcRequested: true, dialogVisible: true });
    expect(v).toMatchObject({ verdict: 'fail', reason: 'blanket_suppression' });
  });

  it('fails a populated call that never gets proceed()', () => {
    expect(classifyConsentProbe({ calls: [bootstrap, populated(null)], fcRequested: true }).reason).toBe('unanswered');
  });

  it('fails when Funding Choices is never requested', () => {
    expect(classifyConsentProbe({ calls: [], fcRequested: false, dialogVisible: false }).reason).toBe('fc_not_requested');
  });

  it('passes when the consent message is on screen', () => {
    const v = classifyConsentProbe({ calls: [bootstrap, populated({ allow: false, types: ['offerwall'] })], fcRequested: true, dialogVisible: true });
    expect(v.verdict).toBe('pass');
  });

  it('is inconclusive, not failed, when Funding Choices offers nothing', () => {
    expect(classifyConsentProbe({ calls: [bootstrap], fcRequested: true, dialogVisible: false }))
      .toMatchObject({ verdict: 'inconclusive', reason: 'no_message_offered' });
  });

  it('ignores the enum-less bootstrap call even when it is refused', () => {
    const refusedBootstrap: Call = { enumKeys: 0, offerwallType: 'undefined', decision: { allow: false, types: null } };
    expect(classifyConsentProbe({ calls: [refusedBootstrap], fcRequested: true, dialogVisible: true }).verdict).toBe('pass');
  });

  it('aggregates attempts failure-sticky: only a pass clears a fail', () => {
    const fail = { verdict: 'fail' as const, reason: 'blanket_suppression', detail: '' };
    const pass = { verdict: 'pass' as const, reason: 'consent_visible', detail: '' };
    const unsure = { verdict: 'inconclusive' as const, reason: 'no_message_offered', detail: '' };
    expect(bestVerdict([fail, pass])).toBe(pass);
    expect(bestVerdict([fail, fail])).toBe(fail);
    expect(bestVerdict([fail, unsure])).toBe(fail);
    expect(bestVerdict([unsure, fail])).toBe(fail);
    expect(bestVerdict([unsure, unsure])).toBe(unsure);
  });

  it('fails a page that could not be loaded or observed', () => {
    const v = navigationErrorVerdict(new Error('net::ERR_CONNECTION_REFUSED at http://127.0.0.1:9/'));
    expect(v).toMatchObject({ verdict: 'fail', reason: 'navigation_error' });
    expect(v.detail).toContain('ERR_CONNECTION_REFUSED');
    expect(bestVerdict([v, v]).verdict).toBe('fail');
  });
});

describe('botFingerprintVerdict', () => {
  // The user agent the probe presents (Linux desktop Chrome).
  const PROBE_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
  const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36';
  type Env = { ua: string; webdriver?: boolean; chromeObject: boolean; languages: string[]; plugins: number; permissions: boolean };
  // Measured on 2026-09-28 with webdriver already masked by the probe:
  // chrome-headless-shell {plugins:0, chrome:false, langs:1}, full Chromium {plugins:5, chrome:true, langs:2}.
  const SCENARIOS: Array<[string, Env, boolean]> = [
    ['chrome-headless-shell', { ua: PROBE_UA, chromeObject: false, languages: ['it-CH'], plugins: 0, permissions: true }, true],
    ['full Chromium, new headless', { ua: PROBE_UA, chromeObject: true, languages: ['it-CH', 'it'], plugins: 5, permissions: true }, false],
    ['webdriver left visible', { ua: PROBE_UA, webdriver: true, chromeObject: true, languages: ['it-CH'], plugins: 5, permissions: true }, true],
    ['no languages', { ua: PROBE_UA, chromeObject: true, languages: [], plugins: 5, permissions: true }, true],
    ['no Permissions API', { ua: PROBE_UA, chromeObject: true, languages: ['it-CH'], plugins: 5, permissions: false }, true],
    ['mobile Chrome with no plugins', { ua: MOBILE_UA, chromeObject: true, languages: ['it-CH'], plugins: 0, permissions: true }, false],
  ];

  function fakeEnv(env: Env) {
    const navigator: Record<string, unknown> = {
      userAgent: env.ua,
      webdriver: env.webdriver === true,
      language: env.languages[0] || '',
      languages: env.languages,
      plugins: { length: env.plugins },
    };
    if (env.permissions) navigator.permissions = {};
    const window: Record<string, unknown> = { screen: { width: 1280, height: 900 } };
    if (env.chromeObject) window.chrome = {};
    return { window, navigator };
  }

  for (const [name, env, flagged] of SCENARIOS) {
    it(`${name}: agrees with the loaders' BOT_GATE_FN (${flagged ? 'bot' : 'visitor'})`, () => {
      const { window, navigator } = fakeEnv(env);
      // eslint-disable-next-line no-new-func
      const gate = new Function('window', 'navigator', `return (${BOT_GATE_FN})();`)(window, navigator);
      // eslint-disable-next-line no-new-func
      const fp = new Function('window', 'navigator', `return ${BROWSER_FINGERPRINT_JS};`)(window, navigator);
      expect(gate).toBe(flagged);
      expect(botFingerprintVerdict(fp) !== null).toBe(flagged);
    });
  }

  it('names the probe environment, not the site, when the shell is used', () => {
    const v = botFingerprintVerdict({ userAgent: PROBE_UA, webdriver: false, chromeObject: false, languages: 1, plugins: 0, permissions: true });
    expect(v).toMatchObject({ verdict: 'fail', reason: 'probe_flagged_as_bot' });
    expect(v!.detail).toContain('navigator.plugins is empty');
    expect(v!.detail).toContain('no window.chrome');
    expect(v!.detail).toContain('not a site regression');
  });
});

describe('probeUrl', () => {
  it('adds the Funding Choices preview query and a cache-busting stamp', () => {
    expect(probeUrl('https://frontaliereticino.ch/', '/cerca-lavoro-ticino/', 42)).toBe(
      `https://frontaliereticino.ch/cerca-lavoro-ticino/?${FC_PREVIEW_QUERY}&_ftprobe=42`,
    );
  });
});

describe('post-deploy-validate-live.yml', () => {
  const stepStart = validateLive.indexOf('- name: Consent message reaches new visitors');
  const step = validateLive.slice(stepStart, validateLive.indexOf('\n      - name:', stepStart + 1));

  it('runs the probe as a failing step after the propagation wait', () => {
    expect(stepStart).toBeGreaterThan(validateLive.indexOf('- name: Fail on propagation timeout'));
    expect(step).toContain('node scripts/probe-live-consent-message.mjs');
    expect(step).toContain('PLAYWRIGHT_BROWSERS_PATH: /home/runner/.cache/ms-playwright');
    expect(step).not.toMatch(/continue-on-error:\s*true/);
    // Worst case inside the probe: 3 pages x 2 attempts x (60s navigation + 30s wait).
    expect(step).toMatch(/timeout-minutes:\s*\d+/);
  });

  it('launches full Chromium, which the CI install provides next to the headless shell', () => {
    expect(probeSrc).toContain("{ headless: true, channel: 'chromium' }");
    expect(probeSrc).toContain('botFingerprintVerdict(await browserFingerprint(browser, userAgent))');
    // `install chromium` fetches both builds; --only-shell would drop the one the probe launches.
    expect(validateLive).toContain('npx playwright install --with-deps chromium');
    expect(validateLive).not.toMatch(/playwright install[^\n]*--only-shell/);
  });

  it('does not fail an older deploy_ref when the workflow-only probe is new', () => {
    expect(step).toContain('if [ ! -f scripts/probe-live-consent-message.mjs ]; then');
    expect(step).toContain('git fetch --depth=1 origin main');
    expect(step).toContain('git cat-file -e origin/main:scripts/probe-live-consent-message.mjs');
    expect(step).toContain('the build predates the live gate');
    expect(step).toContain('exit 0');
  });
});
