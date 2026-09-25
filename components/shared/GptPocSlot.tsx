/**
 * GptPocSlot — proof-of-concept GPT display slot below blog-article content.
 *
 * WHY: the GAM Offerwall (with the in-house newsletter custom choice) requires
 * the site to be tagged with GPT. This PoC validates that GPT can serve a slot
 * on a NON-funnel page (blog articles), with AdSense filling unsold inventory,
 * WHILE AdSense Auto Ads keep serving untouched. See issue #2273 / #2289.
 *
 * Thin wrapper over the shared {@link GptAdSlot} engine (script load, framework
 * init, lazy IntersectionObserver, prod/bot gating). Runtime kill-switch:
 * Firebase Remote Config `KILL_GPT_POC_SLOT` (resolves `false` / shown on RC
 * failure). The master GPT flag lives in GptAdSlot (`GPT_ENABLED`).
 */

import React from 'react';
import GptAdSlot, { type GptSize } from '@/components/shared/GptAdSlot';
import { useKillSwitches } from '@/hooks/useKillSwitches';

// Full GAM ad unit path — the display ad unit created for this PoC in GAM
// Inventory (ad unit id 23356816306, sizes 300x250 + fluid, AdSense backfill on).
const GPT_POC_AD_UNIT_PATH = '/23355151813/gpt-poc-articoli';
// Match the sizes the GAM ad unit actually allows (300x250 + fluid/responsive).
const GPT_POC_SIZES: GptSize[] = [[300, 250], 'fluid'];

const GptPocSlot: React.FC = () => {
  const { gptPocSlot: killed, headerBidding: hbKilled } = useKillSwitches();
  return (
    <GptAdSlot
      adUnitPath={GPT_POC_AD_UNIT_PATH}
      sizes={GPT_POC_SIZES}
      killed={killed}
      headerBiddingKilled={hbKilled}
      minHeight={250}
      className="mx-auto my-6 w-full max-w-[336px] text-center"
    />
  );
};

export default GptPocSlot;
