import React from 'react';
import { Asterisk, ClipboardCheck, ExternalLink, ShieldCheck } from 'lucide-react';
import type { Locale } from '@/services/i18n';

export interface ATSApplicationFormField {
  label: string;
  type: string;
  required: boolean;
  kind: 'question' | 'consent';
}

export interface ATSApplicationFormSnapshot {
  provider: 'ncoreplat';
  sourceUrl: string;
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

function isVerifiedSnapshot(value: ATSApplicationFormSnapshot | undefined): value is ATSApplicationFormSnapshot {
  if (!value || value.provider !== 'ncoreplat' || !Array.isArray(value.fields) || value.fields.length === 0) return false;
  if (!Number.isFinite(Date.parse(value.checkedAt))) return false;

  try {
    const source = new URL(value.sourceUrl);
    return source.protocol === 'https:'
      && source.hostname === 'app.ncoreplat.com'
      && /^\/jobposition\/[1-9]\d*\//.test(source.pathname);
  } catch {
    return false;
  }
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
            <span className="min-w-0 font-semibold text-heading">{field.label}</span>
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
