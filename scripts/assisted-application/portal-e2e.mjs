#!/usr/bin/env node
/**
 * End-to-end check of the portal runner on a LOCAL fake portal: no employer,
 * no Codex, no Firestore. Run by assisted-application-portal-e2e.yml when the
 * runner changes, and by hand:
 *
 *   node scripts/assisted-application/portal-e2e.mjs
 *   (PLAYWRIGHT_CHROMIUM_PATH=<binary> to use a local Chromium build)
 *   AA_PORTAL_E2E_FOCUS=coop node scripts/assisted-application/portal-e2e.mjs
 *   AA_PORTAL_E2E_FOCUS=agent-birth-date node scripts/assisted-application/portal-e2e.mjs
 *   AA_PORTAL_E2E_FOCUS=diagnostics node scripts/assisted-application/portal-e2e.mjs
 *   AA_PORTAL_E2E_FOCUS=umantis node scripts/assisted-application/portal-e2e.mjs
 *   AA_PORTAL_E2E_FOCUS=modal-application node scripts/assisted-application/portal-e2e.mjs
 *   AA_PORTAL_E2E_FOCUS=workday-tenant node scripts/assisted-application/portal-e2e.mjs
 *   AA_PORTAL_E2E_FOCUS=workday-tenant-smoke node scripts/assisted-application/portal-e2e.mjs
 *
 * posting → sign-in page → "Konto erstellen" → register (two passwords, the
 * required consent, a newsletter box left alone) → "check your e-mail" →
 * activation link from the inbox → sign-in → form (CV upload) → submit →
 * confirmation. Three runs: a dry run (stops before creating the account),
 * the first real run (creates, verifies, applies), a second one (signs in).
 * The same for Coop's way in (2026-10-02): its career page, the Prospective.ch
 * redirect, SuccessFactors' registration with its privacy-statement dialog.
 */
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchChromium } from '../lib/ensure-chromium.mjs';
import { acceptPrivacyStatement, portalUploadActionKey, readPortalRequirements, submitViaPortal } from './lib/portal/portal.mjs';
import { aiSnapshot, runAction } from './lib/portal/agent.mjs';
import { extractFields } from './lib/portal/fields.mjs';
import { applyActions } from './lib/portal/fill.mjs';
import { registerCookieSessionRecovery } from './lib/portal/cookie-session.mjs';
import { normalizeLabel } from './lib/portal/knowledge.mjs';

