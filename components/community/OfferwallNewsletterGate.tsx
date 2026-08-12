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
import ConsentNotice from '@/components/shared/ConsentNotice';
import { consentProof } from '@/services/consentTexts';
import { Analytics } from '@/services/analytics';
import { reportCaughtError } from '@/services/errorReporter';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';
import SocialSignInButtons from '@/components/shared/SocialSignInButtons';
import { useAuth } from '@/services/authService';
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
  orWithEmail: string;
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
    orWithEmail: 'oppure con email',
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
    orWithEmail: 'or with email',
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
    orWithEmail: 'oder mit E-Mail',
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
    orWithEmail: 'ou par e-mail',
    submit: 'S’abonner et lire',
    dismiss: 'Non merci',
    invalidEmail: 'Veuillez saisir une adresse e-mail valide.',
    consentRequired: 'Veuillez cocher le consentement pour continuer.',
    error: 'Échec de l’inscription. Veuillez réessayer.',
    success: 'Terminé ! Vérifiez votre boîte mail pour confirmer.',
  },
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

/**
 * Ensure the Offerwall custom-choice registry exists on `window.googlefc`. On SPA
 * routes index.html sets it inline; STATIC SSG pages (articles, SEO landings) use
 * a different shell whose <head> lacks it — and those are exactly the pages we
 * scope the Offerwall to. This gate hydrates on every page (SPA + static), so we
 * set it here. Idempotent: no-op when already present (SPA). The registry's show()
 * delegates to window.__ftOfferwallSubscribe (installed by this component's effect).
 *
 * NOTE: we do NOT inject the Funding Choices (`fundingchoicesmessages`) loader —
 * per Google Ad Manager support, the Offerwall (and consent, once upgraded to the
 * GPT framework) is delivered via GPT, so no separate FC CMP script is needed
 * alongside GPT. The page's GPT (GptPocSlot) provides the delivery surface.
 */
/**
 * Synchronous "already has access" check for the Offerwall gate. Grants access
 * (suppresses the Offerwall) when the visitor is EITHER an existing newsletter
 * subscriber (local flag set by markNewsletterSubscribedLocally) OR signed in to
 * the site. Firebase Auth persists the session under a `firebase:authUser:<…>`
 * localStorage key (mirrored from authService.hasPersistedAuthSession), so a
 * logged-in user is detected without waiting for async auth hydration — the
 * registry's initialize() must resolve in <1s. Keeps gating to anonymous,
 * non-subscribed readers (the funnel target); registered users never see it.
 */
function offerwallHasAccess(w: any): boolean {
  try {
    if (w.localStorage.getItem('newsletter_subscribed') === 'true') return true;
    for (let i = 0; i < w.localStorage.length; i++) {
      const k = w.localStorage.key(i);
      if (k && k.indexOf('firebase:authUser:') === 0) return true;
    }
  } catch { /* localStorage unavailable */ }
  return false;
}

function ensureOfferwallRegistry(): void {
  if (typeof window === 'undefined') return;
  const w = window as any;
  const g = (w.googlefc = w.googlefc || {});
  const ow = (g.offerwall = g.offerwall || {});
  const cc = (ow.customchoice = ow.customchoice || {});
  if (cc.registry) return;
  cc.registry = {
    initialize(params: { offerwallLanguageCode?: string } | undefined) {
      const E = cc.InitializeResponseEnum || {};
      try {
        if (offerwallHasAccess(w)) {
          return Promise.resolve(E.ACCESS_GRANTED || 'ACCESS_GRANTED');
        }
      } catch { /* ignore */ }
      w.__ftOfferwallLang = (params && params.offerwallLanguageCode) || null;
      return Promise.resolve(E.ACCESS_NOT_GRANTED || 'ACCESS_NOT_GRANTED');
    },
    show() {
      const fn = w.__ftOfferwallSubscribe;
      const run = (f: (lang: unknown) => unknown): Promise<boolean> => {
        try {
          return Promise.resolve(f(w.__ftOfferwallLang)).then((ok: unknown) => !!ok);
        } catch { return Promise.resolve(false); }
      };
      if (typeof fn !== 'function') {
        // The hook is installed by this component's effect, which is lazy
        // (code-split): FC can call show() before the chunk hydrates. Queue the
        // request instead of dropping the subscribe choice; drainOfferwallShowQueue
        // (run on mount) resolves it once the hook is installed.
        return new Promise<boolean>((resolve) => {
          let settled = false;
          const settle = (ok: unknown) => { if (settled) return; settled = true; resolve(!!ok); };
          const q = (w.__ftOfferwallShowQueue = w.__ftOfferwallShowQueue || []);
          // Safety net: if the gate never hydrates, fall back to the other choices.
          // Cleared once the thunk drains so the 10s budget only covers the
          // hydration wait, never the user's in-progress subscribe interaction.
          const timer = setTimeout(() => settle(false), 10000);
          q.push((hook: (lang: unknown) => unknown) => { if (settled) return; clearTimeout(timer); run(hook).then(settle, () => settle(false)); });
        });
      }
      return run(fn);
    },
  };
}

