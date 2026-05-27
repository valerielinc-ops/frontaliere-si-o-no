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

// Note on `3a|3b`: previously included as a bare token to match the Swiss
// pension pillar 3a/3b. Caused false positives like "meteo 3b" (the
// Italian weather app brand "3B Meteo") jumping to top score in the trend
// candidate pool. Removed in favor of `pilastro\s*3[ab]` and `(?:pillar|pilier)\s*3[ab]`
// which require the pillar context word.
//
// Note on housing/mortgage terms (added 2026-05-07): the top-performing
// winner article "Mutuo per frontalieri: comprare casa in Italia"
// (adsense €0.017, 87 pageviews, 7 clicks → highest revenue article)
// had its keywords completely excluded from topKeywords because the
// regex didn't cover housing-finance vocabulary. Added: mutuo, hypothek,
// prestito, casa, abita*, alloggio, immobile, immobiliar*, appartament*,
// affitt*, locazion*, wohnung. Plus banking action verbs (comprare/
// acquistare/vendere/kaufen/acheter) and Italy-side geo (italia/italien/
// italie) to round out cross-border real-estate context.
export const FRONTALIERI_DOMAIN_RE = /\b(frontal|grenzg|permess(o|i)\s*[gbl]|tass[ae]|fisco|fiscal|imposta|irpef|quellensteuer|busta\s*paga|salar|stipend|salaire|gehalt|cassa\s*malati|lamal|cmi|assicur|krankenkass|pension|avs|ahv|lpp|bvg|terzo\s*pilastro|secondo\s*pilastro|pilastro\s*3[ab]|(?:pillar|pilier)\s*3[ab]|cambio|chf|euro|valut|telelavoro|smart\s*working|t[ée]l[ée]travail|homeoffic|pendolar|commut|dogana|valico|frontiera|bordo|bord[ée]r|naspi|disoccupaz|ristorn|accordo|abkommen|bilateral|svizzer|switzer|tessin|ticin|lombard|comask|varesin|grigion|grauen|mutu|hypothek|prestit|banc|conto\s*corrente|cas[ae]|abita|alloggi|immobil|appartament|affitt|locazion|wohnung|comprare|acquistare|vendere|kaufen|acheter|italia|italien|italie|familia|familiar|figli[oa]?|kinder|enfants|children|residen|domicil|wohnsitz)/i;

export function isFrontalieriDomainTerm(term) {
  if (!term || typeof term !== 'string') return false;
  return FRONTALIERI_DOMAIN_RE.test(term);
}

export default { FRONTALIERI_DOMAIN_RE, isFrontalieriDomainTerm };
