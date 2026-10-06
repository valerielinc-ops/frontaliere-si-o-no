import { useEffect, useState, type CSSProperties } from 'react';
import { observeGoogleAdEdgeInsets, type GoogleAdEdgeInsets } from '@/services/modalAdOcclusion';

export interface ApplicationOfferAdClearance {
  /** Padding of the dialog's overlay past the anchor, when one is on screen. */
  overlayStyle?: CSSProperties;
  /** Max height of a scrollable card inside that padding. */
  cardStyle?: CSSProperties;
}

/**
 * Keeps an application offer dialog clear of a Google anchor ad. The anchor
 * stacks above every site layer: live on 2026-10-06 it covered the free
 * button of the paid offer, and a click meant for the button opened the ad.
 * The ad itself is never changed (services/modalAdOcclusion.ts): the dialog
 * makes room for it instead.
 */
export function useApplicationOfferAdClearance(): ApplicationOfferAdClearance {
  const [insets, setInsets] = useState<GoogleAdEdgeInsets>({ top: 0, bottom: 0 });
  useEffect(() => observeGoogleAdEdgeInsets(setInsets), []);
  if (!insets.top && !insets.bottom) return {};
  return {
    overlayStyle: {
      paddingTop: `calc(env(safe-area-inset-top, 0px) + 1rem + ${insets.top}px)`,
      paddingBottom: `calc(env(safe-area-inset-bottom, 0px) + 1rem + ${insets.bottom}px)`,
    },
    cardStyle: { maxHeight: `min(42rem, calc(100dvh - 2rem - ${insets.top + insets.bottom}px))` },
  };
}