/**
 * Drain any registry.show() calls that fired before this lazy (code-split)
 * chunk hydrated. show() — here, in index.html, and in OFFERWALL_FC_SNIPPET —
 * queues a thunk on window.__ftOfferwallShowQueue when the hook is absent; we
 * run each with the freshly-installed hook so the subscribe overlay still
 * appears instead of the choice being silently dropped. Thunks that already
 * timed out no-op (guarded by their own `settled` flag).
 */
function drainOfferwallShowQueue(hook: (offerwallLang?: string | null) => Promise<boolean>): void {
  if (typeof window === 'undefined') return;
  const q = (window as any).__ftOfferwallShowQueue;
  if (!Array.isArray(q) || q.length === 0) return;
  (window as any).__ftOfferwallShowQueue = [];
  for (const run of q) {
    try { run(hook); } catch { /* no-op */ }
  }
}

const OfferwallNewsletterGate: React.FC = () => {
  const { locale } = useTranslation();
  const { user } = useAuth();
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
    ensureOfferwallRegistry();
    // Drain any show() calls that fired before this lazy chunk hydrated (the
    // race where FC invokes registry.show() before the gate installs the hook),
    // so the queued subscribe overlay still opens instead of resolving false.
    drainOfferwallShowQueue(hook);
    return () => {
      if ((window as any).__ftOfferwallSubscribe === hook) {
        delete (window as any).__ftOfferwallSubscribe;
      }
      // Resolve any dangling promise so the Offerwall isn't left hanging.
      if (resolverRef.current) settle(false);
    };
  }, [settle]);

  // Grant access when the visitor signs in via the social buttons while the gate
  // is open. Google sign-in/One Tap completes in-page → `user` flips here → we
  // grant the Offerwall reward immediately. (Auth providers auto-subscribe to the
  // newsletter — same as NewsletterPopup — so no extra subscribe call is needed.)
  // The LinkedIn flow redirects away and returns logged-in: the gate is gone by
  // then, but offerwallHasAccess()'s firebase:authUser scan suppresses the
  // Offerwall on the returning pageview, so access is granted there too.
  useEffect(() => {
    if (open && user) {
      markNewsletterSubscribedLocally();
      try { Analytics.trackUIInteraction('offerwall_gate', 'social', 'access_granted', String(activeLocale)); } catch { /* no-op */ }
      settle(true);
    }
  }, [open, user, settle, activeLocale]);

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
        // Same string the checkbox rendered, same locale, one function
        // (#5712/#5718). The four-locale table this replaced described only
        // the newsletter, which was never all the visitor would receive.
        ...consentProof('communicationsOptIn', 'email_checkbox', activeLocale),
        consentGiven: true,
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

            {/* Same social row as the newsletter popup: a Google sign-in completes
                in-page (One Tap / GIS) and LinkedIn redirects; either way the
                visitor ends up authenticated (and auto-subscribed), which the
                grant-on-auth effect above turns into the Offerwall reward. */}
            <SocialSignInButtons
              locale={activeLocale}
              errorContext="offerwallGate"
              googleWidth={360}
            />

            <div className="relative py-1">
              <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-edge" /></div>
              <div className="relative flex justify-center">
                <span className="px-2 bg-surface text-xs text-muted uppercase tracking-wider">{copy.orWithEmail}</span>
              </div>
            </div>

            <EmailInput
              value={email}
              onChange={setEmail}
              ariaLabel={copy.title}
              required
              className="w-full px-4 py-2.5 bg-surface-alt border border-edge rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:border-transparent text-strong text-sm"
            />

            <label className="flex items-start gap-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={consentChecked}
                onChange={(e) => setConsentChecked(e.target.checked)}
                className="mt-0.5"
              />
              <ConsentNotice consentKey="communicationsOptIn" locale={activeLocale} />
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
