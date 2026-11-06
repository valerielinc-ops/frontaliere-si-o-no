import { AlertTriangle, Info } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import type { ReviewFitGap, ReviewFitNotice } from '@/services/assistedApplicationReviewService';
import { fitNoticeWording } from '@/functions/src/assistedApplicationFitNotice.js';

/**
 * Above the questions of the review page: the posting's decisive requirements
 * the CV does not show (functions/src/assistedApplicationFitNotice.js). The
 * application goes on all the same (owner decision 2026-10-03): the candidate
 * reads it before deciding, and answers or asks for a change if the CV left
 * something out. The words follow what the page shows, as the review e-mail's
 * do (fitNoticeWording): no list promised when there is none, the answers only
 * when there are questions, otherwise the letter or a new version.
 */
export function AssistedApplicationFitNotice({ fit, locale, hasQuestions, canEdit }: { fit: ReviewFitNotice; locale: string; hasQuestions: boolean; canEdit: boolean }) {
  const { t } = useTranslation();
  const low = fit.level === 'low';
  const Icon = low ? AlertTriangle : Info;
  const words = fitNoticeWording(fit, { questions: hasQuestions, edit: canEdit });
  const kind = words?.kind || fit.level;
  // The analysis is written in Italian: the other languages read the posting's own words.
  const wording = (gap: ReviewFitGap) => (locale === 'it' ? gap.requirement || gap.quote : gap.quote || gap.requirement);
  return (
    <section
      className={`rounded-xl border p-4 ${low ? 'border-warning-border bg-warning-subtle/60' : 'border-info-border bg-info-subtle/60'}`}
      role="note"
      aria-labelledby="assisted-fit-title"
    >
      <div className="flex items-start gap-3">
        <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${low ? 'text-warning' : 'text-info'}`} aria-hidden="true" />
        <div className="min-w-0 space-y-2">
          <h2 id="assisted-fit-title" className="text-base font-bold text-heading">{t(`jobBoard.assisted.review.fit.${kind}Title`)}</h2>
          {words?.via && (
            <p className="text-sm leading-relaxed text-body">{t(`jobBoard.assisted.review.fit.${kind}Body${words.via === 'edit' ? 'Edit' : ''}`)}</p>
          )}
          {fit.gaps.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm text-body">
              {fit.gaps.map((gap) => (
                <li key={`${gap.importance}-${gap.status}-${wording(gap)}`}>
                  {wording(gap)} <span className="text-xs text-subtle">— {t(`jobBoard.assisted.review.fit.${gap.status}`)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
