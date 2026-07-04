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
 'salary-40000': { annualIncomeCHF: 40000, maritalStatus: 'SINGLE', children: 0, familyMembers: 1, frontierWorkerType: 'NEW', distanceZone: 'WITHIN_20KM', age: 30, spouseWorks: false },
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
 // True when the next inputs change should be attributed to a user action.
 // Stays false for URL hydration, SEO preset prefill, and the deferred initial
 // auto-calc — those produce a result but no `input_start`/`calculate` funnel
 // event, otherwise `calculate` over-fires vs `input_start` (see funnel report
 // 2026-05-25: 5 input_start / 219 calculate).
 const nextRecalcIsUser = useRef(false);

 // handleCalculate
 // `userInitiated` defaults to true so existing callers (InputCard
 // onCalculate button, tests, anything passing no args) keep firing the
 // funnel events. Internal call sites that auto-recalc on hydration /
 // preset / first-interaction pass false to avoid inflating `calculate`.
 const handleCalculate = useCallback(async (userInitiated = true) => {
 if (userInitiated) {
 // Funnel step fired BEFORE the heavy calc so we measure the click-to-result
 // latency in PostHog and capture users who abort mid-calculation.
 Analytics.trackFunnelStep('simulation_start', {
 funnel: 'calculator',
 worker_type: inputs.workerType,
 });
 }
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
 if (userInitiated) {
 Analytics.trackFunnelStep('calculate', {
 funnel: 'calculator',
 worker_type: inputs.workerType,
 });
 Analytics.trackFunnelStep('simulation_complete', {
 funnel: 'calculator',
 worker_type: inputs.workerType,
 has_children: inputs.hasChildren,
 });
 }
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

 // Deferred initial auto-calculation: fired at first IDLE after boot, NOT on
 // first user interaction.
 // CLS fix (#3529): the previous trigger was the first pointerdown/keydown/
 // scroll/touchstart. `scroll` never sets `hadRecentInput`, so mounting the
 // result card + newsletter CTA (~1.1k px on mobile, ResultsView column on
 // desktop) exactly while the user was scrolling counted fully as CLS — the
 // reason field p75 CLS was 0.26 (mobile) / 0.30 (desktop) while the lab,
 // which never scrolls, measured 0.012–0.18. Worse, the window listener used
 // capture:true, so the consent dialog's internal scroll event fired it at
 // ~2.5s anyway for every first-visit EEA session (boot-path deferral was
 // already moot for those). Firing at idle (~1–2.5s, still after LCP/boot
 // work) mounts the result area while the user is still at the top in the
 // vast majority of sessions, so the growth happens below the fold where
 // layout shifts don't count.
 useEffect(() => {
 let idleId: number | undefined;
 let fallbackTimer: number | undefined;
 const runInitialCalc = () => {
 if (initialCalcDone.current) return;
 initialCalcDone.current = true;
 // Not user-initiated — fires at idle on any page, even when the
 // visitor never touched a calculator input.
 handleCalculate(false);
 };
 if (typeof requestIdleCallback === 'function') {
 idleId = requestIdleCallback(runInitialCalc, { timeout: 2500 });
 } else {
 fallbackTimer = window.setTimeout(runInitialCalc, 2000);
 }
 return () => {
 if (idleId !== undefined && typeof cancelIdleCallback === 'function') cancelIdleCallback(idleId);
 if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
 };
 }, []);

 // Auto-recalculate when inputs change (skip first mount — handled above).
 // Only attribute to user when the prior setInputs was a real user input
 // change (nextRecalcIsUser flipped by handleUserInputChange below).
 useEffect(() => {
 if (!hasHydrated.current) {
 hasHydrated.current = true;
 return;
 }
 const userInitiated = nextRecalcIsUser.current;
 nextRecalcIsUser.current = false;
 handleCalculate(userInitiated);
 }, [inputs]);

 // Wrapped setInputs that marks the next auto-recalculate as user-initiated.
 // SEO preset + URL hydration use the raw setInputs and stay attribution-free.
 const setInputsUser: SimulationState['setInputs'] = useCallback((next) => {
 nextRecalcIsUser.current = true;
 setInputs(next);
 }, []);

 return { inputs, setInputs: setInputsUser, result, setResult, handleCalculate, urlHydrated };
}
