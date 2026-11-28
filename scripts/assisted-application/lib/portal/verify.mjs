/** Protected inspection: existing-account sign-in, GET reads, no application actions. */
import { isStealthBrowser, launchStealthOrChromium } from '../../../lib/stealth-browser.mjs';
import { COOKIE_REJECT_RE, headedBrowser, recoverAccountPassword } from './portal.mjs';
import { extractFields } from './fields.mjs';
import { SIGN_IN_RE, authPageKind, loginFields } from './account.mjs';
import { applyActions, findButton, locatorFor } from './fill.mjs';
import { applicationReceipt, applicationStage, portalJobKey, routeDirectory } from './stages.mjs';
import { avaturePortalDirectory } from './protocol.mjs';
import { resolvesToPublicHost } from '../../../../functions/src/assistedApplicationAiJob.js';
import { applicationExistsProbeNavigation, applicationExistsRoute } from '../../../../functions/src/lib/applicationExistsReconciliation.js';

const portalDirectory = url => routeDirectory(url.pathname);
// /job?jobId=42 does not attest a sibling /application/ namespace. Only
// primary protocol metadata can lift a JobDetail/slug directory to its
// portal namespace; suffix regexes must never relax this boundary.
const sourceDirectory = (url, protocol) => avaturePortalDirectory(url.href, protocol) || portalDirectory(url);

const launchAssistedVerificationBrowser = ({ headless = !headedBrowser() } = {}) => {
  const args = ['--window-size=1366,900'];
  return launchStealthOrChromium({
    purpose: 'assisted',
    headless,
    locale: 'en-GB',
    timezone: 'Europe/Zurich',
    args,
    fallbackOptions: { headless, args },
  });
};

export { applicationExistsProbeNavigation };

const SAFE_ERROR_MESSAGES = [
  [/net::ERR_[A-Z_]{3,40}/, match => match[0]],
  [/Timeout \d+ms exceeded/, () => 'timeout'],
  [/Target page, context or browser has been closed|has been closed/i, () => 'target_closed'],
  [/Execution context was destroyed/i, () => 'context_destroyed'],
  [/strict mode violation/i, () => 'strict_mode_violation'],
  [/Cannot read properties of (undefined|null)/, match => `read_of_${match[1]}`],
  [/is not a function/, () => 'not_a_function'],
  [/is not (?:defined|iterable)/, () => 'not_defined'],
  [/decrypt|Unsupported state or unable to authenticate data/i, () => 'decrypt_failed'],
];

/**
 * What an inspection error may say about itself: where it happened (our own stage names), the error's class and
 * code when they look like identifiers, and one token from a short allowlist of known messages. Never the
 * message text itself: it can carry portal pages, URLs, credentials or candidate data.
 */
export function safeErrorInfo(error, stage = 'unknown') {
  const name = typeof error?.name === 'string' && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'Error';
  const code = typeof error?.code === 'string' && /^[A-Za-z0-9_.:-]{1,60}$/.test(error.code) ? error.code : undefined;
  const text = String(error?.message ?? '').slice(0, 400);
  let messageCode;
  for (const [pattern, token] of SAFE_ERROR_MESSAGES) {
    const match = pattern.exec(text);
    if (match) { messageCode = token(match); break; }
  }
  return { stage: String(stage).replace(/[^a-z_]/g, '').slice(0, 30) || 'unknown', name, ...(code ? { code } : {}), ...(messageCode ? { message: messageCode } : {}) };
}

export function verificationTarget({ applyUrl, evidence, sourceProtocol = null }) {
  try {
    const source = new URL(applyUrl);
    const target = new URL(evidence?.finalUrl);
    if (source.protocol !== 'https:' || target.origin !== source.origin || portalDirectory(target) !== sourceDirectory(source, sourceProtocol) || !portalJobKey(applyUrl, sourceProtocol)
      || portalJobKey(target.href) !== portalJobKey(applyUrl, sourceProtocol) || target.hash
      || !/(?:^|\/)(?:application\/|application)?(?:review|preview|summary)\/?$/i.test(target.pathname)) return null;
    if ([...target.searchParams.keys()].some(key => !/^(?:jobid|job_id|requisitionid|requisition_id|postingid)$/i.test(key))) return null;
    return target.href;
  } catch { return null; }
}

