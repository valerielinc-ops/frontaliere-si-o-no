/**
 * Swiss Salary Benchmark Lookup & Negotiation Service.
 *
 * Powered by the native USTAT 2024 (Rilevazione svizzera della struttura dei salari)
 * and official BFS Grossregion wage indexes across all 26 Swiss Cantons.
 *
 * Provides realistic Swiss salary benchmarks (in CHF gross/year and CHF/month on 13 months)
 * adjusted for all Swiss Cantons, sectors, seniority tiers, and border frontalieri dynamics.
 * Generates tailor-made negotiation scripts and recruiter questions for cross-border candidates.
 */

import {
  estimateSwissSalary,
  CANTON_NAMES,
  normalizeSalaryCantonCode,
  inferSeniorityTier,
} from '../lib/salaryEstimation.js';

export { CANTON_NAMES, inferSeniorityTier };

/**
 * Maps common job titles to normalized role keys.
 * @param {string} roleTitle
 * @returns {string}
 */
export function matchRoleKey(roleTitle) {
  const t = String(roleTitle || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  if (/\b(cloud|devops|sre|sistemista|network|infrastruttura)\b/.test(t)) {
    return 'devops_cloud_engineer';
  }
  if (/\b(software|sviluppatore|sviluppatrice|developer|dev|programmatore|programmatrice|frontend|backend|full[- ]?stack|react|node|web|informatica|it|data engineer)\b/.test(t)) {
    return 'software_engineer';
  }
  if (/\b(finan\w*|banc\w*|account\w*|contabil\w*|controller|credit\w*|analyst|risk|audit|wealth|tax)\b/.test(t)) {
    return 'financial_analyst';
  }
  if (/\b(pharma\w*|farmac\w*|chimic\w*|lab\w*|biotech\w*|qa|qc|regulatory|scienz\w*|controllo qualita)\b/.test(t)) {
    return 'pharma_specialist';
  }
  if (/\b(mecc\w*|automaz\w*|elettr\w*|industr\w*|produzion\w*|progettista|ingegner\w*|tecnic\w*|disegnatore)\b/.test(t)) {
    return 'mechanical_engineer';
  }
  if (/\b(inferm\w*|sanit\w*|oss|medic\w*|cura|clinic\w*|terap\w*|fisioter\w*|nurse|healthcare)\b/.test(t)) {
    return 'nurse_healthcare';
  }

  return 'general_office';
}

/**
 * Looks up Swiss salary benchmark given role, canton, and seniority.
 * Uses the official 2024 USTAT RSS + BFS Grossregion engine across all 26 Swiss cantons.
 *
 * @param {object} params
 * @param {string} params.roleTitle
 * @param {string} [params.canton='TI']
 * @param {string} [params.category]
 * @param {'junior'|'mid'|'senior'|'lead'} [params.seniority]
 * @param {number} [params.yearsExperience=0]
 * @param {boolean} [params.applyFrontialieriDiscount=false]
 * @returns {object}
 */
export function lookupSalaryBenchmark({
  roleTitle,
  canton = 'TI',
  category,
  seniority,
  yearsExperience = 0,
  applyFrontialieriDiscount = false,
}) {
  const normCanton = normalizeSalaryCantonCode(canton);
  const roleKey = category || matchRoleKey(roleTitle);
  const resolvedSeniority = seniority || inferSeniorityTier(roleTitle, yearsExperience);

  const estimate = estimateSwissSalary(
    {
      title: roleTitle,
      category: roleKey,
      canton: normCanton,
      seniority: resolvedSeniority,
      yearsExperience,
    },
    { applyFrontialieriDiscount }
  );

  const p25Annual = estimate.minValue;
  const medianAnnual = estimate.median;
  const p75Annual = estimate.maxValue;

  return {
    currency: 'CHF',
    roleKey,
    sectorName: estimate.sectorName,
    industry: estimate.sectorName,
    seniority: estimate.level,
    canton: normCanton,
    cantonName: CANTON_NAMES[normCanton] || `Cantone ${normCanton}`,
    cantonMultiplier: estimate.cantonFactor,
    frontialieriAdjusted: estimate.frontialieriAdjusted,
    annual: {
      p25: p25Annual,
      median: medianAnnual,
      p75: p75Annual,
    },
    monthly13: {
      p25: Math.round(p25Annual / 13),
      median: Math.round(medianAnnual / 13),
      p75: Math.round(p75Annual / 13),
    },
    rangeFormatted: `CHF ${p25Annual.toLocaleString('it-CH')} - ${p75Annual.toLocaleString('it-CH')}`,
    medianFormatted: `CHF ${medianAnnual.toLocaleString('it-CH')}`,
  };
}

/**
 * Generates actionable salary interview briefing and negotiation scripts for candidates.
 *
 * @param {object} benchmark - output of lookupSalaryBenchmark
 * @param {string} [roleTitle='']
 * @returns {{ advice: string, deferralScript: string, recruiterQuestions: string[] }}
 */
export function formatSalaryInterviewBriefing(benchmark, roleTitle = '') {
  const cantonStr = benchmark.cantonName;
  const rangeStr = benchmark.rangeFormatted;
  const medianStr = benchmark.medianFormatted;
  const roleDisplay = roleTitle || benchmark.sectorName || benchmark.roleKey;

  const cantonSpecifics = benchmark.canton === 'TI'
    ? 'Nel Canton Ticino vigono il salario minimo cantonale e contratti collettivi CCL in diversi settori; è fondamentale ancorare le aspettative al benchmark di mercato per evitare penalizzazioni salariali.'
    : benchmark.canton === 'ZH' || benchmark.canton === 'BS'
    ? `Nel ${cantonStr} i livelli retributivi risentono del costo della vita più elevato e del fattore regionale BFS (>+25% rispetto al Ticino).`
    : `In ${cantonStr} si applicano i parametri salariali della regione con contratti svizzeri standard generalmente basati su 13 mensilità.`;

  const advice = `Per una posizione di ${roleDisplay} in ${cantonStr} (${benchmark.seniority}), il benchmark di mercato svizzero si colloca tra ${rangeStr} lordi/anno (mediana a ${medianStr}). ${cantonSpecifics} Nei colloqui in Svizzera, per un lavoratore frontaliere è consigliabile ancorare le aspettative all'estremità medio-alta di questa fascia per evitare svalutazioni salariali, considerando che il contratto standard svizzero prevede solitamente la 13esima mensilità.`;

  const deferralScript = `In questa fase iniziale sono concentrato soprattutto sulla comprensione delle sfide tecniche e degli obiettivi del team. In base alle mie ricerche e al valore che posso portare al progetto, per un ruolo simile in ${cantonStr} considero congruo un range tra ${rangeStr} annui lordi, ma sono pronto a discutere una proposta complessiva che includa benefit, welfare aziendale e piano previdenziale LPP.`;

  const recruiterQuestions = [
    'Qual è il range retributivo previsto dall\'azienda per questa specifica posizione?',
    'Il contratto prevede la 13esima mensilità o un piano di bonus variabile legato a obiettivi individuali/aziendali?',
    'L\'azienda offre agevolazioni per il trasporto transfrontaliero, welfare o contributi alla cassa pensione LPP superiori al minimo di legge?',
  ];

  return {
    advice,
    deferralScript,
    recruiterQuestions,
  };
}
