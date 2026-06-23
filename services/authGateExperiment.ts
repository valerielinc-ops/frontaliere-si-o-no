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
 *   p=1.25e-9). Promoted to 100%: the `jobBoard.gate.title` i18n key now holds
 *   the frictionless copy, so the round-2 `control` arm IS the round-1 winner.
 *   Full results: docs/AUTHGATE-HEADLINE-EXPERIMENT.md.
 *
 * Round 2 (`authgate-headline-v2`, ACTIVE): control (= round-1 winner) vs two
 * new challengers that probe different framings against the proven baseline:
 *   control     — t('jobBoard.gate.title'), the round-1 frictionless winner.
 *   free_unlock — cost-removal + immediacy ("unlock the full listing for free").
 *   apply_now   — goal-proximity toward applying ("see how to apply").
 *
 * Initial render is always control until PostHog loads (~200-400 ms cold).
 * The experiment's exposure metric should be `gate_view WHERE headline_variant
 * IS NOT NULL` so the brief unattributed window does not bias the outcome.
 *
 * ── Model experiment (orthogonal to the headline copy test) ──────────────────
 * `useAuthGateModelVariant` (flag `authgate-model-v1`) probes a *structural*
 * change rather than copy: round-2 headline arms came back inconclusive
 * (apply_now +1.99pp p=0.20, free_unlock +1.28pp p=0.41 over 30d), i.e. copy is
 * exhausted as a lever while the dominant drop is gate_view → engagement (~88%
 * of viewers never click any method; ~17% overall conversion). The `value_first`
 * arm reveals substantially more of the job description before the gate (the
 * control teaser is throttled to ~220 chars / ≤80px) to build information scent
 * + reciprocity. Tagged via the `gate_model` super-property; split the funnel by
 * it with `node scripts/query-authgate-experiment.mjs --prop gate_model`.
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

// ─── Model-level experiment (structural, not copy) ───────────────────────────

const MODEL_FLAG_KEY = 'authgate-model-v1';

export type AuthGateModel = 'control' | 'value_first';

function normalizeModel(raw: unknown): AuthGateModel | null {
  if (raw === 'control' || raw === 'value_first') return raw;
  return null;
}

/**
 * Resolves the active auth-gate *model* from the PostHog flag
 * `authgate-model-v1` and tags every subsequent event with `gate_model` so the
 * funnel can split by arm. Falls back to `control` (current behaviour) until
 * PostHog loads, or whenever the flag is absent/disabled — so the code is safe
 * to ship before the experiment is created.
 *
 *   control     — current gate: ~220-char / ≤80px description teaser.
 *   value_first — reveal much more of the description before the gate.
 */
export function useAuthGateModelVariant(): AuthGateModel {
  const [model, setModel] = useState<AuthGateModel>('control');

  useEffect(() => {
    const unsubscribe = onFeatureFlags(() => {
      const resolved = normalizeModel(getFeatureFlag(MODEL_FLAG_KEY));
      setModel(resolved ?? 'control');
      if (!resolved) return;
      registerSuperProperty('gate_model', resolved);
    });
    return unsubscribe;
  }, []);

  return model;
}
