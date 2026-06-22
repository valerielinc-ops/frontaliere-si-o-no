import { onRequest } from 'firebase-functions/v2/https';
import {
 ensureAdminApp,
 handleResendWebhookRequest,
} from './src/newsletterResendWebhookCore.js';
import { handleMailgunWebhookRequest } from './src/newsletterMailgunWebhookCore.js';
import { handleMailjetWebhookRequest } from './src/newsletterMailjetWebhookCore.js';
import { handleUnosendWebhookRequest } from './src/newsletterUnosendWebhookCore.js';
import { handleMailtrapWebhookRequest } from './src/newsletterMailtrapWebhookCore.js';
import { handleMailerooWebhookRequest } from './src/newsletterMailerooWebhookCore.js';
import { handleSubscriptionManagement } from './src/newsletterSubscriptionManagement.js';
import { sendNewsletterConfirmationEmail } from './src/newsletterConfirmationEmail.js';
import { handleSendCalculatorReport } from './src/sendCalculatorReport.js';
import { getNewsletterSecrets, getRemoteConfigValue } from './src/remoteConfigSecrets.js';
import { handleChatbotInference } from './src/chatbotInference.js';
import { handleLinkedInCallback } from './src/linkedinAuthCallback.js';
import { handleJobAlertUnsubscribe } from './src/jobAlertUnsubscribe.js';
import { handleRecaptchaVerification } from './src/recaptchaVerification.js';
import { getPublicConfigValues } from './src/publicConfig.js';
import { handleGeminiGenerate } from './src/geminiGenerate.js';
import { handleGetExchangeRate } from './src/exchangeRate.js';
import { handleCreateFeedbackIssue, handleGetAdminGithubToken } from './src/githubProxy.js';
import { handleCreatePublisherCheckout, handleStripeWebhook, handleCreateBillingPortal, handleArchivePublisherAd, handleRestorePublisherAd } from './src/stripePublisherCore.js';
import { reapStalePendingPayments } from './src/publisherPendingReapCore.js';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import {
  handleForwardApplication,
  handleGetApplicationCvUrl,
  purgeOldApplications,
} from './src/publisherApplicationsCore.js';
import { sendRenewalReminders } from './src/publisherRenewalCore.js';
import { handleVerifyPublisherDomain } from './src/publisherDomainVerifyCore.js';
import { enforceFreeTierCap } from './src/publisherFreeCapCore.js';

ensureAdminApp();

// Generic Gemini text generation (feedback "AI optimize", newsletter preview).
// Keeps GEMINI_API_KEY server-side.
export const geminiGenerate = onRequest(
 {
 region: 'europe-west6',
 memory: '256MiB',
 timeoutSeconds: 60,
 cors: true,
 },
 async (req, res) => {
 try {
 const { status, body } = await handleGeminiGenerate(req);
 res.status(status).json(body);
 } catch (error) {
 console.error('[geminiGenerate]', error instanceof Error ? error.message : String(error));
 res.status(500).json({ ok: false, error: 'internal_error' });
 }
 },
);

// Live CHF/EUR rate (keeps TWELVEDATA_API_KEY server-side). Edge-cached.
export const getExchangeRate = onRequest(
 {
 region: 'europe-west6',
 memory: '256MiB',
 timeoutSeconds: 15,
 cors: true,
 },
 async (req, res) => {
 try {
 const { status, body } = await handleGetExchangeRate(req);
 res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
 res.status(status).json(body);
 } catch (error) {
 console.error('[getExchangeRate]', error instanceof Error ? error.message : String(error));
 res.status(200).json({ ok: false, rate: null, error: 'internal_error' });
 }
 },
);

// Public feedback → GitHub issue (reCAPTCHA-gated). Keeps the repo PAT
// server-side instead of shipping it to every browser via the feedback form.
export const createFeedbackIssue = onRequest(
 {
 region: 'europe-west6',
 memory: '256MiB',
 timeoutSeconds: 30,
 cors: true,
 },
 async (req, res) => {
 try {
 const { status, body } = await handleCreateFeedbackIssue(req);
 res.status(status).json(body);
 } catch (error) {
 console.error('[createFeedbackIssue]', error instanceof Error ? error.message : String(error));
 res.status(500).json({ ok: false, error: 'internal_error' });
 }
 },
);

