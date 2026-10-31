import { AssistedApplicationEmployerResponse } from '@/components/community/AssistedApplicationEmployerResponse';
import React, { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, CalendarDays, MapPin } from 'lucide-react';
import { useTranslation, type Locale } from '@/services/i18n';
import { REPLAY_PRIVATE_ATTRS, REPLAY_PRIVATE_CLASS } from '@/services/replayPrivacy';
import { buildPath } from '@/services/router';
import { normalizeExternalJobDetailUrl } from '@/services/jobApplicationDestination';
import { cdnImageUrl } from '@/services/cdnImageBase';
import { resolveCompanyLogoUrl } from '@/services/jobDataNormalization';
import { generateInitialsLogo } from '@/services/logoService';
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

const ACTION_REQUIRED_STATUSES = new Set<AssistedApplicationCandidateStatus>([
  'awaiting_materials',
  'needs_candidate',
]);

function statusStyle(status: AssistedApplicationCandidateStatus): string {
  if (status === 'submitted') return 'border-success/30 bg-success-subtle text-success-strong-hover dark:text-success';
  if (status === 'needs_candidate' || status === 'awaiting_materials') return 'border-warning/30 bg-warning-subtle text-warning-strong-hover dark:text-warning';
  if (status === 'under_review') return 'border-info-border bg-info-subtle text-info-strong-hover dark:text-info';
  if (status === 'refunded') return 'border-edge bg-surface-alt text-subtle';
  return 'border-accent-border bg-accent-subtle text-accent';
}

