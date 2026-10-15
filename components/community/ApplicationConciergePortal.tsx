import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowRight, BriefcaseBusiness, CheckCircle2, Clock3, FileText, Loader2, ShieldCheck, Sparkles, Target, UploadCloud, XCircle } from 'lucide-react';
import { useLocale, useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analyticsProxy';
import { REPLAY_PRIVATE_ATTRS, REPLAY_PRIVATE_CLASS } from '@/services/replayPrivacy';
import { ensureAssistedApplicationAuth } from '@/services/assistedApplicationCheckout';
import { createApplicationConciergeCheckout } from '@/services/applicationConciergeCheckout';
import { AssistedApplicationLegalLinks } from '@/components/community/AssistedApplicationLegalLinks';
import {
  acceptApplicationConciergeProposal,
  declineApplicationConciergeProposal,
  recordApplicationConciergeConsent,
  fetchApplicationConciergeService,
  saveApplicationConciergeProfile,
  type ApplicationConciergeProposal,
  type ApplicationConciergeService,
} from '@/services/applicationConciergeService';

const MAX_CV_BYTES = 5 * 1024 * 1024;
const POLL_MS = 3500;
const MATCHING_STATES = new Set(['queued', 'processing', 'running']);

export interface ApplicationConciergePortalProps {
  serviceId?: string | null;
  entry?: boolean;
  authUser?: any | null;
  authLoading?: boolean;
  onRequireAuth?: () => void;
}

function fileTypeFor(file: File): string | null {
  const extension = file.name.toLowerCase().split('.').pop() || '';
  return {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }[extension] || null;
}

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'cv.pdf';
}

function randomToken(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // Fall back below.
  }
  return Math.random().toString(36).slice(2, 14);
}

function errorKey(error: unknown): string {
  const value = error instanceof Error ? error.message : '';
  return /^[a-z][a-z0-9_.:/-]{0,63}$/.test(value) ? value : 'generic';
}

function isPending(service: ApplicationConciergeService | null): boolean {
  return service?.paymentStatus === 'pending' || service?.serviceStatus === 'awaiting_payment';
}

