import { useTranslation } from '@/services/i18n';
// permitLabels.js, not permitStatus.js: the browser bundle must not carry its lookbehind regexes.
import { PERMIT_STATUSES, permitOptions } from '@/functions/src/lib/permitLabels.js';

/**
 * Asked with the CV (owner decision 2026-11-09): the work permit, the passport
 * and the nationality are the candidate's to say, so they are asked once here
 * and never again on the application forms (functions/src/assistedApplicationPlatformDefaults.js).
 */
export interface CandidateFacts {
  workPermit?: string;
  passport?: string;
  nationality?: string;
}

export const CANDIDATE_PASSPORTS = ['swiss', 'eu_efta', 'other'] as const;

export function candidateFactsComplete(facts: CandidateFacts) {
  return PERMIT_STATUSES.includes(String(facts.workPermit || ''))
    && (CANDIDATE_PASSPORTS as readonly string[]).includes(String(facts.passport || ''))
    && String(facts.nationality || '').trim().length > 0;
}

export function cleanCandidateFacts(facts: CandidateFacts): CandidateFacts {
  return {
    workPermit: String(facts.workPermit || ''),
    passport: String(facts.passport || ''),
    nationality: String(facts.nationality || '').trim().slice(0, 80),
  };
}

const PASSPORT_LABELS = {
  swiss: 'jobBoard.assisted.passport.swiss',
  eu_efta: 'jobBoard.assisted.passport.eu_efta',
  other: 'jobBoard.assisted.passport.other',
} as const;

export function AssistedApplicationCandidateFacts({ value, onChange, locale, disabled = false }: {
  value: CandidateFacts;
  onChange: (value: CandidateFacts) => void;
  locale: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const fieldClass = 'mt-1 w-full rounded-lg border border-edge bg-surface px-3 py-2.5 text-sm text-heading';
  const permitLabels = permitOptions(locale);
  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <legend className="text-sm font-medium text-body">{t('jobBoard.assisted.candidateFactsTitle')}</legend>
      <p className="text-xs text-subtle">{t('jobBoard.assisted.candidateFactsHint')}</p>
      <label className="block text-sm font-medium text-body">
        {t('jobBoard.assisted.workPermit')}
        <select value={value.workPermit || ''} onChange={(event) => onChange({ ...value, workPermit: event.target.value })} className={fieldClass} required>
          <option value="">—</option>
          {PERMIT_STATUSES.map((status: string, index: number) => <option key={status} value={status}>{permitLabels[index]}</option>)}
        </select>
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-medium text-body">
          {t('jobBoard.assisted.passport')}
          <select value={value.passport || ''} onChange={(event) => onChange({ ...value, passport: event.target.value })} className={fieldClass} required>
            <option value="">—</option>
            {CANDIDATE_PASSPORTS.map((passport) => <option key={passport} value={passport}>{t(PASSPORT_LABELS[passport])}</option>)}
          </select>
        </label>
        <label className="text-sm font-medium text-body">
          {t('jobBoard.assisted.nationality')}
          <input value={value.nationality || ''} onChange={(event) => onChange({ ...value, nationality: event.target.value })} placeholder={t('jobBoard.assisted.nationalityPlaceholder')} className={fieldClass} autoComplete="off" maxLength={80} required />
        </label>
      </div>
    </fieldset>
  );
}