// Admin-only GitHub connection: returns the repo PAT to the verified admin
// (Firebase ID-token email allowlist) so `GITHUB_PAT` can leave the universal
// public config. The dashboard's existing GitHub logic is otherwise unchanged.
export const getAdminGithubToken = onRequest(
 {
 region: 'europe-west6',
 memory: '256MiB',
 timeoutSeconds: 30,
 cors: true,
 },
 async (req, res) => {
 try {
 const { status, body } = await handleGetAdminGithubToken(req);
 res.status(status).json(body);
 } catch (error) {
 console.error('[getAdminGithubToken]', error instanceof Error ? error.message : String(error));
 res.status(500).json({ ok: false, error: 'internal_error' });
 }
 },
);

// Browser-safe Remote Config: returns ONLY the allowlisted client params
// (see functions/src/publicConfig.js) so the full RC template — with all server
// secrets — never reaches the browser. Cached at the edge; fails open to the
// client's built-in defaults.
export const getPublicConfig = onRequest(
 {
 region: 'europe-west6',
 memory: '256MiB',
 timeoutSeconds: 30,
 cors: true,
 },
 async (req, res) => {
 try {
 const config = await getPublicConfigValues();
 res.set('Cache-Control', 'public, max-age=300, s-maxage=300');
 res.status(200).json(config);
 } catch (error) {
 console.error('[getPublicConfig]', error instanceof Error ? error.message : String(error));
 // Fail open: empty object → client uses its built-in defaults.
 res.status(200).json({});
 }
 },
);

export const newsletterResendWebhook = onRequest(
 {
 region: 'europe-west6',
 memory: '256MiB',
 timeoutSeconds: 60,
 cors: false,
 },
 async (req, res) => {
 if (req.method !== 'POST') {
 res.status(405).json({ ok: false, error: 'method_not_allowed' });
 return;
 }

 const payload = Buffer.isBuffer(req.rawBody)
 ? req.rawBody.toString('utf8')
 : typeof req.rawBody === 'string'
 ? req.rawBody
 : JSON.stringify(req.body || {});

 try {
 const { resendWebhookSecret } = await getNewsletterSecrets();
 const result = await handleResendWebhookRequest({
 payload,
 headers: req.headers,
 webhookSecret: resendWebhookSecret,
 });
 console.log(`[resendWebhook] ${result?.type || 'unknown'} → ${result?.handled ? 'handled' : (result?.reason || 'skipped')} for ${result?.email || '?'}`);
 res.status(200).json({ ok: true, result });
 } catch (error) {
 const message = error instanceof Error ? error.message : String(error || 'unknown_error');
 const status = /signature|svix|webhook/i.test(message) ? 401 : 500;
 console.error('[newsletterResendWebhook] Error:', message);
 res.status(status).json({ ok: false, error: message });
 }
 },
);

// Mailgun delivery event webhooks
export const newsletterMailgunWebhook = onRequest(
 {
 region: 'europe-west6',
 memory: '256MiB',
 timeoutSeconds: 60,
 cors: false,
 },
 async (req, res) => {
 if (req.method !== 'POST') {
 res.status(405).json({ ok: false, error: 'method_not_allowed' });
 return;
 }

 try {
 const signingKey = await getRemoteConfigValue('MAILGUN_WEBHOOK_SIGNING_KEY');
 const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
 const result = await handleMailgunWebhookRequest({ body, signingKey });
 res.status(200).json({ ok: true, result });
 } catch (error) {
 const message = error instanceof Error ? error.message : String(error || 'unknown_error');
 const status = /signature/i.test(message) ? 401 : 500;
 console.error('[newsletterMailgunWebhook] Error:', message);
 res.status(status).json({ ok: false, error: message });
 }
 },
);

