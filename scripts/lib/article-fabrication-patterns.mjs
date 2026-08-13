/**
 * article-fabrication-patterns.mjs
 *
 * The curated denylist behind `tests/article-fabrication-guard.test.ts`,
 * extracted 2026-08-13 (issue #5671) so it has exactly one definition instead
 * of two. Before this change the patterns lived ONLY inside the vitest test
 * file, which made them undetectable outside `npm test` — and the sync job
 * that actually publishes article bodies (`sync-articles-sitemaps.yml`)
 * commits straight to `main` with no PR, so `npm test` never runs on that
 * path (verified: zero `push` check-runs on a sync commit, only
 * `schedule`/`workflow_run`). Two incidents on 2026-08-11 ("Ufficio federale
 * del lavoro", "LTL") shipped through exactly that gap and only surfaced as
 * `main` going red hours later, on unrelated PRs.
 *
 * This module is the patterns ONLY — no vitest, no filesystem walk — so it can
 * be imported from both:
 *   - tests/article-fabrication-guard.test.ts   (the existing PR-time net)
 *   - scripts/ci/report-synced-article-fabrication.mjs (the new sync-time one)
 * without either copy drifting from the other (AGENTS.md #6).
 *
 * DO NOT extend these lists as part of unrelated work. `packages/articles`'
 * confinement test and the corpus mirror both care that this file's pattern
 * VALUES stay identical to what the corpus repo carries — adding new patterns
 * is legitimate but is site-first work that should be its own, declared
 * change, not a drive-by addition riding on a wiring PR.
 */

/** Fabricated institution patterns (Italian only — see module note in the test). */
export const FABRICATED_INSTITUTIONS = [
  { pattern: /Codice\s+federale\s+del\s+lavoro/i, desc: '"Codice federale del lavoro" non esiste (reale: Legge sul lavoro LL/ArG)' },
  { pattern: /\bCFL\b(?!\s*[A-Z])/, desc: '"CFL" è un acronimo inventato' },
  { pattern: /Dipartimento\s+delle\s+Entrate\b/i, desc: '"Dipartimento delle Entrate" non esiste' },
  { pattern: /Codice\s+federale\s+(?:della\s+)?(?:salute|sanità)/i, desc: '"Codice federale della salute" non esiste' },
  { pattern: /Ministero\s+(?:federale|cantonale)\s+del(?:la)?\s+(?:lavoro|salute|finanz)/i, desc: 'Ministero federale/cantonale non esiste in Svizzera (reale: Dipartimento)' },
  { pattern: /Ufficio\s+federale\s+del(?:la)?\s+(?:lavoro\s+transfrontaliero|migrazione\s+lavorativa)/i, desc: '"Ufficio federale del lavoro transfrontaliero" non esiste' },
  { pattern: /Legge\s+cantonale\s+(?:sui|del)\s+frontalier/i, desc: '"Legge cantonale sui frontalieri" non esiste' },
  { pattern: /Regolamento\s+ticinese\s+(?:del|sul)\s+lavoro/i, desc: '"Regolamento ticinese del lavoro" non esiste' },
  { pattern: /Commissione\s+(?:federale|cantonale)\s+(?:per\s+i\s+)?frontalier/i, desc: '"Commissione federale per i frontalieri" non esiste' },
  { pattern: /Osservatorio\s+nazionale\s+(?:del|sulla)\s+sicurezza\s+(?:sul\s+)?lavoro/i, desc: '"Osservatorio nazionale sulla sicurezza sul lavoro" non esiste (reale: SUVA)' },
];

/** Fabricated Swiss acronyms (Italian only). */
export const FABRICATED_ACRONYMS = [
  { pattern: /\bUFOL\b/, desc: '"UFOL" non esiste (reale: SECO)' },
  { pattern: /\bUWL\b/, desc: '"UWL" non esiste (reale: SECO)' },
  { pattern: /\bUSTTI\b/, desc: '"USTTI" non esiste (reale: USTAT)' },
  { pattern: /\bUBSP\b/, desc: '"UBSP" non esiste (reale: UFSP/BAG)' },
  { pattern: /\bONSSL\b/, desc: '"ONSSL" non esiste (reale: SUVA)' },
  { pattern: /\bROSSL\b/, desc: '"ROSSL" non esiste' },
  { pattern: /\bLCFL\b/, desc: '"LCFL" non esiste (reale: LL/ArG)' },
  { pattern: /\bLTL\b/, desc: '"LTL" non esiste' },
  { pattern: /\bCCFL\b/, desc: '"CCFL" non esiste' },
  { pattern: /\bUFML\b/, desc: '"UFML" non esiste (reale: SEM)' },
];

