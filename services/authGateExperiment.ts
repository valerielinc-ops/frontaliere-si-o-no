/**
 * Auth-gate headline A/B test wiring.
 *
 * Backed by the PostHog feature flag `authgate-headline-v2`. Variant assignment
 * is per-distinctId and sticky; PostHog handles bucketing + the experiment
 * statistics. This module just resolves the variant, returns the matching
 * headline string for the active locale, and tags every subsequent PostHog
 * event with `headline_variant` so the funnel queries can split by arm.
 *
 * ── Round history ──────────────────────────────────────────────────────────
 * Round 1 (`authgate-headline-v1`, CLOSED): control vs `frictionless`.
 *   Winner = `frictionless` (+50.8% relative on per-person auth_success,
 *   p=1.25e-9). Promoted to 100%: the `jobBoard.gate.title` i18n key held the
 *   frictionless copy, so the round-2 `control` arm WAS the round-1 winner.
 *   Full results: docs/AUTHGATE-HEADLINE-EXPERIMENT.md.
 *
 * Round 2 (`authgate-headline-v2`, CLOSED 2026-06-25): control (= round-1
 * winner) vs free_unlock vs apply_now. apply_now led on per-person CR
 * (23.26% vs 21.80% control, +1.46pp) while free_unlock was flat (-0.13pp);
 * owner promoted apply_now to 100%. The `jobBoard.gate.title` i18n key now
 * holds the apply_now copy and the PostHog flag is deactivated, so every
 * viewer sees the promoted headline via the `control` fall-back. The
 * `CHALLENGER_HEADLINES` map below is retained as the last round's config for
 * a future round-3 (redefine the arms + reactivate the flag to reuse it).
 *
 * Initial render is always control until PostHog loads (~200-400 ms cold).
 * The experiment's exposure metric should be `gate_view WHERE headline_variant
 * IS NOT NULL` so the brief unattributed window does not bias the outcome.
 */

import { useEffect, useState } from 'react';
import { getFeatureFlag, onFeatureFlags, registerSuperProperty } from './posthog';

const FLAG_KEY = 'authgate-headline-v2';

export type AuthGateVariant = 'control' | 'free_unlock' | 'apply_now';

type ChallengerVariant = Exclude<AuthGateVariant, 'control'>;

const CHALLENGER_HEADLINES: Record<ChallengerVariant, Record<string, string>> = {
  free_unlock: {
    it: "Sblocca gratis l'annuncio completo",
    en: 'Unlock the full listing for free',
    de: 'Vollständiges Stellenangebot gratis freischalten',
    fr: "Débloquez gratuitement l'annonce complète",
  },
  apply_now: {
    it: 'Scopri come candidarti a questo lavoro',
    en: 'See how to apply for this job',
    de: 'So bewirbst du dich für diese Stelle',
    fr: 'Découvrez comment postuler à cette offre',
  },
};

function resolveChallenger(variant: ChallengerVariant, locale: string): string {
  const byLocale = CHALLENGER_HEADLINES[variant];
  return byLocale[locale] ?? byLocale.it;
}

function normalizeVariant(raw: unknown): AuthGateVariant | null {
  if (raw === 'control' || raw === 'free_unlock' || raw === 'apply_now') return raw;
  return null;
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
      setVariant(resolved ?? 'control');
      if (!resolved) return;
      registerSuperProperty('headline_variant', resolved);
    });
    return unsubscribe;
  }, []);

  const headline = variant === 'control' ? controlHeadline : resolveChallenger(variant, locale);
  return { variant, headline };
}
