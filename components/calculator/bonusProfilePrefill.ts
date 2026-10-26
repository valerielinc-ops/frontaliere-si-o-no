export const BONUS_CHILDREN_MIN = 0;
export const BONUS_CHILDREN_MAX = 10;

export const parseProfileChildren = (value: unknown): number | null => {
 if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
 const count = Number(value);
 return Number.isInteger(count) && count >= BONUS_CHILDREN_MIN && count <= BONUS_CHILDREN_MAX
 ? count
 : null;
};
