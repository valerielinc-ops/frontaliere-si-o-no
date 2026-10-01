/**
 * Portal runner (fase 3b: portals without an account; fase 3c: accounts).
 *
 *   open the apply URL → reach the real form (career-ops: the application host
 *   may differ from the posting host) → per page: CAPTCHA / login check,
 *   Codex plan, deterministic fill, next → submit → confirmation.
 *
 * It never bypasses a CAPTCHA (owner decision: career-ops' approach): that
 * ends in the candidate handoff. A login page is handled by account.mjs: an
 * account on the order's alias, created by the runner and verified through
 * the order's inbox. A required answer only the candidate can give ends in
 * `submit_needs_candidate` with the question; the flow asks it on the review
 * page and dispatches the submission again.
 * A click on "submit" whose outcome cannot be confirmed is never retried
 * (career-ops: an ambiguous submit is not re-submitted).
 */

import { CREATE_ACCOUNT_RE, SIGN_IN_RE, VERIFY_PAGE_RE, authPageKind, codeField, loginFields, newPortalPassword, registrationOutcome, verificationOutcome } from './account.mjs';
import { extractFields } from './fields.mjs';
import { planPage } from './plan.mjs';
import { sanitizeValidation } from '../../../../functions/src/lib/answerRules.js';
import { CONFIRM_RE, NEXT_RE, SUBMIT_RE, VALIDATION_RE, applyActions, findButton, locatorFor } from './fill.mjs';
import { launchChromium } from '../../../lib/ensure-chromium.mjs';

export const WAVE1_CHANNELS = new Set([
  'employer_site', 'lever', 'greenhouse', 'smartrecruiters', 'personio', 'softgarden', 'umantis', 'refline', 'jobs_ch',
  // Workday and SuccessFactors: a guest application where the tenant allows
  // it, otherwise an account on the order's alias (account.mjs).
  'workday', 'successfactors',
]);
// Login pages in one run: create, verify, sign in, and one retry.
const MAX_AUTH_STEPS = 5;
const INTL = { it: 'it-CH', de: 'de-CH', fr: 'fr-CH', en: 'en-GB' };
// Anywhere in the label: Personio says "Auf diese Stelle bewerben".
const APPLY_RE = /(\bapply\b|bewerben\b|bewerbung starten|zur bewerbung|\bcandidati\b|\bcandidarsi\b|invia (la tua )?candidatura|\bpostuler\b|\bpostulez\b|je postule)/i;
const OUTCOME_TIMEOUT_MS = 25_000;
// Scans that only look for buttons, a CAPTCHA or a login never open listboxes (see extractFields).
const NAVIGATION = { listboxOptions: false };

export function slugId(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'question';
}

/** What the planner may use, with the alias as the e-mail (candidateIdentity). */
export function candidateForForm({ identity, profile = {}, answers = {}, draft = {}, portalQuestions = [] }) {
  const parts = String(identity.name || '').trim().split(/\s+/);
  // The split the candidate chose on the review page, else the last word is the surname.
  const chosen = typeof identity.firstName === 'string';
  const latest = (profile.experience || [])[0] || {};
  const motivation = Object.fromEntries((draft.formAnswers || []).map((field) => [field.key, field.value]));
  return {
    identity: {
      fullName: identity.name,
      firstName: chosen ? identity.firstName : parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0] || '',
      lastName: chosen ? identity.lastName : parts.length > 1 ? parts[parts.length - 1] : '',
      email: identity.email,
      phone: identity.phone,
      location: profile.location || '',
      address: profile.address || { street: '', postalCode: '', city: '', country: '' },
      linkedin: profile.linkedin || '',
      website: profile.website || '',
    },
    profile: {
      headline: profile.headline || '',
      currentOrLatestRole: [latest.role, latest.employer].filter(Boolean).join(' — '),
      employers: [...new Set((profile.experience || []).map((item) => item.employer).filter(Boolean))].slice(0, 15),
      languages: profile.languages || [],
      education: (profile.education || []).slice(0, 2),
      workPermit: profile.workPermit || '',
      availability: profile.availability || '',
      dateOfBirth: profile.dateOfBirth || '',
      nationality: profile.nationality || '',
    },
    answers,
    portalQuestionsAnswered: portalQuestions.filter((question) => String(answers[question.id] ?? '').trim())
      .map((question) => ({ question: question.question, answer: answers[question.id] })),
    texts: {
      motivationShort: motivation.motivationShort || '',
      whyCompany: motivation.whyCompany || '',
      coverLetter: draft.coverLetter?.text || '',
    },
    documents: { cv: true, cover_letter: true },
  };
}