function nextStepStyle(status: AssistedApplicationCandidateStatus): string {
  if (status === 'needs_candidate' || status === 'awaiting_materials') {
    return 'bg-warning-subtle text-warning-strong-hover dark:text-warning';
  }
  return 'bg-info-subtle text-info-strong-hover dark:text-info';
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

function prioritizeApplications(applications: CandidateAssistedApplication[]): CandidateAssistedApplication[] {
  return [...applications].sort((left, right) => {
    const leftNeedsAction = ACTION_REQUIRED_STATUSES.has(left.status) ? 1 : 0;
    const rightNeedsAction = ACTION_REQUIRED_STATUSES.has(right.status) ? 1 : 0;
    if (leftNeedsAction !== rightNeedsAction) return rightNeedsAction - leftNeedsAction;

    const leftUpdated = left.updatedAt ? Date.parse(left.updatedAt) : 0;
    const rightUpdated = right.updatedAt ? Date.parse(right.updatedAt) : 0;
    return rightUpdated - leftUpdated;
  });
}

function CompanyLogo({ companyName, companyKey }: { companyName: string; companyKey?: string | null }): React.ReactElement {
  const fallback = generateInitialsLogo(companyName);
  const resolved = cdnImageUrl(resolveCompanyLogoUrl({ company: companyName, companyKey })) || fallback;
  const [src, setSrc] = useState(resolved);

  useEffect(() => setSrc(resolved), [resolved]);

  return (
    <span className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-stripe border border-edge bg-surface">
      <img
        src={src}
        alt=""
        aria-hidden="true"
        width={56}
        height={56}
        loading="lazy"
        decoding="async"
        className="h-full w-full object-contain p-1.5"
        onError={() => setSrc(fallback)}
      />
    </span>
  );
}

function ApplicationDossier({
  application,
  jobBoardPath,
}: {
  application: CandidateAssistedApplication;
  jobBoardPath: string;
}): React.ReactElement {
  const { t, locale } = useTranslation();
  const companyName = application.companyName || t('profile.paidApplications.companyUnavailable');
  const jobTitle = application.jobTitle || t('profile.paidApplications.untitled');
  const updatedDate = formatDate(application.updatedAt, locale);
  const helpKey = STATUS_HELP_KEYS[application.status];
  const uploadPath = `${jobBoardPath}?assisted_application_order_id=${encodeURIComponent(application.orderId)}`;
  const applicationPath = application.requiresCvUpload || application.status === 'awaiting_materials'
    ? uploadPath
    : application.applicationUrl || uploadPath;
  const applicationActionKey = ACTION_REQUIRED_STATUSES.has(application.status)
    ? 'profile.paidApplications.openNextStep'
    : 'profile.paidApplications.openApplication';
  const applicationAction = (
    <a
      href={applicationPath}
      className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-stripe bg-accent px-4 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
      aria-label={`${t(applicationActionKey)}: ${jobTitle}, ${companyName}`}
    >
      {t(applicationActionKey)}
      <ArrowRight size={16} aria-hidden="true" />
    </a>
  );

  return (
    <li>
      <article className="relative overflow-hidden rounded-stripe border border-edge bg-surface transition-colors duration-200 hover:border-accent-border">
        <span className="absolute inset-y-5 left-0 w-1 rounded-r bg-accent" aria-hidden="true" />
        <div className="p-4 pl-5 sm:p-5 sm:pl-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-start gap-3.5">
              <CompanyLogo companyName={companyName} companyKey={application.companyKey} />
              <div className="min-w-0 pt-0.5">
                <h3 className="break-words font-display text-lg font-medium leading-snug text-strong sm:text-xl">
                  {jobTitle}
                </h3>
                <p className="mt-1 break-words text-sm font-medium text-body">{companyName}</p>
                {application.location && (
                  <p className="mt-2 inline-flex items-center gap-1.5 text-sm text-subtle">
                    <MapPin size={15} aria-hidden="true" />
                    <span>{application.location}</span>
                  </p>
                )}
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2 sm:flex-col sm:items-end">
              <span className={`inline-flex min-h-7 items-center rounded-full border px-3 py-1 text-sm font-semibold ${statusStyle(application.status)}`}>
                {t(STATUS_TRANSLATION_KEYS[application.status])}
              </span>
              {updatedDate && (
                <time
                  dateTime={application.updatedAt ?? undefined}
                  className="inline-flex items-center gap-1.5 text-xs tabular-nums text-muted"
                >
                  <CalendarDays size={14} aria-hidden="true" />
                  {t('profile.paidApplications.updatedAt')} {updatedDate}
                </time>
              )}
            </div>
          </div>

          <AssistedApplicationEmployerResponse response={application.employerResponse} compact />

          {helpKey && (
            <div className={`-mx-4 mt-5 flex flex-col gap-3 px-4 py-4 sm:-mx-5 sm:flex-row sm:items-center sm:justify-between sm:px-5 ${nextStepStyle(application.status)}`}>
              <div className="min-w-0">
                <h4 className="text-sm font-medium">{t('profile.paidApplications.nextStep')}</h4>
                <p className="mt-1 text-sm leading-6">{t(helpKey)}</p>
              </div>
              {application.requiresCvUpload ? (
                <a
                  href={applicationPath}
                  className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-stripe bg-accent px-4 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
                >
                  {t('profile.paidApplications.upload')}
                  <ArrowRight size={16} aria-hidden="true" />
                </a>
              ) : applicationAction}
            </div>
          )}

          <footer className="mt-4 flex flex-col gap-2 border-t border-edge pt-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
              <span>{t(sourceTranslationKey(application.source))}</span>
              {!helpKey && applicationAction}
            </div>
            {application.jobUrl && (
              <a
                href={normalizeExternalJobDetailUrl(application.jobUrl)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center gap-1.5 self-start text-sm font-semibold text-link underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 sm:self-auto"
                aria-label={`${t('profile.paidApplications.openListing')}: ${jobTitle}, ${companyName}`}
              >
                {t('profile.paidApplications.openListing')}
                <ArrowUpRight size={16} aria-hidden="true" />
              </a>
            )}
          </footer>
        </div>
      </article>
    </li>
  );
}

function EmptyApplicationsIllustration(): React.ReactElement {
  return (
    <svg viewBox="0 0 240 180" className="h-auto w-full max-w-60" aria-hidden="true" focusable="false">
      <path d="M41 37a9 9 0 0 1 9-9h85l26 26v82a9 9 0 0 1-9 9H50a9 9 0 0 1-9-9V37Z" className="fill-surface stroke-accent-border" strokeWidth="2" />
      <path d="M135 28v21a6 6 0 0 0 6 6h20" className="fill-accent-subtle stroke-accent-border" strokeWidth="2" />
      <rect x="61" y="70" width="70" height="9" rx="4.5" className="fill-accent" opacity=".82" />
      <rect x="61" y="91" width="94" height="6" rx="3" className="fill-accent-border" />
      <rect x="61" y="106" width="79" height="6" rx="3" className="fill-accent-border" />
      <rect x="61" y="121" width="47" height="6" rx="3" className="fill-warning" />
      <circle cx="177" cy="121" r="32" className="fill-accent-subtle" />
      <rect x="151" y="97" width="52" height="52" rx="12" className="fill-accent" />
      <path d="m164 123 8 8 18-19" fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="4" />
    </svg>
  );
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
  const prioritizedApplications = prioritizeApplications(applications);
  const attentionApplications = prioritizedApplications.filter((application) => ACTION_REQUIRED_STATUSES.has(application.status));
  const otherApplications = prioritizedApplications.filter((application) => !ACTION_REQUIRED_STATUSES.has(application.status));

  const renderApplications = (items: CandidateAssistedApplication[], listLabel: string, id?: string) => (
    <ul className="space-y-3" aria-label={id ? undefined : listLabel} aria-labelledby={id}>
      {items.map((application) => (
        <ApplicationDossier key={application.orderId} application={application} jobBoardPath={jobBoardPath} />
      ))}
    </ul>
  );

  return (
    <section
      className={`${REPLAY_PRIVATE_CLASS} mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-9`}
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

      <header className="mt-5 max-w-3xl">
        <h1 id="paid-applications-title" className="font-display text-3xl font-medium leading-tight text-strong sm:text-4xl">
          {t('profile.paidApplications.title')}
        </h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-body">
          {t('profile.paidApplications.subtitle')}
        </p>
      </header>

      {state === 'loading' && (
        <div className="mt-7 space-y-3" aria-busy="true">
          <span role="status" className="sr-only">{t('profile.paidApplications.loading')}</span>
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex min-h-36 items-start gap-3.5 rounded-stripe border border-edge p-4 sm:p-5" aria-hidden="true">
              <div className="h-14 w-14 shrink-0 rounded-stripe bg-surface-raised" />
              <div className="min-w-0 flex-1 space-y-3 pt-1">
                <div className="h-5 w-3/4 rounded bg-surface-raised" />
                <div className="h-4 w-2/5 rounded bg-surface-raised" />
                <div className="h-7 w-32 rounded-full bg-surface-raised" />
              </div>
            </div>
          ))}
        </div>
      )}

      {state === 'error' && (
        <div className="mt-7 flex flex-wrap items-center justify-between gap-4 rounded-stripe border border-danger/30 bg-danger-subtle p-4" role="alert">
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
        <div className="mt-8 grid overflow-hidden rounded-stripe border border-accent-border bg-accent-subtle md:grid-cols-[minmax(0,1fr)_260px]">
          <div className="flex flex-col items-start justify-center p-6 sm:p-8">
            <h2 className="font-display text-2xl font-medium leading-tight text-strong sm:text-3xl">
              {t('profile.paidApplications.emptyTitle')}
            </h2>
            <p className="mt-3 max-w-xl text-sm leading-6 text-body sm:text-base sm:leading-7">
              {t('profile.paidApplications.emptyBody')}
            </p>
            <a
              href={jobBoardPath}
              className="mt-6 inline-flex min-h-12 items-center justify-center gap-2 rounded-stripe bg-accent px-5 text-sm font-semibold text-white transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
            >
              {t('profile.paidApplications.exploreJobs')}
              <ArrowRight size={17} aria-hidden="true" />
            </a>
          </div>
          <div className="flex min-h-48 items-center justify-center bg-accent-subtle px-6 py-5 md:min-h-64">
            <EmptyApplicationsIllustration />
          </div>
        </div>
      )}

      {state === 'ready' && applications.length > 0 && (
        <div className="mt-8 space-y-8">
          {attentionApplications.length > 0 && (
            <section aria-labelledby="paid-applications-attention-title">
              <h2 id="paid-applications-attention-title" className="mb-3 font-display text-xl font-medium text-strong sm:text-2xl">
                {t('profile.paidApplications.attentionTitle')}
              </h2>
              {renderApplications(attentionApplications, t('profile.paidApplications.attentionTitle'), 'paid-applications-attention-title')}
            </section>
          )}
          {otherApplications.length > 0 && (
            <section
              aria-labelledby={attentionApplications.length > 0 ? 'paid-applications-other-title' : 'paid-applications-all-title'}
            >
              {attentionApplications.length > 0 && (
                <h2 id="paid-applications-other-title" className="mb-3 font-display text-xl font-medium text-strong sm:text-2xl">
                  {t('profile.paidApplications.otherTitle')}
                </h2>
              )}
              {attentionApplications.length === 0 && (
                <h2 id="paid-applications-all-title" className="mb-3 font-display text-xl font-medium text-strong sm:text-2xl">
                  {t('profile.paidApplications.allTitle')}
                </h2>
              )}
              {renderApplications(
                otherApplications,
                t(attentionApplications.length > 0 ? 'profile.paidApplications.otherTitle' : 'profile.paidApplications.allTitle'),
                attentionApplications.length > 0 ? 'paid-applications-other-title' : 'paid-applications-all-title',
              )}
            </section>
          )}
        </div>
      )}
    </section>
  );
}
