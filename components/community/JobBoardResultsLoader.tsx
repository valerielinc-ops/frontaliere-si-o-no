import React, { useEffect, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { useTranslation } from '@/services/i18n';

interface JobBoardResultsLoaderProps {
  /**
   * Number of shimmer skeleton cards to reserve. Pick a count close to the
   * eventual list length so results reconcile in place with zero CLS.
   */
  cards?: number;
  className?: string;
}

/**
 * Animated, accessible loading state for the job-board result list (#2968).
 *
 * - Rotating reassuring messages ("woow effect") so the wait reads as purposeful
 *   work instead of a frozen / empty page.
 * - Shimmer-sweep skeleton cards sized to the real JobCard (h-24 / sm:h-[120px])
 *   so the footer never shifts when the list resolves (anti-CLS).
 * - role="status" + aria-busy lets assistive tech announce the loading phase and
 *   never read a misleading "0 risultati" mid-fetch.
 * - All motion runs through `animate-spin` / `.job-loader-shimmer`, which the
 *   global prefers-reduced-motion rule (index.css) neutralises; message rotation
 *   is paused for motion-sensitive users too.
 */
export const JobBoardResultsLoader: React.FC<JobBoardResultsLoaderProps> = ({ cards = 6, className = '' }) => {
  const { t } = useTranslation();
  // Static t() calls (not template literals) so the i18n-completeness test
  // verifies every key exists across all four locales.
  const steps = [
    t('jobBoard.loading.step1'),
    t('jobBoard.loading.step2'),
    t('jobBoard.loading.step3'),
    t('jobBoard.loading.step4'),
  ];
  const [step, setStep] = useState(0);

  useEffect(() => {
    const reduce = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return; // keep the first message static for motion-sensitive users
    const id = window.setInterval(() => setStep((s) => (s + 1) % steps.length), 1800);
    return () => window.clearInterval(id);
    // steps.length is constant for the component lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps.length]);

  return (
    <div className={`space-y-3 ${className}`} role="status" aria-busy="true">
      {/* Single stable announcement — the rotating visual below is decorative
          (aria-hidden) so screen readers aren't spammed every 1.8s. */}
      <span className="sr-only">{t('jobBoard.loading.aria')}</span>

      {/* Animated message banner — the focal "woow" element. Decorative. */}
      <div
        className="flex items-center gap-3 rounded-2xl border border-accent-border bg-accent-subtle px-4 py-3"
        aria-hidden="true"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface">
          <Loader2 className="h-5 w-5 animate-spin text-accent" />
        </span>
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-semibold font-display text-accent">
            <Sparkles className="h-3.5 w-3.5 shrink-0" />
            {/* key={step} remounts the span so the fade-in re-triggers each rotation. */}
            <span key={step} className="truncate animate-fade-in">{steps[step]}</span>
          </p>
          <p className="mt-0.5 text-xs text-subtle">{t('jobBoard.loadingResults')}</p>
        </div>
      </div>

      {/* Shimmer skeleton cards — sized to the real JobCard so the list resolves
          in place (no CLS). The sweep is decorative → hidden from a11y tree. */}
      <div className="space-y-3" aria-hidden="true">
        {Array.from({ length: cards }).map((_, i) => (
          <div
            key={i}
            className="job-loader-card relative h-24 overflow-hidden rounded-xl border border-edge bg-surface-raised sm:h-[120px]"
          >
            <div className="job-loader-shimmer absolute inset-0" />
          </div>
        ))}
      </div>
    </div>
  );
};

export default JobBoardResultsLoader;
