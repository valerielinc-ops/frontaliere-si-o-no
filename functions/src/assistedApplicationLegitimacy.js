import { resolveReportedPostingDate } from './lib/jobPostingDate.js';
/**
 * Posting legitimacy (extra "Legittimità dell'annuncio", owner decision
 * 2026-09-30), ported from career-ops' Block G (MIT, modes/_shared.md and
 * modes/oferta.md). Deterministic: the text signals come as verbatim quotes
 * from the requirements pass (sanitizeRequirements + verifyQuotes), the rest
 * from the posting data and the liveness check.
 *
 * Tiers, as career-ops names them:
 *   high_confidence  real, active opening: most signals positive;
 *   caution          mixed signals, worth noting (also: no posting date);
 *   suspicious       several ghost indicators: the owner looks first. It is an
 *                    owner red flag (assistedApplicationFlow.evaluateRedFlags)
 *                    and stops the automatic approval.
 * Rules kept from career-ops: the tier never changes the match or the score;
 * "NEVER default to 'Suspicious' without evidence"; findings are never
 * written as accusations; public-sector postings stay open 60-90 days and an
 * ongoing/rolling opening is a pipeline role, not a ghost job; notes
 * (self-employment wording, a wide pay range, text aimed at an AI) are
 * reported apart and never change the tier.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const PUBLIC_EMPLOYER_RE = /\b(cantone|canton|kanton|comune|città|citta|stadt|gemeinde|commune|ville|confederazione|bund|eidgen|universit|usi\b|supsi|eoc\b|ente ospedaliero|politecnico|eth\b|epfl|scuola|schule|école|ospedale cantonale|kantonsspital)/i;

function toMs(value) {
  if (!value) return null;
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

/** "CHF 70000–120000 / YEAR" → { min, max } (same currency and period by construction). */
export function salaryRange(salary) {
  const match = /(\d[\d'’ .]*)\s*[–-]\s*(\d[\d'’ .]*)/.exec(String(salary || ''));
  if (!match) return null;
  const toNumber = (text) => Number(text.replace(/[^\d]/g, ''));
  const min = toNumber(match[1]);
  const max = toNumber(match[2]);
  return min > 0 && max >= min ? { min, max } : null;
}

/**
 * @param {object} input
 * @param {object} input.posting fetchJobPosting(...) result
 * @param {object} [input.legitimacy] requirements.legitimacy (verified quotes)
 * @param {string} [input.livenessResult] 'active' | 'uncertain' | … from checkPostingLiveness
 * @param {string} [input.companyName]
 * @param {number} input.nowMs
 */
export function assessLegitimacy({ posting = {}, legitimacy = {}, livenessResult = '', companyName = '', nowMs }) {
  const signals = [];
  const notes = [];
  const add = (key, weight, reliability, detail = '') => signals.push({ key, weight, reliability, detail });
  const publicEmployer = PUBLIC_EMPLOYER_RE.test(companyName);
  const rolling = legitimacy.rolling === true;

  // Posting age (high): under 30 days good, 30-60 mixed, 60+ concerning.
  const dateMs = toMs(resolveReportedPostingDate(posting, new Date(nowMs)));
  // Collection history is an observation, never a publication-age signal.
  const observedMs = toMs(posting.firstSeenAt);
  const observedAgeDays = observedMs !== null && observedMs <= nowMs
    ? Math.floor((nowMs - observedMs) / DAY_MS) : null;
  const ageDays = dateMs !== null ? Math.max(0, Math.floor((nowMs - dateMs) / DAY_MS)) : null;
  if (ageDays === null) add('age_unknown', 'neutral', 'high');
  else if (ageDays < 30) add('age', 'positive', 'high', `${ageDays}`);
  else if (rolling || (publicEmployer && ageDays <= 90) || ageDays <= 60) add('age', 'neutral', 'high', `${ageDays}`);
  else add('age', 'concerning', 'high', `${ageDays}`);

  // Apply channel still open (high): the liveness check right before drafting.
  if (livenessResult === 'active') add('apply_open', 'positive', 'high');
  else add('apply_unverified', 'neutral', 'high');

  // Description quality (medium): contradictions are strong, vagueness weaker.
  if (legitimacy.contradictions?.length) add('contradictions', 'concerning', 'medium', legitimacy.contradictions[0]);
  if (legitimacy.specificity === 'specific') add('specific', 'positive', 'medium');
  else if (legitimacy.specificity === 'vague') add('vague', 'concerning', 'medium');
  else add('specificity_mixed', 'neutral', 'medium');
  if (String(posting.text || '').trim().length > 0 && String(posting.text).trim().length < 400) add('short_text', 'concerning', 'medium');

  // Salary transparency (low).
  add(posting.salary ? 'salary_shown' : 'salary_missing', posting.salary ? 'positive' : 'neutral', 'low');

  // Notes: reported apart, never change the tier.
  if (legitimacy.contractorQuote) notes.push({ key: 'self_employment', quote: legitimacy.contractorQuote });
  const range = salaryRange(posting.salary);
  if (range && range.max - range.min > 0.5 * range.min) notes.push({ key: 'wide_pay_range', detail: posting.salary });
  if (legitimacy.aiDirectedQuote) notes.push({ key: 'ai_directed_text', quote: legitimacy.aiDirectedQuote });
  if (publicEmployer) notes.push({ key: 'public_employer' });
  if (rolling) notes.push({ key: 'rolling' });

  const concerning = signals.filter((signal) => signal.weight === 'concerning' && signal.reliability !== 'low');
  const concerningHigh = concerning.filter((signal) => signal.reliability === 'high');
  const positive = signals.filter((signal) => signal.weight === 'positive');
  let tier;
  if (concerning.length >= 2 && concerningHigh.length >= 1) tier = 'suspicious';
  else if (concerning.length >= 3) tier = 'suspicious';
  else if (concerning.length || ageDays === null || positive.length < 2) tier = 'caution';
  else tier = 'high_confidence';
  return { tier, ageDays, observedAgeDays, signals, notes };
}

export const LEGITIMACY_LABELS_IT = {
  tier: { high_confidence: 'affidabile', caution: 'da verificare', suspicious: 'sospetto' },
  signal: {
    age: 'età dell’annuncio (giorni)',
    age_unknown: 'data di pubblicazione non nota',
    apply_open: 'candidatura ancora aperta',
    apply_unverified: 'apertura non verificata',
    contradictions: 'requisiti in contraddizione',
    specific: 'descrizione concreta',
    vague: 'descrizione generica',
    specificity_mixed: 'descrizione in parte generica',
    short_text: 'testo molto breve',
    salary_shown: 'stipendio indicato',
    salary_missing: 'stipendio non indicato',
  },
  note: {
    self_employment: 'lavoro autonomo (fattura / partita IVA)',
    wide_pay_range: 'forbice di stipendio ampia',
    ai_directed_text: 'testo rivolto a un’IA o a un revisore',
    public_employer: 'datore pubblico: 60-90 giorni sono normali',
    rolling: 'posizione aperta in continuo',
  },
};
