/**
 * Progressive profile/jobalert enrichment — single-question chip prompt.
 *
 * Non-blocking toast, same visual language as `JobDetailAlertPrompt`. Asks
 * exactly ONE field (picked upstream by `profileEnrichmentGating.pickNextQuestion`)
 * and writes the answer straight to Firestore — `savePartialProfile` for
 * profile fields (shared `newsletter_subscribers/{email}` doc), `updateAlert`
 * for alert fields. The caller owns gating state (`recordAnswer`/`recordSkip`)
 * via `onAnswered`/`onSkipped`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sparkles, X, Loader2 } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import type { Locale } from '@/services/i18n';
import BottomPromptShell from '@/components/shared/BottomPromptShell';
import { POPUP_PRIORITY } from '@/services/popupQueue';
import type { EnrichmentFieldKey } from '@/services/profileEnrichmentGating';
import { savePartialProfile } from '@/services/profileFirestore';
import { MUNICIPALITIES, findMunicipality } from '@/data/municipalities';
import { provinceToCantons } from '@/services/provinceCantonAffinity';
import { getCantonLabel, type CantonLocale } from '@/services/cantonList';
import { SECTORS } from './jobAlertConstants';

export interface ProfileEnrichmentPromptProps {
  field: EnrichmentFieldKey;
  email: string;
  locale: Locale;
  /** Required for alert-scoped fields (`cantonFilter`, `sectors`) — ignored otherwise. */
  alertId?: string | null;
  /** Current profile municipality — used to derive `cantonFilter` suggestion chips. */
  municipality?: string | null;
  onAnswered: () => void;
  onSkipped: () => void;
  onClose: () => void;
}

const PROVINCE_QUICK_PICKS: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'CO', label: 'Como' },
  { code: 'VA', label: 'Varese' },
  { code: 'VB', label: 'V.C.Ossola' },
  { code: 'SO', label: 'Sondrio' },
];

const GROSS_SALARY_BANDS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '35000', label: '< 40k' },
  { value: '50000', label: '40-60k' },
  { value: '70000', label: '60-80k' },
  { value: '90000', label: '80-100k' },
  { value: '120000', label: '> 100k' },
];

const TITLE_ID = 'profile-enrichment-prompt-title';

const chipClass = (active: boolean): string =>
  `px-3 py-1.5 min-h-[36px] text-xs rounded-full border transition-colors ${
    active
      ? 'bg-accent-strong text-on-accent border-accent'
      : 'bg-surface text-subtle border-edge hover:border-accent-border'
  }`;

