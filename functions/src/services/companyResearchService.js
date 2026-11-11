/**
 * Persistent company intelligence cache & research service,
 * inspired by ai-job-search company research cache (MIT).
 *
 * Stores and retrieves verified company intelligence (mission, culture, strategic priorities,
 * tech stack) with a 30-day TTL in Firestore (`company_intelligence`), avoiding repeated
 * external web research and grounding AI-generated cover letters and interview prep in real facts.
 */

export const COMPANY_INTELLIGENCE_COLLECTION = 'company_intelligence';
export const DEFAULT_COMPANY_RESEARCH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const LEGAL_FORM_RE = /\b(sa|ag|sagl|gmbh|srl|spa|inc|llc|corp|ltd|holding|group|schweiz|suisse|switzerland)\b/gi;

const COMMON_SWISS_ALIASES = Object.freeze({
  'bally-schuhfabriken': 'bally',
  'ubs-group': 'ubs',
  'novartis-pharma': 'novartis',
});

/**
 * Normalizes a company name into a stable slugified cache key.
 * E.g. "UBS Switzerland AG" -> "ubs"
 *      "Novartis Pharma Schweiz AG" -> "novartis"
 *      "Bally Schuhfabriken SA" -> "bally"
 * @param {string} raw
 * @returns {string}
 */