// Mailjet delivery event webhooks
export const newsletterMailjetWebhook = onRequest(
 {
 region: 'europe-west6',
 memory: '256MiB',
 timeoutSeconds: 60,
 cors: false,
 },
 async (req, res) => {
 if (req.method !== 'POST') {
 res.status(405).json({ ok: false, error: 'method_not_allowed' });
 return;
 }

 try {
 const webhookSecret = await getRemoteConfigValue('MAILJET_SECRET_KEY');
 const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
 const result = await handleMailjetWebhookRequest({
 body,
 query: req.query,
 webhookSecret,
 });
 res.status(200).json({ ok: true, result });
 } catch (error) {
 const message = error instanceof Error ? error.message : String(error || 'unknown_error');
 const status = /secret/i.test(message) ? 401 : 500;
 console.error('[newsletterMailjetWebhook] Error:', message);
 res.status(status).json({ ok: false, error: message });
 }
 },
);

// Unosend delivery event webhooks
export const newsletterUnosendWebhook = onRequest(
 {
 region: 'europe-west6',
 memory: '256MiB',
 timeoutSeconds: 60,
 cors: true,
 },
 async (req, res) => {
 if (req.method === 'OPTIONS') {
 res.set('Access-Control-Allow-Origin', '*');
 res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
 res.set('Access-Control-Allow-Headers', 'Content-Type, webhook-id, webhook-timestamp, webhook-signature');
 res.status(204).send('');
 return;
 }
 if (req.method !== 'POST') {
 res.status(405).json({ ok: false, error: 'method_not_allowed' });
 return;
 }

 const payload = Buffer.isBuffer(req.rawBody)
 ? req.rawBody.toString('utf8')
 : typeof req.rawBody === 'string'
 ? req.rawBody
 : JSON.stringify(req.body || {});

 try {
 const signingSecret = await getRemoteConfigValue('UNOSEND_WEBHOOK_SECRET');
 const result = await handleUnosendWebhookRequest({
 payload,
 headers: req.headers,
 signingSecret,
 });
 res.status(200).json({ ok: true, result });
 } catch (error) {
 const message = error instanceof Error ? error.message : String(error || 'unknown_error');
 const status = /signature/i.test(message) ? 401 : 500;
 console.error('[newsletterUnosendWebhook] Error:', message);
 res.status(status).json({ ok: false, error: message });
 }
 },
);

// Mailtrap delivery event webhooks
export const newsletterMailtrapWebhook = onRequest(
 {
 region: 'europe-west6',
 memory: '256MiB',
 timeoutSeconds: 60,
 cors: false,
 },
 async (req, res) => {
 if (req.method !== 'POST') {
 res.status(405).json({ ok: false, error: 'method_not_allowed' });
 return;
 }

 try {
 const webhookSecret = await getRemoteConfigValue('MAILTRAP_WEBHOOK_SECRET');
 const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
 const result = await handleMailtrapWebhookRequest({
 body,
 query: req.query,
 webhookSecret,
 });
 res.status(200).json({ ok: true, result });
 } catch (error) {
 const message = error instanceof Error ? error.message : String(error || 'unknown_error');
 const status = /secret/i.test(message) ? 401 : 500;
 console.error('[newsletterMailtrapWebhook] Error:', message);
 res.status(status).json({ ok: false, error: message });
 }
 },
);

// Maileroo delivery event webhooks
export const newsletterMailerooWebhook = onRequest(
 {
 region: 'europe-west6',
 memory: '256MiB',
 timeoutSeconds: 60,
 cors: false,
 },
 async (req, res) => {
 if (req.method !== 'POST') {
 res.status(405).json({ ok: false, error: 'method_not_allowed' });
 return;
 }

 const payload = Buffer.isBuffer(req.rawBody)
 ? req.rawBody.toString('utf8')
 : typeof req.rawBody === 'string'
 ? req.rawBody
 : JSON.stringify(req.body || {});

 try {
 const signingSecret = await getRemoteConfigValue('MAILEROO_WEBHOOK_SECRET');
 const result = await handleMailerooWebhookRequest({
 payload,
 headers: req.headers,
 signingSecret,
 });
 res.status(200).json({ ok: true, result });
 } catch (error) {
 const message = error instanceof Error ? error.message : String(error || 'unknown_error');
 const status = /signature/i.test(message) ? 401 : 500;
 console.error('[newsletterMailerooWebhook] Error:', message);
 res.status(status).json({ ok: false, error: message });
 }
 },
);

