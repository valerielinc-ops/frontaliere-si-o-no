/**
 * Telegram broadcast channel — public link config.
 *
 * The channel URL is a build-time PUBLIC value, injected as
 * `VITE_TELEGRAM_CHANNEL_URL` (mapped from Firebase Remote Config by
 * scripts/load-rc-env.mjs). It is EMPTY until the owner creates the channel, so
 * every consumer MUST gate on `isTelegramChannelConfigured()` and render
 * nothing when it is unset — the site never shows a dead link.
 *
 * The bot token / channel id used by the poster (scripts/post-to-telegram.mjs)
 * are server-only and deliberately NOT exposed here.
 */

/** The configured public channel URL (e.g. `https://t.me/frontaliereticino`) or ''. */
export const TELEGRAM_CHANNEL_URL: string = (import.meta.env.VITE_TELEGRAM_CHANNEL_URL ?? '').trim();

/** True only when a well-formed public Telegram channel URL is configured. */
export function isTelegramChannelConfigured(): boolean {
  return /^https:\/\/t\.me\/[A-Za-z0-9_+-]+\/?$/.test(TELEGRAM_CHANNEL_URL);
}
