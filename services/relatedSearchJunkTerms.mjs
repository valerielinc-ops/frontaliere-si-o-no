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
  // ── DE — connective nouns / boilerplate leaking from cross-language ads ──
  'sowie', 'patienten', 'patientinnen', 'patient',
  'unterstutzung', 'aufgaben', 'bieten', 'mitarbeiter', 'mitarbeiterin',
  'mitarbeitende', 'mitarbeitenden', 'bereich', 'rahmen', 'umfeld',
  'kenntnisse', 'weiterbildung', 'entwicklung', 'qualitat',
  'systeme', 'projekte', 'projekt', 'dienstleistungen',
  'gruppe', 'abteilung',
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
  // ── Scraped web/UI noise ──
  'cookie', 'cookies', 'javascript', 'browser', 'newsletter', 'website',
]);

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
 * A keyword is junk when it has no meaningful token — i.e. EVERY token is a
 * junk-denylist word or a pure number. Multi-word terms survive as long as at
 * least one token carries real search intent (so "senior associate",
 * "tecnico data center", "ospedale lugano" are all kept).
 * @param {string} keyword
 * @returns {boolean}
 */
export function isJunkSearchKeyword(keyword) {
  const tokens = tokenizeKeyword(keyword);
  if (tokens.length === 0) return true;
  return tokens.every((t) => /^\d+$/.test(t) || RELATED_SEARCH_JUNK_TERMS.has(t));
}
