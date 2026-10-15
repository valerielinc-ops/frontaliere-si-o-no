/**
 * Build-time data module for the CHF/EUR exchange SSG vertical (epic #4452).
 *
 * URL structure / amount set / path builders live in the BROWSER-SAFE shared
 * module services/exchangeSsgPaths.ts (one definition, consumed by both the
 * SPA cross-links and this build path — AGENTS.md Non-Negotiable #6). This
 * module adds the node-only parts:
 *   - the committed snapshot loader (data/exchange-rate-snapshot.json,
 *     refreshed daily by .github/workflows/update-exchange-history.yml via
 *     scripts/snapshot-exchange-history.mjs — build never hits Firestore)
 *   - the precompiled path Set used by searchConsoleCompat.ts's self-map
 *     (module-load Set → O(1) per URL inside the 150k+-path compat loop).
 */

import fs from 'node:fs';
import np from 'node:path';
import {
  EXCHANGE_LOCALES,
  EXCHANGE_AMOUNTS,
  buildExchangeHubPath,
  buildExchangeAmountPath,
} from '../services/exchangeSsgPaths';

export {
  EXCHANGE_LOCALES,
  EXCHANGE_AMOUNTS,
  EXCHANGE_LOCALE_PREFIX,
  EXCHANGE_SECTION_SLUG,
  exchangeAmountSlug,
  buildExchangeHubPath,
  buildExchangeAmountPath,
  buildNearestExchangeAmountPath,
  type ExchangeLocale,
} from '../services/exchangeSsgPaths';

// ── Snapshot loader ──────────────────────────────────────────────────────────

export interface ExchangeWindowStats {
  startRate: number;
  startDate: string;
  min: number;
  max: number;
  avg: number;
  changePct: number;
}

export interface ExchangePoint {
  date: string;
  rate: number;
}

export interface ExchangeSnapshot {
  updatedAt: string;
  rateDate: string;
  currentRate: number;
  source: string;
  windows: Record<'30' | '90' | '365', ExchangeWindowStats>;
  sparkline: ExchangePoint[];
  monthly: ExchangePoint[];
}

/** Plausibility band mirrored from scripts/snapshot-exchange-history.mjs. */
function isPlausibleRate(rate: unknown): rate is number {
  return typeof rate === 'number' && Number.isFinite(rate) && rate >= 0.6 && rate <= 1.6;
}

/**
 * Load + validate the committed snapshot. Returns null when the file is
 * missing or malformed — the plugin then skips emission with a warning
 * (graceful degrade, mirrors borderWaitPagesPlugin's missing-snapshot path)
 * rather than failing the whole build.
 */
export function loadExchangeSnapshot(rootDir: string): ExchangeSnapshot | null {
  const p = np.resolve(rootDir, 'data', 'exchange-rate-snapshot.json');
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as ExchangeSnapshot;
    if (!isPlausibleRate(raw.currentRate)) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw.rateDate))) return null;
    if (!Array.isArray(raw.sparkline) || raw.sparkline.length < 10) return null;
    if (!Array.isArray(raw.monthly) || raw.monthly.length < 3) return null;
    for (const key of ['30', '90', '365'] as const) {
      const w = raw.windows?.[key];
      if (!w || !isPlausibleRate(w.startRate)) return null;
    }
    return raw;
  } catch {
    return null;
  }
}

// ── searchConsoleCompat self-map support ─────────────────────────────────────

/**
 * Every path this vertical emits (hub + amounts × 4 locales), WITHOUT the
 * trailing slash (searchConsoleCompat normalizes paths by stripping it).
 * Precompiled ONCE at module load — never build Sets per call inside the
 * compat loop (tests/search-console-compat.test.ts resolves 150k+ paths).
 */
const EXCHANGE_SSG_PATHS: ReadonlySet<string> = (() => {
  const s = new Set<string>();
  for (const locale of EXCHANGE_LOCALES) {
    s.add(buildExchangeHubPath(locale).replace(/\/$/, ''));
    for (const amount of EXCHANGE_AMOUNTS) {
      s.add(buildExchangeAmountPath(locale, amount).replace(/\/$/, ''));
    }
  }
  return s;
})();

/**
 * O(1) membership check for the compat self-map. `path` must be normalized
 * (leading slash, no trailing slash) — searchConsoleCompat's normalizePath
 * output shape.
 */
export function isExchangeSsgPath(path: string): boolean {
  return EXCHANGE_SSG_PATHS.has(path);
}
