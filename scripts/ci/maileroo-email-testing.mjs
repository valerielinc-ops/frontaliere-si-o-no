#!/usr/bin/env node
/**
 * Maileroo Email Testing CI.
 *
 * The runner sends two representative messages through the same Maileroo
 * Applications used in production, but addresses them to a Maileroo
 * Email-Testing ephemeral inbox. Maileroo captures those messages instead of
 * delivering them to a real recipient, then exposes the provider's analysis
 * and deterministic CI assertions.
 *
 * Required environment:
 *   MAILEROO_EMAIL_TESTING_API_KEY   restricted to email_testing.* scopes
 *   MAILEROO_TRANSACTIONAL_API_KEY   Frontaliere transactional Application key
 *   MAILEROO_NEWSLETTER_API_KEY      Frontaliere newsletter Application key
 *
 * Optional:
 *   MAILEROO_EMAIL_TESTING_REPORT    JSON report path
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildNewsletter } from '../../services/newsletter-template.mjs';
import {
  buildNewsletterConfirmationEmailHtml,
  confirmationConfirmUrl,
  confirmationEmailSubject,
} from '../../functions/src/lib/confirmationEmailContent.js';
import { htmlToText } from '../../functions/src/lib/mimeMessage.js';
import { makeOneClickUnsubscribeUrl, makePreferencesUrl } from '../../functions/src/lib/newsletterUrls.js';

const TESTING_BASE_URL = (process.env.MAILEROO_EMAIL_TESTING_BASE_URL || 'https://api.maileroo.com/v1/email-testing').replace(/\/+$/, '');
const EMAIL_API_URL = (process.env.MAILEROO_EMAIL_API_URL || 'https://smtp.maileroo.com/api/v2/emails').replace(/\/+$/, '');
const INBOX_TTL_SECONDS = 900;
const WAIT_TIMEOUT_MS = 40_000;
const ANALYSIS_POLL_INTERVAL_MS = 1_000;
const ANALYSIS_POLL_ATTEMPTS = 30;
const REPORT_VERSION = 1; // CI fixture contract
const TEST_LINK_SECRET = 'maileroo-email-testing-ci-fixture-secret';

const CASE_CONFIG = Object.freeze([
  {
    name: 'transactional-confirmation',
    stream: 'transactional',
    from: { address: 'confirmation@frontaliereticino.ch', display_name: 'Frontaliere Ticino' },
    subjectContains: 'Conferma la tua iscrizione',
  },
  {
    name: 'newsletter-weekly',
    stream: 'newsletter',
    from: { address: 'newsletter@frontaliereticino.ch', display_name: 'Frontaliere Ticino' },
    subjectContains: 'briefing',
  },
]);

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function assertNonEmpty(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is empty`);
  return normalized;
}

function safeRunId(raw) {
  const value = String(raw || '').trim().replace(/[^a-zA-Z0-9_.:-]+/g, '-');
  return (value || `local-${Date.now().toString(36)}`).slice(0, 80);
}

function safeLocalPart(runId) {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `frontaliere-ci-${runId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 28)}-${suffix}`.slice(0, 64);
}

function errorMessage(error) {
  return String(error?.message || error || 'unknown error').replace(/[\r\n]+/g, ' ').slice(0, 300);
}

function bodyMessage(body) {
  const candidate = body?.message
    || body?.error
    || body?.errors?.[0]?.message
    || body?.data?.message;
  return String(candidate || 'request failed').replace(/[\r\n]+/g, ' ').slice(0, 240);
}

function parseJsonOrNull(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function request(url, { fetchImpl = fetch, headers = {}, body, method = 'GET', timeoutMs = 60_000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: controller.signal,
    });
    const raw = await response.text();
    return { response, body: parseJsonOrNull(raw), raw };
  } finally {
    clearTimeout(timeout);
  }
}

function testingHeaders(apiKey, contentType = 'application/json') {
  return {
    Authorization: `Bearer ${apiKey}`,
    ...(contentType ? { 'Content-Type': contentType } : {}),
  };
}

async function testingRequest(path, apiKey, options = {}) {
  const result = await request(`${TESTING_BASE_URL}${path}`, {
    ...options,
    headers: {
      ...testingHeaders(apiKey, options.contentType || 'application/json'),
      ...(options.headers || {}),
    },
  });
  if (!result.response.ok) {
    throw new Error(`Email Testing API ${result.response.status}: ${bodyMessage(result.body)}`);
  }
  return result;
}

function buildTransactionalCase(recipient, runId) {
  const confirmUrl = confirmationConfirmUrl({
    email: recipient,
    token: 'ci-fixture-token',
    sourcePath: '/maileroo-email-testing/',
    mode: 'ci',
  });
  const subject = confirmationEmailSubject('it');
  const html = buildNewsletterConfirmationEmailHtml(confirmUrl, 'it');
  return {
    ...CASE_CONFIG[0],
    recipient,
    runId,
    subject,
    html,
    text: htmlToText(html),
    headers: {
      'X-Frontaliere-CI-Run': `${runId}:transactional-confirmation`,
      'X-Campaign-Id': 'maileroo-ci-transactional',
    },
  };
}

function buildNewsletterCase(recipient, runId) {
  const unsubscribeUrl = makeOneClickUnsubscribeUrl(recipient, { secret: TEST_LINK_SECRET });
  const preferencesUrl = makePreferencesUrl(recipient, 'it', { secret: TEST_LINK_SECRET });
  const html = buildNewsletter({
    locale: 'it',
    recipientName: 'Test',
    issueNumber: 9999,
    exchangeRate: { rate: 0.9412, previousRate: 0.9387 },
    totalJobs: 42,
    matchedJobs: [{
      title: 'Analista QA',
      url: 'https://frontaliereticino.ch/offerte/analista-qa/',
      company: 'Frontaliere Ticino',
      location: 'Lugano',
      contract: 'Tempo pieno',
    }],
    weeklyFact: {
      text: 'Una verifica automatica mantiene sotto controllo la qualità delle nostre email.',
      source: 'Frontaliere Ticino',
    },
    article: {
      title: 'Guida pratica per chi lavora tra Italia e Svizzera',
      excerpt: 'Un contenuto rappresentativo per controllare il rendering della newsletter.',
      url: 'https://frontaliereticino.ch/guide-frontaliere/',
      badge: true,
    },
    metrics: {
      unemploymentRate: '2,1%',
      unemploymentLabel: 'Disoccupazione CH',
      lamalPremium: 'CHF 400',
      lamalLabel: 'Premio LAMal Lugano',
    },
    interest: 'general',
    acquisitionSource: 'maileroo_ci',
    recommendationCampaign: 'maileroo_ci',
    unsubscribeUrl,
    preferencesUrl,
    preheaderText: 'Aggiornamento automatico di qualità Frontaliere Ticino',
  });
  return {
    ...CASE_CONFIG[1],
    recipient,
    runId,
    subject: 'Il briefing della settimana',
    html,
    text: htmlToText(html),
    headers: {
      'X-Frontaliere-CI-Run': `${runId}:newsletter-weekly`,
      'X-Campaign-Id': 'maileroo-ci-newsletter',
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'List-ID': 'Frontaliere Newsletter <weekly.frontaliereticino.ch>',
    },
  };
}

/** Build both fixtures from the real production renderers, without network access. */
export function buildTestCases({ recipient, runId }) {
  const safeRecipient = assertNonEmpty(recipient, 'recipient');
  const safeId = safeRunId(runId);
  return [
    buildTransactionalCase(safeRecipient, safeId),
    buildNewsletterCase(safeRecipient, safeId),
  ];
}

