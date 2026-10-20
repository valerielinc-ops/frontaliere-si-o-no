// scripts/lib/consent-message-probe.mjs
//
// Pure half of scripts/probe-live-consent-message.mjs: the in-page recorder
// and the verdict. Kept apart from Playwright so tests can run the recorder
// next to the REAL Offerwall gate (both copies) against a fake Funding
// Choices, and prove the verdict catches the regression it exists for.
//
// Why a live probe at all. On 2026-09-27 the gate (#9974) read Funding
// Choices' MessageTypeEnum as missing because its live values are strings
// ({OFFERWALL:"offerwall"}), not the numbers the unit tests had assumed. On
// every page the call that carries OFFERWALL got `proceed(false)` with no
// types. That call also carries the GDPR consent message, so no new visitor
// was ever asked for consent, `frontaliere_ads_consent` was never written and
// the ad loaders kept waiting: ad revenue fell 73% for ~6 hours (11-17h
// Zurich) while sessions stayed normal, and nothing alerted. Unit tests can
// only check the enum shape we believe in; this probe asks the real one.

/**
 * Installed with page.addInitScript before any page script. Wraps whatever
 * the page assigns to `googlefc.controlledMessagingFunction` (the Offerwall
 * gate, or anything composed before it) and records, per Funding Choices
 * call, the enum it saw and the decision the page gave. Only the outermost
 * wrapper records: a composed inner function receives a message already
 * marked, so one Funding Choices call is one record. Written in ES5 because
 * it runs as-is in the page, like the gate it observes.
 */
export const CMF_RECORDER_INIT_JS = `(function(){
  var w = window;
  var g = w.googlefc = w.googlefc || {};
  var log = w.__ftConsentProbe = w.__ftConsentProbe || { calls: [] };
  var current;
  Object.defineProperty(g, 'controlledMessagingFunction', {
    configurable: true,
    enumerable: true,
    get: function(){ return current; },
    set: function(fn){
      if (typeof fn !== 'function') { current = fn; return; }
      current = function(message){
        if (!message || message.__ftConsentProbe) return fn.apply(this, arguments);
        var E = (w.googlefc && w.googlefc.MessageTypeEnum) || {};
        var rec = { enumKeys: Object.keys(E).length, offerwallType: typeof E.OFFERWALL, decision: null };
        log.calls.push(rec);
        var d = Object.create(message);
        d.__ftConsentProbe = true;
        d.proceed = function(allow, types){
          if (!rec.decision) rec.decision = { allow: allow !== false, types: Array.isArray(types) ? types.slice() : null };
          return message.proceed.apply(message, arguments);
        };
        return fn.call(this, d);
      };
    }
  });
})();`;

/**
 * Query that makes Funding Choices show the GDPR message regardless of the
 * visitor's location (Google's documented message preview). GitHub runners
 * are outside the EEA, where the consent message would otherwise not be
 * offered at all.
 */
export const FC_PREVIEW_QUERY = 'fc=alwaysshow&fctype=gdpr';

/**
 * @typedef {{ enumKeys: number, offerwallType: string, decision: { allow: boolean, types: unknown[] | null } | null }} CmfCall
 * @typedef {{ verdict: 'pass' | 'fail' | 'inconclusive', reason: string, detail: string }} ProbeVerdict
 */

/**
 * @param {{ calls?: CmfCall[], fcRequested?: boolean, dialogVisible?: boolean }} observation
 * @returns {ProbeVerdict}
 */
export function classifyConsentProbe({ calls = [], fcRequested = false, dialogVisible = false } = {}) {
  // A call whose enum is populated is the one that carries the Offerwall AND
  // the consent message. The gate may suppress the Offerwall by type there,
  // never everything.
  const populated = calls.filter((c) => c && c.enumKeys > 0);
  const blanket = populated.filter(
    (c) => c.decision && c.decision.allow === false && !(Array.isArray(c.decision.types) && c.decision.types.length > 0),
  );
  if (blanket.length > 0) {
    const shapes = [...new Set(blanket.map((c) => c.offerwallType))].join(', ');
    return {
      verdict: 'fail',
      reason: 'blanket_suppression',
      detail: `Funding Choices offered its messages (MessageTypeEnum.OFFERWALL is ${shapes}) and the page answered proceed(false) with no types: the GDPR consent message is suppressed for every new visitor, so no consent is recorded and no ads load.`,
    };
  }
  // A clean profile has no consent decision, so the gate must answer at once
  // (suppressing only the Offerwall); holding the call keeps the CMP off screen.
  const unanswered = populated.filter((c) => !c.decision);
  if (unanswered.length > 0) {
    return {
      verdict: 'fail',
      reason: 'unanswered',
      detail: `${unanswered.length} Funding Choices call(s) carrying the consent message never got proceed(): the CMP stays off screen for a visitor with no consent decision.`,
    };
  }
  if (!fcRequested) {
    return {
      verdict: 'fail',
      reason: 'fc_not_requested',
      detail: 'The page never requested the Funding Choices script: the consent message cannot appear, so new visitors never get ads.',
    };
  }
  if (dialogVisible) {
    return { verdict: 'pass', reason: 'consent_visible', detail: 'The GDPR consent message is on screen.' };
  }
  if (populated.length === 0) {
    return {
      verdict: 'inconclusive',
      reason: 'no_message_offered',
      detail: 'Funding Choices loaded but offered no message in the window (Google-side, or not offered from this location).',
    };
  }
  return {
    verdict: 'inconclusive',
    reason: 'consent_not_visible',
    detail: 'The page let the consent message through, but it did not appear in the window.',
  };
}

