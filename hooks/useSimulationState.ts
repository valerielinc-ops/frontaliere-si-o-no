/**
 * useSimulationState — Manages fiscal simulation state extracted from App.tsx
 *
 * Handles:
 * - Simulation inputs and result
 * - URL hydration of simulation parameters
 * - SEO landing preset application
 * - Deferred initial calculation (interaction-triggered)
 * - Auto-recalculate when inputs change
 * - handleCalculate (lazy imports calculationService)
 */
import { useState, useEffect, useRef, useCallback, useMemo, type Dispatch, type SetStateAction, type MutableRefObject } from 'react';
import { DEFAULT_INPUTS } from '@/constants';
import { SimulationInputs, SimulationResult } from '@/types';
import { decodeSimulationParams, hasSimulationParams, cleanSimulationParams } from '@/services/urlStateService';
import { reportCaughtError } from '@/services/errorReporter';
import type { SeoLandingId, ActiveTab } from '@/services/router';

const lazyCalculate = () => import('@/services/calculationService');

import { Analytics, unlockAchievement } from '@/services/analyticsProxy';

export const SEO_LANDING_PRESETS: Record<SeoLandingId, Partial<SimulationInputs>> = {
 'salary-60000': { annualIncomeCHF: 60000, maritalStatus: 'SINGLE', children: 0, familyMembers: 1, frontierWorkerType: 'NEW', distanceZone: 'WITHIN_20KM', age: 35, spouseWorks: false },
 'salary-80000': { annualIncomeCHF: 80000, maritalStatus: 'SINGLE', children: 0, familyMembers: 1, frontierWorkerType: 'NEW', distanceZone: 'WITHIN_20KM', age: 35, spouseWorks: false },
 'salary-100000': { annualIncomeCHF: 100000, maritalStatus: 'SINGLE', children: 0, familyMembers: 1, frontierWorkerType: 'NEW', distanceZone: 'WITHIN_20KM', age: 40, spouseWorks: false },
 'salary-120000': { annualIncomeCHF: 120000, maritalStatus: 'SINGLE', children: 0, familyMembers: 1, frontierWorkerType: 'NEW', distanceZone: 'WITHIN_20KM', age: 42, spouseWorks: false },
 'salary-60000-old': { annualIncomeCHF: 60000, frontierWorkerType: 'OLD' },
 'salary-60000-new': { annualIncomeCHF: 60000, frontierWorkerType: 'NEW' },
 'salary-80000-old': { annualIncomeCHF: 80000, frontierWorkerType: 'OLD' },
 'salary-80000-new': { annualIncomeCHF: 80000, frontierWorkerType: 'NEW' },
 'salary-100000-old': { annualIncomeCHF: 100000, frontierWorkerType: 'OLD' },
 'salary-100000-new': { annualIncomeCHF: 100000, frontierWorkerType: 'NEW' },
 'salary-60000-married-2kids': { annualIncomeCHF: 60000, maritalStatus: 'MARRIED', children: 2, familyMembers: 4, spouseWorks: false, age: 38 },
 'salary-80000-married-2kids': { annualIncomeCHF: 80000, maritalStatus: 'MARRIED', children: 2, familyMembers: 4, spouseWorks: false, age: 40 },
 'salary-100000-married-2kids': { annualIncomeCHF: 100000, maritalStatus: 'MARRIED', children: 2, familyMembers: 4, spouseWorks: false, age: 42 },
 'salary-80000-over20km': { annualIncomeCHF: 80000, distanceZone: 'OVER_20KM' },
 'salary-80000-within20km': { annualIncomeCHF: 80000, distanceZone: 'WITHIN_20KM' },
 'salary-60000-over20km': { annualIncomeCHF: 60000, distanceZone: 'OVER_20KM' },
 'salary-60000-within20km': { annualIncomeCHF: 60000, distanceZone: 'WITHIN_20KM' },
 'salary-100000-over20km': { annualIncomeCHF: 100000, distanceZone: 'OVER_20KM' },
 'salary-100000-within20km': { annualIncomeCHF: 100000, distanceZone: 'WITHIN_20KM' },
 'new-frontier-over20km': { annualIncomeCHF: 80000, frontierWorkerType: 'NEW', distanceZone: 'OVER_20KM', maritalStatus: 'SINGLE', children: 0, familyMembers: 1, age: 38, spouseWorks: false },
 'net-comparison-2025-2026-within20km': { annualIncomeCHF: 80000, frontierWorkerType: 'NEW', distanceZone: 'WITHIN_20KM', maritalStatus: 'SINGLE', children: 0, familyMembers: 1, age: 38, spouseWorks: false },
 'net-comparison-g-vs-b-within20km': { annualIncomeCHF: 80000, frontierWorkerType: 'NEW', distanceZone: 'WITHIN_20KM', maritalStatus: 'SINGLE', children: 0, familyMembers: 1, age: 38, spouseWorks: false },
 'net-comparison-2025-2026-over20km': { annualIncomeCHF: 80000, frontierWorkerType: 'NEW', distanceZone: 'OVER_20KM', maritalStatus: 'SINGLE', children: 0, familyMembers: 1, age: 38, spouseWorks: false },
 'net-comparison-g-vs-b-over20km': { annualIncomeCHF: 80000, frontierWorkerType: 'NEW', distanceZone: 'OVER_20KM', maritalStatus: 'SINGLE', children: 0, familyMembers: 1, age: 38, spouseWorks: false },
};

