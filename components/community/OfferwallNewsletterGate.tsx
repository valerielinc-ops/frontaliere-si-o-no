/**
 * OfferwallNewsletterGate — in-house "subscribe to read" choice for the
 * Google Ad Manager Offerwall (Privacy & Messaging) custom-choice slot.
 *
 * The Offerwall is configured in the GAM console; an inline script in
 * index.html registers `window.googlefc.offerwall.customchoice.registry`
 * BEFORE Funding Choices loads. That registry's `show()` delegates to the
 * `window.__ftOfferwallSubscribe` hook this component installs on mount.
 *
 * When the user picks "subscribe to read" in the Offerwall, `show()` calls the
 * hook, which opens this modal. On a successful subscribe we resolve `true`
 * (Offerwall grants page access) and persist `newsletter_subscribed` locally so
 * `initialize()` returns ACCESS_GRANTED on subsequent pageviews. On dismiss we
 * resolve `false` (the Offerwall re-renders its other choices). This routes the
 * email straight into the existing newsletter pipeline (rate-limit, capture,
 * acquisitionSource tagging, double opt-in via Resend) — no CSV, unlike the
 * built-in AdSense "Email collection" beta.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Mail, Loader2, CheckCircle2 } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { reportCaughtError } from '@/services/errorReporter';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';
import { AD_CLIENT } from '@/services/adsenseSlots';
import {
  upsertNewsletterSubscriber,
  markNewsletterSubscribedLocally,
} from '@/services/newsletterSubscribers';

type OfferwallLocale = 'it' | 'en' | 'de' | 'fr';

// Self-contained 4-locale copy (the Offerwall passes its own language code, which
// may differ from the SPA locale). Kept inline so the gate has no dependency on
// on-demand locale chunks being loaded when the Offerwall fires.
const COPY: Record<OfferwallLocale, {
  title: string;
  body: string;
  consent: string;
  submit: string;
  dismiss: string;
  invalidEmail: string;
  consentRequired: string;
  error: string;
  success: string;
}> = {
  it: {
    title: 'Continua a leggere gratis',
    body: 'Iscriviti alla newsletter dei frontalieri (cambio CHF, fisco, lavoro) e accedi subito al contenuto. Niente spam, disiscrizione con un clic.',
    consent: 'Acconsento a ricevere la newsletter e accetto la privacy policy.',
    submit: 'Iscriviti e leggi',
    dismiss: 'No grazie',
    invalidEmail: 'Inserisci un indirizzo email valido.',
    consentRequired: 'Spunta il consenso per continuare.',
    error: 'Iscrizione non riuscita. Riprova.',
    success: 'Fatto! Controlla la mail per confermare.',
  },
  en: {
    title: 'Keep reading for free',
    body: 'Subscribe to the cross-border workers newsletter (CHF rate, tax, jobs) and unlock this content now. No spam, one-click unsubscribe.',
    consent: 'I agree to receive the newsletter and accept the privacy policy.',
    submit: 'Subscribe & read',
    dismiss: 'No thanks',
    invalidEmail: 'Please enter a valid email address.',
    consentRequired: 'Please tick the consent box to continue.',
    error: 'Subscription failed. Please try again.',
    success: 'Done! Check your inbox to confirm.',
  },
  de: {
    title: 'Kostenlos weiterlesen',
    body: 'Abonnieren Sie den Grenzgänger-Newsletter (CHF-Kurs, Steuern, Jobs) und schalten Sie diesen Inhalt sofort frei. Kein Spam, Abmeldung mit einem Klick.',
    consent: 'Ich willige ein, den Newsletter zu erhalten, und akzeptiere die Datenschutzerklärung.',
    submit: 'Abonnieren & lesen',
    dismiss: 'Nein danke',
    invalidEmail: 'Bitte geben Sie eine gültige E-Mail-Adresse ein.',
    consentRequired: 'Bitte bestätigen Sie die Einwilligung, um fortzufahren.',
    error: 'Anmeldung fehlgeschlagen. Bitte erneut versuchen.',
    success: 'Fertig! Bitte bestätigen Sie in Ihrem Postfach.',
  },
  fr: {
    title: 'Continuez à lire gratuitement',
    body: 'Abonnez-vous à la newsletter des frontaliers (cours CHF, fiscalité, emploi) et accédez immédiatement au contenu. Pas de spam, désinscription en un clic.',
    consent: 'J’accepte de recevoir la newsletter et la politique de confidentialité.',
    submit: 'S’abonner et lire',
    dismiss: 'Non merci',
    invalidEmail: 'Veuillez saisir une adresse e-mail valide.',
    consentRequired: 'Veuillez cocher le consentement pour continuer.',
    error: 'Échec de l’inscription. Veuillez réessayer.',
    success: 'Terminé ! Vérifiez votre boîte mail pour confirmer.',
  },
};

const CONSENT_TEXT_BY_LOCALE: Record<OfferwallLocale, string> = {
  it: 'Offerwall: consenso esplicito a ricevere la newsletter Frontaliere Ticino in cambio dell’accesso al contenuto.',
  en: 'Offerwall: explicit consent to receive the Frontaliere Ticino newsletter in exchange for content access.',
  de: 'Offerwall: ausdrückliche Einwilligung zum Erhalt des Frontaliere-Ticino-Newsletters im Austausch für den Zugang zum Inhalt.',
  fr: 'Offerwall: consentement explicite à recevoir la newsletter Frontaliere Ticino en échange de l’accès au contenu.',
};

let firestoreDb: any = null;
const initFirestore = async () => {
  if (firestoreDb) return firestoreDb;
  try {
    const [{ getFirestore }, { getApp }] = await Promise.all([
      import('firebase/firestore'),
      import('@/services/firebase'),
    ]);
    firestoreDb = getFirestore(await getApp());
    return firestoreDb;
  } catch (e) {
    reportCaughtError(e, 'offerwallGate.firestoreInit');
    return null;
  }
};

function normalizeLocale(code?: string | null, fallback?: string): OfferwallLocale {
  const raw = String(code || fallback || 'it').toLowerCase().slice(0, 2);
  if (raw === 'en' || raw === 'de' || raw === 'fr') return raw;
  return 'it';
}

// Funding Choices publisher id ('pub-8628054934855353'), derived from the shared
// AdSense client to avoid a second hard-coded copy.
const FC_PUB = AD_CLIENT.replace(/^ca-/, '');

/**
 * Ensure the Offerwall custom-choice registry AND the Funding Choices loader are
 * present. On SPA routes index.html sets both inline; STATIC SSG pages (articles,
 * SEO landings) use a different shell whose <head> has NEITHER — so the Offerwall
 * could never render on exactly the pages we scope it to. This gate hydrates on
 * every page (SPA + static), so we set them here. Idempotent: no-op when already
 * present (SPA). Mirrors the index.html bootstrap; the registry's show() delegates
 * to window.__ftOfferwallSubscribe (installed by this component's effect below).
 */
