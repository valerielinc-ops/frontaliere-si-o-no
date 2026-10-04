/** Official BAG CSV codes before and after the 2027 publication change. */
export const BAG_AGE_CLASSES = Object.freeze({
  'AKL-KIN': 'KIN', 'AKL-JUG': 'JUG', 'AKL-ERW': 'ERW',
  AKA_01_KIN: 'KIN', AKA_02_JUG: 'JUG', AKA_03_ERW: 'ERW',
});
export const BAG_ACCIDENT_COVER = Object.freeze({
  'MIT-UNF': 'withAccident', 'OHN-UNF': 'withoutAccident',
  MIT_UNF: 'withAccident', OHN_UNF: 'withoutAccident',
});
export const BAG_MODELS = Object.freeze({
  'TAR-BASE': 'standard', 'TAR-HAM': 'hausarzt', 'TAR-HMO': 'hmo', 'TAR-DIV': 'telmed',
  BASE: 'standard', PRAXIS: 'praxis', TEL_DIG: 'tel_dig', PHARM: 'pharm', FLEX: 'flex',
});
export function bagFranchiseAmount(code) {
  const digits = typeof code === 'string' ? code.match(/(?:-|_)(\d+)$/)?.[1] : undefined;
  return digits === undefined ? NaN : Number(digits);
}
export function bagSwissRegion(code) {
  const match = typeof code === 'string' ? code.match(/^(?:PR-REG CH|PR_REG_)(\d+)$/) : null;
  return match ? `PR-REG CH${Number(match[1])}` : null;
}

/** Ordinary child tariff; family-size discounts need a separate eligibility input. */
export function isOrdinaryBagChildTier(row) {
  return BAG_AGE_CLASSES[row.Altersklasse] !== 'KIN' || !row.Altersuntergruppe || row.Altersuntergruppe === 'K1';
}