/**
 * In-page snapshot of the navigator signals that the ad loaders' bot gate
 * reads (`BOT_GATE_FN` in build-plugins/constants.ts, twin of
 * services/botPatterns.ts `isLikelyBot()`). A browser that trips that gate is
 * skipped by the loaders by design, so Funding Choices never loads for it.
 */
export const BROWSER_FINGERPRINT_JS = `(function(){var n=navigator;return{userAgent:String(n.userAgent||''),webdriver:n.webdriver===true,chromeObject:'chrome' in window,languages:n.languages?n.languages.length:-1,plugins:n.plugins?n.plugins.length:-1,permissions:typeof n.permissions!=='undefined'};})()`;

/**
 * The browser-dependent layers of `BOT_GATE_FN` (webdriver, Chrome without
 * `window.chrome`, desktop Chrome with no languages, no plugins or no
 * Permissions API), applied to the probe's own browser. The UA-pattern and
 * screen-signature layers depend on inputs the probe sets itself.
 *
 * chrome-headless-shell, Playwright's default headless browser, has no PDF
 * plugin and no `window.chrome`: on 2026-09-28 it made the probe fail
 * `fc_not_requested` on /cerca-lavoro-zurigo/ (#10166), whose only Funding
 * Choices loader is the gated CDN one, while real Chrome got the consent
 * message. A probe the site treats as a bot says nothing about visitors.
 *
 * @param {{ userAgent?: string, webdriver?: boolean, chromeObject?: boolean, languages?: number, plugins?: number, permissions?: boolean }} fp
 * @returns {ProbeVerdict | null} null when the probe browser looks like a visitor
 */
export function botFingerprintVerdict(fp = {}) {
  const ua = String(fp.userAgent || '').toLowerCase();
  const signals = [];
  if (fp.webdriver) signals.push('navigator.webdriver is true');
  if (ua.includes('chrome') && !fp.chromeObject) signals.push('no window.chrome');
  if (ua.includes('chrome') && !ua.includes('mobile')) {
    if (fp.languages === 0) signals.push('navigator.languages is empty');
    if (fp.plugins === 0) signals.push('navigator.plugins is empty');
    if (!fp.permissions) signals.push('navigator.permissions is missing');
  }
  if (signals.length === 0) return null;
  return {
    verdict: 'fail',
    reason: 'probe_flagged_as_bot',
    detail: `The probe browser trips the ad loaders' bot gate (${signals.join(', ')}), so the site rightly never loads Funding Choices for it and no page can be verified: this is the probe's environment, not a site regression. Launch full Chromium (channel 'chromium' or CHROMIUM_EXECUTABLE_PATH), not chrome-headless-shell.`,
  };
}

/**
 * A page that could not be loaded or observed was not verified: that is a
 * fail, never a warning, or an unreachable page would pass the gate.
 */
export function navigationErrorVerdict(error) {
  return {
    verdict: 'fail',
    reason: 'navigation_error',
    detail: `The page could not be loaded or observed, so the consent message was not verified: ${String(error?.message || error).slice(0, 300)}`,
  };
}

/**
 * Verdict of one page over its attempts, failure-sticky: a pass on any attempt
 * clears a flake; otherwise a fail on any attempt stands, whatever the other
 * attempts said. Only attempts that are all inconclusive stay a warning.
 */
export function bestVerdict(verdicts) {
  return (
    verdicts.find((v) => v.verdict === 'pass') ??
    verdicts.find((v) => v.verdict === 'fail') ??
    verdicts[verdicts.length - 1]
  );
}