/** Build the Maileroo Email API v2 body for a rendered fixture. */
export function buildSendPayload(testCase) {
  return {
    from: testCase.from,
    to: [{ address: testCase.recipient }],
    subject: testCase.subject,
    html: testCase.html,
    plain: testCase.text,
    // Tracking is disabled only for the sandbox capture: assertions then test
    // the links authored by our templates, not provider tracking rewrites.
    tracking: false,
    headers: testCase.headers,
  };
}

export function buildAssertions(testCase) {
  const assertions = [
    { type: 'subject_contains', value: testCase.subjectContains },
    { type: 'recipient_eq', value: testCase.recipient },
    { type: 'spf_eq', value: 'pass' },
    { type: 'dkim_eq', value: 'pass' },
    { type: 'dmarc_eq', value: 'pass' },
    { type: 'auth_aligned_eq', value: true },
    { type: 'rspamd_score_lte', value: 5 },
    { type: 'links_rbl_clean', value: true },
    { type: 'ip_rbl_clean', value: true },
    { type: 'size_lte', value: 200_000 },
    { type: 'gmail_clip_eq', value: false },
    { type: 'accessibility_score_gte', value: 70 },
  ];
  if (testCase.stream === 'newsletter') assertions.push({ type: 'unsubscribe_valid_eq', value: true });
  return assertions;
}

