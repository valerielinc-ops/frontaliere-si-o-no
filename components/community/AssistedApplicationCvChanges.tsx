import { useEffect, useState } from 'react';
import { useTranslation } from '@/services/i18n';
import type { ReviewCvChanges, ReviewCvLineChoice } from '@/services/assistedApplicationReviewService';

type Use = ReviewCvLineChoice['use'];
type Choices = Record<string, ReviewCvLineChoice>;

const MAX_OWN_LINE = 300;

/**
 * What the tailored CV changed, line by line (study 2026-10-02, report-cv-lettera §6, phase 4):
 * each rewritten line beside the CV's own line it rewrites, and the candidate chooses which one
 * leaves, or writes it in their own words. The server checks the facts again and rebuilds the PDF.
 */
export function AssistedApplicationCvChanges({ changes, disabled, onSave }: {
  changes: ReviewCvChanges;
  disabled: boolean;
  onSave: (choices: Choices) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const lines = [...(changes.summary ? [changes.summary] : []), ...changes.roles.flatMap((role) => role.lines)];
  const initial = (): Choices => Object.fromEntries(lines.map((line) => [line.id, { use: line.use, ...(line.use === 'own' ? { text: line.text } : {}) }]));
  const [choices, setChoices] = useState<Choices>(initial);
  const [saved, setSaved] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setChoices(initial()); }, [changes]);

  if (!lines.length) return null;
  const set = (id: string, use: Use, text?: string) => {
    setSaved(false);
    setChoices((current) => ({ ...current, [id]: { use, ...(use === 'own' ? { text: text ?? current[id]?.text ?? '' } : {}) } }));
  };
  const invalid = Object.values(choices).some((choice) => choice.use === 'own' && (!String(choice.text || '').trim() || String(choice.text).length > MAX_OWN_LINE));

  const lineEditor = (line: ReviewCvChanges['roles'][number]['lines'][number], label?: string) => {
    const choice = choices[line.id] || { use: 'adapted' };
    return (
      <li key={line.id} className="space-y-1 rounded-lg border border-edge p-3">
        {label && <p className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>}
        {line.original
          ? <p className="text-xs text-subtle"><span className="font-semibold">{t('jobBoard.assisted.review.cvLineOriginal')}:</span> {line.original}</p>
          : <p className="text-xs text-subtle">{t('jobBoard.assisted.review.cvLineNoOriginal')}</p>}
        <p className="text-body"><span className="font-semibold">{t('jobBoard.assisted.review.cvLineAdapted')}:</span> {line.adapted}</p>
        <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-xs" disabled={disabled}>
          <legend className="sr-only">{t('jobBoard.assisted.review.cvLineChoice')}</legend>
          {(['adapted', 'original', 'own'] as const).map((use) => (
            <label key={use} className="flex items-center gap-1">
              <input
                type="radio"
                name={`cv-line-${line.id}`}
                checked={choice.use === use}
                disabled={use === 'original' && !line.original}
                onChange={() => set(line.id, use)}
              />
              {t(`jobBoard.assisted.review.cvLineUse.${use}`)}
            </label>
          ))}
        </fieldset>
        {choice.use === 'own' && (
          <textarea
            aria-label={t('jobBoard.assisted.review.cvLineUse.own')}
            className="w-full rounded-lg border border-edge bg-surface p-2 text-sm text-body"
            rows={2}
            maxLength={MAX_OWN_LINE}
            value={choice.text || ''}
            disabled={disabled}
            onChange={(event) => set(line.id, 'own', event.target.value)}
          />
        )}
      </li>
    );
  };

  return (
    <details className="rounded-xl border border-edge p-3 text-sm">
      <summary className="cursor-pointer font-semibold text-heading">{t('jobBoard.assisted.review.cvChangesTitle')}</summary>
      <p className="mt-2 text-xs text-subtle">{t('jobBoard.assisted.review.cvChangesIntro')}</p>
      <ul className="mt-2 space-y-2">
        {changes.summary && lineEditor(changes.summary, t('jobBoard.assisted.review.cvSummary'))}
        {changes.roles.map((role) => (
          <li key={`${role.title}-${role.employer}`} className="space-y-2">
            <p className="font-medium text-heading">{[role.title, role.employer].filter(Boolean).join(' — ')}</p>
            <ul className="space-y-2">{role.lines.map((line) => lineEditor(line))}</ul>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={disabled || invalid}
          onClick={async () => { setSaved(await onSave(choices)); }}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-accent px-4 text-sm font-semibold text-accent hover:bg-accent-subtle disabled:opacity-60"
        >
          {t('jobBoard.assisted.review.cvChangesSave')}
        </button>
        {saved && <span className="text-xs text-success" role="status">{t('jobBoard.assisted.review.cvChangesSaved')}</span>}
      </div>
    </details>
  );
}