export default function ApplicationConciergePortal({
  serviceId = null,
  entry = false,
  authUser = null,
  authLoading = false,
  onRequireAuth,
}: ApplicationConciergePortalProps) {
  const { t } = useTranslation();
  const [locale] = useLocale();
  const formattedPrice = useMemo(
    () => new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(39.99),
    [locale],
  );
  const [service, setService] = useState<ApplicationConciergeService | null>(null);
  const [currentUser, setCurrentUser] = useState<any | null>(authUser);
  const [loading, setLoading] = useState(Boolean(serviceId));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const conciergeViewTracked = useRef(false);

  useEffect(() => {
    if (!entry || serviceId || conciergeViewTracked.current) return;
    conciergeViewTracked.current = true;
    Analytics.trackApplicationConciergeView();
  }, [entry, serviceId]);

  useEffect(() => {
    if (!authUser) return;
    setCurrentUser(authUser);
    setName((value) => value || String(authUser.displayName || ''));
    setEmail((value) => value || String(authUser.email || ''));
  }, [authUser]);

  const ensureUser = useCallback(async () => {
    if (currentUser?.getIdToken) return currentUser;
    if (authLoading) return null;
    const user = await ensureAssistedApplicationAuth();
    if (user) setCurrentUser(user);
    return user;
  }, [authLoading, currentUser]);

  const loadService = useCallback(async () => {
    if (!serviceId) return null;
    const user = await ensureUser();
    if (!user) return null;
    const loaded = await fetchApplicationConciergeService(user, serviceId);
    setService(loaded);
    setName((value) => value || loaded.applicantName || user.displayName || '');
    setEmail((value) => value || loaded.applicantEmail || loaded.customerEmail || user.email || '');
    setPhone((value) => value || loaded.applicantPhone || '');
    setConsent(loaded.hasConsent);
    return loaded;
  }, [ensureUser, serviceId]);

  useEffect(() => {
    if (!serviceId || authLoading) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void loadService().catch((loadError) => {
      if (!cancelled) setError(errorKey(loadError));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [authLoading, loadService, serviceId]);

  useEffect(() => {
    if (!serviceId || !service || (!isPending(service) && !MATCHING_STATES.has(String(service.matchingStatus || '')))) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(async function poll() {
      if (cancelled) return;
      try {
        const loaded = await loadService();
        if (!cancelled && loaded && (isPending(loaded) || MATCHING_STATES.has(String(loaded.matchingStatus || '')))) window.setTimeout(poll, POLL_MS);
      } catch (pollError) {
        if (!cancelled) setError(errorKey(pollError));
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [loadService, service, serviceId]);

  const displayError = useMemo(() => {
    if (!error) return null;
    const key = `jobBoard.concierge.errors.${error}`;
    const translated = t(key);
    return translated === key ? t('jobBoard.concierge.errors.generic') : translated;
  }, [error, t]);

  const startCheckout = async () => {
    if (busy === 'checkout') return;
    Analytics.trackApplicationConciergeCheckoutClick();
    setBusy('checkout');
    setError(null);
    try {
      const base = new URL(window.location.href);
      base.searchParams.delete('application_concierge');
      base.searchParams.delete('application_concierge_service_id');
      const result = await createApplicationConciergeCheckout({ successUrl: base.toString(), cancelUrl: base.toString(), locale }, currentUser);
      window.location.assign(result.url);
    } catch (checkoutError) {
      setError(errorKey(checkoutError));
    } finally {
      setBusy(null);
    }
  };

  const saveProfile = async (options: { cvStorageKey?: string; cvFileName?: string } = {}) => {
    if (!serviceId) return null;
    const user = await ensureUser();
    if (!user) {
      onRequireAuth?.();
      throw new Error('auth_required');
    }
    const updated = await saveApplicationConciergeProfile(user, serviceId, {
      applicantName: name.trim(),
      applicantEmail: email.trim().toLowerCase(),
      applicantPhone: phone.trim(),
      ...(options.cvStorageKey ? { cvStorageKey: options.cvStorageKey } : {}),
      ...(options.cvFileName ? { cvFileName: options.cvFileName } : {}),
    });
    setService(updated);
    setConsent(updated.hasConsent);
    return updated;
  };

  const handleRecordConsent = async () => {
    if (!serviceId || !consent || busy) return;
    setBusy('consent');
    setError(null);
    setMessage(null);
    try {
      const user = await ensureUser();
      if (!user) {
        onRequireAuth?.();
        throw new Error('auth_required');
      }
      const updated = await recordApplicationConciergeConsent(user, serviceId, {
        applicantName: name.trim(),
        applicantEmail: email.trim().toLowerCase(),
        applicantPhone: phone.trim(),
      });
      setService(updated);
      setConsent(updated.hasConsent);
      setMessage(t('jobBoard.concierge.consentRecorded'));
    } catch (consentError) {
      setError(errorKey(consentError));
    } finally {
      setBusy(null);
    }
  };

  const handleSaveProfile = async () => {
    setBusy('profile');
    setError(null);
    setMessage(null);
    try {
      await saveProfile();
      setMessage(t('jobBoard.concierge.profileSaved'));
    } catch (saveError) {
      setError(errorKey(saveError));
    } finally {
      setBusy(null);
    }
  };

  const handleCvChange = async (file: File | undefined) => {
    if (!file || !serviceId) return;
    const contentType = fileTypeFor(file);
    if (!contentType || file.size >= MAX_CV_BYTES) {
      setError('invalid_cv_file');
      return;
    }
    setBusy('cv');
    setError(null);
    setMessage(null);
    try {
      const user = await ensureUser();
      if (!user) throw new Error('auth_required');
      await saveProfile();
      const [{ getApp }, storageModule] = await Promise.all([import('@/services/firebase'), import('firebase/storage')]);
      const storage = storageModule.getStorage(await getApp());
      const path = `application-concierge-uploads/${serviceId}/${Date.now()}-${randomToken()}-${safeFileName(file.name)}`;
      const uploaded = await storageModule.uploadBytes(storageModule.ref(storage, path), file, { contentType });
      const fullPath = uploaded.metadata.fullPath || path;
      await saveProfile({ cvStorageKey: fullPath, cvFileName: safeFileName(file.name) });
      setMessage(t('jobBoard.concierge.cvUploaded'));
    } catch (uploadError) {
      setError(errorKey(uploadError));
    } finally {
      setBusy(null);
    }
  };

  const decide = async (proposal: ApplicationConciergeProposal, decision: 'accept' | 'decline') => {
    if (!serviceId || busy) return;
    const user = await ensureUser();
    if (!user) return;
    setBusy(`${decision}:${proposal.proposalId}`);
    setError(null);
    setMessage(null);
    try {
      const result = decision === 'accept'
        ? await acceptApplicationConciergeProposal(user, serviceId, proposal.proposalId)
        : { service: await declineApplicationConciergeProposal(user, serviceId, proposal.proposalId) };
      setService(result.service);
      setMessage(t(decision === 'accept' ? 'jobBoard.concierge.proposalAccepted' : 'jobBoard.concierge.proposalDeclined'));
    } catch (decisionError) {
      setError(errorKey(decisionError));
    } finally {
      setBusy(null);
    }
  };

  if (entry && !serviceId) {
    return (
      <main className={`${REPLAY_PRIVATE_CLASS} mx-auto max-w-5xl px-4 py-6 sm:py-10`} {...REPLAY_PRIVATE_ATTRS}>
        <div className="space-y-10">
          <section className="overflow-hidden rounded-3xl border border-edge bg-surface shadow-stripe-sm">
            <div className="grid lg:grid-cols-[1.08fr_.92fr]">
              <div className="bg-accent-subtle/60 p-6 sm:p-10">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent text-on-accent shadow-stripe-sm">
                  <BriefcaseBusiness aria-hidden="true" />
                </div>
                <h1 className="mt-6 max-w-2xl text-3xl font-bold leading-tight tracking-[-0.025em] font-display text-heading sm:text-5xl">
                  {t('jobBoard.concierge.title')}
                </h1>
                <p className="mt-5 max-w-2xl text-base leading-7 text-body sm:text-lg">
                  {t('jobBoard.concierge.description')}
                </p>
                <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-accent/30 bg-surface px-3 py-2 text-sm font-semibold text-accent">
                  <Sparkles className="h-4 w-4" aria-hidden="true" />
                  {t('jobBoard.concierge.landingBadge')}
                </div>
                <div className="mt-8 grid gap-3 sm:grid-cols-3">
                  <Info icon={<Clock3 size={17} />} label={t('jobBoard.concierge.duration')} />
                  <Info icon={<BriefcaseBusiness size={17} />} label={t('jobBoard.concierge.quota')} />
                  <Info icon={<ShieldCheck size={17} />} label={t('jobBoard.concierge.noRenewal')} />
                </div>
                <div className="mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
                  <button
                    type="button"
                    onClick={() => { void startCheckout(); }}
                    disabled={busy === 'checkout'}
                    aria-busy={busy === 'checkout'}
                    className="inline-flex min-h-[52px] items-center justify-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-bold text-on-accent shadow-stripe-sm transition-colors hover:bg-accent-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
                    data-testid="application-concierge-start"
                  >
                    {busy === 'checkout' && <Loader2 size={17} className="animate-spin" aria-hidden="true" />}
                    {t('jobBoard.concierge.start')}
                    <ArrowRight size={17} aria-hidden="true" />
                  </button>
                  <span className="text-sm font-semibold text-body">{formattedPrice} · {t('jobBoard.concierge.priceNote')}</span>
                </div>
                {displayError && <p role="alert" className="mt-4 text-sm font-medium text-danger">{displayError}</p>}
                <p className="mt-5 max-w-2xl text-xs leading-5 text-subtle">{t('jobBoard.concierge.disclosure')}</p>
              </div>
              <div className="border-t border-edge bg-surface p-6 sm:p-10 lg:border-l lg:border-t-0">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-2xl font-bold tracking-[-0.02em] font-display text-heading">
                      {t('jobBoard.concierge.howItWorksTitle')}
                    </h2>
                    <p className="mt-2 text-sm leading-6 text-subtle">{t('jobBoard.concierge.howItWorksIntro')}</p>
                  </div>
                  <Target className="mt-1 h-6 w-6 shrink-0 text-accent" aria-hidden="true" />
                </div>
                <ol className="mt-7 space-y-6">
                  <Step number="1" title={t('jobBoard.concierge.step1Title')} text={t('jobBoard.concierge.step1Text')} />
                  <Step number="2" title={t('jobBoard.concierge.step2Title')} text={t('jobBoard.concierge.step2Text')} />
                  <Step number="3" title={t('jobBoard.concierge.step3Title')} text={t('jobBoard.concierge.step3Text')} />
                  <Step number="4" title={t('jobBoard.concierge.step4Title')} text={t('jobBoard.concierge.step4Text')} />
                </ol>
              </div>
            </div>
          </section>

          <section aria-labelledby="concierge-benefits-title">
            <div className="max-w-2xl">
              <h2 id="concierge-benefits-title" className="text-2xl font-bold tracking-[-0.02em] font-display text-heading sm:text-3xl">
                {t('jobBoard.concierge.benefitsTitle')}
              </h2>
              <p className="mt-3 text-base leading-7 text-subtle">{t('jobBoard.concierge.benefitsIntro')}</p>
            </div>
            <ul className="mt-7 grid gap-x-8 gap-y-7 md:grid-cols-3">
              <Benefit icon={<Target size={20} />} title={t('jobBoard.concierge.benefitMatchingTitle')} text={t('jobBoard.concierge.benefitMatchingText')} />
              <Benefit icon={<FileText size={20} />} title={t('jobBoard.concierge.benefitTailoredTitle')} text={t('jobBoard.concierge.benefitTailoredText')} />
              <Benefit icon={<ShieldCheck size={20} />} title={t('jobBoard.concierge.benefitApprovalTitle')} text={t('jobBoard.concierge.benefitApprovalText')} />
            </ul>
          </section>

          <section className="rounded-3xl border border-edge bg-surface p-6 sm:p-9" aria-labelledby="concierge-included-title">
            <div className="max-w-2xl">
              <h2 id="concierge-included-title" className="text-2xl font-bold tracking-[-0.02em] font-display text-heading sm:text-3xl">
                {t('jobBoard.concierge.includedTitle')}
              </h2>
              <p className="mt-3 text-base leading-7 text-subtle">{t('jobBoard.concierge.includedIntro')}</p>
            </div>
            <div className="mt-8 grid gap-6 sm:grid-cols-3">
              <IncludedValue value="30" label={t('jobBoard.concierge.included30')} />
              <IncludedValue value="10" label={t('jobBoard.concierge.included10')} />
              <IncludedValue value="€39,99" label={t('jobBoard.concierge.includedPrice')} />
            </div>
          </section>

          <section className="rounded-3xl border border-info-border bg-info-subtle/60 p-6 sm:p-9" aria-labelledby="concierge-clarity-title">
            <div className="grid gap-7 lg:grid-cols-[.85fr_1.15fr] lg:items-start">
              <div>
                <h2 id="concierge-clarity-title" className="text-2xl font-bold tracking-[-0.02em] font-display text-heading sm:text-3xl">
                  {t('jobBoard.concierge.clarityTitle')}
                </h2>
                <p className="mt-3 text-base leading-7 text-body">{t('jobBoard.concierge.clarityText')}</p>
              </div>
              <div className="space-y-3 text-sm leading-6 text-body">
                <p className="flex items-start gap-3"><CheckCircle2 className="mt-1 h-5 w-5 shrink-0 text-success" aria-hidden="true" />{t('jobBoard.concierge.clarityApproval')}</p>
                <p className="flex items-start gap-3"><CheckCircle2 className="mt-1 h-5 w-5 shrink-0 text-success" aria-hidden="true" />{t('jobBoard.concierge.clarityNoRenewal')}</p>
                <p className="flex items-start gap-3"><CheckCircle2 className="mt-1 h-5 w-5 shrink-0 text-success" aria-hidden="true" />{t('jobBoard.concierge.noGuarantee')}</p>
              </div>
            </div>
          </section>

          <section className="rounded-3xl bg-accent p-6 text-on-accent shadow-stripe-sm sm:p-9" aria-labelledby="concierge-final-title">
            <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
              <div className="max-w-2xl">
                <h2 id="concierge-final-title" className="text-2xl font-bold tracking-[-0.02em] font-display sm:text-3xl">
                  {t('jobBoard.concierge.finalTitle')}
                </h2>
                <p className="mt-3 text-sm leading-6 text-on-accent/85">{t('jobBoard.concierge.finalText')}</p>
              </div>
              <button
                type="button"
                onClick={() => { void startCheckout(); }}
                disabled={busy === 'checkout'}
                aria-busy={busy === 'checkout'}
                className="inline-flex min-h-[52px] shrink-0 items-center justify-center gap-2 rounded-xl bg-surface px-5 py-3 text-sm font-bold text-accent transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-surface focus-visible:ring-offset-2 focus-visible:ring-offset-accent disabled:cursor-wait disabled:opacity-60"
              >
                {busy === 'checkout' && <Loader2 size={17} className="animate-spin" aria-hidden="true" />}
                {t('jobBoard.concierge.start')} · {formattedPrice}
                <ArrowRight size={17} aria-hidden="true" />
              </button>
            </div>
          </section>
        </div>
      </main>
    );
  }

  if (loading || authLoading) return <PortalShell><div className="flex items-center gap-2 text-sm text-subtle" role="status"><Loader2 size={17} className="animate-spin" aria-hidden="true" />{t('jobBoard.concierge.loading')}</div></PortalShell>;
  if (!service) return <PortalShell><p role="alert" className="text-sm text-danger">{displayError || t('jobBoard.concierge.errors.service_not_found')}</p></PortalShell>;

  const pending = isPending(service);
  const expired = service.serviceStatus === 'expired' || (service.expiresAt ? new Date(service.expiresAt).getTime() <= Date.now() : false);

  const matchingStatus = String(service.matchingStatus || '');
  const matchingActive = MATCHING_STATES.has(matchingStatus);
  const matchingNeedsReview = matchingStatus === 'needs_review';
  const matchingFailed = matchingStatus === 'failed';

  return (
    <PortalShell wide>
      <div className="space-y-6">
        <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">{t('jobBoard.concierge.eyebrow')}</p>
            <h1 className="mt-1 text-3xl font-bold tracking-[-0.025em] font-display text-heading">{t('jobBoard.concierge.portalTitle')}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-subtle">{t('jobBoard.concierge.portalIntro')}</p>
          </div>
          <div className="flex items-center gap-3 rounded-2xl border border-accent-border bg-accent-subtle/60 px-4 py-3">
            <Target className="h-5 w-5 text-accent" aria-hidden="true" />
            <div><p className="text-xs font-semibold uppercase tracking-wide text-accent">{t('jobBoard.concierge.remaining')}</p><p className="text-xl font-bold tabular-nums text-heading">{service.remainingPositions}<span className="text-sm font-medium text-subtle">/{service.maxPositions}</span></p></div>
          </div>
        </header>
        {pending && <Notice icon={<Clock3 size={17} />} text={t('jobBoard.concierge.paymentPending')} />}
        {service.paymentStatus === 'failed' && <Notice icon={<XCircle size={17} />} tone="danger" text={t('jobBoard.concierge.paymentFailed')} />}
        {expired && <Notice icon={<Clock3 size={17} />} tone="warning" text={t('jobBoard.concierge.expired')} />}
        {message && <Notice icon={<CheckCircle2 size={17} />} tone="success" text={message} />}
        {displayError && <p role="alert" className="rounded-xl border border-danger-border bg-danger-subtle p-3 text-sm text-danger">{displayError}</p>}
        {!pending && service.paymentStatus === 'paid' && (
          <>
            <div className="grid gap-5 lg:grid-cols-[minmax(0,.9fr)_minmax(0,1.1fr)]">
              <section className="rounded-2xl border border-edge bg-surface p-5 shadow-stripe-sm" aria-labelledby="concierge-profile-title">
                <div className="flex items-start gap-3">
                  <div className="rounded-xl bg-accent-subtle p-2.5 text-accent"><ShieldCheck size={20} aria-hidden="true" /></div>
                  <div><h2 id="concierge-profile-title" className="text-lg font-bold font-display text-heading">{t('jobBoard.concierge.profileTitle')}</h2><p className="mt-1 text-sm leading-6 text-subtle">{t('jobBoard.concierge.profileIntro')}</p></div>
                </div>
                <form className="mt-5 space-y-4" onSubmit={(event) => { event.preventDefault(); void handleSaveProfile(); }}>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="text-sm font-medium text-body">{t('jobBoard.concierge.name')}<input value={name} onChange={(event) => setName(event.target.value)} className="mt-1 w-full rounded-xl border border-edge bg-surface px-3 py-2.5 text-sm text-heading" autoComplete="name" /></label>
                    <label className="text-sm font-medium text-body">{t('jobBoard.concierge.email')}<input value={email} onChange={(event) => setEmail(event.target.value)} className="mt-1 w-full rounded-xl border border-edge bg-surface px-3 py-2.5 text-sm text-heading" type="email" autoComplete="email" /></label>
                  </div>
                  <label className="block text-sm font-medium text-body">{t('jobBoard.concierge.phone')}<input value={phone} onChange={(event) => setPhone(event.target.value)} className="mt-1 w-full rounded-xl border border-edge bg-surface px-3 py-2.5 text-sm text-heading" autoComplete="tel" /></label>
                  <button type="submit" disabled={busy !== null || expired} className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-edge px-4 py-2 text-sm font-semibold text-body transition-colors hover:border-accent hover:text-accent disabled:opacity-60">{busy === 'profile' && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}{t('jobBoard.concierge.saveData')}</button>
                </form>

                <div className="mt-6 border-t border-edge pt-5">
                  {service.hasConsent ? (
                    <div className="rounded-xl border border-success-border bg-success-subtle/70 p-4">
                      <div className="flex items-start gap-3"><CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden="true" /><div><p className="text-sm font-semibold text-heading">{t('jobBoard.concierge.consentRecorded')}</p><p className="mt-1 text-xs leading-5 text-body">{t('jobBoard.concierge.consentStored')}</p><p className="mt-3 flex items-center gap-2 text-xs font-medium text-body"><FileText size={14} className="text-accent" aria-hidden="true" />{service.cvFileName || t('jobBoard.concierge.cvPending')}</p></div></div>
                      <AssistedApplicationLegalLinks className="mt-3 block text-xs text-muted" />
                    </div>
                  ) : (
                    <div className="rounded-xl border border-warning-border bg-warning-subtle/40 p-4">
                      <p className="text-sm font-semibold text-heading">{t('jobBoard.concierge.consentTitle')}</p>
                      <label className="mt-3 flex items-start gap-3 text-sm leading-6 text-body"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-accent" /><span>{t('jobBoard.concierge.consent')}</span></label>
                      <AssistedApplicationLegalLinks className="mt-2 block pl-7 text-xs text-muted" />
                      <button type="button" onClick={() => { void handleRecordConsent(); }} disabled={!consent || busy !== null || expired} className="mt-4 inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-bold text-on-accent transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50">{busy === 'consent' && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}{t('jobBoard.concierge.recordConsent')}</button>
                    </div>
                  )}
                </div>

                <div className="mt-5 rounded-xl border border-dashed border-edge p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div><p className="text-sm font-semibold text-body">{service.hasCv ? <span className="inline-flex items-center gap-2 text-success"><CheckCircle2 size={16} aria-hidden="true" />{t('jobBoard.concierge.cvReady')}</span> : t('jobBoard.concierge.cvTitle')}</p>{service.cvFileName && <p className="mt-1 text-xs text-muted">{service.cvFileName}</p>}</div>
                    <label className={`inline-flex min-h-[42px] cursor-pointer items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold ${service.hasConsent ? 'bg-accent text-on-accent hover:bg-accent-strong' : 'bg-surface-raised text-muted'}`}><UploadCloud size={16} aria-hidden="true" />{busy === 'cv' ? t('jobBoard.concierge.uploading') : t('jobBoard.concierge.upload')}<input type="file" accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="sr-only" disabled={!service.hasConsent || busy !== null || expired} onChange={(event) => { void handleCvChange(event.target.files?.[0]); event.currentTarget.value = ''; }} /></label>
                  </div>
                  {!service.hasConsent && <p className="mt-2 text-xs leading-5 text-subtle">{t('jobBoard.concierge.consentUploadHint')}</p>}
                  {service.cvProfileStatus === 'needs_review' && <p className="mt-2 text-xs leading-5 text-warning">{t('jobBoard.concierge.cvNeedsReview')}</p>}
                </div>
              </section>

              <section className="rounded-2xl border border-edge bg-surface p-5 shadow-stripe-sm" aria-labelledby="concierge-proposals-title">
                <div className="flex items-start justify-between gap-3"><div><h2 id="concierge-proposals-title" className="text-lg font-bold font-display text-heading">{t('jobBoard.concierge.proposalsTitle')}</h2><p className="mt-1 text-sm leading-6 text-subtle">{t('jobBoard.concierge.proposalsIntro')}</p></div><span className="shrink-0 rounded-full bg-surface-raised px-3 py-1 text-xs font-semibold text-muted">{service.acceptedPositionsCount}/{service.maxPositions}</span></div>
                {matchingActive && <div className="mt-5 rounded-xl border border-info-border bg-info-subtle/60 p-4" role="status"><div className="flex items-center gap-2 text-sm font-semibold text-info"><Loader2 size={16} className="animate-spin" aria-hidden="true" />{t('jobBoard.concierge.matchingRunning')}</div><p className="mt-1 text-xs leading-5 text-body">{t('jobBoard.concierge.matchingRunningHint')}</p><div className="mt-4 space-y-2" aria-hidden="true"><div className="h-16 animate-pulse rounded-lg bg-surface" /><div className="h-16 animate-pulse rounded-lg bg-surface" /></div></div>}
                {matchingNeedsReview && <div className="mt-5"><Notice icon={<FileText size={17} />} tone="warning" text={t('jobBoard.concierge.matchingNeedsReview')} /></div>}
                {matchingFailed && <div className="mt-5"><Notice icon={<XCircle size={17} />} tone="danger" text={t('jobBoard.concierge.matchingFailed')} /></div>}
                <div className="mt-5 space-y-3">
                  {service.proposals.length === 0 && !matchingActive && !matchingNeedsReview && !matchingFailed && <p className="rounded-xl bg-surface-raised p-4 text-sm leading-6 text-subtle">{t('jobBoard.concierge.noProposals')}</p>}
                  {service.proposals.map((proposal) => <ProposalCard key={proposal.proposalId} proposal={proposal} disabled={expired || busy !== null} canAccept={service.hasCv && service.hasConsent} busy={busy} onDecision={decide} t={t} />)}
                </div>
              </section>
            </div>
            <p className="text-xs leading-5 text-muted">{t('jobBoard.concierge.noGuarantee')}</p>
          </>
        )}
      </div>
    </PortalShell>
  );
}

function PortalShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return <main className={`${REPLAY_PRIVATE_CLASS} mx-auto ${wide ? 'max-w-5xl' : 'max-w-3xl'} px-4 py-8 sm:py-12`} {...REPLAY_PRIVATE_ATTRS}><section className="rounded-3xl border border-edge bg-surface p-5 shadow-sm sm:p-8">{children}</section></main>;
}

function Info({ icon, label }: { icon: ReactNode; label: string }) {
  return <div className="flex items-start gap-2 rounded-xl border border-edge bg-surface p-3 text-sm font-semibold leading-5 text-body">{icon}<span>{label}</span></div>;
}

function Step({ number, title, text }: { number: string; title: string; text: string }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-bold text-on-accent" aria-hidden="true">{number}</span>
      <div>
        <h3 className="font-bold text-heading">{title}</h3>
        <p className="mt-1 text-sm leading-6 text-subtle">{text}</p>
      </div>
    </li>
  );
}

function Benefit({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <li className="border-t border-edge pt-4">
      <div className="flex items-center gap-2 text-accent">{icon}<h3 className="font-bold text-heading">{title}</h3></div>
      <p className="mt-2 text-sm leading-6 text-subtle">{text}</p>
    </li>
  );
}

function IncludedValue({ value, label }: { value: string; label: string }) {
  return (
    <div className="border-t-2 border-accent pt-3">
      <p className="text-3xl font-bold tracking-[-0.02em] font-display text-heading">{value}</p>
      <p className="mt-1 text-sm leading-6 text-subtle">{label}</p>
    </div>
  );
}

function Notice({ icon, text, tone = 'info' }: { icon: ReactNode; text: string; tone?: 'info' | 'danger' | 'warning' | 'success' }) {
  const styles = { info: 'border-info-border bg-info-subtle text-info', danger: 'border-danger-border bg-danger-subtle text-danger', warning: 'border-warning-border bg-warning-subtle text-warning', success: 'border-success-border bg-success-subtle text-success' };
  return <div role="status" className={`flex items-start gap-2 rounded-xl border p-3 text-sm ${styles[tone]}`}>{icon}<span>{text}</span></div>;
}

function ProposalCard({ proposal, disabled, canAccept, busy, onDecision, t }: { proposal: ApplicationConciergeProposal; disabled: boolean; canAccept: boolean; busy: string | null; onDecision: (proposal: ApplicationConciergeProposal, decision: 'accept' | 'decline') => void; t: (key: string, params?: Record<string, string>) => string }) {
  const proposed = proposal.status === 'proposed';
  return <article className="rounded-xl border border-edge p-4 transition-colors hover:border-accent-border"><div className="flex items-start gap-3"><div className="mt-0.5 rounded-lg bg-accent-subtle p-2 text-accent"><FileText size={17} aria-hidden="true" /></div><div className="min-w-0 flex-1"><h3 className="font-bold text-heading">{proposal.jobTitle}</h3><p className="text-sm text-subtle">{proposal.companyName}{proposal.location ? ` · ${proposal.location}` : ''}</p>{proposal.matchScore && <p className="mt-2 text-xs font-semibold text-accent">{t('jobBoard.concierge.matchScore')}: {proposal.matchScore}%</p>}</div><span className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-bold ${proposed ? 'bg-warning-subtle text-warning' : proposal.status === 'accepted' ? 'bg-success-subtle text-success' : 'bg-surface-raised text-muted'}`}>{t(`jobBoard.concierge.proposalStatus.${proposal.status}`)}</span></div>{proposal.matchReasons?.length ? <ul className="mt-3 space-y-1 text-xs leading-5 text-subtle">{proposal.matchReasons.slice(0, 3).map((reason) => <li key={reason} className="flex gap-2"><CheckCircle2 size={13} className="mt-0.5 shrink-0 text-success" aria-hidden="true" />{reason}</li>)}</ul> : null}{proposed && <div className="mt-4 flex flex-wrap items-center gap-2"><a href={proposal.jobUrl} target="_blank" rel="noreferrer" className="text-sm font-semibold text-accent hover:underline">{t('jobBoard.concierge.openJob')}</a><button type="button" disabled={disabled || !canAccept} onClick={() => onDecision(proposal, 'accept')} className="inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-accent px-3 py-2 text-xs font-bold text-on-accent disabled:cursor-not-allowed disabled:opacity-50">{busy === `accept:${proposal.proposalId}` && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}{t('jobBoard.concierge.accept')}</button><button type="button" disabled={disabled} onClick={() => onDecision(proposal, 'decline')} className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-edge px-3 py-2 text-xs font-semibold text-subtle hover:text-body disabled:opacity-50">{busy === `decline:${proposal.proposalId}` && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}{t('jobBoard.concierge.decline')}</button></div>}{proposed && !canAccept && <p className="mt-2 text-xs text-subtle">{t('jobBoard.concierge.acceptHint')}</p>}</article>;
}
