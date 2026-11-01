/** Protected inspection: existing-account sign-in, GET reads, no application actions. */
import { launchChromium } from '../../../lib/ensure-chromium.mjs';
import { COOKIE_REJECT_RE, headedBrowser, realisticUserAgent } from './portal.mjs';
import { extractFields } from './fields.mjs';
import { SIGN_IN_RE, authPageKind, loginFields } from './account.mjs';
import { applyActions, findButton, locatorFor } from './fill.mjs';
import { applicationReceipt, applicationStage, portalJobKey } from './stages.mjs';
import { avaturePortalDirectory } from './protocol.mjs';

const portalDirectory = url => url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
// /job?jobId=42 does not attest a sibling /application/ namespace. Only
// primary protocol metadata can lift a JobDetail/slug directory to its
// portal namespace; suffix regexes must never relax this boundary.
const sourceDirectory = (url, protocol) => avaturePortalDirectory(url.href, protocol) || portalDirectory(url);

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

/**
 * This result is evidence for human review. A review page being accessible does
 * not prove that the earlier application was unsent, and never releases a claim.
 */
export async function verifyPortalApplication({ applyUrl, targetUrl, observedUrls = [], sourceProtocol = null, job, accounts, launch = launchChromium }) {
  if (verificationTarget({ applyUrl, evidence: { finalUrl: targetUrl }, sourceProtocol }) !== targetUrl) throw new Error('unsafe_verification_target');
  const browser = await launch({ headless: !headedBrowser() });
  let context;
  const proof = { ...(sourceProtocol ? { sourceProtocol } : {}), kind: 'portal_verification', version: 1, observedAt: Date.now(), pages: [], blockedRequests: 0, conclusion: 'unknown' };
  try {
    context = await browser.newContext({ serviceWorkers: 'block', userAgent: realisticUserAgent(typeof browser.version === 'function' ? browser.version() : ''), viewport: { width: 1366, height: 900 }, locale: 'en-GB' });
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
      if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        if (request.isNavigationRequest() && url.origin !== origin) { proof.blockedRequests++; return route.abort(); }
        let pathname;
        try { pathname = decodeURIComponent(url.pathname).replace(/\\/g, '/'); }
        catch { proof.blockedRequests++; return route.abort(); }
        // Known mutation routes stay forbidden even as XHR/image GETs. Do
        // not let encoding hide one, or confuse save.svg with a Save route.
        if (/%[0-9a-f]{2}/i.test(pathname)
          || /(?:submit|finali[sz]e|withdraw|delete|remove|cancelapplication|applicationapply)/i.test(pathname)
          || /(?:^|\/)(?:application)?save(?:\/|$)/i.test(pathname)
          || [...url.searchParams.keys()].some(key => /^(?:action|submit|send|withdraw|delete|cancel)$/i.test(key))) { proof.blockedRequests++; return route.abort(); }
        if (request.isNavigationRequest() && !navigationTargets.has(url.href)
          && !safeSigninAction(url.href, applyUrl, sourceProtocol)
          && !(portalDirectory(url) === sourceDirectory(new URL(applyUrl), sourceProtocol) && /(?:^|\/)(?:home|index)\/?$/i.test(url.pathname) && !url.search)
          && !(!url.search && (url.pathname === '/' || url.pathname === sourceDirectory(new URL(applyUrl), sourceProtocol).replace(/\/$/, '')))) { proof.blockedRequests++; return route.abort(); }
        return route.continue();
      }
      if (loginArmed && !loginPosted && method === 'POST' && request.url() === loginAction && safeSigninAction(loginAction, applyUrl, sourceProtocol)) {
        loginPosted = true;
        return route.continue();
      }
      proof.blockedRequests++;
      return route.abort();
    });
    const page = await context.newPage();
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
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
    if (snapshot.passwordVisible) {
      if (!safeSigninAction(page.url(), applyUrl, sourceProtocol) || authPageKind(snapshot) !== 'sign_in') return proof;
      const { email, password } = loginFields(snapshot);
      const signin = findButton(snapshot.buttons, SIGN_IN_RE);
      if (!email || !password || !signin || new Set([email.id, password.id, signin.id]).size !== 3 || (signin.frame || 0) !== 0 || (email.frame || 0) !== (signin.frame || 0)
        || (password.frame || 0) !== (signin.frame || 0)) return proof;
      const owned = await locatorFor(page, signin).evaluate((element, ids) => {
        const form = element.form || element.closest('form');
        return form ? { action: element.hasAttribute('formaction') ? element.formAction : form.action,
          method: element.hasAttribute('formmethod') ? element.formMethod : form.method,
          credentialsOwned: ids.every(id => {
            const nodes = document.querySelectorAll(`[data-aa-id="${id}"]`);
            return nodes.length === 1 && nodes[0].form === form;
          }) } : null;
      }, [email.id, password.id]);
      if (!owned?.credentialsOwned || !safeSigninAction(owned.action, applyUrl, sourceProtocol) || String(owned.method).toLowerCase() !== 'post') return proof;
      const account = await accounts.load(new URL(page.url()).hostname);
      if (!account?.email || !account.password) return proof;
      loginAction = owned.action;
      navigationTargets.add(loginAction);
      await applyActions(page, [email, password], [{ fieldId: email.id, action: 'fill', value: account.email }, { fieldId: password.id, action: 'fill', value: account.password }], {});
      loginArmed = true;
      await locatorFor(page, signin).click({ timeout: 6000 });
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(1500);
      loginArmed = false;
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      snapshot = await extractFields(page, { listboxOptions: false });
      if (snapshot.passwordVisible || snapshot.captcha) return proof;
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
    snapshot = await observe();
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
  } finally {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