export const newsletterManageSubscription = onRequest(
 {
 region: 'europe-west6',
 memory: '256MiB',
 timeoutSeconds: 30,
 cors: true,
 },
 async (req, res) => {
 if (req.method !== 'GET' && req.method !== 'POST') {
 res.status(405).send('Method not allowed');
 return;
 }

 const params = req.method === 'GET' ? req.query : req.body;
 const action = String(params.action || '').trim().toLowerCase();
 const email = String(params.email || '').trim();
 const token = String(params.token || '').trim();
 const format = String(params.format || '').trim().toLowerCase();
 const enabled = params.enabled;
 const subscribed = params.subscribed;
 const alertId = params.alert_id;
 const keywords = params.keywords;
 const locations = params.locations;
 const sectors = params.sectors;
 const frequency = params.frequency;
 const active = params.active;

 try {
 const { newsletterSecret } = await getNewsletterSecrets();
 const result = await handleSubscriptionManagement({
 action,
 email,
 token,
 secret: newsletterSecret,
 enabled,
 subscribed,
 alertId,
 keywords,
 locations,
 sectors,
 frequency,
 active,
 });

 // exchange_auth_code always returns JSON (no HTML page)
 if (result.json) {
 res.status(result.status).type('json').json(result.json);
 } else if (format === 'json') {
 const jsonBody = { success: result.status === 200 };
 if (result.authToken) jsonBody.authToken = result.authToken;
 if (result.alreadyConfirmed != null) jsonBody.alreadyConfirmed = result.alreadyConfirmed;
 res.status(result.status).type('json').json(jsonBody);
 } else {
 res.status(result.status).type('html').send(result.html);
 }
 } catch (error) {
 console.error('[newsletterManageSubscription] Error:', error);
 res.status(500).type('html').send('<h1>Errore interno</h1><p>Riprova più tardi.</p>');
 }
 },
);

// FRO-24: Send newsletter confirmation email (HTTP endpoint)
export const newsletterSendConfirmation = onRequest(
 {
 region: 'europe-west6',
 memory: '256MiB',
 timeoutSeconds: 30,
 cors: true,
 },
 async (req, res) => {
 if (req.method !== 'POST') {
 res.status(405).json({ success: false, error: 'method_not_allowed' });
 return;
 }

 const email = String(req.body?.email || '').trim().toLowerCase();
 const locale = String(req.body?.locale || 'it').trim();
 const sourcePath = String(req.body?.sourcePath || '/').trim();
 const purpose = req.body?.purpose === 'login' ? 'login' : 'confirm';

 if (!email || !email.includes('@')) {
 res.status(400).json({ success: false, error: 'invalid_email' });
 return;
 }

 try {
 const { resendApiKey, newsletterSecret } = await getNewsletterSecrets();
 const result = await sendNewsletterConfirmationEmail({
 email,
 locale,
 sourcePath,
 resendApiKey,
 secret: newsletterSecret,
 purpose,
 });
 res.status(result.success ? 200 : 400).json(result);
 } catch (error) {
 console.error('[newsletterSendConfirmation] Error:', error);
 res.status(500).json({ success: false, error: 'internal_error' });
 }
 },
);

