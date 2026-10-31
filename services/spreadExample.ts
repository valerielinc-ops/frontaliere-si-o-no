// Margini dell'esempio didattico sullo spread: banca 2,66%, Wise 0,25% come nel testo.
const EXAMPLE_BANK_SPREAD = 0.0266;
const EXAMPLE_WISE_SPREAD = 0.0025;

/** Cifre dell'esempio sullo spread, ricavate dal tasso mostrato in pagina. */
export function buildSpreadExample(rate: number, locale: string): Record<string, string> {
 const bank = rate * (1 - EXAMPLE_BANK_SPREAD);
 const wise = rate * (1 - EXAMPLE_WISE_SPREAD);
 const format = (value: number, digits: number) => value.toLocaleString(locale, {
  minimumFractionDigits: digits,
  maximumFractionDigits: digits,
 });
 return {
  real: format(rate, 4),
  bank: format(bank, 4),
  diff: format(rate - bank, 4),
  spread: format(EXAMPLE_BANK_SPREAD * 100, 2),
  wise: format(wise, 4),
  savings: format((wise - bank) * 1000, 2),
 };
}
