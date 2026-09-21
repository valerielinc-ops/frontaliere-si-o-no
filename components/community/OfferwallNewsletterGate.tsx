/**
 * Legacy newsletter gate retained for the newsletter consent surface. It is
 * no longer mounted by App.tsx: the custom Offerwall choice is disabled
 * globally and job-board access now uses a dedicated GPT Rewarded Web page.
 *
 * Older deployments used this component as the Offerwall custom-choice hook.
 * It remains source-compatible for the newsletter tests, but it must not
 * register anything with Funding Choices if it is ever imported again.
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
import EmailConsentCheckbox from '@/components/shared/EmailConsentCheckbox';
import { Analytics } from '@/services/analytics';
import { reportCaughtError } from '@/services/errorReporter';
import EmailInput, { validateEmailStrict } from '@/components/shared/EmailInput';
import SocialSignInButtons from '@/components/shared/SocialSignInButtons';
import { useAuth } from '@/services/authService';
import { hasFirebaseAuthPersistence } from '@/services/firebaseAuthPersistence';
import {
  upsertUnifiedEmailSubscriber,
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
  error: string;
  success: string;
  pendingTitle: string;
  pendingBody: string;
}> = {
  it: {
    title: 'Continua a leggere gratis',
    body: 'Iscriviti alla newsletter dei frontalieri (cambio CHF, fisco, lavoro) e accedi subito al contenuto. Niente spam, disiscrizione con un clic.',
    orWithEmail: 'oppure con email',
    submit: 'Iscriviti e leggi',
    dismiss: 'No grazie',
    invalidEmail: 'Inserisci un indirizzo email valido.',
    error: 'Iscrizione non riuscita. Riprova.',
    success: 'Fatto! Accesso sbloccato.',
    pendingTitle: 'Controlla la tua email',
    pendingBody: 'Apri l’email di conferma e clicca sul link per verificare l’indirizzo: l’accesso e le comunicazioni sono già attivi in base alla registrazione.',
  },
  en: {
    title: 'Keep reading for free',
    body: 'Subscribe to the cross-border workers newsletter (CHF rate, tax, jobs) and unlock this content now. No spam, one-click unsubscribe.',
    orWithEmail: 'or with email',
    submit: 'Subscribe & read',
    dismiss: 'No thanks',
    invalidEmail: 'Please enter a valid email address.',
    error: 'Subscription failed. Please try again.',
    success: 'Done! Access unlocked.',
    pendingTitle: 'Check your email',
    pendingBody: 'Open the confirmation email and click the link to verify your address: access and communications are already active under the registration terms.',
  },
  de: {
    title: 'Kostenlos weiterlesen',
    body: 'Abonnieren Sie den Grenzgänger-Newsletter (CHF-Kurs, Steuern, Jobs) und schalten Sie diesen Inhalt sofort frei. Kein Spam, Abmeldung mit einem Klick.',
    orWithEmail: 'oder mit E-Mail',
    submit: 'Abonnieren & lesen',
    dismiss: 'Nein danke',
    invalidEmail: 'Bitte geben Sie eine gültige E-Mail-Adresse ein.',
    error: 'Anmeldung fehlgeschlagen. Bitte erneut versuchen.',
    success: 'Fertig! Zugang freigeschaltet.',
    pendingTitle: 'Prüfen Sie Ihre E-Mail',
    pendingBody: 'Öffnen Sie die Bestätigungs-E-Mail und klicken Sie auf den Link, um Ihre Adresse zu bestätigen: Zugang und Mitteilungen sind aufgrund der Registrierung bereits aktiv.',
  },
  fr: {
    title: 'Continuez à lire gratuitement',
    body: 'Abonnez-vous à la newsletter des frontaliers (cours CHF, fiscalité, emploi) et accédez immédiatement au contenu. Pas de spam, désinscription en un clic.',
    orWithEmail: 'ou par e-mail',
    submit: 'S’abonner et lire',
    dismiss: 'Non merci',
    invalidEmail: 'Veuillez saisir une adresse e-mail valide.',
    error: 'Échec de l’inscription. Veuillez réessayer.',
    success: 'Terminé ! Accès débloqué.',
    pendingTitle: 'Vérifiez votre email',
    pendingBody: 'Ouvrez l’email de confirmation et cliquez sur le lien pour vérifier votre adresse : l’accès et les communications sont déjà actifs selon votre inscription.',
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

/** Legacy compatibility helpers; no active Funding Choices path calls this gate. */
/**
 * Synchronous "already has access" check for the Offerwall gate. Grants access
 * (suppresses the Offerwall) when the visitor is EITHER an existing newsletter
 * subscriber (local flag set by markNewsletterSubscribedLocally) OR signed in to
 * the site. Firebase Auth persists the session under the active persistence
 * key (mirrored from authService.hasPersistedAuthSession), so a logged-in user
 * is detected without waiting for async auth hydration — the registry's
 * initialize() must resolve in <1s. Keeps gating to anonymous, non-subscribed
 * readers (the funnel target); registered users never see it.
 */
