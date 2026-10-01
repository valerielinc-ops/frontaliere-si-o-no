import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { SimulationInputs } from '@/types';
import { resilientImport, isVersionSkewError, recoverFromStaleChunk } from '@/services/resilientImport';
import { reportCaughtError } from '@/services/errorReporter';

/** One refresh lifecycle for the calculator, including the compact mobile view. */
export function useCalculatorExchangeRate(
 setInputs: Dispatch<SetStateAction<SimulationInputs>>,
 enabled: boolean,
) {
 const [loadingRate, setLoadingRate] = useState(false);
 const [lastRateUpdate, setLastRateUpdate] = useState<Date | null>(null);
 const generation = useRef(0);
 const fetchRate = useCallback(async () => {
  const currentGeneration = generation.current;
  setLoadingRate(true);
  try {
   const { fetchExchangeRate } = await resilientImport(
    () => import('@/services/exchangeRateService'),
    m => typeof m.fetchExchangeRate === 'function',
   );
   const rate = await fetchExchangeRate();
   if (currentGeneration !== generation.current) return;
   setInputs(previous => previous.customExchangeRate === rate
    ? previous : { ...previous, customExchangeRate: rate });
   setLastRateUpdate(new Date());
  } catch (error) {
   reportCaughtError(error, 'inputCard.fetchExchangeRate');
   // Preserve stale-chunk recovery previously owned by InputCard.
   if (isVersionSkewError(error)) {
    void recoverFromStaleChunk(`inputCard_exchange_rate:${(error as Error)?.message?.slice(0, 80) || ''}`);
   }
  } finally {
   if (currentGeneration === generation.current) setLoadingRate(false);
  }
 }, [setInputs]);

 useEffect(() => {
  if (!enabled) return;
  void fetchRate();
  const interval = window.setInterval(fetchRate, 300000);
  return () => {
   generation.current += 1;
   window.clearInterval(interval);
  };
 }, [enabled, fetchRate]);

 return { fetchRate, loadingRate, lastRateUpdate };
}
