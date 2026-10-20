import { settledWindow } from '../analytics-settled-window.mjs';

// safe(fn) — guarantees source helpers never throw. Returns
// { ok: true, ...result } or { ok: false, reason }.

export async function safe(name, fn) {
  try {
    const result = await fn();
    if (result && typeof result === 'object' && 'ok' in result) return result;
    return { ok: true, ...(result || {}) };
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    return { ok: false, reason: `[${name}] ${reason}` };
  }
}

export function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

export function windowDates(daysBack) {
  return settledWindow({ days: daysBack });
}

export function pathnameFromUrl(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}