// E2: Calculator paywall PDF delivery (HTTP endpoint)
export const sendCalculatorReport = onRequest(
 {
 region: 'europe-west6',
 memory: '256MiB',
 timeoutSeconds: 30,
 cors: true,
 },
 async (req, res) => {
 if (req.method !== 'POST') {
 res.status(405).json({ success: false, error: 'method_not_allowed' });
 return;
 }
 const email = String(req.body?.email || '').trim().toLowerCase();
 const pdfBase64 = typeof req.body?.pdfBase64 === 'string' ? req.body.pdfBase64 : '';
 const resultSummary = req.body?.resultSummary || null;
 const locale = String(req.body?.locale || 'it').trim();
 const sourcePath = String(req.body?.sourcePath || '/').trim();
 try {
 const { resendApiKey } = await getNewsletterSecrets();
 const result = await handleSendCalculatorReport({
 email,
 pdfBase64,
 resultSummary,
 locale,
 sourcePath,
 resendApiKey,
 });
 res.status(result.status).type('json').json(result.body);
 } catch (error) {
 console.error('[sendCalculatorReport] Error:', error);
 res.status(500).json({ success: false, error: 'internal_error' });
 }
 },
);

/**
 * chatbotInference — Server-side AI inference endpoint for the site chatbot.
 *
 * Keeps the Gemini API key off the browser, provides multi-model fallback
 * (gemini-2.0-flash-lite → gemini-1.5-flash-8b), and caches common FAQ answers.
 *
 * POST { messages: [{role, content},...], systemPrompt: string }
 * → { ok: true, text: string, model: string, source: 'cache'|'gemini' }
 * → { ok: false, error: string, code: string }
 */
export const chatbotInference = onRequest(
 {
 region: 'europe-west6',
 memory: '256MiB',
 timeoutSeconds: 30,
 cors: [
 'https://frontaliereticino.ch',
 'https://frontaliere-ticino.web.app',
 'https://frontaliere-ticino.firebaseapp.com',
 // Allow localhost/dev environments
 /^http:\/\/localhost(:\d+)?$/,
 ],
 },
 async (req, res) => {
 if (req.method !== 'POST') {
 res.status(405).json({ ok: false, error: 'method_not_allowed', code: 'METHOD' });
 return;
 }

 const messages = req.body?.messages;
 const systemPrompt = String(req.body?.systemPrompt ?? '');

 if (!Array.isArray(messages) || messages.length === 0 || messages.length > 40) {
 res.status(400).json({ ok: false, error: 'invalid_messages', code: 'INVALID' });
 return;
 }

 // Validate message shape
 for (const m of messages) {
 if (!m || typeof m !== 'object' || !m.role || typeof m.content !== 'string') {
 res.status(400).json({ ok: false, error: 'invalid_message_shape', code: 'INVALID' });
 return;
 }
 }

 try {
 const result = await handleChatbotInference({ messages, systemPrompt });
 res.json({ ok: true, ...result });
 } catch (err) {
 const code = String(err?.code ?? 'ERROR');
 const message = String(err?.message ?? 'inference_error');
 console.warn(`[chatbotInference] error code=${code}: ${message}`);
 if (code === '429') {
 res.status(429).json({ ok: false, error: 'rate_limited', code });
 } else if (code === 'CONFIG') {
 res.status(503).json({ ok: false, error: 'service_unavailable', code });
 } else {
 res.status(500).json({ ok: false, error: message, code });
 }
 }
 },
);

/**
 * LinkedIn OAuth2 code exchange → Firebase custom token.
 * Called by the frontend /auth/linkedin/callback SPA page.
 * POST { code, redirectUri } → { ok: true, customToken }
 */
export const linkedinAuthCallback = onRequest(
 {
 region: 'europe-west6',
 memory: '256MiB',
 timeoutSeconds: 30,
 cors: ['https://frontaliereticino.ch', 'http://localhost:3000', 'http://localhost:4173'],
 },
 async (req, res) => {
 if (req.method !== 'POST') {
 res.status(405).json({ ok: false, error: 'method_not_allowed' });
 return;
 }

 const { code, redirectUri } = req.body || {};
 if (!code || !redirectUri) {
 res.status(400).json({ ok: false, error: 'missing_code_or_redirect_uri' });
 return;
 }

 try {
 const result = await handleLinkedInCallback({ code, redirectUri });
 res.status(200).json({ ok: true, ...result });
 } catch (err) {
 const status = err.status || 500;
 const message = err.message || 'linkedin_callback_error';
 console.warn(`[linkedinAuthCallback] error status=${status}: ${message}`);
 res.status(status).json({ ok: false, error: message });
 }
 },
);