export default function ProfileEnrichmentPrompt({
  field,
  email,
  locale,
  alertId = null,
  municipality = null,
  onAnswered,
  onSkipped,
  onClose,
}: ProfileEnrichmentPromptProps) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [province, setProvince] = useState<string | null>(null);
  const [workPositionInput, setWorkPositionInput] = useState('');

  const typedLocale = (locale as CantonLocale) || 'it';

  const suggestedCantons = useMemo(() => {
    if (field !== 'cantonFilter') return [];
    return provinceToCantons(findMunicipality(municipality || '')?.province);
  }, [field, municipality]);

  const provinceMunicipalities = useMemo(() => {
    if (!province) return [];
    return MUNICIPALITIES.filter((m) => m.province === province)
      .sort((a, b) => b.population - a.population)
      .slice(0, 5);
  }, [province]);

  // `cantonFilter` with no derivable suggestion has nothing useful to offer —
  // skip silently rather than show an empty picker.
  useEffect(() => {
    if (field === 'cantonFilter' && suggestedCantons.length === 0) {
      onSkipped();
      onClose();
    }
  }, [field, suggestedCantons, onSkipped, onClose]);

  const handleSkip = useCallback(() => {
    onSkipped();
    onClose();
  }, [onClose, onSkipped]);

  const finishProfileField = useCallback(
    async (partial: Record<string, unknown>) => {
      setSaving(true);
      try {
        await savePartialProfile(email, partial);
      } finally {
        setSaving(false);
      }
      onAnswered();
      onClose();
    },
    [email, onAnswered, onClose],
  );

  const finishAlertField = useCallback(
    async (patch: Record<string, unknown>) => {
      if (!alertId) {
        handleSkip();
        return;
      }
      setSaving(true);
      try {
        const { updateAlert } = await import('@/services/jobAlertService');
        await updateAlert(email, alertId, patch);
      } finally {
        setSaving(false);
      }
      onAnswered();
      onClose();
    },
    [alertId, email, handleSkip, onAnswered, onClose],
  );

  if (field === 'cantonFilter' && suggestedCantons.length === 0) return null;

  const title = t(`profileEnrichment.${field}.title`, DEFAULT_TITLES[field]);

  const body = (() => {
    switch (field) {
      case 'provinceQuickPick':
        if (!province) {
          return (
            <div className="flex flex-wrap gap-2" role="group" aria-label={title}>
              {PROVINCE_QUICK_PICKS.map((p) => (
                <button key={p.code} type="button" className={chipClass(false)} onClick={() => setProvince(p.code)}>
                  {p.label}
                </button>
              ))}
              <button type="button" className={chipClass(false)} onClick={handleSkip}>
                {t('profileEnrichment.other', 'Altro')}
              </button>
            </div>
          );
        }
        return (
          <div className="flex flex-wrap gap-2" role="group" aria-label={title}>
            {provinceMunicipalities.map((m) => (
              <button
                key={m.name}
                type="button"
                disabled={saving}
                className={chipClass(false)}
                onClick={() => finishProfileField({ municipality: `${m.name} (${m.province})` })}
              >
                {m.name}
              </button>
            ))}
            <button type="button" className={chipClass(false)} onClick={handleSkip}>
              {t('profileEnrichment.other', 'Altro')}
            </button>
          </div>
        );

      case 'frontaliereType':
        return (
          <div className="flex flex-wrap gap-2" role="group" aria-label={title}>
            {(['permit-g', 'permit-b'] as const).map((value) => (
              <button
                key={value}
                type="button"
                disabled={saving}
                className={chipClass(false)}
                onClick={() => finishProfileField({ frontaliereType: value })}
              >
                {t(`profile.${value === 'permit-g' ? 'permitG' : 'permitB'}`, value)}
              </button>
            ))}
          </div>
        );

      case 'workPosition':
        return (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const v = workPositionInput.trim();
              if (v) finishProfileField({ workPosition: v });
            }}
          >
            <input
              type="text"
              value={workPositionInput}
              onChange={(e) => setWorkPositionInput(e.target.value)}
              placeholder={t('profile.workPositionPlaceholder', 'es. Infermiere')}
              className="flex-1 min-w-0 px-3 py-1.5 text-xs rounded-lg border border-edge bg-surface focus-visible:ring-2 focus-visible:ring-accent outline-none"
            />
            <button
              type="submit"
              disabled={saving || !workPositionInput.trim()}
              className="px-3 py-1.5 min-h-[36px] text-xs font-semibold rounded-lg bg-accent-strong text-on-accent disabled:opacity-50"
            >
              {t('profileEnrichment.submit', 'Ok')}
            </button>
          </form>
        );

      case 'grossSalary':
        return (
          <div className="flex flex-wrap gap-2" role="group" aria-label={title}>
            {GROSS_SALARY_BANDS.map((band) => (
              <button
                key={band.value}
                type="button"
                disabled={saving}
                className={chipClass(false)}
                onClick={() => finishProfileField({ grossSalary: band.value })}
              >
                {band.label}
              </button>
            ))}
          </div>
        );

      case 'cantonFilter':
        return (
          <div className="flex flex-wrap gap-2" role="group" aria-label={title}>
            {suggestedCantons.map((code) => (
              <button
                key={code}
                type="button"
                disabled={saving}
                className={chipClass(false)}
                onClick={() => finishAlertField({ cantonFilter: [code] })}
              >
                {getCantonLabel(code, typedLocale)}
              </button>
            ))}
            <button type="button" className={chipClass(false)} onClick={handleSkip}>
              {t('profileEnrichment.other', 'Altro')}
            </button>
          </div>
        );

      case 'sectors':
        return (
          <div className="flex flex-wrap gap-2 max-h-28 overflow-y-auto pr-1" role="group" aria-label={title}>
            {SECTORS.map((s) => (
              <button
                key={s.value}
                type="button"
                disabled={saving}
                className={chipClass(false)}
                onClick={() => finishAlertField({ sectors: [s.value] })}
              >
                {s.label}
              </button>
            ))}
          </div>
        );

      default:
        return null;
    }
  })();

  return (
    // Rendered from JobAlertForm, a different subtree from the JobBoard toasts
    // it shared coordinates with — which is precisely why a parent-level
    // suppression boolean could never have covered it.
    <BottomPromptShell
      slotId="profile-enrichment-prompt"
      priority={POPUP_PRIORITY.PROFILE_ENRICHMENT}
      ariaLabelledBy={TITLE_ID}
    >
      <div className="relative p-4 rounded-xl border border-accent-border bg-surface shadow-lg shadow-accent/20">
        <button
          type="button"
          onClick={handleSkip}
          aria-label={t('common.close', 'Chiudi')}
          disabled={saving}
          className="absolute top-2 right-2 p-1 text-muted hover:text-strong transition-colors disabled:opacity-50"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
        <div className="flex items-start gap-3">
          <span className="flex-shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-full bg-accent-strong text-on-accent shadow-sm">
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="w-4 h-4" aria-hidden="true" />
            )}
          </span>
          <div className="flex-1 min-w-0 pr-4">
            <h3 id={TITLE_ID} className="text-sm font-bold text-heading">
              {title}
            </h3>
            <div className="mt-3">{body}</div>
          </div>
        </div>
      </div>
    </BottomPromptShell>
  );
}

const DEFAULT_TITLES: Record<EnrichmentFieldKey, string> = {
  provinceQuickPick: 'Dove abiti?',
  frontaliereType: 'Che permesso hai (o vorresti)?',
  workPosition: 'Che lavoro fai?',
  grossSalary: 'Qual è il tuo stipendio lordo annuo?',
  cantonFilter: 'Vuoi restringere l\'alert a un cantone?',
  sectors: 'In che settore cerchi lavoro?',
};
