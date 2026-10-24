import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Users, X } from 'lucide-react';

import { ABOVE_MOBILE_NAV_BOTTOM } from '@/components/shared/mobileNavClearance';
import {
  getAutoAdOverlayClearance,
  subscribeToAutoAdOverlay,
} from '@/services/autoAdOverlay';
import { useTranslation } from '@/services/i18n';

const DISPLAY_DELAY_MS = 1_500;
const AUTO_DISMISS_MS = 3_500;
const STATUS_TOAST_GAP_PX = 12;
const SESSION_SEEN_KEY = 'ft_job_viewers_prompt_seen';
let runtimePromptShown = false;
const runtimeViewerCounts = new Map<string, number>();

const STATUS_TOAST_SELECTORS = [
  '[data-testid="gamification-toast"]',
  '[data-bottom-prompt]',
  '[class*="z-[9999]"]',
].join(',');

function useStatusToastStackOffset(enabled: boolean): number {
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    if (!enabled || typeof document === 'undefined') {
      setOffset(0);
      return undefined;
    }

    let frame: number | null = null;
    const measure = () => {
      frame = null;
      const viewportHeight = window.innerHeight;
      let nextOffset = 0;
      document.querySelectorAll<HTMLElement>(STATUS_TOAST_SELECTORS).forEach((element) => {
        const computed = window.getComputedStyle(element);
        if (computed.display === 'none' || computed.visibility === 'hidden') return;
        const rect = element.getBoundingClientRect();
        const isCoordinatedPrompt = element.hasAttribute('data-bottom-prompt');
        if (
          computed.position !== 'fixed'
          || rect.height <= 0
          || rect.top <= 0
          || (!isCoordinatedPrompt && rect.bottom <= viewportHeight / 2)
        ) return;
        nextOffset = Math.max(nextOffset, Math.ceil(viewportHeight - rect.top + STATUS_TOAST_GAP_PX));
      });
      setOffset((current) => current === nextOffset ? current : nextOffset);
    };
    const scheduleMeasure = () => {
      if (frame !== null) return;
      if (typeof window.requestAnimationFrame !== 'function') {
        measure();
        return;
      }
      frame = window.requestAnimationFrame(measure);
    };
    const observer = new MutationObserver(scheduleMeasure);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', scheduleMeasure, { passive: true });
    measure();

    return () => {
      if (frame !== null && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(frame);
      }
      observer.disconnect();
      window.removeEventListener('resize', scheduleMeasure);
    };
  }, [enabled]);

  return offset;
}

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
  const [autoAdClearance, setAutoAdClearance] = useState(getAutoAdOverlayClearance);
  const dismissTimer = useRef<number | null>(null);
  const statusToastStackOffset = useStatusToastStackOffset(visible);

  useEffect(() => {
    if (!visible) return undefined;
    return subscribeToAutoAdOverlay(setAutoAdClearance);
  }, [visible]);

  useEffect(() => {
    if (runtimePromptShown) return;
    try {
      if (window.sessionStorage.getItem(SESSION_SEEN_KEY)) return;
    } catch {
      // Session storage is optional; the prompt still works without it.
    }

    let timer: number | null = null;
    let gateObserver: MutationObserver | null = null;
    const showPrompt = () => {
      setCount(getSessionViewerCount(jobId));
      setVisible(true);
    };
    const schedule = () => {
      if (timer !== null) return;
      const gate = document.getElementById('job-auth-gate');
      if (gate?.dataset.viewerPromptJobId !== jobId) return;
      const gateVisibleAt = Number(gate.dataset.viewerPromptVisibleAt);
      if (!Number.isFinite(gateVisibleAt)) return;
      const elapsedSinceGate = Number.isFinite(gateVisibleAt)
        ? Math.max(0, Date.now() - gateVisibleAt)
        : 0;
      timer = window.setTimeout(showPrompt, Math.max(0, DISPLAY_DELAY_MS - elapsedSinceGate));
    };
    const scheduleFallback = () => {
      if (timer !== null) return;
      timer = window.setTimeout(showPrompt, DISPLAY_DELAY_MS);
    };
    const gate = document.getElementById('job-auth-gate');
    if (
      gate?.dataset.viewerPromptJobId === jobId
      && gate.dataset.viewerPromptVisibleAt
    ) {
      schedule();
    } else if (gate && typeof MutationObserver !== 'undefined') {
      gateObserver = new MutationObserver(() => {
        if (
          gate.dataset.viewerPromptJobId !== jobId
          || !gate.dataset.viewerPromptVisibleAt
        ) return;
        gateObserver?.disconnect();
        gateObserver = null;
        schedule();
      });
      gateObserver.observe(gate, {
        attributes: true,
        attributeFilter: [
          'data-viewer-prompt-job-id',
          'data-viewer-prompt-visible-at',
        ],
      });
    } else {
      scheduleFallback();
    }

    return () => {
      gateObserver?.disconnect();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [jobId]);

  const close = useCallback(() => {
    if (dismissTimer.current !== null) {
      window.clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
    }
    setVisible(false);
  }, []);

  useEffect(() => {
    if (!visible) return;
    runtimePromptShown = true;
    try {
      window.sessionStorage.setItem(SESSION_SEEN_KEY, '1');
    } catch {
      // Session storage is optional; the runtime guard still limits repetition.
    }

    dismissTimer.current = window.setTimeout(close, AUTO_DISMISS_MS);
    return () => {
      if (dismissTimer.current !== null) {
        window.clearTimeout(dismissTimer.current);
        dismissTimer.current = null;
      }
    };
  }, [close, visible]);

  useEffect(() => () => {
    if (dismissTimer.current !== null) window.clearTimeout(dismissTimer.current);
  }, []);

  if (!visible || count === null || typeof document === 'undefined') return null;

  const message = t('jobBoard.viewers.message', { count });

  return createPortal(
    <div
      data-testid="job-viewers-activity-toast"
      role="status"
      aria-label={message}
      aria-live="polite"
      className={`fixed ${ABOVE_MOBILE_NAV_BOTTOM} right-4 sm:right-6 z-[60] animate-toast-in pointer-events-auto`}
      style={{
        '--bottom-prompt-ad-clearance': `${autoAdClearance}px`,
        // Stacking above another status toast goes through the class's
        // translate (index.css .above-mobile-nav), not `bottom`, so it is not a
        // layout shift; the total stays var(--bottom-prompt-offset).
        '--bottom-prompt-stack': `${statusToastStackOffset}px`,
      } as CSSProperties}
    >
      <div className="bg-warning-strong text-on-accent rounded-xl shadow-lg px-4 py-2.5 flex items-center gap-2.5 max-w-xs">
        <span className="text-xl flex-shrink-0" aria-hidden="true">
          <Users className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <div className="font-bold text-xs">{message}</div>
        </div>
        <button
          type="button"
          onClick={close}
          aria-label={t('common.close')}
          className="ml-1 p-2 min-w-[44px] min-h-[44px] flex items-center justify-center hover:bg-on-accent/20 rounded-full transition-colors flex-shrink-0 focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-amber-500"
        >
          <X size={12} />
        </button>
      </div>
    </div>,
    document.body,
  );
}