// Job Alert one-click unsubscribe (RFC 8058 + browser GET)
export const jobAlertUnsubscribe = onRequest(
 {
 region: 'europe-west6',
 memory: '256MiB',
 timeoutSeconds: 30,
 cors: true,
 },
 async (req, res) => {
 if (req.method !== 'GET' && req.method !== 'POST') {
 res.status(405).send('Method not allowed');
 return;
 }

 // RFC 8058 one-click POST carries alertId/email/token in the URI QUERY STRING
 // (the body is only `List-Unsubscribe=One-Click`), so a POST must read the
 // identifiers from the query too — not just req.body. Merge both (body wins on
 // the rare key collision) so both the footer GET link and the header one-click
 // POST resolve the same params. A POST that read body-only verified an empty
 // email/token → 403 → never unsubscribed, which also hurts sender reputation.
 const params = req.method === 'GET' ? req.query : { ...req.query, ...req.body };
 const alertId = String(params.alertId || '').trim();
 const email = String(params.email || '').trim();
 const token = String(params.token || '').trim();
 const action = String(params.action || '').trim();

 try {
 const { newsletterSecret } = await getNewsletterSecrets();
 const result = await handleJobAlertUnsubscribe({
 alertId,
 email,
 token,
 secret: newsletterSecret,
 action,
 });

 // RFC 8058 POST returns 200 with no body
 if (req.method === 'POST') {
 res.status(result.status).type('text').send(result.status === 200 ? 'OK' : 'Error');
 } else {
 res.status(result.status).type('html').send(result.html);
 }
 } catch (error) {
 console.error('[jobAlertUnsubscribe] Error:', error);
 res.status(500).type('html').send('<h1>Errore interno</h1><p>Riprova più tardi.</p>');
 }
 },
);

/**
 * reCAPTCHA Enterprise token verification.
 * POST { token: string, action: string } → { ok, score, threshold, passed }
 * Used by Contact form and Feedback form to gate submissions before they
 * reach Firestore / GitHub. Runs createAssessment server-side so the
 * "unprotected events" alert goes away.
 */
export const verifyRecaptcha = onRequest(
 {
 region: 'europe-west6',
 memory: '256MiB',
 timeoutSeconds: 30,
 cors: [
 'https://frontaliereticino.ch',
 'https://www.frontaliereticino.ch',
 'https://frontaliere-ticino.web.app',
 'https://frontaliere-ticino.firebaseapp.com',
 /^http:\/\/localhost(:\d+)?$/,
 ],
 },
 async (req, res) => {
 if (req.method !== 'POST') {
 res.status(405).json({ ok: false, error: 'method_not_allowed', code: 'METHOD' });
 return;
 }

 try {
 const { status, body } = await handleRecaptchaVerification(req);
 res.status(status).json(body);
 } catch (error) {
 console.error('[verifyRecaptcha] Unhandled error:', error);
 res.status(500).json({ ok: false, error: 'internal_error', code: 'INTERNAL' });
 }
 },
);

// ── Publisher portal (paid job postings) ──────────────────────────────────
// Create a Stripe Checkout Session (subscription mode, 30-day auto-renew).
// Authenticated publisher only; price is recomputed server-side from the
// referenced publisher_jobs (client amount is never trusted).
export const createPublisherCheckout = onRequest(
 {
 region: 'europe-west6',
 memory: '256MiB',
 timeoutSeconds: 30,
 cors: [
 'https://frontaliereticino.ch',
 'https://frontaliere-ticino.web.app',
 'https://frontaliere-ticino.firebaseapp.com',
 /^http:\/\/localhost(:\d+)?$/,
 ],
 },
 async (req, res) => {
 try {
 const { status, body } = await handleCreatePublisherCheckout(req);
 res.status(status).json(body);
 } catch (error) {
 console.error('[createPublisherCheckout]', error instanceof Error ? error.message : String(error));
 res.status(500).json({ ok: false, error: 'internal_error' });
 }
 },
);

