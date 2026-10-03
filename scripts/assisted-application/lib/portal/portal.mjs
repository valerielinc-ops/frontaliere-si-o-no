/**
 * Portal runner (fase 3b: portals without an account; fase 3c: accounts).
 *
 *   open the apply URL → reach the real form (career-ops: the application host
 *   may differ from the posting host) → per page: CAPTCHA / login check,
 *   Codex plan, deterministic fill, next → submit → confirmation.
 *
 * NopeCHA solves supported CAPTCHAs in the runner's browser (owner request
 * 2026-10-01); an unresolved challenge still ends in a handoff.
 * A login page is handled by account.mjs: an
 * account on the order's alias, created by the runner and verified through
 * the order's inbox. A required answer only the candidate can give ends in
 * `submit_needs_candidate` with the question; the flow asks it on the review
 * page and dispatches the submission again.
 * A click on "submit" whose outcome cannot be confirmed is never retried
 * (career-ops: an ambiguous submit is not re-submitted).
 * A page the deterministic filler cannot move on (a calendar, option cards,
 * a custom dropdown, fields with generated names) goes to the agentic
 * fallback (agent.mjs): Codex on Playwright's accessibility snapshot, as
 * career-ops drives Playwright MCP. Next and the final submit stay here.
 */

import { AGENT_ROUNDS, advanceLocator, completeWithAgent, submitLocator } from './agent.mjs';
import { CREATE_ACCOUNT_RE, SIGN_IN_RE, VERIFY_PAGE_RE, authPageKind, codeField, loginFields, newPortalPassword, registrationOutcome, verificationOutcome } from './account.mjs';
import { extractFields } from './fields.mjs';
import { startPortalDiagnostics } from './diagnostics.mjs';
import { NO_PORTAL_KNOWLEDGE, labelsAt, learnedButton } from './knowledge.mjs';
import { holdsValue, planPage } from './plan.mjs';
import { sanitizeValidation } from '../../../../functions/src/lib/answerRules.js';
import { CONFIRM_RE, NEXT_RE, REFUSED_RE, SUBMIT_RE, VALIDATION_RE, applyActions, findButton, locatorFor } from './fill.mjs';
import { launchChromium } from '../../../lib/ensure-chromium.mjs';
import { awaitCaptcha, CAPTCHA_TIMEOUT_MS, launchNopechaContext } from './nopecha.mjs';
import { classifyLiveness, isHardClosed } from '../liveness.mjs';

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
export const APPLY_RE = /(\bapply\b|bewerben\b|bewerbung starten|zur bewerbung|\bcandidati\b|\bcandidarsi\b|invia (la tua )?candidatura|\bpostuler\b|\bpostulez\b|je postule)/i;
// «Später bewerben» on Prospective.ch's career pages (Coop, 2026-10-02) keeps
// the posting for later by e-mail: never the way into the form.
export const APPLY_LATER_RE = /(später|spaeter|\blater\b|più tardi|piu tardi|plus tard|merken)/i;
const startsApplication = (text) => APPLY_RE.test(text) && !APPLY_LATER_RE.test(text);
const OUTCOME_TIMEOUT_MS = 25_000;
// Scans that only look for buttons, a CAPTCHA or a login never open listboxes (see extractFields).
const NAVIGATION = { listboxOptions: false };
// Codex turns of the agentic fallback in one run (each page has AGENT_ROUNDS at most).
const MAX_AGENT_CALLS = 16;

/**
 * The browser's own user agent without "Headless", on the machine's real
 * system: some ATS turn away a browser that calls itself HeadlessChrome
 * (owner decision 2026-10-01). Same Chrome version, nothing else disguised.
 */
export function realisticUserAgent(version, platform = process.platform) {
  const system = platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
  const major = /^\d+/.exec(String(version || ''))?.[0] || '140';
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

// Path segments that name the employer or the posting, not the portal's page.
const NAMED_SEGMENT_AFTER = /^(companies|company|jobs|job|careers|career|positions|position|stellen|stelle|offerte|offres|vacancies|postings|o|j)$/i;

/**
 * The page's address with the employer and the posting left out, for a public
 * fix issue (self-correction, level 3): "join.com/companies/acme/16772222/apply/review"
 * → "/companies/*\/*\/apply/review". Ids, long slugs and the segment after
 * "companies", "jobs"… become "*"; the query and the hash go.
 */
export function anonymizePath(url) {
  let path = '';
  try {
    path = new URL(url).pathname;
  } catch {
    return '';
  }
  const segments = path.split('/').filter(Boolean);
  return `/${segments.map((segment, index) => {
    const named = index > 0 && NAMED_SEGMENT_AFTER.test(segments[index - 1]) && segments[index - 1].length > 1;
    return named || /\d/.test(segment) || segment.length > 24 ? '*' : segment;
  }).join('/')}`;
}

/**
 * Where and why the runner stopped, as a fixer needs it and nothing more
 * (self-correction, level 3): the portal's host, the anonymized page, the
 * buttons, the fields' labels and kinds, the form's messages. Never a value:
 * agent.mjs also strikes every value of the candidate out before it leaves.
 */
export function stopReportFrom({ url, reason, step, seen, agent = [] }) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    host = '';
  }
  return {
    host,
    path: anonymizePath(url),
    reason,
    step,
    buttons: [...new Set((seen?.buttons || []).map((button) => String(button.text || '').trim()).filter(Boolean))].slice(0, 30),
    fields: (seen?.fields || []).slice(0, 30).map((field) => ({ label: String(field.label || '').slice(0, 120), kind: field.kind, required: Boolean(field.required) })),
    errors: (seen?.errors || []).slice(0, 8),
    agent: agent.map((item) => ({ hint: item.hint, status: item.status })),
  };
}

/** The workflow runs the browser headed on a virtual screen (xvfb-run) when it can. */
export const headedBrowser = () => process.env.ASSISTED_APPLICATION_HEADED === '1';

/** A label that is a generated name, not a question ("select-input-_r_p_", "file:_r_3_:input"). */
export function machineLabel(label) {
  const text = String(label || '').trim();
  return !text || (/^[\w:.-]+$/.test(text) && /[_:\d]/.test(text));
}

