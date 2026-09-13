import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  FileText,
  Loader2,
  LockKeyhole,
  Mail,
  MapPin,
  ShieldCheck,
  Timer,
} from 'lucide-react';
import { Analytics } from '@/services/analyticsProxy';
import ConsentNotice from '@/components/shared/ConsentNotice';
import SocialSignInButtons from '@/components/shared/SocialSignInButtons';
import { validateEmailStrict } from '@/components/shared/EmailInput';
import {
  getAuthEmail,
  getUserDisplayName,
  useAuth,
} from '@/services/authService';
import {
  upsertNewsletterSubscriber,
  requestConfirmationEmail,
} from '@/services/newsletterSubscribers';
import { consentProof } from '@/services/consentTexts';
import { app } from '@/services/firebase';
import { signStabioDossoPetition } from '@/services/petition';
import { buildStabioDossoPetitionPath } from '@/services/petitionRoute';
import { useTranslation } from '@/services/i18n';

const PENDING_EMAIL_KEY = 'stabio_petition_pending_email';
const AUTH_INTENT_KEY = 'stabio_petition_auth_intent';

type FormStatus = 'idle' | 'loading' | 'email-sent' | 'success' | 'error';

type Source = {
  href: string;
  label: string;
};

const SOURCES: Record<string, Source> = {
  oasi: {
    href: 'https://www.oasi.ti.ch/web/rest/trafficcounts/sheet/051.pdf',
    label: 'OASI / Dipartimento del Territorio',
  },
  cdt: {
    href: 'https://www.cdt.ch/news/la-corsia-che-rendera-via-gaggiolo-piu-scorrevole-395441',
    label: 'Corriere del Ticino',
  },
  municipality: {
    href: 'https://www.stabio.ch/fileadmin/user_upload/Documenti/CC/Interpellanze/2024/Risposta_a_interpellanza_GUS_e_I_Verdi_-__Criticita_del_progetto_di_potenziamento_dell_autostrada_N2_Lugano_e_Mendrisio__PoLuMe__-_Quater.pdf',
    label: 'Comune di Stabio',
  },
  history: {
    href: 'https://www.laregione.ch/cantone/mendrisiotto/1186791/strada-per-il-gaggiolo-piu-sicura-a-stabio-cittadini-soddisfatti',
    label: 'laRegione, 2015',
  },
};

function readStorage(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key) || window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private browsing or a full storage quota must not block the form.
  }
}

function clearStorage(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key);
    window.sessionStorage.removeItem(key);
  } catch {
    // Best-effort cleanup only.
  }
}

async function initFirestore() {
  try {
    const { getFirestore } = await import('firebase/firestore');
    return getFirestore(app);
  } catch {
    return null;
  }
}

