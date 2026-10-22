/**
 * Return-visit action: toggles the job board to offers posted since the
 * visitor's previous session.
 */

import React from 'react';
import { Sparkles, X } from 'lucide-react';
import { useTranslation } from '@/services/i18n';

interface NewJobsCounterProps {
 newJobsCount: number;
 isActive: boolean;
 onToggle: () => void;
 onDismiss: () => void;
}

function NewJobsCounter({ newJobsCount, isActive, onToggle, onDismiss }: NewJobsCounterProps) {
 const { t } = useTranslation();

 if (newJobsCount <= 0 && !isActive) return null;

 return (
 <div
 role="status"
 data-testid="return-visit-new-jobs"
 className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-[6px] bg-accent-subtle border border-accent-border/40 text-xs text-body"
 >
 <Sparkles className="w-4 h-4 text-accent shrink-0" aria-hidden="true" />
 <span className="flex-1 min-w-0">
 <strong className="font-semibold text-accent">{newJobsCount}</strong>
 {' '}
 {t('jobBoard.returnVisit.message', { count: newJobsCount })}
 </span>
 <button
 type="button"
 onClick={onToggle}
 aria-pressed={isActive}
 data-testid="return-visit-toggle"
 className="shrink-0 min-h-[44px] px-3 rounded-lg border border-accent-border bg-surface text-accent font-semibold hover:bg-accent-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
 >
 {t(isActive ? 'jobBoard.returnVisit.showAll' : 'jobBoard.returnVisit.show')}
 </button>
 {!isActive && (
 <button
 type="button"
 onClick={onDismiss}
 aria-label={t('jobBoard.returnVisit.dismiss')}
 data-testid="return-visit-dismiss"
 className="shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center opacity-60 hover:opacity-100 transition-opacity motion-reduce:transition-none"
 >
 <X className="w-4 h-4" aria-hidden="true" />
 </button>
 )}
 </div>
 );
}

export default React.memo(NewJobsCounter);
