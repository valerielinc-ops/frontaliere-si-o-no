/**
 * Swiss Salary Benchmark Lookup & Negotiation Service,
 * inspired by ai-job-search salary_lookup.py and convert_salary_excel.py (MIT).
 *
 * Provides realistic Swiss salary benchmarks (in CHF gross/year and CHF/month on 13 months)
 * adjusted for Swiss Cantons (Ticino, Grigioni, Zurigo, Basilea, etc.) and seniority.
 * Generates tailor-made negotiation scripts and recruiter questions for cross-border candidates.
 */

import SWISS_BENCHMARKS_DATA from '../data/salary-benchmarks/swiss-salary-benchmarks.json' with { type: 'json' };

export const CANTON_NAMES = Object.freeze({
  TI: 'Canton Ticino',
  GR: 'Canton Grigioni',
  VS: 'Canton Vallese',
  ZH: 'Canton Zurigo',
  BS: 'Canton Basilea Città',
  BE: 'Canton Berna',
  GE: 'Canton Ginevra',
});

/**
 * Infer seniority tier from title or numerical years of experience.
 * @param {string} title
 * @param {number} [years=0]
 * @returns {'junior'|'mid'|'senior'|'lead'}
 */
export function inferSeniorityTier(title, years = 0) {
  const t = String(title || '').toLowerCase();
  if (/\b(lead|principal|head|director|manager|responsabile)\b/.test(t) || years >= 10) {
    return 'lead';
  }
  if (/\b(senior|sr\.?|esperto|guida)\b/.test(t) || years >= 5) {
    return 'senior';
  }
  if (/\b(junior|jr\.?|trainee|apprendista|entry|stagista)\b/.test(t) || (years > 0 && years < 3)) {
    return 'junior';
  }
  return 'mid';
}

/**
 * Normalizes text for keyword matching.
 * @param {string} text
 * @returns {string}
 */
function normalizeText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Identifies the best role key from a job title.
 * @param {string} roleTitle
 * @returns {string}
 */
export function matchRoleKey(roleTitle) {
  const normalized = normalizeText(roleTitle);
  const roles = SWISS_BENCHMARKS_DATA?.roles || {};

  for (const [key, roleDef] of Object.entries(roles)) {
    for (const titleCandidate of roleDef.titles || []) {
      if (normalized.includes(normalizeText(titleCandidate))) {
        return key;
      }
    }
  }

  // Broad keyword heuristics
  if (/\b(software|sviluppatore|sviluppatrice|developer|dev|programmatore|programmatrice|frontend|backend|full[- ]?stack|react|node|web|engineer|ingegnere informatico)\b/.test(normalized)) {
    return 'software_engineer';
  }
  if (/\b(cloud|devops|sre|sistemista|network|infrastruttura)\b/.test(normalized)) {
    return 'devops_cloud_engineer';
  }
  if (/\b(finan|banc|account|contabil|controller|credit|analyst|risk)\b/.test(normalized)) {
    return 'financial_analyst';
  }
  if (/\b(pharma|farmac|chimic|lab|biotech|qa|qc)\b/.test(normalized)) {
    return 'pharma_specialist';
  }
  if (/\b(mecc|automaz|elettr|industr|produzione|progettista)\b/.test(normalized)) {
    return 'mechanical_engineer';
  }
  if (/\b(inferm|sanit|oss|medico|medica|cura|clinica|terap)\b/.test(normalized)) {
    return 'nurse_healthcare';
  }

  return 'general_office';
}

/**
 * Looks up Swiss salary benchmark given role, canton, and seniority.
 * @param {object} params
 * @param {string} params.roleTitle
 * @param {string} [params.canton='TI']
 * @param {'junior'|'mid'|'senior'|'lead'} [params.seniority]
 * @param {number} [params.yearsExperience=0]
 * @returns {object}
 */
export function lookupSalaryBenchmark({
  roleTitle,
  canton = 'TI',
  seniority,
  yearsExperience = 0,
}) {
  const chosenCanton = String(canton || 'TI').toUpperCase();
  const cantonMult = SWISS_BENCHMARKS_DATA.cantonMultipliers?.[chosenCanton] ?? 1.0;
  const resolvedSeniority = seniority || inferSeniorityTier(roleTitle, yearsExperience);
  const roleKey = matchRoleKey(roleTitle);
  const roleData = SWISS_BENCHMARKS_DATA.roles?.[roleKey] || SWISS_BENCHMARKS_DATA.roles.general_office;

  const baseBenchmarks = roleData.benchmarks?.[resolvedSeniority] || roleData.benchmarks.mid;

  const roundTo100 = (num) => Math.round((num * cantonMult) / 100) * 100;

  const p25Annual = roundTo100(baseBenchmarks.p25);
  const medianAnnual = roundTo100(baseBenchmarks.p50);
  const p75Annual = roundTo100(baseBenchmarks.p75);

  return {
    currency: 'CHF',
    roleKey,
    industry: roleData.industry,
    seniority: resolvedSeniority,
    canton: chosenCanton,
    cantonName: CANTON_NAMES[chosenCanton] || `Cantone ${chosenCanton}`,
    cantonMultiplier: cantonMult,
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
 * Generates actionable salary interview briefing and scripts for candidates.
 * @param {object} benchmark - output of lookupSalaryBenchmark
 * @param {string} [roleTitle='']
 * @returns {{ advice: string, deferralScript: string, recruiterQuestions: string[] }}
 */
export function formatSalaryInterviewBriefing(benchmark, roleTitle = '') {
  const cantonStr = benchmark.cantonName;
  const rangeStr = benchmark.rangeFormatted;
  const medianStr = benchmark.medianFormatted;
  const roleDisplay = roleTitle || benchmark.roleKey;

  const advice = `Per una posizione di ${roleDisplay} in ${cantonStr} (${benchmark.seniority}), il benchmark di mercato svizzero si colloca tra ${rangeStr} lordi/anno (mediana a ${medianStr}). Nei colloqui in Svizzera, per un lavoratore frontaliere è consigliabile ancorare le aspettative all'estremità medio-alta di questa fascia per evitare svalutazioni salariali ("dumping salariale"), tenendo conto che il contratto standard svizzero prevede solitamente la 13esima mensilità.`;

  const deferralScript = `In questa fase iniziale sono concentrato soprattutto sulla comprensione delle sfide tecniche e degli obiettivi del team. In base alle mie ricerche e al valore che posso portare al progetto, per un ruolo simile in ${cantonStr} considero congruo un range tra ${rangeStr} annui lordi, ma sono pronto a discutere una proposta complessiva che includa benefit e welfare aziendale.`;

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
