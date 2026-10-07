import { useEffect, useState, type CSSProperties } from 'react';
import { observeGoogleAdEdgeInsets, type GoogleAdEdgeInsets } from '@/services/modalAdOcclusion';

export interface ApplicationOfferAdClearance {
  /** Padding of the dialog's overlay past the anchor, when one is on screen. */
  overlayStyle?: CSSProperties;
  /**
   * `--offer-ad-inset` for a scrollable card: the height the anchor takes,
   * which the card's own max-height classes subtract (APPLICATION_OFFER_CARD_ROOM).
   */
  cardStyle?: CSSProperties;
}

/** Custom property a card reads for the height Google's anchor takes (0 without one). */
export const APPLICATION_OFFER_AD_INSET_VAR = '--offer-ad-inset';
/**
 * What a card's max-height leaves to the anchor, as a Tailwind arbitrary
 * value (underscores are spaces). The breakpoint caps stay in the classes:
 * an inline max-height capped phones at 42rem too (live 2026-10-07, 915 px
 * phone: 672 px for 720 px of content with 774 px free).
 */
export const APPLICATION_OFFER_CARD_ROOM = 'calc(100dvh_-_2rem_-_var(--offer-ad-inset,0px))';

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
    cardStyle: { [APPLICATION_OFFER_AD_INSET_VAR]: `${insets.top + insets.bottom}px` } as CSSProperties,
  };
}
