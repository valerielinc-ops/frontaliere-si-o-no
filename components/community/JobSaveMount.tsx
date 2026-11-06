/**
 * Mounted once from App.tsx on every page: owns the save sign-in modal and
 * hydrates the bookmark of the static job cards.
 *
 * Static cards (`renderJobCardHtml`) emit a `[data-job-save]` placeholder that
 * is empty and zero-sized until this portal fills it, so nothing shifts and
 * crawlers see no dead button. Same island contract as `CompanyFollowMount`,
 * over the same loop (`hooks/useHydrationIslands.ts`). The title is read from
 * the card rather than repeated in the markup: this runs on ~314k cards.
 */
import React, { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { getLocale } from '@/services/i18n';
import { lazyRetry } from '@/services/lazyRetry';
import { useHydrationIslands } from '@/hooks/useHydrationIslands';
import { dismissSavePrompt, isSavePromptOpen, subscribeSavePrompt, type SaveableJob } from '@/services/jobSaveGate';
import JobSaveButton from './JobSaveButton';

const SaveSignInPromptModal = lazyRetry(() => import('@/components/community/SaveSignInPromptModal'));

/** First text node only: the heading also holds the "new" and featured badges. */
function cardTitle(el: HTMLElement): string {
  const heading = el.closest('article')?.querySelector('.jc-title');
  return (heading?.firstChild?.textContent || '').trim();
}

export function readJobSaveProps(el: HTMLElement): SaveableJob | null {
  const id = (el.dataset.jobSave || '').trim();
  const title = cardTitle(el);
  if (!id || !title) return null;
  return {
    id,
    slug: el.dataset.slug || null,
    title,
    company: el.dataset.company || '',
    canton: el.dataset.canton || null,
    category: el.dataset.category || null,
  };
}

const JobSaveMount: React.FC = () => {
  const targets = useHydrationIslands<SaveableJob>({
    attribute: 'data-job-save',
    mountedAttribute: 'data-job-save-mounted',
    readProps: readJobSaveProps,
  });
  const promptOpen = useSyncExternalStore(subscribeSavePrompt, isSavePromptOpen, () => false);

  return (
    <>
      {targets.map((t, i) =>
        t.el.isConnected
          ? createPortal(<JobSaveButton job={t.props} surface="card_static" />, t.el, `job-save-${i}`)
          : null,
      )}
      {promptOpen && (
        <React.Suspense fallback={null}>
          <SaveSignInPromptModal locale={getLocale()} onDismiss={dismissSavePrompt} />
        </React.Suspense>
      )}
    </>
  );
};

export default JobSaveMount;
