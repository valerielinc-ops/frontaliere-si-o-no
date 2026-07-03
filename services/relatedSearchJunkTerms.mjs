/**
 * Junk-term denylist for related-search cluster keywords.
 *
 * Single source of truth (rule #6: no copy-paste of a constant across files).
 * Imported by:
 *   - services/relatedSearchClusters.ts        (runtime SPA widget + future candidate gen)
 *   - build-plugins/relatedSearchClustersPlugin.ts (emit-time guard — cleans the LIVE hub
 *     + stops emitting thin doorway landings even from the already-committed,
 *     stale data/related-search-candidates.json that predates this filter)
 *   - scripts/audit-related-search-candidates.mjs (generation-time mirror)
 *
 * Plain .mjs so BOTH the .ts graph and the .mjs audit script can import the
 * exact same set (mirrors the existing services/searchStem.mjs pattern).
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * `extractRelatedTopicTokens` harvests the MOST FREQUENT body tokens of a job
 * description. The most frequent tokens are inherently generic filler that
 * appears in every posting regardless of role ("gestione", "sviluppo",
 * "qualità", "professionale"), scraped UI noise ("cookie"), German connective
 * nouns leaking from cross-language postings ("sowie", "patienten",
 * "unterstützung"), and care-OBJECTS rather than job ROLES ("pazienti"). These
 * produced thin, embarrassing doorway pages such as
 *   /cerca-lavoro-svizzera/ricerca-cookie-bern/   → "<title>Cookie a Bern</title>"
 * and polluted the /…/ricerca/ hub index with hundreds of meaningless links.
 *
 * ── What is NOT junk ─────────────────────────────────────────────────────
 * Real job-search intents are deliberately KEPT even when generic: role nouns
 * (ospedale, medico, medici, medicina, clinica, infermiere, assistenza,
 * assistente, vendita, stage, manager, formazione, sicurezza, studenti) and
 * multi-word terms (e.g. "data center technician", "senior associate") — a
 * keyword is junk only when EVERY one of its tokens is junk/numeric.
 *
 * Tokens are compared lowercased + diacritic-stripped (NFD).
 */

export const RELATED_SEARCH_JUNK_TERMS = new Set([
  // ── IT — abstract filler / connectives / HR boilerplate / meta ──
  'pazienti', 'paziente',
  'gestione', 'sviluppo', 'professionale', 'professionali',
  'modo', 'compiti', 'mansioni', 'attivita', 'ambiente',
  'ricerca', 'ricerche', // meta: a "ricerca-ricerca-x" page is nonsense
  'qualita', 'dati', 'capacita', 'squadra', 'gruppo',
  'sistemi', 'sistema', 'servizio', 'servizi',
  'oltre', 'nell', 'nello', 'nella', 'lavorare',
  'descrizione', 'conoscenza', 'conoscenze', 'vita', 'futuro',
  'supporto', 'responsabilita', 'requisiti', 'requisito',
  'progetti', 'progetto', 'posizione', 'posizioni',
  'offriamo', 'dipendenti', 'competenze', 'competenza',
  'settore', 'settori', 'soluzioni', 'soluzione',
  'possibile', 'persone', 'persona', 'presente', 'inoltre',
  'vuoi', 'presso', 'mediante', 'stipendio',
  'cura', 'cosa', 'circa', 'collab', 'area', 'ruolo',
  // ── DE — connective nouns / boilerplate leaking from cross-language ads ──
  'sowie', 'patienten', 'patientinnen', 'patient',
  'unterstutzung', 'aufgaben', 'bieten', 'mitarbeiter', 'mitarbeiterin',
  'mitarbeitende', 'mitarbeitenden', 'bereich', 'rahmen', 'umfeld',
  'kenntnisse', 'weiterbildung', 'entwicklung', 'qualitat',
  'systeme', 'projekte', 'projekt', 'dienstleistungen',
  'gruppe', 'abteilung', 'berufsfeld',
  // ── FR — abstract filler ──
  'patients', 'competences', 'competence', 'connaissances', 'connaissance',
  'missions', 'mission', 'domaine', 'domaines', 'taches', 'tache',
  'developpement', 'gestion', 'qualite', 'systemes',
  'projets', 'projet', 'environnement', 'profil', 'profils', 'equipe',
  // ── EN — abstract filler (NOTE: 'data'/'center'/'technician'/'system(s)'
  //         deliberately excluded — they form real multi-word role searches
  //         like "data center technician" pinned by unit tests) ──
  'responsibilities', 'responsibility', 'skills', 'ability', 'abilities',
  'strong', 'working', 'knowledge', 'relevant', 'various',
  'ensure', 'ensuring', 'providing', 'including',
  'environment', 'development', 'management', 'quality',
  'projects', 'tasks', 'employees', 'staff', 'requirements',
  // 'owner' — generic possessive noun harvested from job body text
  // ("business owner", "process owner"), never itself a searchable role.
  // Combined with a leaked cross-canton location it produced
  // /search-owner-zurich/ (0 live matches once source job rotated out —
  // thin/empty page, 100% bounce all 4 locales, GA4-flagged 2026-07-03).
  'owner', 'owners',
  // ── Scraped web/UI noise ──
  'cookie', 'cookies', 'javascript', 'browser', 'newsletter', 'website',
]);

