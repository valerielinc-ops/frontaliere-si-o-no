import React from 'react';
import { Asterisk, ClipboardCheck, ExternalLink, ShieldCheck } from 'lucide-react';
import type { Locale } from '@/services/i18n';

export interface ATSApplicationFormField {
  label: string;
  type: string;
  required: boolean;
  kind: 'question' | 'consent';
  section?: string;
  options?: string[];
}

export type ATSApplicationFormProvider =
  | 'ncoreplat'
  | 'greenhouse'
  | 'ashby'
  | 'workable'
  | 'lever'
  | 'dover'
  | 'recruitee'
  | 'teamtailor';

export interface ATSApplicationFormSnapshot {
  provider: ATSApplicationFormProvider;
  sourceUrl: string;
  jobUrl?: string;
  checkedAt: string;
  stage: string;
  fields: ATSApplicationFormField[];
}

export interface JobPreApplyChecklistProps {
  companyName: string;
  atsApplicationForm?: ATSApplicationFormSnapshot;
  locale: Locale;
  t: (key: string, params?: Record<string, string | number>) => string;
  className?: string;
}

const CHECKED_AT_DATE_LOCALES: Record<Locale, string> = {
  it: 'it-CH',
  en: 'en-GB',
  de: 'de-CH',
  fr: 'fr-CH',
};

function isCanonicalHttpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash) return null;
    return url.href === `https://${url.hostname.toLowerCase()}${url.pathname}` ? url : null;
  } catch {
    return null;
  }
}