export function slugId(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'question';
}

/** What the planner may use, with the alias as the e-mail (candidateIdentity). */
export function candidateForForm({ identity, profile = {}, answers = {}, draft = {}, portalQuestions = [], extraDocuments = [] }) {
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
      // Workday's, SuccessFactors' and umantis' "My Experience" steps: the work
      // history as the CV states it, instead of questions to the candidate.
      experience: (profile.experience || []).slice(0, 8)
        .map(({ role = '', employer = '', location = '', start = '', end = '' }) => ({ role, employer, location, start, end })),
      languages: profile.languages || [],
      education: (profile.education || []).slice(0, 4)
        .map(({ degree = '', institution = '', start = '', end = '' }) => ({ degree, institution, start, end })),
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
    // The requested documents the candidate gave (assistedApplicationExtraDocuments.js), by form slot.
    documents: { cv: true, cover_letter: true, extra: extraDocuments.map(({ slot, label, kind }) => ({ slot, label, kind })) },
  };
}

/** How an upload reads in the evidence: [CV], [lettera di presentazione], [documento: Bulletins scolaires]. */
function uploadLabel(document, candidate) {
  if (document === 'cover_letter') return '[lettera di presentazione]';
  const extra = (candidate?.documents?.extra || []).find((item) => item.slot === document);
  return extra ? `[documento: ${extra.label}]` : '[CV]';
}

function hasApplicationForm(snapshot) {
  const kinds = snapshot.fields.map((field) => field.kind);
  const textish = snapshot.fields.filter((field) => field.kind === 'text' || field.kind === 'textarea').length;
  const email = snapshot.fields.some((field) => field.inputType === 'email' || /e-?mail/i.test(field.label));
  return kinds.includes('file') || (textish >= 3 && email);
}

/**
 * A page that has just changed may still be drawing its form (JOIN's steps
 * render a moment after the address changes, dry_run 36817633054 read none):
 * up to 10 s for its fields, and while `unchanged` says it is the old page.
 */
async function awaitFields(page, snapshot, unchanged = () => false) {
  let current = snapshot;
  for (let waited = 0; waited < 10_000 && (unchanged(current) || !current.fields.length); waited += 2000) {
    await page.waitForTimeout(2000);
    current = await extractFields(page);
  }
  return current;
}

/** A page is the same page when the URL and the field labels are (Workday's steps share one URL). */
function pageSignature(page, snapshot) {
  return `${page.url()}|${snapshot.fields.map((field) => field.label).join('|')}`;
}

