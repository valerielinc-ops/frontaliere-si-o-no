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
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 2); // 2-day lag for late-arriving data
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - daysBack);
  return { start: fmtDate(start), end: fmtDate(end) };
}

export function pathnameFromUrl(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}
