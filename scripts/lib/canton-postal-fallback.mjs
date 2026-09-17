/**
 * Representative Swiss postal codes used only when a source gives a canton
 * but omits the job's postal code. They are canton-level safe defaults, not
 * employer headquarters and never replace a source-backed postal code.
 */
export const CANTON_POSTAL_FALLBACK = {
  AG: '5000', AI: '9050', AR: '9100', BE: '3000', BL: '4410', BS: '4000',
  FR: '1700', GE: '1200', GL: '8750', GR: '7000', JU: '2800', LU: '6000',
  NE: '2000', NW: '6370', OW: '6060', SG: '9000', SH: '8200', SO: '4500',
  SZ: '6430', TG: '8500', TI: '6900', UR: '6460', VD: '1000', VS: '3900',
  ZG: '6300', ZH: '8000',
};

export function getCantonPostalFallback(canton = '') {
  return CANTON_POSTAL_FALLBACK[String(canton || '').toUpperCase()] || '';
}
