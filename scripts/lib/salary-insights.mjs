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

const INSIGHT_COPY = {
  it: {
    datasetName: 'Distribuzione salariale osservata',
    description: (role, canton, count) => `Distribuzione dei range annuali lordi in CHF dichiarati negli annunci disponibili per ${role} in ${canton}. Campione: ${count} annunci con salario dichiarato.`,
    median: 'Salario lordo annuo mediano dichiarato',
    salaryDistribution: 'Stipendio annuo lordo osservato in CHF',
    role: 'Lavoratore in Ticino',
    switzerland: 'Svizzera',
  },
  en: {
    datasetName: 'Observed salary distribution',
    description: (role, canton, count) => `Distribution of annual gross salary ranges in CHF reported in available listings for ${role} in ${canton}. Sample: ${count} listings with reported salary ranges.`,
    median: 'Reported median annual gross salary',
    salaryDistribution: 'Observed annual gross salary in CHF',
    role: 'Worker in Ticino',
    switzerland: 'Switzerland',
  },
  de: {
    datasetName: 'Beobachtete Gehaltsverteilung',
    description: (role, canton, count) => `Verteilung der in verfügbaren Stellenanzeigen für ${role} in ${canton} gemeldeten jährlichen Bruttolohnspannen in CHF. Stichprobe: ${count} Anzeigen mit gemeldeter Lohnspanne.`,
    median: 'Gemeldeter jährlicher Bruttomedianlohn',
    salaryDistribution: 'Beobachtetes jährliches Bruttogehalt in CHF',
    role: 'Beschäftigte im Tessin',
    switzerland: 'Schweiz',
  },
  fr: {
    datasetName: 'Distribution salariale observée',
    description: (role, canton, count) => `Distribution des fourchettes annuelles brutes en CHF déclarées dans les annonces disponibles pour ${role} au ${canton}. Échantillon : ${count} annonces avec fourchette déclarée.`,
    median: 'Salaire brut annuel médian déclaré',
    salaryDistribution: 'Salaire brut annuel observé en CHF',
    role: 'Travailleur au Tessin',
    switzerland: 'Suisse',
  },
};

const CANTON_NAMES = {
  TI: { it: 'Canton Ticino, Svizzera', en: 'Canton Ticino, Switzerland', de: 'Kanton Tessin, Schweiz', fr: 'Canton du Tessin, Suisse' },
  GR: { it: 'Canton Grigioni, Svizzera', en: 'Canton of Graubünden, Switzerland', de: 'Kanton Graubünden, Schweiz', fr: 'Canton des Grisons, Suisse' },
  ZH: { it: 'Canton Zurigo, Svizzera', en: 'Canton Zurich, Switzerland', de: 'Kanton Zürich, Schweiz', fr: 'Canton de Zurich, Suisse' },
};

export function getSalaryInsightsCopy(locale = 'it') {
  return INSIGHT_COPY[locale] || INSIGHT_COPY.it;
}

import { reportedAnnualChfSalaryRange } from './reported-salary.mjs';

/**
 * Calcola i percentili dai soli importi annuali CHF puntuali e dichiarati.
 * Gli annunci con intervalli non vengono convertiti in midpoint sintetici.
 * @param {Array<object>} jobs Elenco offerte
 * @param {{ role: string, canton: string }} options
 * @returns {object}
 */
export function aggregateRoleInsights(jobs, { role, canton = 'TI' } = {}) {
  const salaries = [];

  for (const job of jobs || []) {
    const salary = reportedAnnualChfSalaryRange(job);
    if (salary && salary.min === salary.max) salaries.push(salary.min);
  }

  salaries.sort((a, b) => a - b);
  const sampleSize = salaries.length;

  if (sampleSize === 0) {
    return {
      role: role || 'Professionista',
      canton,
      sampleSize: 0,
      min: 0,
      p10: null,
      p25: null,
      median: null,
      p75: null,
      p90: null,
      calculatedAt: new Date().toISOString()
    };
  }

  const min = salaries[0];
  const p10 = calculatePercentile(salaries, 10);
  const p25 = calculatePercentile(salaries, 25);
  const median = calculatePercentile(salaries, 50);
  const p75 = calculatePercentile(salaries, 75);
  const p90 = calculatePercentile(salaries, 90);

  return {
    role: role || 'Professionista',
    canton,
    sampleSize,
    min,
    p10,
    p25,
    median,
    p75,
    p90,
    calculatedAt: new Date().toISOString()
  };
}

/**
 * Genera il payload Schema.org (@type: Dataset & @type: Occupation) per le pagine di insight.
 * @param {object} insight Dati aggregati da aggregateRoleInsights
 * @returns {object}
 */
export function generateInsightsStructuredData(insight, locale = 'it') {
  const copy = getSalaryInsightsCopy(locale);
  const cantonName = CANTON_NAMES[insight.canton]?.[locale] || copy.switzerland;

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Dataset',
        name: `${copy.datasetName}: ${insight.role} (${insight.canton})`,
        description: copy.description(insight.role, cantonName, insight.sampleSize),
        spatialCoverage: {
          '@type': 'Place',
          name: cantonName
        },
        variableMeasured: [
          {
            '@type': 'PropertyValue',
            name: copy.median,
            value: String(insight.median),
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
            name: copy.salaryDistribution,
            currency: 'CHF',
            median: insight.median,
            percentile10: insight.p10,
            percentile25: insight.p25,
            percentile75: insight.p75,
            percentile90: insight.p90
          }
        ]
      }
    ]
  };
}
