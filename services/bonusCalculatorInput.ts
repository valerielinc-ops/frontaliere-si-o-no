const WHOLE_NUMBER_RE = /^(?:0|[1-9]\d*)$/;

export const BONUS_CHILDREN_MIN = 0;
export const BONUS_CHILDREN_MAX = 10;
export const BONUS_AMOUNT_MAX = 1_000_000;
export const BONUS_RATE_MIN = 0.01;
export const BONUS_RATE_MAX = 10;

export function parseBonusProfileChildren(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const value = raw === '4+' ? '4' : raw;
  if (!WHOLE_NUMBER_RE.test(value)) return null;
  const children = Number(value);
  return Number.isSafeInteger(children) && children >= BONUS_CHILDREN_MIN && children <= BONUS_CHILDREN_MAX
    ? children
    : null;
}

export function clampBonusNumber(raw: unknown, fallback: number, min = 0, max = BONUS_AMOUNT_MAX): number {
  if (typeof raw === 'string' && raw.trim() === '') return fallback;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function clampBonusInteger(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw === 'string' && raw.trim() === '') return fallback;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