function hasApplicationForm(snapshot) {
  const kinds = snapshot.fields.map((field) => field.kind);
  const textish = snapshot.fields.filter((field) => field.kind === 'text' || field.kind === 'textarea').length;
  const email = snapshot.fields.some((field) => field.inputType === 'email' || /e-?mail/i.test(field.label));
  return kinds.includes('file') || (textish >= 3 && email);
}

/** A page is the same page when the URL and the field labels are (Workday's steps share one URL). */
function pageSignature(page, snapshot) {
  return `${page.url()}|${snapshot.fields.map((field) => field.label).join('|')}`;
}

async function settle(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
}

async function clickButton(page, button) {
  const frame = page.frames()[button.frame || 0] || page.mainFrame();
  try {
    await frame.locator(`[data-aa-id="${button.id}"]`).first().click({ timeout: 6_000 });
  } catch (error) {
    // Workday animates its apply modal and re-renders the links, dropping our
    // data-aa-id: the same control is found again by its visible text.
    if (!button.text) throw error;
    try {
      await frame.getByText(button.text, { exact: true }).first().click({ timeout: 6_000 });
    } catch (textError) {
      // A link that never settles is followed by its address.
      if (!button.href) throw textError;
      await page.goto(button.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    }
  }
}

// Cookie banners: refuse the non-essential cookies when the banner offers it,
// otherwise accept (the runner's own browser session, no candidate data).
const COOKIE_REJECT_RE = /^(ablehnen|alle ablehnen|nur (notwendige|erforderliche)( cookies)?|reject( all)?|decline( all)?|only necessary|rifiuta( tutti| tutto)?|solo necessari|refuser( tout)?|tout refuser|continuer sans accepter)$/i;
const COOKIE_ACCEPT_RE = /^(cookies akzeptieren|alle akzeptieren|akzeptieren|accept( all)?( cookies)?|accetta( tutti)?|tout accepter|accepter|ok)$/i;
// Workday offers autofill, "use my last application" or a manual application: manual is the predictable one.
const MANUAL_APPLY_RE = /^(manuell bewerben|apply manually|candidarsi manualmente|candidatura manuale|postuler manuellement)$/i;

export async function dismissCookieBanner(page, snapshot) {
  const button = findButton(snapshot.buttons, COOKIE_REJECT_RE) || findButton(snapshot.buttons, COOKIE_ACCEPT_RE);
  if (!button) return false;
  await clickButton(page, button).catch(() => {});
  await page.waitForTimeout(800);
  return true;
}

/**
 * From the posting to the form, up to three hops (Workday: "Bewerben", then
 * "Manuell bewerben"; a cookie banner can come back on each page). A new tab
 * opened by the apply button is followed.
 */
async function openApplicationForm(context, page, snapshot) {
  for (let hop = 0; hop < 3; hop += 1) {
    if (await dismissCookieBanner(page, snapshot)) snapshot = await extractFields(page, NAVIGATION);
    if (hasApplicationForm(snapshot)) return { page, snapshot };
    const manual = findButton(snapshot.buttons, MANUAL_APPLY_RE);
    const apply = manual ? null : findButton(snapshot.buttons, APPLY_RE);
    const link = manual || apply ? null : await page.getByRole('link', { name: APPLY_RE }).first().elementHandle().catch(() => null);
    if (!manual && !apply && !link) return { page, snapshot };
    const popup = context.waitForEvent('page', { timeout: 6000 }).catch(() => null);
    if (manual || apply) await clickButton(page, manual || apply);
    else await link.click();
    page = (await popup) || page;
    await settle(page);
    await page.waitForTimeout(1200); // a modal (Workday's apply dialog) finishes its animation
    snapshot = await extractFields(page, NAVIGATION);
  }
  return { page, snapshot };
}

/** Questions for the candidate from a plan's missing required fields (ids are stable slugs). */
function questionsFrom(missingRequired) {
  const questions = [];
  for (const item of missingRequired) {
    const id = `portal_${slugId(item.question)}`;
    if (questions.some((question) => question.id === id)) continue; // Greenhouse repeats a question in two controls
    questions.push({ id, question: item.question, why: item.why || '', type: item.type, options: item.options || [], required: true, validation: sanitizeValidation(item.validation, { type: item.type }), source: 'portal' });
  }
  return questions;
}

async function clickFirst(page, snapshot, patterns) {
  for (const pattern of patterns) {
    const button = findButton(snapshot.buttons, pattern);
    if (button) {
      await clickButton(page, button);
      return true;
    }
    const link = await page.getByRole('link', { name: pattern }).first().elementHandle().catch(() => null);
    if (link) {
      await link.click();
      return true;
    }
  }
  return false;
}

/** The verification e-mail's link (on the portal's own site) or code, read from the order's inbox. */
async function verifyAccount({ page, host, sinceMs, ctx, snapshot }) {
  const verification = await ctx.accounts.waitForVerification({ host, sinceMs });
  if (!verification) return { handoff: 'account_verification_timeout' };
  if (verification.url) {
    await page.goto(verification.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await settle(page);
  } else {
    const current = snapshot || await extractFields(page);
    const field = codeField(current);
    if (!field) return { handoff: 'account' };
    await applyActions(page, current.fields, [{ fieldId: field.id, action: 'fill', value: verification.code }], {});
    if (!await clickFirst(page, current, [SUBMIT_RE, NEXT_RE, /^(verify|verifizieren|bestätigen|verifica|conferma|vérifier|confirmer)$/i])) return { handoff: 'account' };
    await settle(page);
  }
  const after = await extractFields(page);
  // Verified only when the portal says so: an expired or refused token never
  // marks the account verified for the next runs.
  const outcome = verificationOutcome(after);
  if (outcome !== 'accepted') return { handoff: `account_verification_${outcome}` };
  await ctx.accounts.mark(host, { verifiedAt: Date.now() });
  return { snapshot: after, reopen: true };
}

/**
 * One login page (account.mjs): sign in with the order's account, or create
 * it on the alias, or verify it. Returns the next page, a handoff reason,
 * questions for the candidate, or `dryRun` (a dry run never creates an account).
 */
async function handleAuth({ page, snapshot, ctx }) {
  const host = new URL(page.url()).hostname;
  const kind = authPageKind(snapshot);
  const account = await ctx.accounts.load(host);

  if (kind === 'sign_in' && !account) {
    if (!await clickFirst(page, snapshot, [CREATE_ACCOUNT_RE])) return { handoff: 'account' };
    await settle(page);
    return { snapshot: await extractFields(page) };
  }

  if (kind === 'sign_in') {
    const { email, password } = loginFields(snapshot);
    if (!email || !password) return { handoff: 'account' };
    await applyActions(page, snapshot.fields, [
      { fieldId: email.id, action: 'fill', value: account.email },
      { fieldId: password.id, action: 'fill', value: account.password },
    ], {});
    if (!await clickFirst(page, snapshot, [SIGN_IN_RE, SUBMIT_RE, NEXT_RE])) return { handoff: 'account' };
    await settle(page);
    const after = await extractFields(page);
    if (!account.verifiedAt && (VERIFY_PAGE_RE.test(after.text) || codeField(after))) {
      return verifyAccount({ page, host, sinceMs: account.createdAt || 0, ctx, snapshot: after });
    }
    if (authPageKind(after) === 'sign_in') return { handoff: 'account_sign_in_failed' };
    await ctx.accounts.mark(host, { lastSignInAt: Date.now() });
    return { snapshot: after, reopen: true };
  }

  // Create-account page.
  if (account) {
    // Created by an earlier run: sign in instead.
    if (!await clickFirst(page, snapshot, [SIGN_IN_RE])) return { handoff: 'account' };
    await settle(page);
    return { snapshot: await extractFields(page) };
  }
  if (ctx.dryRun) return { dryRun: true };
  const others = { ...snapshot, fields: snapshot.fields.filter((field) => field.inputType !== 'password') };
  const plan = await planPage({ snapshot: others, candidate: ctx.candidate, candidateLocale: ctx.candidateLocale, codex: ctx.codex });
  if (plan.missingRequired.length) return { questions: questionsFrom(plan.missingRequired) };
  const password = newPortalPassword();
  // Stored (encrypted) before the click: a run that dies afterwards still knows it.
  await ctx.accounts.save(host, { email: ctx.candidate.identity.email, password });
  const sinceMs = Date.now();
  const passwordActions = snapshot.fields.filter((field) => field.inputType === 'password')
    .map((field) => ({ fieldId: field.id, action: 'fill', value: password }));
  await applyActions(page, snapshot.fields, [...plan.actions, ...passwordActions], ctx.files);
  const filled = await extractFields(page, NAVIGATION);
  if (!await clickFirst(page, filled, [CREATE_ACCOUNT_RE, SUBMIT_RE, NEXT_RE])) {
    await ctx.accounts.discard(host, 'no_create_button');
    return { handoff: 'account' };
  }
  await settle(page);
  const after = await extractFields(page);
  const outcome = registrationOutcome(after);
  if (outcome === 'refused') {
    // No account exists: the next run creates it again instead of signing in.
    await ctx.accounts.discard(host, 'registration_refused');
    return { handoff: 'account_create_refused' };
  }
  await ctx.accounts.mark(host, { status: 'created' });
  if (outcome === 'verify') return verifyAccount({ page, host, sinceMs, ctx, snapshot: after });
  return { snapshot: after, reopen: !after.passwordVisible };
}

async function waitForOutcome(page) {
  const deadline = Date.now() + OUTCOME_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (CONFIRM_RE.test(text) || /thank|confirm|success|danke|grazie|merci/i.test(page.url())) return 'confirmed';
    const snapshot = await extractFields(page, NAVIGATION).catch(() => null);
    if (snapshot?.captcha) return 'captcha';
    if (Date.now() > deadline - OUTCOME_TIMEOUT_MS + 4000 && VALIDATION_RE.test(text)) return 'validation';
  }
  return 'ambiguous';
}

/**
 * @param {object} ctx
 * @param {string} ctx.applyUrl
 * @param {string} ctx.language posting language (browser locale)
 * @param {string} ctx.candidateLocale language of the questions to the candidate
 * @param {object} ctx.candidate candidateForForm(...)
 * @param {{cv:string, cover_letter:string}} ctx.files local file paths
 * @param {Function} ctx.codex broker call
 * @param {Function} [ctx.launch] browser launcher (tests)
 * @param {boolean} [ctx.dryRun] fill every page but never press submit (nor create an account)
 * @param {Function} [ctx.onBeforeSubmit] called right before the final submit click (submission guard)
 * @param {ReturnType<import('./account.mjs').portalAccountStore>} [ctx.accounts] the order's portal accounts; without it a login page is handed over
 * @returns {Promise<{event:object, evidence:object}>}
 */
export async function submitViaPortal(ctx) {
  const launch = ctx.launch || (() => launchChromium({ headless: true }));
  const log = ctx.log || (() => {});
  const maxSteps = ctx.maxSteps || 8;
  const evidence = { steps: [], applyUrl: ctx.applyUrl };
  const browser = await launch();
  let page = null;
  // Where the runner stopped, for whoever takes over (encrypted with the rest of the evidence).
  const handoff = async (reason) => {
    if (page) evidence.handoffScreenshot = (await page.screenshot({ fullPage: true }).catch(() => Buffer.from(''))).toString('base64');
    return { event: { type: 'submit_handoff', reason }, evidence };
  };
  try {
    const context = await browser.newContext({
      locale: INTL[ctx.language] || 'de-CH',
      timezoneId: 'Europe/Zurich',
      viewport: { width: 1366, height: 900 },
      acceptDownloads: false,
    });
    page = await context.newPage();
    await page.goto(ctx.applyUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await settle(page);
    let snapshot = await extractFields(page, NAVIGATION);
    ({ page, snapshot } = await openApplicationForm(context, page, snapshot));
    if (snapshot.fields.some((field) => field.kind === 'listbox')) snapshot = await extractFields(page);
    let validationRetries = 0;
    let stuckOnPage = 0;
    let authSteps = 0;
    const uploaded = new Set();

    for (let step = 1; step <= maxSteps; step += 1) {
      evidence.steps.push({ step, url: page.url(), fields: snapshot.fields.length, errors: snapshot.errors || [] });
      log(`portal step ${step}: ${snapshot.fields.length} fields`);
      if (snapshot.captcha) return await handoff('captcha');
      if (snapshot.passwordVisible) {
        if (!ctx.accounts || ++authSteps > MAX_AUTH_STEPS) return await handoff('account');
        const auth = await handleAuth({ page, snapshot, ctx });
        evidence.steps.at(-1).auth = { kind: authPageKind(snapshot), outcome: auth.handoff || (auth.questions ? 'questions' : auth.dryRun ? 'dry_run' : 'ok') };
        if (auth.handoff) return await handoff(auth.handoff);
        if (auth.questions) return { event: { type: 'submit_needs_candidate', questions: auth.questions }, evidence };
        if (auth.dryRun) {
          evidence.dryRunScreenshot = (await page.screenshot({ fullPage: true })).toString('base64');
          return { event: { type: 'dry_run_ready', stage: 'account' }, evidence };
        }
        snapshot = auth.snapshot;
        // After a sign-in or a verification link the portal may land on its
        // home page: back to the posting and its form.
        if (auth.reopen && !hasApplicationForm(snapshot) && !findButton(snapshot.buttons, NEXT_RE) && !findButton(snapshot.buttons, SUBMIT_RE)) {
          await page.goto(ctx.applyUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          await settle(page);
          ({ page, snapshot } = await openApplicationForm(context, page, await extractFields(page, NAVIGATION)));
          snapshot = await extractFields(page);
        }
        step -= 1; // a login page is not a form page
        continue;
      }
      if (!hasApplicationForm(snapshot) && !findButton(snapshot.buttons, SUBMIT_RE) && !findButton(snapshot.buttons, NEXT_RE)) {
        return await handoff('portal_needs_candidate');
      }

      const plan = await planPage({ snapshot, candidate: ctx.candidate, candidateLocale: ctx.candidateLocale, codex: ctx.codex });
      if (plan.missingRequired.length) {
        return { event: { type: 'submit_needs_candidate', questions: questionsFrom(plan.missingRequired) }, evidence };
      }
      // A file already uploaded on this page is not uploaded again when the
      // page is planned a second time (Personio empties the input after the upload).
      const uploadKey = (fieldId) => `${page.url()}|${snapshot.fields.find((field) => field.id === fieldId)?.label || fieldId}`;
      const actions = plan.actions.filter((action) => action.action !== 'upload' || !uploaded.has(uploadKey(action.fieldId)));
      const plannedUrl = page.url();
      const results = await applyActions(page, snapshot.fields, actions, ctx.files);
      for (const result of results) {
        if (result.ok && actions.some((action) => action.fieldId === result.fieldId && action.action === 'upload')) uploaded.add(uploadKey(result.fieldId));
      }
      evidence.steps.at(-1).actions = actions.map(({ fieldId, action, source, document }) => ({ fieldId, action, source, document }));
      evidence.steps.at(-1).failures = results.filter((result) => !result.ok);

      let after = await extractFields(page, NAVIGATION);
      // The portal moved to another page by itself (JOIN registers the e-mail
      // and shows the CV page a moment later): plan that page, instead of
      // judging it by the buttons of the one just filled. Giro di prova 2026-10-01.
      if (page.url() !== plannedUrl) {
        snapshot = await extractFields(page);
        continue;
      }
      // No usable button yet: a form re-rendering after a choice (Workday
      // redraws the address for another country) or an uploaded CV still being
      // processed (Workday parses it). Up to 6 s, or 60 s after an upload.
      const buttonWaitMs = actions.some((action) => action.action === 'upload') ? 60_000 : 6_000;
      for (let waited = 0; waited < buttonWaitMs && !findButton(after.buttons, SUBMIT_RE) && !findButton(after.buttons, NEXT_RE); waited += 2000) {
        await page.waitForTimeout(2000);
        after = await extractFields(page, NAVIGATION);
      }
      if (after.captcha) return await handoff('captcha');
      const submit = findButton(after.buttons, SUBMIT_RE);
      const next = findButton(after.buttons, NEXT_RE);
      if (next && !submit) {
        const before = pageSignature(page, after);
        await clickButton(page, next);
        await settle(page);
        snapshot = await extractFields(page);
        // A single-page form moves on after its own request (JOIN checks the
        // e-mail first): up to 10 s for the next page before calling it stuck.
        for (let waited = 0; waited < 10_000 && pageSignature(page, snapshot) === before; waited += 2000) {
          await page.waitForTimeout(2000);
          snapshot = await extractFields(page);
        }
        // Still the same page: the form refused a value. Two corrections, then the owner.
        stuckOnPage = pageSignature(page, snapshot) === before ? stuckOnPage + 1 : 0;
        if (stuckOnPage > 2) return await handoff('portal_needs_candidate');
        continue;
      }
      if (!submit) {
        if (findButton(after.buttons, SUBMIT_RE, { includeDisabled: true }) && validationRetries < 1) {
          validationRetries += 1;
          snapshot = await extractFields(page);
          continue;
        }
        return await handoff('portal_needs_candidate');
      }
      if (ctx.dryRun) {
        evidence.dryRunScreenshot = (await page.screenshot({ fullPage: true })).toString('base64');
        return { event: { type: 'dry_run_ready' }, evidence };
      }
      evidence.beforeSubmit = (await page.screenshot({ fullPage: true })).toString('base64');
      // From here the outcome may be unknown: the submission guard records the click.
      if (ctx.onBeforeSubmit) await ctx.onBeforeSubmit();
      await clickButton(page, submit);
      const outcome = await waitForOutcome(page);
      evidence.afterSubmit = (await page.screenshot({ fullPage: true }).catch(() => Buffer.from(''))).toString('base64');
      evidence.finalUrl = page.url();
      log(`portal outcome: ${outcome}`);
      if (outcome === 'confirmed') return { event: { type: 'submit_succeeded', channel: 'portal' }, evidence };
      if (outcome === 'captcha') return await handoff('captcha');
      if (outcome === 'validation' && validationRetries < 1) {
        validationRetries += 1;
        snapshot = await extractFields(page);
        continue;
      }
      // career-ops: an ambiguous submit is never re-submitted automatically.
      return { event: { type: 'submit_failed', error: outcome === 'validation' ? 'portal_validation' : 'portal_ambiguous' }, evidence };
    }
    return await handoff('portal_needs_candidate');
  } finally {
    await browser.close().catch(() => {});
  }
}

export { locatorFor };
