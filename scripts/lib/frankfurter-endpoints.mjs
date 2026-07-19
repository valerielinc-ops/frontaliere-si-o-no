/**
 * Frankfurter API base endpoints (free ECB reference rates, no key).
 *
 * ONE definition shared by scripts/update-exchange-history.mjs (Firestore
 * history cron) and scripts/snapshot-exchange-history.mjs (committed SSG
 * snapshot) — the literal array used to be duplicated in both scripts
 * (AGENTS.md Non-Negotiable #6: a constant duplicated in ≥2 files WILL
 * drift when one endpoint dies and only one copy gets updated).
 *
 * Order matters: `.dev` is the canonical host, `.app` the legacy fallback.
 */
export const FRANKFURTER_ENDPOINTS = [
  'https://api.frankfurter.dev',
  'https://api.frankfurter.app',
];
