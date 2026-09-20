import { useEffect } from 'react';
import { initGptFramework } from './GptAdSlot';
import { isAdsConsentGranted, onAdsConsentChange } from '@/services/adsConsent';

/**
 * Loads the GPT framework on every hydrated job-board route, including the
 * static-overlay pages where JobBoard itself is intentionally not rendered.
 * The static HTML bootstrap covers first paint; this island also covers SPA
 * navigation into the job board without a full document reload.
 */
export default function GptJobBoardBootstrap(): null {
  useEffect(() => {
    const initAfterConsent = () => {
      if (isAdsConsentGranted()) initGptFramework();
    };
    initAfterConsent();
    return onAdsConsentChange(initAfterConsent);
  }, []);

  return null;
}
