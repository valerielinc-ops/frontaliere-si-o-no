/**
 * publicConfig.js — the browser-safe allowlist of Remote Config parameters.
 *
 * The Firebase client SDK's `fetchAndActivate` downloads the ENTIRE Remote
 * Config template into every visitor's browser (readable in IndexedDB), which
 * leaked all server secrets (ESP keys, AdSense/GSC tokens, AI provider keys…).
 * Instead the client now fetches ONLY this allowlist via `getPublicConfig`
 * (functions/index.js), read server-side. Everything not listed here never
 * reaches the browser — default-deny, so a new RC secret can't leak by accident.
 *
 * Keys tagged PHASE-2 are still read by client code (chatbot, exchange rates,
 * feedback issue creation) and stay until those calls are proxied server-side;
 * removing them from this list is what finishes de-secreting the browser.
 */

import { getRemoteConfigValue } from './remoteConfigSecrets.js';
import { PUBLIC_CONFIG_KEYS } from './publicConfigKeys.js';

export { PUBLIC_CONFIG_KEYS };

/**
 * Resolve the allowlisted RC params to a `{ KEY: value }` object. Empty values
 * are dropped so the client falls back to its built-in defaults for them.
 */
export async function getPublicConfigValues() {
  const entries = await Promise.all(
    PUBLIC_CONFIG_KEYS.map(async (key) => [key, await getRemoteConfigValue(key)]),
  );
  return Object.fromEntries(entries.filter(([, value]) => value !== ''));
}