// Self-serve subscription management (cancel / payment method / invoices) via
// Stripe's hosted Billing Portal.
export const createPublisherBillingPortal = onRequest(
 {
 region: 'europe-west6',
 memory: '256MiB',
 timeoutSeconds: 30,
 cors: [
 'https://frontaliereticino.ch',
 'https://frontaliere-ticino.web.app',
 'https://frontaliere-ticino.firebaseapp.com',
 /^http:\/\/localhost(:\d+)?$/,
 ],
 },
 async (req, res) => {
 try {
 const { status, body } = await handleCreateBillingPortal(req);
 res.status(status).json(body);
 } catch (error) {
 console.error('[createPublisherBillingPortal]', error instanceof Error ? error.message : String(error));
 res.status(500).json({ ok: false, error: 'internal_error' });
 }
 },
);

// Publisher-initiated archive of one of their own ads. Removes it from the live
// slice without touching the Stripe subscription (the paid slot stays reusable).
export const archivePublisherAd = onRequest(
 {
 region: 'europe-west6',
 memory: '256MiB',
 timeoutSeconds: 30,
 cors: [
 'https://frontaliereticino.ch',
 'https://frontaliere-ticino.web.app',
 'https://frontaliere-ticino.firebaseapp.com',
 /^http:\/\/localhost(:\d+)?$/,
 ],
 },
 async (req, res) => {
 try {
 const { status, body } = await handleArchivePublisherAd(req);
 res.status(status).json(body);
 } catch (error) {
 console.error('[archivePublisherAd]', error instanceof Error ? error.message : String(error));
 res.status(500).json({ ok: false, error: 'internal_error' });
 }
 },
);

// Publisher-initiated restore of an archived ad. Re-lists it: free → published,
// sponsored with a still-active subscription → paid (reusing the slot, no new
// charge), otherwise → draft (must run a fresh checkout). Inverse of archive.
export const restorePublisherAd = onRequest(
 {
 region: 'europe-west6',
 memory: '256MiB',
 timeoutSeconds: 30,
 cors: [
 'https://frontaliereticino.ch',
 'https://frontaliere-ticino.web.app',
 'https://frontaliere-ticino.firebaseapp.com',
 /^http:\/\/localhost(:\d+)?$/,
 ],
 },
 async (req, res) => {
 try {
 const { status, body } = await handleRestorePublisherAd(req);
 res.status(status).json(body);
 } catch (error) {
 console.error('[restorePublisherAd]', error instanceof Error ? error.message : String(error));
 res.status(500).json({ ok: false, error: 'internal_error' });
 }
 },
);

// Stripe webhook — the ONLY path that flips a job to 'paid'. Needs the raw body
// for signature verification (cors:false; Firebase provides req.rawBody).
export const stripeWebhook = onRequest(
 {
 region: 'europe-west6',
 memory: '256MiB',
 timeoutSeconds: 60,
 cors: false,
 },
 async (req, res) => {
 try {
 const { status, body } = await handleStripeWebhook(req);
 res.status(status).json(body);
 } catch (error) {
 console.error('[stripeWebhook]', error instanceof Error ? error.message : String(error));
 res.status(500).json({ ok: false, error: 'internal_error' });
 }
 },
);

// Anti-spam: cap free-tier self-published ads per publisher per day; over the
// cap the new ad is flipped to 'rejected' (kept out of the slice).
export const enforcePublisherFreeCap = onDocumentCreated(
 { region: 'europe-west6', memory: '256MiB', document: 'publisher_jobs/{jobId}' },
 async (event) => {
 const snap = event.data;
 if (!snap) return;
 try {
 await enforceFreeTierCap(snap.data(), event.params.jobId);
 } catch (error) {
 console.error('[enforcePublisherFreeCap]', error instanceof Error ? error.message : String(error));
 }
 },
);

// Forward a candidate application to the publisher's chosen email (read
// server-side; never exposed to the client). Fires on application create —
// firestore.rules guarantees consentGiven == true for every created doc.
export const forwardPublisherApplication = onDocumentCreated(
 { region: 'europe-west6', memory: '256MiB', document: 'applications/{appId}' },
 async (event) => {
 const snap = event.data;
 if (!snap) return;
 try {
 const result = await handleForwardApplication(snap.data(), event.params.appId);
 if (!result.ok) console.error('[forwardPublisherApplication]', result.error);
 } catch (error) {
 console.error('[forwardPublisherApplication]', error instanceof Error ? error.message : String(error));
 }
 },
);