function ensureOfferwallRegistryAndFc(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const w = window as any;
  const g = (w.googlefc = w.googlefc || {});
  const ow = (g.offerwall = g.offerwall || {});
  const cc = (ow.customchoice = ow.customchoice || {});
  if (!cc.registry) {
    cc.registry = {
      initialize(params: { offerwallLanguageCode?: string } | undefined) {
        const E = cc.InitializeResponseEnum || {};
        try {
          if (w.localStorage.getItem('newsletter_subscribed') === 'true') {
            return Promise.resolve(E.ACCESS_GRANTED || 'ACCESS_GRANTED');
          }
        } catch { /* ignore */ }
        w.__ftOfferwallLang = (params && params.offerwallLanguageCode) || null;
        return Promise.resolve(E.ACCESS_NOT_GRANTED || 'ACCESS_NOT_GRANTED');
      },
      show() {
        const fn = w.__ftOfferwallSubscribe;
        if (typeof fn !== 'function') return Promise.resolve(false);
        try {
          return Promise.resolve(fn(w.__ftOfferwallLang)).then((ok: unknown) => !!ok);
        } catch { return Promise.resolve(false); }
      },
    };
  }
  // Inject the Funding Choices messaging tag if absent (needed for the Offerwall
  // to serve). index.html marks its loader with data-fc-loader; skip if present.
  if (!document.querySelector('script[data-fc-loader]') &&
      !document.querySelector('script[src*="fundingchoicesmessages.google.com"]')) {
    const s = document.createElement('script');
    s.async = true;
    // No crossOrigin: the /i/pub-XXX endpoint serves no ACAO header (see
    // tests/index-html-fc-loader.test.ts rationale).
    s.src = `https://fundingchoicesmessages.google.com/i/${FC_PUB}?ers=1`;
    s.setAttribute('data-fc-loader', '1');
    document.head.appendChild(s);
    if (!w.frames['googlefcPresent'] && document.body) {
      const iframe = document.createElement('iframe');
      iframe.style.cssText = 'width:0;height:0;border:none;z-index:-1000;left:-1000px;top:-1000px;display:none';
      iframe.name = 'googlefcPresent';
      document.body.appendChild(iframe);
    }
  }
}

