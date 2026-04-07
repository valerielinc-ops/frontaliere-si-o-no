import { onRequest } from 'firebase-functions/v2/https';
import {
  ensureAdminApp,
  handleResendWebhookRequest,
} from './src/newsletterResendWebhookCore.js';
import { handleSesWebhookRequest } from './src/newsletterSesWebhookCore.js';
import { handleSubscriptionManagement } from './src/newsletterSubscriptionManagement.js';
import { sendNewsletterConfirmationEmail } from './src/newsletterConfirmationEmail.js';
import { getNewsletterSecrets, getRemoteConfigValue } from './src/remoteConfigSecrets.js';
import { handleChatbotInference } from './src/chatbotInference.js';
import { handleLinkedInCallback } from './src/linkedinAuthCallback.js';

ensureAdminApp();

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
      res.status(200).json({ ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || 'unknown_error');
      const status = /signature|svix|webhook/i.test(message) ? 401 : 500;
      res.status(status).json({ ok: false, error: message });
    }
  },
);

// AWS SES event notifications via SNS
export const newsletterSesWebhook = onRequest(
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

    const body = Buffer.isBuffer(req.rawBody)
      ? req.rawBody.toString('utf8')
      : typeof req.rawBody === 'string'
        ? req.rawBody
        : JSON.stringify(req.body || {});

    try {
      const result = await handleSesWebhookRequest({
        body,
        headers: req.headers,
      });
      res.status(200).json({ ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || 'unknown_error');
      console.error('[newsletterSesWebhook] Error:', message);
      res.status(500).json({ ok: false, error: message });
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

    try {
      const { newsletterSecret } = await getNewsletterSecrets();
      const result = await handleSubscriptionManagement({
        action,
        email,
        token,
        secret: newsletterSecret,
      });

      if (format === 'json') {
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
      });
      res.status(result.success ? 200 : 400).json(result);
    } catch (error) {
      console.error('[newsletterSendConfirmation] Error:', error);
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
