import {
 BONUS_CHILDREN_MAX,
 BONUS_CHILDREN_MIN,
 parseBonusProfileChildren,
} from '@/services/bonusCalculatorInput';

export { BONUS_CHILDREN_MAX, BONUS_CHILDREN_MIN };

export const parseProfileChildren = (value: unknown): number | null => parseBonusProfileChildren(value);
