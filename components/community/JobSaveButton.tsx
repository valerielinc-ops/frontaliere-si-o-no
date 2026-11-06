/**
 * Bookmark for a job card outside JobBoard's own `JobCard` — same control, same
 * gate (services/jobSaveGate.ts): saves when signed in, asks for an account when
 * not. Absolutely positioned, so the card must be `relative` and reserve the
 * corner on its text block; it is always a sibling of the card's link, never
 * nested in it (a11y).
 */
import React, { useSyncExternalStore } from 'react';
import { Bookmark } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { requestJobSave, type SaveableJob } from '@/services/jobSaveGate';
import type { SaveJobSurface } from '@/services/pendingSaveJob';
import { isJobSaved, SAVED_JOBS_CHANGED_EVENT } from '@/services/savedJobsService';

function subscribeSavedJobs(listener: () => void): () => void {
  window.addEventListener(SAVED_JOBS_CHANGED_EVENT, listener);
  return () => window.removeEventListener(SAVED_JOBS_CHANGED_EVENT, listener);
}

interface JobSaveButtonProps {
  job: SaveableJob;
  surface: SaveJobSurface;
}

const JobSaveButton: React.FC<JobSaveButtonProps> = ({ job, surface }) => {
  const { t } = useTranslation();
  const saved = useSyncExternalStore(subscribeSavedJobs, () => isJobSaved(job.id), () => false);
  return (
    <button
      type="button"
      onClick={(event) => {
        // Some cards are a clickable container: a bookmark tap must not open the job.
        event.stopPropagation();
        requestJobSave(job, surface);
      }}
      aria-pressed={saved}
      aria-label={saved ? t('jobBoard.save.remove') : t('jobBoard.save.add')}
      className={`absolute top-1 right-1 z-10 inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg transition-colors ${
        saved ? 'text-accent' : 'text-muted hover:text-accent'
      }`}
    >
      <Bookmark className={`w-5 h-5 ${saved ? 'fill-current' : ''}`} aria-hidden="true" />
    </button>
  );
};

export default JobSaveButton;