export function normalizeCompanyKey(raw) {
  const cleaned = String(raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(LEGAL_FORM_RE, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleaned) return 'unknown-company';
  return COMMON_SWISS_ALIASES[cleaned] || cleaned;
}

/**
 * Known baseline profiles for premier employers in Switzerland / Ticino,
 * providing instant factual grounding without cold web scraping.
 */
export const SWISS_EMPLOYER_BASELINES = Object.freeze({
  ubs: {
    legalName: 'UBS Group AG',
    cantons: ['ZH', 'TI', 'BS', 'GE'],
    industry: 'Banking & Financial Services',
    mission: 'Fornire consulenza finanziaria e soluzioni patrimoniali globali con standard svizzeri di eccellenza e affidabilità.',
    cultureKeywords: ['eccellenza operativa', 'gestione del rischio', 'innovazione digitale', 'client-centric'],
    strategicPriorities: ['integrazione tecnologica delle piattaforme bancarie', 'sostenibilità ESG', 'rafforzamento della consulenza wealth management'],
  },
  novartis: {
    legalName: 'Novartis AG',
    cantons: ['BS', 'TI'],
    industry: 'Pharmaceuticals & Life Sciences',
    mission: 'Reimmaginare la medicina per migliorare e prolungare la vita delle persone attraverso la ricerca d\'avanguardia.',
    cultureKeywords: ['unbossed leadership', 'integrità scientifica', 'innovazione biomedica', 'collaborazione globale'],
    strategicPriorities: ['terapie innovative e medicina personalizzata', 'digital health e automazione R&D', 'espansione dei poli produttivi svizzeri'],
  },
  migros: {
    legalName: 'Federazione delle Cooperative Migros',
    cantons: ['TI', 'ZH', 'BE', 'VD'],
    industry: 'Retail & Consumer Goods',
    mission: 'Migliorare la qualità della vita quotidiana dei clienti con prodotti di qualità accessibili e responsabilità sociale.',
    cultureKeywords: ['responsabilità sociale', 'vicinanza al territorio ticinese', 'sostenibilità ambientale'],
    strategicPriorities: ['digitalizzazione del commercio omnicanale', 'valorizzazione della filiera locale', 'efficienza logistica svizzera'],
  },
  swisscom: {
    legalName: 'Swisscom AG',
    cantons: ['BE', 'ZH', 'TI', 'VD'],
    industry: 'Telecommunications & IT Services',
    mission: 'Guidare la trasformazione digitale della Svizzera con reti di telecomunicazione resilienti e servizi cloud affidabili.',
    cultureKeywords: ['innovazione continua', 'sicurezza e resilienza', 'focus sull\'esperienza cliente'],
    strategicPriorities: ['espansione reti 5G e fibra ottica', 'soluzioni cloud e cybersecurity per PMI e grandi aziende'],
  },
  bally: {
    legalName: 'Bally Schuhfabriken AG',
    cantons: ['TI'],
    industry: 'Luxury Fashion & Manufacturing',
    mission: 'Celebrare la tradizione artigianale svizzera nel lusso e nella calzatura combinando heritage e design contemporaneo.',
    cultureKeywords: ['heritage svizzero', 'artigianalità d\'eccellenza', 'design durevole'],
    strategicPriorities: ['sviluppo dell\'e-commerce globale', 'sostenibilità dei materiali', 'hub produttivo e logistico in Ticino'],
  },
});

/**
 * Retrieves cached company research or returns null if expired or missing.
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {string} companyName
 * @param {object} [options]
 * @param {number} [options.nowMs=Date.now()]
 * @returns {Promise<object|null>}
 */
export async function getCompanyResearch(db, companyName, { nowMs = Date.now() } = {}) {
  const companyKey = normalizeCompanyKey(companyName);
  if (!db || !companyKey || companyKey === 'unknown-company') return null;

  try {
    const docRef = db.collection(COMPANY_INTELLIGENCE_COLLECTION).doc(companyKey);
    const snap = await docRef.get();
    if (!snap.exists) {
      // Check if known baseline applies
      const baseline = SWISS_EMPLOYER_BASELINES[companyKey];
      if (baseline) {
        return {
          companyKey,
          companyName: baseline.legalName,
          ...baseline,
          source: 'curated_baseline',
          fetchedAt: nowMs,
          expiresAt: nowMs + DEFAULT_COMPANY_RESEARCH_TTL_MS,
        };
      }
      return null;
    }

    const data = snap.data();
    if (data.expiresAt && data.expiresAt < nowMs) {
      return null; // Expired cache
    }
    return { ...data, companyKey };
  } catch (err) {
    console.warn('[companyResearchService] get failed', companyKey, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Saves company intelligence to the Firestore cache.
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {string} companyName
 * @param {object} intelligence
 * @param {object} [options]
 * @param {number} [options.nowMs=Date.now()]
 * @param {number} [options.ttlMs=DEFAULT_COMPANY_RESEARCH_TTL_MS]
 * @returns {Promise<object>}
 */
export async function saveCompanyResearch(db, companyName, intelligence, { nowMs = Date.now(), ttlMs = DEFAULT_COMPANY_RESEARCH_TTL_MS } = {}) {
  const companyKey = normalizeCompanyKey(companyName);
  const record = {
    companyKey,
    companyName: String(intelligence?.companyName || companyName).trim(),
    legalName: String(intelligence?.legalName || intelligence?.companyName || companyName).trim(),
    cantons: Array.isArray(intelligence?.cantons) ? intelligence.cantons : [],
    industry: String(intelligence?.industry || 'Azienda svizzera').trim(),
    mission: String(intelligence?.mission || '').trim(),
    cultureKeywords: Array.isArray(intelligence?.cultureKeywords) ? intelligence.cultureKeywords.slice(0, 10) : [],
    strategicPriorities: Array.isArray(intelligence?.strategicPriorities) ? intelligence.strategicPriorities.slice(0, 8) : [],
    recentHighlights: Array.isArray(intelligence?.recentHighlights) ? intelligence.recentHighlights.slice(0, 5) : [],
    source: intelligence?.source || 'inferred_research',
    fetchedAt: nowMs,
    expiresAt: nowMs + ttlMs,
  };

  if (db && companyKey !== 'unknown-company') {
    try {
      const docRef = db.collection(COMPANY_INTELLIGENCE_COLLECTION).doc(companyKey);
      await docRef.set(record, { merge: true });
    } catch (err) {
      console.warn('[companyResearchService] set failed', companyKey, err instanceof Error ? err.message : String(err));
    }
  }

  return record;
}

/**
 * Resolves company research for drafting or interview prep:
 * tries cache first, falls back to baseline, or synthesizes a clean context from posting facts.
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {string} companyName
 * @param {object} [context]
 * @returns {Promise<object>}
 */
export async function resolveCompanyResearch(db, companyName, { postingContext = {}, nowMs = Date.now() } = {}) {
  const cached = await getCompanyResearch(db, companyName, { nowMs });
  if (cached) return cached;

  const companyKey = normalizeCompanyKey(companyName);
  const baseline = SWISS_EMPLOYER_BASELINES[companyKey];
  if (baseline) {
    const saved = await saveCompanyResearch(db, companyName, {
      companyName: baseline.legalName,
      ...baseline,
      source: 'curated_baseline',
    }, { nowMs });
    return saved;
  }

  // Synthesize from posting context if available
  const inferred = {
    companyName,
    legalName: companyName,
    cantons: postingContext.location ? [String(postingContext.location).slice(0, 30)] : ['TI'],
    industry: postingContext.sector || 'Settore aziendale svizzero',
    mission: postingContext.description ? `Organizzazione operante in Svizzera con focus su ${String(postingContext.title || 'qualità e servizio')}.` : '',
    cultureKeywords: ['professionalità', 'precisione svizzera', 'collaborazione'],
    strategicPriorities: ['sviluppo delle competenze del team', 'qualità del servizio'],
    source: 'posting_inferred',
  };

  return saveCompanyResearch(db, companyName, inferred, { nowMs });
}

/**
 * Builds formatted text block for AI drafting prompts.
 * @param {object} [research]
 * @returns {string}
 */
export function formatCompanyPromptContext(research) {
  if (!research || (!research.mission && !research.cultureKeywords?.length && !research.strategicPriorities?.length)) {
    return '';
  }

  const lines = ['Company Intelligence (grounded background facts, do NOT fabricate beyond this):'];
  if (research.legalName) lines.push(`- Nome / Ragione Sociale: ${research.legalName}`);
  if (research.industry) lines.push(`- Settore: ${research.industry}`);
  if (research.mission) lines.push(`- Missione: ${research.mission}`);
  if (research.cultureKeywords?.length) lines.push(`- Valori culturali chiave: ${research.cultureKeywords.join(', ')}`);
  if (research.strategicPriorities?.length) lines.push(`- Priorità strategiche: ${research.strategicPriorities.join('; ')}`);
  return lines.join('\n');
}