const ALIAS = 'c-abcdefghjk@candidature.frontaliereticino.ch';
const HOTEL_NO_H1_UUID = '01234567-89ab-cdef-0123-456789abcdef';
const HOTEL_NO_H1_PATH = `/hotel-job-no-h1/${HOTEL_NO_H1_UUID}`;
const HOTEL_NO_H1_OTHER_TITLE_PATH = `/hotel-job-no-h1-other-title/${HOTEL_NO_H1_UUID}`;
const WORKDAY_SITE_PATH = '/en-US/AcmeCareers';
const WORKDAY_JOB_PATH = `${WORKDAY_SITE_PATH}/job/Mendrisio%2C-Outlet%2C-CHE/Consultant_R-12345-1`;
const WORKDAY_MANUAL_JOB_PATH = `${WORKDAY_SITE_PATH}/job/Mendrisio%2C-Outlet%2C-CHE/Consultant_R-12345-1/apply/applyManually`;
const WORKDAY_LOGIN_PATH = `${WORKDAY_SITE_PATH}/login`;
const WORKDAY_CREATE_ACCOUNT_PATH = `${WORKDAY_SITE_PATH}/createAccount`;
const WORKDAY_FORGOT_PASSWORD_PATH = `${WORKDAY_SITE_PATH}/forgotPassword`;
const WORKDAY_RESET_PASSWORD_PATH = `${WORKDAY_SITE_PATH}/resetPassword`;
const WORKDAY_ACTIVATE_PATH = `${WORKDAY_SITE_PATH}/activate`;
const WORKDAY_MY_APPLICATIONS_PATH = `${WORKDAY_SITE_PATH}/myApplications`;
const workdayTenantOrigin = (server) => `https://acme.wd3.myworkdayjobs.com:${server.address().port}`;
const PORTAL_TEST_DATA_RETENTION_KEEP_OPTION = 'I consent to my data being stored, including after a specific job has been filled, and to being advised of any interesting job offers.';
const PORTAL_TEST_DATA_RETENTION_ANSWER = 'I would like my data to be deleted once the present application process is complete.';
const PORTAL_TEST_DATA_RETENTION_CONTEXT = `Data release * · ${PORTAL_TEST_DATA_RETENTION_KEEP_OPTION} · ${PORTAL_TEST_DATA_RETENTION_ANSWER}`;
const PORTAL_TEST_PRIVACY_CONTEXT = 'Concierge Host';
const fakeLocalizationUnknowns = [];
const safeFixtureLabel = (value) => String(value || '').replace(/[^\p{L}\p{N} _.,?*'’()-]/gu, '').slice(0, 140);
// Synthetic candidate facts keep the fake planner's identity, contact, birth
// date, permit answer, and explicit consent answers grounded. Pass null to omit
// a fact under test; consent is never inferred from the portal's checkbox.
const portalTestCandidate = ({ dateOfBirth = '12.05.1990', permitAnswer = 'Yes' } = {}) => ({
  identity: { email: ALIAS, firstName: 'Luca', lastName: 'Bianchi', phone: '+41 79 000 00 00' },
  profile: {
    location: 'Lugano',
    address: { street: 'Via Esempio 1', postalCode: '6830', city: 'Lugano', country: 'Svizzera' },
    ...(dateOfBirth ? { dateOfBirth } : {}),
  },
  answers: {
    salutation: 'Mr',
    portal_privacy_consent: 'Yes',
    portal_data_retention: PORTAL_TEST_DATA_RETENTION_ANSWER,
    ...(permitAnswer
      ? { work_permit: 'Permesso G', valid_work_permit: permitAnswer }
      : {}),
  },
  portalQuestionsAnswered: [
    ...(permitAnswer ? [{ id: 'valid_work_permit', question: 'Do you hold a valid work permit?', answer: permitAnswer, source: 'user' }] : []),
    { question: 'Ich akzeptiere die Datenschutzerklärung', answer: 'Ja', source: 'user' },
    { question: 'I agree to the Privacy Policy Statement', answer: 'Yes', source: 'user' },
    // Explicit answers carry the same section context the native-field reader
    // records, so matching cannot leak across repeated questions or sections.
    {
      question: 'I agree to the Privacy Policy Statement', answer: 'Yes', source: 'user',
      context: PORTAL_TEST_PRIVACY_CONTEXT, section: PORTAL_TEST_PRIVACY_CONTEXT,
    },
    {
      question: 'Data release', answer: PORTAL_TEST_DATA_RETENTION_ANSWER, source: 'user',
    },
    {
      question: 'Data release', answer: PORTAL_TEST_DATA_RETENTION_ANSWER, source: 'user',
      context: PORTAL_TEST_DATA_RETENTION_CONTEXT, section: 'Data release *',
    },
  ],
});
// Synthetic-portal diagnostics only: never serialize values, credentials or
// arbitrary evidence when a checked lifecycle stops before its expected phase.
const safeLocation = (value) => {
  try {
    const url = new URL(value);
    return { host: url.hostname, path: url.pathname };
  } catch {
    return null;
  }
};
const safePortalNavigationDiagnostic = (entry = {}) => {
  const host = typeof entry.location?.host === 'string' && /^[a-z0-9.-]{1,253}$/i.test(entry.location.host)
    ? entry.location.host : '';
  const pathname = typeof entry.location?.path === 'string' && /^\/[a-z0-9_./-]{0,179}$/i.test(entry.location.path)
    ? entry.location.path : '';
  const count = (value, max) => Number.isInteger(value) ? Math.min(max, Math.max(0, value)) : 0;
  return {
    hop: count(entry.hop, 3),
    phase: ['cookie_check', 'entry_selection', 'after_click', 'direct_route'].includes(entry.phase) ? entry.phase : 'cookie_check',
    cookieStatus: ['none', 'dismissed', 'unresolved'].includes(entry.cookieStatus) ? entry.cookieStatus : 'unresolved',
    location: host && pathname ? { host, path: pathname } : null,
    applicationControlCandidateCount: count(entry.applicationControlCandidateCount, 50),
    applicationEntryControlCount: count(entry.applicationEntryControlCount, 20),
    ...(entry.entryResolution && typeof entry.entryResolution === 'object' ? { entryResolution: {
      externalFallbackAllowed: entry.entryResolution.externalFallbackAllowed === true,
      candidateCount: count(entry.entryResolution.candidateCount, 20),
      boundedVacancyContextCount: count(entry.entryResolution.boundedVacancyContextCount, 20),
      vacancyRoleMatchCount: count(entry.entryResolution.vacancyRoleMatchCount, 20),
      vacancyEmployerMatchCount: count(entry.entryResolution.vacancyEmployerMatchCount, 20),
      vacancyEmployerConflictCount: count(entry.entryResolution.vacancyEmployerConflictCount, 20),
      vacancyContextMatchCount: count(entry.entryResolution.vacancyContextMatchCount, 20),
    } } : {}),
    selectedControlKind: ['none', 'button', 'manual_button', 'link'].includes(entry.selectedControlKind) ? entry.selectedControlKind : 'none',
    linkVisible: entry.linkVisible === true,
  };
};
const stopContext = ({ event = {}, evidence = {}, portalNavigationDiagnostics = [], tenantRequests = [] }) => ({
  type: event.type, reason: event.reason, error: event.error, stage: event.stage,
  ...(fakeLocalizationUnknowns.length ? { fakeLocalizationUnknowns: fakeLocalizationUnknowns.slice(-3) } : {}),
  ...(evidence.finalFormGuardFailure ? { finalFormGuardFailure: evidence.finalFormGuardFailure } : {}),
  ...(Array.isArray(evidence.finalOutcomes) ? { finalOutcomes: evidence.finalOutcomes } : {}),
  ...(evidence.finalUrl ? { finalUrl: (() => {
    try {
      const url = new URL(evidence.finalUrl);
      return { host: url.hostname, path: url.pathname, hasPostingKey: [...url.searchParams.keys()].some(key => /^(?:jobid|job_id|requisitionid|requisition_id|postingid)$/i.test(key)) };
    } catch { return null; }
  })() } : {}),
  ...(evidence.finalButton ? { finalButton: { label: evidence.finalButton.label, by: evidence.finalButton.by } } : {}),
  ...(evidence.postingMatch ? { postingMatch: evidence.postingMatch, postingMatchVia: evidence.postingMatchVia } : {}),
  ...(Array.isArray(portalNavigationDiagnostics) && portalNavigationDiagnostics.length
    ? { portalNavigation: portalNavigationDiagnostics.slice(0, 12).map(safePortalNavigationDiagnostic) } : {}),
  ...(Array.isArray(tenantRequests) && tenantRequests.length
    ? { tenantRequests: tenantRequests.slice(-12).map((request) => String(request).replace(/([?&]token=)[^&]+/gi, '$1[redacted]')) } : {}),
  questions: (Array.isArray(event.questions) ? event.questions : []).map(question => {
    if (typeof question === 'string') return question;
    return {
      fieldId: safeFixtureLabel(question.fieldId || question.id),
      applicationQuestion: safeFixtureLabel(question.applicationQuestion || question.portalQuestion || ''),
      context: safeFixtureLabel(question.context || ''),
      section: safeFixtureLabel(question.section || ''),
      question: safeFixtureLabel(question.question || question.label || ''),
    };
  }),
  steps: (evidence.steps || []).slice(-2).map(step => ({
    step: step.step, ...(step.url ? { location: safeLocation(step.url) } : {}),
    fields: step.fields, requiredFieldsUnfilled: step.requiredFieldsUnfilled,
    failures: (step.failures || []).length,
    failureErrors: (step.failures || []).map((failure) => failure?.error).filter((error) => /^[a-z_]{1,80}$/.test(String(error || ''))).slice(0, 5),
    actionDocuments: (step.actions || []).map(action => action.document).filter(Boolean),
    ...(step.auth ? { auth: { kind: step.auth.kind, outcome: step.auth.outcome, privacy: step.auth.privacy } } : {}),
  })),
});

// The tenant id in the address names no company: the posting is checked on the form.
const SF_JOB = '/sf/career?company=tenant1000103&career_ns=job_application&career_job_req_id=170044';
// SuccessFactors' password policy (8–18 characters) follows its host name.
const sfOrigin = (server) => `http://career2.successfactors.localhost:${server.address().port}`;
// umantis as a hotel's career page links to it (2026-10-03): another host, the form's address names no company.
const UMANTIS_FORM = '/Vacancies/717/Application/New/2';
// The same form with its photo and documents in sections still closed (review of #11033).
const UMANTIS_CLOSED_FORM = '/Vacancies/718/Application/New/2';
const umantisOrigin = (server) => `http://recruitingapp-0000.umantis.localhost:${server.address().port}`;
const localOrigin = (server) => `http://127.0.0.1:${server.address().port}`;

async function createWorkdayTlsFixture(directory) {
  const caKeyPath = path.join(directory, 'workday-test-ca.key');
  const caCertPath = path.join(directory, 'workday-test-ca.pem');
  const serverKeyPath = path.join(directory, 'workday.localhost.key');
  const serverCsrPath = path.join(directory, 'workday.localhost.csr');
  const serverCertPath = path.join(directory, 'workday.localhost.pem');
  const extensionsPath = path.join(directory, 'workday-server-extensions.cnf');
  await writeFile(extensionsPath, [
    '[server_cert]',
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    'subjectAltName=DNS:workday.localhost,DNS:acme.wd3.myworkdayjobs.com',
    '',
  ].join('\n'));

  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', caKeyPath, '-out', caCertPath, '-days', '1',
      '-subj', '/CN=Application Concierge E2E Test CA',
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    ], { stdio: 'ignore' });
    execFileSync('openssl', [
      'req', '-new', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', serverKeyPath, '-out', serverCsrPath,
      '-subj', '/CN=workday.localhost',
    ], { stdio: 'ignore' });
    execFileSync('openssl', [
      'x509', '-req', '-in', serverCsrPath,
      '-CA', caCertPath, '-CAkey', caKeyPath, '-CAcreateserial',
      '-out', serverCertPath, '-days', '1', '-sha256',
      '-extfile', extensionsPath, '-extensions', 'server_cert',
    ], { stdio: 'ignore' });
    const publicKey = execFileSync('openssl', ['x509', '-in', serverCertPath, '-pubkey', '-noout']);
    const spki = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'DER'], { input: publicKey });
    return {
      cert: await readFile(serverCertPath),
      key: await readFile(serverKeyPath),
      spkiPin: createHash('sha256').update(spki).digest('base64'),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function fakePortal() {
  const state = { accounts: new Map(), verified: new Set(), sessions: new Set(), applications: [], widgetApplications: [], gravityApplication: { openerClicks: 0, submissions: 0, day: '', month: '', year: '', hasCv: false }, rhbApplications: [], sixApplications: [], sixPostingViews: 0, summarySubmissions: 0, summaryCv: [], newsletter: false, pending: null, refuseNextRegistration: false, registrationValidationOnce: false, registrationInvalidOnlyOnce: false, registrationNeedsAnswerAfterValidation: false, registrationNeedsAnswer: false, registrationRequests: 0, registeredPermit: '', unverifiedLoginStaysOnSignIn: false, omitNextRegistrationSubmit: false };
  let receiptJobId = '';
  let receiptJobParam = 'jobid';
  let receiptJobSequence = 0;
  const receiptJobKeys = /^(?:jobid|job_id|requisitionid|requisition_id|postingid)$/i;
  const bindReceiptJobId = (value) => {
    const url = new URL(value);
    const keys = [...url.searchParams.entries()].filter(([key]) => receiptJobKeys.test(key));
    if (keys.length > 1) throw new Error('fake portal apply URL has ambiguous posting keys');
    if (keys.length === 1) {
      [receiptJobParam, receiptJobId] = keys[0];
    } else {
      receiptJobParam = 'jobid';
      receiptJobId = `e2e-${++receiptJobSequence}`;
      url.searchParams.set(receiptJobParam, receiptJobId);
    }
    return url.href;
  };
  const receiptQuery = (value) => {
    const url = new URL(value, 'http://127.0.0.1');
    if (![...url.searchParams.keys()].some((key) => receiptJobKeys.test(key))) {
      url.searchParams.set(receiptJobParam, receiptJobId);
    }
    return `${url.pathname}${url.search}${url.hash}`;
  };
  const bindLocalReceiptTarget = (value) => {
    if (String(value).startsWith('/') && !String(value).startsWith('//')) {
      const localPath = new URL(value, 'http://127.0.0.1').pathname;
      if (localPath === WORKDAY_SITE_PATH || localPath.startsWith(`${WORKDAY_SITE_PATH}/`)) return value;
      if (/^\/en-US\/AcmeCareers\/job\/[^/]+\/Consultant_R-12345-1(?:\/|$)/i.test(localPath)) return value;
      return receiptQuery(value);
    }
    let url;
    try { url = new URL(value); } catch { return value; }
    if (/^\/en-US\/AcmeCareers\/job\/[^/]+\/Consultant_R-12345-1(?:\/|$)/i.test(url.pathname)) return value;
    const port = String(server.address()?.port || '');
    const hostname = url.hostname.toLowerCase();
    const isLoopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname.endsWith('.localhost');
    if (!isLoopback || url.port !== port) return value;
    const bound = receiptQuery(`${url.pathname}${url.search}${url.hash}`);
    return `${url.origin}${bound}`;
  };
  const bindLocalReceiptTargets = (html) => String(html)
    .replace(/\b(href|action)=(['"])(\/[^'"]*)\2/gi, (_match, attribute, quote, target) => `${attribute}=${quote}${bindLocalReceiptTarget(target)}${quote}`)
    .replace(/(window\.location(?:\.href)?\s*=\s*)(['"])(\/[^'"]*)\2/gi, (_match, assignment, quote, target) => `${assignment}${quote}${bindLocalReceiptTarget(target)}${quote}`);
  // Coop, 2026-10-02: Prospective.ch's career page in front of SAP SuccessFactors.
  const coop = { later: 0, accounts: new Map(), sessions: new Set(), applications: [], jobAbo: false, privacyAccepted: 0, refused: [], outsideAccept: 0, cvUploads: 0, validationRefusals: 0, privacyValidationRetry: false, privacyValidationRetries: 0, applicationPrivacySubmissions: [], flaky: false, cookieManager: '' };
  // umantis, 2026-10-03: the application form itself asks for the account's password.
  const umantis = { accounts: new Map(), applications: [], refused: [] };
  // Workday, 2026-10-07: one page for «Create Account» and «Sign In», answered by script after the click.
  const workday = { accounts: new Map(), verifiedAccounts: new Set(), resetEmails: [], resetLinksClaimed: 0, resetLinkSent: false, recoveryUsed: false, recoveryHistoryChecked: false, historyUnavailable: false, activationResends: 0, activationLinksClaimed: 0, alreadyApplied: false, silent: false, cover: false, resumed: false, uploadFails: false, coverLetterUploadFails: false, coverLetterUploads: 0, additionalCvField: false, cvUploads: 0, additionalCvUploads: 0, nativeCvSelector: false, nativeCvSelectorClicks: 0, routeChangesBeforeUpload: false, tenantMode: false, tenantRouteMode: false, routeLandOnHomeAfterLogin: false, routeSessionSequence: 0, nativeCvMultipartUploads: 0, talentPoolRequests: 0, refusedOnce: new Set(), deletedFiles: 0, dropped: 0, registrations: 0, logins: 0, headerSignIns: 0, choiceClicks: { autofill: 0, lastApplication: 0 }, tenantRequests: [], forms: [] };
  const page = (title, body) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${title}</title></head><body><main>${body}</main></body></html>`;
  const form = (action, inner, multipart = false) => `<form method="post" action="${receiptQuery(action)}"${multipart ? ' enctype="multipart/form-data"' : ''}>${inner}</form>`;
  const registrationForm = ({ submit = true, error = '', includePermit = state.registrationNeedsAnswer, invalidEmail = false } = {}) => {
    const validationError = error ? `<p role="alert">${error}</p>` : '';
    const permitField = includePermit
      ? '<label for="permit">Do you hold a valid work permit?</label><select id="permit" name="permit" required><option value="">Select</option><option>Yes</option><option>No</option></select>'
      : '';
    const submitButton = submit ? '<button type="submit">Konto erstellen</button>' : '';
    const fields = `<label for="e">E-Mail-Adresse</label><input id="e" type="email" name="email" required${invalidEmail ? ' aria-invalid="true"' : ''}><label for="p1">Kennwort</label><input id="p1" type="password" name="p1" required><label for="p2">Kennwort bestätigen</label><input id="p2" type="password" name="p2" required>${permitField}<label><input type="checkbox" name="privacy" required> Ich akzeptiere die Datenschutzerklärung *</label><label><input type="checkbox" name="news"> Newsletter abonnieren</label>${submitButton}`;
    return page('Registrieren', `${validationError}${form('/register', fields)}`);
  };
  const loginForm = (error = '') => page('Anmelden', `${error ? `<p role="alert">${error}</p>` : ''}${form('/login', '<label for="e">E-Mail-Adresse</label><input id="e" type="email" name="email" required><label for="p">Kennwort</label><input id="p" type="password" name="password" required><button type="submit">Anmelden</button>')}<a href="/register">Konto erstellen</a>`);
  // The form as read on 2026-10-03: one <form>, one password among the applicant's data and the
  // uploads, «Submit final application». The page names the role, never the company.
  const umantisPhoto = '<label for="ph">Photo</label><input id="ph" type="file" name="photo">';
  const umantisDocuments = '<label for="cl">Cover letter</label><input id="cl" type="file" name="letter">'
    + '<label for="cv">Resume *</label><input id="cv" type="file" name="cv">'
    + '<label for="od">Other documents</label><input id="od" type="file" name="other">';
  // closed: the photo and the documents come into the page only once «Expand all sections» is pressed,
  // so the page first shows a password and a send button, and no file field.
  const umantisForm = (error = '', { closed = false } = {}) => page('Concierge Host - Application | Application Tracking System', `<nav><a href="/umantis-login">Login</a><a role="button" tabindex="0" href="/umantis-recruiters">Login for recruiters</a></nav>
    <h1>Concierge Host</h1><p>Click on Login if you have already set up your profile.</p>${error ? `<p role="alert">${error}</p>` : ''}
    ${closed ? '<button type="button" id="expand">Expand all sections</button>' : ''}
    ${form(closed ? UMANTIS_CLOSED_FORM : UMANTIS_FORM, `${closed ? '<div id="photo-section"></div>' : umantisPhoto}
      <fieldset><legend>Title *</legend><label><input type="radio" name="title" value="ms"> Ms</label><label><input type="radio" name="title" value="mr"> Mr</label><label><input type="radio" name="title" value="other"> Other</label></fieldset>
      <label for="fn">First name *</label><input id="fn" name="first">
      <label for="ln">Last name *</label><input id="ln" name="last">
      <label for="em">Email address/login *</label><input id="em" type="text" name="mail">
      <label for="pw">Password *</label><input id="pw" type="password" name="pwd" autocomplete="new-password">
      <p>The password must be at least 7 characters long. Password must contain special characters, numbers, upper and lower case letters</p>
      <label for="tel">Cell phone *</label><input id="tel" name="phone">
      ${closed ? '<div id="documents-section"></div>' : umantisDocuments}
      <label for="hear">How did you hear about us? *</label><select id="hear" name="hear"><option value="">Please select</option><option value="home">Company homepage</option><option value="board">Online job board</option><option value="misc">Miscellaneous</option></select>
      <label><input type="checkbox" name="employee"> I am a current employee of your company</label>
      <fieldset><legend>Data release *</legend><label><input type="radio" name="release" value="keep"> ${PORTAL_TEST_DATA_RETENTION_KEEP_OPTION}</label><label><input type="radio" name="release" value="delete"> ${PORTAL_TEST_DATA_RETENTION_ANSWER}</label></fieldset>
      <label><input type="checkbox" name="privacy"> I agree to the Privacy Policy Statement *</label>
      <input type="hidden" id="letter_stored" name="letter_stored" value=""><input type="hidden" id="cv_stored" name="cv_stored" value="">
      <button type="submit">Submit final application</button>`, true)}
    <script>
      // As on umantis: a file is sent as soon as it is chosen, one at a time. A second choice
      // while the first still travels drops the first (the letter left at 15% on 2026-10-03).
      let travelling = null;
      // On the document: the file fields of a closed section come into the page later.
      document.addEventListener('change', (event) => {
        const stored = { cl: 'letter_stored', cv: 'cv_stored' }[event.target.id];
        if (!stored) return;
        if (travelling) travelling.abort();
        const upload = new AbortController();
        travelling = upload;
        fetch('/umantis-upload', { method: 'POST', body: event.target.id, signal: upload.signal })
          .then(() => { document.getElementById(stored).value = '1'; if (travelling === upload) travelling = null; })
          .catch(() => {});
      });
      ${closed ? `document.getElementById('expand').addEventListener('click', (event) => {
        document.getElementById('photo-section').innerHTML = ${JSON.stringify(umantisPhoto)};
        document.getElementById('documents-section').innerHTML = ${JSON.stringify(umantisDocuments)};
        event.target.remove();
      });` : ''}
    </script>`);
  const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
  });
  const sessionOf = (req) => /sid=([a-z0-9]+)/.exec(req.headers.cookie || '')?.[1];
  // SuccessFactors' own cookie manager (Rolex, 2026-10-03): a region over the
  // whole sign-in page until one of its buttons, which name the cookies, is pressed.
  const sfCookieManager = (req) => (/sfCookies=/.test(req.headers.cookie || '') ? '' : `
    <div role="region" class="cookiePolicy cookiemanager" aria-labelledby="cookieManagerModalLabel" id="sfCookies" style="position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.3)">
      <p id="cookieManagerModalLabel">Wir verwenden Cookies, um Ihnen die bestmögliche Erfahrung auf unserer Website zu bieten.</p>
      <button type="button" id="cookie-bannershow">Cookie-Einstellungen ändern</button><button type="button" id="cookie-reject">Alle Cookies ablehnen</button><button type="button" id="cookie-accept">Alle Cookies akzeptieren</button></div>
    <script>
      for (const [id, choice] of [['cookie-reject', 'rejected'], ['cookie-accept', 'accepted']]) {
        document.getElementById(id).addEventListener('click', () => { document.cookie = 'sfCookies=' + choice + '; Path=/'; document.getElementById('sfCookies').remove(); });
      }
    </script>`);
  // Coop's SuccessFactors application page as mapped on 2026-10-03: its sections
  // closed behind «Alle Abschnitte einblenden», the CV only through «Lebenslauf
  // hochladen», a dialog whose file input exists once it is open and uploads at
  // once; «Bewerben» with something missing comes back with the portal's errors.
  const sfApplyPage = (errors = []) => page('Karrierechancen: Bewerbung', `<h1>Coop</h1><h2>Bäcker:in - Konditor:in (Schwerpunkt Bäckerei)</h2>
    ${errors.length ? `<div role="alert"><p>Bitte korrigieren Sie die folgenden Fehler.</p>${errors.map((error) => `<p>${error}</p>`).join('')}</div>` : ''}
    <button type="button" id="expand">Alle Abschnitte einblenden</button>
    ${form('/sf/apply', `<section id="docs"${errors.length ? '' : ' hidden'}><h3>Meine Dokumente</h3><span>Lebenslauf *</span> <span id="cvname"></span>
        <button type="button" id="cvbtn" aria-haspopup="dialog">Lebenslauf hochladen</button><input type="hidden" name="cv" id="cvdone" value=""></section>
      <section id="profile"${errors.length ? '' : ' hidden'}><label for="v">* Vorname</label><input id="v" name="first" required><label for="n">* Nachname</label><input id="n" name="last" required><label for="m">* E-Mail</label><input id="m" type="email" name="mail" required>
        <label for="anrede-in">* Anrede</label><input id="anrede-in" aria-label="Anrede" type="text" role="combobox" placeholder="Bitte auswählen" aria-owns="an:_listSelect" aria-required="true" aria-expanded="false" class="rcmpaginatedselectinput"><input type="hidden" name="anrede" id="anrede-v"><ul id="an:_listSelect" role="listbox"></ul>
        <label for="97:_datepicker">Geburtsdatum:*</label><div id="97:_datepicker" class="datePicker"><ui5-date-picker-xweb-calendar-widget ui5-date-picker="" title="Geburtsdatum" accessible-name="Geburtsdatum" format-pattern="dd.MM.yyyy" required="" placeholder="TT.MM.JJJJ"></ui5-date-picker-xweb-calendar-widget></div><input type="hidden" name="birth" id="birth-v">
        <label for="agency-in">* Stammt diese Bewerbung von einem Vermittlungsbüro? (Falls ja: Mit Einreichen des Dossiers werden die AGB der Coop Genossenschaft für die Personalvermittlung auf Erfolgsbasis akzeptiert.)</label><input id="agency-in" type="text" role="combobox" placeholder="Bitte auswählen" aria-owns="ag:_listSelect" aria-required="true" aria-expanded="false" class="rcmpaginatedselectinput"><input type="hidden" name="agency" id="agency-v"><ul id="ag:_listSelect" role="listbox"></ul>
      </section>
      <input type="hidden" name="applicationPrivacy" id="applicationPrivacy" value="">
      <label>Terms of Use * <a id="applicationPrivacyLink" role="button" tabindex="0" aria-haspopup="dialog">Read and accept the data privacy statement</a></label>
      <button type="button">Speichern</button><button type="submit">Bewerben</button>`)}
    <div role="dialog" id="up" hidden></div>
    <div role="dialog" id="applicationPrivacyDialog" hidden><label><input type="checkbox" id="applicationPrivacyReview"> I have read and accept the data privacy statement.</label><button type="button" id="applicationPrivacyAccept" disabled>Accept</button></div>
    <script>
      const privacyDialog = document.getElementById('applicationPrivacyDialog');
      const privacyReview = document.getElementById('applicationPrivacyReview');
      const privacyAccept = document.getElementById('applicationPrivacyAccept');
      document.getElementById('applicationPrivacyLink').addEventListener('click', () => { privacyDialog.hidden = false; });
      privacyReview.addEventListener('change', () => { privacyAccept.disabled = !privacyReview.checked; });
      privacyAccept.addEventListener('click', () => { document.getElementById('applicationPrivacy').value = '1'; privacyDialog.hidden = true; });
      // A flaky portal (review of #11022): the first click on each control is dropped.
      const flaky = ${coop.flaky ? 'true' : 'false'};
      const dropped = new Set();
      const dropsFirst = (id) => flaky && !dropped.has(id) && dropped.add(id);
      document.getElementById('expand').addEventListener('click', () => { if (dropsFirst('expand')) return; for (const id of ['docs', 'profile']) document.getElementById(id).hidden = false; });
      // A picklist: its options load a moment after it opens, into the list it owns.
      const picklist = (inputId, listId, hiddenId, options, writesAfterMs = 400) => {
        const input = document.getElementById(inputId);
        const list = document.getElementById(listId);
        const close = () => { list.innerHTML = ''; input.setAttribute('aria-expanded', 'false'); };
        input.addEventListener('click', () => {
          input.setAttribute('aria-expanded', 'true');
          list.innerHTML = '';
          setTimeout(() => {
            list.innerHTML = ['Bitte auswählen', ...options].map((option) => '<li role="option">' + option + '</li>').join('');
            for (const item of list.querySelectorAll('li')) {
              item.addEventListener('click', () => {
                list.innerHTML = '';
                // SuccessFactors writes the choice a moment after the click.
                if (item.textContent !== 'Bitte auswählen') {
                  // The visible widget paints first; the hidden form value is
                  // the commit that the server receives.
                  input.value = item.textContent;
                  setTimeout(() => { document.getElementById(hiddenId).value = item.textContent; close(); }, writesAfterMs);
                } else close();
              });
            }
          }, 1500);
        });
        input.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
      };
      picklist('anrede-in', 'an:_listSelect', 'anrede-v', ['Frau', 'Herr']);
      // As on Coop's SuccessFactors (run 37118242131): an Enter in the form submits it.
      document.addEventListener('keydown', (event) => { if (event.key === 'Enter' && event.isTrusted) { event.preventDefault(); document.querySelector('form').requestSubmit(); } });
      // Review of #11061: a choice written at 2.9 s still counts (the runner waits 3 s and looks once more).
      picklist('agency-in', 'ag:_listSelect', 'agency-v', ['Ja', 'Nein'], 2900);
      // UI5's date picker: its input in an open shadow root, its value set on change or Enter.
      customElements.get('ui5-date-picker-xweb-calendar-widget') || customElements.define('ui5-date-picker-xweb-calendar-widget', class extends HTMLElement {
        constructor() {
          super();
          this._value = '';
          const root = this.attachShadow({ mode: 'open' });
          root.innerHTML = '<input type="text" placeholder="TT.MM.JJJJ" style="width:120px">';
          const input = root.querySelector('input');
          const commit = () => { if (/^\\d{2}\\.\\d{2}\\.\\d{4}$/.test(input.value)) { this._value = input.value; document.getElementById('birth-v').value = input.value; } };
          input.addEventListener('change', commit);
        }
        get value() { return this._value; }
      });
      document.getElementById('cvbtn').addEventListener('click', () => {
        if (dropsFirst('cvbtn')) return;
        const dialog = document.getElementById('up');
        dialog.innerHTML = '<p>Quelle für das Hochladen der Datei auswählen</p><label for="f">Von Gerät hochladen</label><input type="file" id="f">';
        dialog.hidden = false;
        document.getElementById('f').addEventListener('change', async (event) => {
          const file = event.target.files[0];
          const body = new FormData();
          body.append('cv', file);
          await fetch('/sf/upload', { method: 'POST', body });
          document.getElementById('cvdone').value = '1';
          document.getElementById('cvname').textContent = file.name;
          dialog.hidden = true;
          dialog.innerHTML = '';
        });
      });
    </script>`);

  // Workday's account page as read on 2026-10-07 (Rituals): the form answers by script, a second and a half
  // after the click, without loading a document; its real submit is hidden (aria-hidden, tabindex -2)
  // under a «click_filter» overlay, and only a click on the overlay counts («NoCaptcha»); a honeypot a
  // hundredth of a pixel tall («beecatcher») must stay empty. A click that fails either test does nothing.
  // Above the page, the site's header has a «Sign In» of its own: it opens a dialog over everything, and
  // comes first in the document (dry run of 2026-10-07: the runner pressed it instead of the form's link).
  // The older fixture route uses an explicit same-site anchor. The tenant route below uses Workday's
  // `signInLink` button inside the auth form; the sign-in form is drawn anew once, right
  // after it is typed into (on the real page, when what it loads arrives late): what was typed is gone and
  // its overlay is another element. `workday.cover` puts something over the button: it cannot be pressed.
  const workdayAccountPage = (initialView = 'create', { buttonSignIn = false, tenantMode = false } = {}) => {
    const signInRoute = tenantMode ? `${WORKDAY_MANUAL_JOB_PATH}?view=sign-in` : '/wd/sign-in';
    const createRoute = tenantMode ? `${WORKDAY_MANUAL_JOB_PATH}?view=create` : '/wd/apply';
    const resetRoute = tenantMode ? `${WORKDAY_MANUAL_JOB_PATH}?view=password-reset-request` : '/wd/password-reset-request';
    const destination = tenantMode ? `${WORKDAY_MANUAL_JOB_PATH}?view=${workday.recoveryUsed ? 'home' : 'form'}` : `/wd/${workday.recoveryUsed ? 'home' : 'form'}`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Careers</title></head><body>
    <header><button id="util" type="button" data-automation-id="utilityButtonSignIn">Sign In</button></header>
    <div id="popup" role="dialog" aria-modal="true" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:50;background:#fff">
      <label for="pe">Email Address *</label><input id="pe" type="text">
      <label for="pp">Password *</label><input id="pp" type="password">
      <button type="button">Close</button>
    </div>
    <main>
    <h2 id="title">Create Account</h2>
    <form id="auth">
      <div id="notice"></div>
      <label for="e">Email Address *</label><input id="e" type="text" autocomplete="email" required>
      <label for="p1">Password *</label><input id="p1" type="password" autocomplete="new-password" required>
      <div id="again"><label for="p2">Verify New Password *</label><input id="p2" type="password" autocomplete="new-password" required></div>
      <div style="position:relative"><label for="hp">Enter website. This input is for robots only, do not enter if you're human.</label>
        <input id="hp" name="website" type="text" data-automation-id="beecatcher" style="display:block;border:0;width:1px;transform:scaleY(.01);margin-top:-22px"></div>
      <div style="position:relative;height:40px">
        <div id="filter" role="button" tabindex="0" aria-label="Create Account" data-automation-id="click_filter" style="position:absolute;top:0;left:0;right:0;bottom:0;z-index:3;cursor:pointer"></div>
        ${workday.cover ? '<div style="position:absolute;top:0;left:0;right:0;bottom:0;z-index:9"></div>' : ''}
        <button id="go" type="submit" tabindex="-2" aria-hidden="true" style="width:100%;height:40px">Create Account</button>
      </div>
      ${buttonSignIn
        ? `<button id="swap" type="button" data-automation-id="signInLink">${initialView === 'create' ? 'Sign In' : 'Create Account'}</button>`
        : `<a id="swap" href="${initialView === 'create' ? signInRoute : createRoute}">${initialView === 'create' ? 'Sign In' : 'Create Account'}</a>`}
      <button id="forgot" type="button" data-automation-id="forgotPasswordLink" style="${initialView === 'sign_in' ? '' : 'display:none'}">Forgot Password?</button>
      <button id="activation" type="button" style="display:none">Resend verification email</button>
    </form>
    <script>
      let view = '${initialView}';
      let human = false;
      const el = (id) => document.getElementById(id);
      const show = (next, notice) => {
        view = next;
        human = false;
        const name = next === 'create' ? 'Create Account' : 'Sign In';
        el('title').textContent = name;
        el('go').textContent = name;
        el('filter').setAttribute('aria-label', name);
        el('swap').textContent = next === 'create' ? 'Sign In' : 'Create Account';
        if (el('swap').tagName === 'A') el('swap').href = next === 'create' ? '${signInRoute}' : '${createRoute}';
        el('again').style.display = next === 'create' ? '' : 'none';
        el('p2').required = next === 'create';
        el('forgot').style.display = next === 'sign_in' ? '' : 'none';
        el('activation').style.display = next === 'sign_in' && /verify/i.test(notice || '') ? '' : 'none';
        el('notice').innerHTML = notice ? '<p role="alert">' + notice + '</p>' : '';
      };
      show(view);
      el('forgot').onclick = () => { window.location.href = '${resetRoute}'; };
      el('activation').onclick = () => { fetch('/wd/activation-resend', { method: 'POST' }); };
      el('util').onclick = () => { fetch('/wd/header', { method: 'POST' }); setTimeout(() => { el('popup').style.display = 'block'; }, 800); };
      if (${buttonSignIn ? 'true' : 'false'}) el('swap').onclick = () => show(view === 'create' ? 'sign_in' : 'create');
      el('filter').onclick = () => { human = true; el('go').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); };
      let redrawn = false;
      el('p1').addEventListener('input', () => {
        if (view !== 'sign_in' || redrawn) return;
        redrawn = true;
        setTimeout(() => {
          el('e').value = '';
          el('p1').value = '';
          const fresh = el('filter').cloneNode(true);
          fresh.removeAttribute('data-aa-id');
          fresh.onclick = el('filter').onclick;
          el('filter').replaceWith(fresh);
        }, 50);
      });
      el('auth').onsubmit = (event) => {
        event.preventDefault();
        if (!human || el('hp').value) { fetch('/wd/dropped', { method: 'POST' }); return; }
        const body = new URLSearchParams({ email: el('e').value, password: el('p1').value });
        setTimeout(async () => {
          const answer = await (await fetch(view === 'create' ? '/wd/register' : '/wd/login', { method: 'POST', body })).json();
          if (answer.silent) return;
          if (view === 'create') show(answer.ok ? 'sign_in' : 'create', answer.message);
      else if (answer.ok) { el('auth').style.display = 'none'; setTimeout(() => { window.location.href = '${destination}'; }, 1200); }
          else show('sign_in', answer.message);
        }, 1500);
      };
    </script></main></body></html>`;
  };
  const workdayTenantRouteAccountPage = (initialView = 'sign_in', error = '') => {
    const creating = initialView === 'create';
    const action = creating ? WORKDAY_CREATE_ACCOUNT_PATH : WORKDAY_LOGIN_PATH;
    const title = creating ? 'Créer un compte' : 'Connexion';
    const errorMessage = error ? `<p role="alert">${error}</p>` : '';
    return `<!doctype html><html lang="fr-FR"><head><meta charset="utf-8"><title>${title}</title></head><body>
      <nav aria-label="Tenant"><a href="${WORKDAY_SITE_PATH}/introduceYourself">Présentez-vous</a></nav>
      <main><h1>${title}</h1>${errorMessage}
        <form id="auth" method="post" action="${action}">
          <label for="account-email">Adresse e-mail</label><input id="account-email" type="email" name="email" autocomplete="email" required>
          <label for="account-password">Mot de passe</label><input id="account-password" type="password" name="password" autocomplete="current-password" required>
          ${creating ? '<label for="account-confirm">Confirmer le mot de passe</label><input id="account-confirm" type="password" name="confirm" autocomplete="new-password" required>' : ''}
          <button type="submit" data-automation-id="signInButton">${title}</button>
          ${creating ? '' : `<button type="button" data-automation-id="forgotPasswordLink" onclick="window.location.href='${WORKDAY_FORGOT_PASSWORD_PATH}'">Vous avez oublié votre mot de passe ?</button>`}
        </form>
        ${creating
          ? `<a href="${WORKDAY_LOGIN_PATH}">Connexion</a>`
          : `<a href="${WORKDAY_CREATE_ACCOUNT_PATH}">Créer un compte</a>`}
      </main></body></html>`;
  };
  const workdayTenantRoutePasswordRequestPage = () => `<!doctype html><html lang="fr-FR"><head><meta charset="utf-8"><title>Mot de passe oublié</title></head><body>
    <main><h1>Mot de passe oublié</h1><form method="post" action="${WORKDAY_FORGOT_PASSWORD_PATH}">
      <label for="reset-email">Adresse e-mail</label><input id="reset-email" type="email" name="email" required>
      <button type="submit">Réinitialiser le mot de passe</button>
    </form></main></body></html>`;
  const workdayTenantRouteResetPasswordPage = () => `<!doctype html><html lang="fr-FR"><head><meta charset="utf-8"><title>Réinitialiser le mot de passe</title></head><body>
    <main><h1>Réinitialiser le mot de passe</h1><form method="post" action="${WORKDAY_RESET_PASSWORD_PATH}">
      <input type="hidden" name="email" value="${ALIAS}">
      <label for="new-password">Nouveau mot de passe</label><input id="new-password" type="password" name="password" autocomplete="new-password" required>
      <label for="confirm-password">Confirmer le mot de passe</label><input id="confirm-password" type="password" name="confirm" autocomplete="new-password" required>
      <button type="submit">Enregistrer</button>
    </form></main></body></html>`;
  const workdayTenantRouteHomePage = () => `<!doctype html><html lang="fr-FR"><head><meta charset="utf-8"><title>Accueil candidat</title></head><body>
    <main><h1>Accueil candidat</h1><a href="${WORKDAY_MY_APPLICATIONS_PATH}">Mes candidatures</a></main></body></html>`;
  const workdayTenantRouteHistoryPage = () => `<!doctype html><html lang="fr-FR"><head><meta charset="utf-8"><title>Mes candidatures</title></head><body>
    <main><h1>Mes candidatures</h1><p>Vous n'avez aucune candidature pour le moment.</p></main></body></html>`;
  const workdayPasswordRequestPage = ({ tenantMode = false } = {}) => page('Forgot Password', `<h1>Forgot Password</h1>
    <form method="post" action="${tenantMode ? `${WORKDAY_MANUAL_JOB_PATH}?view=password-reset-request` : '/wd/password-reset-request'}">
      <label for="reset-email">Email Address</label><input id="reset-email" type="email" name="email" required>
      <button type="submit">Reset Password</button>
    </form>`);
  const workdayResetPasswordPage = ({ tenantMode = false } = {}) => page('Reset Password', `<h1>Reset Password</h1>
    <form method="post" action="${tenantMode ? `${WORKDAY_MANUAL_JOB_PATH}?view=password-reset` : '/wd/password-reset'}">
      <input type="hidden" name="email" value="${ALIAS}">
      <label for="new-password">New Password</label><input id="new-password" type="password" name="password" autocomplete="new-password" required>
      <label for="confirm-password">Confirm New Password</label><input id="confirm-password" type="password" name="confirm" autocomplete="new-password" required>
      <button type="submit">Save New Password</button>
    </form>`);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://portal.test');
    const send = (html) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(bindLocalReceiptTargets(html)); };
    const redirect = (to, headers = {}) => { res.writeHead(303, { location: bindLocalReceiptTarget(to), ...headers }); res.end(); };
    const route = `${req.method} ${url.pathname}`;
    const tenantWorkdayRequest = /(?:^|\.)wd\d+\.myworkdayjobs\.com(?::\d+)?$/i.test(String(req.headers.host || ''));
    if (tenantWorkdayRequest) workday.tenantRequests.push(`${req.method} ${url.pathname}${url.search}`);
    if (tenantWorkdayRequest && req.method === 'GET' && /\/introduceYourself\/?$/i.test(url.pathname)) {
      workday.talentPoolRequests += 1;
      return send(page('Introduce yourself', '<h1>Introduce yourself</h1><p>This is not an application for a specific job.</p>'));
    }
    if (tenantWorkdayRequest && workday.tenantRouteMode) {
      if (req.method === 'GET' && url.pathname === WORKDAY_LOGIN_PATH) {
        if (state.sessions.has(sessionOf(req))) return redirect(workday.routeLandOnHomeAfterLogin ? WORKDAY_SITE_PATH : WORKDAY_MANUAL_JOB_PATH);
        return send(workdayTenantRouteAccountPage('sign_in'));
      }
      if (req.method === 'GET' && url.pathname === WORKDAY_CREATE_ACCOUNT_PATH) return send(workdayTenantRouteAccountPage('create'));
      if (req.method === 'GET' && url.pathname === WORKDAY_FORGOT_PASSWORD_PATH) return send(workdayTenantRoutePasswordRequestPage());
      if (req.method === 'GET' && url.pathname === WORKDAY_RESET_PASSWORD_PATH) {
        return workday.resetLinkSent && url.searchParams.get('token') === 'synthetic-reset-token'
          ? send(workdayTenantRouteResetPasswordPage())
          : send(page('Lien expiré', '<h1>Ce lien de réinitialisation a expiré.</h1>'));
      }
      if (req.method === 'GET' && url.pathname === WORKDAY_ACTIVATE_PATH) {
        if (url.searchParams.get('token') !== 'synthetic-activation' || workday.activationResends < 1) {
          return send(page('Lien expiré', '<h1>Ce lien d’activation a expiré.</h1>'));
        }
        workday.verifiedAccounts.add(ALIAS);
        return redirect(WORKDAY_LOGIN_PATH);
      }
      if (req.method === 'GET' && url.pathname === WORKDAY_SITE_PATH) return send(workdayTenantRouteHomePage());
      if (req.method === 'GET' && url.pathname === WORKDAY_MY_APPLICATIONS_PATH) {
        if (!state.sessions.has(sessionOf(req))) return redirect(WORKDAY_LOGIN_PATH);
        if (workday.recoveryUsed) workday.recoveryHistoryChecked = true;
        return workday.alreadyApplied
          ? send(page('Mes candidatures', '<h1>Mes candidatures</h1><p>Vous avez déjà postulé à Consultant_R-12345-1.</p>'))
          : send(workdayTenantRouteHistoryPage());
      }
      if (req.method === 'GET' && url.pathname === WORKDAY_MANUAL_JOB_PATH) {
        if (!state.sessions.has(sessionOf(req))) return redirect(WORKDAY_LOGIN_PATH);
        if (workday.alreadyApplied) return send(page('Mes candidatures', '<h1>Mes candidatures</h1><p>Vous avez déjà postulé à Consultant_R-12345-1.</p>'));
      }
      if (req.method === 'POST' && url.pathname === WORKDAY_LOGIN_PATH) {
        const body = new URLSearchParams(await readBody(req));
        const email = String(body.get('email') || '').toLowerCase();
        const password = String(body.get('password') || '');
        if (!workday.accounts.has(email) || workday.accounts.get(email) !== password) {
          return send(workdayTenantRouteAccountPage('sign_in', 'Adresse e-mail ou mot de passe invalide.'));
        }
        workday.logins += 1;
        const sid = `route${++workday.routeSessionSequence}`;
        state.sessions.add(sid);
        const destination = workday.routeLandOnHomeAfterLogin ? WORKDAY_SITE_PATH : WORKDAY_MANUAL_JOB_PATH;
        return redirect(destination, { 'set-cookie': `sid=${sid}; Path=/; Secure; SameSite=Lax` });
      }
      if (req.method === 'POST' && url.pathname === WORKDAY_CREATE_ACCOUNT_PATH) {
        workday.registrations += 1;
        return send(workdayTenantRouteAccountPage('sign_in'));
      }
      if (req.method === 'POST' && url.pathname === WORKDAY_FORGOT_PASSWORD_PATH) {
        const body = new URLSearchParams(await readBody(req));
        const email = String(body.get('email') || '').toLowerCase();
        workday.resetEmails.push(email);
        workday.resetLinkSent = workday.accounts.has(email);
        return send(page('E-mail envoyé', '<h1>Consultez votre messagerie.</h1>'));
      }
      if (req.method === 'POST' && url.pathname === WORKDAY_RESET_PASSWORD_PATH) {
        const body = new URLSearchParams(await readBody(req));
        const email = String(body.get('email') || '').toLowerCase();
        const password = String(body.get('password') || '');
        if (!workday.resetLinkSent || !workday.accounts.has(email) || password !== body.get('confirm')) {
          return send(page('Réinitialisation impossible', '<h1>Le mot de passe n’a pas pu être changé.</h1>'));
        }
        workday.accounts.set(email, password);
        workday.resetLinkSent = false;
        workday.recoveryUsed = true;
        workday.recoveryHistoryChecked = false;
        return redirect(WORKDAY_LOGIN_PATH);
      }
    }
    if (route === 'GET /cookiecheck-cc0.html') {
      const validCookie = /(?:^|;\s*)sid=synthetic-session(?:;|$)/.test(req.headers.cookie || '');
      res.writeHead(url.search ? 500 : 200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ cookie_allowed: validCookie, session_id: validCookie ? 'synthetic-session' : '' }));
    }
    // SIX's SuccessFactors route: a cold direct apply URL falls back to the
    // generic career page. Visiting the matching posting first sets the site
    // cookie, and its own Apply link opens the actual application form.
    if (route === 'GET /job/Zurich-Senior-IT-Manager/1448418433/') {
      state.sixPostingViews += 1;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'sixPostingSeen=1; Path=/' });
      return res.end(bindLocalReceiptTargets(page('Senior IT Manager - CIO Office | SIX Group', '<h1>Senior IT Manager - CIO Office</h1><p>SIX Group</p><a href="/talentcommunity/apply/1448418433/?locale=en_US">Apply now »</a>')));
    }
    if (route === 'GET /talentcommunity/apply/1448418433/') {
      if (!/sixPostingSeen=1/.test(req.headers.cookie || '')) return redirect('/careers.html');
      return send(page('Career Opportunities: Senior IT Manager - CIO Office (8299)', `<h1>Senior IT Manager - CIO Office (8299)</h1><p>SIX Group</p>
        ${form('/six/submit', '<label for="first">First Name *</label><input id="first" name="first" required><label for="email">Email Address *</label><input id="email" name="email" type="email" required><label for="cv">Resume / CV *</label><input id="cv" name="cv" type="file" required><label for="workload">What is your preferred workload? *</label><input id="workload" name="workload" required><button type="submit">Submit application</button>', true)}`));
    }
    if (route === 'GET /careers.html') return send(page('Career Opportunities | SIX', '<h1>Finde deinen Traumjob</h1><label for="search">Suche</label><input id="search" name="search"><button type="button">Finden</button>'));
    if (route === 'POST /six/submit') {
      const body = await readBody(req);
      state.sixApplications.push({ workload: body.match(/name="workload"\r\n\r\n([^\r\n]*)/)?.[1] || '' });
      state.sixApplications.at(-1).hasCv = /name="cv"; filename="CV_Luca_Bianchi\.pdf"/.test(body);
      return send(page('Application received', '<h1>Thank you for your application</h1>'));
    }
    // Talentsoft/RhB's final button has no application noun, just «Senden».
    if (route === 'GET /rhb-form') return send(page('Pflegefachperson', `<h1>Pflegefachperson 80%</h1>${form('/rhb-submit', '<label for="mail">E-Mail *</label><input id="mail" type="email" name="email" required><label for="cv">Lebenslauf *</label><input id="cv" type="file" name="cv" required><button type="submit">Senden</button>', true)}`));
    if (route === 'POST /rhb-submit') {
      const body = await readBody(req);
      state.rhbApplications.push({ hasCv: /filename="CV_/.test(body) });
      return redirect(receiptQuery('/rhb-offer'));
    }
    if (route === 'GET /rhb-offer') return send(page('Pflegefachperson', '<p role="status">Ihre persönlichen Angaben wurden gespeichert. Ihre Bewerbung auf das Stellenangebot TEST-42 – Pflegefachperson (80%) wurde erfolgreich gesendet.</p><h1>Pflegefachperson 80%</h1><a href="/rhb-form">Auf diese Stelle bewerben</a>'));
    if (route === 'GET /job') return send(page('Pflegefachperson', '<section class="job-detail" data-job-id="fixture-80"><h1>Pflegefachperson 80%</h1><a href="/login">Jetzt bewerben</a></section>'));
    // jobs.coopjobs.ch as seen on 2026-10-02: «Später bewerben» (a bookmark by
    // e-mail) comes first, a Usercentrics banner in a shadow root covers the
    // page, «Jetzt bewerben» opens the ATS redirect in a new tab.
    if (route === 'GET /coop-job') {
      return send(page('Coop: Bäcker:in - Konditor:in (Schwerpunkt Bäckerei)', `<header><a role="button" tabindex="0" href="/coop-later">Später bewerben</a></header>
        <section class="job-detail" data-job-id="coop-baecker">
        <h1>Bäcker:in - Konditor:in (Schwerpunkt Bäckerei)</h1><p>Coop Genossenschaft</p><p>Standort Rickenbach</p>
        <a class="main-btn apply" target="_blank" href="/ohws/redirect/20d53107-db26-4a35-8f4c-b4d15bb4bb31/ats/">Jetzt bewerben</a>
        </section>
        <div id="usercentrics-root"></div><script>
          const host = document.getElementById('usercentrics-root');
          const root = host.attachShadow({ mode: 'open' });
          root.innerHTML = '<div style="position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.3)"><div role="dialog" aria-label="Privatsphäre"><p>Diese Website verwendet Cookies.</p><button type="button">Einstellungen verwalten</button><button type="button" id="all">Alle akzeptieren</button></div></div>';
          root.getElementById('all').addEventListener('click', () => host.remove());
        </script>`));
    }
    if (route === 'GET /coop-later') {
      coop.later += 1;
      return send(page('Später bewerben', '<p>Wir senden dir den Link per E-Mail.</p>'));
    }
    // To another host, as Coop's redirect does: SuccessFactors' own (a *.localhost name is the loopback for Chrome).
    if (url.pathname.startsWith('/ohws/redirect/')) return redirect(`${sfOrigin(server)}${SF_JOB}`);
    if (route === 'GET /sf/career') {
      if (coop.sessions.has(sessionOf(req))) {
        return send(sfApplyPage());
      }
      return send(page('Karrierechancen: Anmelden', `<p>Haben Sie schon ein Konto? Mit bestehendem Profil anmelden und bewerben</p>${form('/sf/login', '<label for="u">E-Mail-Adresse:*</label><input id="u" type="text" name="username" required><label for="p">Kennwort:*</label><input id="p" type="password" name="password" required><button type="submit">Anmelden</button>')}<p><a href="/sf/register">Noch kein Profil? Hier registrieren</a> und direkt bewerben</p>${sfCookieManager(req)}`));
    }
    if (route === 'POST /sf/login') {
      const body = new URLSearchParams(await readBody(req));
      if (coop.accounts.get(body.get('username')) !== body.get('password')) return send(page('Karrierechancen: Anmelden', '<p role="alert">Ungültige Anmeldedaten</p>'));
      const sid = Math.random().toString(36).slice(2);
      coop.sessions.add(sid);
      return redirect(SF_JOB, { 'set-cookie': `sid=${sid}; Path=/` });
    }
    // «Konto anlegen»: the privacy statement opens only for a chosen country,
    // and its required review checkbox enables the dialog's accept button.
    if (route === 'GET /sf/register') {
      coop.cookieManager = /sfCookies=(rejected|accepted)/.exec(req.headers.cookie || '')?.[1] || coop.cookieManager;
      return send(page('Karrierechancen: Konto anlegen', `${form('/sf/register', `<label for="e1">E-Mail-Adresse: *</label><input id="e1" type="text" name="email" required>
        <label for="e2">E-Mail-Adresse erneut eingeben: *</label><input id="e2" type="text" name="email2" required>
        <label for="p1">Wähle ein Kennwort: *</label><input id="p1" type="password" name="p1" required>
        <label for="p2">Kennwort erneut eingeben: *</label><input id="p2" type="password" name="p2" required>
        <label for="f">Vorname: *</label><input id="f" name="first" required><label for="l">Nachname: *</label><input id="l" name="last" required>
        <label for="c">Land/Region des Wohnorts:*</label><select id="c" name="country" required><option value="">- Bitte auswählen -</option><option value="CH">Schweiz</option><option value="IT">Italien</option></select>
        <label for="abo">Job-Abo</label><input type="checkbox" id="abo" name="abo">
        <input type="hidden" id="dpcs" name="dpcs" value="">
        <label for="dataPrivacyId">Datenschutzerklärung:*</label><a id="dataPrivacyId" role="button" tabindex="0" aria-haspopup="dialog">Datenschutzerklärung lesen und akzeptieren.</a>
        <div role="dialog" id="unrelatedDialog"><label><input type="checkbox" id="outsideReview"> I have reviewed this privacy notice.</label><button type="button" id="outsideAccept">Accept</button></div>
        <button type="submit">Konto anlegen</button>`)}
        <div role="dialog" id="dpcsDialog" hidden><p>Datenschutzerklärung für Stellenbewerber:innen</p><label><input type="checkbox" id="dpcsReview" name="dpcsReview"> Ich habe die Datenschutzerklärung gelesen und akzeptiere sie.</label><button type="button" id="ok" disabled>Akzeptieren</button><button type="button" id="no">Ablehnen</button></div>
        <script>
          const dialog = document.getElementById('dpcsDialog');
          const review = document.getElementById('dpcsReview');
          const accept = document.getElementById('ok');
          document.getElementById('outsideAccept').addEventListener('click', () => { document.cookie = 'outsideAccept=1; Path=/'; });
          review.addEventListener('change', () => { accept.disabled = !review.checked; });
          // As on Coop's SuccessFactors, the password repeat checks itself on
          // blur and the statement click is lost while that request is active.
          let checking = false;
          document.getElementById('p2').addEventListener('blur', () => {
            checking = true;
            fetch('/sf/pwd-policy', { method: 'POST' }).finally(() => { checking = false; });
          });
          document.getElementById('dataPrivacyId').addEventListener('click', () => { if (!checking && document.getElementById('c').value) dialog.hidden = false; });
          accept.addEventListener('click', () => { if (!review.checked) return; document.getElementById('dpcs').value = '1'; dialog.hidden = true; });
          document.getElementById('no').addEventListener('click', () => { dialog.hidden = true; });
        </script>`));
    }
    if (route === 'POST /sf/pwd-policy') {
      await new Promise((done) => setTimeout(done, 1200));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (route === 'POST /sf/register') {
      if (/outsideAccept=1/.test(req.headers.cookie || '')) coop.outsideAccept += 1;
      const body = new URLSearchParams(await readBody(req));
      const password = String(body.get('p1') || '');
      const problems = [
        body.get('email') !== body.get('email2') && 'email',
        (password !== body.get('p2') || password.length < 8 || password.length > 18 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9\W]/.test(password)) && 'password',
        (!body.get('first') || !body.get('last')) && 'name',
        !body.get('country') && 'country',
        body.get('dpcs') !== '1' && 'dpcs',
      ].filter(Boolean);
      if (body.get('abo')) coop.jobAbo = true;
      if (problems.length) {
        coop.refused.push(problems.join(','));
        return send(page('Karrierechancen: Konto anlegen', `<p role="alert">${problems.join(', ')} ist erforderlich</p>`));
      }
      coop.privacyAccepted += 1;
      coop.accounts.set(body.get('email'), password);
      const sid = Math.random().toString(36).slice(2);
      coop.sessions.add(sid);
      return redirect(SF_JOB, { 'set-cookie': `sid=${sid}; Path=/` });
    }
    if (route === 'POST /sf/upload') {
      const raw = await readBody(req);
      if (/filename="CV_/.test(raw)) coop.cvUploads += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (route === 'POST /sf/apply') {
      const body = new URLSearchParams(await readBody(req));
      coop.applicationPrivacySubmissions.push(body.get('applicationPrivacy') || '');
      if (coop.privacyValidationRetry) {
        coop.privacyValidationRetry = false;
        coop.privacyValidationRetries += 1;
        return send(sfApplyPage(['Please open the data privacy agreement to accept the terms.']));
      }
      const errors = [
        body.get('cv') !== '1' && 'Lebenslauf ist erforderlich',
        !body.get('first') && 'Vorname ist erforderlich',
        !body.get('last') && 'Nachname ist erforderlich',
        !body.get('anrede') && 'Anrede ist erforderlich',
        !body.get('birth') && 'Geburtsdatum ist erforderlich',
        !body.get('agency') && 'Stammt diese Bewerbung von einem Vermittlungsbüro? ist erforderlich',
        body.get('applicationPrivacy') !== '1' && 'Please open the data privacy agreement to accept the terms.',
      ].filter(Boolean);
      if (errors.length) {
        coop.validationRefusals += 1;
        return send(sfApplyPage(errors));
      }
      coop.applications.push({ hasCv: coop.cvUploads > 0, first: body.get('first') || '', anrede: body.get('anrede'), birth: body.get('birth'), agency: body.get('agency') });
      return send(page('Karrierechancen', '<h1>Vielen Dank für deine Bewerbung</h1>'));
    }
    // The posting names the brand, never the company the order names; the form behind the account keeps
    // the account page's title, and the site's language menu sits in its header (Workday, 2026-10-07). Its
    // «Postal Code» is no verification code: taken for one, the run waited for an e-mail nobody sends.
    if (route === 'GET /wd/job') {
      return send(page(
        'Verkaufsberater/in | Acme Retail Switzerland',
        '<section class="job-detail" data-job-id="wd-verkaeufer"><p>Acme Careers</p><h1>Verkaufsberater/in</h1><p>Acme Retail Switzerland</p><a href="/wd/apply">Apply</a></section>',
      ));
    }
    if (route === `GET ${WORKDAY_JOB_PATH}`) {
      const entryUrl = `https://${req.headers.host}`;
      return send(page('Consultant | Careers', `<section class="job-detail">
        <h1>Verkaufsberater/in</h1>
        <button type="button" data-automation-id="adventureButton" onclick="document.getElementById('wd-popup-frame').style.display='block'">Postuler</button>
        <section><h2>Présentez-vous</h2><button type="button" data-automation-id="introduceYourselfButton" onclick="window.location.href='${entryUrl}${WORKDAY_JOB_PATH}/introduceYourself'">Démarrer</button></section>
        <div id="wd-popup-frame" role="dialog" data-automation-id="wd-popup-frame" style="display:none">
          <button type="button" onclick="fetch('/wd/autofill-click',{method:'POST'})">Apply with Autofill</button>
          <button type="button" onclick="fetch('/wd/last-application-click',{method:'POST'})">Use my last application</button>
          <a data-automation-id="applyManually" href="${entryUrl}${WORKDAY_MANUAL_JOB_PATH}">Postuler manuellement</a>
        </div>
      </section>`));
    }
    if (tenantWorkdayRequest && !workday.tenantRouteMode && route === `GET ${WORKDAY_MANUAL_JOB_PATH}`) {
      const view = url.searchParams.get('view') || '';
      if (view === 'password-reset-request') return send(workdayPasswordRequestPage({ tenantMode: true }));
      if (view === 'password-reset') {
        return workday.resetLinkSent && url.searchParams.get('token') === 'synthetic-reset-token'
          ? send(workdayResetPasswordPage({ tenantMode: true }))
          : send(page('Reset link expired', '<h1>This reset link has expired.</h1>'));
      }
      if (view === 'activate') {
        if (url.searchParams.get('token') !== 'synthetic-activation' || workday.activationResends < 1) {
          return send(page('Activation link expired', '<h1>This activation link has expired.</h1>'));
        }
        workday.verifiedAccounts.add(ALIAS);
        return redirect(`${WORKDAY_MANUAL_JOB_PATH}?view=sign-in`);
      }
      if (view === 'home') {
        if (!state.sessions.has(sessionOf(req))) return redirect(`${WORKDAY_MANUAL_JOB_PATH}?view=sign-in`);
        return send(page('Candidate Home', workday.historyUnavailable
          ? '<h1>Candidate Home</h1>'
          : `<h1>Candidate Home</h1><a href="${WORKDAY_MANUAL_JOB_PATH}?view=my-applications">My Applications</a>`));
      }
      if (view === 'my-applications') {
        if (!state.sessions.has(sessionOf(req))) return redirect(`${WORKDAY_MANUAL_JOB_PATH}?view=sign-in`);
        if (workday.recoveryUsed) workday.recoveryHistoryChecked = true;
        return workday.alreadyApplied
          ? send(page('My Applications', '<h1>My Applications</h1><p>You have already applied to Consultant_R-12345-1.</p>'))
          : send(page('My Applications', '<h1>My Applications</h1><p>You have no applications yet.</p>'));
      }
      if (view === 'form') {
        if (!state.sessions.has(sessionOf(req))) return redirect(`${WORKDAY_MANUAL_JOB_PATH}?view=sign-in`);
        // The application form is served by the shared Workday form route below.
      } else {
        if (state.sessions.has(sessionOf(req))) return redirect(`${WORKDAY_MANUAL_JOB_PATH}?view=${workday.recoveryUsed && !workday.recoveryHistoryChecked ? 'home' : 'form'}`);
        return send(workdayAccountPage(view === 'sign-in' ? 'sign_in' : 'create', { buttonSignIn: true, tenantMode: true }));
      }
    }
    if (route === 'GET /wd/password-reset-request') return send(workdayPasswordRequestPage());
    if (route === 'POST /wd/password-reset-request'
      || (tenantWorkdayRequest && route === `POST ${WORKDAY_MANUAL_JOB_PATH}` && url.searchParams.get('view') === 'password-reset-request')) {
      const body = new URLSearchParams(await readBody(req));
      const email = String(body.get('email') || '').toLowerCase();
      workday.resetEmails.push(email);
      workday.resetLinkSent = workday.accounts.has(email);
      return send(page('Check Your Email', '<h1>If an account exists, password reset instructions were sent.</h1>'));
    }
    if (route === 'GET /wd/password-reset') {
      return workday.resetLinkSent && url.searchParams.get('token') === 'synthetic-reset-token'
        ? send(workdayResetPasswordPage())
        : send(page('Reset link expired', '<h1>This reset link has expired.</h1>'));
    }
    if (route === 'POST /wd/password-reset'
      || (tenantWorkdayRequest && route === `POST ${WORKDAY_MANUAL_JOB_PATH}` && url.searchParams.get('view') === 'password-reset')) {
      const body = new URLSearchParams(await readBody(req));
      const email = String(body.get('email') || '').toLowerCase();
      const password = String(body.get('password') || '');
      if (!workday.resetLinkSent || !workday.accounts.has(email) || password !== body.get('confirm')) {
        return send(page('Reset Password', '<h1>The reset could not be completed.</h1>'));
      }
      workday.accounts.set(email, password);
      workday.resetLinkSent = false;
      workday.recoveryUsed = true;
      workday.recoveryHistoryChecked = false;
      return redirect(workday.tenantMode ? `${WORKDAY_MANUAL_JOB_PATH}?view=sign-in` : '/wd/sign-in');
    }
    if (route === 'POST /wd/activation-resend') {
      workday.activationResends += 1;
      res.writeHead(204);
      return res.end();
    }
    if (route === 'GET /wd/activate') {
      if (url.searchParams.get('token') !== 'synthetic-activation' || workday.activationResends < 1) {
        return send(page('Activation link expired', '<h1>This activation link has expired.</h1>'));
      }
      workday.verifiedAccounts.add(ALIAS);
      return redirect('/wd/sign-in');
    }
    if (route === 'GET /wd/home') {
      if (!state.sessions.has(sessionOf(req))) return redirect('/wd/sign-in');
      return send(page('Candidate Home', workday.historyUnavailable
        ? '<h1>Candidate Home</h1>'
        : '<h1>Candidate Home</h1><a href="/wd/my-applications">My Applications</a>'));
    }
    if (route === 'GET /wd/my-applications') {
      if (!state.sessions.has(sessionOf(req))) return redirect('/wd/sign-in');
      return workday.alreadyApplied
        ? send(page('My Applications', '<h1>My Applications</h1><p>You have already applied to Consultant_R-12345-1.</p>'))
        : send(page('My Applications', '<h1>My Applications</h1><p>You have no applications yet.</p>'));
    }
    if (route === 'GET /wd/apply') return state.sessions.has(sessionOf(req)) ? redirect('/wd/form') : send(workdayAccountPage());
    if (route === 'GET /wd/sign-in') return state.sessions.has(sessionOf(req)) ? redirect(workday.recoveryUsed ? '/wd/home' : '/wd/form') : send(workdayAccountPage('sign_in'));
    // The form behind the account. Its «Country» is a listbox button, and choosing draws the address fields
    // anew for that country a moment later, as other elements («Address Line 1» becomes «Street Name»): what
    // was typed before is gone. Its phone code is a search box whose chosen value is a pill next to it: two
    // seconds after Enter the only match is taken by itself and shown as that pill (also an «option» on the
    // page); several matches are listed to choose from (Workday's «My Information», 2026-10-07).
    // `workday.resumed`: the account already holds an application in progress. The first load of the form in
    // a session is then the portal's own «Something went wrong. Please refresh the page and then try again»
    // (its request for a new application is refused), the load after it is the application, and the CV an
    // earlier run uploaded is listed with its «Delete» button.
    if (route === 'GET /wd/form'
      || (tenantWorkdayRequest && route === `GET ${WORKDAY_MANUAL_JOB_PATH}` && url.searchParams.get('view') === 'form')
      || (tenantWorkdayRequest && workday.tenantRouteMode && route === `GET ${WORKDAY_MANUAL_JOB_PATH}`)) {
      if (!state.sessions.has(sessionOf(req))) return redirect(workday.tenantMode ? `${WORKDAY_MANUAL_JOB_PATH}?view=sign-in` : '/wd/apply');
      if (workday.alreadyApplied) return send(page('My Applications', '<h1>My Applications</h1><p>You have already applied to Consultant_R-12345-1.</p>'));
      if (workday.resumed && !workday.refusedOnce.has(sessionOf(req))) {
        workday.refusedOnce.add(sessionOf(req));
        return send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Create Account</title></head><body>
          <header><p>Acme Careers</p></header><main><h1>Verkaufsberater/in</h1><h2>Something went wrong</h2><p>Please refresh the page and then try again.</p><p>Error Code: VPS|0000</p></main></body></html>`);
      }
      return send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Create Account</title></head><body>
        <header><button type="button" aria-haspopup="listbox" aria-label="settingsSelectorButton">English</button><p>Acme Careers</p></header>
        <main><h1>Verkaufsberater/in</h1>
          ${workday.tenantRouteMode ? `<a href="${WORKDAY_MY_APPLICATIONS_PATH}">Mes candidatures</a>` : ''}
          <h2>My Information</h2>
        <form method="post" action="${workday.tenantMode ? `${WORKDAY_MANUAL_JOB_PATH}?view=submit` : '/wd/submit'}" enctype="multipart/form-data">
          <label for="v">Vorname *</label><input id="v" name="first" required><label for="n">Nachname *</label><input id="n" name="last" required>
          <label for="m">E-Mail *</label><input id="m" type="email" name="mail" required>
          <div id="addr"></div><input type="hidden" name="country" id="countryValue" value="United States of America">
          <label for="pcode">Country Phone Code*</label><input id="pcode" data-uxi-widget-type="selectinput" data-uxi-multiselect-id="pc1" autocomplete="off" aria-expanded="false">
          <ul role="listbox"><li id="pill" role="option" data-uxi-widget-type="selectinputlistitem" data-uxi-multiselect-id="pc1">United States of America (+1)</li></ul>
          <input type="hidden" name="phoneCode" id="phoneCodeValue" value="United States of America (+1)">
          <label for="letter">Cover Letter</label><input id="letter" type="file" name="letter">
          <div id="letter-status" aria-live="polite"></div>
          ${workday.nativeCvSelector
            ? '<section id="cv-holder" hidden><h2>CV</h2><input id="cv" data-automation-id="file-upload-input-ref" type="file" name="cv" required style="display:none"><div id="cv-status" aria-live="polite"></div></section><section><h2>CV</h2><button id="select-files" data-automation-id="select-files" type="button">Select file</button></section>'
            : '<label for="cv">Lebenslauf *</label><input id="cv" type="file" name="cv" required><div id="cv-status" aria-live="polite"></div>'}
          ${workday.additionalCvField ? '<section id="additional-cv-holder" hidden><label for="additional-cv">Additional CV *</label><input id="additional-cv" type="file" name="additionalCv" required><div id="additional-cv-status" aria-live="polite"></div></section>' : ''}
          ${workday.resumed ? '<div id="kept"><span>candidate-cv.pdf successfully uploaded</span><input type="hidden" name="kept" value="candidate-cv.pdf"><button type="button" id="del" aria-label="Delete" style="width:24px;height:24px"></button></div>' : ''}
          <section><h2>Work Experience</h2><div id="experience-rows"></div><button type="button" id="add-experience">Add</button></section>
          <section><h2>Education</h2><div id="education-rows"></div><button type="button" id="add-education">Add</button></section>
          <button type="submit">Bewerbung absenden</button>
        </form>
        <ul id="countries" role="listbox" style="display:none"><li role="option">Switzerland</li><li role="option">United States of America</li></ul>
        <ul id="codes" role="listbox" style="display:none"></ul></main>
        <script>
          const el = (id) => document.getElementById(id);
          const draw = (country) => {
            el('addr').innerHTML = '<button type="button" id="country" aria-haspopup="listbox" aria-label="Country*">' + country + '</button>' + (country === 'Switzerland'
              ? '<label for="st">Street Name</label><input id="st" name="street"><label for="pc">Postcode</label><input id="pc" name="postcode">'
              : '<label for="a1">Address Line 1</label><input id="a1" name="address1"><label for="pc">Postal Code</label><input id="pc" name="postalCode">');
            el('country').onclick = () => { el('countries').style.display = 'block'; };
            el('country').onkeydown = (event) => { if (event.key === 'Escape') el('countries').style.display = 'none'; };
          };
          const routeChangesBeforeUpload = ${workday.routeChangesBeforeUpload ? 'true' : 'false'};
          draw('United States of America');
          if (el('select-files')) el('select-files').onclick = async () => { await fetch('/wd/select-file', { method: 'POST' }); el('cv-holder').hidden = false; el('cv').click(); };
          if (el('del')) el('del').onclick = () => { fetch('/wd/delete-file', { method: 'POST' }); el('kept').remove(); };
          el('cv').addEventListener('change', async () => {
            const body = new FormData();
            body.append('cv', el('cv').files[0]);
            const request = ${workday.uploadFails
              ? "{ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: el('cv').files[0].name }) }"
              : "{ method: 'POST', body }"};
            const response = await fetch('/wd/upload', request);
            if (response.ok) {
              el('cv-status').textContent = el('cv').files[0].name + ' successfully uploaded';
              if (el('additional-cv-holder')) el('additional-cv-holder').hidden = false;
            }
            else el('cv-status').textContent = el('cv').files[0].name;
          });
          if (el('additional-cv')) el('additional-cv').addEventListener('change', async () => {
            const body = new FormData();
            body.append('cv', el('additional-cv').files[0]);
            const response = await fetch('/wd/upload-additional-cv', { method: 'POST', body });
            if (response.ok) el('additional-cv-status').textContent = el('additional-cv').files[0].name + ' successfully uploaded';
          });
          const uploadLetter = async () => {
            const body = new FormData();
            body.append('letter', el('letter').files[0]);
            const request = ${workday.coverLetterUploadFails
              ? "{ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: el('letter').files[0].name }) }"
              : "{ method: 'POST', body }"};
            const response = await fetch('/wd/upload-letter', request);
            if (response.ok) el('letter-status').textContent = el('letter').files[0].name + ' successfully uploaded';
            else {
              el('letter-status').textContent = el('letter').files[0].name;
              const previous = el('letter');
              const replacement = previous.cloneNode(false);
              replacement.removeAttribute('data-aa-id');
              replacement.addEventListener('change', uploadLetter);
              previous.replaceWith(replacement);
            }
          };
          el('letter').addEventListener('change', uploadLetter);
          const addProfileRow = (kind) => {
            const root = el(kind + '-rows');
            const row = document.createElement('fieldset');
            const index = document.querySelectorAll('[data-profile-editor]').length + 1;
            const experience = kind === 'experience';
            const labels = experience
              ? [['role', 'Job Title'], ['employer', 'Employer'], ['start', 'Start Date'], ['end', 'End Date']]
              : [['degree', 'Degree'], ['institution', 'Institution'], ['start', 'Start Date'], ['end', 'End Date']];
            row.dataset.profileEditor = kind;
            row.innerHTML = '<legend>' + (experience ? 'Work Experience Entry' : 'Education Entry') + '</legend>'
              + labels.map(([key, label]) => '<label for="profile-' + kind + '-' + index + '-' + key + '">' + label + ' *</label><input required id="profile-' + kind + '-' + index + '-' + key + '" name="' + key + '">').join('')
              + '<button type="button" data-profile-save>Save</button><button type="button" data-profile-cancel>Cancel</button>';
            row.querySelector('[data-profile-save]').onclick = () => {
              const values = labels.map(([key]) => row.querySelector('[name="' + key + '"]').value);
              const hidden = document.createElement('input');
              hidden.type = 'hidden'; hidden.name = kind; hidden.value = values.join('|');
              el('cv').form.append(hidden);
              row.remove();
            };
            row.querySelector('[data-profile-cancel]').onclick = () => row.remove();
            root.append(row);
          };
          el('add-experience').onclick = () => addProfileRow('experience');
          el('add-education').onclick = () => addProfileRow('education');
          for (const option of el('countries').children) {
            option.onclick = () => {
              el('countries').style.display = 'none';
              el('countryValue').value = option.textContent;
              if (routeChangesBeforeUpload) {
                const otherPosting = location.pathname.replace('Consultant_R-12345-1', 'Consultant_R-99999-2');
                history.pushState({}, '', otherPosting + location.search);
              }
              setTimeout(() => draw(option.textContent), 400);
            };
          }
          el('pcode').onkeydown = (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            el('pcode').setAttribute('aria-expanded', 'true');
            const choose = (code) => { el('phoneCodeValue').value = code; el('pill').textContent = code; el('pcode').value = code; el('pcode').setAttribute('aria-expanded', 'false'); el('codes').style.display = 'none'; };
            setTimeout(() => {
              const matches = ['Switzerland (+41)', 'Italy (+39)'].filter((code) => code.includes(el('pcode').value));
              if (matches.length === 1) return choose(matches[0]);
              el('codes').innerHTML = matches.map((code) => '<li role="option">' + code + '</li>').join('');
              el('codes').style.display = 'block';
              for (const option of el('codes').children) option.onclick = () => choose(option.textContent);
            }, 2000);
          };
        </script></body></html>`);
    }
    if (route === 'POST /wd/submit'
      || (tenantWorkdayRequest && route === `POST ${WORKDAY_MANUAL_JOB_PATH}` && url.searchParams.get('view') === 'submit')) {
      const raw = await readBody(req);
      const part = (name) => new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`).exec(raw)?.[1] || '';
      const many = (name) => [...raw.matchAll(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`, 'g'))].map((match) => match[1]);
      workday.forms.push({ first: part('first'), country: part('country'), street: part('street'), postcode: part('postcode'), address1: part('address1'), phoneCode: part('phoneCode'), kept: part('kept'), experience: many('experience'), education: many('education') });
      state.applications.push({ hasCv: /name="cv"; filename="/i.test(raw), cvFiles: (raw.match(/name="cv"; filename="/gi) || []).length, first: part('first') });
      if (workday.recoveryUsed) workday.alreadyApplied = true;
      return send(page('Danke', '<h1>Vielen Dank für Ihre Bewerbung</h1>'));
    }
    if (route === 'POST /wd/upload') {
      workday.cvUploads += 1;
      const uploadBody = await readBody(req);
      if (/multipart\/form-data/i.test(String(req.headers['content-type'] || ''))
        && /name="cv"; filename="/i.test(uploadBody)) workday.nativeCvMultipartUploads += 1;
      res.writeHead(workday.uploadFails ? 500 : 204);
      return res.end();
    }
    if (route === 'POST /wd/select-file') {
      workday.nativeCvSelectorClicks += 1;
      res.writeHead(204);
      return res.end();
    }
    if (route === 'POST /wd/upload-additional-cv') {
      workday.additionalCvUploads += 1;
      await readBody(req);
      res.writeHead(204);
      return res.end();
    }
    if (route === 'POST /wd/upload-letter') {
      workday.coverLetterUploads += 1;
      await readBody(req);
      res.writeHead(workday.coverLetterUploadFails ? 500 : 204);
      return res.end();
    }
    if (route === 'POST /wd/delete-file') {
      workday.deletedFiles += 1;
      res.writeHead(204);
      return res.end();
    }
    if (route === 'POST /wd/dropped' || route === 'POST /wd/header' || route === 'POST /wd/autofill-click' || route === 'POST /wd/last-application-click') {
      if (route === 'POST /wd/header') workday.headerSignIns += 1;
      else if (route === 'POST /wd/autofill-click') workday.choiceClicks.autofill += 1;
      else if (route === 'POST /wd/last-application-click') workday.choiceClicks.lastApplication += 1;
      else workday.dropped += 1;
      res.writeHead(204);
      return res.end();
    }
    if (route === 'POST /wd/register' || route === 'POST /wd/login') {
      const body = new URLSearchParams(await readBody(req));
      const json = (answer, headers = {}) => { res.writeHead(200, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(answer)); };
      if (route === 'POST /wd/register') {
        workday.registrations += 1;
        // «created»: the account is made, and the answer still never comes.
        if (workday.silent === 'created') workday.accounts.set(body.get('email'), body.get('password'));
        if (workday.silent) return json({ silent: true });
        if (workday.accounts.has(body.get('email'))) return json({ ok: false, message: 'An account already exists for this email address.' });
        workday.accounts.set(body.get('email'), body.get('password'));
        workday.verifiedAccounts.add(body.get('email'));
        return json({ ok: true, message: 'Your account has been created.' });
      }
      workday.logins += 1;
      if (workday.accounts.get(body.get('email')) !== body.get('password')) return json({ ok: false, message: 'Invalid Username/Password' });
      if (!workday.verifiedAccounts.has(body.get('email'))) {
        return json({ ok: false, message: 'Please verify your email address to activate your account.' });
      }
      const sid = Math.random().toString(36).slice(2);
      state.sessions.add(sid);
      return json({ ok: true }, { 'set-cookie': `sid=${sid}; Path=/` });
    }
    if (route === 'GET /login') {
      if (state.sessions.has(sessionOf(req))) return redirect('/apply');
      return send(loginForm());
    }
    if (route === 'POST /login') {
      const body = new URLSearchParams(await readBody(req));
      const email = body.get('email');
      if (state.accounts.get(email) !== body.get('password')) return send(loginForm('Falsches Kennwort'));
      if (state.unverifiedLoginStaysOnSignIn && !state.verified.has(email)) return send(loginForm('Ungültige Anmeldedaten'));
      if (!state.verified.has(email)) return send(page('Bestätigung', '<p>Bitte bestätigen Sie zuerst Ihre E-Mail-Adresse.</p>'));
      const sid = Math.random().toString(36).slice(2);
      state.sessions.add(sid);
      return redirect('/apply', { 'set-cookie': `sid=${sid}; Path=/` });
    }
    if (route === 'GET /register') {
      const submit = state.omitNextRegistrationSubmit ? '' : '<button type="submit">Konto erstellen</button>';
      state.omitNextRegistrationSubmit = false;
      return send(registrationForm({ submit: Boolean(submit) }));
    }
    if (route === 'POST /register') {
      const body = new URLSearchParams(await readBody(req));
      state.registrationRequests += 1;
      if (state.registrationInvalidOnlyOnce) {
        state.registrationInvalidOnlyOnce = false;
        return send(registrationForm({ invalidEmail: true }));
      }
      if (state.registrationValidationOnce) {
        state.registrationValidationOnce = false;
        state.registrationNeedsAnswer = state.registrationNeedsAnswerAfterValidation;
        return send(registrationForm({ error: 'Ungültig' }));
      }
      if (state.refuseNextRegistration || body.get('p1') !== body.get('p2') || !body.get('privacy') || String(body.get('p1')).length < 12) {
        state.refuseNextRegistration = false;
        return send(page('Registrieren', '<p role="alert">Ungültig</p>'));
      }
      if (body.get('news')) state.newsletter = true;
      state.registeredPermit = body.get('permit') || '';
      state.accounts.set(body.get('email'), body.get('p1'));
      state.pending = { email: body.get('email'), token: `tok${Math.random().toString(36).slice(2)}` };
      return send(page('E-Mail gesendet', '<p>Wir haben Ihnen eine E-Mail gesendet. Bitte bestätigen Sie Ihre E-Mail-Adresse über den Link.</p>'));
    }
    if (route === 'GET /activate') {
      if (!state.pending || url.searchParams.get('t') !== state.pending.token) return send(page('Fehler', '<p>Ungültiger Link</p>'));
      state.verified.add(state.pending.email);
      return redirect('/login');
    }
    if (route === 'GET /apply') {
      if (!state.sessions.has(sessionOf(req))) return redirect('/login');
      return send(page('Bewerbung', form('/apply', '<label for="v">Vorname *</label><input id="v" name="first" required><label for="n">Nachname *</label><input id="n" name="last" required><label for="m">E-Mail *</label><input id="m" type="email" name="mail" required><label for="cv">Lebenslauf *</label><input id="cv" type="file" name="cv" required><button type="submit">Bewerbung absenden</button>', true)));
    }
    if (route === 'POST /apply') {
      const raw = await readBody(req);
      state.applications.push({ hasCv: /filename="CV_/.test(raw), first: /name="first"\r\n\r\n([^\r]*)/.exec(raw)?.[1] || '' });
      return send(page('Danke', '<h1>Vielen Dank für Ihre Bewerbung</h1>'));
    }
    if (route === 'GET /gravity-modal-job') {
      const days = Array.from({ length: 31 }, (_, index) => `<option value="${String(index + 1).padStart(2, '0')}.">${index + 1}.</option>`).join('');
      const months = Array.from({ length: 12 }, (_, index) => `<option value="${String(index + 1).padStart(2, '0')}">${index + 1}</option>`).join('');
      const years = Array.from({ length: 31 }, (_, index) => `<option value="${1980 + index}">${1980 + index}</option>`).join('');
      return send(page('Bewerbung: Fachperson Betreuung', `<h1>Fachperson Betreuung 80%</h1>
        <a class="button gravity-opener" href="#">Jetzt bewerben</a><a class="button gravity-opener" href="#">Jetzt bewerben</a>
        <div class="job-application-modal" id="gravity-modal" style="position:fixed;inset:5%;background:white;z-index:2">
          <div id="gform_wrapper_1">
          <form id="gform_1" method="post" action="/gravity-submit" enctype="multipart/form-data">
            <section id="gravity-step-one">
              <label for="gravity-first">Vorname *</label><input id="gravity-first" name="first" required>
              <label for="gravity-last">Nachname *</label><input id="gravity-last" name="last" required>
              <label for="gravity-email">E-Mail *</label><input id="gravity-email" type="email" name="email" required>
              <label for="gravity-day">Geburtstag Tag</label><select id="gravity-day" name="birthDay" required><option value="">Tag</option>${days}</select>
              <label for="gravity-month">Geburtstag Monat</label><select id="gravity-month" name="birthMonth" required><option value="">Monat</option>${months}</select>
              <label for="gravity-year">Geburtstag Jahr</label><select id="gravity-year" name="birthYear" required><option value="">Jahr</option>${years}</select>
              <button type="button" id="gravity-next">Weiter</button>
            </section>
            <section id="gravity-step-two" hidden>
              <label for="gravity-cv">Lebenslauf *</label><input id="gravity-cv" type="file" name="cv" required>
              <label for="gravity-start">Frühester Eintritt</label><input id="gravity-start" type="date" name="startDate">
              <button type="button" id="gravity-previous">Previous</button>
              <button type="submit">Abschicken</button>
            </section>
          </form>
          </div>
        </div>
        <script>
          for (const opener of document.querySelectorAll('.gravity-opener')) opener.addEventListener('click', async (event) => {
            event.preventDefault(); await fetch('/gravity-opener-click', { method: 'POST' });
          });
          document.getElementById('gravity-next').addEventListener('click', async () => {
            const body = new URLSearchParams({
              day: document.getElementById('gravity-day').value,
              month: document.getElementById('gravity-month').value,
              year: document.getElementById('gravity-year').value,
            });
            await fetch('/gravity-birth-date', { method: 'POST', body });
            document.getElementById('gravity-step-one').hidden = true;
            document.getElementById('gravity-step-two').hidden = false;
          });
          document.getElementById('gform_1').addEventListener('submit', async (event) => {
            event.preventDefault();
            const response = await fetch('/gravity-submit', { method: 'POST', body: new FormData(event.target) });
            if (response.ok) document.getElementById('gform_wrapper_1').innerHTML = '<div class="gform_confirmation_wrapper" id="gform_confirmation_wrapper_1"><div class="gform_confirmation_message" id="gform_confirmation_message_1">Vielen Dank für Ihre Bewerbung. Ihre Bewerbung ist eingegangen.</div></div>';
          });
        </script>`));
    }
    if (route === 'GET /gravity-iframe-job') {
      return send(page('Bewerbung: Fachperson Betreuung', `<h1>Fachperson Betreuung 80%</h1>
        <iframe title="Application form" src="/gravity-iframe-form" style="width:100%;height:900px;border:0"></iframe>`));
    }
    if (route === 'GET /gravity-iframe-form') {
      return send(page('Bewerbung', `<h1>Bewerbung</h1>
        <button type="button" class="button gravity-iframe-opener">Jetzt bewerben</button>
        <div id="gform_wrapper_2">
          <form id="gform_2" method="post" action="/gravity-submit" enctype="multipart/form-data">
            <label for="gravity-iframe-first">Vorname *</label><input id="gravity-iframe-first" name="first" required>
            <label for="gravity-iframe-last">Nachname *</label><input id="gravity-iframe-last" name="last" required>
            <label for="gravity-iframe-email">E-Mail *</label><input id="gravity-iframe-email" type="email" name="email" required>
            <label for="gravity-iframe-cv">Lebenslauf *</label><input id="gravity-iframe-cv" type="file" name="cv" required>
            <button type="submit">ABSCHICKEN</button>
          </form>
        </div>
        <script>
          document.querySelector('.gravity-iframe-opener').addEventListener('click', async (event) => {
            event.preventDefault(); await fetch('/gravity-opener-click', { method: 'POST' });
          });
          document.getElementById('gform_2').addEventListener('submit', async (event) => {
            event.preventDefault();
            const response = await fetch('/gravity-submit', { method: 'POST', body: new FormData(event.target) });
            if (response.ok) document.getElementById('gform_wrapper_2').innerHTML = '<div class="gform_confirmation_wrapper" id="gform_confirmation_wrapper_2"><div class="gform_confirmation_message" id="gform_confirmation_message_2">Thank you for your application. Your application has been received.</div></div>';
          });
        </script>`));
    }
    if (route === 'POST /gravity-opener-click') {
      state.gravityApplication.openerClicks += 1;
      res.writeHead(204); return res.end();
    }
    if (route === 'POST /gravity-birth-date') {
      const body = new URLSearchParams(await readBody(req));
      state.gravityApplication.day = body.get('day') || '';
      state.gravityApplication.month = body.get('month') || '';
      state.gravityApplication.year = body.get('year') || '';
      res.writeHead(204); return res.end();
    }
    if (route === 'POST /gravity-submit') {
      const raw = await readBody(req);
      state.gravityApplication.submissions += 1;
      state.gravityApplication.hasCv = /filename="CV_/.test(raw);
      res.writeHead(204); return res.end();
    }
    // A form with a custom calendar the filler cannot read (JOIN's "Quando sei
    // nato?"): the send button stays disabled until a day is chosen.
    if (route === 'GET /widget-job') return send(page('Pflegefachperson', '<section class="job-detail" data-job-id="fixture-60"><h1>Pflegefachperson 60%</h1><a href="/widget">Jetzt bewerben</a></section>'));
    if (route === 'GET /widget') {
      const days = ['11', '12'].map((day) => `<div role="button" tabindex="0" aria-label="Choose ${day} May 1990" data-d="1990-05-${day}">${day}</div>`).join('');
      return send(page('Bewerbung', `${form('/widget', `<label for="v">Vorname *</label><input id="v" name="first" required><label for="m">E-Mail *</label><input id="m" type="email" name="mail" required><label for="cv">Lebenslauf *</label><input id="cv" type="file" name="cv" required><h2>Geburtsdatum *</h2><input type="hidden" id="dob" name="dob"><div role="group" aria-label="Mai 1990">${days}</div><button type="submit" id="send" disabled>Bewerbung absenden</button>`, true)}
        <script>document.querySelectorAll('[data-d]').forEach((day) => day.addEventListener('click', () => { document.getElementById('dob').value = day.dataset.d; day.setAttribute('aria-pressed', 'true'); document.getElementById('send').disabled = false; }));</script>`));
    }
    // A summary page whose send button has an unusual name, and a dead end (self-correction).
    if (route === 'GET /summary') {
      return send(page('Zusammenfassung', `<h1>Ihre Bewerbung</h1><p>Bitte prüfen Sie Ihre Angaben.</p>${form('/summary', '<button type="submit">Abschliessen und übermitteln</button>')}`));
    }
    if (route === 'POST /summary') {
      state.summarySubmissions += 1;
      return send(page('Danke', '<h1>Vielen Dank für Ihre Bewerbung</h1>'));
    }
    // The same unusual send button under a required CV: the upload counts as filled.
    if (route === 'GET /summary-cv') {
      return send(page('Zusammenfassung', `<h1>Ihre Bewerbung</h1>${form('/summary-cv', '<label for="cv">Lebenslauf *</label><input id="cv" type="file" name="cv" required><button type="submit">Abschliessen und übermitteln</button>', true)}`));
    }
    if (route === 'POST /summary-cv') {
      const raw = await readBody(req);
      state.summaryCv.push({ hasCv: /filename="CV_/.test(raw) });
      return send(page('Danke', '<h1>Vielen Dank für Ihre Bewerbung</h1>'));
    }
    if (route === 'GET /dead-end') return send(page('Bewerbung', '<h1>Bewerbung</h1><p>Diese Seite ist leer.</p>'));
    // JOIN 2026-10-01: an invisible reCAPTCHA scores the browser; the send click does nothing visible.
    if (route === 'GET /antibot') {
      return send(page('Bewerbung', `<h1>Ihre Bewerbung</h1><div class="grecaptcha-badge" style="width:256px;height:60px"></div>${form('/antibot', '<button type="submit">Bewerbung absenden</button>').replace('<form ', '<form onsubmit="return false" ')}`));
    }
    // Lever, TSMG 2026-10-01: the send click serves an hCaptcha challenge nobody passes; the form stays as it was.
    if (route === 'GET /hchallenge') {
      return send(page('Application', `<h1>Submit your application</h1>${form('/hchallenge', '<button type="submit">Submit application</button>').replace('<form ', '<form onsubmit="fetch(\'https://api.hcaptcha.com/getcaptcha/e2e-site\', { method: \'POST\' }).catch(() => {}); return false" ')}`));
    }
    // JOIN run 36846326334: the portal answers the send click with its own refusal toast.
    // Keep generic thank-you copy too: refusal must win when an error page is mixed.
    if (route === 'GET /refused') {
      return send(page('Candidatura', `<h1>La tua candidatura</h1><div class="grecaptcha-badge" style="width:256px;height:60px"></div><div id="toast" role="status"></div>${form('/refused', '<button type="submit">Conferma e applica</button>').replace('<form ', '<form onsubmit="document.getElementById(\'toast\').textContent = \'La ringraziamo per la sua candidatura. Non siamo riusciti a inviare la tua candidatura. Riprova.\'; return false" ')}`));
    }
    // Client validation and a JSON error with HTTP 200 were invisible to the old diagnostics.
    if (route === 'GET /diagnostic-refused') {
      return send(page('Candidatura', `<h1>La tua candidatura</h1><form id="diagnostic" method="post" action="/diagnostic-refused"><input id="profile" type="url" aria-label="LinkedIn" required hidden><div id="toast" role="status"></div><button type="button" onclick="submitTest()">Conferma e applica</button></form><script>
        async function submitTest() {
          document.getElementById('profile').value = 'invalid-url';
          const result = await fetch('/diagnostic-error', {method:'POST'}).then(response => response.json());
          console.error(result.errors[0].message + ' token=private-test-token');
          setTimeout(() => { throw new Error('client_submit_validation'); }, 0);
          document.getElementById('toast').textContent = 'Non siamo riusciti a inviare la tua candidatura. Riprova.';
        }
      </script>`));
    }
    if (route === 'POST /diagnostic-error') {
      const body = JSON.stringify({ errors: [{ field: 'linkedin', code: 'INVALID_URL', message: 'Profile URL invalid' }] });
      // JOIN returns chunked GraphQL errors: no declared Content-Length.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.flushHeaders();
      return res.end(body);
    }
    if (route === 'GET /thank-you') return send(page('Application', '<h1>Thank you very much for your application for Concierge Host (m/w/d)</h1><p>We will get in touch with you.</p>'));
    // The refusal shown on an error page the portal moves to (review of #10741).
    if (route === 'GET /refused-moved') {
      return send(page('Candidatura', `<h1>La tua candidatura</h1>${form('/refused-moved', '<button type="submit">Conferma e applica</button>')}`));
    }
    if (route === 'POST /refused-moved') return redirect('/refused-moved/error');
    if (route === 'GET /refused-moved/error') return send(page('Errore', '<p role="alert">Non siamo riusciti a inviare la tua candidatura. Riprova.</p>'));
    if (route === 'POST /widget') {
      const raw = await readBody(req);
      state.widgetApplications.push({ hasCv: /filename="CV_/.test(raw), dob: /name="dob"\r\n\r\n([^\r]*)/.exec(raw)?.[1] || '' });
      return send(page('Danke', '<h1>Vielen Dank für Ihre Bewerbung</h1>'));
    }
    // A hotel's own career page: «Apply» opens umantis, on another host, in a new tab.
    if (route === 'GET /hotel-job') {
      return send(page('Concierge Host (m/w/d) | Grand Hotel Esempio', `<section class="job-detail" data-job-id="hotel-concierge"><h1>Concierge Host (m/w/d)</h1>
        <p>Grand Hotel Esempio</p><a target="_blank" href="${umantisOrigin(server)}${UMANTIS_FORM}">Apply</a></section>
        <p>Pontresina</p><button type="button">ACCEPT COOKIES</button>`));
    }
    if (route === `GET ${HOTEL_NO_H1_PATH}` || route === `GET ${HOTEL_NO_H1_OTHER_TITLE_PATH}`) {
      const otherTitle = route === `GET ${HOTEL_NO_H1_OTHER_TITLE_PATH}`;
      const title = otherTitle ? 'Chef de Rang' : 'Concierge Host (m/w/d)';
      const applyPath = otherTitle ? HOTEL_NO_H1_OTHER_TITLE_PATH : HOTEL_NO_H1_PATH;
      return send(page(title, `<header><nav><button type="button">open navigation</button></nav></header>
        <section class="job-detail" data-job-id="hotel-concierge-no-heading">
          <p>Grand Hotel Esempio</p><p>Concierge Host (m/w/d)</p>
          <a class="button" href="${localOrigin(server)}${applyPath}/apply">Applica ora</a>
        </section>`));
    }
    if (route === `GET ${HOTEL_NO_H1_PATH}/apply` || route === `GET ${HOTEL_NO_H1_OTHER_TITLE_PATH}/apply`) return send(umantisForm());
    if (route === 'GET /hotel-job-other-role') {
      return send(page('Chef de Rang | Grand Hotel Esempio', `<section class="job-detail" data-job-id="hotel-chef-de-rang"><h1>Chef de Rang</h1>
        <p>Grand Hotel Esempio</p><a target="_blank" href="${umantisOrigin(server)}${UMANTIS_FORM}">Apply</a></section>`));
    }
    if (route === `GET ${UMANTIS_FORM}`) return send(umantisForm());
    if (route === 'GET /hotel-job-closed') {
      return send(page('Concierge Host (m/w/d) | Grand Hotel Esempio', `<section class="job-detail" data-job-id="hotel-concierge-closed"><h1>Concierge Host (m/w/d)</h1>
        <p>Grand Hotel Esempio</p><a target="_blank" href="${umantisOrigin(server)}${UMANTIS_CLOSED_FORM}">Apply</a></section>
        <p>Pontresina</p>`));
    }
    if (route === `GET ${UMANTIS_CLOSED_FORM}`) return send(umantisForm('', { closed: true }));
    if (route === 'POST /umantis-upload') {
      await new Promise((done) => setTimeout(done, 1500));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"stored":true}');
    }
    if (route === `POST ${UMANTIS_FORM}`) {
      const raw = await readBody(req);
      const value = (name) => new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`).exec(raw)?.[1] || '';
      const sent = (name) => new RegExp(`name="${name}"; filename="[^"]+"`).test(raw);
      const password = value('pwd');
      const weak = password.length < 7 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password);
      const missing = ['title', 'first', 'last', 'mail', 'phone', 'hear', 'release', 'privacy'].filter((name) => !value(name));
      // A file chosen but not stored yet never arrives with the application.
      const problems = [...missing, weak && 'password', (!sent('cv') || !value('cv_stored')) && 'resume', sent('letter') && !value('letter_stored') && 'cover letter'].filter(Boolean);
      if (problems.length) {
        umantis.refused.push(problems.join(','));
        return send(umantisForm(`Please complete: ${problems.join(', ')}`));
      }
      umantis.accounts.set(value('mail'), password);
      umantis.applications.push({
        first: value('first'), title: value('title'), hear: value('hear'), release: value('release'), employee: Boolean(value('employee')),
        cv: /name="cv"; filename="CV_/.test(raw), letter: sent('letter'), photo: sent('photo'), other: sent('other'),
      });
      return redirect(`/thank-you${url.search}`);
    }
    res.writeHead(404);
    res.end();
  });
  const hasCurrentReceiptKey = (value) => {
    try { return new URL(value).searchParams.get(receiptJobParam) === receiptJobId; } catch { return false; }
  };
  return { server, state, coop, umantis, workday, bindReceiptJobId, hasCurrentReceiptKey };
}

/**
 * Agent stand-in (agent.mjs): clicks the birth date's day on the snapshot's
 * ref, then says the page is done. The answer comes from the profile when the
 * candidate data has one; without it, it is invented ("rule") and the code
 * guard must turn it into a question for the candidate.
 */
let agentTurns = 0;
function fakeAgent(prompt) {
  agentTurns += 1;
  const snapshot = prompt.slice(prompt.indexOf('Page snapshot:'));
  const { agentPage } = JSON.parse(prompt.slice(prompt.indexOf('{"agentPage"'), prompt.indexOf('\n\nPage snapshot:')));
  const turn = (status, actions = [], extra = {}) => ({ status, reason: '', advanceRef: '', submitRef: '', actions, questions: [], ...extra });
  // The last page's send button with an unusual name: named, never pressed (self-correction, level 1).
  const send = /button "Abschliessen und übermitteln" \[ref=(\w+)\]/.exec(snapshot);
  if (send) return turn('done', [], { submitRef: send[1] });
  if (agentPage.history.length) return turn('done');
  const day = /button "Choose 12 May 1990" \[ref=(\w+)\]/.exec(snapshot);
  const source = /"dateOfBirth":"\d/.test(prompt) ? 'profile' : 'rule';
  return turn('act', day ? [{ ref: day[1], action: 'click', value: '', document: 'none', question: 'Geburtsdatum *', answer: '1990-05-12', source }] : []);
}

// A password field must never reach the planner: the runner types it (account.mjs).
let plannerSawPassword = false;
let plannerSawPrivacyCheckboxJa = false;

/** Planner stand-in: answers by label, as the real planner does for these fields. */
async function fakeCodex({ prompt }) {
  if (prompt.includes('{"agentPage"')) return fakeAgent(prompt);
  if (prompt.includes('You localize questions from an online job application')) {
    const start = prompt.lastIndexOf('{"questions":');
    const end = prompt.lastIndexOf('\n\nReturn exactly one JSON object');
    const request = JSON.parse(prompt.slice(start, end));
    return { questions: request.questions.map((question) => {
      const applicationQuestion = question.applicationQuestion || question.question || '';
      if (/geburtsdatum|birth date|date of birth/i.test(applicationQuestion)) {
        return {
          id: question.id,
          sourceLocale: 'de',
          question: 'Qual è la tua data di nascita?',
          why: 'Il portale richiede la tua data di nascita.',
          options: [],
          optionMap: [],
          validationMessage: '',
        };
      }
      if (/^title\b|salutation|form of address/i.test(applicationQuestion)) {
        const optionMap = (question.applicationOptions || question.options || []).map((application) => ({
          candidate: /^mr\.?$/i.test(application) ? 'Signor' : /^mrs?\.?$|^ms\.?$/i.test(application) ? 'Signora' : /^other$/i.test(application) ? 'Altro' : '',
          application,
        }));
        if (optionMap.some((pair) => !pair.candidate)) {
          fakeLocalizationUnknowns.push(safeFixtureLabel(applicationQuestion));
          throw new Error('fake_localizer_unknown_fixture');
        }
        return {
          id: question.id,
          sourceLocale: 'en',
          question: 'Quale appellativo vuoi usare nei moduli di candidatura?',
          why: 'Il portale richiede di scegliere un appellativo.',
          options: optionMap.map((pair) => pair.candidate),
          optionMap,
          validationMessage: '',
        };
      }
      if (/data release|data retention|retention period/i.test(applicationQuestion)) {
        const optionMap = (question.applicationOptions || question.options || []).map((application) => ({
          candidate: /stored|keep|retain|future/i.test(application)
            ? 'Acconsento alla conservazione dei miei dati anche dopo questa candidatura per future opportunità di lavoro.'
            : /deleted|delete|present application process/i.test(application)
              ? 'Desidero che i miei dati siano cancellati al termine dell’attuale procedura di candidatura.'
              : '',
          application,
        }));
        if (optionMap.some((pair) => !pair.candidate)) {
          fakeLocalizationUnknowns.push(safeFixtureLabel(applicationQuestion));
          throw new Error('fake_localizer_unknown_fixture');
        }
        return {
          id: question.id,
          sourceLocale: 'en',
          question: 'Per quanto tempo autorizzi il portale a conservare i tuoi dati personali?',
          why: 'Scegli per quanto tempo autorizzi la conservazione dei dati.',
          options: optionMap.map((pair) => pair.candidate),
          optionMap,
          validationMessage: '',
        };
      }
      if (/privacy policy|privacy statement|data protection/i.test(applicationQuestion)) {
        return {
          id: question.id,
          sourceLocale: 'en',
          question: 'Accetti la dichiarazione sulla protezione dei dati?',
          why: 'Il portale richiede di accettare la dichiarazione sulla protezione dei dati.',
          options: [],
          optionMap: [],
          validationMessage: '',
        };
      }
      if (!/valid work permit/i.test(applicationQuestion)) {
        fakeLocalizationUnknowns.push(safeFixtureLabel(applicationQuestion));
        throw new Error('fake_localizer_unknown_fixture');
      }
      const optionMap = (question.applicationOptions || question.options || []).map((application) => ({
        candidate: /^yes$/i.test(application) ? 'Sì' : /^no$/i.test(application) ? 'No' : application,
        application,
      }));
      return {
        id: question.id,
        sourceLocale: 'en',
        question: 'Possiedi un permesso di lavoro valido?',
        why: 'Indica se possiedi un permesso di lavoro valido.',
        options: optionMap.map((pair) => pair.candidate),
        optionMap,
        validationMessage: '',
      };
    }) };
  }
  const request = JSON.parse(prompt.slice(prompt.lastIndexOf('{"form"'), prompt.lastIndexOf('\n\nReturn exactly')));
  const { form, candidate } = request;
  if ((candidate?.portalQuestionsAnswered || []).some((item) => /privacy policy statement/i.test(item.question || '')
    && String(item.answer || '').trim().toLowerCase() === 'ja')) plannerSawPrivacyCheckboxJa = true;
  if (form.fields.some((field) => /password|kennwort/i.test(field.label))) plannerSawPassword = true;
  const actions = form.fields.map((field) => {
    const act = (action, value = '', extra = {}) => ({ fieldId: field.id, action, value, document: 'none', source: 'identity', ...extra });
    const experience = candidate?.profile?.experience?.[0] || {};
    const education = candidate?.profile?.education?.[0] || {};
    if (/^job title\b/i.test(field.label)) return act('fill', experience.role || '', { source: 'profile' });
    if (/^employer\b/i.test(field.label)) return act('fill', experience.employer || '', { source: 'profile' });
    if (/^degree\b/i.test(field.label)) return act('fill', education.degree || '', { source: 'profile' });
    if (/^institution\b/i.test(field.label)) return act('fill', education.institution || '', { source: 'profile' });
    if (/^start date\b/i.test(field.label)) return act('fill', experience.start || education.start || '', { source: 'profile' });
    if (/^end date\b/i.test(field.label)) return act('fill', experience.end || education.end || '', { source: 'profile' });
    if (/preferred workload/i.test(field.label)) {
      const answer = candidate?.portalQuestionsAnswered?.find((item) => /preferred workload/i.test(item.applicationQuestion || item.question || ''))?.answer || '';
      return act('fill', answer, { source: 'answers' });
    }
    if (/e-?mail/i.test(field.label)) return act('fill', ALIAS);
    if (/datenschutz|privacy policy/i.test(field.label)) {
      const answer = candidate?.portalQuestionsAnswered?.find((item) => /datenschutz|privacy policy/i.test(item.question || ''))?.answer || '';
      return act('check', '', { source: answer ? 'answers' : 'consent' });
    }
    if (/vermittlungsb/i.test(field.label)) return act('select', 'Ja', { source: 'rule' });
    if (/anrede/i.test(field.label)) return act('select', 'Herr', { source: 'answers' });
    if (/geburtsdatum/i.test(field.label)) return act('fill', '1990-05-12', { source: 'profile' });
    if (/vorname|first name/i.test(field.label)) return act('fill', 'Luca');
    // Workday's first page: the country is a listbox, the address follows it, the phone code is a search.
    if (/^country\*?$/i.test(field.label)) return act('select', 'Switzerland', { source: 'profile' });
    if (/address line 1/i.test(field.label)) return act('fill', 'Via Esempio 1');
    if (/street name/i.test(field.label)) return act('fill', 'Via Esempio');
    if (/postcode|postal code/i.test(field.label)) return act('fill', '6830');
    if (/phone code/i.test(field.label)) return act('fill', candidate?.identity?.phone ? '+41' : '');
    if (/land\/region/i.test(field.label)) return act('select', 'Italien', { source: 'profile' });
    if (/nachname|last name/i.test(field.label)) return act('fill', 'Bianchi');
    // umantis' form: no photo and no other document to give, the letter in its own field.
    if (/photo|other documents/i.test(field.label)) return act('skip', '', { source: 'rule' });
    if (/cover letter/i.test(field.label)) return act('upload', '', { document: 'cover_letter', source: 'documents' });
    if (/cell phone/i.test(field.label)) return act('fill', candidate?.identity?.phone || '');
    // A honeypot must never reach the planner (fields.mjs): one that did would be filled.
    if (/website/i.test(field.label)) return act('fill', 'https://example.com');
    if (/how did you hear/i.test(field.label)) return act('select', 'Online job board', { source: 'rule' });
    if (/valid work permit/i.test(field.label)) {
      const answer = candidate?.portalQuestionsAnswered?.find((item) => /valid work permit/i.test(item.question || ''))?.answer || '';
      return act('select', answer, { source: 'answers' });
    }
    if (/^title/i.test(field.label)) return act('select', 'Mr', { source: 'answers' });
    if (/data release/i.test(field.label)) {
      const answer = candidate?.portalQuestionsAnswered?.find((item) => /data release/i.test(item.question || ''))?.answer || '';
      return act('select', answer, { source: answer ? 'answers' : 'consent' });
    }
    if (field.kind === 'file') return act('upload', '', { document: 'cv', source: 'documents' });
    return act('skip', '', { source: 'rule' });
  });
  return { actions, missingRequired: [] };
}

/**
 * Workday's account page (a real order of 2026-10-07, Rituals): the runner judged the registration 1.9 s
 * after storing its password, while the portal had not answered yet, called it refused and threw the
 * password away.
 */
async function workdayAccountChecks({ base, tenantBase, state, workday, files, executablePath, browserTlsSpkiPin, check, bindReceiptJobId }, assistedOnly = false, tenantOnly = false, smokeOnly = false) {
  const host = new URL(base).hostname;
  const saved = new Map();
  const accounts = {
    async load(hostname) { return saved.get(hostname) || null; },
    async save(hostname, { email, password }) { saved.set(hostname, { email, password, createdAt: Date.now(), verifiedAt: null, status: 'pending' }); },
    async mark(hostname, patch) { saved.set(hostname, { ...saved.get(hostname), ...patch }); },
    async discard(hostname) { saved.delete(hostname); },
    async recordExistingUnknownPassword(hostname) {
      saved.set(hostname, { email: null, password: null, createdAt: Date.now(), verifiedAt: null, status: 'exists_unknown_password' });
    },
    async beginRecovery(hostname, { email, password }) {
      const requestId = `synthetic-reset-${workday.resetEmails.length + 1}`;
      const current = saved.get(hostname) || {};
      saved.set(hostname, {
        ...current, email, password, status: 'recovering', verifiedAt: null,
        recoveryRequestedAt: Date.now(), recoveryRequestId: requestId,
        recoveryApplicationCheckRequired: true,
      });
      return { status: 'started', requestId, requestedAt: Date.now(), attempt: 1 };
    },
    async waitForPasswordReset() {
      if (workday.resetLinksClaimed >= workday.resetEmails.length || !workday.resetEmails.length) return null;
      workday.resetLinksClaimed += 1;
      const url = workday.tenantMode
        ? (workday.tenantRouteMode
          ? `${tenantBase}${WORKDAY_RESET_PASSWORD_PATH}?token=synthetic-reset-token`
          : `${tenantBase}${WORKDAY_MANUAL_JOB_PATH}?view=password-reset&token=synthetic-reset-token`)
        : `${tenantBase}/wd/password-reset?token=synthetic-reset-token`;
      return { url, messageId: 'synthetic-reset' };
    },
    async completeRecovery(hostname) {
      const current = saved.get(hostname);
      if (!current?.password) return false;
      saved.set(hostname, { ...current, status: 'pending', verifiedAt: null, recoveryCompletedAt: Date.now() });
      return true;
    },
    async abortRecovery() { return true; },
    async recoveryActivation() { return null; },
    async verificationMessageIds() { return []; },
    async waitForVerification() {
      if (workday.activationLinksClaimed >= workday.activationResends || !workday.activationResends) return null;
      workday.activationLinksClaimed += 1;
      const url = workday.tenantMode
        ? (workday.tenantRouteMode
          ? `${tenantBase}${WORKDAY_ACTIVATE_PATH}?token=synthetic-activation`
          : `${tenantBase}${WORKDAY_MANUAL_JOB_PATH}?view=activate&token=synthetic-activation`)
        : `${tenantBase}/wd/activate?token=synthetic-activation`;
      return { url, messageId: 'synthetic-activation' };
    },
  };
  // The order's name for the employer and the one the posting's own data gives it: two entities of one company.
  const job = { title: 'Verkaufsberater/in', company: 'Acme Retail Switzerland', organization: 'Acme Retail Germany GmbH' };
  const run = (order = job, candidate = portalTestCandidate({ permitAnswer: 'Yes' })) => {
    const applyUrl = bindReceiptJobId(`${base}/wd/job`);
    return submitViaPortal({
      applyUrl, postingUrl: applyUrl, job: order, language: 'en', candidateLocale: 'it', candidate, files, codex: fakeCodex, accounts,
      launch: () => launchChromium({
        headless: true,
        executablePath,
        args: [`--ignore-certificate-errors-spki-list=${browserTlsSpkiPin}`],
      }),
    });
  };
  const runTenantWorkday = async (
    order = job,
    candidate = portalTestCandidate({ permitAnswer: 'Yes' }),
    { routeAccounts = false, landOnHomeAfterLogin = false } = {},
  ) => {
    workday.tenantMode = true;
    workday.tenantRouteMode = routeAccounts;
    workday.routeLandOnHomeAfterLogin = landOnHomeAfterLogin;
    const portalNavigationDiagnostics = [];
    const tenantRequestStart = workday.tenantRequests.length;
    try {
      const result = await submitViaPortal({
        applyUrl: `${tenantBase}${WORKDAY_JOB_PATH}`,
        postingUrl: `${tenantBase}${WORKDAY_JOB_PATH}`,
        job: order,
        language: 'en',
        candidateLocale: 'it',
        candidate,
        files,
        codex: fakeCodex,
        accounts,
        onPortalNavigationDiagnostic: (entry) => {
          if (portalNavigationDiagnostics.length < 12) portalNavigationDiagnostics.push(safePortalNavigationDiagnostic(entry));
        },
        launch: () => launchChromium({
          headless: true,
          executablePath,
          args: [
            `--ignore-certificate-errors-spki-list=${browserTlsSpkiPin}`,
            '--host-resolver-rules=MAP acme.wd3.myworkdayjobs.com 127.0.0.1',
          ],
        }),
      });
      return {
        ...result,
        portalNavigationDiagnostics,
        tenantRequests: workday.tenantRequests.slice(tenantRequestStart),
      };
    } finally {
      workday.tenantMode = false;
      workday.tenantRouteMode = false;
      workday.routeLandOnHomeAfterLogin = false;
    }
  };
  const authOf = (result) => result.evidence.steps.filter((step) => step.auth).map((step) => `${step.auth.kind}:${step.auth.outcome}`).join(',');

  if (assistedOnly) {
    const seeded = await run();
    check('Workday: focused assisted-flow setup creates the account and applies', seeded.event.type === 'submit_succeeded');
  } else if (!tenantOnly) {
  // The portal never answers the registration: no word of refusal, so the password stays for the next run.
  workday.silent = true;
  const unanswered = await run();
  check('Workday: a registration the portal does not answer is handed over as unanswered, its password kept',
    unanswered.event.type === 'submit_handoff' && unanswered.event.reason === 'account_create_unanswered'
    && saved.get(host)?.status === 'unanswered' && Boolean(saved.get(host)?.password) && workday.registrations === 1);
  check('Workday: the overlay is what gets clicked and the honeypot stays empty (nothing dropped by the «NoCaptcha»)', workday.dropped === 0);
  // The next run tries the password it kept; the account is not there, so it is created now, and the
  // application leaves. The answer comes a second and a half after each click.
  workday.silent = false;
  const applications = state.applications.length;
  const recovered = await run();
  check('Workday: the next run signs in with the kept password, and creates the account when that fails',
    recovered.event.type === 'submit_succeeded' && workday.accounts.get(ALIAS) === saved.get(host)?.password
    && workday.registrations === 2 && state.applications.length === applications + 1 && workday.dropped === 0);
  check('Workday: the late answers are waited for (sign-in refused, account created, signed in)',
    /sign_in/.test(authOf(recovered)) && /create/.test(authOf(recovered)) && Boolean(saved.get(host)?.lastSignInAt));
  // A later order's run on the same account signs in at once.
  state.sessions.clear();
  const again = await run();
  check('Workday: a later run signs in with the stored account', again.event.type === 'submit_succeeded' && workday.registrations === 2 && state.applications.length === applications + 2);
  // With an account stored the runner lands on «Create Account» and must follow the form's own verified
  // «Sign In» anchor by GET, never the site header's control, which opens a dialog over the page.
  // The country is chosen before anything is typed, the form it redraws is planned again, and the phone
  // code's matches are waited for: the address is in the fields of the chosen country, not in ones that are gone.
  const sent = workday.forms.at(-1) || {};
  check('Workday: the country is chosen first, the redrawn form planned again, the phone code picked from its late matches',
    sent.country === 'Switzerland' && sent.street === 'Via Esempio' && sent.postcode === '6830' && sent.phoneCode === 'Switzerland (+41)'
    && again.evidence.steps.some((step) => step.redrawn) && !again.evidence.steps.some((step) => (step.failures || []).length), stopContext(again));
  // The posting's page says only the brand: the employer is the order's by the posting's own data, and the
  // form behind the account (whose title is still the account page's) is the posting's by its role.
  check('Workday: the form is the posting’s by the employer its data names, another entity of the order’s company',
    again.evidence.postingMatch === 'match' && again.evidence.postingMatchVia === 'posting_data');
  state.sessions.clear();
  const stranger = await run({ ...job, organization: 'Other Retail GmbH' });
  check('Workday: with another company in the posting’s data the form is not the order’s',
    stranger.event.type === 'submit_handoff' && stranger.event.reason === 'posting_mismatch' && state.applications.length === applications + 2);
  check('Workday: the «Sign In» link of the form is the one pressed, never the one in the site header', workday.headerSignIns === 0 && /create:ok/.test(authOf(again)) && /sign_in:ok/.test(authOf(again)));
  // The address is genuinely already registered: record its unknown-password state and hand it off.
  saved.clear();
  state.sessions.clear();
  const refused = await run();
  check('Workday: an existing email is recorded without its generated password and handed off for recovery',
    refused.event.type === 'submit_handoff' && refused.event.reason === 'account'
    && refused.event.accountFailure?.code === 'account_exists'
    && saved.get(host)?.status === 'exists_unknown_password' && saved.get(host)?.password == null);
  // The registration went through and its answer never came: the next run signs in with the kept password,
  // and from then on the account is on record as created (review of #12255: left `unanswered`, a later
  // sign-in that fails would create it again and throw a real account's password away).
  workday.accounts.clear();
  saved.clear();
  state.sessions.clear();
  workday.silent = 'created';
  await run();
  workday.silent = false;
  const registrations = workday.registrations;
  const signedIn = await run();
  check('Workday: an account whose registration was never answered is on record as created once it has signed in',
    signedIn.event.type === 'submit_succeeded' && workday.registrations === registrations && saved.get(host)?.status === 'created');
  // The button of the registration cannot be pressed (something lies over it): a stop with the page kept,
  // not a failed run, and the password stored before the click stays as `unanswered`, so the next run signs
  // in, finds no account and creates it (left `pending` it would stop at the failed sign-in).
  workday.accounts.clear();
  saved.clear();
  state.sessions.clear();
  workday.cover = true;
  const covered = await run();
  workday.cover = false;
  check('Workday: a registration button that cannot be pressed is a stop with its page, the password kept as unanswered',
    covered.event.type === 'submit_handoff' && covered.event.reason === 'account' && Boolean(covered.evidence.handoffScreenshot)
    && /create:control_error/.test(authOf(covered)) && saved.get(host)?.status === 'unanswered' && workday.registrations === registrations);
  state.sessions.clear();
  const afterCover = await run();
  check('Workday: the run after that stop creates the account and sends the application',
    afterCover.event.type === 'submit_succeeded' && workday.accounts.get(ALIAS) === saved.get(host)?.password && saved.get(host)?.status === 'created');
  }
  if (!tenantOnly) {
  // An application in progress from an earlier run (the one that stopped for a question, a dry run): the page
  // after the sign-in asks to be refreshed and is, and the CV that run left is taken away before this run's
  // goes in — one CV on the application, never two.
  state.sessions.clear();
  workday.resumed = true;
  const resumed = await run();
  workday.resumed = false;
  const kept = workday.forms.at(-1) || {};
  check('Workday: an application in progress is opened by the refresh the portal asks for, and its old CV replaced, not doubled',
    resumed.event.type === 'submit_succeeded' && resumed.evidence.steps.some((step) => step.refreshed)
    && workday.deletedFiles === 1 && kept.kept === '' && state.applications.at(-1)?.hasCv === true
    && resumed.evidence.steps.some((step) => (step.replaced || []).includes('cv')));

  state.sessions.clear();
  workday.resumed = true;
  workday.uploadFails = true;
  const beforeFailedUpload = state.applications.length;
  const failedUpload = await run();
  workday.resumed = false;
  workday.uploadFails = false;
  check('Workday: HTTP 500 with the selected filename still visible is handed off before application submission',
    failedUpload.event.type === 'submit_handoff' && failedUpload.event.reason === 'upload_failed'
    && state.applications.length === beforeFailedUpload && workday.deletedFiles === 2);

  const profileCandidate = portalTestCandidate({ permitAnswer: 'Yes' });
  profileCandidate.profile.experience = [
        { role: 'Retail Assistant', employer: 'Mendrisio Market', start: '2020-03', end: '2022-04' },
        { role: 'Cashier', employer: 'Lugano Foods', start: '2022-05', end: '2024-10' },
        { role: 'Temporary Helper', employer: 'Seasonal Shop', start: '2021', end: '' },
      ];
  profileCandidate.profile.education = [
        { degree: 'Vocational Diploma', institution: 'Scuola Cantonale', start: '2015-09', end: '2018-06' },
        { degree: 'Secondary School', institution: 'Liceo Lugano', start: '2012-09', end: '2015-06' },
      ];
  state.sessions.clear();
  const profileResult = await run(job, profileCandidate);
  const profileForm = workday.forms.at(-1) || {};
  const profileSections = profileResult.evidence.steps.map((step) => step.profileSections).filter(Boolean);
  check('Workday: profile sections submit the application', profileResult.event.type === 'submit_succeeded');
  check('Workday: experience rows are complete and retain source order', JSON.stringify(profileForm.experience) === JSON.stringify([
    'Retail Assistant|Mendrisio Market|2020-03|2022-04',
    'Cashier|Lugano Foods|2022-05|2024-10',
  ]), { values: profileForm.experience, profileSections });
  check('Workday: education rows are complete and retain source order', JSON.stringify(profileForm.education) === JSON.stringify([
    'Vocational Diploma|Scuola Cantonale|2015-09|2018-06',
    'Secondary School|Liceo Lugano|2012-09|2015-06',
  ]), { values: profileForm.education, profileSections });
  check('Workday: rows without month-level dates are skipped', profileResult.evidence.steps.some((step) => JSON.stringify(step.profileSections) === JSON.stringify([
      { section: 'experience', added: 2, skipped: 1 },
      { section: 'education', added: 2, skipped: 0 },
  ])), profileSections);
  workday.additionalCvField = true;
  workday.cvUploads = 0;
  workday.additionalCvUploads = 0;
  state.sessions.clear();
  const applicationsBeforeMultipleCvFields = state.applications.length;
  const multipleCvFields = await run(job);
  workday.additionalCvField = false;
  check('Workday: distinct required CV fields both upload the CV after the second field appears on redraw',
    multipleCvFields.event.type === 'submit_succeeded'
    && state.applications.length === applicationsBeforeMultipleCvFields + 1
    && state.applications.at(-1)?.cvFiles === 2
    && workday.cvUploads === 1
    && workday.additionalCvUploads === 1,
    { event: { type: multipleCvFields.event.type, reason: multipleCvFields.event.reason || null }, cvUploads: workday.cvUploads, additionalCvUploads: workday.additionalCvUploads, submittedCvFiles: state.applications.at(-1)?.cvFiles || 0 });
  workday.coverLetterUploadFails = true;
  workday.coverLetterUploads = 0;
  const applicationsBeforeOptionalLetter = state.applications.length;
  state.sessions.clear();
  const optionalLetterFailure = await run(job);
  workday.coverLetterUploadFails = false;
  const uploadsAfterOptionalLetterFailure = optionalLetterFailure.evidence.uploads || [];
  const optionalLetterDiagnostics = {
    event: { type: optionalLetterFailure.event.type, reason: optionalLetterFailure.event.reason || null },
    applicationDelta: state.applications.length - applicationsBeforeOptionalLetter,
    submittedHasCv: state.applications.at(-1)?.hasCv === true,
    coverLetterUploadAttempts: workday.coverLetterUploads,
    uploadDocuments: uploadsAfterOptionalLetterFailure.map((upload) => upload.document),
    failureCodes: optionalLetterFailure.evidence.steps.flatMap((step) => step.failures || []).map((failure) => failure.error).filter((error) => /^[a-z_]{1,80}$/.test(String(error || ''))),
  };
  check('Workday: an unconfirmed optional cover letter does not block the required CV or application',
    optionalLetterFailure.event.type === 'submit_succeeded'
    && state.applications.length === applicationsBeforeOptionalLetter + 1
    && state.applications.at(-1)?.hasCv === true
    && workday.coverLetterUploads === 1
    && uploadsAfterOptionalLetterFailure.some((upload) => upload.document === 'cv')
    && !uploadsAfterOptionalLetterFailure.some((upload) => upload.document === 'cover_letter')
    && optionalLetterFailure.evidence.steps.some((step) => (step.failures || []).some((failure) => failure.error === 'upload_not_confirmed')),
    optionalLetterDiagnostics);
  }

  const tenantHost = new URL(tenantBase).hostname;
  workday.accounts.delete(ALIAS);
  saved.delete(tenantHost);
  state.sessions.clear();
  const tenantApplicationsBefore = state.applications.length;
  const tenantRegistrationsBefore = workday.registrations;
  const tenantChoiceClicksBefore = { ...workday.choiceClicks };
  const tenantRequestsBefore = workday.tenantRequests.length;
  const nativeCvUploadsBefore = workday.nativeCvMultipartUploads;
  const nativeCvSelectorClicksBefore = workday.nativeCvSelectorClicks;
  const talentPoolRequestsBefore = workday.talentPoolRequests;
  workday.nativeCvSelector = true;
  const tenantSuccess = await runTenantWorkday();
  workday.nativeCvSelector = false;
  const tenantRequests = workday.tenantRequests.slice(tenantRequestsBefore);
  check('Workday: a no-jobid tenant posting opens Apply, chooses only manual apply, signs in, and submits once',
    tenantSuccess.event.type === 'submit_succeeded'
    && state.applications.length === tenantApplicationsBefore + 1
    && workday.registrations === tenantRegistrationsBefore + 1
    && tenantRequests.includes(`GET ${WORKDAY_JOB_PATH}`)
    && tenantRequests.includes(`GET ${WORKDAY_MANUAL_JOB_PATH}`)
    && tenantRequests.some((request) => request.startsWith(`GET ${WORKDAY_MANUAL_JOB_PATH}?view=form`))
    && !tenantRequests.some((request) => /introduceYourself|jobid=/i.test(request))
    && workday.talentPoolRequests === talentPoolRequestsBefore
    && workday.nativeCvMultipartUploads === nativeCvUploadsBefore + 1
    && workday.nativeCvSelectorClicks === nativeCvSelectorClicksBefore + 1
    && workday.choiceClicks.autofill === tenantChoiceClicksBefore.autofill
    && workday.choiceClicks.lastApplication === tenantChoiceClicksBefore.lastApplication
    && workday.headerSignIns === 0,
    {
      event: { type: tenantSuccess.event.type, error: tenantSuccess.event.error || null },
      requests: tenantRequests.slice(-3),
      nativeCvMultipartUploads: workday.nativeCvMultipartUploads - nativeCvUploadsBefore,
      nativeCvSelectorClicks: workday.nativeCvSelectorClicks - nativeCvSelectorClicksBefore,
      talentPoolRequests: workday.talentPoolRequests - talentPoolRequestsBefore,
      finalUrl: tenantSuccess.evidence.finalUrl || null,
      portalNavigation: tenantSuccess.portalNavigationDiagnostics,
      uploads: (tenantSuccess.evidence.uploads || []).map((upload) => upload.document),
      steps: tenantSuccess.evidence.steps.map((step) => ({
        cv: step.cv || null,
        cvUploadGuard: step.cvUploadGuard || null,
        cvUploadDiagnostics: step.cvUploadDiagnostics || [],
        applicationStage: step.applicationStage || null,
        actions: (step.actions || []).map((action) => action.action || 'unknown'),
        failures: (step.failures || []).map((failure) => failure.error || 'unknown'),
      })),
      lastSteps: tenantSuccess.evidence.steps.slice(-2).map((step) => ({
        applicationStage: step.applicationStage || null,
        cv: step.cv || null,
        cvUploadDiagnostics: step.cvUploadDiagnostics || null,
        failures: (step.failures || []).map((failure) => failure.error || 'unknown'),
      })),
    });

  const routeRecoveryApplicationsBefore = state.applications.length;
  const routeRecoveryRegistrationsBefore = workday.registrations;
  const routeRecoveryNativeUploadsBefore = workday.nativeCvMultipartUploads;
  const routeRecoveryNativeClicksBefore = workday.nativeCvSelectorClicks;
  const routeRecoveryTalentPoolBefore = workday.talentPoolRequests;
  workday.accounts.set(ALIAS, 'synthetic-old-password');
  workday.verifiedAccounts.add(ALIAS);
  saved.set(tenantHost, { email: null, password: null, status: 'exists_unknown_password' });
  workday.resetEmails.length = 0;
  workday.resetLinksClaimed = 0;
  workday.resetLinkSent = false;
  workday.recoveryUsed = false;
  workday.recoveryHistoryChecked = false;
  workday.alreadyApplied = false;
  state.sessions.clear();
  const routeRecoveryRequestsStart = workday.tenantRequests.length;
  workday.nativeCvSelector = true;
  const routeRecovery = await runTenantWorkday(job, portalTestCandidate(), { routeAccounts: true });
  workday.nativeCvSelector = false;
  const routeRecoveryRequests = workday.tenantRequests.slice(routeRecoveryRequestsStart);
  const routeLoginGets = routeRecoveryRequests.filter((request) => request === `GET ${WORKDAY_LOGIN_PATH}`);
  check('Workday: applyManually redirects to query-free login, performs one alias reset, signs in, uploads through the native picker, and submits once',
    routeRecovery.event.type === 'submit_succeeded'
    && state.applications.length === routeRecoveryApplicationsBefore + 1
    && workday.resetEmails.length === 1
    && workday.resetEmails[0] === ALIAS
    && routeLoginGets.length === 2
    && routeRecoveryRequests.includes(`GET ${WORKDAY_FORGOT_PASSWORD_PATH}`)
    && routeRecoveryRequests.includes(`POST ${WORKDAY_FORGOT_PASSWORD_PATH}`)
    && routeRecoveryRequests.some((request) => request.startsWith(`GET ${WORKDAY_RESET_PASSWORD_PATH}?token=`))
    && routeRecoveryRequests.includes(`POST ${WORKDAY_RESET_PASSWORD_PATH}`)
    && workday.registrations === routeRecoveryRegistrationsBefore
    && workday.nativeCvMultipartUploads === routeRecoveryNativeUploadsBefore + 1
    && workday.nativeCvSelectorClicks === routeRecoveryNativeClicksBefore + 1
    && workday.talentPoolRequests === routeRecoveryTalentPoolBefore
    && !routeRecoveryRequests.some((request) => /introduceYourself|jobid=/i.test(request))
    && (routeRecovery.evidence.uploads || []).some((upload) => upload.document === 'cv'),
    {
      event: { type: routeRecovery.event.type, reason: routeRecovery.event.reason || null },
      requests: routeRecoveryRequests.filter((request) => /(?:applyManually|\/login|forgotPassword|resetPassword|introduceYourself)/i.test(request)),
      loginGetCount: routeLoginGets.length,
      resetEmailCount: workday.resetEmails.length,
      applicationDelta: state.applications.length - routeRecoveryApplicationsBefore,
      nativeCvUploads: workday.nativeCvMultipartUploads - routeRecoveryNativeUploadsBefore,
    });

  const routeHomeApplicationsBefore = state.applications.length;
  workday.accounts.set(ALIAS, 'synthetic-old-password');
  workday.verifiedAccounts.add(ALIAS);
  saved.set(tenantHost, { email: null, password: null, status: 'exists_unknown_password' });
  workday.resetEmails.length = 0;
  workday.resetLinksClaimed = 0;
  workday.resetLinkSent = false;
  workday.recoveryUsed = false;
  workday.recoveryHistoryChecked = false;
  workday.alreadyApplied = false;
  state.sessions.clear();
  const routeHomeRequestsStart = workday.tenantRequests.length;
  const routeHomeNativeUploadsBefore = workday.nativeCvMultipartUploads;
  workday.nativeCvSelector = true;
  const routeHomeRecovery = await runTenantWorkday(job, portalTestCandidate(), {
    routeAccounts: true,
    landOnHomeAfterLogin: true,
  });
  workday.nativeCvSelector = false;
  const routeHomeRequests = workday.tenantRequests.slice(routeHomeRequestsStart);
  check('Workday: a home-page login return gets one selected applyManually hop, then submits once',
    routeHomeRecovery.event.type === 'submit_succeeded'
    && state.applications.length === routeHomeApplicationsBefore + 1
    && workday.resetEmails.length === 1
    && workday.resetEmails[0] === ALIAS
    && workday.recoveryHistoryChecked === true
    && routeHomeRequests.filter((request) => request === `GET ${WORKDAY_MANUAL_JOB_PATH}`).length === 2
    && routeHomeRequests.includes(`GET ${WORKDAY_SITE_PATH}`)
    && routeHomeRequests.includes(`GET ${WORKDAY_MY_APPLICATIONS_PATH}`)
    && workday.nativeCvMultipartUploads === routeHomeNativeUploadsBefore + 1
    && !routeHomeRequests.some((request) => /introduceYourself|jobid=/i.test(request)),
    {
      event: { type: routeHomeRecovery.event.type, reason: routeHomeRecovery.event.reason || null },
      applicationHops: routeHomeRequests.filter((request) => request === `GET ${WORKDAY_MANUAL_JOB_PATH}`).length,
      historyChecked: workday.recoveryHistoryChecked,
      nativeCvUploadDelta: workday.nativeCvMultipartUploads - routeHomeNativeUploadsBefore,
    });
  workday.resetLinksClaimed = 0;

  workday.accounts.delete(ALIAS);
  workday.verifiedAccounts.delete(ALIAS);
  saved.delete(tenantHost);
  state.sessions.clear();
  const routeChangeUploadCount = workday.cvUploads;
  const routeChangeApplicationCount = state.applications.length;
  workday.routeChangesBeforeUpload = true;
  let routeChangedBeforeUpload;
  try {
    routeChangedBeforeUpload = await runTenantWorkday();
  } finally {
    workday.routeChangesBeforeUpload = false;
  }
  check('Workday: a requisition change after stage classification stops before any upload request',
    routeChangedBeforeUpload.event.type === 'submit_handoff'
    && routeChangedBeforeUpload.event.reason === 'posting_mismatch'
    && workday.cvUploads === routeChangeUploadCount
    && state.applications.length === routeChangeApplicationCount,
    {
      event: { type: routeChangedBeforeUpload.event.type, reason: routeChangedBeforeUpload.event.reason || null },
      uploadRequestDelta: workday.cvUploads - routeChangeUploadCount,
      applicationDelta: state.applications.length - routeChangeApplicationCount,
    });
  if (smokeOnly) return;

  workday.alreadyApplied = false;
  workday.recoveryUsed = false;
  workday.accounts.set(ALIAS, 'synthetic-current-password');
  workday.verifiedAccounts.add(ALIAS);
  workday.resetEmails.length = 0;
  saved.set(tenantHost, {
    email: ALIAS, password: 'synthetic-stale-password', status: 'created', verifiedAt: Date.now(),
  });
  state.sessions.clear();
  const trustedLoginApplicationsBefore = state.applications.length;
  const trustedLoginFailure = await runTenantWorkday();
  check('Workday: a failed sign-in for a previously verified account is handed off without resetting its password',
    trustedLoginFailure.event.type === 'submit_handoff'
    && trustedLoginFailure.event.reason === 'account_sign_in_failed'
    && workday.resetEmails.length === 0
    && state.applications.length === trustedLoginApplicationsBefore);

  saved.delete(tenantHost);
  state.sessions.clear();
  const duplicateRegistrationBefore = workday.registrations;
  const applicationsBeforeDuplicate = state.applications.length;
  const duplicateAccount = await runTenantWorkday();
  const unknownPasswordRecord = saved.get(tenantHost);
  check('Workday: an email already registered stops after one create click and records account_exists without a password',
    duplicateAccount.event.type === 'submit_handoff'
    && duplicateAccount.event.reason === 'account'
    && duplicateAccount.event.accountFailure?.code === 'account_exists'
    && duplicateAccount.event.accountFailure?.stage === 'registration'
    && workday.registrations === duplicateRegistrationBefore + 1
    && unknownPasswordRecord?.status === 'exists_unknown_password'
    && unknownPasswordRecord.password == null
    && state.applications.length === applicationsBeforeDuplicate, stopContext(duplicateAccount));
  state.sessions.clear();
  const duplicateRetry = await runTenantWorkday();
  check('Workday: a recorded unknown-password account recovers by one reset request without re-registering',
    duplicateRetry.event.type === 'submit_succeeded'
    && workday.resetEmails.length === 1
    && workday.registrations === duplicateRegistrationBefore + 1
    && state.applications.length === applicationsBeforeDuplicate + 1, stopContext(duplicateRetry));

  const tenantRecoveryHost = new URL(tenantBase).hostname;
  workday.accounts.set(ALIAS, 'synthetic-unknown-old-password');
  workday.verifiedAccounts.delete(ALIAS);
  workday.resetEmails.length = 0;
  workday.resetLinksClaimed = 0;
  workday.resetLinkSent = false;
  workday.activationResends = 0;
  workday.activationLinksClaimed = 0;
  workday.alreadyApplied = false;
  saved.set(tenantRecoveryHost, {
    email: null, password: null, createdAt: null, verifiedAt: null, status: 'exists_unknown_password',
  });
  state.sessions.clear();
  const applicationsBeforeRecovery = state.applications.length;
  const recoveredUnactivated = await runTenantWorkday();
  check('Workday: an unactivated existing alias account resets, signs in, resends activation, and applies once',
    recoveredUnactivated.event.type === 'submit_succeeded'
    && workday.resetEmails.length === 1
    && workday.resetEmails[0] === ALIAS
    && workday.activationResends === 1
    && workday.registrations === duplicateRegistrationBefore + 1
    && state.applications.length === applicationsBeforeRecovery + 1
    && saved.get(tenantRecoveryHost)?.status === 'created'
    && saved.get(tenantRecoveryHost)?.recoveryApplicationCheckRequired === true,
    stopContext(recoveredUnactivated));
  const applicationsAfterRecovery = state.applications.length;
  state.sessions.clear();
  const recoveredRetry = await runTenantWorkday();
  check('Workday: later retries recheck history and never duplicate a recovered application',
    recoveredRetry.event.type === 'submit_handoff'
    && recoveredRetry.event.reason === 'account_application_already_applied'
    && workday.resetEmails.length === 1
    && state.applications.length === applicationsAfterRecovery,
    stopContext(recoveredRetry));

  workday.accounts.set(ALIAS, 'synthetic-unknown-old-password');
  workday.verifiedAccounts.delete(ALIAS);
  workday.resetEmails.length = 0;
  workday.resetLinksClaimed = 0;
  workday.resetLinkSent = false;
  workday.activationResends = 0;
  workday.activationLinksClaimed = 0;
  saved.set(tenantRecoveryHost, {
    email: null, password: null, createdAt: null, verifiedAt: null, status: 'exists_unknown_password',
  });
  state.sessions.clear();
  workday.alreadyApplied = true;
  const applicationsBeforeAlreadyApplied = state.applications.length;
  const alreadyApplied = await runTenantWorkday();
  check('Workday: a recovered account with an existing application history is held before final send',
    alreadyApplied.event.type === 'submit_handoff'
    && alreadyApplied.event.reason === 'account_application_already_applied'
    && alreadyApplied.evidence.accountRecovery?.applicationCheck?.status === 'already_applied'
    && workday.resetEmails.length === 1
    && workday.activationResends === 1
    && state.applications.length === applicationsBeforeAlreadyApplied,
    stopContext(alreadyApplied));

  workday.alreadyApplied = false;
  workday.historyUnavailable = true;
  workday.accounts.set(ALIAS, 'synthetic-unknown-old-password');
  workday.verifiedAccounts.delete(ALIAS);
  workday.resetEmails.length = 0;
  workday.resetLinksClaimed = 0;
  workday.resetLinkSent = false;
  workday.recoveryUsed = false;
  workday.activationResends = 0;
  workday.activationLinksClaimed = 0;
  saved.set(tenantRecoveryHost, {
    email: null, password: null, createdAt: null, verifiedAt: null, status: 'exists_unknown_password',
  });
  state.sessions.clear();
  const applicationsBeforeUncertainHistory = state.applications.length;
  const uncertainHistory = await runTenantWorkday();
  check('Workday: recovery does not send when application history cannot be verified',
    uncertainHistory.event.type === 'submit_handoff'
    && uncertainHistory.event.reason === 'account_application_history_uncertain'
    && uncertainHistory.evidence.accountRecovery?.applicationCheck?.status === 'uncertain_application_history'
    && workday.resetEmails.length === 1
    && state.applications.length === applicationsBeforeUncertainHistory
    && saved.get(tenantRecoveryHost)?.recoveryApplicationCheckRequired === true);
  state.sessions.clear();
  const repeatedUncertainHistory = await runTenantWorkday();
  check('Workday: a retry keeps the duplicate guard after uncertain history and does not reset or send again',
    repeatedUncertainHistory.event.type === 'submit_handoff'
    && repeatedUncertainHistory.event.reason === 'account_application_history_uncertain'
    && workday.resetEmails.length === 1
    && state.applications.length === applicationsBeforeUncertainHistory);
  workday.historyUnavailable = false;
}

async function hiddenFutureStepFileCheck({ executablePath, check }) {
  const browser = await launchChromium({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><body><form>
      <section><label for="active-cv">Upload CV</label><input id="active-cv" type="file" style="display:none"></section>
      <section hidden><label for="hidden-cv">Required CV</label><input id="hidden-cv" type="file" required></section>
      <section aria-hidden="true"><label for="aria-hidden-cv">Required CV</label><input id="aria-hidden-cv" type="file" required></section>
      <section inert><label for="inert-cv">Required CV</label><input id="inert-cv" type="file" required></section>
      <section style="display:none"><label for="display-hidden-cv">Required CV</label><input id="display-hidden-cv" type="file" required></section>
      <section style="visibility:collapse"><label for="collapsed-cv">Required CV</label><input id="collapsed-cv" type="file" required></section>
    </form></body></html>`);
    const fileFields = (await extractFields(page)).fields.filter((field) => field.kind === 'file');
    check('Portal snapshots omit file inputs under hidden future steps but keep an active input styled behind its upload control',
      fileFields.length === 1 && fileFields[0].domId === 'active-cv'
      && fileFields[0].label === 'Upload CV' && fileFields[0].required === false,
      { visibleFileCount: fileFields.length, visibleFileDomId: fileFields[0]?.domId || '', visibleFileLabel: fileFields[0]?.label || '' });
    await page.locator('#active-cv').evaluate((element) => { element.style.display = ''; });
    const readAheadFileFields = (await extractFields(page, { includeHidden: true, listboxOptions: false })).fields
      .filter((field) => field.kind === 'file');
    check('Portal read-ahead omits file inputs in hidden, aria-hidden, inert, display:none, and visibility:collapse future steps',
      readAheadFileFields.length === 1 && readAheadFileFields[0].domId === 'active-cv'
      && readAheadFileFields[0].label === 'Upload CV' && readAheadFileFields[0].required === false,
      { visibleFileCount: readAheadFileFields.length, visibleFileDomId: readAheadFileFields[0]?.domId || '' });
  } finally {
    await browser.close();
  }
}

async function main() {
  const { server, state, coop, umantis, workday, bindReceiptJobId, hasCurrentReceiptKey } = fakePortal();
  const dir = await mkdtemp(path.join(tmpdir(), 'aa-portal-e2e-'));
  const tlsFixture = await createWorkdayTlsFixture(dir);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const requestHandler = server.listeners('request')[0];
  const workdayServer = https.createServer({ key: tlsFixture.key, cert: tlsFixture.cert }, requestHandler);
  await new Promise((resolve) => workdayServer.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const workdayBase = `https://workday.localhost:${workdayServer.address().port}`;
  const workdayTenantBase = workdayTenantOrigin(workdayServer);
  const otpBase = `http://career5.successfactors.localhost:${server.address().port}`;
  const accountHost = '127.0.0.1';
  const otpAccountHost = 'career5.successfactors.localhost';
  const saved = new Map();
  const accounts = {
    async load(host) { return saved.get(host) || null; },
    async save(host, { email, password }) { saved.set(host, { email, password, createdAt: Date.now(), verifiedAt: null }); },
    async mark(host, patch) { saved.set(host, { ...saved.get(host), ...patch }); },
    async discard(host) { saved.delete(host); },
    // The e-mail the portal would send to the alias, as the inbound handler stores it.
    async waitForVerification() { return state.pending ? { url: `${base}/activate?t=${state.pending.token}`, code: '' } : null; },
  };
  const files = { cv: path.join(dir, 'candidate-cv.pdf'), cover_letter: path.join(dir, 'candidate-cover-letter.pdf') };
  await writeFile(files.cv, '%PDF-1.4\n%%EOF\n');
  await writeFile(files.cover_letter, '%PDF-1.4\n%%EOF\n');
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
  const run = async (extra = {}) => {
    const { capturePortalNavigationDiagnostics = false, ...runOptions } = extra;
    const portalNavigationDiagnostics = [];
    const applyUrl = bindReceiptJobId(runOptions.applyUrl || `${base}/job`);
    const fixturePath = new URL(applyUrl).pathname;
    // These posting pages are verified only when the test supplies the selected
    // role, just as the production runner receives it from the application order.
    const fixtureJob = fixturePath === '/job' ? { title: 'Pflegefachperson 80%' }
      : fixturePath === '/widget-job' ? { title: 'Pflegefachperson 60%' }
        : fixturePath === '/gravity-modal-job' ? { title: 'Fachperson Betreuung 80%' }
        : undefined;
    const postingUrl = runOptions.postingUrl || (['/job', '/widget-job', '/gravity-modal-job', '/coop-job', '/wd/job', '/hotel-job', HOTEL_NO_H1_PATH, HOTEL_NO_H1_OTHER_TITLE_PATH, '/hotel-job-closed'].includes(fixturePath) ? applyUrl : '');
    const result = await submitViaPortal({
      language: 'de',
      candidateLocale: 'it',
      ...(fixtureJob ? { job: fixtureJob } : {}),
      ...(postingUrl ? { postingUrl } : {}),
      candidate: portalTestCandidate(),
      files,
      codex: fakeCodex,
      accounts,
      launch: () => launchChromium({ headless: true, executablePath }),
      ...runOptions,
      ...(capturePortalNavigationDiagnostics ? {
        onPortalNavigationDiagnostic: (entry) => {
          if (portalNavigationDiagnostics.length < 12) portalNavigationDiagnostics.push(safePortalNavigationDiagnostic(entry));
        },
      } : {}),
      applyUrl,
    });
    return capturePortalNavigationDiagnostics ? { ...result, portalNavigationDiagnostics } : result;
  };

  // hCaptcha's own host answered locally: the test never calls the real service.
  const launchWithLocalHcaptcha = async () => {
    const browser = await launchChromium({ headless: true, executablePath });
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (options) => {
      const context = await newContext(options);
      await context.route('https://api.hcaptcha.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":false}' }));
      return context;
    };
    return browser;
  };

  const checks = [];
  const check = (name, ok, actual, { reportDiagnostic = false } = {}) => {
    checks.push({ name, ok, ...(reportDiagnostic && actual ? { diagnostic: actual } : {}) });
    console.log(`${ok ? '✓' : '✗'} ${name}`);
    if (!ok && actual !== undefined) console.log(`  actual: ${JSON.stringify(actual)}`);
  };
  const cvField = { id: 'f1', domId: 'resume', name: 'cv', label: 'CV', section: 'Profile' };
  const redrawnCvField = { ...cvField, id: 'f9' };
  const laterCvField = { ...cvField, id: 'f10' };
  const generatedCvField = { id: 'f20', name: 'cv', label: 'CV', section: 'Profile' };
  const redrawnGeneratedCvField = { ...generatedCvField, id: 'f21' };
  const selectedGeneratedCvKey = portalUploadActionKey('/wizard', 1, generatedCvField, [generatedCvField]);
  const selectedGeneratedCvRecord = { key: selectedGeneratedCvKey, fieldId: generatedCvField.id, domId: '', groupIndex: 0, groupSize: 1 };
  const newlyVisibleGeneratedCvField = { ...generatedCvField, id: 'f22' };
  const fieldsAfterSecondGeneratedCvAppears = [generatedCvField, newlyVisibleGeneratedCvField];
  const fieldsWithNewGeneratedCvBeforeSelected = [newlyVisibleGeneratedCvField, generatedCvField];
  const ambiguousGeneratedCvRedraw = [redrawnGeneratedCvField, newlyVisibleGeneratedCvField];
  const initiallyDuplicatedGeneratedFields = [generatedCvField, { ...generatedCvField, id: 'f23' }];
  const selectedDuplicateGeneratedKey = portalUploadActionKey('/wizard', 1, generatedCvField, initiallyDuplicatedGeneratedFields);
  const selectedDuplicateGeneratedRecord = { key: selectedDuplicateGeneratedKey, fieldId: generatedCvField.id, domId: '', groupIndex: 0, groupSize: 2 };
  const singleFieldAfterDuplicateShrinks = [{ ...generatedCvField, id: 'f24' }];
  check('Portal upload keys survive same-step redraws and distinguish controls and later steps that reuse an id',
    portalUploadActionKey('/wizard', 1, cvField) === portalUploadActionKey('/wizard', 1, redrawnCvField)
    && portalUploadActionKey('/wizard', 1, cvField) !== portalUploadActionKey('/wizard', 2, laterCvField)
    && portalUploadActionKey('/wizard', 1, cvField) !== portalUploadActionKey('/wizard', 1, { ...cvField, id: 'f2', domId: 'resume-two' })
    && selectedGeneratedCvKey === portalUploadActionKey('/wizard', 1, redrawnGeneratedCvField, [redrawnGeneratedCvField], [selectedGeneratedCvRecord])
    && selectedGeneratedCvKey === portalUploadActionKey('/wizard', 1, generatedCvField, fieldsAfterSecondGeneratedCvAppears, [selectedGeneratedCvRecord])
    && selectedGeneratedCvKey === portalUploadActionKey('/wizard', 1, generatedCvField, fieldsWithNewGeneratedCvBeforeSelected, [selectedGeneratedCvRecord])
    && selectedGeneratedCvKey !== portalUploadActionKey('/wizard', 1, newlyVisibleGeneratedCvField, fieldsAfterSecondGeneratedCvAppears, [selectedGeneratedCvRecord])
    && portalUploadActionKey('/wizard', 1, redrawnGeneratedCvField, ambiguousGeneratedCvRedraw, [selectedGeneratedCvRecord]) === null
    && portalUploadActionKey('/wizard', 1, singleFieldAfterDuplicateShrinks[0], singleFieldAfterDuplicateShrinks, [selectedDuplicateGeneratedRecord]) === null);
  const runUmantisChecks = async () => {
    plannerSawPrivacyCheckboxJa = false;
    const hotelSaved = new Map();
    const hotelAccounts = {
      async load(host) { return hotelSaved.get(host) || null; },
      async save(host, { email, password }) { hotelSaved.set(host, { email, password, status: 'pending', createdAt: Date.now(), verifiedAt: null }); },
      async mark(host, patch) { hotelSaved.set(host, { ...hotelSaved.get(host), ...patch }); },
      async discard(host) { hotelSaved.delete(host); },
      async waitForVerification() { return null; },
    };
    const hotelJob = { company: 'Grand Hotel Esempio', title: 'Concierge Host (m/w/d)', location: 'Pontresina' };
    const hotelHost = new URL(umantisOrigin(server)).hostname;
    const noHeading = await run({ applyUrl: `${base}${HOTEL_NO_H1_PATH}`, job: hotelJob, accounts: hotelAccounts, dryRun: true, capturePortalNavigationDiagnostics: true });
    check('umantis: an exact posting route with navigation first, no h1 and «Applica ora» reaches the matching form', noHeading.event.type === 'dry_run_ready'
      && noHeading.evidence.finalButton?.label === 'Submit final application' && noHeading.evidence.postingMatch === 'match'
      && noHeading.evidence.steps.some((step) => step.auth?.kind === 'inline' && step.auth.outcome === 'dry_run')
      && umantis.applications.length === 0, stopContext(noHeading));
    const noHeadingOtherTitle = await run({ applyUrl: `${base}${HOTEL_NO_H1_OTHER_TITLE_PATH}`, job: hotelJob, accounts: hotelAccounts });
    check('umantis: a no-h1 posting whose document title names another role stops before its form', noHeadingOtherTitle.event.type === 'submit_handoff'
      && noHeadingOtherTitle.event.reason === 'posting_mismatch' && umantis.applications.length === 0, stopContext(noHeadingOtherTitle));
    const hotelDry = await run({ applyUrl: `${base}/hotel-job`, job: hotelJob, accounts: hotelAccounts, dryRun: true });
    check('umantis: a dry run fills the form that asks for its own password up to the send button, and keeps no account', hotelDry.event.type === 'dry_run_ready'
      && !hotelDry.event.stage && hotelDry.evidence.finalButton?.label === 'Submit final application' && hotelSaved.size === 0 && umantis.applications.length === 0
      && hotelDry.evidence.steps.some((step) => step.auth?.kind === 'inline' && step.auth.outcome === 'dry_run')
      && hotelDry.evidence.answers.some((item) => /privacy policy statement/i.test(item.question) && item.answer === '✓' && item.source === 'answers')
      && plannerSawPrivacyCheckboxJa, stopContext(hotelDry));
    check('umantis: the company is read on the posting, the role on the form it opened', hotelDry.evidence.postingMatch === 'match' && hotelDry.evidence.postingMatchVia === 'posting_page');
    let guardCalls = 0;
    const hotel = await run({ applyUrl: `${base}/hotel-job`, job: hotelJob, accounts: hotelAccounts, onBeforeSubmit: async () => { guardCalls += 1; } });
    const sentToHotel = umantis.applications[0] || {};
    const hotelPassword = hotelSaved.get(hotelHost)?.password || '';
    check('umantis: the form is sent once behind the submission guard, with the CV and the letter stored one after the other in their own fields, and no photo', hotel.event.type === 'submit_succeeded'
      && guardCalls === 1 && umantis.applications.length === 1 && umantis.refused.length === 0 && sentToHotel.cv && sentToHotel.letter && !sentToHotel.photo && !sentToHotel.other
      && sentToHotel.first === 'Luca' && sentToHotel.title === 'mr' && sentToHotel.hear === 'board' && sentToHotel.release === 'delete' && !sentToHotel.employee,
    { ...stopContext(hotel), guardCalls, applicationCount: umantis.applications.length, refusalReasons: umantis.refused.slice(-2), receiptKeyPreserved: hasCurrentReceiptKey(hotel.evidence.finalUrl) });
    check('umantis: the account is the order’s (alias, the stored password) and is marked created', hotelPassword.length >= 7
      && umantis.accounts.get(ALIAS) === hotelPassword && hotelSaved.get(hotelHost)?.status === 'created',
    { ...stopContext(hotel), accountCreated: hotelSaved.get(hotelHost)?.status === 'created', accountPasswordPresent: Boolean(hotelPassword) });
    check('the password is in no evidence, and no password field ever reached the planner', Boolean(hotelPassword)
      && !JSON.stringify(hotel.evidence).includes(hotelPassword) && !plannerSawPassword);
    const otherRole = await run({ applyUrl: `${base}/hotel-job-other-role`, job: { company: 'Grand Hotel Esempio', title: 'Chef de Rang' }, accounts: hotelAccounts });
    check('umantis: the form of another role of the same employer is never filled', otherRole.event.type === 'submit_handoff'
      && otherRole.event.reason === 'posting_mismatch' && umantis.applications.length === 1, stopContext(otherRole));
    // Review of #11033: a password and «Submit final application» in sight, the CV field in a section still closed.
    const closedSections = await run({ applyUrl: `${base}/hotel-job-closed`, job: hotelJob, accounts: hotelAccounts, dryRun: true });
    const closedAuth = closedSections.evidence.steps.filter((step) => step.auth).map((step) => step.auth.kind);
    check('umantis: a password page whose CV field sits in a closed section is opened first, then filled as the form (never taken for a login)', closedSections.event.type === 'dry_run_ready'
      && !closedSections.event.stage && closedSections.evidence.finalButton?.label === 'Submit final application' && closedAuth.length > 0 && closedAuth.every(kind => kind === 'inline')
      && closedSections.evidence.postingMatch === 'match' && closedSections.evidence.steps.some((step) => (step.actions || []).some((action) => action.document === 'cv')), stopContext(closedSections));
  };
  const runCoopChecks = async () => {
    // Coop (2026-10-02): career page → Prospective.ch redirect → SuccessFactors, on an account of its own.
    const coopSaved = new Map();
    const coopAccounts = {
      async load(host) { return coopSaved.get(host) || null; },
      async save(host, { email, password }) { coopSaved.set(host, { email, password, createdAt: Date.now(), verifiedAt: null }); },
      async mark(host, patch) { coopSaved.set(host, { ...coopSaved.get(host), ...patch }); },
      async discard(host) { coopSaved.delete(host); },
      async waitForVerification() { return null; },
    };
    const coopJob = { company: 'Coop Genossenschaft', title: 'Bäcker:in - Konditor:in (Schwerpunkt Bäckerei)', location: 'Rickenbach' };
    const coopCandidate = { identity: { email: ALIAS, firstName: 'Luca', lastName: 'Bianchi', phone: '+41 79 000 00 00' }, profile: { dateOfBirth: '1990-05-12', location: 'Lugano', address: { street: 'Via Esempio 1', postalCode: '6830', city: 'Lugano', country: 'Svizzera' } }, answers: { portal_anrede: 'Herr' }, portalQuestionsAnswered: [] };
    const coopDry = await run({ applyUrl: `${base}/coop-job`, job: coopJob, accounts: coopAccounts, dryRun: true, capturePortalNavigationDiagnostics: true });
    check('Coop: past the shadow cookie banner, «Jetzt bewerben» (never «Später bewerben») reaches SuccessFactors’ registration', coopDry.event.type === 'dry_run_ready'
      && coopDry.event.stage === 'account' && coop.later === 0 && coop.accounts.size === 0,
    stopContext(coopDry), { reportDiagnostic: true });
    check('Coop: SuccessFactors’ own cookie manager («Alle Cookies ablehnen») is refused, the sign-in page behind it is reached', coop.cookieManager === 'rejected');
    const coopFirst = await run({ applyUrl: `${base}/coop-job`, job: coopJob, accounts: coopAccounts, candidate: coopCandidate });
    const coopAuth = coopFirst.evidence.steps.filter((step) => step.auth).map((step) => step.auth);
    check('Coop: the account is created (16-character password, country, privacy statement accepted, no job alert) and the application sent with «Bewerben»',
      coopFirst.event.type === 'submit_succeeded' && coop.accounts.size === 1 && coop.privacyAccepted === 1 && !coop.jobAbo
      && coop.refused.length === 0 && coop.outsideAccept === 0 && coopAuth.some((auth) => auth.privacy === 'accepted') && coopFirst.evidence.finalButton?.label === 'Bewerben'
      && coop.applications.length === 1 && coop.applications[0].hasCv && coop.applications[0].first === 'Luca', {
        ...stopContext(coopFirst), portal: {
          refusalReasons: coop.refused.slice(-3), privacyAcceptedCount: coop.privacyAccepted,
          outsideConsentAcceptedCount: coop.outsideAccept, jobAlertEnabled: coop.jobAbo,
          accountCount: coop.accounts.size,
        },
      });
    check('Coop: SuccessFactors’ picklists, its UI5 birth date and «Vermittlungsbüro?» (always Nein) are filled',
      coop.applications[0]?.anrede === 'Herr' && coop.applications[0]?.birth === '12.05.1990' && coop.applications[0]?.agency === 'Nein');
    check('Coop: the closed sections are opened and the CV goes in through «Lebenslauf hochladen» before «Bewerben»',
      coop.validationRefusals === 0 && coop.cvUploads === 1 && coopFirst.evidence.steps.some((step) => step.cv === 'uploaded')
      && (coopFirst.evidence.finalOutcomes || []).join(',') === 'confirmed' && coopFirst.evidence.uploads?.some((item) => item.document === 'cv'));
    check('Coop: the sign-in page names no company, so the posting is checked on the form behind it', coopFirst.evidence.postingMatch === 'match');
    // This time the portal drops the first click on the sections and on the CV dialog.
    coop.flaky = true;
    const coopAgain = await run({ applyUrl: `${sfOrigin(server)}${SF_JOB}`, job: coopJob, accounts: coopAccounts, candidate: coopCandidate });
    coop.flaky = false;
    check('Coop: a dropped first click on the sections or the CV dialog is tried again, never «Bewerben» on a closed form',
      coopAgain.event.type === 'submit_succeeded' && coop.validationRefusals === 0 && coop.cvUploads === 2
      && coopAgain.evidence.steps.some((step) => step.cv === 'uploaded'));
    check('Coop: a run that starts on SuccessFactors (the resolved redirect) signs in with the stored account', coopAgain.event.type === 'submit_succeeded'
      && coopAgain.evidence.steps.filter((step) => step.auth).map((step) => step.auth.kind).join(',') === 'sign_in' && coop.accounts.size === 1 && coop.applications.length === 2);
    coop.privacyValidationRetry = true;
    const privacyRetry = await run({ applyUrl: `${sfOrigin(server)}${SF_JOB}`, job: coopJob, accounts: coopAccounts, candidate: coopCandidate });
    check('SuccessFactors reopens and accepts the required privacy statement after same-page validation',
      privacyRetry.event.type === 'submit_succeeded' && coop.privacyValidationRetries === 1
      && coop.applicationPrivacySubmissions.slice(-2).join(',') === '1,1');
  };
  const workdayFocus = process.env.AA_PORTAL_E2E_FOCUS;
  const focusWorkdayTenant = workdayFocus === 'workday-tenant';
  const focusWorkdayTenantSmoke = workdayFocus === 'workday-tenant-smoke';
  const focusWorkday = workdayFocus === 'workday-assisted' || workdayFocus === 'workday-auth' || focusWorkdayTenant || focusWorkdayTenantSmoke;
  const focusCoop = workdayFocus === 'coop';
  const focusRegistration = process.env.AA_PORTAL_E2E_FOCUS === 'registration-retry';
  const focusAgentBirthDate = workdayFocus === 'agent-birth-date';
  const focusDiagnostics = workdayFocus === 'diagnostics';
  const focusUmantis = workdayFocus === 'umantis';
  const focusModalApplication = workdayFocus === 'modal-application';
  try {
    if (!focusModalApplication && !focusWorkdayTenant && !focusWorkdayTenantSmoke) await hiddenFutureStepFileCheck({ executablePath, check });
    if (focusWorkday) {
      await workdayAccountChecks({ base: workdayBase, tenantBase: workdayTenantBase, state, workday, files, executablePath, browserTlsSpkiPin: tlsFixture.spkiPin, check, bindReceiptJobId }, workdayFocus === 'workday-assisted', focusWorkdayTenant || focusWorkdayTenantSmoke, focusWorkdayTenantSmoke);
    } else if (focusCoop) {
      await runCoopChecks();
    } else if (focusAgentBirthDate) {
      const unknown = await run({ applyUrl: `${base}/widget-job`, candidate: portalTestCandidate({ dateOfBirth: null }) });
      const asked = unknown.event.questions || [];
      check('without the birth date the agent asks the candidate and sends nothing', unknown.event.type === 'submit_needs_candidate'
        && asked.length === 1 && asked[0].applicationQuestion === 'Geburtsdatum *' && asked[0].question === 'Qual è la tua data di nascita?'
        && asked[0].type === 'date' && state.widgetApplications.length === 0, stopContext(unknown));
    } else if (focusDiagnostics) {
      const diagnosticRefusal = await run({ applyUrl: `${base}/diagnostic-refused` });
      const diagnostics = diagnosticRefusal.evidence.diagnostics;
      check('a refused submit records console and uncaught browser errors privately', diagnosticRefusal.event.error === 'portal_refused'
        && diagnostics.console.some((entry) => entry.text.includes('Profile URL invalid'))
        && diagnostics.pageErrors.some((entry) => entry.message === 'client_submit_validation')
        && !JSON.stringify(diagnostics).includes('private-test-token'), stopContext(diagnosticRefusal));
      const capturedChunkedError = diagnostics.responses.some((entry) => entry.source === 'browser_stream' && entry.status === 200 && entry.errors?.some((error) => error.code === 'INVALID_URL'));
      const capturedInvalidLinkedIn = diagnostics.validation.some((entry) => entry.phase === 'after_submit' && entry.frames.some((frame) => frame.invalid.some((field) => field.label === 'LinkedIn')));
      check('chunked HTTP 200 application errors and native field validation are captured', capturedChunkedError && capturedInvalidLinkedIn,
        { capturedChunkedError, capturedInvalidLinkedIn });
    } else if (focusUmantis) {
      await runUmantisChecks();
    } else if (focusModalApplication) {
      Object.assign(state.gravityApplication, { openerClicks: 0, submissions: 0, day: '', month: '', year: '', hasCv: false });
      const modal = await run({ applyUrl: `${base}/gravity-modal-job`, dryRun: true });
      const dayCorrect = state.gravityApplication.day === '12.';
      const monthCorrect = state.gravityApplication.month === '05';
      const yearCorrect = state.gravityApplication.year === '1990';
      const birthDateCorrect = dayCorrect && monthCorrect && yearCorrect;
      const openerUnused = state.gravityApplication.openerClicks === 0;
      const submissionProtected = state.gravityApplication.submissions === 0;
      const finalControlProtected = modal.event.type === 'dry_run_ready' && modal.evidence.finalButton?.label === 'Abschicken';
      const pageTwoStage = modal.evidence.steps.find((step) => step.step === 2)?.applicationStage?.kind;
      check('non-ARIA two-page application ignores both openers, reaches page 2 as a form, chooses the birth-date day, and protects Abschicken',
        finalControlProtected && pageTwoStage === 'form' && birthDateCorrect && openerUnused && submissionProtected,
        { finalControlProtected, pageTwoStage, dayCorrect, monthCorrect, yearCorrect, openerUnused, submissionProtected });
      Object.assign(state.gravityApplication, { openerClicks: 0, submissions: 0, day: '', month: '', year: '', hasCv: false });
      const submitted = await run({ applyUrl: `${base}/gravity-modal-job` });
      const submittedPageTwoStage = submitted.evidence.steps.find((step) => step.step === 2)?.applicationStage?.kind;
      check('non-ARIA Gravity Forms AJAX confirmation follows one guarded submit and confirms the replaced form',
        submitted.event.type === 'submit_succeeded' && submittedPageTwoStage === 'form'
          && submitted.evidence.finalOutcomes?.at(-1) === 'confirmed'
          && state.gravityApplication.submissions === 1 && state.gravityApplication.hasCv === true,
        { event: submitted.event.type, submittedPageTwoStage, outcome: submitted.evidence.finalOutcomes?.at(-1), submissions: state.gravityApplication.submissions, hasCv: state.gravityApplication.hasCv });
      Object.assign(state.gravityApplication, { openerClicks: 0, submissions: 0, day: '', month: '', year: '', hasCv: false });
      const iframeSubmitted = await run({ applyUrl: `${base}/gravity-iframe-job` });
      check('same-origin Gravity Forms iframe receipt is read from the guarded form frame',
        iframeSubmitted.event.type === 'submit_succeeded'
          && iframeSubmitted.evidence.finalOutcomes?.at(-1) === 'confirmed'
          && state.gravityApplication.submissions === 1 && state.gravityApplication.hasCv === true
          && state.gravityApplication.openerClicks === 0,
        { event: iframeSubmitted.event.type, reason: iframeSubmitted.event.reason, outcome: iframeSubmitted.evidence.finalOutcomes?.at(-1), submissions: state.gravityApplication.submissions, hasCv: state.gravityApplication.hasCv, openerUnused: state.gravityApplication.openerClicks === 0 });
    } else if (!focusRegistration) {
    // Keep this timing-sensitive portal first in the full suite; the same
    // scenarios also run alone through AA_PORTAL_E2E_FOCUS=coop.
    await runCoopChecks();
    const dry = await run({ dryRun: true });
    check('a dry run stops before creating the account', dry.event.type === 'dry_run_ready' && dry.event.stage === 'account' && state.accounts.size === 0);
    // The portal refuses the registration once: no account is kept, so the next run creates it again.
    state.refuseNextRegistration = true;
    const refused = await run();
    check('a refused registration hands off and keeps no account', refused.event.type === 'submit_handoff' && refused.event.reason === 'account_create_refused' && !saved.has(accountHost) && state.accounts.size === 0);
    const first = await run();
    check('the first run creates the account on the alias, verifies it and applies', first.event.type === 'submit_succeeded' && state.accounts.has(ALIAS) && state.verified.has(ALIAS), stopContext(first));
    check('the password is stored and the account marked verified', Boolean(saved.get(accountHost)?.password) && Boolean(saved.get(accountHost)?.verifiedAt));
    const again = await run();
    const auth = again.evidence.steps.filter((step) => step.auth).map((step) => step.auth.kind);
    check('a later run signs in with the stored account', again.event.type === 'submit_succeeded' && auth.join(',') === 'sign_in' && state.accounts.size === 1, stopContext(again));
    check('both applications carry the CV and the name', state.applications.length === 2 && state.applications.every((item) => item.hasCv && item.first === 'Luca'), {
      applicationCount: state.applications.length,
      applications: state.applications.map((item) => ({ hasCv: item.hasCv, hasName: Boolean(item.first) })),
      run: stopContext(again),
    });
    // OTP-based SuccessFactors only creates the external account after code
    // verification. Reproduce a run that saved its password but lost the OTP
    // page: login stays on the generic sign-in error, so the runner must
    // restart registration with the same credential and consume a fresh code.
    state.verified.delete(ALIAS);
    state.sessions.clear();
    state.unverifiedLoginStaysOnSignIn = true;
    saved.set(otpAccountHost, { ...saved.get(accountHost), verifiedAt: null });
    state.omitNextRegistrationSubmit = true;
    const missingRetryButton = await run({ applyUrl: `${otpBase}/job` });
    check('a missing retry button hands off without discarding the saved credential', missingRetryButton.event.type === 'submit_handoff'
      && missingRetryButton.event.reason === 'account' && Boolean(saved.get(otpAccountHost)?.password) && saved.get(otpAccountHost)?.verifiedAt === null);
    const recovered = await run({ applyUrl: `${otpBase}/job` });
    check('an unverified saved account restarts registration and verifies before applying', recovered.event.type === 'submit_succeeded' && state.verified.has(ALIAS) && Boolean(saved.get(otpAccountHost)?.verifiedAt) && state.applications.length === 3, stopContext(recovered));
    state.unverifiedLoginStaysOnSignIn = false;
    check('the evidence names the files the form received', first.evidence.uploads?.some((item) => item.document === 'cv'), {
      documents: (first.evidence.uploads || []).map((item) => item.document),
    });
    check('the newsletter box is left alone', !state.newsletter);
    const rhb = await run({ applyUrl: `${base}/rhb-form`, codex: async (request) => {
      if (request.prompt.includes('{"agentPage"')) throw new Error('standard_send_button_must_not_need_agent');
      return fakeCodex(request);
    } });
    check('RhB Senden submits once with the required CV without agentic button discovery',
      rhb.event.type === 'submit_succeeded' && rhb.evidence.finalOutcomes?.at(-1) === 'confirmed'
      && state.rhbApplications.length === 1 && state.rhbApplications[0].hasCv);
    const sixApplyUrl = `${base}/talentcommunity/apply/1448418433/?locale=en_US`;
    const sixPostingUrl = `${base}/job/Zurich-Senior-IT-Manager/1448418433/`;
    const sixJob = { title: 'Senior IT Manager - CIO Office', company: 'SIX Group' };
    const sixDirect = await run({ applyUrl: sixApplyUrl, job: sixJob });
    check('SIX cold apply redirects to the generic careers page and never sends', sixDirect.event.type === 'submit_handoff' && state.sixApplications.length === 0);
    let sixReadSawWorkload = false;
    const sixRead = await readPortalRequirements({
      channelType: 'employer_site', applyUrl: sixApplyUrl, postingUrl: sixPostingUrl, language: 'en', candidateLocale: 'it',
      candidate: { identity: { email: ALIAS } },
      codex: async (request) => {
        const result = await fakeCodex(request);
        const input = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf('{"form"'), request.prompt.lastIndexOf('\n\nReturn exactly')));
        const workload = input.form.fields.find((field) => /preferred workload/i.test(field.label));
        sixReadSawWorkload = Boolean(workload);
        return { ...result, missingRequired: workload ? [{ fieldId: workload.id, question: workload.label }] : [] };
      },
      launch: () => launchChromium({ headless: true, executablePath }),
    });
    check('SIX pre-read recognizes workload without asking the candidate for an operational default', sixReadSawWorkload
      && !sixRead.questions.some((item) => /preferred workload/i.test(item.applicationQuestion || item.question)) && state.sixPostingViews === 1);
    const sixCodex = async (request) => {
      const planned = await fakeCodex(request);
      if (!request.prompt.includes('{"form"')) return planned;
      const payload = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf('{"form"'), request.prompt.lastIndexOf('\n\nReturn exactly')));
      const cv = payload.form.fields.find((field) => field.kind === 'file' && /resume|cv/i.test(field.label));
      const workload = payload.form.fields.find((field) => /preferred workload/i.test(field.label));
      const workloadAnswer = payload.candidate?.portalQuestionsAnswered?.find((item) => /preferred workload/i.test(item.applicationQuestion || item.question || ''))?.answer || '';
      // Deliberately leave the model's missing preference in the plan: the
      // deterministic owner policy must resolve the soft question to 100%.
      // An explicit reviewed preference on a later run must still win.
      const gated = workload && !String(workloadAnswer).trim()
        ? { ...planned, missingRequired: [{ fieldId: workload.id, question: workload.label }] }
        : planned;
      if (!cv) return gated;
      // The deterministic runner must attach a supplied CV even when the plan omits it.
      return { ...gated, actions: gated.actions.map((action) => action.fieldId === cv.id ? { ...action, action: 'skip', document: 'none' } : action) };
    };
    const sixCandidate = {
      identity: { email: ALIAS },
      profile: { location: 'Lugano', address: { street: 'Via Esempio 1', postalCode: '6830', city: 'Lugano', country: 'Svizzera' } },
    };
    const sixDefault = await run({
      applyUrl: sixApplyUrl, postingUrl: sixPostingUrl, job: sixJob,
      codex: sixCodex,
      candidate: sixCandidate,
    });
    check('SIX submits with the 100% operational default when no hard facts are missing', sixDefault.event.type === 'submit_succeeded'
      && state.sixApplications.length === 1 && state.sixApplications[0].workload === '100%'
      && state.sixApplications[0].hasCv === true, {
      event: sixDefault.event,
      postingViews: state.sixPostingViews,
      applications: state.sixApplications.map(({ workload, hasCv }) => ({ workload, hasCv })),
      postingMatch: sixDefault.evidence.postingMatch,
      uploads: sixDefault.evidence.uploads,
      finalButton: sixDefault.evidence.finalButton,
      steps: sixDefault.evidence.steps.map(({ url, fields, applicationStage }) => ({ path: new URL(url).pathname, fields, applicationStage })),
      stopReport: sixDefault.evidence.stopReport,
    });
    const six = await run({
      applyUrl: sixApplyUrl, postingUrl: sixPostingUrl, job: sixJob,
      codex: sixCodex,
      candidate: {
        identity: { email: ALIAS },
        profile: { location: 'Lugano', address: { street: 'Via Esempio 1', postalCode: '6830', city: 'Lugano', country: 'Svizzera' } },
        portalQuestionsAnswered: [{ question: 'What is your preferred workload?', answer: '80%' }],
      },
    });
    check('SIX opens the matching form and submits with the reviewed workload answer', six.event.type === 'submit_succeeded'
      && state.sixPostingViews === 3 && state.sixApplications.length === 2 && state.sixApplications[1].workload === '80%'
      && six.evidence.postingMatch === 'match', {
      event: six.event,
      postingViews: state.sixPostingViews,
      applications: state.sixApplications.map(({ workload, hasCv }) => ({ workload, hasCv })),
      postingMatch: six.evidence.postingMatch,
      uploads: six.evidence.uploads,
      finalButton: six.evidence.finalButton,
      steps: six.evidence.steps.map(({ url, fields, applicationStage }) => ({ path: new URL(url).pathname, fields, applicationStage })),
      stopReport: six.evidence.stopReport,
    });
    check('SIX uploads the supplied CV when the planner skips its file field', state.sixApplications[1]?.hasCv === true
      && six.evidence.uploads?.some((item) => item.document === 'cv'), {
      application: state.sixApplications[1] && { workload: state.sixApplications[1].workload, hasCv: state.sixApplications[1].hasCv },
      uploads: six.evidence.uploads,
      finalButton: six.evidence.finalButton,
      steps: six.evidence.steps.map(({ url, fields, applicationStage }) => ({ path: new URL(url).pathname, fields, applicationStage })),
      stopReport: six.evidence.stopReport,
    });
    // The agentic fallback on a custom calendar (Playwright's snapshot refs, a real browser).
    const unknown = await run({ applyUrl: `${base}/widget-job`, candidate: portalTestCandidate({ dateOfBirth: null }) });
    const asked = unknown.event.questions || [];
    check('without the birth date the agent asks the candidate and sends nothing', unknown.event.type === 'submit_needs_candidate'
      && asked.length === 1 && asked[0].applicationQuestion === 'Geburtsdatum *' && Boolean(asked[0].question) && asked[0].type === 'date' && state.widgetApplications.length === 0, stopContext(unknown));
    // Review of #10707: Codex failing inside the fallback ends in the owner's handoff, not a failed run.
    const failing = async (request) => {
      if (request.prompt.includes('{"agentPage"')) throw new Error('timeout');
      return fakeCodex(request);
    };
    const broken = await run({ applyUrl: `${base}/widget`, codex: failing, candidate: portalTestCandidate() });
    check('a Codex failure in the fallback hands the order to the owner', broken.event.type === 'submit_handoff'
      && broken.event.reason === 'portal_needs_candidate' && state.widgetApplications.length === 0);
    const widget = await run({ applyUrl: `${base}/widget-job`, candidate: portalTestCandidate() });
    const agentSteps = widget.evidence.steps.filter((step) => step.agent);
    // Second review of #10707: a select picks only the exact option ("1990" is not "1990s").
    const listPage = await (await launchChromium({ headless: true, executablePath })).newPage();
    await listPage.setContent('<input role="combobox" aria-label="Jahr" aria-controls="years"><div role="listbox" id="years"><div role="option">1990s</div></div>');
    const yearRef = /combobox "Jahr" \[ref=(\w+)\]/.exec((await aiSnapshot(listPage)) || '')?.[1];
    const near = await runAction(listPage, { ref: yearRef, action: 'select', value: '1990' });
    check('a select never takes a near option', near.ok === false && near.error === 'option_not_found');
    await listPage.context().browser().close();
    // Review of #10822: visible unrelated year/month lists must not shift JOIN's
    // selections away from the popups controlled by the date comboboxes.
    const dateBrowser = await launchChromium({ headless: true, executablePath });
    const datePage = await dateBrowser.newPage();
    const unrelatedOptions = Array.from({ length: 12 }, (_, index) => `<div role="option">Unrelated ${index + 1}</div>`).join('');
    const unrelatedYearOptions = '<div role="option">2025</div>';
    const monthOptions = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
      .map((label, index) => `<div role="option" data-month="${index + 1}">${label}</div>`).join('');
    await datePage.setContent(`<div data-scope="date-picker" data-part="root" aria-label="Birth date">
      <input id="date-year" role="combobox" aria-controls="date-years" value="">
      <input id="date-month" role="combobox" aria-controls="date-months" value="">
      <div role="listbox" id="unrelated-options">${unrelatedOptions}</div>
      <div role="listbox" id="date-years"><div role="option">2025</div></div>
      <div role="listbox" id="unrelated-years">${unrelatedYearOptions}</div>
      <div role="listbox" id="date-months" style="display:none">${monthOptions}</div>
      <div role="listbox" id="unrelated-months">${monthOptions}</div>
      <div data-part="table"><div data-part="table-cell-trigger" role="button" data-value="2025-05-12" style="display:none">12</div></div>
    </div><script>
      const year = document.getElementById('date-year');
      const month = document.getElementById('date-month');
      const months = document.getElementById('date-months');
      const day = document.querySelector('[data-value="2025-05-12"]');
      month.addEventListener('keydown', (event) => { if (event.key === 'ArrowDown') months.style.display = ''; });
      document.querySelector('#date-years [role="option"]').addEventListener('click', () => { year.value = '2025'; });
      months.querySelectorAll('[role="option"]').forEach((option) => option.addEventListener('click', () => { month.value = option.dataset.month; day.style.display = ''; }));
      day.addEventListener('click', () => day.setAttribute('data-selected', ''));
    </script>`);
    const dateSnapshot = await extractFields(datePage);
    const dateField = dateSnapshot.fields.find((field) => field.kind === 'date');
    const dateResult = await applyActions(datePage, dateSnapshot.fields, [
      { fieldId: dateField?.id, action: 'fill', value: '2025-05-12' },
    ], {}, { pause: async () => {} });
    const pickedDate = await datePage.locator('[data-part="table-cell-trigger"][data-selected]').getAttribute('data-value').catch(() => '');
    const pickedYear = await datePage.locator('#date-year').inputValue();
    const pickedMonth = await datePage.locator('#date-month').inputValue();
    check('unrelated visible year and month lists cannot shift the JOIN picker', dateResult[0]?.ok === true
      && pickedDate === '2025-05-12' && pickedYear === '2025' && pickedMonth === '5');
    await dateBrowser.close();

    // Rexx-style controls: a styled native select and an optional AI parser
    // dialog opened only after choosing the required attachment.
    const parserBrowser = await launchChromium({ headless: true, executablePath });
    try {
      const parserPage = await parserBrowser.newPage();
      await parserPage.goto(`${base}/careers.html`);
      let parserUploads = 0;
      await parserPage.route('**/optional-parser-upload', async route => {
        parserUploads++;
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      });
      await parserPage.setContent(`<form>
        <label for="notice">Attuale periodo di preavviso *</label>
        <select id="notice" name="notice" required style="display:none"><option value="">---</option><option value="month1">1 mese</option><option value="month3">3 mesi</option></select>
        <span id="notice-button" class="ui-selectmenu-button" role="combobox" aria-owns="notice-menu" tabindex="0">---</span>
        <ul id="notice-menu" style="display:none"><li><div data-month="month1">1 mese</div></li><li><div data-month="month3">3 mesi</div></li></ul>
        <label for="parser-cv">Curriculum vitae *</label><input id="parser-cv" type="file" required>
        <input id="parser-privacy" type="checkbox" required style="display:none"><label for="parser-privacy">I accept the Privacy Policy</label>
        <label for="parser-newsletter">Marketing newsletter</label><input id="parser-newsletter" type="checkbox">
        <button type="submit">Submit application</button></form>
        <div role="dialog" style="display:none" id="parser-dialog">
          Per un riempimento automatico più preciso i contenuti possono essere valutati da un’intelligenza artificiale (IA).
          La decisione di procedere senza IA non ha alcun effetto sul prosieguo del processo di candidatura.
          <button type="button" id="parser-accept">Accettare</button><button type="button" id="parser-decline">Rifiutare</button>
        </div><script>
          window.parserAccepted = 0; window.parserDeclined = 0; window.parserSent = 0;
          const native = document.querySelector('#notice');
          const menu = document.querySelector('#notice-menu');
          document.querySelector('#notice-button').onclick = () => { menu.style.display = ''; };
          menu.querySelectorAll('[data-month]').forEach(item => item.onclick = () => {
            native.value = item.dataset.month; menu.style.display = 'none';
            document.querySelector('#notice-button').textContent = item.textContent;
          });
          const dialog = document.querySelector('#parser-dialog');
          const cv = document.querySelector('#parser-cv');
          cv.onchange = () => { dialog.style.display = ''; };
          document.querySelector('#parser-accept').onclick = () => { window.parserAccepted++; };
          document.querySelector('#parser-decline').onclick = async () => {
            window.parserDeclined++; dialog.style.display = 'none';
            const body = new FormData(); body.append('cv', cv.files[0]);
            await fetch('/optional-parser-upload', { method: 'POST', body });
          };
          document.querySelector('form').onsubmit = event => { event.preventDefault(); window.parserSent++; };
        </script>`);
      const parserSnapshot = await extractFields(parserPage);
      const parserActions = [
        { fieldId: parserSnapshot.fields.find(field => field.widget === 'jquery-selectmenu')?.id, action: 'select', value: '3 mesi' },
        { fieldId: parserSnapshot.fields.find(field => field.kind === 'checkbox' && /Privacy/.test(field.label))?.id, action: 'check' },
        { fieldId: parserSnapshot.fields.find(field => field.kind === 'file')?.id, action: 'upload', document: 'cv' },
      ];
      const parserResults = await applyActions(parserPage, parserSnapshot.fields, parserActions, files, { pause: async () => {} });
      const parserState = await parserPage.evaluate(() => ({
        notice: document.querySelector('#notice').value, privacy: document.querySelector('#parser-privacy').checked,
        newsletter: document.querySelector('#parser-newsletter').checked,
        accepted: window.parserAccepted, declined: window.parserDeclined, sent: window.parserSent,
      }));
      check('owned selectmenu commits three months and the optional parser is declined before upload confirmation',
        parserResults.length === 3 && parserResults.every(result => result.ok)
        && parserResults.some(result => result.uploadAccepted) && parserUploads === 1
        && parserState.notice === 'month3' && parserState.privacy && !parserState.newsletter
        && parserState.accepted === 0 && parserState.declined === 1 && parserState.sent === 0);
    } finally { await parserBrowser.close(); }

    const sessionBrowser = await launchChromium({ headless: true, executablePath });
    try {
      const context = await sessionBrowser.newContext();
      await context.addCookies([{ name: 'sid', value: 'synthetic-session', url: base }]);
      await registerCookieSessionRecovery(context);
      const page = await context.newPage();
      await page.goto(`${base}/careers.html`);
      const result = await page.evaluate(async () => {
        const response = await fetch('/cookiecheck-cc0.html?sid=synthetic-session');
        return { status: response.status, body: await response.json() };
      });
      check('a failing session-query preflight recovers through the same proven cookie session',
        result.status === 200 && result.body.cookie_allowed === true && result.body.session_id === 'synthetic-session');
    } finally { await sessionBrowser.close(); }

    const unownedBrowser = await launchChromium({ headless: true, executablePath });
    const unownedPage = await unownedBrowser.newPage();
    await unownedPage.setContent(`<div data-scope="date-picker" data-part="root" aria-label="Birth date">
      <input id="unowned-year" role="combobox" value="">
      <input id="unowned-month" role="combobox" value="">
      <div role="listbox" id="unrelated-years"><div role="option">2025</div></div>
      <div role="listbox" id="unrelated-months">${monthOptions}</div>
      <div data-part="table"><div data-part="table-cell-trigger" role="button" data-value="2025-05-12" style="display:none">12</div></div>
    </div><script>
      window.unrelatedClicks = 0;
      document.querySelectorAll('#unrelated-years [role="option"], #unrelated-months [role="option"]')
        .forEach((option) => option.addEventListener('click', () => { window.unrelatedClicks += 1; }));
    </script>`);
    const unownedSnapshot = await extractFields(unownedPage);
    const unownedField = unownedSnapshot.fields.find((field) => field.kind === 'date');
    const unownedResult = await applyActions(unownedPage, unownedSnapshot.fields, [
      { fieldId: unownedField?.id, action: 'fill', value: '2025-05-12' },
    ], {}, { pause: async () => {} });
    const unrelatedClicks = await unownedPage.evaluate(() => window.unrelatedClicks);
    check('an unowned JOIN popup fails closed without clicking an unrelated list', unownedResult[0]?.ok === false && unrelatedClicks === 0);
    await unownedBrowser.close();
    // career-ops apply.md: company and role on the form match the posting, or stop.
    const elsewhere = await run({ applyUrl: `${base}/widget-job`, job: { company: 'Muster Elektro AG', title: 'Elektroinstallateur EFZ' }, candidate: portalTestCandidate() });
    check('a form for another job is never filled', elsewhere.event.type === 'submit_handoff' && elsewhere.event.reason === 'posting_mismatch' && state.widgetApplications.length === 1, stopContext(elsewhere));
    // career-ops "verify each selection": a click that does not take is a failure, not an answer.
    const comboPage = await (await launchChromium({ headless: true, executablePath })).newPage();
    await comboPage.setContent(`<label for="good">Land</label><div><input id="good" role="combobox" aria-controls="gl"><span id="gv"></span><div role="listbox" id="gl"><div role="option" onclick="document.getElementById('gv').textContent='Schweiz'; this.parentElement.remove()">Schweiz</div></div></div>
      <label for="bad">Nationalität</label><div><input id="bad" role="combobox" aria-controls="bl"><div role="listbox" id="bl"><div role="option" onclick="document.getElementById('bad').value=''">Italien</div></div></div>
      <label for="near">Wohnland</label><div><input id="near" role="combobox" aria-controls="nl"><span id="nv"></span><div role="listbox" id="nl"><div role="option" onclick="document.getElementById('nv').textContent='Italy'">Italy</div></div></div>`);
    const combo = await extractFields(comboPage);
    const byLabel = (label) => combo.fields.find((field) => field.label === label)?.id;
    const picked = await applyActions(comboPage, combo.fields, [
      { fieldId: byLabel('Land'), action: 'select', value: 'Schweiz' },
      { fieldId: byLabel('Nationalität'), action: 'select', value: 'Italien' },
      // Review of #10715: "IT" never picks the only option "Italy".
      { fieldId: byLabel('Wohnland'), action: 'select', value: 'IT' },
    ], {}, { pause: async () => {} });
    check('a choice is verified on the page', picked[0]?.ok === true && picked[1]?.ok === false && picked[1]?.error === 'choice_not_registered'
      && picked[2]?.ok === false && picked[2]?.error === 'option_not_found');
    await comboPage.context().browser().close();
    // Self-correction, levels 1 and 2: the agent names an unusual send button,
    // the runner presses it behind the guard, the portal's memory learns it.
    const portalMemory = new Map();
    const knowledge = {
      async load(host) { return portalMemory.get(host) || { finalButtons: [], nextButtons: [] }; },
      async learn(host, { finalButton = null, nextButtons = [] }) {
        const current = portalMemory.get(host) || { finalButtons: [], nextButtons: [] };
        const clean = (button) => ({ path: button.path, label: normalizeLabel(button.label) });
        portalMemory.set(host, {
          finalButtons: [...(finalButton ? [clean(finalButton)] : []), ...current.finalButtons],
          nextButtons: [...nextButtons.map(clean), ...current.nextButtons],
        });
      },
    };
    const turnsBefore = agentTurns;
    const named = await run({ applyUrl: `${base}/summary`, knowledge });
    check('the agent names an unusual send button and the runner presses it', named.event.type === 'submit_succeeded'
      && named.evidence.finalButton?.by === 'agent' && state.summarySubmissions === 1 && agentTurns > turnsBefore);
    const turnsLearned = agentTurns;
    const taught = await run({ applyUrl: `${base}/summary`, knowledge });
    check('the next run presses the learned button without the agent', taught.event.type === 'submit_succeeded'
      && taught.evidence.finalButton?.by === 'runner' && state.summarySubmissions === 2 && agentTurns === turnsLearned);
    const withCv = await run({ applyUrl: `${base}/summary-cv` });
    check('the agent’s send button is pressed under a required CV the runner attached', withCv.event.type === 'submit_succeeded'
      && withCv.evidence.finalButton?.by === 'agent' && state.summaryCv.length === 1 && state.summaryCv[0].hasCv);
    // Level 3: a page the runner cannot get through leaves an anonymous stop report.
    const dead = await run({ applyUrl: `${base}/dead-end` });
    check('a dead end leaves a stop report for the fix issue', dead.event.type === 'submit_handoff'
      && dead.evidence.stopReport?.path === '/dead-end' && dead.evidence.stopReport?.host === '127.0.0.1');
    // The send click leaves the page as it was, behind an invisible reCAPTCHA: Valerie is told it most likely did not arrive.
    const silent = await run({ applyUrl: `${base}/antibot` });
    check('a send the portal silently drops is reported as a likely anti-bot refusal', silent.event.type === 'submit_failed'
      && silent.event.error === 'portal_antibot_ambiguous' && silent.evidence.antibot === true);
    // A challenge served after the click and never passed: the application never left, Valerie completes it.
    const challenged = await run({ applyUrl: `${base}/hchallenge`, launch: launchWithLocalHcaptcha });
    check('a CAPTCHA served after the send click and never passed is a CAPTCHA stop, not an unknown outcome', challenged.event.type === 'submit_handoff'
      && challenged.event.reason === 'captcha' && challenged.evidence.challengeAfterClick === true);
    // The portal says it did not send: not ambiguous, and the runner's observed UA is in the evidence.
    const toast = await run({ applyUrl: `${base}/refused` });
    check('a send the portal refuses in words is a refusal, not an ambiguity', toast.event.type === 'submit_failed'
      && toast.event.error === 'portal_refused' && toast.evidence.antibot === true
      && typeof toast.evidence.browser?.userAgent === 'string');
    const diagnosticRefusal = await run({ applyUrl: `${base}/diagnostic-refused` });
    const diagnostics = diagnosticRefusal.evidence.diagnostics;
    check('a refused submit records console and uncaught browser errors privately', diagnosticRefusal.event.error === 'portal_refused'
      && diagnostics.console.some((entry) => entry.text.includes('Profile URL invalid'))
      && diagnostics.pageErrors.some((entry) => entry.message === 'client_submit_validation')
      && !JSON.stringify(diagnostics).includes('private-test-token'));
    const capturedChunkedError = diagnostics.responses.some((entry) => entry.source === 'browser_stream' && entry.status === 200 && entry.errors?.some((error) => error.code === 'INVALID_URL'));
    const capturedInvalidLinkedIn = diagnostics.validation.some((entry) => entry.phase === 'after_submit' && entry.frames.some((frame) => frame.invalid.some((field) => field.label === 'LinkedIn')));
    check('chunked HTTP 200 application errors and native field validation are captured', capturedChunkedError && capturedInvalidLinkedIn,
      { capturedChunkedError, capturedInvalidLinkedIn });
    const moved = await run({ applyUrl: `${base}/refused-moved` });
    check('a refusal on the error page the portal moved to is a refusal too', moved.event.type === 'submit_failed'
      && moved.event.error === 'portal_refused' && new URL(moved.evidence.finalUrl || '/', `${base}/`).pathname === '/refused-moved/error');
    // Review of #11015: a lost first click gets its own 8 s retry window.
    const slowBrowser = await launchChromium({ headless: true, executablePath });
    const slowPage = await slowBrowser.newPage();
    await slowPage.setContent(`<form><a role="button" tabindex="0" id="t">Datenschutzerklärung lesen und akzeptieren.</a>
      <input type="hidden" id="v" value=""><button type="button">Konto anlegen</button></form>
      <div role="dialog" id="d" hidden><h2>Datenschutzerklärung</h2><button type="button" id="ok">Akzeptieren</button></div>
      <script>
        // The first click is lost. Only the second click starts the 6 s open.
        let clicks = 0;
        document.getElementById('t').addEventListener('click', () => { clicks += 1; if (clicks === 2) setTimeout(() => { document.getElementById('d').hidden = false; }, 6000); });
        document.getElementById('ok').addEventListener('click', () => { document.getElementById('v').value = '1'; document.getElementById('d').hidden = true; });
      </script>`);
    const slow = await acceptPrivacyStatement(slowPage, await extractFields(slowPage, { listboxOptions: false }));
    check('a lost first privacy click is retried with a fresh 8 s window', slow === 'accepted' && await slowPage.locator('#v').inputValue() === '1');
    await slowBrowser.close();
    // Grand Hotel Kronenhof (2026-10-03): the posting's «Apply» opens umantis in a new tab; its form
    // asks for the account's password itself and names the role, never the company.
    await runUmantisChecks();
    check('the agent picks the day on the calendar and the runner sends the form', widget.event.type === 'submit_succeeded'
      && state.widgetApplications.length === 1 && state.widgetApplications[0].dob === '1990-05-12' && state.widgetApplications[0].hasCv
      && agentSteps.length === 1 && agentSteps[0].agent[0].status === 'done', stopContext(widget));
    await workdayAccountChecks({ base: workdayBase, tenantBase: workdayTenantBase, state, workday, files, executablePath, browserTlsSpkiPin: tlsFixture.spkiPin, check, bindReceiptJobId });
    }

    if (!focusWorkday && !focusCoop && !focusAgentBirthDate && !focusDiagnostics && !focusUmantis && !focusModalApplication) {
      const resetRegistration = () => {
        state.accounts.clear();
        state.verified.clear();
        state.sessions.clear();
        state.pending = null;
        state.registrationNeedsAnswer = false;
        state.registrationNeedsAnswerAfterValidation = false;
        state.registrationInvalidOnlyOnce = false;
        state.registeredPermit = '';
        saved.clear();
      };
      resetRegistration();
      const registrationsBeforeRepair = state.registrationRequests;
      const applicationsBeforeRepair = state.applications.length;
      state.registrationValidationOnce = true;
      state.registrationNeedsAnswerAfterValidation = true;
      const candidateWithPermit = portalTestCandidate({ permitAnswer: 'Yes' });
      const repairedRegistration = await run({ candidate: candidateWithPermit });
      check('a registration validation response replans a newly required known answer and retries automatically',
        repairedRegistration.event.type === 'submit_succeeded' && state.registrationRequests === registrationsBeforeRepair + 2
        && state.registeredPermit === 'Yes' && state.applications.length === applicationsBeforeRepair + 1
        && Boolean(saved.get(accountHost)?.verifiedAt), stopContext(repairedRegistration));

      resetRegistration();
      const registrationsBeforeInvalidOnly = state.registrationRequests;
      const applicationsBeforeInvalidOnly = state.applications.length;
      state.registrationInvalidOnlyOnce = true;
      const invalidOnlyRegistration = await run();
      check('a field marked aria-invalid without an error message is treated as a validation response and retried',
        invalidOnlyRegistration.event.type === 'submit_succeeded'
        && state.registrationRequests === registrationsBeforeInvalidOnly + 2
        && state.applications.length === applicationsBeforeInvalidOnly + 1
        && Boolean(saved.get(accountHost)?.verifiedAt), stopContext(invalidOnlyRegistration));

      resetRegistration();
      const registrationsBeforeQuestion = state.registrationRequests;
      const applicationsBeforeQuestion = state.applications.length;
      state.registrationValidationOnce = true;
      state.registrationNeedsAnswerAfterValidation = true;
      const registrationQuestion = await run({ candidate: portalTestCandidate({ permitAnswer: null }) });
      const permitQuestion = registrationQuestion.event.questions?.find((question) => /valid work permit/i.test(question.applicationQuestion || question.question || ''));
      check('a newly exposed registration fact becomes a candidate question and keeps the credential for resume',
        registrationQuestion.event.type === 'submit_needs_candidate' && Boolean(permitQuestion)
        && saved.get(accountHost)?.status === 'unanswered' && Boolean(saved.get(accountHost)?.password)
        && state.registrationRequests === registrationsBeforeQuestion + 1 && state.accounts.size === 0
        && state.applications.length === applicationsBeforeQuestion);
      if (permitQuestion) {
        const candidate = portalTestCandidate();
        candidate.answers.work_permit = 'Permesso G';
        candidate.answers[permitQuestion.id] = 'Yes';
        candidate.portalQuestionsAnswered = [
          ...candidate.portalQuestionsAnswered.filter((item) => item.id !== permitQuestion.id),
          { id: permitQuestion.id, question: permitQuestion.applicationQuestion || permitQuestion.question, context: permitQuestion.context, section: permitQuestion.section, autocomplete: permitQuestion.autocomplete, answer: 'Yes', source: 'user' },
        ];
        const resumedApplication = await run({ candidate });
        check('an answered registration question resumes account creation and submits the application',
          resumedApplication.event.type === 'submit_succeeded' && state.registeredPermit === 'Yes'
          && state.accounts.has(ALIAS) && state.verified.has(ALIAS)
          && state.applications.length === applicationsBeforeQuestion + 1, stopContext(resumedApplication));
      }
    }
  } finally {
    await Promise.all([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => workdayServer.close(resolve)),
    ]);
    await rm(dir, { recursive: true, force: true });
  }
  const failed = checks.filter((item) => !item.ok).length;
  if (process.env.AA_PORTAL_E2E_REPORT) {
    const report = {
      schemaVersion: 1,
      focus: process.env.AA_PORTAL_E2E_FOCUS || 'all',
      totalChecks: checks.length,
      passedChecks: checks.length - failed,
      failedChecks: checks.filter((item) => !item.ok).map((item) => item.name),
      diagnostics: checks.filter((item) => !item.ok && item.diagnostic)
        .map(({ name, diagnostic }) => ({ name, detail: diagnostic })),
    };
    await writeFile(process.env.AA_PORTAL_E2E_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(failed ? `${failed} check(s) failed` : 'portal e2e ok');
  process.exitCode = failed ? 1 : 0;
}

await main();