function sendKeyFor(testCase) {
  return testCase.stream === 'newsletter'
    ? process.env.MAILEROO_NEWSLETTER_API_KEY
    : process.env.MAILEROO_TRANSACTIONAL_API_KEY;
}

async function sendThroughApplication(testCase, fetchImpl) {
  const apiKey = assertNonEmpty(sendKeyFor(testCase), `MAILEROO_${testCase.stream.toUpperCase()}_API_KEY`);
  const result = await request(EMAIL_API_URL, {
    fetchImpl,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify(buildSendPayload(testCase)),
    timeoutMs: 60_000,
  });
  if (!result.response.ok) throw new Error(`Maileroo Email API ${result.response.status}: ${bodyMessage(result.body)}`);
  if (result.body?.success === false) throw new Error(`Maileroo Email API rejected message: ${bodyMessage(result.body)}`);
  return result.body?.data?.reference_id || result.body?.data?.id || null;
}

async function createInbox(apiKey, fetchImpl, runId) {
  const result = await testingRequest('/mailboxes/ephemeral', apiKey, {
    fetchImpl,
    method: 'POST',
    body: JSON.stringify({ local_part: safeLocalPart(runId), ttl_seconds: INBOX_TTL_SECONDS }),
  });
  const inbox = result.body?.data;
  if (!inbox?.id || !inbox?.address) throw new Error('Email Testing API returned an incomplete ephemeral inbox');
  return inbox;
}

async function waitForMessage(apiKey, fetchImpl, testCase, inbox, receivedAfter) {
  const result = await testingRequest('/wait/messages', apiKey, {
    fetchImpl,
    method: 'POST',
    body: JSON.stringify({
      mailbox_id: inbox.id,
      recipient: inbox.address,
      sender: testCase.from.address,
      subject_contains: testCase.subjectContains,
      header_name: 'X-Frontaliere-CI-Run',
      header_value: testCase.headers['X-Frontaliere-CI-Run'],
      received_after: receivedAfter,
      timeout_ms: WAIT_TIMEOUT_MS,
    }),
    timeoutMs: WAIT_TIMEOUT_MS + 10_000,
  });
  if (result.response.status === 204 || !result.body?.data?.id) throw new Error(`timed out waiting for ${testCase.name}`);
  return result.body.data;
}

async function waitForAnalysis(apiKey, fetchImpl, messageId) {
  let lastStatus = 'unknown';
  for (let attempt = 0; attempt < ANALYSIS_POLL_ATTEMPTS; attempt += 1) {
    const result = await testingRequest(`/messages/${encodeURIComponent(messageId)}/analysis`, apiKey, {
      fetchImpl,
      timeoutMs: 30_000,
    });
    const analysis = result.body?.data;
    lastStatus = String(analysis?.status || 'unknown');
    if (lastStatus === 'complete' || lastStatus === 'ok') return analysis;
    if (['failed', 'error'].includes(lastStatus)) throw new Error(`analysis failed for ${messageId}`);
    await sleep(ANALYSIS_POLL_INTERVAL_MS);
  }
  throw new Error(`analysis did not complete (last status: ${lastStatus})`);
}

async function runAssertions(apiKey, fetchImpl, testCase, messageId) {
  const result = await testingRequest(`/messages/${encodeURIComponent(messageId)}/assertions`, apiKey, {
    fetchImpl,
    method: 'POST',
    body: JSON.stringify({ assertions: buildAssertions(testCase) }),
    timeoutMs: 60_000,
  });
  const report = result.body?.data;
  if (!report || report.pass !== true) {
    const failed = Array.isArray(report?.results)
      ? report.results.filter((item) => item?.pass !== true).map((item) => `${item.type}: ${item.message || `actual=${String(item.actual)}`}`)
      : ['Maileroo returned no assertion report'];
    throw new Error(`assertions failed for ${testCase.name}: ${failed.join('; ')}`);
  }
  return report;
}

