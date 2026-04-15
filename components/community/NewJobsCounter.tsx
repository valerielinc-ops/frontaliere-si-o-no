/**
 * NewJobsCounter — slim inline bar showing new jobs since last visit.
 *
 * DESIGN-1: Below filter chips, above job list. No emoji (Stripe aesthetic).
 * DESIGN-7: Hides"per te" suffix when matchingCount is 0.
 */

import React, { useState } from 'react';
import { Sparkles, X } from 'lucide-react';

interface NewJobsCounterProps {
 newJobsCount: number;
 matchingCount: number;
 onDismiss: () => void;
}

function NewJobsCounter({ newJobsCount, matchingCount, onDismiss }: NewJobsCounterProps) {
 const [dismissed, setDismissed] = useState(false);

 if (newJobsCount <= 0 || dismissed) return null;

 const handleDismiss = () => {
 setDismissed(true);
 onDismiss();
 };

 return (
 <div
 role="status"
 className={`flex items-start sm:items-center gap-2 px-3 py-2 rounded-[6px] bg-accent-subtle border border-accent-border/40 text-xs text-body transition-[opacity,height,padding,border-width] duration-200 motion-reduce:transition-none ${dismissed ? 'h-0 overflow-hidden opacity-0 py-0 border-0' : ''}`}
 >
 <Sparkles className="w-4 h-4 text-accent shrink-0 mt-0.5 sm:mt-0" />
 <span className="flex-1 min-w-0">
 <strong className="font-semibold text-accent">{newJobsCount}</strong>
 {' nuovi lavori dalla tua ultima visita'}
 {matchingCount > 0 && (
 <>
 {', '}
 <strong className="font-semibold text-accent">{matchingCount}</strong>
 {' corrispondono al tuo profilo'}
 </>
 )}
 </span>
 <button
 onClick={handleDismiss}
 aria-label="Chiudi"
 className="shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center opacity-60 hover:opacity-100 transition-opacity motion-reduce:transition-none"
 >
 <X className="w-4 h-4" />
 </button>
 </div>
 );
}

export default React.memo(NewJobsCounter);
