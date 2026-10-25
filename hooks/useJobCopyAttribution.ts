import { useCallback, type ClipboardEventHandler } from 'react';
import { Analytics } from '@/services/analytics';
import {
  buildJobCopyAttributionFromSelection,
  type JobCopyAttributionSelectionInput,
} from '@/services/jobCopyAttribution';

export interface UseJobCopyAttributionOptions extends JobCopyAttributionSelectionInput {
  /** Disable attribution on the authenticated version of a shared card. */
  enabled?: boolean;
  /** Stable value used to identify the listing in the existing select-content event. */
  analyticsValue?: string;
}

/**
 * Shared React wiring for the gated job-card copy attribution.
 *
 * The handler must be attached to the title/teaser card itself. The service
 * still verifies the selected range, so a selection from a sibling rail cannot
 * accidentally receive the listing's attribution.
 */
export function useJobCopyAttribution({
  enabled = true,
  analyticsValue,
  jobTitle,
  company,
  url,
  lead,
}: UseJobCopyAttributionOptions): ClipboardEventHandler<HTMLDivElement> {
  return useCallback((event) => {
    if (!enabled) return;
    try {
      const selection = typeof window !== 'undefined' ? window.getSelection() : null;
      const clipboard = buildJobCopyAttributionFromSelection(
        selection,
        event.currentTarget,
        { jobTitle, company, url, lead },
      );
      if (!clipboard) return;

      event.clipboardData.setData('text/plain', clipboard.text);
      event.clipboardData.setData('text/html', clipboard.html);
      event.preventDefault();
      Analytics.trackSelectContent(
        'job_gate_copy_attribution',
        analyticsValue ?? `${company ?? ''}_${jobTitle}`,
      );
    } catch {
      // Native copy remains the fallback if a browser rejects a clipboard flavor.
    }
  }, [analyticsValue, company, enabled, jobTitle, lead, url]);
}
