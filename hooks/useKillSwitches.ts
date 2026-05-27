/**
 * useKillSwitches — live Firebase Remote Config gate for the 5 SEO feature
 * internal-linking surfaces.
 *
 * When a flag is toggled to `true` in the Firebase Remote Config console, the
 * next SPA render within the RC cache window (~1 minute in production) hides
 * every internal link to the corresponding feature. Static HTML pages in
 * dist/ remain reachable — Google doesn't immediately de-index them — but the
 * SPA link graph closes, which cuts internal-link equity and user-funnelled
 * traffic to that feature.
 *
 * Default-safe: if Remote Config fails to load (ad-blocker, offline, network
 * error), every flag resolves to `false`, i.e. links stay SHOWN. Hiding
 * everything on RC error would amplify a transient failure into a site-wide
 * SEO regression.
 *
 * Runtime (this hook) is intentionally a separate layer from the build-time
 * `SKIP_*` env gates. Env gates stop the static HTML from being generated at
 * all (permanent, requires redeploy to re-enable). Runtime kill-switches only
 * close the SPA link graph — zero deploy required to flip.
 */

import { useEffect, useState } from 'react';

export type KillSwitchKey =
  | 'fuelDaily'
  | 'healthPremiums'
  | 'jobMarket'
  | 'weeklyEmployers'
  | 'orphanLandings';

export type KillSwitchState = Readonly<Record<KillSwitchKey, boolean>>;

/**
 * Canonical mapping from the logical kill-switch key to the Firebase Remote
 * Config parameter name. Keep these in sync with `REMOTE_CONFIG_DEFAULTS` in
 * `services/firebase.ts`.
 */
export const KILL_SWITCH_RC_KEYS: Readonly<Record<KillSwitchKey, string>> = {
  fuelDaily: 'KILL_FUEL_DAILY_LINKS',
  healthPremiums: 'KILL_HEALTH_PREMIUMS_LINKS',
  jobMarket: 'KILL_JOB_MARKET_LINKS',
  weeklyEmployers: 'KILL_WEEKLY_EMPLOYERS_LINKS',
  orphanLandings: 'KILL_ORPHAN_LANDINGS_LINKS',
} as const;

const DEFAULT_STATE: KillSwitchState = {
  fuelDaily: false,
  healthPremiums: false,
  jobMarket: false,
  weeklyEmployers: false,
  orphanLandings: false,
} as const;

function parseBooleanFlag(value: string | undefined | null): boolean {
  if (value == null) return false;
  return value.trim().toLowerCase() === 'true';
}

/**
 * React hook. Returns the current kill-switch state.
 *
 * First render returns {@link DEFAULT_STATE} (all `false`) so the SPA never
 * flashes a hidden state while RC is loading. Once Remote Config resolves,
 * the state updates and the component re-renders.
 */
export function useKillSwitches(): KillSwitchState {
  const [state, setState] = useState<KillSwitchState>(DEFAULT_STATE);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const { getConfigValue } = await import('@/services/firebase');
        const entries = await Promise.all(
          (Object.keys(KILL_SWITCH_RC_KEYS) as KillSwitchKey[]).map(async (key) => {
            try {
              const raw = await getConfigValue(KILL_SWITCH_RC_KEYS[key]);
              return [key, parseBooleanFlag(raw)] as const;
            } catch {
              // Per-key fallback: any RC read failure is default-safe.
              return [key, false] as const;
            }
          }),
        );
        if (cancelled) return;
        const next: Record<KillSwitchKey, boolean> = { ...DEFAULT_STATE };
        for (const [key, value] of entries) {
          next[key] = value;
        }
        setState(next);
      } catch {
        // Module-level fallback: firebase import failed. Stay on defaults.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