function offerwallHasAccess(w: any): boolean {
  try {
    if (w.localStorage.getItem('newsletter_subscribed') === 'true') return true;
    if (hasFirebaseAuthPersistence(w.localStorage)) return true;
  } catch { /* localStorage unavailable */ }
  return false;
}

function ensureOfferwallRegistry(): void {
  // Intentionally empty: the Funding Choices custom-choice registry is
  // retired globally, so an accidental legacy import must fail safe.
}

/** Legacy queue drain retained for source compatibility; no active FC path uses it. */
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
  const [status, setStatus] = useState<'idle' | 'loading' | 'pending' | 'success' | 'error'>('idle');
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
      setStatus('idle');
      setErrorMessage('');
      setOpen(true);
      try { Analytics.trackUIInteraction('offerwall_gate', 'modal', 'show', String(offerwallLang || localeRef.current)); } catch { /* no-op */ }
      return new Promise<boolean>((resolve) => {
        resolverRef.current = resolve;
      });
    };
    (window as any).__ftOfferwallSubscribe = hook;
    // Keep the old hook harmless if a legacy bundle imports this component.
    ensureOfferwallRegistry();
    // Drain only legacy queued calls; the current Funding Choices path does not use this path.
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
  // grant the Offerwall reward immediately. Newsletter subscription is handled
  // only by the explicit email branch below.
  // The LinkedIn flow redirects away and returns logged-in: the gate is gone by
  // then, but offerwallHasAccess()'s active Firebase Auth key suppresses the
  // Offerwall on the returning pageview, so access is granted there too.
  useEffect(() => {
    if (open && user) {
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
    setStatus('loading');
    try {
      const firestore = await initFirestore();
      if (!firestore) throw new Error('firestore_unavailable');
      const upsert = await upsertUnifiedEmailSubscriber(firestore, {
        email,
        source: 'offerwall',
        sourceChannel: 'offerwall',
        sourcePage: window.location.pathname,
        sourceCta: 'offerwall_custom_choice',
        sourceComponent: 'OfferwallNewsletterGate',
        locale: activeLocale,
      });
      const needsConfirmation = upsert.status === 'pending' && !upsert.hadConfirmationProof;
      if (needsConfirmation) {
        try { Analytics.trackUIInteraction('offerwall_gate', 'form', 'subscribe', 'confirmation_pending'); } catch { /* no-op */ }
        setStatus('pending');
      } else {
        markNewsletterSubscribedLocally();
        try { Analytics.trackUIInteraction('offerwall_gate', 'form', 'subscribe', 'success'); } catch { /* no-op */ }
        setStatus('success');
      }
      // Grant content access after a brief state confirmation. A pending DOI
      // must not be confused with a confirmed communications subscription.
      setTimeout(() => settle(true), needsConfirmation ? 1200 : 900);
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

        {status === 'pending' ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center" role="status" aria-live="polite">
            <Mail className="h-10 w-10 text-info" aria-hidden="true" />
            <p className="font-semibold text-heading">{copy.pendingTitle}</p>
            <p className="text-sm text-muted">{copy.pendingBody}</p>
          </div>
        ) : status === 'success' ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <CheckCircle2 className="h-10 w-10 text-success" aria-hidden="true" />
            <p className="text-body">{copy.success}</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <p className="text-sm text-muted">{copy.body}</p>

            {/* Social sign-in authenticates the visitor; the grant-on-auth effect
                above turns that explicit access action into the Offerwall reward.
                It does not subscribe the address to the newsletter. */}
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

            <EmailConsentCheckbox
              id="offerwall-email-consent"
              consentKey="communicationsOptIn"
              locale={activeLocale}
              className="flex items-start gap-2 text-xs text-muted"
            />

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