/** The page's visible text, frames included (Greenhouse embeds its form). */
async function pageText(page) {
  const texts = await Promise.all(page.frames().slice(0, 5).map((frame) => frame.evaluate(() => document.body?.innerText || '').catch(() => '')));
  return texts.join('\n').slice(0, 60_000);
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
export const COOKIE_REJECT_RE = /^(ablehnen|alle ablehnen|nur (notwendige|erforderliche)( cookies)?|reject( all)?|decline( all)?|only necessary|rifiuta( tutti| tutto)?|solo necessari|refuser( tout)?|tout refuser|continuer sans accepter)$/i;
const COOKIE_ACCEPT_RE = /^(cookies akzeptieren|alle akzeptieren|akzeptieren|accept( all)?( cookies)?|accetta( tutti)?|tout accepter|accepter|ok)$/i;
// Workday offers autofill, "use my last application" or a manual application: manual is the predictable one.
const MANUAL_APPLY_RE = /^(manuell bewerben|apply manually|candidarsi manualmente|candidatura manuale|postuler manuellement)$/i;

export async function dismissCookieBanner(page, snapshot) {
  const button = findButton(snapshot.buttons, COOKIE_REJECT_RE) || findButton(snapshot.buttons, COOKIE_ACCEPT_RE);
  if (button) {
    await clickButton(page, button).catch(() => {});
    await page.waitForTimeout(800);
    return true;
  }
  // A banner inside a shadow root (Usercentrics on Coop's career pages,
  // 2026-10-02) is out of the page scan's reach while its overlay takes every
  // click. Only a shadow root's own buttons: marked in the page, clicked by a
  // CSS locator (it pierces open shadow roots).
  if (!await markShadowCookieButton(page)) return false;
  await page.locator('[data-aa-cookie="1"]').first().click({ timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(800);
  return true;
}

async function markShadowCookieButton(page) {
  return page.evaluate(([reject, accept]) => {
    const roots = [document];
    const shadows = [];
    for (let index = 0; index < roots.length && index < 50; index += 1) {
      for (const element of roots[index].querySelectorAll('*')) {
        if (!element.shadowRoot) continue;
        roots.push(element.shadowRoot);
        shadows.push(element.shadowRoot);
      }
    }
    for (const source of [reject, accept]) {
      const pattern = new RegExp(source, 'i');
      for (const shadow of shadows) {
        const button = [...shadow.querySelectorAll('button, [role="button"]')]
          .find((element) => element.getBoundingClientRect().width > 0 && pattern.test(String(element.innerText || element.textContent || '').trim()));
        if (button) {
          button.setAttribute('data-aa-cookie', '1');
          return true;
        }
      }
    }
    return false;
  }, [COOKIE_REJECT_RE.source, COOKIE_ACCEPT_RE.source]).catch(() => false);
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
    const apply = manual ? null : snapshot.buttons.find((button) => !button.disabled && startsApplication(button.text)) || null;
    const link = manual || apply ? null : await page.getByRole('link', { name: APPLY_RE }).filter({ hasNotText: APPLY_LATER_RE }).first().elementHandle().catch(() => null);
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

const normalizeWords = (text) => String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ');
// Legal forms and short words name no company: "Ospedale ABC SA" is "ospedale abc",
// "Coop Genossenschaft" is "coop" (its SuccessFactors pages say only "Coop").
const NOT_A_NAME = new Set(['sa', 'ag', 'gmbh', 'sagl', 'srl', 'spa', 'sarl', 'ltd', 'inc', 'llc', 'kg', 'genossenschaft', 'cooperativa', 'cooperative', 'the', 'und', 'and', 'del', 'della', 'des', 'les', 'der', 'die', 'das']);
const nameWords = (text) => normalizeWords(text).split(' ').filter((word) => word.length >= 3 && !NOT_A_NAME.has(word) && !/^\d+$/.test(word));

/**
 * Is this form the posting's (career-ops apply.md: company and role on the
 * form match the posting, or stop)? The company's WHOLE name as whole words
 * ("Muster Elektro AG" is not "Altra GmbH — Elektroinstallateur", review of
 * #10715); never its initials ("ME" is in "Tell me more"): a portal that shows
 * only "EOC" goes to Valerie, whose retry goes on. Only when the order names
 * no company, the title: every word, or a gender variant of it
 * ("Infermiere/a" = "Infermiera": same word but the last two letters).
 * 'unknown' when the order names neither.
 */
export function postingMatch(pageText, job = {}) {
  const words = normalizeWords(pageText).split(' ').filter(Boolean);
  const company = nameWords(job.company);
  const title = nameWords(job.title).filter((word) => word.length >= 4);
  if (!company.length && !title.length) return 'unknown';
  if (company.length) {
    // The page's words filtered as the name is ("Ospedale Regionale di Lugano" = "ospedale regionale lugano").
    const named = ` ${nameWords(pageText).join(' ')} `;
    return named.includes(` ${company.join(' ')} `) ? 'match' : 'mismatch';
  }
  const variant = (word) => words.some((seen) => seen === word
    || (word.length >= 6 && Math.abs(seen.length - word.length) <= 2 && seen.slice(0, word.length - 2) === word.slice(0, word.length - 2)));
  return title.every(variant) ? 'match' : 'mismatch';
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

// SuccessFactors' required privacy statement (Coop, 2026-10-02) starts as a
// link, only once the country is chosen. Its dialog can require a separate
// “I have reviewed…” checkbox before «Akzeptieren» becomes enabled. This is
// the application's own required consent (plan.mjs), never a newsletter or a
// job alert.
export const PRIVACY_STATEMENT_RE = /(lesen und akzeptieren|leggere e accettare|lire et accepter|read and accept)/i;
export const PRIVACY_REVIEW_RE = /(dpcs|data[\s_-]*privacy.*(?:review|read|accept)|privacy.*(?:review|read|accept)|datenschutz.*(?:gelesen|akzept|zustimm)|(?:ich habe|i have|j['’]ai|ho)\s+.*(?:gelesen|reviewed|read|lu|letto)|(?:presa|preso|prise|pris)\s+visione|consent.*(?:review|read|accept|gelesen|lu|letto))/i;
export const PRIVACY_ACCEPT_RE = /^(akzeptieren|ich akzeptiere|accept|i accept|agree|zustimmen|accetta|accetto|accettare|accepter|j['’]accepte)(?:\s+(?:und|and|et|e)\s+.*)?\W*$/i;

function dialogKey(control) {
  if (control?.dialogId) return String(control.dialogId);
  // Accept snapshots made before dialogId was added can still be inspected,
  // but a boolean cannot identify one dialog among several.
  return typeof control?.dialog === 'string' ? control.dialog : '';
}

function isDialogControl(control) {
  return control?.dialog === true || Boolean(dialogKey(control));
}

function dialogToken(control) {
  const key = dialogKey(control);
  return key ? `${control.frame || 0}:${key}` : '';
}

function visibleDialogTokens(snapshot = {}) {
  const controls = [
    ...(Array.isArray(snapshot.fields) ? snapshot.fields : []),
    ...(Array.isArray(snapshot.buttons) ? snapshot.buttons : []),
  ];
  return new Set(controls.map(dialogToken).filter(Boolean));
}

function candidateScore(candidate) {
  // A disabled accept button is the DPCS state before its required review
  // checkbox is selected. Prefer it when this function receives a standalone
  // snapshot without the before/after dialog context used by the caller.
  if (candidate.accept?.disabled) return 3;
  if (candidate.accept) return 2;
  return candidate.review ? 1 : 0;
}

export function privacyConsentControls(snapshot = {}, { allowedDialogTokens = null, preferredDialogToken = '' } = {}) {
  const fields = Array.isArray(snapshot.fields) ? snapshot.fields : [];
  const buttons = Array.isArray(snapshot.buttons) ? snapshot.buttons : [];
  const allowed = allowedDialogTokens === null ? null : new Set(allowedDialogTokens);
  const inScope = (control) => {
    const token = dialogToken(control);
    return token && (!allowed || allowed.has(token));
  };
  // The page can retain another modal with an enabled "Accept" control next
  // to the DPCS dialog. Keep candidate lookups in one dialog and frame. The
  // live flow passes the token of the dialog that appeared after the trigger;
  // the disabled-button preference keeps direct snapshot inspection safe too.
  const dialogFields = fields.filter((field) => isDialogControl(field) && inScope(field));
  const dialogButtons = buttons.filter((button) => isDialogControl(button) && inScope(button));
  const reviewFields = dialogFields.filter((field) => field.kind === 'checkbox'
    && PRIVACY_REVIEW_RE.test(`${field.label || ''} ${field.name || ''} ${field.autocomplete || ''}`));
  const candidateTokens = new Set([
    ...reviewFields.map(dialogToken),
    ...dialogButtons.map(dialogToken),
  ].filter(Boolean));
  const candidates = [...candidateTokens].map((token) => {
    const review = reviewFields.find((field) => dialogToken(field) === token) || null;
    const buttonsInDialog = dialogButtons.filter((button) => dialogToken(button) === token);
    return { token, review, accept: findButton(buttonsInDialog, PRIVACY_ACCEPT_RE, { includeDisabled: true }) };
  });
  const preferred = preferredDialogToken
    ? candidates.find((candidate) => candidate.token === preferredDialogToken) || null
    : null;
  const candidate = preferred || candidates
    .slice()
    .sort((left, right) => candidateScore(right) - candidateScore(left))[0] || null;
  const review = candidate?.review || null;
  return {
    trigger: findButton(buttons, PRIVACY_STATEMENT_RE),
    review,
    // A disabled accept button is useful evidence while the required review
    // box is being checked; the caller still waits for it to become enabled.
    accept: candidate?.accept || null,
    dialogToken: candidate?.token || '',
  };
}

async function scrollPrivacyStatement(page) {
  await Promise.all(page.frames().map((frame) => frame.evaluate(() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')];
    for (const dialog of dialogs) {
      for (const element of [dialog, ...dialog.querySelectorAll('*')]) {
        if (element.scrollHeight > element.clientHeight + 4) element.scrollTop = element.scrollHeight;
      }
    }
  }).catch(() => {})));
}

/** @returns {Promise<'none'|'accepted'|'unavailable'>} */
export async function acceptPrivacyStatement(page, snapshot) {
  if (!privacyConsentControls(snapshot).trigger) return 'none';
  // The last field filled (the password repeat) checks itself on blur:
  // SuccessFactors asks its password policy and a click on the statement's
  // link meanwhile is lost. Blur first, wait for that request, then open the
  // dialog; retry once if the portal redraws the form during the first click.
  await page.evaluate(() => document.activeElement?.blur?.()).catch(() => {});
  await settle(page);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const deadline = Date.now() + 8_000;
    const currentSnapshot = await extractFields(page, NAVIGATION).catch(() => snapshot);
    const trigger = privacyConsentControls(currentSnapshot).trigger;
    if (!trigger) break;
    const beforeDialogTokens = visibleDialogTokens(currentSnapshot);
    let openedDialogToken = '';
    const controlsForOpenedDialog = (current) => {
      const currentDialogTokens = visibleDialogTokens(current);
      const newlyOpened = [...currentDialogTokens].filter((token) => !beforeDialogTokens.has(token));
      let controls = privacyConsentControls(current, {
        allowedDialogTokens: openedDialogToken ? [openedDialogToken] : newlyOpened,
        preferredDialogToken: openedDialogToken,
      });
      // A portal may replace the dialog node after its checkbox changes. If
      // that gives it a new snapshot token, keep the replacement in scope but
      // never fall back to an older unrelated modal.
      if (!controls.dialogToken && openedDialogToken && newlyOpened.length) {
        controls = privacyConsentControls(current, { allowedDialogTokens: newlyOpened });
      }
      if (controls.dialogToken) openedDialogToken = controls.dialogToken;
      return controls;
    };
    await clickButton(page, trigger).catch(() => {});
    await scrollPrivacyStatement(page);
    while (Date.now() <= deadline) {
      const current = await extractFields(page, NAVIGATION).catch(() => null);
      if (current) {
        const controls = controlsForOpenedDialog(current);
        if (controls.review && !controls.review.checked) {
          await applyActions(page, current.fields, [{ fieldId: controls.review.id, action: 'check' }], {}, { pause: async () => {} });
          await scrollPrivacyStatement(page);
        }
        const refreshed = await extractFields(page, NAVIGATION).catch(() => null);
        const accept = controlsForOpenedDialog(refreshed || {}).accept;
        if (accept && !accept.disabled) {
          try {
            await clickButton(page, accept);
            await page.waitForTimeout(800);
            return 'accepted';
          } catch {
            // A portal can replace the dialog button after the review checkbox;
            // rescan and retry within the bounded window.
          }
        }
      }
      if (Date.now() >= deadline) break;
      await page.waitForTimeout(200);
    }
    await settle(page);
  }
  return 'unavailable';
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
  const password = newPortalPassword({ portal: host });
  // Stored (encrypted) before the click: a run that dies afterwards still knows it.
  await ctx.accounts.save(host, { email: ctx.candidate.identity.email, password });
  const sinceMs = Date.now();
  const passwordActions = snapshot.fields.filter((field) => field.inputType === 'password')
    .map((field) => ({ fieldId: field.id, action: 'fill', value: password }));
  await applyActions(page, snapshot.fields, [...plan.actions, ...passwordActions], ctx.files);
  // After the fields: SuccessFactors opens its statement only for a chosen country.
  const privacy = await acceptPrivacyStatement(page, await extractFields(page, NAVIGATION));
  const noted = (result) => (privacy === 'none' ? result : { ...result, privacy });
  const filled = await extractFields(page, NAVIGATION);
  if (!await clickFirst(page, filled, [CREATE_ACCOUNT_RE, SUBMIT_RE, NEXT_RE])) {
    await ctx.accounts.discard(host, 'no_create_button');
    return noted({ handoff: 'account' });
  }
  await settle(page);
  const after = await extractFields(page);
  const outcome = registrationOutcome(after);
  if (outcome === 'refused') {
    // No account exists: the next run creates it again instead of signing in.
    await ctx.accounts.discard(host, 'registration_refused');
    return noted({ handoff: 'account_create_refused' });
  }
  await ctx.accounts.mark(host, { status: 'created' });
  if (outcome === 'verify') return noted(await verifyAccount({ page, host, sinceMs, ctx, snapshot: after }));
  return noted({ snapshot: after, reopen: !after.passwordVisible });
}

/**
 * A required field of the page is still empty. A file input's value is never
 * read by the snapshot (`holdsValue` counts it empty), so its own `files` say
 * whether the CV went in; an upload widget that clears its input reads as empty.
 */
async function requiredLeftEmpty(page) {
  for (const field of (await extractFields(page, NAVIGATION)).fields) {
    if (!field.required) continue;
    const filled = field.kind === 'file'
      ? await locatorFor(page, field).evaluate((element) => (element.files?.length || 0) > 0, null, { timeout: 2000 }).catch(() => false)
      : holdsValue(field);
    if (!filled) return true;
  }
  return false;
}

/**
 * The page's send and step buttons: a usual name, or one a confirmed
 * submission on this portal taught (level 2) on this same page (review of
 * #10741: a label is a control of the page it was learned on, not of every
 * page of the host). A taught send button never counts next to a step button.
 */
export function pageControls(buttons, known, url) {
  const here = anonymizePath(url);
  const submit = findButton(buttons, SUBMIT_RE);
  const usualNext = findButton(buttons, NEXT_RE);
  const taughtNext = submit || usualNext ? null : learnedButton(buttons, labelsAt(known.nextButtons, here));
  return {
    submit: submit || (usualNext || taughtNext ? null : learnedButton(buttons, labelsAt(known.finalButtons, here))),
    next: usualNext || taughtNext,
  };
}

/**
 * After the final click: the same send button is still on the page, and the
 * portal loads an invisible reCAPTCHA (v3 badge or `api.js?render=`), the
 * kind that scores the browser and lets the portal drop a bot's submission
 * without a word.
 */
async function refusedSilently(page, label) {
  return (await sendButtonStill(page, label)) && invisibleRecaptcha(page);
}

/** After the final click the same send button is still on the page: nothing moved on. */
async function sendButtonStill(page, label) {
  const after = await extractFields(page, NAVIGATION).catch(() => null);
  return Boolean(after && learnedButton(after.buttons, [label]));
}

/** The page scores its visitors with an invisible reCAPTCHA (v3 badge or `api.js?render=`). */
function invisibleRecaptcha(page) {
  return page.evaluate(() => Boolean(document.querySelector('.grecaptcha-badge'))
    || [...document.scripts].some((script) => /recaptcha\/(api|enterprise)\.js\?[^#]*render=/.test(script.src)))
    .catch(() => false);
}

// An address that says the application went through; a review step
// ("review-and-confirm") is not one.
const DONE_URL_RE = /(thank|danke|grazie|merci|success|confirmation|submitted|received|complete)/i;
const REVIEW_URL_RE = /(review|preview|summary|riepilogo|zusammenfassung|überprüf|ueberpruef|vérif|verif|resume|récap)/i;

/** The address alone confirms only once the page holds no send button any more. */
export function urlConfirms(url, snapshot) {
  return DONE_URL_RE.test(url) && !REVIEW_URL_RE.test(url) && Boolean(snapshot) && !findButton(snapshot.buttons || [], SUBMIT_RE, { includeDisabled: true });
}

async function waitForOutcome(page, captchaEnabled = false) {
  const started = Date.now();
  const deadline = started + OUTCOME_TIMEOUT_MS + (captchaEnabled ? CAPTCHA_TIMEOUT_MS : 0);
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (CONFIRM_RE.test(text)) return 'confirmed';
    // The portal says it did not send: nothing left, by its own word.
    if (REFUSED_RE.test(text)) return 'refused';
    let snapshot = await extractFields(page, NAVIGATION).catch(() => null);
    if (snapshot?.captcha && captchaEnabled) {
      snapshot = await awaitCaptcha(page, snapshot, { enabled: true, timeoutMs: Math.max(0, deadline - Date.now()) });
      // Solving may have submitted the original request: observe its outcome,
      // never press the final button a second time.
      if (!snapshot.captcha) continue;
    }
    if (urlConfirms(page.url(), snapshot)) return 'confirmed';
    if (snapshot?.captcha) return 'captcha';
    if (Date.now() > started + 4000 && VALIDATION_RE.test(text)) return 'validation';
  }
  return 'ambiguous';
}

// Single-page forms only: reading them sends nothing. JOIN registers the
// e-mail on its first step, Workday and SuccessFactors start with an account.
export const PREREAD_CHANNELS = new Set(['greenhouse', 'lever', 'smartrecruiters', 'personio', 'softgarden']);

/**
 * The questions a portal will ask, read while drafting (career-ops apply.md:
 * identify ALL the questions before answering), so the candidate answers them
 * on the first review instead of in a second round at submit time. The form
 * is opened and read, never filled, and nothing is pressed but "apply".
 * Never fails the draft: any problem returns no questions.
 * @returns {Promise<Array<object>>} questions for the review page (source 'portal')
 */
export async function readPortalQuestions(ctx) {
  if (!PREREAD_CHANNELS.has(ctx.channelType) || !ctx.applyUrl || !ctx.codex) return [];
  const launch = ctx.launch || (() => launchChromium({ headless: !headedBrowser() }));
  let browser = null;
  try {
    browser = await launch();
    const context = await browser.newContext({
      userAgent: realisticUserAgent(typeof browser.version === 'function' ? browser.version() : ''),
      locale: INTL[ctx.language] || 'de-CH',
      timezoneId: 'Europe/Zurich',
      viewport: { width: 1366, height: 900 },
      acceptDownloads: false,
    });
    let page = await context.newPage();
    await page.goto(ctx.applyUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await settle(page);
    let snapshot;
    ({ page, snapshot } = await openApplicationForm(context, page, await extractFields(page, NAVIGATION)));
    snapshot = await awaitFields(page, await extractFields(page));
    if (snapshot.captcha || snapshot.passwordVisible || !hasApplicationForm(snapshot)) return [];
    const plan = await planPage({ snapshot, candidate: ctx.candidate, candidateLocale: ctx.candidateLocale, codex: ctx.codex });
    // A field with a generated name is no question for a person: the submit run's agent reads it.
    const readable = plan.missingRequired.filter((item) => !machineLabel(snapshot.fields.find((field) => field.id === item.fieldId)?.label));
    return questionsFrom(readable);
  } catch (error) {
    (ctx.log || (() => {}))(`portal pre-read skipped: ${String(error?.message || error).split('\n')[0].slice(0, 120)}`);
    return [];
  } finally {
    await browser?.close().catch(() => {});
  }
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
  const launch = ctx.launch || (() => launchChromium({ headless: !headedBrowser() }));
  const extensionPath = !ctx.launch && process.env.NOPECHA_EXTENSION_PATH;
  const log = ctx.log || (() => {});
  // JOIN asks one question per page (e-mail, CV, details, links, permit, salary,
  // start date, the employer's own questions, review): 8 pages were not enough.
  const maxSteps = ctx.maxSteps || 15;
  const evidence = { steps: [], applyUrl: ctx.applyUrl };
  const browser = extensionPath ? null : await launch();
  let context = null;
  let page = null;
  let diagnostics = null;
  // Where the runner stopped, for whoever takes over (encrypted with the rest of the evidence).
  const handoff = async (reason) => {
    if (page) {
      evidence.handoffScreenshot = (await page.screenshot({ fullPage: true }).catch(() => Buffer.from(''))).toString('base64');
      // What a fixer needs to teach the runner this page (level 3); a CAPTCHA is no code fix.
      if (reason !== 'captcha') {
        const seen = await extractFields(page, NAVIGATION).catch(() => null);
        evidence.stopReport = stopReportFrom({ url: page.url(), reason, step: evidence.steps.length, seen, agent: evidence.steps.at(-1)?.agent || [] });
      }
    }
    return { event: { type: 'submit_handoff', reason }, evidence };
  };
  // What each portal taught earlier runs (level 2), read once per host.
  const knowledge = new Map();
  const knownFor = async (url) => {
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      return NO_PORTAL_KNOWLEDGE;
    }
    if (!ctx.knowledge) return NO_PORTAL_KNOWLEDGE;
    if (!knowledge.has(host)) knowledge.set(host, await ctx.knowledge.load(host).catch(() => NO_PORTAL_KNOWLEDGE));
    return knowledge.get(host);
  };
  // Step buttons the agent named in this run, with their page: learned only once the portal confirms.
  const namedNext = [];
  try {
    const contextOptions = {
      locale: INTL[ctx.language] || 'de-CH',
      timezoneId: 'Europe/Zurich',
      viewport: { width: 1366, height: 900 },
      acceptDownloads: false,
    };
    context = extensionPath
      ? await launchNopechaContext(extensionPath, { ...contextOptions, headless: !headedBrowser() })
      : await browser.newContext({ ...contextOptions, userAgent: realisticUserAgent(typeof browser.version === 'function' ? browser.version() : '') });
    diagnostics = startPortalDiagnostics(context, (evidence.submitHttpFailures = []));
    evidence.diagnostics = diagnostics.data;
    await diagnostics.installFetchObserver().catch(() => { evidence.diagnostics.fetchObserverUnavailable = true; });
    page = await context.newPage();
    // Which browser the portal saw (the run's logs are deleted): headed on the
    // virtual screen or headless, and the user agent it sent.
    evidence.browser = { headed: headedBrowser(), userAgent: await page.evaluate(() => navigator.userAgent).catch(() => ''), nopecha: Boolean(extensionPath) };
    const response = await page.goto(ctx.applyUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await settle(page);
    let snapshot = await extractFields(page, NAVIGATION);
    snapshot = await awaitCaptcha(page, snapshot, { enabled: Boolean(extensionPath) });
    // The posting as a browser renders it (career-ops liveness-browser): the
    // fetch before the run sees only the empty shell of a JavaScript portal.
    const rendered = classifyLiveness({
      status: response?.status() || 0,
      requestedUrl: ctx.applyUrl,
      finalUrl: page.url(),
      bodyText: await pageText(page),
      applyControls: snapshot.buttons.map((button) => button.text || button.label || ''),
    });
    evidence.liveness = { result: rendered.result, code: rendered.code };
    if (isHardClosed(rendered)) return { event: { type: 'posting_closed', reason: rendered.code }, evidence };
    ({ page, snapshot } = await openApplicationForm(context, page, snapshot));
    if (snapshot.fields.some((field) => field.kind === 'listbox')) snapshot = await extractFields(page);
    // The form must be the posting's: an address that lands on a list of jobs
    // with a "Bewerben" must not apply to another one. Valerie's retry, after
    // she looked at the screenshot, goes on.
    const formMatch = async () => postingMatch(`${await page.title().catch(() => '')} ${await pageText(page)} ${page.url()}`, ctx.job);
    const match = await formMatch();
    evidence.postingMatch = match;
    // A sign-in page often names neither the company nor the role
    // (SuccessFactors, Coop 2026-10-02): the check waits for the form behind it.
    let postingCheckPending = match === 'mismatch' && snapshot.passwordVisible && !ctx.skipPostingCheck;
    if (match === 'mismatch' && !postingCheckPending && !ctx.skipPostingCheck) return await handoff('posting_mismatch');
    let validationRetries = 0;
    let stuckOnPage = 0;
    let authSteps = 0;
    const uploaded = new Set();
    // What went into the form, question by question (career-ops application-answers):
    // for the interview prep, and for Valerie when she finishes by hand. The last answer wins.
    const given = new Map();
    evidence.answers = [];
    const record = (question, answer, source) => {
      if (!question || !String(answer ?? '').trim()) return;
      given.set(question, { question: String(question).slice(0, 200), answer: String(answer).slice(0, 2000), source: source || '' });
      evidence.answers = [...given.values()].slice(0, 80);
    };
    // The agentic fallback: once per page and reason, within the run's budget.
    let agentCalls = 0;
    const agentTried = new Set();
    const runAgent = async (current, hint) => {
      const key = `${pageSignature(page, current)}|${hint}`;
      if (!ctx.codex || agentTried.has(key) || agentCalls >= MAX_AGENT_CALLS) return null;
      agentTried.add(key);
      let agent;
      try {
        agent = await completeWithAgent({
          page,
          hint,
          errors: current.errors || [],
          candidate: ctx.candidate,
          candidateLocale: ctx.candidateLocale,
          codex: ctx.codex,
          files: ctx.files,
          maxRounds: Math.min(AGENT_ROUNDS, MAX_AGENT_CALLS - agentCalls),
          log,
        });
      } catch (error) {
        // The fallback is optional: whatever it throws ends in the usual handoff, never a failed run.
        agent = { status: 'stuck', reason: `agent_error: ${String(error?.message || error).split('\n')[0].slice(0, 120)}`, calls: 1, evidence: { hint, rounds: [] } };
      }
      agentCalls += agent.calls;
      (evidence.steps.at(-1).agent ||= []).push({ ...agent.evidence, status: agent.status, ...(agent.reason ? { reason: agent.reason } : {}) });
      for (const item of agent.answers || []) record(item.question, item.answer, item.source);
      return agent;
    };
    const askCandidate = (questions) => ({ event: { type: 'submit_needs_candidate', questions: questionsFrom(questions) }, evidence });

    for (let step = 1; step <= maxSteps; step += 1) {
      snapshot = await awaitCaptcha(page, snapshot, { enabled: Boolean(extensionPath) });
      evidence.steps.push({ step, url: page.url(), fields: snapshot.fields.length, errors: snapshot.errors || [] });
      log(`portal step ${step}: ${snapshot.fields.length} fields`);
      if (snapshot.captcha) return await handoff('captcha');
      if (snapshot.passwordVisible) {
        if (!ctx.accounts || ++authSteps > MAX_AUTH_STEPS) return await handoff('account');
        const auth = await handleAuth({ page, snapshot, ctx });
        evidence.steps.at(-1).auth = {
          kind: authPageKind(snapshot),
          outcome: auth.handoff || (auth.questions ? 'questions' : auth.dryRun ? 'dry_run' : 'ok'),
          ...(auth.privacy ? { privacy: auth.privacy } : {}),
        };
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
      if (postingCheckPending) {
        postingCheckPending = false;
        evidence.postingMatch = await formMatch();
        if (evidence.postingMatch === 'mismatch') return await handoff('posting_mismatch');
      }
      // Inside the form, any page with a field is planned: a step with one
      // question and its Next disabled until it is answered (JOIN's work
      // authorization) is not a dead end. Nothing to fill and nowhere to go is.
      const workable = (current) => current.fields.length > 0 || hasApplicationForm(current)
        || findButton(current.buttons, SUBMIT_RE) || findButton(current.buttons, NEXT_RE);
      if (!workable(snapshot)) snapshot = await awaitFields(page, snapshot);
      // Nothing the filler can read (a page of custom widgets): straight to the agent.
      let agentHint = workable(snapshot) ? 'next_disabled' : 'no_form_controls';

      let after = snapshot;
      let unclearQuestions = [];
      if (workable(snapshot)) {
        const plan = await planPage({ snapshot, candidate: ctx.candidate, candidateLocale: ctx.candidateLocale, codex: ctx.codex });
        // A required field with no readable label is no question for the
        // candidate ("select-input-_r_p_"): the agent finds its question on the page.
        const unclear = plan.missingRequired.some((item) => machineLabel(snapshot.fields.find((field) => field.id === item.fieldId)?.label));
        if (plan.missingRequired.length && !unclear) return askCandidate(plan.missingRequired);
        if (unclear) unclearQuestions = plan.missingRequired;
        if (unclear) agentHint = 'unclear_fields';
        // A file already uploaded on this page is not uploaded again when the
        // page is planned a second time (Personio empties the input after the upload).
        const uploadKey = (fieldId) => `${page.url()}|${snapshot.fields.find((field) => field.id === fieldId)?.label || fieldId}`;
        const actions = plan.actions.filter((action) => action.action !== 'upload' || !uploaded.has(uploadKey(action.fieldId)));
        const plannedUrl = page.url();
        const results = await applyActions(page, snapshot.fields, actions, ctx.files);
        for (const result of results) {
          if (result.ok && actions.some((action) => action.fieldId === result.fieldId && action.action === 'upload')) uploaded.add(uploadKey(result.fieldId));
          const action = result.ok && actions.find((item) => item.fieldId === result.fieldId);
          const field = action && snapshot.fields.find((item) => item.id === result.fieldId);
          if (!field || field.inputType === 'password') continue;
          const answer = { upload: uploadLabel(action.document, ctx.candidate), check: '✓', uncheck: '✗' }[action.action] ?? action.value;
          record(field.label || field.name || field.id, answer, action.source);
        }
        evidence.steps.at(-1).actions = actions.map(({ fieldId, action, source, document }) => ({ fieldId, action, source, document }));
        evidence.steps.at(-1).failures = results.filter((result) => !result.ok);

        after = await extractFields(page, NAVIGATION);
        // The portal moved to another page by itself (JOIN registers the e-mail
        // and shows the CV page a moment later): plan that page, instead of
        // judging it by the buttons of the one just filled. Giro di prova 2026-10-01.
        if (page.url() !== plannedUrl) {
          snapshot = await awaitFields(page, await extractFields(page));
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
      }
      after = await awaitCaptcha(page, after, { enabled: Boolean(extensionPath) });
      if (after.captcha) return await handoff('captcha');
      // A usual name, or one this portal taught a confirmed submission (level 2).
      const known = await knownFor(page.url());
      let { submit, next } = pageControls(after.buttons, known, page.url());
      let advance = null;
      let finalByAgent = null;
      // The filler cannot move this page on (its Next stays disabled: JOIN's
      // calendar of "Quando sei nato?"), or left fields it could not name:
      // the agent completes the page, then the runner moves on as before.
      if ((!submit && !next) || agentHint === 'unclear_fields') {
        const agentUrl = page.url();
        const agent = await runAgent(after, agentHint);
        if (agent?.status === 'needs_candidate') return askCandidate(agent.questions);
        // Required fields left unanswered: the owner looks when the agent could
        // not answer them; without the agent, the planner's questions as before.
        if (unclearQuestions.length && agent?.status !== 'done') {
          return !agent || agent.status === 'unavailable' ? askCandidate(unclearQuestions) : await handoff('portal_needs_candidate');
        }
        if (agent?.status === 'done') {
          if (agent.moved || page.url() !== agentUrl) {
            snapshot = await awaitFields(page, await extractFields(page));
            continue;
          }
          after = await extractFields(page, NAVIGATION);
          for (let waited = 0; waited < 6000 && !findButton(after.buttons, SUBMIT_RE) && !findButton(after.buttons, NEXT_RE); waited += 2000) {
            await page.waitForTimeout(2000);
            after = await extractFields(page, NAVIGATION);
          }
          ({ submit, next } = pageControls(after.buttons, known, page.url()));
          // A step button with an unusual name ("Salva e prosegui"), never one that may send.
          if (!submit && !next && agent.advanceRef) advance = await advanceLocator(page, agent.advanceRef);
          // The last page's send button with an unusual name («Conferma e applica», level 1):
          // the agent names it, the runner presses it below, behind the submission guard,
          // only when nothing required is left empty on the page.
          if (!submit && !next && !advance && agent.submitRef) {
            if (!await requiredLeftEmpty(page)) finalByAgent = await submitLocator(page, agent.submitRef);
          }
        }
      }
      if ((next || advance) && !submit) {
        const before = pageSignature(page, after);
        if (next) await clickButton(page, next);
        else {
          const from = anonymizePath(page.url());
          await advance.locator.click({ timeout: 6_000 });
          namedNext.push({ path: from, label: advance.name });
        }
        await settle(page);
        snapshot = await extractFields(page);
        // A single-page form moves on after its own request (JOIN checks the
        // e-mail first): up to 10 s for the next page before calling it stuck.
        // The address may change before the content does (JOIN's professionalLinks
        // step was read with the previous page's fields): the same labels count as the same page.
        const labelsBefore = after.fields.map((field) => field.label).join('|');
        snapshot = await awaitFields(page, snapshot, (current) => pageSignature(page, current) === before
          || (current.fields.length > 0 && current.fields.map((field) => field.label).join('|') === labelsBefore));
        // Still the same page: the form refused a value. A correction by the
        // planner, one by the agent (it reads the page's own messages), then the owner.
        stuckOnPage = pageSignature(page, snapshot) === before ? stuckOnPage + 1 : 0;
        if (stuckOnPage >= 2) {
          const agent = await runAgent(snapshot, 'refused');
          if (agent?.status === 'needs_candidate') return askCandidate(agent.questions);
          if (agent?.status === 'done') snapshot = await extractFields(page);
          else if ((agent && agent.status !== 'unavailable') || stuckOnPage > 2) return await handoff('portal_needs_candidate');
        }
        continue;
      }
      // The final button: a usual or learned name (the runner's), or the one the agent named.
      const final = submit
        ? { label: submit.text, by: 'runner', click: () => clickButton(page, submit) }
        : finalByAgent && { label: finalByAgent.name, by: 'agent', click: () => finalByAgent.locator.click({ timeout: 6_000 }) };
      if (!final) {
        if (findButton(after.buttons, SUBMIT_RE, { includeDisabled: true }) && validationRetries < 1) {
          validationRetries += 1;
          snapshot = await extractFields(page);
          continue;
        }
        return await handoff('portal_needs_candidate');
      }
      if (ctx.dryRun) {
        evidence.dryRunScreenshot = (await page.screenshot({ fullPage: true })).toString('base64');
        evidence.finalButton = { label: final.label, by: final.by };
        return { event: { type: 'dry_run_ready' }, evidence };
      }
      evidence.beforeSubmit = (await page.screenshot({ fullPage: true })).toString('base64');
      evidence.finalButton = { label: final.label, by: final.by };
      const finalUrl = page.url();
      await diagnostics.beforeSubmit(page);
      // From here the outcome may be unknown: the submission guard records the click.
      if (ctx.onBeforeSubmit) await ctx.onBeforeSubmit();
      diagnostics.finalClick();
      await final.click();
      const outcome = await waitForOutcome(page, Boolean(extensionPath));
      await diagnostics.afterSubmit(page, outcome);
      evidence.afterSubmit = (await page.screenshot({ fullPage: true }).catch(() => Buffer.from(''))).toString('base64');
      evidence.finalUrl = page.url();
      log(`portal outcome: ${outcome}`);
      if (outcome === 'confirmed') {
        // The portal confirmed: what this run had to learn is remembered for the next one (level 2).
        const learnedFinal = final.by === 'agent' || !SUBMIT_RE.test(final.label) ? { path: anonymizePath(finalUrl), label: final.label } : null;
        if (ctx.knowledge && (learnedFinal || namedNext.length)) {
          await ctx.knowledge.learn(new URL(finalUrl).hostname, { finalButton: learnedFinal, nextButtons: namedNext }).catch((error) => log(`portal knowledge not saved: ${String(error?.message || error).slice(0, 80)}`));
        }
        return { event: { type: 'submit_succeeded', channel: 'portal' }, evidence };
      }
      if (outcome === 'captcha') return await handoff('captcha');
      if (outcome === 'validation' && validationRetries < 1) {
        validationRetries += 1;
        snapshot = await extractFields(page);
        continue;
      }
      // Lever, TSMG 2026-10-01: SUBMIT APPLICATION opened an hCaptcha challenge
      // (getcaptcha after the click) that nobody passed and that was gone by
      // the end of the wait; the page kept its form and send button. The
      // application never left: a CAPTCHA stop for Valerie, as a challenge
      // still on screen is, not an unknown outcome.
      if (outcome === 'ambiguous' && page.url() === finalUrl && diagnostics.challengeAfterClick() && await sendButtonStill(page, final.label)) {
        evidence.challengeAfterClick = true;
        return await handoff('captcha');
      }
      // career-ops: an ambiguous submit is never re-submitted automatically.
      // The page did not move and still offers the same send button, on a
      // portal that scores visitors with an invisible reCAPTCHA (JOIN, giro di
      // prova 2026-10-01: nothing reached the employer): most likely refused as
      // a bot. Said to Valerie as such; still never re-sent automatically.
      const antibot = outcome === 'ambiguous' && page.url() === finalUrl && await refusedSilently(page, final.label);
      if (antibot) evidence.antibot = true;
      // The portal said the application did not go (JOIN, run 36846326334),
      // on the same page or on an error page it moved to (review of #10741):
      // not ambiguous. submit.mjs releases the guard, so Valerie's retry can
      // claim it again; the runner itself never re-sends.
      if (outcome === 'refused') {
        evidence.antibot = await invisibleRecaptcha(page);
        return { event: { type: 'submit_failed', error: 'portal_refused' }, evidence };
      }
      return { event: { type: 'submit_failed', error: outcome === 'validation' ? 'portal_validation' : antibot ? 'portal_antibot_ambiguous' : 'portal_ambiguous' }, evidence };
    }
    return await handoff('portal_needs_candidate');
  } finally {
    await diagnostics?.finish();
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

export { locatorFor };