/**
 * Salary-intent lead tokens. These sit inside RELATED_SEARCH_JUNK_TERMS
 * (they were added as a generic "bonus straggler" catch), but unlike real
 * filler they form a legitimate, SEO-valuable query when followed by an
 * actual role/phrase — "stipendio infermiere" (salary + nurse), "stipendio
 * manager" — the same class of intent as "quanto guadagna un infermiere".
 * Only the BARE token alone, or the token followed exclusively by other
 * junk/city-leftover tokens, should still drop (see isJunkSearchKeyword).
 *
 * Confirmed against the live data/related-search-candidates.json audit
 * (issue #2764, follow-up of #2756): ~4.8k live "stipendio <role> svizzera"
 * candidates were being wholesale dropped by the blanket
 * first-token-is-junk rule before this exception existed.
 */
const SALARY_INTENT_LEAD_TOKENS = new Set(['stipendio']);

/**
 * Normalize a keyword to lowercased, diacritic-stripped, alnum-spaced tokens.
 * @param {string} keyword
 * @returns {string[]}
 */
function tokenizeKeyword(keyword) {
  return String(keyword || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * A keyword is junk when its leading content token is junk, OR every token is
 * junk/numeric.
 *
 * Related-search candidates are built as `${term} ${location}` (see
 * buildRelatedSearches), so the SEARCH TERM always leads and the city trails.
 * The display keyword only gets its city stripped when detectCity recognizes it
 * (KNOWN_CITIES); for an unrecognized city (Baden, Gossau, Meyrin, Solothurn…)
 * the keyword keeps the form "pazienti baden". A plain "every token is junk"
 * test then KEEPS it (the city token isn't junk), which is exactly how thin
 * doorways like /…/ricerca-pazienti-baden/ leaked back onto the hub.
 *
 * Checking the FIRST token instead is precise: title-derived candidates lead
 * with a real role ("software engineer bellinzona", "senior associate",
 * "tecnico data center", "ospedale lugano") and survive, while body-token junk
 * leads with the generic filler word ("pazienti baden", "cura baden",
 * "capacita gossau") and is dropped. The junk set is curated to EXCLUDE real
 * single-word job categories (ospedale, medico, vendita, formazione, …), so a
 * junk leading token reliably means a junk keyword.
 *
 * EXCEPTION: salary-intent lead tokens (SALARY_INTENT_LEAD_TOKENS, e.g.
 * "stipendio") are junk only in isolation. "stipendio <role...>" is a
 * legitimate salary+role search intent, so the leading-junk short-circuit is
 * skipped for them once 2+ tokens remain; the keyword still falls through to
 * the "every token junk" check below, so a bare "stipendio" or a "stipendio
 * <city-leftover-junk>" (all-junk remainder) still drops.
 * @param {string} keyword
 * @returns {boolean}
 */
export function isJunkSearchKeyword(keyword) {
  const tokens = tokenizeKeyword(keyword);
  if (tokens.length === 0) return true;
  const isJunkToken = (t) => /^\d+$/.test(t) || RELATED_SEARCH_JUNK_TERMS.has(t);
  const isSalaryIntentLed = tokens.length >= 2 && SALARY_INTENT_LEAD_TOKENS.has(tokens[0]);
  if (isSalaryIntentLed) return tokens.every(isJunkToken);
  return isJunkToken(tokens[0]) || tokens.every(isJunkToken);
}