/** Known incorrect facts, proximity-constrained (Italian only). */
export const INCORRECT_FACTS = [
  { pattern: /convenzione.*9\s+marzo\s+1976/i, desc: 'Convenzione italo-svizzera: 9 DICEMBRE 1976, non marzo' },
  { pattern: /9\s+marzo\s+1976.*convenzione/i, desc: 'Convenzione italo-svizzera: 9 DICEMBRE 1976, non marzo' },
  { pattern: /tassa\s+(?:sulla\s+)?salute\s+(?:\w+\s+){0,5}(?:del\s+)?10\s*%/i, desc: '"Tassa sulla salute del 10%" è un dato inventato' },
];

/** Vague source attributions that are red flags for fabricated stats (Italian only). */
export const VAGUE_SOURCING = [
  { pattern: /secondo\s+(?:uno\s+)?studio\s+(?:recente|del\s+20\d{2})[^.]{0,40}\d{2,3}[.,]\d+\s*%/i, desc: 'Percentuale precisa attribuita a "uno studio" senza nome specifico' },
  { pattern: /secondo\s+(?:un(?:a|')\s+)?(?:indagine|ricerca|sondaggio)[^.]{0,40}\d{2,3}[.,]\d+\s*%/i, desc: 'Percentuale precisa attribuita a indagine/ricerca senza fonte' },
];

// Cross-locale: the same fabricated "federal labour office" institution
// (real: SECO) recurs under a different fake acronym per article — matching
// the institution NAME itself (not a fixed acronym list) catches every
// variant regardless of what acronym a future auto-generated article invents.
export const FABRICATED_LABOR_OFFICE = {
  it: /\b[Uu]fficio federale(?: svizzero)? del lavoro\b/i,
  de: /\b([Bb]undesamt(?:es)? für Arbeit|[Bb]undesarbeitsamt)\b/,
  fr: /\b(?:[Oo]ffice|[Bb]ureau) fédéral du travail\b/,
  en: /\b[Ff]ederal (?:Labou?r Office|Office of Labou?r)\b/,
};

/**
 * Extracts string-literal content from a body module's raw source text.
 *
 * Must treat a backslash-escaped quote (`\'`) as part of the string content,
 * not a terminator — a naive `/'[^']*'/g` stops at the FIRST `\'` it sees
 * (e.g. "dell\'Ufficio..."), silently truncating the extracted text and
 * losing everything after it. That is exactly where Italian/French/German
 * elisions put an apostrophe right before a fabricated institution name
 * ("dell\'Ufficio federale...", "l\'Office fédéral...").
 *
 * @param {string} raw
 */
export function extractTextContentFromSource(raw) {
  const stringMatches = raw.match(/'(?:[^'\\]|\\.)*'/g) || [];
  return stringMatches.join(' ');
}

/**
 * Runs every Italian-only denylist check (institutions, acronyms, incorrect
 * facts, vague sourcing) against `text`. These are NOT locale-parameterised —
 * they encode facts about specific Italian strings, so calling this on a
 * translation would be meaningless by construction (same restriction as
 * `tests/article-fabrication-guard.test.ts`, which only runs them on
 * `itFiles`).
 *
 * @param {string} text
 * @returns {Array<{code: string, desc: string, evidence: string}>}
 */
export function scanItalianOnlyPatterns(text) {
  const violations = [];
  if (typeof text !== 'string' || !text) return violations;
  const groups = [
    ['fabricated-institution-name', FABRICATED_INSTITUTIONS],
    ['fabricated-acronym', FABRICATED_ACRONYMS],
    ['incorrect-fact', INCORRECT_FACTS],
    ['vague-sourcing', VAGUE_SOURCING],
  ];
  for (const [code, list] of groups) {
    for (const { pattern, desc } of list) {
      const m = text.match(pattern);
      if (m) violations.push({ code, desc, evidence: m[0].slice(0, 160) });
    }
  }
  return violations;
}

/**
 * Runs the cross-locale "federal labour office" check for one locale.
 * @param {string} text
 * @param {string} locale one of 'it'|'en'|'de'|'fr'
 * @returns {Array<{code: string, desc: string, evidence: string}>}
 */
export function scanFabricatedLaborOffice(text, locale) {
  const pattern = FABRICATED_LABOR_OFFICE[locale];
  if (!pattern || typeof text !== 'string' || !text) return [];
  const m = text.match(pattern);
  if (!m) return [];
  return [{
    code: 'fabricated-labor-office',
    desc: 'Ente "Ufficio federale del lavoro" (o traduzione) inesistente — reale: SECO',
    evidence: m[0].slice(0, 160),
  }];
}

/**
 * All checks that apply to a single body-locale's text.
 * @param {string} text
 * @param {string} locale
 */
export function scanFabricationPatterns(text, locale) {
  const violations = locale === 'it' ? scanItalianOnlyPatterns(text) : [];
  return [...violations, ...scanFabricatedLaborOffice(text, locale)];
}
