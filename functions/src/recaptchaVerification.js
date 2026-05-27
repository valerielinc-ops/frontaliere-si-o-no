/**
 * recaptchaVerification.js — Server-side reCAPTCHA Enterprise assessment.
 *
 * Verifies tokens emitted by the client and returns the risk score. Used to
 * gate form submissions (Contact, Feedback) before they hit Firestore / GitHub.
 *
 * Env:
 * - GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT is populated automatically inside
 *   Firebase Functions (europe-west6). No service account JSON is required
 *   because the runtime uses ADC.
 */

import { RecaptchaEnterpriseServiceClient } from '@google-cloud/recaptcha-enterprise';
import { getRemoteConfigValue } from './remoteConfigSecrets.js';

const VALID_ACTIONS = new Set([
  'CONTACT_FORM',
  'FEEDBACK_SUBMIT',
  'TRAFFIC_DATA',
  'EXCHANGE_RATES',
  'API_TEST',
  'PAGE_LOAD',
]);

const ACTION_THRESHOLDS = {
  CONTACT_FORM: 0.5,
  FEEDBACK_SUBMIT: 0.5,
  TRAFFIC_DATA: 0.5,
  EXCHANGE_RATES: 0.4,
  API_TEST: 0.3,
  PAGE_LOAD: 0.3,
};

let cachedClient = null;
function getClient() {
  if (!cachedClient) {
    cachedClient = new RecaptchaEnterpriseServiceClient();
  }
  return cachedClient;
}

let cachedSiteKey = null;
async function getSiteKey() {
  if (cachedSiteKey) return cachedSiteKey;
  const fromRc = await getRemoteConfigValue('RECAPTCHA_SITE_KEY').catch(() => '');
  cachedSiteKey = (fromRc || process.env.RECAPTCHA_SITE_KEY || '').trim();
  return cachedSiteKey;
}

/**
 * Create an assessment for a reCAPTCHA Enterprise token.
 * @returns {Promise<{valid: boolean, score: number|null, reasons: string[], invalidReason?: string, actionMismatch?: boolean}>}
 */
export async function createAssessment({ token, expectedAction, projectId, siteKey }) {
  const client = getClient();
  const projectPath = client.projectPath(projectId);

  const [response] = await client.createAssessment({
    parent: projectPath,
    assessment: {
      event: { token, siteKey, expectedAction },
    },
  });

  if (!response.tokenProperties?.valid) {
    return {
      valid: false,
      score: null,
      reasons: [],
      invalidReason: response.tokenProperties?.invalidReason ?? 'UNKNOWN',
    };
  }

  if (response.tokenProperties.action !== expectedAction) {
    return {
      valid: false,
      score: response.riskAnalysis?.score ?? null,
      reasons: response.riskAnalysis?.reasons ?? [],
      actionMismatch: true,
    };
  }

  return {
    valid: true,
    score: response.riskAnalysis?.score ?? null,
    reasons: response.riskAnalysis?.reasons ?? [],
  };
}

/**
 * HTTP handler — verifies a token and returns the score.
 * Request: { token: string, action: string }
 * Response 200: { ok: true, score: number, passed: boolean, threshold: number }
 * Response 400/403: { ok: false, error: string, code: string }
 */
export async function handleRecaptchaVerification(req) {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const action = typeof req.body?.action === 'string' ? req.body.action.trim() : '';

  if (!token) {
    return { status: 400, body: { ok: false, error: 'missing_token', code: 'INVALID' } };
  }
  if (!VALID_ACTIONS.has(action)) {
    return { status: 400, body: { ok: false, error: 'invalid_action', code: 'INVALID' } };
  }

  const siteKey = await getSiteKey();
  if (!siteKey) {
    return { status: 503, body: { ok: false, error: 'recaptcha_not_configured', code: 'CONFIG' } };
  }

  const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'frontaliere-ticino';

  try {
    const result = await createAssessment({ token, expectedAction: action, projectId, siteKey });

    if (!result.valid) {
      return {
        status: 403,
        body: {
          ok: false,
          error: result.actionMismatch ? 'action_mismatch' : 'token_invalid',
          code: 'INVALID_TOKEN',
          invalidReason: result.invalidReason,
        },
      };
    }

    const threshold = ACTION_THRESHOLDS[action] ?? 0.5;
    const score = result.score ?? 0;
    const passed = score >= threshold;

    return {
      status: passed ? 200 : 403,
      body: {
        ok: passed,
        score,
        threshold,
        passed,
        reasons: result.reasons,
        ...(passed ? {} : { error: 'score_below_threshold', code: 'LOW_SCORE' }),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || 'unknown_error');
    console.error('[verifyRecaptcha] Assessment failed:', message);
    return { status: 500, body: { ok: false, error: 'assessment_failed', code: 'INTERNAL' } };
  }
}