function sourceLink(source: Source, children: React.ReactNode) {
  return (
    <a
      href={source.href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-semibold text-link underline decoration-link/40 underline-offset-2 hover:decoration-link focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {children}
      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
    </a>
  );
}

export function StabioDossoPetitionPage() {
  const { t, locale } = useTranslation();
  const { user, loading: authLoading } = useAuth();
  const [email, setEmail] = useState('');
  const [consentChecked, setConsentChecked] = useState(false);
  const [status, setStatus] = useState<FormStatus>('idle');
  const [error, setError] = useState('');
  const [alreadySigned, setAlreadySigned] = useState(false);

  const signedInEmail = getAuthEmail(user) || '';

  useEffect(() => {
    if (signedInEmail && !email) setEmail(signedInEmail);
  }, [email, signedInEmail]);

  useEffect(() => {
    Analytics.trackPageView(buildStabioDossoPetitionPath(locale), t('petition.hero.title'));
  }, [locale, t]);

  useEffect(() => {
    if (!user) return;
    // These flags are written only after the visitor has checked the consent
    // box and deliberately pressed a sign-in control. They preserve that
    // context across the provider redirect without auto-consenting a restored
    // session that arrived here for another reason.
    if (readStorage(PENDING_EMAIL_KEY) || readStorage(AUTH_INTENT_KEY)) {
      setConsentChecked(true);
      clearStorage(AUTH_INTENT_KEY);
      if (status === 'email-sent') setStatus('idle');
    }
  }, [status, user]);

  const markAuthIntent = useCallback(() => {
    writeStorage(AUTH_INTENT_KEY, '1');
  }, []);

  const scrollToForm = useCallback(() => {
    document.getElementById('petition-sign')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const errorMessage = useCallback((reason: unknown) => {
    const message = String((reason as { message?: string })?.message || reason || '');
    if (message.includes('newsletter-opted-out')) return t('petition.form.newsletterOptOut');
    if (message.includes('newsletter_required')) return t('petition.form.newsletterError');
    if (message.includes('verified_account_required')) return t('petition.form.accountError');
    if (message.includes('petition/auth-required')) return t('petition.form.accountError');
    return t('petition.form.error');
  }, [t]);

  const handleEmailSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedEmail = email.trim().toLowerCase();
    if (!validateEmailStrict(normalizedEmail).valid) {
      setError(t('petition.form.emailRequired'));
      setStatus('error');
      return;
    }
    if (!consentChecked) {
      setError(t('petition.form.consentRequired'));
      setStatus('error');
      return;
    }

    setStatus('loading');
    setError('');
    try {
      const db = await initFirestore();
      if (!db) throw new Error('firestore-unavailable');
      const capture = await upsertNewsletterSubscriber(db, {
        email: normalizedEmail,
        source: 'stabio_petition',
        sourceChannel: 'newsletter_page',
        sourcePage: window.location.pathname,
        sourceCta: 'stabio_petition_email',
        sourceComponent: 'StabioDossoPetitionPage',
        sourceRouteFamily: 'petition',
        locale,
        signupLocale: locale,
        preferredLocale: locale,
        preferences: { traffic: true, general: true },
        status: 'pending',
        isActive: false,
        reconsent: true,
        ...consentProof('communicationsSignInEmail', 'email_checkbox', locale),
        consentGiven: true,
        consentPurpose: 'stabioPetition',
      });
      if (capture.optedOut) throw new Error('newsletter-opted-out');

      // A new pending address receives the DOI message from the upsert; that
      // confirmation link also returns a Firebase custom-auth session. An
      // existing/previously confirmed address does not enter that DOI branch,
      // so explicitly request the passwordless login link before showing the
      // "check your email" state. Without this branch the visitor could be
      // left waiting for an email that never enables the signing session.
      if (
        (capture.status === 'confirmed' || capture.status === 'subscribed')
        && (capture.existed || capture.hadConfirmationProof)
      ) {
        await requestConfirmationEmail(normalizedEmail, 'login');
      }

      writeStorage(PENDING_EMAIL_KEY, normalizedEmail);
      setEmail(normalizedEmail);
      setStatus('email-sent');
      Analytics.trackUIInteraction('stabio_petition', 'form', 'email_submitted', 'newsletter_gate');
    } catch (reason) {
      setError(errorMessage(reason));
      setStatus('error');
    }
  };

  const handleSignedInSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedEmail = signedInEmail.trim().toLowerCase();
    if (!user || !normalizedEmail) {
      setError(t('petition.form.accountError'));
      setStatus('error');
      return;
    }
    if (!consentChecked) {
      setError(t('petition.form.consentRequired'));
      setStatus('error');
      return;
    }

    setStatus('loading');
    setError('');
    try {
      const db = await initFirestore();
      if (!db) throw new Error('firestore-unavailable');
      const providerId = user.providerData?.find((provider: { providerId?: string }) => provider?.providerId)?.providerId || '';
      const consentMethod = providerId === 'google.com'
        ? 'google_oauth'
        : providerId === 'linkedin.com'
          ? 'linkedin_oauth'
          : 'email_checkbox';
      const capture = await upsertNewsletterSubscriber(db, {
        email: normalizedEmail,
        userId: user.uid || null,
        name: getUserDisplayName(user),
        source: 'stabio_petition',
        sourceChannel: providerId === 'google.com' ? 'auth_google' : 'web_app',
        sourcePage: window.location.pathname,
        sourceCta: 'stabio_petition_authenticated',
        sourceComponent: 'StabioDossoPetitionPage',
        sourceRouteFamily: 'petition',
        locale,
        signupLocale: locale,
        preferredLocale: locale,
        preferences: { traffic: true, general: true },
        status: 'confirmed',
        isActive: true,
        // A checked box is an explicit request to re-enter the DOI flow for
        // addresses that previously opted out. The confirmation link must
        // lift that opt-out before the petition can be signed.
        reconsent: true,
        ...consentProof(
          providerId === 'google.com' || providerId === 'linkedin.com'
            ? 'communicationsSignIn'
            : 'communicationsSignInEmail',
          consentMethod,
          locale,
        ),
        consentGiven: true,
        consentPurpose: 'stabioPetition',
      });
      if (capture.optedOut) throw new Error('newsletter-opted-out');
      if (capture.status !== 'confirmed' && capture.status !== 'subscribed') {
        setStatus('email-sent');
        Analytics.trackUIInteraction('stabio_petition', 'form', 'newsletter_reconsent_requested', 'newsletter_gate');
        return;
      }

      const result = await signStabioDossoPetition(user, locale);
      setAlreadySigned(result.alreadySigned === true);
      clearStorage(PENDING_EMAIL_KEY);
      clearStorage(AUTH_INTENT_KEY);
      setStatus('success');
      Analytics.trackUIInteraction('stabio_petition', 'form', result.alreadySigned ? 'already_signed' : 'signed', 'petition');
    } catch (reason) {
      setError(errorMessage(reason));
      setStatus('error');
    }
  };

  const sourceEntries = [
    { key: 'oasi', source: SOURCES.oasi, description: t('petition.sources.traffic') },
    { key: 'cdt', source: SOURCES.cdt, description: t('petition.sources.cdt') },
    { key: 'municipality', source: SOURCES.municipality, description: t('petition.sources.municipality') },
    { key: 'history', source: SOURCES.history, description: t('petition.sources.history') },
  ];

  return (
    <main className="space-y-8 px-4 py-6 sm:px-6 sm:py-8 lg:px-8 lg:py-10">
      <section className="relative overflow-hidden rounded-[2rem] border border-edge bg-surface p-6 shadow-sm sm:p-10 lg:p-14">
        <div className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full border-[28px] border-accent-subtle/70" aria-hidden="true" />
        <div className="relative max-w-4xl">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm font-medium text-subtle">
            <span className="inline-flex items-center gap-2"><MapPin className="h-4 w-4 text-accent" aria-hidden="true" />{t('petition.hero.meta')}</span>
            <span className="text-muted" aria-hidden="true">·</span>
            <span>{t('petition.notice')}</span>
          </div>
          <h1 className="mt-6 max-w-4xl font-display text-3xl font-bold leading-tight tracking-tight text-strong sm:text-5xl sm:leading-[1.08]">
            {t('petition.hero.title')}
          </h1>
          <p className="mt-5 max-w-3xl text-lg leading-8 text-subtle sm:text-xl">
            {t('petition.hero.subtitle')}
          </p>
          <button
            type="button"
            onClick={scrollToForm}
            className="mt-8 inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl bg-accent px-6 py-3 text-base font-semibold text-on-accent transition-colors hover:bg-accent-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
          >
            {t('petition.hero.cta')}
            <ArrowRight className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
      </section>

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(340px,420px)]">
        <div className="space-y-8">
          <section className="rounded-3xl border border-edge bg-surface p-6 shadow-sm sm:p-8" aria-labelledby="petition-evidence-heading">
            <div className="flex items-start gap-4">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent-subtle text-accent"><Timer className="h-5 w-5" aria-hidden="true" /></span>
              <div>
                <h2 id="petition-evidence-heading" className="font-display text-2xl font-semibold text-strong">{t('petition.evidence.title')}</h2>
                <p className="mt-2 max-w-2xl text-sm leading-7 text-subtle">{t('petition.notice')}</p>
              </div>
            </div>
            <dl className="mt-7 divide-y divide-edge overflow-hidden rounded-2xl border border-edge">
              <div className="grid gap-1 bg-surface-alt px-4 py-4 sm:grid-cols-[190px_1fr] sm:gap-5">
                <dt className="text-sm font-semibold text-strong">{t('petition.evidence.weekdayLabel')}</dt>
                <dd className="text-sm leading-6 text-subtle">{t('petition.evidence.weekday')}</dd>
              </div>
              <div className="grid gap-1 bg-surface px-4 py-4 sm:grid-cols-[190px_1fr] sm:gap-5">
                <dt className="text-sm font-semibold text-strong">{t('petition.evidence.weekendLabel')}</dt>
                <dd className="text-sm leading-6 text-subtle">{t('petition.evidence.weekend')}</dd>
              </div>
              <div className="grid gap-1 bg-surface-alt px-4 py-4 sm:grid-cols-[190px_1fr] sm:gap-5">
                <dt className="text-sm font-semibold text-strong">{t('petition.evidence.reportsLabel')}</dt>
                <dd className="text-sm leading-6 text-subtle">{t('petition.evidence.reports')}</dd>
              </div>
            </dl>
          </section>

          <section className="rounded-3xl border border-edge bg-surface p-6 shadow-sm sm:p-8" aria-labelledby="petition-ask-heading">
            <div className="flex items-start gap-4">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-surface-alt text-accent"><ShieldCheck className="h-5 w-5" aria-hidden="true" /></span>
              <div>
                <h2 id="petition-ask-heading" className="font-display text-2xl font-semibold text-strong">{t('petition.ask.title')}</h2>
                <p className="mt-2 text-sm leading-7 text-subtle">{t('petition.ask.intro')}</p>
              </div>
            </div>
            <ol className="mt-7 space-y-4">
              {[1, 2, 3].map((item) => (
                <li key={item} className="flex gap-4 rounded-2xl border border-edge bg-surface-alt p-4">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-bold text-on-accent" aria-hidden="true">{item}</span>
                  <p className="pt-0.5 text-sm leading-7 text-body">{t(`petition.ask.item${item}`)}</p>
                </li>
              ))}
            </ol>
            <p className="mt-6 border-l-2 border-accent pl-4 text-sm font-medium leading-7 text-strong">{t('petition.ask.safety')}</p>
          </section>

          <section className="rounded-3xl border border-edge bg-surface p-6 shadow-sm sm:p-8" aria-labelledby="petition-sources-heading">
            <div className="flex items-start gap-4">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-surface-alt text-accent"><FileText className="h-5 w-5" aria-hidden="true" /></span>
              <div>
                <h2 id="petition-sources-heading" className="font-display text-2xl font-semibold text-strong">{t('petition.sources.title')}</h2>
                <p className="mt-2 text-sm leading-7 text-subtle">{t('petition.sources.intro')}</p>
              </div>
            </div>
            <ul className="mt-6 divide-y divide-edge">
              {sourceEntries.map(({ key, source, description }) => (
                <li key={key} className="py-4 first:pt-0 last:pb-0">
                  <p className="text-sm text-body">{sourceLink(source, source.label)}</p>
                  <p className="mt-1 text-sm leading-6 text-subtle">{description}</p>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <aside id="petition-sign" className="scroll-mt-24 lg:sticky lg:top-6">
          <section className="rounded-3xl border border-accent-border bg-surface p-6 shadow-sm sm:p-8" aria-labelledby="petition-form-heading">
            <div className="flex items-start gap-4">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent text-on-accent"><LockKeyhole className="h-5 w-5" aria-hidden="true" /></span>
              <div>
                <h2 id="petition-form-heading" className="font-display text-2xl font-semibold text-strong">{t('petition.form.title')}</h2>
                <p className="mt-2 text-sm leading-6 text-subtle">{t('petition.form.subtitle')}</p>
              </div>
            </div>

            {status === 'success' ? (
              <div className="mt-7 rounded-2xl border border-success-border bg-success-subtle p-5" role="status" aria-live="polite">
                <CheckCircle2 className="h-8 w-8 text-success" aria-hidden="true" />
                <h3 className="mt-3 font-display text-lg font-semibold text-strong">{t('petition.form.successTitle')}</h3>
                <p className="mt-2 text-sm leading-6 text-subtle">
                  {alreadySigned ? t('petition.form.already') : t('petition.form.successBody')}
                </p>
                <p className="mt-4 text-xs leading-5 text-muted">{t('petition.form.privacyNote')}</p>
              </div>
            ) : status === 'email-sent' ? (
              <div className="mt-7 rounded-2xl border border-warning-border bg-warning-subtle p-5" role="status" aria-live="polite">
                <Mail className="h-8 w-8 text-warning-strong" aria-hidden="true" />
                <h3 className="mt-3 font-display text-lg font-semibold text-strong">{t('petition.form.checkEmailTitle')}</h3>
                <p className="mt-2 text-sm leading-6 text-subtle">{t('petition.form.checkEmailBody')}</p>
                <p className="mt-3 text-xs leading-5 text-muted">{t('petition.form.checkEmailReturn')}</p>
                <button
                  type="button"
                  onClick={() => { setStatus('idle'); setError(''); }}
                  className="mt-5 min-h-[44px] rounded-xl border border-edge bg-surface px-4 py-2 text-sm font-semibold text-body transition-colors hover:bg-surface-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {t('petition.form.backToForm')}
                </button>
              </div>
            ) : (
              <>
                <p className="mt-6 rounded-2xl bg-surface-alt px-4 py-3 text-sm leading-6 text-subtle">{t('petition.form.accountNotice')}</p>
                <div className="mt-6 rounded-2xl border border-edge bg-surface-alt p-4">
                  <div className="flex items-start gap-3">
                    <input
                      id="stabio-petition-consent"
                      type="checkbox"
                      checked={consentChecked}
                      onChange={(event) => { setConsentChecked(event.target.checked); setError(''); }}
                      className="mt-1 h-5 w-5 shrink-0 rounded border-edge text-accent focus:ring-2 focus:ring-accent"
                    />
                    <label htmlFor="stabio-petition-consent" className="text-sm font-medium leading-6 text-strong">
                      {t('petition.form.checkboxIntro')}
                    </label>
                  </div>
                  <ConsentNotice
                    consentKey="communicationsSignIn"
                    locale={locale}
                    className="mt-3 block text-xs leading-5 text-muted"
                  />
                </div>

                {user ? (
                  <form className="mt-6" onSubmit={handleSignedInSubmit}>
                    <p className="text-sm text-subtle">{t('petition.form.signedAs')} <strong className="text-strong">{signedInEmail || getUserDisplayName(user)}</strong></p>
                    <button
                      type="submit"
                      disabled={status === 'loading' || authLoading}
                      className="mt-4 inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
                    >
                      {status === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
                      {status === 'loading' ? t('petition.form.signing') : t('petition.form.signCta')}
                    </button>
                  </form>
                ) : (
                  <>
                    <form className="mt-6" onSubmit={handleEmailSubmit}>
                      <label htmlFor="stabio-petition-email" className="text-sm font-semibold text-strong">{t('petition.form.emailLabel')}</label>
                      <input
                        id="stabio-petition-email"
                        type="email"
                        value={email}
                        onChange={(event) => { setEmail(event.target.value); setError(''); }}
                        autoComplete="email"
                        inputMode="email"
                        required
                        className="mt-2 min-h-[48px] w-full rounded-xl border border-edge bg-surface px-4 py-3 text-base text-strong outline-none transition-colors placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
                      />
                      <p className="mt-2 text-xs leading-5 text-muted">{t('petition.form.emailHint')}</p>
                      <button
                        type="submit"
                        disabled={status === 'loading' || authLoading}
                        className="mt-4 inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
                      >
                        {status === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Mail className="h-4 w-4" aria-hidden="true" />}
                        {status === 'loading' ? t('petition.form.signing') : t('petition.form.emailCta')}
                      </button>
                    </form>

                    <div className="my-6 flex items-center gap-3 text-xs text-muted" aria-hidden="true">
                      <span className="h-px flex-1 bg-edge" />
                      <span>{t('petition.form.or')}</span>
                      <span className="h-px flex-1 bg-edge" />
                    </div>

                    <div>
                      <h3 className="text-sm font-semibold text-strong">{t('petition.form.socialTitle')}</h3>
                      <p className="mt-1 text-xs leading-5 text-muted">{t('petition.form.socialIntro')}</p>
                      {!authLoading && consentChecked && (
                        <SocialSignInButtons
                          locale={locale}
                          className="mt-4"
                          layout="stack"
                          errorContext="stabioPetition.socialSignIn"
                          onAuthIntent={markAuthIntent}
                          mountEnabled={!authLoading && consentChecked}
                        />
                      )}
                      {!consentChecked && <p className="mt-3 text-xs text-muted">{t('petition.form.consentRequired')}</p>}
                    </div>
                  </>
                )}

                {status === 'error' && (
                  <p className="mt-5 flex items-start gap-2 rounded-xl border border-danger-border bg-danger-subtle px-4 py-3 text-sm leading-6 text-danger-strong" role="alert">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{error}</span>
                  </p>
                )}
              </>
            )}
          </section>
        </aside>
      </div>
    </main>
  );
}
