/**
 * Lazy loader for the reCAPTCHA Enterprise client script.
 *
 * The script is only injected once, on first demand — typically when a
 * protected form (Contact, Feedback) is about to submit. Keeps reCAPTCHA
 * out of the initial page load and away from Lighthouse / idle users.
 */

import { isRecaptchaClientReady, type RecaptchaLikeWindow } from '@/services/recaptchaReady';

const SCRIPT_ID = 'recaptcha-enterprise-loader';

let loadPromise: Promise<void> | null = null;

export function resetRecaptchaLoaderForTests(): void {
  loadPromise = null;
}

export async function ensureRecaptchaLoaded(siteKey: string): Promise<void> {
  if (typeof window === 'undefined') {
    throw new Error('reCAPTCHA cannot be loaded outside the browser');
  }
  if (!siteKey || siteKey.trim().length === 0) {
    throw new Error('reCAPTCHA site key is missing');
  }

  if (isRecaptchaClientReady(window as RecaptchaLikeWindow)) {
    return;
  }

  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Failed to load reCAPTCHA script')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = `https://www.google.com/recaptcha/enterprise.js?render=${encodeURIComponent(siteKey)}`;
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.onload = () => resolve();
    script.onerror = () => {
      loadPromise = null;
      reject(new Error('Failed to load reCAPTCHA script'));
    };
    document.head.appendChild(script);
  }).then(async () => {
    await new Promise<void>((resolve) => {
      const w = window as RecaptchaLikeWindow;
      if (w.grecaptcha?.enterprise?.ready) {
        w.grecaptcha.enterprise.ready(() => resolve());
        return;
      }
      let tries = 0;
      const poll = () => {
        tries += 1;
        if (isRecaptchaClientReady(window as RecaptchaLikeWindow)) {
          (window as RecaptchaLikeWindow).grecaptcha!.enterprise!.ready!(() => resolve());
          return;
        }
        if (tries >= 50) {
          resolve();
          return;
        }
        setTimeout(poll, 100);
      };
      poll();
    });
  });

  return loadPromise;
}
