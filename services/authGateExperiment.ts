/**
 * Auth-gate H2 A/B test wiring.
 *
 * Backed by the PostHog feature flag `authgate-headline-v1`. Variant assignment
 * is per-distinctId and sticky; PostHog handles bucketing + the experiment
 * statistics. This module just resolves the variant, returns the matching
 * headline string for the active locale, and tags every subsequent PostHog
 * event with `headline_variant` so the funnel queries can split by arm.
 *
 * Variants:
 *   control      — t('jobBoard.gate.title') passed in from the caller.
 *   frictionless — neutral outcome-framed CTA, tested across all 4 locales.
 *
 * Initial render is always control until PostHog loads (~200-400 ms cold).
 * The experiment's exposure metric should be `gate_view WHERE headline_variant
 * IS NOT NULL` so the brief unattributed window does not bias the outcome.
 */

import { useEffect, useState } from 'react';
import { getFeatureFlag, onFeatureFlags, registerSuperProperty } from './posthog';

const FLAG_KEY = 'authgate-headline-v1';

export type AuthGateVariant = 'control' | 'frictionless';

const CHALLENGER_HEADLINES: Record<string, string> = {
 it: "Continua per vedere l'annuncio completo",
 en: 'Continue to see the full listing',
 de: 'Weiter zum vollständigen Stellenangebot',
 fr: "Continuer pour voir l'annonce complète",
};

function resolveChallenger(locale: string): string {
 return CHALLENGER_HEADLINES[locale] ?? CHALLENGER_HEADLINES.it;
}

function normalizeVariant(raw: unknown): AuthGateVariant {
 return raw === 'frictionless' ? 'frictionless' : 'control';
}

interface UseAuthGateHeadlineVariantResult {
 variant: AuthGateVariant;
 headline: string;
}

/**
 * Returns the headline + variant for the current PostHog assignment. Pass the
 * control headline (typically `t('jobBoard.gate.title')`) so this hook can
 * fall back without duplicating the i18n key.
 */
export function useAuthGateHeadlineVariant(
 locale: string,
 controlHeadline: string,
): UseAuthGateHeadlineVariantResult {
 const [variant, setVariant] = useState<AuthGateVariant>('control');

 useEffect(() => {
 const unsubscribe = onFeatureFlags(() => {
 const resolved = normalizeVariant(getFeatureFlag(FLAG_KEY));
 setVariant(resolved);
 registerSuperProperty('headline_variant', resolved);
 });
 return unsubscribe;
 }, []);

 const headline = variant === 'frictionless' ? resolveChallenger(locale) : controlHeadline;
 return { variant, headline };
}
