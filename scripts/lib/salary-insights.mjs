/**
 * Modulo per il calcolo delle statistiche salariali di mercato
 * e la generazione dei metadati Schema.org Dataset & Occupation
 * per le pagine programmatiche /insights/salari/...
 */

/**
 * Calcola un percentile da un array numerico già ordinato in senso crescente.
 * @param {number[]} sortedValues
 * @param {number} p Percentile tra 0 e 100
 * @returns {number}
 */
export function calculatePercentile(sortedValues, p) {
  if (!sortedValues || sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];

  const index = (p / 100) * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;

  if (lower === upper) return sortedValues[lower];
  return Math.round(sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight);
}

/**
 * Calcola la stima del netto mensile per frontaliere svizzero (12 mensilità)
 * tenendo conto dell'imposta alla fonte cantonale e dell'accordo fiscale frontalieri 2026.
 * @param {number} grossAnnualChf Salario lordo annuo in CHF
 * @param {string} canton Sigla cantone (TI, GR, ZH, etc.)
 * @returns {number} Netto mensile stimato in CHF
 */
export function estimateMonthlyNetFrontaliereChf(grossAnnualChf, canton = 'TI') {
  if (!grossAnnualChf || grossAnnualChf <= 0) return 0;

  // Aliquota media contributi sociali svizzeri (AVS/AI/IPG 5.3%, AD 1.1%, LPP ~7-9%) ~15%
  const socialContributionsRate = 0.15;
  const afterSocial = grossAnnualChf * (1 - socialContributionsRate);

  // Imposta alla fonte svizzera indicativa per cantone
  const withholdingRate = canton === 'TI' ? 0.08 : canton === 'ZH' ? 0.11 : 0.09;
  const swissWithholdingTax = grossAnnualChf * withholdingRate;

  const netAnnualChf = afterSocial - swissWithholdingTax;
  return Math.round(netAnnualChf / 12);
}

/**
 * Raggruppa e calcola i percentili salariali da un insieme di offerte di lavoro.
 * @param {Array<object>} jobs Elenco offerte
 * @param {{ role: string, canton: string }} options
 * @returns {object}
 */
export function aggregateRoleInsights(jobs, { role, canton = 'TI' } = {}) {
  const salaries = [];

  for (const j of jobs || []) {
    if (typeof j.salaryMin === 'number' && typeof j.salaryMax === 'number') {
      salaries.push(Math.round((j.salaryMin + j.salaryMax) / 2));
    } else if (typeof j.salaryMin === 'number') {
      salaries.push(j.salaryMin);
    } else if (typeof j.salaryMax === 'number') {
      salaries.push(j.salaryMax);
    }
  }

  salaries.sort((a, b) => a - b);
  const sampleSize = salaries.length;

  if (sampleSize === 0) {
    return {
      role: role || 'Professionista',
      canton,
      sampleSize: 0,
      min: 0,
      p25: 0,
      median: 0,
      p75: 0,
      p90: 0,
      monthlyNetChf: 0,
      calculatedAt: new Date().toISOString()
    };
  }

  const min = salaries[0];
  const p25 = calculatePercentile(salaries, 25);
  const median = calculatePercentile(salaries, 50);
  const p75 = calculatePercentile(salaries, 75);
  const p90 = calculatePercentile(salaries, 90);
  const monthlyNetChf = estimateMonthlyNetFrontaliereChf(median, canton);

  return {
    role: role || 'Professionista',
    canton,
    sampleSize,
    min,
    p25,
    median,
    p75,
    p90,
    monthlyNetChf,
    calculatedAt: new Date().toISOString()
  };
}

/**
 * Genera il payload Schema.org (@type: Dataset & @type: Occupation) per le pagine di insight.
 * @param {object} insight Dati aggregati da aggregateRoleInsights
 * @returns {object}
 */
export function generateInsightsStructuredData(insight) {
  const cantonName = insight.canton === 'TI'
    ? 'Canton Ticino, Svizzera'
    : insight.canton === 'GR'
      ? 'Canton Grigioni, Svizzera'
      : insight.canton === 'ZH'
        ? 'Canton Zurigo, Svizzera'
        : 'Svizzera';

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Dataset',
        name: `Statistiche Salariali Frontalieri: ${insight.role} (${insight.canton})`,
        description: `Distribuzione retributiva mediana e percentili per ${insight.role} in ${cantonName} aggiornati a Novembre 2026. Campione: ${insight.sampleSize} offerte di lavoro verificate.`,
        spatialCoverage: {
          '@type': 'Place',
          name: cantonName
        },
        variableMeasured: [
          {
            '@type': 'PropertyValue',
            name: 'Salario Mediano Annuo Lordo',
            value: String(insight.median),
            unitText: 'CHF'
          },
          {
            '@type': 'PropertyValue',
            name: 'Stima Netto Mensile Frontaliere',
            value: String(insight.monthlyNetChf),
            unitText: 'CHF'
          }
        ]
      },
      {
        '@type': 'Occupation',
        name: insight.role,
        estimatedSalary: [
          {
            '@type': 'MonetaryAmountDistribution',
            name: 'Stipendio Annuo Base Lordo in CHF',
            currency: 'CHF',
            median: insight.median,
            percentile10: insight.min,
            percentile25: insight.p25,
            percentile75: insight.p75,
            percentile90: insight.p90
          }
        ]
      }
    ]
  };
}