export interface SimulationState {
 inputs: SimulationInputs;
 setInputs: Dispatch<SetStateAction<SimulationInputs>>;
 result: SimulationResult | null;
 setResult: Dispatch<SetStateAction<SimulationResult | null>>;
 handleCalculate: () => Promise<void>;
 urlHydrated: MutableRefObject<boolean>;
}

export function useSimulationState(activeTab: ActiveTab, seoLanding: SeoLandingId | null): SimulationState {
 const [inputs, setInputs] = useState<SimulationInputs>(DEFAULT_INPUTS);
 const [result, setResult] = useState<SimulationResult | null>(null);

 const urlHydrated = useRef(false);
 const hasHydrated = useRef(false);
 const initialCalcDone = useRef(false);
 const landingAppliedRef = useRef<SeoLandingId | null>(null);

 // handleCalculate
 const handleCalculate = useCallback(async () => {
 const { calculateSimulation } = await lazyCalculate();
 const res = calculateSimulation(inputs);
 setResult(res);
 import('@/services/firestoreService')
 .then(m => m.registerSimulationForSocialProof())
 .catch((e) => reportCaughtError(e, 'simulation.socialProof'));
 unlockAchievement('first_simulation');
 unlockAchievement('simulation_pro');
 Analytics.trackCalculation(
 inputs.workerType,
 inputs.grossSalary,
 inputs.hasChildren
 );
 Analytics.trackFunnelStep('calculate', { worker_type: inputs.workerType });
 }, [inputs]);

 // Hydrate simulation inputs from URL query params (runs once on mount)
 useEffect(() => {
 if (hasSimulationParams()) {
 const decoded = decodeSimulationParams(window.location.search);
 if (decoded && Object.keys(decoded).length > 0) {
 urlHydrated.current = true;
 setInputs(prev => ({ ...prev, ...decoded }));
 cleanSimulationParams();
 Analytics.trackUIInteraction('calcolatore', 'url-state', 'hydrate', 'auto', Object.keys(decoded).join(','));
 }
 }
 }, []);

 // Apply SEO landing presets when seoLanding changes
 useEffect(() => {
 if (activeTab !== 'calculator') return;
 if (!seoLanding) return;
 if (landingAppliedRef.current === seoLanding) return;
 landingAppliedRef.current = seoLanding;
 urlHydrated.current = true;
 const preset = SEO_LANDING_PRESETS[seoLanding];
 if (preset) {
 setInputs(prev => ({ ...prev, ...preset }));
 setResult(null);
 Analytics.trackUIInteraction('seo', 'landing', 'prefill', 'auto', seoLanding);
 }
 }, [activeTab, seoLanding]);

 // Deferred initial auto-calculation: triggered by first user interaction
 useEffect(() => {
 const runInitialCalc = () => {
 if (initialCalcDone.current) return;
 initialCalcDone.current = true;
 for (const evt of interactionEvents) {
 window.removeEventListener(evt, onInteract, { capture: true } as EventListenerOptions);
 }
 handleCalculate();
 };
 const interactionEvents = ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const;
 const onInteract = () => {
 setTimeout(runInitialCalc, 50);
 };
 for (const evt of interactionEvents) {
 window.addEventListener(evt, onInteract, { capture: true, passive: true, once: true } as AddEventListenerOptions);
 }
 const fallback = setTimeout(runInitialCalc, 30000);
 return () => {
 clearTimeout(fallback);
 for (const evt of interactionEvents) {
 window.removeEventListener(evt, onInteract, { capture: true } as EventListenerOptions);
 }
 };
 }, []);

 // Auto-recalculate when inputs change (skip first mount — handled above)
 useEffect(() => {
 if (!hasHydrated.current) {
 hasHydrated.current = true;
 return;
 }
 handleCalculate();
 }, [inputs]);

 return { inputs, setInputs, result, setResult, handleCalculate, urlHydrated };
}
