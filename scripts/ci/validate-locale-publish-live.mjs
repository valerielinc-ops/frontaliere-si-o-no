#!/usr/bin/env node
/**
 * Smoke the locale homes named by the publish plan.
 *
 * This is intentionally a status-code check, not a content comparison: the
 * provenance plan proves build/CDN identity, while this observer proves that
 * both newly admitted and last-known-good stale locales remain servable after
 * the Pages publish.
 */
export const LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);

function text(value) {
  return value == null ? '' : String(value).trim();
}

function normalizeLocaleList(value) {
  if (!Array.isArray(value)) throw new Error('locale list must be a JSON array');
  const out = [];
  for (const item of value) {
    const locale = text(item).toLowerCase();
    if (!LOCALES.includes(locale)) throw new Error(`unsupported locale ${JSON.stringify(locale)}`);
    if (!out.includes(locale)) out.push(locale);
  }
  return out;
}

export function parseLocaleList(value, fallback = []) {
  if (Array.isArray(value)) return normalizeLocaleList(value);
  const raw = text(value);
  if (!raw) return normalizeLocaleList(fallback);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`locale list is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return normalizeLocaleList(parsed);
}

export function localeHomeUrl(baseUrl, locale) {
  const base = text(baseUrl).replace(/\/+$/, '');
  if (!base) throw new Error('live base URL is missing');
  if (!LOCALES.includes(locale)) throw new Error(`unsupported locale ${JSON.stringify(locale)}`);
  return locale === 'it' ? `${base}/` : `${base}/${locale}/`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchStatus(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      redirect: 'manual',
      headers: { 'cache-control': 'no-cache' },
      signal: controller.signal,
    });
    return { status: response.status };
  } catch (error) {
    return { status: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check all requested locale homes with bounded parallel retries.
 * Returns a structured verdict instead of exiting so unit tests and CI share
 * exactly the same classification.
 */
export async function validateLocaleHomes({
  baseUrl,
  healthyLocales = LOCALES,
  staleLocales = [],
  fetchImpl = globalThis.fetch,
  attempts = 12,
  intervalMs = 10_000,
  timeoutMs = 20_000,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('global fetch is unavailable');
  const healthy = parseLocaleList(healthyLocales, LOCALES);
  const stale = parseLocaleList(staleLocales);
  const locales = [...new Set([...healthy, ...stale])];
  if (!locales.length) throw new Error('publish plan contains no locale to smoke');
  const entries = locales.map((locale) => ({
    locale,
    classification: stale.includes(locale) ? 'stale-fallback' : 'healthy-publish',
    url: localeHomeUrl(baseUrl, locale),
  }));
  let last = [];
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    last = await Promise.all(entries.map(async (entry) => ({
      ...entry,
      ...(await fetchStatus(entry.url, fetchImpl, timeoutMs)),
    })));
    if (last.every((entry) => entry.status === 200)) {
      return { ok: true, attempts: attempt, entries: last };
    }
    if (attempt < Math.max(1, attempts)) await sleep(intervalMs);
  }
  return { ok: false, attempts: Math.max(1, attempts), entries: last };
}

function main() {
  const healthy = parseLocaleList(process.env.HEALTHY_LOCALES, LOCALES);
  const stale = parseLocaleList(process.env.STALE_LOCALES, []);
  const attempts = Number(process.env.LOCALE_SMOKE_ATTEMPTS || 12);
  const intervalMs = Number(process.env.LOCALE_SMOKE_INTERVAL_MS || 10_000);
  const timeoutMs = Number(process.env.LOCALE_SMOKE_TIMEOUT_MS || 20_000);
  validateLocaleHomes({
    baseUrl: process.env.LIVE_BASE_URL || 'https://frontaliereticino.ch',
    healthyLocales: healthy,
    staleLocales: stale,
    attempts,
    intervalMs,
    timeoutMs,
  }).then((verdict) => {
    for (const entry of verdict.entries) {
      const label = entry.classification === 'stale-fallback' ? 'STALE FALLBACK' : 'healthy publish';
      const detail = entry.status == null ? entry.error || 'request failed' : `HTTP ${entry.status}`;
      console.log(`[locale-live] ${label} ${entry.locale} ${entry.url} -> ${detail}`);
    }
    if (!verdict.ok) {
      console.error('::error::one or more admitted/stale locale homes did not serve HTTP 200');
      process.exitCode = 1;
    } else {
      console.log(`[locale-live] all locale homes served HTTP 200 after ${verdict.attempts} attempt(s)`);
    }
  }).catch((error) => {
    console.error(`::error::locale live smoke could not run: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
