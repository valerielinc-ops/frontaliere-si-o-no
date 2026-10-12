import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { BriefcaseBusiness, CheckCircle2, Clock3, FileText, Loader2, ShieldCheck, UploadCloud, XCircle } from 'lucide-react';
import { useLocale, useTranslation } from '@/services/i18n';
import { REPLAY_PRIVATE_ATTRS, REPLAY_PRIVATE_CLASS } from '@/services/replayPrivacy';
import { ensureAssistedApplicationAuth } from '@/services/assistedApplicationCheckout';
import { createApplicationConciergeCheckout } from '@/services/applicationConciergeCheckout';
import {
  acceptApplicationConciergeProposal,
  declineApplicationConciergeProposal,
  fetchApplicationConciergeService,
  saveApplicationConciergeProfile,
  type ApplicationConciergeProposal,
  type ApplicationConciergeService,
} from '@/services/applicationConciergeService';

const MAX_CV_BYTES = 5 * 1024 * 1024;
const POLL_MS = 3500;

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
    if (!serviceId || !service || !isPending(service)) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(async function poll() {
      if (cancelled) return;
      try {
        const loaded = await loadService();
        if (!cancelled && loaded && isPending(loaded)) window.setTimeout(poll, POLL_MS);
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

  const saveProfile = async (cvStorageKey?: string) => {
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
      consent,
      ...(cvStorageKey ? { cvStorageKey } : {}),
    });
    setService(updated);
    setConsent(updated.hasConsent);
    return updated;
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
      await saveProfile(fullPath);
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
      <main className={`${REPLAY_PRIVATE_CLASS} mx-auto max-w-3xl px-4 py-8 sm:py-12`} {...REPLAY_PRIVATE_ATTRS}>
        <section className="rounded-3xl border border-edge bg-surface p-6 shadow-sm sm:p-9">
          <div className="flex items-start gap-3"><div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent-subtle text-accent"><BriefcaseBusiness aria-hidden="true" /></div><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">{t('jobBoard.concierge.eyebrow')}</p><h1 className="mt-1 text-3xl font-bold font-display text-heading">{t('jobBoard.concierge.title')}</h1></div></div>
          <p className="mt-5 max-w-2xl text-base leading-7 text-body">{t('jobBoard.concierge.description')}</p>
          <div className="mt-6 grid gap-3 sm:grid-cols-3"><Info icon={<Clock3 size={17} />} label={t('jobBoard.concierge.duration')} /><Info icon={<BriefcaseBusiness size={17} />} label={t('jobBoard.concierge.quota')} /><Info icon={<ShieldCheck size={17} />} label={t('jobBoard.concierge.noRenewal')} /></div>
          <p className="mt-5 rounded-2xl border border-info-border bg-info-subtle/60 p-4 text-sm leading-6 text-body">{t('jobBoard.concierge.disclosure')}</p>
          <button type="button" onClick={() => { void startCheckout(); }} disabled={busy === 'checkout'} className="mt-6 inline-flex min-h-[46px] items-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-bold text-on-accent hover:bg-accent-strong disabled:cursor-wait disabled:opacity-60">{busy === 'checkout' && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}{t('jobBoard.concierge.start')} · {formattedPrice}</button>
          {displayError && <p role="alert" className="mt-4 text-sm text-danger">{displayError}</p>}
        </section>
      </main>
    );
  }

  if (loading || authLoading) return <PortalShell><div className="flex items-center gap-2 text-sm text-subtle" role="status"><Loader2 size={17} className="animate-spin" aria-hidden="true" />{t('jobBoard.concierge.loading')}</div></PortalShell>;
  if (!service) return <PortalShell><p role="alert" className="text-sm text-danger">{displayError || t('jobBoard.concierge.errors.service_not_found')}</p></PortalShell>;

  const pending = isPending(service);
  const expired = service.serviceStatus === 'expired' || (service.expiresAt ? new Date(service.expiresAt).getTime() <= Date.now() : false);

  return (
    <PortalShell>
      <div className="space-y-5">
        <header><p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">{t('jobBoard.concierge.eyebrow')}</p><h1 className="mt-1 text-2xl font-bold font-display text-heading">{t('jobBoard.concierge.portalTitle')}</h1><p className="mt-2 text-sm text-subtle">{t('jobBoard.concierge.portalIntro')}</p></header>
        {pending && <Notice icon={<Clock3 size={17} />} text={t('jobBoard.concierge.paymentPending')} />}
        {service.paymentStatus === 'failed' && <Notice icon={<XCircle size={17} />} tone="danger" text={t('jobBoard.concierge.paymentFailed')} />}
        {expired && <Notice icon={<Clock3 size={17} />} tone="warning" text={t('jobBoard.concierge.expired')} />}
        {message && <Notice icon={<CheckCircle2 size={17} />} tone="success" text={message} />}
        {displayError && <p role="alert" className="rounded-xl border border-danger-border bg-danger-subtle p-3 text-sm text-danger">{displayError}</p>}
        {!pending && service.paymentStatus === 'paid' && (
          <>
            <section className="rounded-2xl border border-edge bg-surface p-5">
              <div className="flex items-start justify-between gap-4"><div><h2 className="text-lg font-bold font-display text-heading">{t('jobBoard.concierge.profileTitle')}</h2><p className="mt-1 text-sm text-subtle">{t('jobBoard.concierge.profileIntro')}</p></div><span className="shrink-0 rounded-full bg-accent-subtle px-3 py-1 text-xs font-bold text-accent">{service.remainingPositions}/{service.maxPositions}</span></div>
              <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); void handleSaveProfile(); }}>
                <label className="text-sm font-medium text-body">{t('jobBoard.concierge.name')}<input value={name} onChange={(event) => setName(event.target.value)} className="mt-1 w-full rounded-lg border border-edge bg-surface px-3 py-2.5 text-sm" autoComplete="name" /></label>
                <label className="text-sm font-medium text-body">{t('jobBoard.concierge.email')}<input value={email} onChange={(event) => setEmail(event.target.value)} className="mt-1 w-full rounded-lg border border-edge bg-surface px-3 py-2.5 text-sm" type="email" autoComplete="email" /></label>
                <label className="text-sm font-medium text-body sm:col-span-2">{t('jobBoard.concierge.phone')}<input value={phone} onChange={(event) => setPhone(event.target.value)} className="mt-1 w-full rounded-lg border border-edge bg-surface px-3 py-2.5 text-sm" autoComplete="tel" /></label>
                <label className="flex items-start gap-2 text-sm leading-6 text-body sm:col-span-2"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} className="mt-1 h-4 w-4 accent-accent" /><span>{t('jobBoard.concierge.consent')}</span></label>
                <button type="submit" disabled={busy !== null || expired} className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-edge px-4 py-2 text-sm font-semibold text-body hover:border-accent disabled:opacity-60 sm:col-span-2 sm:justify-self-start">{busy === 'profile' && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}{t('jobBoard.concierge.saveProfile')}</button>
              </form>
              <div className="mt-5 rounded-xl border border-dashed border-edge p-4"><div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm font-semibold text-body">{service.hasCv ? <span className="inline-flex items-center gap-2 text-success"><CheckCircle2 size={16} aria-hidden="true" />{t('jobBoard.concierge.cvReady')}</span> : t('jobBoard.concierge.cvTitle')}</p><label className={`inline-flex min-h-[42px] cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold ${service.hasConsent ? 'bg-accent text-on-accent' : 'bg-surface-raised text-muted'}`}><UploadCloud size={16} aria-hidden="true" />{busy === 'cv' ? t('jobBoard.concierge.uploading') : t('jobBoard.concierge.upload')}<input type="file" accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="sr-only" disabled={!service.hasConsent || busy !== null || expired} onChange={(event) => { void handleCvChange(event.target.files?.[0]); event.currentTarget.value = ''; }} /></label></div>{!service.hasConsent && <p className="mt-2 text-xs text-subtle">{t('jobBoard.concierge.saveConsentFirst')}</p>}</div>
            </section>
            <section className="rounded-2xl border border-edge bg-surface p-5"><div className="flex items-center justify-between gap-3"><h2 className="text-lg font-bold font-display text-heading">{t('jobBoard.concierge.proposalsTitle')}</h2><span className="text-xs font-semibold text-muted">{service.acceptedPositionsCount}/{service.maxPositions}</span></div><p className="mt-1 text-sm text-subtle">{t('jobBoard.concierge.proposalsIntro')}</p><div className="mt-4 space-y-3">{service.proposals.length === 0 && <p className="rounded-xl bg-surface-raised p-4 text-sm text-subtle">{t('jobBoard.concierge.noProposals')}</p>}{service.proposals.map((proposal) => <ProposalCard key={proposal.proposalId} proposal={proposal} disabled={expired || busy !== null} canAccept={service.hasCv && service.hasConsent} busy={busy} onDecision={decide} t={t} />)}</div></section>
            <p className="text-xs leading-5 text-muted">{t('jobBoard.concierge.noGuarantee')}</p>
          </>
        )}
      </div>
    </PortalShell>
  );
}

