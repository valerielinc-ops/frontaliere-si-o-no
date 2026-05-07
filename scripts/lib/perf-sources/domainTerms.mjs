// scripts/lib/perf-sources/domainTerms.mjs
//
// Frontalieri-domain allowlist used to filter winner-fingerprint topKeywords.
// Extracted from `scripts/lib/article-topic-selector.mjs` so both the producer
// (fetch-article-performance.mjs) and the consumer (article-topic-selector)
// agree on what counts as a domain-relevant term.
//
// The list is intentionally broad (multilingual roots: IT/DE/FR/EN) but
// confined to the cross-border-worker concept space: tax law, social
// security, pensions, insurance, commute/border, currency, and Swiss/Italian
// region names. Anything outside this regex is news-of-day TF-IDF noise
// (angeli, grandine, pastori) that pollutes the LLM prompt.

export const FRONTALIERI_DOMAIN_RE = /\b(frontal|grenzg|permess(o|i)\s*[gbl]|tass[ae]|fisco|fiscal|imposta|irpef|quellensteuer|busta\s*paga|salar|stipend|salaire|gehalt|cassa\s*malati|lamal|cmi|assicur|krankenkass|pension|avs|ahv|lpp|bvg|terzo\s*pilastro|secondo\s*pilastro|3a|3b|cambio|chf|euro|valut|telelavoro|smart\s*working|t[ée]l[ée]travail|homeoffic|pendolar|commut|dogana|valico|frontiera|bordo|bord[ée]r|naspi|disoccupaz|ristorn|accordo|abkommen|bilateral|svizzer|switzer|tessin|ticin|lombard|comask|varesin|grigion|grauen)/i;

export function isFrontalieriDomainTerm(term) {
  if (!term || typeof term !== 'string') return false;
  return FRONTALIERI_DOMAIN_RE.test(term);
}

export default { FRONTALIERI_DOMAIN_RE, isFrontalieriDomainTerm };
