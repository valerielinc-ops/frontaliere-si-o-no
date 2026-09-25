/**
 * Auth-gate headline A/B test wiring.
 *
 * Backed by the Firebase Remote Config parameter
 * `AUTHGATE_HEADLINE_VARIANT`. The parameter controls the active arm globally;
 * an unknown/missing value fails closed to the promoted control copy.
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
 * holds the apply_now copy and the old experiment is closed, so every viewer
 * sees the promoted headline via the `control` fall-back. The
 * `CHALLENGER_HEADLINES` map below is retained as the last round's config for
 * a future round-3 (redefine the arms + reactivate the flag to reuse it).
 *
 * Round 3 is NOT run through this module: `jobgate-v3` (randomised, multi-arm,
 * layout + copy) lives in services/jobGateExperiment.ts. While a visitor is
 * enrolled there, JobBoard tags the gate events with the v3 id/arm instead of
 * this headline variant.
 *
 * Initial render is always control until Remote Config loads. The active arm
 * can be changed without a new deployment from Firebase Remote Config.
 */

import { useEffect, useState } from 'react';
import { getConfigValue } from './firebase';

export const AUTHGATE_HEADLINE_RC_KEY = 'AUTHGATE_HEADLINE_VARIANT';

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
 * Returns the headline + variant for the current Remote Config assignment. Pass the
 * control headline (typically `t('jobBoard.gate.title')`) so this hook can
 * fall back without duplicating the i18n key.
 */
export function useAuthGateHeadlineVariant(
  locale: string,
  controlHeadline: string,
): UseAuthGateHeadlineVariantResult {
  const [variant, setVariant] = useState<AuthGateVariant>('control');

  useEffect(() => {
    let cancelled = false;
    getConfigValue(AUTHGATE_HEADLINE_RC_KEY)
      .then((raw) => {
        if (cancelled) return;
        const resolved = normalizeVariant(raw.trim().toLowerCase());
        setVariant(resolved ?? 'control');
      })
      .catch(() => {
        if (!cancelled) setVariant('control');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const headline = variant === 'control' ? controlHeadline : resolveChallenger(variant, locale);
  return { variant, headline };
}