// Publisher domain ownership verification (DNS TXT). Authenticated; returns the
// TXT record to add, and on a follow-up call flips domainVerified once present.
export const verifyPublisherDomain = onRequest(
 {
 region: 'europe-west6',
 memory: '256MiB',
 timeoutSeconds: 30,
 cors: [
 'https://frontaliereticino.ch',
 'https://frontaliere-ticino.web.app',
 'https://frontaliere-ticino.firebaseapp.com',
 /^http:\/\/localhost(:\d+)?$/,
 ],
 },
 async (req, res) => {
 try {
 const { status, body } = await handleVerifyPublisherDomain(req);
 res.status(status).json(body);
 } catch (error) {
 console.error('[verifyPublisherDomain]', error instanceof Error ? error.message : String(error));
 res.status(500).json({ ok: false, error: 'internal_error' });
 }
 },
);

// Mint a download link for an application's uploaded CV. Authenticated; the
// publisher dashboard calls this because cv-uploads/** is client-read-denied
// (storage.rules), so the raw object path stored in the doc isn't directly
// fetchable — the server signs a read URL here.
export const getPublisherApplicationCvUrl = onRequest(
 {
 region: 'europe-west6',
 memory: '256MiB',
 timeoutSeconds: 30,
 cors: [
 'https://frontaliereticino.ch',
 'https://frontaliere-ticino.web.app',
 'https://frontaliere-ticino.firebaseapp.com',
 /^http:\/\/localhost(:\d+)?$/,
 ],
 },
 async (req, res) => {
 try {
 const { status, body } = await handleGetApplicationCvUrl(req);
 res.status(status).json(body);
 } catch (error) {
 console.error('[getPublisherApplicationCvUrl]', error instanceof Error ? error.message : String(error));
 res.status(500).json({ ok: false, error: 'internal_error' });
 }
 },
);

// GDPR retention: purge applications older than the retention window, daily.
export const purgePublisherApplications = onSchedule(
 { region: 'europe-west6', schedule: 'every 24 hours', timeZone: 'Europe/Zurich' },
 async () => {
 try {
 const deleted = await purgeOldApplications();
 if (deleted > 0) console.log(`[purgePublisherApplications] deleted ${deleted} expired application(s)`);
 } catch (error) {
 console.error('[purgePublisherApplications]', error instanceof Error ? error.message : String(error));
 }
 },
);

// Retention: remind publishers whose paid ad renews within 3 days, daily.
// Idempotent (renewalReminderSentAt) → one email per publisher per renewal.
export const sendPublisherRenewalReminders = onSchedule(
 { region: 'europe-west6', schedule: 'every 24 hours', timeZone: 'Europe/Zurich' },
 async () => {
 try {
 const sent = await sendRenewalReminders();
 if (sent > 0) console.log(`[sendPublisherRenewalReminders] sent ${sent} renewal reminder(s)`);
 } catch (error) {
 console.error('[sendPublisherRenewalReminders]', error instanceof Error ? error.message : String(error));
 }
 },
);

// Reaper: revert ads stuck in 'pending_payment' past the reap window (abandoned
// checkout) back to 'draft', daily. Backstop for a missed checkout.session.expired
// webhook. Guarded + idempotent (only touches docs still pending_payment).
export const reapPublisherPendingPayments = onSchedule(
 { region: 'europe-west6', schedule: 'every 24 hours', timeZone: 'Europe/Zurich' },
 async () => {
 try {
 const reverted = await reapStalePendingPayments();
 if (reverted > 0) console.log(`[reapPublisherPendingPayments] reverted ${reverted} stale pending ad(s)`);
 } catch (error) {
 console.error('[reapPublisherPendingPayments]', error instanceof Error ? error.message : String(error));
 }
 },
);
