import { useCallback, useEffect, useRef, useState } from 'react';
import { Users, X } from 'lucide-react';

import BottomPromptShell from '@/components/shared/BottomPromptShell';
import { POPUP_PRIORITY } from '@/services/popupQueue';
import { useTranslation } from '@/services/i18n';

const DISPLAY_DELAY_MS = 8_000;
const AUTO_DISMISS_MS = 7_000;
const SESSION_SEEN_KEY = 'ft_job_viewers_prompt_seen';
let runtimePromptShown = false;
const runtimeViewerCounts = new Map<string, number>();

function getSessionViewerCount(jobId: string): number {
  const countKey = `ft_job_viewers_count:${jobId}`;

  try {
    const stored = Number(window.sessionStorage.getItem(countKey));
    if (Number.isInteger(stored) && stored >= 2 && stored <= 5) return stored;

    // The product brief requests a randomized 2–5 figure; this is not telemetry.
    const count = Math.floor(Math.random() * 4) + 2;
    window.sessionStorage.setItem(countKey, String(count));
    return count;
  } catch {
    const cached = runtimeViewerCounts.get(jobId);
    if (cached) return cached;
    const count = Math.floor(Math.random() * 4) + 2;
    runtimeViewerCounts.set(jobId, count);
    return count;
  }
}

interface JobViewersActivityPromptProps {
  jobId: string;
}

export default function JobViewersActivityPrompt({ jobId }: JobViewersActivityPromptProps) {
  const { t } = useTranslation();
  const [count, setCount] = useState<number | null>(null);
  const [visible, setVisible] = useState(false);
  const dismissTimer = useRef<number | null>(null);

  useEffect(() => {
    if (runtimePromptShown) return;
    try {
      if (window.sessionStorage.getItem(SESSION_SEEN_KEY)) return;
    } catch {
      // Session storage is optional; the prompt still works without it.
    }

    const timer = window.setTimeout(() => {
      setCount(getSessionViewerCount(jobId));
      setVisible(true);
    }, DISPLAY_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [jobId]);

  const close = useCallback(() => {
    if (dismissTimer.current !== null) {
      window.clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
    }
    setVisible(false);
  }, []);

  const handleShown = useCallback(() => {
    runtimePromptShown = true;
    try {
      window.sessionStorage.setItem(SESSION_SEEN_KEY, '1');
    } catch {
      // Session storage is optional; the popup queue still limits overlap.
    }

    dismissTimer.current = window.setTimeout(close, AUTO_DISMISS_MS);
  }, [close]);

  useEffect(() => () => {
    if (dismissTimer.current !== null) window.clearTimeout(dismissTimer.current);
  }, []);

  if (!visible || count === null) return null;

  const message = t('jobBoard.viewers.message', { count });

  return (
    <BottomPromptShell
      slotId="job-viewers-activity-prompt"
      priority={POPUP_PRIORITY.JOB_VIEWERS_ACTIVITY}
      role="status"
      ariaLabel={message}
      onShown={handleShown}
    >
      <div className="relative flex items-start gap-3 rounded-xl border border-accent-border bg-surface p-3.5 pr-12 text-heading shadow-stripe-md">
        <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-accent" aria-hidden="true">
          <Users className="h-4 w-4" />
        </span>
        <p className="min-w-0 pt-1 text-sm font-medium leading-snug">
          {message}
        </p>
        <button
          type="button"
          onClick={close}
          aria-label={t('common.close')}
          className="absolute right-1 top-1 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-raised hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </BottomPromptShell>
  );
}