/** A native sign-in action, not an application action wearing a login label. */
export function safeSigninAction(action, pageUrl, sourceProtocol = null) {
  try {
    const url = new URL(action); const source = new URL(pageUrl);
    return url.protocol === 'https:' && url.origin === source.origin && !url.username && !url.password && !url.hash
      && portalDirectory(url) === sourceDirectory(source, sourceProtocol)
      && !/(?:submit|finali[sz]e|withdraw|delete|remove|applicationapply)/i.test(url.pathname)
      && /(?:^|\/)(?:application\/|application)?(?:login|signin|sign-in)\/?$/i.test(url.pathname)
      && [...url.searchParams.keys()].every(key => /^(?:jobid|job_id|requisitionid|requisition_id|postingid)$/i.test(key));
  } catch { return false; }
}

/** Serialized in the browser: a bounded CMP control, never a page-wide cookie state. */
export function isVerificationCookieReject(element, rejectSource) {
  const container = element.closest('#onetrust-banner-sdk, #onetrust-pc-sdk');
  const text = String(element.innerText || element.textContent || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
  return Boolean(container && !['HTML', 'BODY', 'FORM', 'MAIN'].includes(container.tagName)
    && !element.form && !element.closest('form') && /\bcookies?\b/i.test(text)
    && new RegExp(rejectSource, 'i').test(text));
}

/** Accept the owned history link only as an exact read-only route in this portal. */
export function verificationHistoryTarget(value, applyUrl, sourceProtocol = null) {
  try {
    const target = new URL(value); const source = new URL(applyUrl);
    const jobParams = [...target.searchParams.keys()].filter(key => /^(?:jobid|job_id)$/i.test(key));
    if (portalDirectory(target) !== sourceDirectory(source, sourceProtocol)
      || (jobParams.length > 0 && (!portalJobKey(target.href) || portalJobKey(target.href) !== portalJobKey(source.href, sourceProtocol)))) return null;
    if (target.protocol !== 'https:' || target.origin !== source.origin || target.username || target.password || target.hash
      || !/(?:^|\/)(?:(?:my[-_]?)?application(?:s|history)|(?:meine[-_]?)?bewerbungen|(?:(?:mes|le[-_]?mie)[-_]?)?candidatures?)\/?$/i.test(target.pathname)
      || [...target.searchParams.keys()].some(key => !/^(?:page|offset|sort|status|jobid|job_id)$/i.test(key))) return null;
    return target.href;
  } catch { return null; }
}

/** Main-document navigation links are not necessarily styled as form buttons. */
export function applicationHistoryLinksInPage() {
  const named = /^(?:my applications|my application(?:s)? history|meine bewerbungen|le mie candidature|mes candidatures)$/i;
  const links = [...document.querySelectorAll('a[href]')].filter(element => {
    const text = String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
    return named.test(text) && element.getAttribute('aria-disabled') !== 'true' && !element.hasAttribute('disabled')
      && !element.closest('[hidden], [aria-hidden="true"]')
      && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'
      && getComputedStyle(element).display !== 'none';
  }).map(element => ({ text: String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim(), href: element.href }));
  const unique = new Map(links.map(link => [link.href, link]));
  return unique.size > 20 ? [] : [...unique.values()];
}

const MUTATION_QUERY_KEY_RE = /^(?:action|submit|send|withdraw|delete|cancel)$/i;
const MUTATION_PATH_RE = /(?:submit|finali[sz]e|withdraw|delete|remove|cancelapplication|applicationapply)/i;
const RETURN_QUERY_KEY_RE = /^(?:returnurl|redirect|redirecturl|return)$/i;

/**
 * The query a sign-in POST may carry: only a return address, and only one of this origin that names no mutation
 * route. Any other key (or a return address elsewhere) is refused: the POST then does not proceed.
 */
export function signinQueryAllowed(url, origin) {
  for (const [key, value] of url.searchParams.entries()) {
    if (!RETURN_QUERY_KEY_RE.test(key)) return false;
    let target;
    let decoded;
    try { target = new URL(value, origin); decoded = decodeURIComponent(target.pathname); } catch { return false; }
    if (target.origin !== origin || /\\/.test(value) || value.startsWith('//') || MUTATION_PATH_RE.test(decoded)
      || [...target.searchParams.keys()].some(name => MUTATION_QUERY_KEY_RE.test(name))) return false;
  }
  return true;
}

const routeKey = value => { try { const url = new URL(value); return `${url.origin}${url.pathname.replace(/\/$/, '').toLowerCase()}`; } catch { return ''; } };

/**
 * This result is evidence for human review. A review page being accessible does
 * not prove that the earlier application was unsent, and never releases a claim.
 */
export async function verifyPortalApplication({ applyUrl, targetUrl, observedUrls = [], sourceProtocol = null, job, accounts, launch = launchAssistedVerificationBrowser,
  allowCrossOriginNavigation = false, isPublicHost = resolvesToPublicHost, probe = null, aliasEmail = '', allowRecovery = false, recover = recoverAccountPassword }) {
  // `probe` ({origin, vacancyId, entryUrl}): the order's own vacancy entry, signed in with the order's alias
  // account, to see whether the portal answers with its «application exists» page. The fence below is the same;
  // it only also admits Application/New|Login and ApplicationExists of THAT vacancy. No other click than the
  // sign-in and a bounded cookie rejection exists in this function, so nothing here can press a submit control.
  if (probe) {
    if (targetUrl !== probe.entryUrl || !applicationExistsProbeNavigation(targetUrl, probe)) throw new Error('unsafe_verification_target');
  } else if (verificationTarget({ applyUrl, evidence: { finalUrl: targetUrl }, sourceProtocol }) !== targetUrl) throw new Error('unsafe_verification_target');
  const signinOk = (action) => safeSigninAction(action, applyUrl, sourceProtocol)
    || Boolean(probe && applicationExistsProbeNavigation(action, probe) && /\/application\/login\/\d+\/?$/i.test(new URL(action).pathname));
  const browser = await launch({ headless: !headedBrowser() });
  let context;
  let stage = 'launch';
  const proof = { ...(sourceProtocol ? { sourceProtocol } : {}), kind: 'portal_verification', version: 1, observedAt: Date.now(), pages: [], blockedRequests: 0, conclusion: 'unknown', trace: [] };
  // What the inspection saw and refused, without values: host, path and parameter NAMES of every page and of
  // every blocked request, with the reason. Without it a stop with no page recorded cannot be diagnosed.
  const note = (kind, value, reason, extra = {}) => {
    if (proof.trace.length >= 200) return;
    let where;
    try {
      const url = new URL(value);
      where = { host: url.hostname, path: url.pathname.slice(0, 200), params: [...new Set([...url.searchParams.keys()])].slice(0, 12).map(key => key.slice(0, 40)) };
    } catch { where = { path: '(unreadable)' }; }
    proof.trace.push({ kind, ...where, reason, ...extra });
  };
  try {
    context = await browser.newContext({
      serviceWorkers: 'block',
      viewport: isStealthBrowser(browser) ? null : { width: 1366, height: 900 },
      ...(isStealthBrowser(browser) ? {} : { locale: 'en-GB' }),
    });
    // No alternate application transport may bypass the HTTP route fence.
    await context.routeWebSocket('**/*', socket => socket.close());
    await context.addInitScript(() => {
      for (const name of ['WebTransport', 'Worker', 'SharedWorker', 'RTCPeerConnection', 'webkitRTCPeerConnection']) {
        Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false });
      }
    });
    const origin = new URL(applyUrl).origin;
    let loginAction = null;
    let loginArmed = false;
    let loginPosted = false;
    // The one password recovery of the account, when the portal rejects every stored password: only the portal's
    // own /Password/ routes, at most two POSTs (the reset request and the new password).
    let recoveryOpen = false;
    let recoveryPosts = 0;
    const navigationTargets = new Set([targetUrl]);
    for (const value of observedUrls) {
      try {
        const url = new URL(value);
        if (url.origin === origin && portalDirectory(url) === sourceDirectory(new URL(applyUrl), sourceProtocol) && portalJobKey(url.href) === portalJobKey(applyUrl, sourceProtocol) && !url.hash
          && /(?:^|\/)(?:application\/|application)?confirmation\/?$/i.test(url.pathname)
          && [...url.searchParams.keys()].every(key => /^(?:jobid|job_id|requisitionid|requisition_id|postingid)$/i.test(key))) navigationTargets.add(url.href);
      } catch { /* Unknown historical addresses cannot authorize a navigation. */ }
    }
    // Passive GET resources are readable. Mutations are denied, except the
    // single owned sign-in form's request while its sign-in click is armed.
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      // The tenant's static header/footer documents are loaded as sub-frames of the page: same-origin, read-only GETs
      // of the portal's public static folder, never a main-frame navigation.
      const isStaticSubframe = (req, target) => typeof req.frame === 'function' && req.frame() !== page.mainFrame()
        && target.origin === origin && /^\/pubhtml\//i.test(target.pathname);
      const block = (reason) => {
        proof.blockedRequests++;
        note('blocked', request.url(), reason, { method, navigation: request.isNavigationRequest() });
        return route.abort();
      };
      if (allowCrossOriginNavigation) {
        let publicHost = false;
        try { publicHost = await isPublicHost(url.href); } catch { /* Uncertain DNS blocks this replay request. */ }
        if (!publicHost) return block('host_not_public');
      }
      if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        const crossOriginNavigation = request.isNavigationRequest() && url.origin !== origin;
        if (crossOriginNavigation && !allowCrossOriginNavigation) return block('cross_origin_navigation');
        let pathname;
        try { pathname = decodeURIComponent(url.pathname).replace(/\\/g, '/'); }
        catch { return block('undecodable_path'); }
        // Known mutation routes stay forbidden even as XHR/image GETs. Do
        // not let encoding hide one, or confuse save.svg with a Save route.
        if (/%[0-9a-f]{2}/i.test(pathname)) return block('encoded_path');
        if (/(?:submit|finali[sz]e|withdraw|delete|remove|cancelapplication|applicationapply)/i.test(pathname)
          || /(?:^|\/)(?:application)?save(?:\/|$)/i.test(pathname)) return block('mutation_path');
        if ([...url.searchParams.keys()].some(key => /^(?:action|submit|send|withdraw|delete|cancel)$/i.test(key))) return block('mutation_parameter');
        if (request.isNavigationRequest() && !crossOriginNavigation && !navigationTargets.has(url.href)
          && !signinOk(url.href)
          && !(probe && applicationExistsProbeNavigation(url.href, probe))
          && !(probe && isStaticSubframe(request, url))
          && !(recoveryOpen && url.origin === origin && /^\/password\//i.test(url.pathname))
          && !(portalDirectory(url) === sourceDirectory(new URL(applyUrl), sourceProtocol) && /(?:^|\/)(?:home|index)\/?$/i.test(url.pathname) && !url.search)
          && !(!url.search && (url.pathname === '/' || url.pathname === sourceDirectory(new URL(applyUrl), sourceProtocol).replace(/\/$/, '')))) return block('navigation_not_allowed');
        if (request.isNavigationRequest()) note('navigation', request.url(), 'allowed', { method });
        return route.continue();
      }
      // The one POST of the armed sign-in. A probe compares the route without its query (the portal may append a
      // return address); the route must still be the sign-in route of the order's vacancy.
      // A mutation key in the query of any non-read request is refused before anything else.
      if ([...url.searchParams.keys()].some(key => MUTATION_QUERY_KEY_RE.test(key))) return block('mutation_parameter');
      const sameLoginRoute = request.url() === loginAction
        || Boolean(probe && loginAction && `${url.origin}${url.pathname.replace(/\/$/, '').toLowerCase()}` === routeKey(loginAction) && signinOk(request.url())
          && signinQueryAllowed(url, origin));
      if (loginArmed && !loginPosted && method === 'POST' && sameLoginRoute && signinOk(loginAction)) {
        loginPosted = true;
        note('login_post', request.url(), 'allowed', { method });
        return route.continue();
      }
      if (recoveryOpen && recoveryPosts < 2 && method === 'POST' && url.origin === origin && /^\/password\//i.test(url.pathname)) {
        recoveryPosts++;
        note('recovery_post', request.url(), 'allowed', { method });
        return route.continue();
      }
      return block(!loginArmed ? 'mutation_not_armed' : loginPosted ? 'second_mutation' : method !== 'POST' ? 'method_not_allowed' : 'login_route_mismatch');
    });
    stage = 'entry';
    const page = await context.newPage();
    if (typeof page.on === 'function') page.on('framenavigated', frame => { if (frame === page.mainFrame()) note('page', frame.url(), 'navigated'); });
    const stop = (reason, extra = {}) => {
      proof.stopReason = reason;
      note('stop', page.url(), reason, extra);
      return proof;
    };
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    note('page', page.url(), 'loaded');
    let snapshot = await extractFields(page, { listboxOptions: false });
    // A fresh session can put its cookie manager over the login. Only reject
    // optional cookies in a proved cookie container; never press generic OK,
    // Accept, an application consent or an unrelated modal action.
    const cookie = findButton(snapshot.buttons.filter(button => /\bcookies?\b/i.test(button.text || '')), COOKIE_REJECT_RE);
    if (cookie && (cookie.frame || 0) === 0 && await locatorFor(page, cookie).evaluate(isVerificationCookieReject, COOKIE_REJECT_RE.source).catch(() => false) === true) {
      await locatorFor(page, cookie).click({ timeout: 6000 });
      await page.waitForTimeout(800);
      snapshot = await extractFields(page, { listboxOptions: false });
    }
    // The sign-in of this ATS may sit inside the entry page (a block beside the application form) or on its own
    // Login page. A sign-in form is the one of its own «Login» button with exactly one password field.
    const signinFormOf = (view) => {
      const button = findButton(view.buttons, SIGN_IN_RE);
      if (!button || (button.frame || 0) !== 0) return null;
      const fields = button.formId != null ? view.fields.filter(field => String(field.formId) === String(button.formId)) : view.fields;
      return authPageKind({ fields }) === 'sign_in' ? { signin: button, scoped: fields } : null;
    };
    const prepareLoginPage = async () => {
      if (probe && snapshot.passwordVisible && !signinFormOf(snapshot) && probe.loginUrl && new URL(page.url()).pathname !== new URL(probe.loginUrl).pathname) {
        // An entry that shows only a registration form: the vacancy's own sign-in page, one read-only navigation.
        navigationTargets.add(probe.loginUrl);
        await page.goto(probe.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        note('page', page.url(), 'login_page');
        snapshot = await extractFields(page, { listboxOptions: false });
      }
    };
    // One sign-in attempt with one password: null when the portal let the account through, else why not.
    let loadedAccount = null;
    const getAccount = async () => { loadedAccount ??= await accounts.load(new URL(page.url()).hostname); return loadedAccount; };
    const attemptSignin = async (secretOverride = '') => {
      // The trust is in the form's own action below (the vacancy's login route), on any page of the order's vacancy.
      if (!(signinOk(page.url()) || (probe && applicationExistsProbeNavigation(page.url(), probe)))) return { reason: 'login_page_not_trusted' };
      // A sign-in page can carry a registration form next to the sign-in one (two password fields): the sign-in
      // is judged on the form of its own button, never on the page as a whole.
      const signin = findButton(snapshot.buttons, SIGN_IN_RE);
      if (!signin || (signin.frame || 0) !== 0) return { reason: 'signin_button_unresolved' };
      const scoped = signin.formId != null ? snapshot.fields.filter(field => String(field.formId) === String(signin.formId)) : snapshot.fields;
      if (authPageKind({ fields: scoped }) !== 'sign_in') return { reason: 'login_form_not_sign_in', extra: { kind: authPageKind({ fields: scoped }), fields: scoped.length } };
      const { email, password } = loginFields({ fields: scoped });
      if (!email || !password || new Set([email.id, password.id, signin.id]).size !== 3 || (email.frame || 0) !== (signin.frame || 0)
        || (password.frame || 0) !== (signin.frame || 0)) return { reason: 'login_fields_unresolved', extra: { email: Boolean(email), password: Boolean(password) } };
      const owned = await locatorFor(page, signin).evaluate((element, ids) => {
        const form = element.form || element.closest('form');
        return form ? { action: element.hasAttribute('formaction') ? element.formAction : form.action,
          method: element.hasAttribute('formmethod') ? element.formMethod : form.method,
          credentialsOwned: ids.every(id => {
            const nodes = document.querySelectorAll(`[data-aa-id="${id}"]`);
            return nodes.length === 1 && nodes[0].form === form;
          }) } : null;
      }, [email.id, password.id]);
      if (!owned?.credentialsOwned) return { reason: 'login_form_not_owned' };
      if (!signinOk(owned.action)) return { reason: 'login_action_not_trusted', extra: { action: owned.action ? new URL(owned.action, page.url()).pathname.slice(0, 120) : null } };
      if (String(owned.method).toLowerCase() !== 'post') return { reason: 'login_method_not_post', extra: { method: String(owned.method).slice(0, 10) } };
      const account = await getAccount();
      const secret = secretOverride || account?.password;
      if (!account?.email || !secret) return { reason: 'login_account_missing' };
      loginAction = owned.action;
      loginPosted = false;
      navigationTargets.add(loginAction);
      await applyActions(page, [email, password], [{ fieldId: email.id, action: 'fill', value: account.email }, { fieldId: password.id, action: 'fill', value: secret }], {});
      loginArmed = true;
      await locatorFor(page, signin).click({ timeout: 6000 });
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(1500);
      loginArmed = false;
      note('page', page.url(), 'after_login');
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      note('page', page.url(), 'entry_after_login');
      snapshot = await extractFields(page, { listboxOptions: false });
      if (snapshot.captcha) return { reason: 'captcha_after_login' };
      return snapshot.passwordVisible ? { reason: 'login_not_accepted' } : null;
    };
    // The portal rejected every stored password: ONE recovery of the order's alias account with the runner's own
    // flow (reset e-mail read from the alias inbox, new password stored as the runner stores it), under the fence
    // above, then one more sign-in with the new password. Nothing else is opened.
    const recoverAndSignin = async () => {
      stage = 'recovery';
      if (!allowRecovery || !probe?.loginUrl || !aliasEmail) return { reason: 'login_not_accepted', extra: { recovery: 'not_allowed' } };
      navigationTargets.add(probe.loginUrl);
      await page.goto(probe.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      note('page', page.url(), 'recovery_start');
      snapshot = await extractFields(page, { listboxOptions: false });
      const form = signinFormOf(snapshot);
      if (!form) return { reason: 'recovery_no_signin_form' };
      let result = null;
      recoveryOpen = true;
      try {
        result = await recover({
          page, snapshot: { ...snapshot, fields: form.scoped },
          // The store's own answer to the request is the reason a recovery may end without a single click on the
          // portal (rate limit, cooldown, one still running): it goes in the trace.
          ctx: { candidate: { identity: { email: aliasEmail } }, dryRun: false, accounts: { ...accounts,
            // The reset e-mail's link (the portal's own token link, on this host) is the one navigation the run is
            // told to make by the e-mail: it is allowed exactly, once known, and nothing else from the e-mail is.
            waitForPasswordReset: async (...args) => {
              const message = await accounts.waitForPasswordReset(...args);
              try {
                const link = new URL(String(message?.url || ''));
                if (link.protocol === 'https:' && link.origin === new URL(applyUrl).origin && !link.username && !link.password && !link.hash
                  && ![...link.searchParams.keys()].some(key => MUTATION_QUERY_KEY_RE.test(key))) {
                  navigationTargets.add(link.href);
                  note('reset_link', link.href, 'allowed');
                }
              } catch { /* No usable link: the flow decides what to do without it. */ }
              return message;
            },
            beginRecovery: async (...args) => {
            const begun = await accounts.beginRecovery(...args);
            proof.recovery = { ...(proof.recovery || {}), begin: String(begun?.status || '').slice(0, 30), ...(begun?.retryAt ? { retryAt: Number(begun.retryAt) } : {}) };
            note('recovery_begin', page.url(), String(begun?.status || '').slice(0, 30), begun?.retryAt ? { retryAt: Number(begun.retryAt) } : {});
            return begun;
          } } },
          host: new URL(page.url()).hostname, account: await getAccount(), diagnostics: null, typedSecrets: null,
          registrationRestarts: new Map(), recoveryAttempts: new Set(),
          finishRecovery: async view => ({ snapshot: view }),
        });
      } finally { recoveryOpen = false; }
      proof.recovery = { ...(proof.recovery || {}), attempted: true, accepted: result?.accountRecovered === true, ...(result?.accountFailure?.code ? { code: String(result.accountFailure.code).slice(0, 60) } : {}) };
      note('recovery', page.url(), result?.accountRecovered === true ? 'accepted' : 'refused');
      if (result?.accountRecovered !== true) return { reason: 'account_recovery_failed', extra: proof.recovery };
      loadedAccount = null;
      const fresh = await getAccount();
      if (!fresh?.email || !fresh.password) return { reason: 'recovery_password_missing' };
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      snapshot = await extractFields(page, { listboxOptions: false });
      await prepareLoginPage();
      return (await attemptSignin()) || null;
    };
    stage = 'login';
    await prepareLoginPage();
    if (snapshot.passwordVisible) {
      const host = new URL(page.url()).hostname;
      let failure = await attemptSignin();
      let adopted = '';
      if (failure?.reason === 'login_not_accepted') {
        // Every password the store or the alias inbox can still offer, once each (at most three more sign-ins): the
        // one before an unconfirmed recovery, the newest e-mailed by the portal's own reset (it resets the password
        // the moment the request is sent), the last one that made a verified sign-in.
        const stored = loadedAccount || {};
        const emailed = typeof accounts.resetPasswordCandidates === 'function' ? await accounts.resetPasswordCandidates(host, { limit: 2 }).catch(() => []) : [];
        const tried = new Set([stored.password]);
        const candidates = [stored.previousPassword, ...emailed, stored.lastGoodPassword].filter(secret => secret && !tried.has(secret) && tried.add(secret)).slice(0, 3);
        stage = 'candidates';
        note('candidates', page.url(), 'prepared', { count: candidates.length, emailed: emailed.length });
        for (const secret of candidates) {
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          snapshot = await extractFields(page, { listboxOptions: false });
          await prepareLoginPage();
          if (!snapshot.passwordVisible) { failure = null; break; }
          failure = await attemptSignin(secret);
          if (!failure) { adopted = secret; break; }
          if (failure.reason !== 'login_not_accepted') break;
        }
      }
      if (failure?.reason === 'login_not_accepted') failure = await recoverAndSignin();
      if (failure) return stop(failure.reason, failure.extra || {});
      if (adopted && typeof accounts.adoptPassword === 'function') {
        // A password the portal accepted is the account's from now on: nothing is lost again.
        await accounts.adoptPassword(host, adopted).catch(() => {});
        note('account', page.url(), 'password_adopted');
      } else if (adopted && typeof accounts.abortRecovery === 'function') {
        await accounts.abortRecovery(host, { requestSubmitted: true, reason: 'previous_password_valid' }).catch(() => {});
        note('account', page.url(), 'previous_password_restored');
      } else if (proof.recovery?.accepted && typeof accounts.mark === 'function') {
        // Only after a sign-in the portal accepted: the recovered credential is now a verified one.
        await accounts.mark(host, { status: 'created', verifiedAt: Date.now() }).catch(() => {});
      }
    }
    const observe = async () => {
      const current = await extractFields(page, { listboxOptions: false });
      const text = (await page.evaluate(() => document.body?.innerText || '')).slice(0, 60_000);
      const seen = { ...current, text };
      const stage = applicationStage(seen, { applyUrl, sourceProtocol, job, url: page.url() });
      proof.pages.push({ url: page.url(), ...(current.protocol ? { protocol: current.protocol } : {}), text, fields: current.fields.map(field => ({ label: field.label, kind: field.kind, required: field.required })),
        buttons: current.buttons, stage: stage.kind, receipt: applicationReceipt(seen, { applyUrl, sourceProtocol, job, url: page.url() }),
        screenshot: (await page.screenshot({ fullPage: true })).toString('base64') });
      return current;
    };
    stage = 'observe';
    snapshot = await observe();
    note('page', page.url(), 'observed');
    if (probe) {
      // What the portal did with the signed-in account on this vacancy: the live URL is the only evidence kept.
      const route = applicationExistsRoute(page.url());
      proof.applicationExists = route ? { routeKind: route.routeKind, host: route.host, vacancyId: route.vacancyId, pagePath: route.pagePath } : null;
    }
    // An explicitly named application-history link is a read, never Apply or
    // an inferred route. Preserve its exact rows for a job/status review.
    const links = await page.evaluate(applicationHistoryLinksInPage).catch(() => []);
    const histories = [...new Map((Array.isArray(links) ? links : [])
      .map(link => ({ text: link.text, href: verificationHistoryTarget(link.href, applyUrl, sourceProtocol) }))
      .filter(link => link.href).map(link => [link.href, link])).values()];
    if (histories.length === 1) {
      navigationTargets.add(histories[0].href);
      await page.goto(histories[0].href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await observe();
    }
    return proof;
  } catch (error) {
    // The inspection of a probe keeps what it saw up to the failure: its trace, and where and what failed, as
    // identifiers only. The other inspections keep their contract: the error goes to the caller.
    if (!probe) throw error;
    proof.stopReason = 'inspection_exception';
    proof.error = safeErrorInfo(error, stage);
    note('exception', proof.trace.at(-1)?.host ? `https://${proof.trace.at(-1).host}${proof.trace.at(-1).path || '/'}` : applyUrl, 'exception', proof.error);
    return proof;
  } finally {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
