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
]);
const INTL = { it: 'it-CH', de: 'de-CH', fr: 'fr-CH', en: 'en-GB' };
// Anywhere in the label: Personio says "Auf diese Stelle bewerben".
const APPLY_RE = /(\bapply\b|bewerben\b|bewerbung starten|zur bewerbung|\bcandidati\b|\bcandidarsi\b|invia (la tua )?candidatura|\bpostuler\b|\bpostulez\b|je postule)/i;
const OUTCOME_TIMEOUT_MS = 25_000;

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
      linkedin: profile.linkedin || '',
      website: profile.website || '',
    },
    profile: {
      headline: profile.headline || '',
      currentOrLatestRole: [latest.role, latest.employer].filter(Boolean).join(' — '),
      languages: profile.languages || [],
      education: (profile.education || []).slice(0, 2),
      workPermit: profile.workPermit || '',
      availability: profile.availability || '',
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

async function settle(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
}

async function clickButton(page, button) {
  const frame = page.frames()[button.frame || 0] || page.mainFrame();
  await frame.locator(`[data-aa-id="${button.id}"]`).first().click({ timeout: 10_000 });
}

/** A posting page with an "Apply" button: follow it, in the same tab or a new one. */
async function openApplicationForm(context, page, snapshot) {
  if (hasApplicationForm(snapshot)) return { page, snapshot };
  const apply = findButton(snapshot.buttons, APPLY_RE);
  const link = apply ? null : await page.getByRole('link', { name: APPLY_RE }).first().elementHandle().catch(() => null);
  if (!apply && !link) return { page, snapshot };
  const popup = context.waitForEvent('page', { timeout: 6000 }).catch(() => null);
  if (apply) await clickButton(page, apply);
  else await link.click();
  const next = (await popup) || page;
  await settle(next);
  return { page: next, snapshot: await extractFields(next) };
}

async function waitForOutcome(page) {
  const deadline = Date.now() + OUTCOME_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (CONFIRM_RE.test(text) || /thank|confirm|success|danke|grazie|merci/i.test(page.url())) return 'confirmed';
    const snapshot = await extractFields(page).catch(() => null);
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
 * @returns {Promise<{event:object, evidence:object}>}
 */
export async function submitViaPortal(ctx) {
  const launch = ctx.launch || (async () => (await import('playwright')).chromium.launch({ headless: true }));
  const log = ctx.log || (() => {});
  const maxSteps = ctx.maxSteps || 8;
  const evidence = { steps: [], applyUrl: ctx.applyUrl };
  const browser = await launch();
  const handoff = (reason) => ({ event: { type: 'submit_handoff', reason }, evidence });
  try {
    const context = await browser.newContext({
      locale: INTL[ctx.language] || 'de-CH',
      timezoneId: 'Europe/Zurich',
      viewport: { width: 1366, height: 900 },
      acceptDownloads: false,
    });
    let page = await context.newPage();
    await page.goto(ctx.applyUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await settle(page);
    let snapshot = await extractFields(page);
    ({ page, snapshot } = await openApplicationForm(context, page, snapshot));
    let validationRetries = 0;

    for (let step = 1; step <= maxSteps; step += 1) {
      evidence.steps.push({ step, url: page.url(), fields: snapshot.fields.length });
      log(`portal step ${step}: ${snapshot.fields.length} fields`);
      if (snapshot.captcha) return handoff('captcha');
      if (snapshot.passwordVisible && !hasApplicationForm(snapshot)) return handoff('account');
      if (!hasApplicationForm(snapshot) && !findButton(snapshot.buttons, SUBMIT_RE) && !findButton(snapshot.buttons, NEXT_RE)) {
        return handoff('portal_needs_candidate');
      }

      const plan = await planPage({ snapshot, candidate: ctx.candidate, candidateLocale: ctx.candidateLocale, codex: ctx.codex });
      if (plan.missingRequired.length) {
        const questions = plan.missingRequired.map((item) => ({
          id: `portal_${slugId(item.question)}`,
          question: item.question,
          why: item.why || '',
          type: item.type,
          options: item.options || [],
          required: true,
          source: 'portal',
        }));
        return { event: { type: 'submit_needs_candidate', questions }, evidence };
      }
      const results = await applyActions(page, snapshot.fields, plan.actions, ctx.files);
      evidence.steps.at(-1).actions = plan.actions.map(({ fieldId, action, source, document }) => ({ fieldId, action, source, document }));
      evidence.steps.at(-1).failures = results.filter((result) => !result.ok);

      const after = await extractFields(page);
      if (after.captcha) return handoff('captcha');
      const submit = findButton(after.buttons, SUBMIT_RE);
      const next = findButton(after.buttons, NEXT_RE);
      if (next && !submit) {
        await clickButton(page, next);
        await settle(page);
        snapshot = await extractFields(page);
        continue;
      }
      if (!submit) return handoff('portal_needs_candidate');
      if (ctx.dryRun) {
        evidence.dryRunScreenshot = (await page.screenshot({ fullPage: true })).toString('base64');
        return { event: { type: 'dry_run_ready' }, evidence };
      }
      evidence.beforeSubmit = (await page.screenshot({ fullPage: true })).toString('base64');
      await clickButton(page, submit);
      const outcome = await waitForOutcome(page);
      evidence.afterSubmit = (await page.screenshot({ fullPage: true }).catch(() => Buffer.from(''))).toString('base64');
      evidence.finalUrl = page.url();
      log(`portal outcome: ${outcome}`);
      if (outcome === 'confirmed') return { event: { type: 'submit_succeeded', channel: 'portal' }, evidence };
      if (outcome === 'captcha') return handoff('captcha');
      if (outcome === 'validation' && validationRetries < 1) {
        validationRetries += 1;
        snapshot = await extractFields(page);
        continue;
      }
      // career-ops: an ambiguous submit is never re-submitted automatically.
      return { event: { type: 'submit_failed', error: outcome === 'validation' ? 'portal_validation' : 'portal_ambiguous' }, evidence };
    }
    return handoff('portal_needs_candidate');
  } finally {
    await browser.close().catch(() => {});
  }
}

export { locatorFor };