const OfferwallNewsletterGate: React.FC = () => {
  const { locale } = useTranslation();
  const [open, setOpen] = useState(false);
  const [activeLocale, setActiveLocale] = useState<OfferwallLocale>('it');
  const [email, setEmail] = useState('');
  const [consentChecked, setConsentChecked] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  // The pending promise resolver handed back to the Offerwall's show().
  const resolverRef = useRef<((granted: boolean) => void) | null>(null);
  // Ref so the hook closure always reads the current locale without locale
  // being an effect dependency (avoids cleanup→settle(false) on locale change).
  const localeRef = useRef(locale);
  localeRef.current = locale;

  const settle = useCallback((granted: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setOpen(false);
    if (resolve) resolve(granted);
  }, []);

  // Install the global hook the index.html registry delegates to.
  useEffect(() => {
    const hook = (offerwallLang?: string | null): Promise<boolean> => {
      // If a previous invocation is still pending, deny it (the Offerwall only
      // shows one choice at a time, but be defensive).
      if (resolverRef.current) resolverRef.current(false);
      setActiveLocale(normalizeLocale(offerwallLang, localeRef.current));
      setEmail('');
      setConsentChecked(false);
      setStatus('idle');
      setErrorMessage('');
      setOpen(true);
      try { Analytics.trackUIInteraction('offerwall_gate', 'modal', 'show', String(offerwallLang || localeRef.current)); } catch { /* no-op */ }
      return new Promise<boolean>((resolve) => {
        resolverRef.current = resolve;
      });
    };
    (window as any).__ftOfferwallSubscribe = hook;
    // Ensure the registry + FC loader exist (esp. on static SSG pages whose head
    // lacks index.html's inline versions). Runs after the hook is installed so
    // the registry's show() can delegate to it.
    ensureOfferwallRegistryAndFc();
    return () => {
      if ((window as any).__ftOfferwallSubscribe === hook) {
        delete (window as any).__ftOfferwallSubscribe;
      }
      // Resolve any dangling promise so the Offerwall isn't left hanging.
      if (resolverRef.current) settle(false);
    };
  }, [settle]);

  const copy = COPY[activeLocale];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const check = validateEmailStrict(email);
    if (!check.valid) {
      setErrorMessage(copy.invalidEmail);
      setStatus('error');
      return;
    }
    if (!consentChecked) {
      setErrorMessage(copy.consentRequired);
      setStatus('error');
      return;
    }
    setStatus('loading');
    try {
      const firestore = await initFirestore();
      if (!firestore) throw new Error('firestore_unavailable');
      await upsertNewsletterSubscriber(firestore, {
        email,
        name: null,
        preferences: { exchangeRate: true, traffic: true, taxUpdates: true, tips: false },
        source: 'offerwall',
        sourceChannel: 'offerwall',
        sourcePage: window.location.pathname,
        sourceCta: 'offerwall_custom_choice',
        sourceComponent: 'OfferwallNewsletterGate',
        locale: activeLocale,
        // Deliberately NOT in CONFIRMED_NEWSLETTER_SOURCES → starts `pending`
        // and triggers the double opt-in confirmation email. Page access (the
        // Offerwall reward) is granted immediately regardless.
        consentGiven: true,
        consentText: CONSENT_TEXT_BY_LOCALE[activeLocale],
        consentMethod: 'email_checkbox',
        consentUserAgent: navigator.userAgent,
      });
      markNewsletterSubscribedLocally();
      try { Analytics.trackUIInteraction('offerwall_gate', 'form', 'subscribe', 'success'); } catch { /* no-op */ }
      setStatus('success');
      // Grant access after a brief success confirmation.
      setTimeout(() => settle(true), 900);
    } catch (err: any) {
      reportCaughtError(err, 'offerwallGate.submit');
      setErrorMessage(copy.error);
      setStatus('error');
    }
  };

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[2147483600] flex items-center justify-center bg-black/40 backdrop-blur-sm px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="offerwall-gate-title"
    >
      <div className="relative w-full max-w-md rounded-2xl bg-surface p-6 shadow-2xl border border-edge">
        <button
          type="button"
          onClick={() => settle(false)}
          className="absolute right-3 top-3 rounded-full p-1 text-muted hover:text-heading"
          aria-label={copy.dismiss}
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>

        <div className="mb-3 flex items-center gap-2 text-info">
          <Mail className="h-6 w-6" aria-hidden="true" />
          <h2 id="offerwall-gate-title" className="text-lg font-semibold text-heading">
            {copy.title}
          </h2>
        </div>

        {status === 'success' ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <CheckCircle2 className="h-10 w-10 text-success" aria-hidden="true" />
            <p className="text-body">{copy.success}</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <p className="text-sm text-muted">{copy.body}</p>

            <EmailInput
              value={email}
              onChange={setEmail}
              ariaLabel={copy.title}
              required
            />

            <label className="flex items-start gap-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={consentChecked}
                onChange={(e) => setConsentChecked(e.target.checked)}
                className="mt-0.5"
              />
              <span>{copy.consent}</span>
            </label>

            {status === 'error' && errorMessage && (
              <p className="text-sm text-danger" role="alert">{errorMessage}</p>
            )}

            <button
              type="submit"
              disabled={status === 'loading'}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-info-strong px-4 py-2.5 font-semibold text-on-accent hover:bg-info-strong-hover disabled:opacity-60"
            >
              {status === 'loading' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {copy.submit}
            </button>

            <button
              type="button"
              onClick={() => settle(false)}
              className="w-full text-center text-xs text-muted hover:text-heading"
            >
              {copy.dismiss}
            </button>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
};

export default OfferwallNewsletterGate;