function PortalShell({ children }: { children: ReactNode }) {
  return <main className={`${REPLAY_PRIVATE_CLASS} mx-auto max-w-3xl px-4 py-8 sm:py-12`} {...REPLAY_PRIVATE_ATTRS}><section className="rounded-3xl border border-edge bg-surface p-5 shadow-sm sm:p-8">{children}</section></main>;
}

function Info({ icon, label }: { icon: ReactNode; label: string }) {
  return <div className="flex items-center gap-2 rounded-xl bg-surface-raised p-3 text-sm font-semibold text-body">{icon}<span>{label}</span></div>;
}

function Notice({ icon, text, tone = 'info' }: { icon: ReactNode; text: string; tone?: 'info' | 'danger' | 'warning' | 'success' }) {
  const styles = { info: 'border-info-border bg-info-subtle text-info', danger: 'border-danger-border bg-danger-subtle text-danger', warning: 'border-warning-border bg-warning-subtle text-warning', success: 'border-success-border bg-success-subtle text-success' };
  return <div role="status" className={`flex items-start gap-2 rounded-xl border p-3 text-sm ${styles[tone]}`}>{icon}<span>{text}</span></div>;
}

function ProposalCard({ proposal, disabled, canAccept, busy, onDecision, t }: { proposal: ApplicationConciergeProposal; disabled: boolean; canAccept: boolean; busy: string | null; onDecision: (proposal: ApplicationConciergeProposal, decision: 'accept' | 'decline') => void; t: (key: string, params?: Record<string, string>) => string }) {
  const proposed = proposal.status === 'proposed';
  return <article className="rounded-xl border border-edge p-4"><div className="flex items-start gap-3"><div className="mt-0.5 rounded-lg bg-accent-subtle p-2 text-accent"><FileText size={17} aria-hidden="true" /></div><div className="min-w-0 flex-1"><h3 className="font-bold text-heading">{proposal.jobTitle}</h3><p className="text-sm text-subtle">{proposal.companyName}{proposal.location ? ` · ${proposal.location}` : ''}</p></div><span className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-bold ${proposed ? 'bg-warning-subtle text-warning' : proposal.status === 'accepted' ? 'bg-success-subtle text-success' : 'bg-surface-raised text-muted'}`}>{t(`jobBoard.concierge.proposalStatus.${proposal.status}`)}</span></div>{proposed && <div className="mt-3 flex flex-wrap items-center gap-2"><a href={proposal.jobUrl} target="_blank" rel="noreferrer" className="text-sm font-semibold text-accent hover:underline">{t('jobBoard.concierge.openJob')}</a><button type="button" disabled={disabled || !canAccept} onClick={() => onDecision(proposal, 'accept')} className="inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-accent px-3 py-2 text-xs font-bold text-on-accent disabled:cursor-not-allowed disabled:opacity-50">{busy === `accept:${proposal.proposalId}` && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}{t('jobBoard.concierge.accept')}</button><button type="button" disabled={disabled} onClick={() => onDecision(proposal, 'decline')} className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-edge px-3 py-2 text-xs font-semibold text-subtle hover:text-body disabled:opacity-50">{busy === `decline:${proposal.proposalId}` && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}{t('jobBoard.concierge.decline')}</button></div>}{proposed && !canAccept && <p className="mt-2 text-xs text-subtle">{t('jobBoard.concierge.acceptHint')}</p>}</article>;
}
