const DECIMAL_INTEGER_RE = /^\d+$/;

export function incrementSessionPageViews(raw: string | null | undefined): number {
 if (typeof raw !== 'string' || !DECIMAL_INTEGER_RE.test(raw)) return 1;
 const current = Number(raw);
 return Number.isSafeInteger(current) && current < Number.MAX_SAFE_INTEGER ? current + 1 : 1;
}
