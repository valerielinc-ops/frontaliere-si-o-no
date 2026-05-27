/**
 * weatherAlertEvaluator — evaluates AlertState[] against the
 * WEATHER_ALERT_CONFIG table. Pure function, table-driven (per
 * /plan-eng-review D8). Pure function = easy to unit test with mocked
 * snapshots.
 */

import type { AlertState, WeatherSnapshot } from './weather/types';
import { WEATHER_ALERT_CONFIG, type WeatherAlertConfig } from '../data/weatherAlertConfig';

export interface EvaluatedAlert {
  config: WeatherAlertConfig;
  state: AlertState;
}

/**
 * Run every configured alert through the snapshot's alerts map. Falls back
 * to dormant state when the snapshot has no entry (snapshot may have been
 * generated before the config existed, or before MeteoSwiss responded).
 */
export function evaluateAlerts(snapshot: WeatherSnapshot | null): EvaluatedAlert[] {
  return WEATHER_ALERT_CONFIG.map((config) => {
    const state = snapshot?.alerts[config.id] ?? makeDefaultDormantState(config);
    return { config, state };
  });
}

/**
 * Filter to active-only alerts, ordered by severity intent (snow > rain >
 * wind > thunderstorm > frost > heat > slipperiness). Useful for the hub
 * page's "active first" ordering per /plan-design-review D3.
 */
export function activeAlerts(snapshot: WeatherSnapshot | null): EvaluatedAlert[] {
  const order: Record<string, number> = {
    snow: 0, rain: 1, wind: 2, thunderstorm: 3, frost: 4, heat: 5, slipperiness: 6,
  };
  return evaluateAlerts(snapshot)
    .filter((a) => a.state.active)
    .sort((a, b) => (order[a.config.meteoSwissType] ?? 9) - (order[b.config.meteoSwissType] ?? 9));
}

export function dormantAlerts(snapshot: WeatherSnapshot | null): EvaluatedAlert[] {
  return evaluateAlerts(snapshot).filter((a) => !a.state.active);
}

function makeDefaultDormantState(config: WeatherAlertConfig): AlertState {
  return {
    alertId: config.id,
    active: false,
    trigger: 'none',
    confidence: 'low',
    source: 'snapshot-missing',
  };
}