function compactAnalysis(analysis) {
  return {
    status: analysis?.status || null,
    rspamdScore: analysis?.rspamd?.score ?? null,
    rspamdAction: analysis?.rspamd?.action ?? null,
    authentication: analysis?.authentication
      ? {
          spf: analysis.authentication.spf?.status || null,
          dkim: analysis.authentication.dkim?.status || null,
          dmarc: analysis.authentication.dmarc?.status || null,
          aligned: analysis.authentication.aligned ?? null,
        }
      : null,
    accessibilityScore: analysis?.accessibility?.score ?? null,
    unsubscribeValid: analysis?.unsubscribe?.valid ?? null,
  };
}

function compactAssertions(report) {
  return Array.isArray(report?.results)
    ? report.results.map((item) => ({ type: item.type, pass: item.pass, actual: item.actual ?? null, message: item.message || null }))
    : [];
}

async function deleteInbox(apiKey, fetchImpl, inboxId) {
  const result = await testingRequest(`/mailboxes/${encodeURIComponent(inboxId)}`, apiKey, {
    fetchImpl,
    method: 'DELETE',
    contentType: null,
    timeoutMs: 30_000,
  });
  return result.response.status;
}

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

async function writeReport(report, reportPath) {
  if (!reportPath) return;
  await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export async function runMailerooEmailTesting({ fetchImpl = fetch, runId = process.env.GITHUB_RUN_ID || `local-${Date.now()}`, reportPath = process.env.MAILEROO_EMAIL_TESTING_REPORT } = {}) {
  const startedAt = new Date().toISOString();
  const safeId = safeRunId(`${runId}-${process.env.GITHUB_RUN_ATTEMPT || '1'}`);
  const apiKey = assertNonEmpty(process.env.MAILEROO_EMAIL_TESTING_API_KEY, 'MAILEROO_EMAIL_TESTING_API_KEY');
  const report = {
    version: REPORT_VERSION,
    startedAt,
    runId: safeId,
    status: 'failed',
    cases: [],
    cleanup: { status: 'not_started' },
  };
  let inbox = null;
  try {
    inbox = await createInbox(apiKey, fetchImpl, safeId);
    const testCases = buildTestCases({ recipient: inbox.address, runId: safeId });
    for (const testCase of testCases) {
      const caseStartedAt = new Date().toISOString();
      const result = { name: testCase.name, stream: testCase.stream, status: 'failed', startedAt: caseStartedAt };
      try {
        const sentReference = await sendThroughApplication(testCase, fetchImpl);
        const message = await waitForMessage(apiKey, fetchImpl, testCase, inbox, caseStartedAt);
        const analysis = await waitForAnalysis(apiKey, fetchImpl, message.id);
        const assertions = await runAssertions(apiKey, fetchImpl, testCase, message.id);
        result.status = 'passed';
        result.messageId = message.id;
        result.sentReference = sentReference;
        result.analysis = compactAnalysis(analysis);
        result.assertions = compactAssertions(assertions);
        console.log(`✅ Maileroo ${testCase.name}: ${result.assertions.length} assertions passed`);
      } catch (error) {
        result.error = errorMessage(error);
        console.error(`❌ Maileroo ${testCase.name}: ${result.error}`);
      }
      result.finishedAt = new Date().toISOString();
      report.cases.push(result);
    }
    if (report.cases.every((item) => item.status === 'passed')) report.status = 'passed';
  } finally {
    if (inbox?.id) {
      try {
        const status = await deleteInbox(apiKey, fetchImpl, inbox.id);
        report.cleanup = { status: 'deleted', httpStatus: status };
      } catch (error) {
        report.cleanup = { status: 'failed', error: errorMessage(error) };
        console.error(`⚠️ Maileroo ephemeral inbox cleanup failed: ${report.cleanup.error}`);
        if (report.status === 'passed') report.status = 'failed';
      }
    } else {
      report.cleanup = { status: 'not_created' };
    }
    report.finishedAt = new Date().toISOString();
    await writeReport(report, reportPath);
  }
  if (report.status !== 'passed') throw new Error('Maileroo Email Testing CI failed; see the report for case details');
  return report;
}

async function main() {
  const reportPath = optionValue(process.argv.slice(2), '--report') || process.env.MAILEROO_EMAIL_TESTING_REPORT;
  await runMailerooEmailTesting({ reportPath });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`❌ ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
