/**
 * Portal runner (fase 3b, wave 1: portals without an account).
 *
 *   open the apply URL → reach the real form (career-ops: the application host
 *   may differ from the posting host) → per page: CAPTCHA / login check,
 *   Codex plan, deterministic fill, next → submit → confirmation.
 *
 * It never bypasses a CAPTCHA or a login (owner decision: career-ops'
 * approach): those end in the candidate handoff. A required answer only the
 * candidate can give ends in `submit_needs_candidate` with the question; the
 * flow asks it on the review page and dispatches the submission again.
 * A click on "submit" whose outcome cannot be confirmed is never retried
 * (career-ops: an ambiguous submit is not re-submitted).
 */

import { extractFields } from './fields.mjs';
import { planPage } from './plan.mjs';
import { CONFIRM_RE, NEXT_RE, SUBMIT_RE, VALIDATION_RE, applyActions, findButton, locatorFor } from './fill.mjs';

export const WAVE1_CHANNELS = new Set([
  'employer_site', 'lever', 'greenhouse', 'smartrecruiters', 'personio', 'softgarden', 'umantis', 'refline', 'jobs_ch',
  // Workday and SuccessFactors tenants that accept a guest application; a
  // tenant that requires an account ends in the 'account' handoff.
  'workday', 'successfactors',
]);
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
  const latest = (profile.experience || [])[0] || {};
  const motivation = Object.fromEntries((draft.formAnswers || []).map((field) => [field.key, field.value]));
  return {
    identity: {
      fullName: identity.name,
      firstName: parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0] || '',
      lastName: parts.length > 1 ? parts[parts.length - 1] : '',
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
 * @param {boolean} [ctx.dryRun] fill every page but never press submit
 * @param {Function} [ctx.onBeforeSubmit] called right before the final submit click (submission guard)
 * @returns {Promise<{event:object, evidence:object}>}
 */
export async function submitViaPortal(ctx) {
  const launch = ctx.launch || (async () => (await import('playwright')).chromium.launch({ headless: true }));
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
    const uploaded = new Set();

    for (let step = 1; step <= maxSteps; step += 1) {
      evidence.steps.push({ step, url: page.url(), fields: snapshot.fields.length, errors: snapshot.errors || [] });
      log(`portal step ${step}: ${snapshot.fields.length} fields`);
      if (snapshot.captcha) return await handoff('captcha');
      if (snapshot.passwordVisible) return await handoff('account');
      if (!hasApplicationForm(snapshot) && !findButton(snapshot.buttons, SUBMIT_RE) && !findButton(snapshot.buttons, NEXT_RE)) {
        return await handoff('portal_needs_candidate');
      }

      const plan = await planPage({ snapshot, candidate: ctx.candidate, candidateLocale: ctx.candidateLocale, codex: ctx.codex });
      if (plan.missingRequired.length) {
        const questions = [];
        for (const item of plan.missingRequired) {
          const id = `portal_${slugId(item.question)}`;
          if (questions.some((question) => question.id === id)) continue; // Greenhouse repeats a question in two controls
          questions.push({ id, question: item.question, why: item.why || '', type: item.type, options: item.options || [], required: true, source: 'portal' });
        }
        return { event: { type: 'submit_needs_candidate', questions }, evidence };
      }
      // A file already uploaded on this page is not uploaded again when the
      // page is planned a second time (Personio empties the input after the upload).
      const uploadKey = (fieldId) => `${page.url()}|${snapshot.fields.find((field) => field.id === fieldId)?.label || fieldId}`;
      const actions = plan.actions.filter((action) => action.action !== 'upload' || !uploaded.has(uploadKey(action.fieldId)));
      const results = await applyActions(page, snapshot.fields, actions, ctx.files);
      for (const result of results) {
        if (result.ok && actions.some((action) => action.fieldId === result.fieldId && action.action === 'upload')) uploaded.add(uploadKey(result.fieldId));
      }
      evidence.steps.at(-1).actions = actions.map(({ fieldId, action, source, document }) => ({ fieldId, action, source, document }));
      evidence.steps.at(-1).failures = results.filter((result) => !result.ok);

      let after = await extractFields(page, NAVIGATION);
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
