import { onRequest } from 'firebase-functions/v2/https';
import {
  ensureAdminApp,
  handleResendWebhookRequest,
} from './src/newsletterResendWebhookCore.js';
import { handleSubscriptionManagement } from './src/newsletterSubscriptionManagement.js';
import { sendNewsletterConfirmationEmail } from './src/newsletterConfirmationEmail.js';
import { getNewsletterSecrets, getRemoteConfigValue } from './src/remoteConfigSecrets.js';

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
