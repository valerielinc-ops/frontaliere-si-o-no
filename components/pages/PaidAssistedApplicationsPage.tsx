import React, { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useTranslation, type Locale } from '@/services/i18n';
import { REPLAY_PRIVATE_ATTRS, REPLAY_PRIVATE_CLASS } from '@/services/replayPrivacy';
import { buildPath } from '@/services/router';
import {
  fetchMyAssistedApplications,
  type CandidateAssistedApplication,
  type AssistedApplicationCandidateStatus,
} from '@/services/assistedApplicationCandidateStatus';

interface AuthenticatedUser {
  getIdToken: () => Promise<string>;
}

interface PaidAssistedApplicationsPageProps {
  user: AuthenticatedUser;
}

const STATUS_TRANSLATION_KEYS: Record<AssistedApplicationCandidateStatus, string> = {
  awaiting_materials: 'profile.paidApplications.status.awaitingMaterials',
  in_progress: 'profile.paidApplications.status.inProgress',
  needs_candidate: 'profile.paidApplications.status.needsCandidate',
  under_review: 'profile.paidApplications.status.underReview',
  submitted: 'profile.paidApplications.status.submitted',
  refunded: 'profile.paidApplications.status.refunded',
};

const STATUS_HELP_KEYS: Partial<Record<AssistedApplicationCandidateStatus, string>> = {
  awaiting_materials: 'profile.paidApplications.help.awaitingMaterials',
  needs_candidate: 'profile.paidApplications.help.needsCandidate',
  under_review: 'profile.paidApplications.help.underReview',
};

function statusStyle(status: AssistedApplicationCandidateStatus): string {
  if (status === 'submitted') return 'border-success/30 bg-success-subtle text-success';
  if (status === 'needs_candidate' || status === 'awaiting_materials') return 'border-warning/30 bg-warning-subtle text-warning';
  if (status === 'under_review') return 'border-info-border bg-info-subtle text-info';
  if (status === 'refunded') return 'border-edge bg-surface-alt text-subtle';
  return 'border-accent-border bg-accent-subtle text-accent';
}

function formatDate(value: string | null, locale: Locale): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const language = { it: 'it-IT', en: 'en-GB', de: 'de-DE', fr: 'fr-FR' }[locale];
  return date.toLocaleDateString(language, { day: 'numeric', month: 'short', year: 'numeric' });
}

function sourceTranslationKey(source: CandidateAssistedApplication['source']): string {
  return source === 'concierge'
    ? 'profile.paidApplications.source.concierge'
    : 'profile.paidApplications.source.single';
}

export default function PaidAssistedApplicationsPage({ user }: PaidAssistedApplicationsPageProps) {
  const { t, locale } = useTranslation();
  const [applications, setApplications] = useState<CandidateAssistedApplication[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    fetchMyAssistedApplications(user)
      .then((result) => {
        if (cancelled) return;
        setApplications(result);
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => { cancelled = true; };
  }, [user, reloadKey]);

  const profilePath = buildPath({ activeTab: 'profile' }, locale);
  const jobBoardPath = buildPath({ activeTab: 'job-board' }, locale);

  return (
    <section
      className={`${REPLAY_PRIVATE_CLASS} mx-auto w-full max-w-5xl px-4 py-6 sm:px-6`}
      {...REPLAY_PRIVATE_ATTRS}
      aria-labelledby="paid-applications-title"
    >
      <a
        href={profilePath}
        onClick={(event) => {
          // Clear profile_view through a full route load because the SPA router
          // does not observe query-only changes on the active profile route.
          event.preventDefault();
          window.location.assign(event.currentTarget.href);
        }}
        className="inline-flex min-h-11 items-center gap-2 rounded-stripe px-2 text-sm font-medium text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
      >
        <ArrowLeft size={16} aria-hidden="true" />
        {t('profile.paidApplications.back')}
      </a>

      <header className="mt-4 max-w-3xl">
        <h1 id="paid-applications-title" className="text-2xl font-medium text-strong sm:text-3xl">
          {t('profile.paidApplications.title')}
        </h1>
        <p className="mt-2 text-base leading-7 text-body">
          {t('profile.paidApplications.subtitle')}
        </p>
      </header>

      {state === 'loading' && (
        <div className="mt-6 border-y border-edge" aria-busy="true">
          <span role="status" className="sr-only">{t('profile.paidApplications.loading')}</span>
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex min-h-24 items-center justify-between gap-4 border-b border-edge px-1 py-5 last:border-b-0" aria-hidden="true">
              <div className="min-w-0 flex-1 space-y-2">
                <div className="h-4 w-2/3 rounded bg-surface-raised" />
                <div className="h-3 w-1/3 rounded bg-surface-raised" />
              </div>
              <div className="h-7 w-28 rounded-full bg-surface-raised" />
            </div>
          ))}
        </div>
      )}

      {state === 'error' && (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-stripe border border-danger/30 bg-danger-subtle p-4" role="alert">
          <p className="text-sm text-danger">{t('profile.paidApplications.error')}</p>
          <button
            type="button"
            onClick={() => setReloadKey((key) => key + 1)}
            className="min-h-11 rounded-stripe px-4 text-sm font-semibold text-danger underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
          >
            {t('profile.paidApplications.retry')}
          </button>
        </div>
      )}

      {state === 'ready' && applications.length === 0 && (
        <div className="mt-6 rounded-stripe border border-edge bg-surface-alt px-5 py-8 sm:px-7">
          <h2 className="text-lg font-semibold text-strong">{t('profile.paidApplications.emptyTitle')}</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-body">{t('profile.paidApplications.emptyBody')}</p>
        </div>
      )}

      {state === 'ready' && applications.length > 0 && (
        <ul className="mt-6 divide-y divide-edge border-y border-edge" aria-label={t('profile.paidApplications.title')}>
          {applications.map((application) => {
            const updatedDate = formatDate(application.updatedAt, locale);
            const helpKey = STATUS_HELP_KEYS[application.status];
            const uploadPath = `${jobBoardPath}?assisted_application_order_id=${encodeURIComponent(application.orderId)}`;
            return (
              <li key={application.orderId} className="grid gap-4 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-semibold text-strong">
                    {application.jobTitle || t('profile.paidApplications.untitled')}
                  </h2>
                  <p className="mt-1 truncate text-sm text-body">
                    {application.companyName || t('profile.paidApplications.companyUnavailable')}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted">
                    <span>{t(sourceTranslationKey(application.source))}</span>
                    {updatedDate && <span>{t('profile.paidApplications.updatedAt')} {updatedDate}</span>}
                  </div>
                  {helpKey && <p className="mt-2 text-sm leading-6 text-subtle">{t(helpKey)}</p>}
                </div>
                <div className="flex flex-col items-start gap-2 sm:items-end">
                  <span className={`inline-flex min-h-7 items-center rounded-full border px-3 py-1 text-sm font-medium ${statusStyle(application.status)}`}>
                    {t(STATUS_TRANSLATION_KEYS[application.status])}
                  </span>
                  {application.requiresCvUpload && (
                    <a
                      href={uploadPath}
                      className="inline-flex min-h-11 items-center gap-2 rounded-stripe px-1 text-sm font-semibold text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
                    >
                      {t('profile.paidApplications.upload')}
                      <ArrowRight size={15} aria-hidden="true" />
                    </a>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
