/** Protected inspection: existing-account sign-in, GET reads, no application actions. */
import { launchChromium } from '../../../lib/ensure-chromium.mjs';
import { extractFields } from './fields.mjs';
import { SIGN_IN_RE, authPageKind, loginFields } from './account.mjs';
import { applyActions, findButton, locatorFor } from './fill.mjs';
import { applicationReceipt, applicationStage, portalJobKey } from './stages.mjs';

export function verificationTarget({ applyUrl, evidence }) {
  try {
    const source = new URL(applyUrl);
    const target = new URL(evidence?.finalUrl);
    if (source.protocol !== 'https:' || target.origin !== source.origin || !portalJobKey(applyUrl)
      || portalJobKey(target.href) !== portalJobKey(applyUrl) || target.hash
      || !/(?:^|\/)(?:application)?(?:review|preview|summary)\/?$/i.test(target.pathname)) return null;
    if ([...target.searchParams.keys()].some(key => !/^(?:jobid|job_id|requisitionid|requisition_id|postingid)$/i.test(key))) return null;
    return target.href;
  } catch { return null; }
}

/** A native sign-in action, not an application action wearing a login label. */
export function safeSigninAction(action, pageUrl) {
  try {
    const url = new URL(action); const source = new URL(pageUrl);
    return url.protocol === 'https:' && url.origin === source.origin && !url.hash
      && /(?:^|\/)(?:application)?(?:login|signin|sign-in)\/?$/i.test(url.pathname)
      && [...url.searchParams.keys()].every(key => /^(?:jobid|job_id|requisitionid|requisition_id|postingid)$/i.test(key));
  } catch { return false; }
}

/**
 * This result is evidence for human review. A review page being accessible does
 * not prove that the earlier application was unsent, and never releases a claim.
 */
export async function verifyPortalApplication({ applyUrl, targetUrl, observedUrls = [], job, accounts, launch = launchChromium }) {
  if (verificationTarget({ applyUrl, evidence: { finalUrl: targetUrl } }) !== targetUrl) throw new Error('unsafe_verification_target');
  const browser = await launch({ headless: true });
  let context;
  const proof = { kind: 'portal_verification', version: 1, observedAt: Date.now(), pages: [], blockedRequests: 0, conclusion: 'unknown' };
  try {
    context = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'en-GB' });
    const origin = new URL(applyUrl).origin;
    let loginAction = null;
    let loginArmed = false;
    let loginPosted = false;
    const navigationTargets = new Set([targetUrl]);
    for (const value of observedUrls) {
      try {
        const url = new URL(value);
        if (url.origin === origin && portalJobKey(url.href) === portalJobKey(applyUrl) && !url.hash
          && /(?:^|\/)(?:application)?confirmation\/?$/i.test(url.pathname)
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
        if (/(?:submit|finali[sz]e|withdraw|delete|remove|cancelapplication|applicationapply)/i.test(url.pathname) || [...url.searchParams.keys()].some(key => /^(?:action|submit|send|withdraw|delete|cancel)$/i.test(key))) { proof.blockedRequests++; return route.abort(); }
        if (request.isNavigationRequest() && !navigationTargets.has(url.href)
          && !/(?:^|\/)(?:application)?(?:login|signin|sign-in|home|index)(?:\/|$)/i.test(url.pathname)
          && !(!url.search && (url.pathname === '/' || url.pathname === `/${new URL(applyUrl).pathname.split('/').filter(Boolean)[0]}`))) { proof.blockedRequests++; return route.abort(); }
        return route.continue();
      }
      if (loginArmed && !loginPosted && method === 'POST' && request.url() === loginAction && safeSigninAction(loginAction, applyUrl)) {
        loginPosted = true;
        return route.continue();
      }
      proof.blockedRequests++;
      return route.abort();
    });
    const page = await context.newPage();
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    let snapshot = await extractFields(page, { listboxOptions: false });
    if (snapshot.passwordVisible) {
      if (new URL(page.url()).origin !== origin || authPageKind(snapshot) !== 'sign_in') return proof;
      const account = await accounts.load(new URL(page.url()).hostname);
      const { email, password } = loginFields(snapshot);
      const signin = findButton(snapshot.buttons, SIGN_IN_RE);
      if (!account?.email || !account.password || !email || !password || !signin) return proof;
      const owned = await locatorFor(page, signin).evaluate((element, ids) => {
        const form = element.form || element.closest('form');
        return form ? { action: element.hasAttribute('formaction') ? element.formAction : form.action,
          method: element.hasAttribute('formmethod') ? element.formMethod : form.method,
          credentialsOwned: ids.every(id => document.querySelector(`[data-aa-id="${id}"]`)?.form === form) } : null;
      }, [email.id, password.id]);
      if (!owned?.credentialsOwned || !safeSigninAction(owned.action, page.url()) || String(owned.method).toLowerCase() !== 'post') return proof;
      loginAction = owned.action;
      navigationTargets.add(loginAction);
      await applyActions(page, snapshot.fields, [{ fieldId: email.id, action: 'fill', value: account.email }, { fieldId: password.id, action: 'fill', value: account.password }], {});
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
      const stage = applicationStage(seen, { applyUrl, job, url: page.url() });
      proof.pages.push({ url: page.url(), text, fields: current.fields.map(field => ({ label: field.label, kind: field.kind, required: field.required })),
        buttons: current.buttons, stage: stage.kind, receipt: applicationReceipt(seen, { applyUrl, job, url: page.url() }),
        screenshot: (await page.screenshot({ fullPage: true })).toString('base64') });
      return current;
    };
    snapshot = await observe();
    // An explicitly named application-history link is a read, never Apply or
    // an inferred route. Preserve its exact rows for a job/status review.
    const histories = snapshot.buttons.filter(button => !button.disabled && !button.chrome
      && /^(?:my applications|my application(?:s)? history|meine bewerbungen|le mie candidature|mes candidatures)$/i.test(button.text || '')
      && button.href && new URL(button.href).origin === origin && !new URL(button.href).hash
      && /(?:application(?:s|history)|bewerbungen|candidatur)/i.test(new URL(button.href).pathname)
      && [...new URL(button.href).searchParams.keys()].every(key => /^(?:page|offset|sort|status|jobid|job_id)$/i.test(key)));
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