function isVerifiedSource(provider: ATSApplicationFormProvider, source: URL, value: ATSApplicationFormSnapshot): boolean {
  const host = source.hostname.toLowerCase();
  const path = source.pathname;
  if (provider === 'ncoreplat') {
    return host === 'app.ncoreplat.com'
      && source.href === `https://app.ncoreplat.com${path}`
      && /^\/jobposition\/[1-9]\d*\/[^/?#]+(?:\/[^/?#]+)?\/?$/i.test(path);
  }
  if (provider === 'greenhouse') {
    return ['boards.greenhouse.io', 'job-boards.greenhouse.io', 'job-boards.eu.greenhouse.io'].includes(host)
      && /^\/[^/?#]+\/jobs\/[1-9]\d*\/?$/i.test(path);
  }
  if (provider === 'lever') {
    return ['jobs.lever.co', 'jobs.eu.lever.co'].includes(host)
      && /^\/[^/?#]+\/[^/?#]+\/apply\/?$/i.test(path);
  }
  if (provider === 'workable') {
    return host === 'apply.workable.com' && /^\/[^/?#]+\/j\/[^/?#]+(?:\/apply)?\/?$/i.test(path);
  }
  if (provider === 'ashby') {
    return host === 'jobs.ashbyhq.com' && /^\/[^/?#]+\/[^/?#]+(?:\/[^/?#]+)?\/?$/i.test(path);
  }
  if (provider === 'dover') {
    return ['app.dover.com', 'jobs.dover.com'].includes(host) && /^\/(?:apply|jobs)\/[^/?#]+(?:\/[^/?#]+)*\/?$/i.test(path);
  }
  if (provider === 'recruitee') {
    return host.endsWith('.recruitee.com') && /^\/o\/[^/?#]+\/?$/i.test(path);
  }
  if (provider === 'teamtailor') {
    const jobUrl = typeof value.jobUrl === 'string' ? isCanonicalHttpsUrl(value.jobUrl) : null;
    if (!jobUrl || jobUrl.origin !== source.origin) return false;
    const jobPath = jobUrl.pathname.replace(/\/$/, '');
    return /^\/jobs\/[^/?#]+\/?$/i.test(jobUrl.pathname)
      && path === `${jobPath}/applications/new`;
  }
  return false;
}

function isVerifiedSnapshot(value: ATSApplicationFormSnapshot | undefined): value is ATSApplicationFormSnapshot {
  const providers: ATSApplicationFormProvider[] = ['ncoreplat', 'greenhouse', 'ashby', 'workable', 'lever', 'dover', 'recruitee', 'teamtailor'];
  if (!value || !providers.includes(value.provider) || !Array.isArray(value.fields) || value.fields.length === 0) return false;
  if (typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt)) || typeof value.stage !== 'string') return false;
  if (value.fields.some((field) => !field || typeof field.label !== 'string' || !field.label.trim()
    || typeof field.type !== 'string' || typeof field.required !== 'boolean'
    || !['question', 'consent'].includes(field.kind)
    || (field.section !== undefined && typeof field.section !== 'string')
    || (field.options !== undefined && (!Array.isArray(field.options) || field.options.some((option) => typeof option !== 'string'))))) return false;
  const source = typeof value.sourceUrl === 'string' ? isCanonicalHttpsUrl(value.sourceUrl) : null;
  return Boolean(source && isVerifiedSource(value.provider, source, value));
}

function formatCheckedAt(value: string, locale: Locale): string {
  const date = new Date(value);
  return date.toLocaleDateString(CHECKED_AT_DATE_LOCALES[locale], {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Europe/Zurich',
  });
}

export const JobPreApplyChecklist: React.FC<JobPreApplyChecklistProps> = ({
  companyName,
  atsApplicationForm,
  locale,
  t,
  className = '',
}) => {
  if (!isVerifiedSnapshot(atsApplicationForm)) return null;

  return (
    <section
      data-testid="job-preapply-checklist"
      className={`rounded-2xl border border-edge bg-surface/90 p-4 sm:p-5 space-y-3.5 ${className}`}
      aria-label={t('jobBoard.atsChecklist.ariaLabel', { company: companyName })}
    >
      <div className="flex items-center justify-between border-b border-edge/60 pb-2.5">
        <h3 className="text-base font-semibold font-display text-heading flex items-center gap-2">
          <ClipboardCheck className="w-4 h-4 text-accent" />
          {t('jobBoard.atsChecklist.title', { company: companyName })}
        </h3>
        <span className="text-xs font-semibold text-success flex items-center gap-1">
          <ShieldCheck className="w-3.5 h-3.5" />
          {t('jobBoard.atsChecklist.sourceVerified')}
        </span>
      </div>

      <p className="text-sm text-subtle leading-relaxed">
        {atsApplicationForm.stage
          ? t('jobBoard.atsChecklist.fieldsIntroWithStage', { stage: atsApplicationForm.stage })
          : t('jobBoard.atsChecklist.fieldsIntro')}
      </p>

      <ul className="space-y-2 pt-1">
        {atsApplicationForm.fields.map((field, index) => (
          <li
            key={`${field.type}:${field.label}:${index}`}
            className="flex items-center justify-between gap-3 border-b border-edge/60 pb-2.5 text-sm last:border-b-0 last:pb-0"
          >
            <span className="min-w-0">
              <span className="block font-semibold text-heading">{field.label}</span>
              {field.section && <span className="block text-xs text-subtle">{field.section}</span>}
              {field.options && field.options.length > 0 && (
                <span className="block pt-0.5 text-xs text-subtle">{field.options.join(' · ')}</span>
              )}
            </span>
            <span className="flex items-center gap-1.5 shrink-0 text-xs text-subtle">
              {field.required ? (
                <><Asterisk className="w-3.5 h-3.5 text-accent" /> {t('jobBoard.atsChecklist.required')}</>
              ) : t('jobBoard.atsChecklist.optional')}
              {field.kind === 'consent' && <span className="text-muted">· {t('jobBoard.atsChecklist.consent')}</span>}
            </span>
          </li>
        ))}
      </ul>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-t border-edge/60 pt-3 text-xs text-subtle">
        <span>{t('jobBoard.atsChecklist.checkedAt', { date: formatCheckedAt(atsApplicationForm.checkedAt, locale) })}</span>
        <a
          href={atsApplicationForm.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 min-h-[44px] font-semibold text-accent hover:underline underline-offset-4"
        >
          {t('jobBoard.atsChecklist.openSource')}
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
      </div>
      <p className="text-xs leading-relaxed text-subtle">
        {t('jobBoard.atsChecklist.laterSteps')}
      </p>
    </section>
  );
};
