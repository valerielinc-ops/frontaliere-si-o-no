/**
 * reCAPTCHA Enterprise Service
 *
 * Lazy: script is only loaded on demand (when a protected form is about to
 * submit). Tokens are generated client-side and MUST be verified server-side
 * via the `verifyRecaptcha` Cloud Function before the action proceeds —
 * otherwise Google counts them as "unprotected events".
 */

import { reportCaughtError } from '@/services/errorReporter';
import { ensureRecaptchaLoaded } from '@/services/recaptchaLoader';
import { getConfigValue } from '@/services/firebase';

declare global {
  interface Window {
    grecaptcha?: {
      ready?: (callback: () => void) => void;
      enterprise?: {
        ready: (callback: () => void) => void;
        execute: (siteKey: string, options: { action: string }) => Promise<string>;
      };
    };
  }
}

export type RecaptchaAction =
  | 'TRAFFIC_DATA'
  | 'EXCHANGE_RATES'
  | 'FEEDBACK_SUBMIT'
  | 'API_TEST'
  | 'PAGE_LOAD'
  | 'CONTACT_FORM';

const VERIFY_ENDPOINT = 'https://europe-west6-frontaliere-ticino.cloudfunctions.net/verifyRecaptcha';

export interface RecaptchaVerifyResult {
  ok: boolean;
  passed: boolean;
  score?: number;
  threshold?: number;
  reasons?: string[];
  error?: string;
}

class RecaptchaService {
  private siteKey: string | null = null;
  private siteKeyPromise: Promise<string | null> | null = null;

  public setSiteKey(key: string): void {
    if (key && key.length > 0) {
      this.siteKey = key.trim();
    }
  }

  public isEnabled(): boolean {
    return this.siteKey !== null && this.siteKey.length > 0;
  }

  private async resolveSiteKey(): Promise<string | null> {
    if (this.siteKey) return this.siteKey;

    if (!this.siteKeyPromise) {
      this.siteKeyPromise = (async () => {
        try {
          const fromRc = await getConfigValue('RECAPTCHA_SITE_KEY');
          if (fromRc && fromRc.length > 0) {
            this.siteKey = fromRc;
            return this.siteKey;
          }
        } catch (error) {
          reportCaughtError(error, 'recaptcha.resolveSiteKey');
        }

        const devKey = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_RECAPTCHA_SITE_KEY;
        if (devKey && devKey.trim().length > 0) {
          this.siteKey = devKey.trim();
          return this.siteKey;
        }

        return null;
      })();
    }

    return this.siteKeyPromise;
  }

  /**
   * Generate a reCAPTCHA Enterprise token client-side.
   * The token MUST then be verified via verifyToken() before the action proceeds.
   */
  public async executeRecaptcha(action: RecaptchaAction): Promise<string | null> {
    if (typeof window === 'undefined') return null;

    const key = await this.resolveSiteKey();
    if (!key) {
      console.warn('reCAPTCHA non configurato - token non generato');
      return null;
    }

    try {
      await ensureRecaptchaLoaded(key);
      if (!window.grecaptcha?.enterprise) {
        return null;
      }
      return await window.grecaptcha.enterprise.execute(key, { action });
    } catch (error) {
      reportCaughtError(error, 'recaptcha.execute');
      return null;
    }
  }

  /**
   * Alias used by legacy callers (ContactPage, etc.).
   */
  public async getTokenForApi(action: RecaptchaAction): Promise<string | null> {
    return this.executeRecaptcha(action);
  }

  /**
   * Generate a token AND verify it server-side via the Cloud Function.
   * Returns the verification result; the caller should abort if `passed` is false.
   */
  public async verifyAction(action: RecaptchaAction): Promise<RecaptchaVerifyResult> {
    const token = await this.executeRecaptcha(action);
    if (!token) {
      return { ok: false, passed: false, error: 'token_generation_failed' };
    }
    return this.verifyToken(token, action);
  }

  /**
   * Submit an already-generated token to the Cloud Function for verification.
   * Returns the full response so the caller can inspect score/reasons.
   */
  public async verifyToken(token: string, action: RecaptchaAction): Promise<RecaptchaVerifyResult> {
    try {
      const response = await fetch(VERIFY_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, action }),
      });

      const data = (await response.json().catch(() => ({}))) as Partial<RecaptchaVerifyResult> & { error?: string };

      if (!response.ok) {
        return {
          ok: false,
          passed: false,
          score: data.score,
          threshold: data.threshold,
          reasons: data.reasons,
          error: data.error ?? `http_${response.status}`,
        };
      }

      return {
        ok: true,
        passed: Boolean(data.passed),
        score: data.score,
        threshold: data.threshold,
        reasons: data.reasons,
      };
    } catch (error) {
      reportCaughtError(error, 'recaptcha.verifyToken');
      return { ok: false, passed: false, error: 'verification_network_error' };
    }
  }
}

export const recaptchaService = new RecaptchaService();
export default recaptchaService;
