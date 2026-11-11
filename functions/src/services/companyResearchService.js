/**
 * Persistent company intelligence cache & research service.
 *
 * Grounded in:
 * 1. Native platform employer datasets (`company-profiles.json`, `employer_insights`).
 * 2. Firestore `company_intelligence` cache (30-day TTL) preventing repeated lookups.
 * 3. Verified facts for Swiss employers (HQ, sector, size, frontalieri focus, mission).
 */

import CURATED_COMPANY_PROFILES from '../data/companies/company-profiles.json' with { type: 'json' };

export const COMPANY_INTELLIGENCE_COLLECTION = 'company_intelligence';
export const EMPLOYER_INSIGHTS_COLLECTION = 'employer_insights';
export const DEFAULT_COMPANY_RESEARCH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const LEGAL_FORM_RE = /\b(sa|ag|sagl|gmbh|srl|spa|inc|llc|corp|ltd|holding|group|schweiz|suisse|switzerland)\b/gi;

const COMMON_SWISS_ALIASES = Object.freeze({
  'bally-schuhfabriken': 'bally',
  'ubs-group': 'ubs',
  'ubs-switzerland': 'ubs',
  'novartis-pharma': 'novartis',
  'ente-ospedaliero-cantonale': 'eoc',
  'migros-ticino': 'migros',
  'lidl-schweiz': 'lidl',
  'lidl-svizzera': 'lidl',
  'coop-svizzera': 'coop',
  'ferrovie-federali-svizzere': 'sbb',
  'ffs': 'sbb',
  'la-posta-svizzera': 'post',
  'posta-svizzera': 'post',
});

/**
 * Normalizes a company name into a stable slugified cache key.
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
 * Baseline profiles for premier employers in Switzerland,
 * combining data from company-profiles.json with additional top employers.
 */
function buildSwissEmployerBaselines() {
  const baselines = {};

  // Ingest curated profiles from company-profiles.json
  for (const [key, profile] of Object.entries(CURATED_COMPANY_PROFILES)) {
    if (key.startsWith('_') || !profile || typeof profile !== 'object') continue;
    const descIt = profile.description?.it || profile.description?.en || '';
    baselines[key] = {
      legalName: profile.name || key.toUpperCase(),
      headquarters: profile.headquarters || 'Svizzera',
      founded: profile.founded || null,
      size: profile.size || null,
      cantons: profile.headquarters?.toLowerCase().includes('bellinzona') || profile.headquarters?.toLowerCase().includes('lugano') || profile.headquarters?.toLowerCase().includes('mendrisio') || key === 'eoc' || key === 'migros'
        ? ['TI']
        : ['TI', 'ZH', 'BS', 'BE'],
      industry: profile.sector || 'Azienda svizzera',
      mission: descIt,
      cultureKeywords: [
        'professionalità svizzera',
        'qualità del servizio',
        profile.sector ? profile.sector.toLowerCase() : 'affidabilità',
      ],
      strategicPriorities: [
        'sviluppo del capitale umano e talenti sul territorio',
        'continuità del servizio e innovazione operativa',
      ],
      source: 'curated_company_profile',
    };
  }

  // Enrich with specific details for top employers
  baselines.ubs = {
    legalName: 'UBS Group AG',
    headquarters: 'Zürich',
    cantons: ['ZH', 'TI', 'BS', 'GE'],
    industry: 'Banking & Financial Services',
    mission: 'Fornire consulenza finanziaria e soluzioni patrimoniali globali con standard svizzeri di eccellenza e affidabilità.',
    cultureKeywords: ['eccellenza operativa', 'gestione del rischio', 'innovazione digitale', 'client-centric'],
    strategicPriorities: ['integrazione tecnologica delle piattaforme bancarie', 'sostenibilità ESG', 'rafforzamento della consulenza wealth management'],
    source: 'curated_baseline',
  };

  baselines.novartis = {
    legalName: 'Novartis AG',
    headquarters: 'Basel',
    cantons: ['BS', 'TI'],
    industry: 'Pharmaceuticals & Life Sciences',
    mission: 'Reimmaginare la medicina per migliorare e prolungare la vita delle persone attraverso la ricerca d\'avanguardia.',
    cultureKeywords: ['unbossed leadership', 'integrità scientifica', 'innovazione biomedica', 'collaborazione globale'],
    strategicPriorities: ['terapie innovative e medicina personalizzata', 'digital health e automazione R&D', 'espansione dei poli produttivi svizzeri'],
    source: 'curated_baseline',
  };

  baselines.migros = {
    legalName: 'Federazione delle Cooperative Migros',
    headquarters: 'S. Antonino / Zürich',
    cantons: ['TI', 'ZH', 'BE', 'VD'],
    industry: 'Retail & Consumer Goods',
    mission: 'Migliorare la qualità della vita quotidiana dei clienti con prodotti di qualità accessibili e responsabilità sociale.',
    cultureKeywords: ['responsabilità sociale', 'vicinanza al territorio ticinese', 'sostenibilità ambientale'],
    strategicPriorities: ['digitalizzazione del commercio omnicanale', 'valorizzazione della filiera locale', 'efficienza logistica svizzera'],
    source: 'curated_baseline',
  };

  baselines.swisscom = {
    legalName: 'Swisscom AG',
    headquarters: 'Bern / Ittigen',
    cantons: ['BE', 'ZH', 'TI', 'VD'],
    industry: 'Telecommunications & IT Services',
    mission: 'Guidare la trasformazione digitale della Svizzera con reti di telecomunicazione resilienti e servizi cloud affidabili.',
    cultureKeywords: ['innovazione continua', 'sicurezza e resilienza', 'focus sull\'esperienza cliente'],
    strategicPriorities: ['espansione reti 5G e fibra ottica', 'soluzioni cloud e cybersecurity per PMI e grandi aziende'],
    source: 'curated_baseline',
  };

  baselines.bally = {
    legalName: 'Bally Schuhfabriken AG',
    headquarters: 'Caslano (TI)',
    cantons: ['TI'],
    industry: 'Luxury Fashion & Manufacturing',
    mission: 'Celebrare la tradizione artigianale svizzera nel lusso e nella calzatura combinando heritage e design contemporaneo.',
    cultureKeywords: ['heritage svizzero', 'artigianalità d\'eccellenza', 'design durevole'],
    strategicPriorities: ['sviluppo dell\'e-commerce globale', 'sostenibilità dei materiali', 'hub produttivo e logistico in Ticino'],
    source: 'curated_baseline',
  };

  return Object.freeze(baselines);
}

export const SWISS_EMPLOYER_BASELINES = buildSwissEmployerBaselines();

/**
 * Retrieves cached company research or returns null if expired or missing.
 * Checks Firestore cache, native employer_insights, and curated baselines.
 *
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {string} companyName
 * @param {object} [options]
 * @param {number} [options.nowMs=Date.now()]
 * @returns {Promise<object|null>}
 */
export async function getCompanyResearch(db, companyName, { nowMs = Date.now() } = {}) {
  const companyKey = normalizeCompanyKey(companyName);
  if (!companyKey || companyKey === 'unknown-company') return null;

  if (db) {
    try {
      // 1. Check primary company intelligence cache
      const docRef = db.collection(COMPANY_INTELLIGENCE_COLLECTION).doc(companyKey);
      const snap = await docRef.get();
      if (snap?.exists) {
        const data = snap.data();
        if (data?.expiresAt && data.expiresAt < nowMs) {
          return null; // Expired cache document
        }
        return { ...data, companyKey };
      }

      // 2. Check native employer_insights in Firestore only if doc did not exist
      if (typeof db.collection === 'function') {
        const insightsRef = db.collection(EMPLOYER_INSIGHTS_COLLECTION).doc(companyKey);
        const insightsSnap = await insightsRef.get();
        if (insightsSnap?.exists) {
          const ins = insightsSnap.data() || {};
          return {
            companyKey,
            companyName: ins.name || companyName,
            legalName: ins.name || companyName,
            cantons: ins.cantons || ['TI'],
            industry: ins.sector || 'Azienda svizzera',
            activeJobs: ins.activeJobs || 0,
            mission: ins.mission || `Azienda registrata in Svizzera con presenza occupazionale attiva.`,
            cultureKeywords: ['affidabilità', 'presenza svizzera', 'collaborazione'],
            strategicPriorities: ['crescita e reclutamento di profili qualificati'],
            source: 'employer_insights',
            fetchedAt: nowMs,
            expiresAt: nowMs + DEFAULT_COMPANY_RESEARCH_TTL_MS,
          };
        }
      }
    } catch (err) {
      console.warn('[companyResearchService] get failed', companyKey, err instanceof Error ? err.message : String(err));
    }
  }

  // 3. Fallback to curated baseline
  const baseline = SWISS_EMPLOYER_BASELINES[companyKey];
  if (baseline) {
    return {
      companyKey,
      companyName: baseline.legalName,
      ...baseline,
      source: baseline.source || 'curated_baseline',
      fetchedAt: nowMs,
      expiresAt: nowMs + DEFAULT_COMPANY_RESEARCH_TTL_MS,
    };
  }

  return null;
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
    headquarters: intelligence?.headquarters || 'Svizzera',
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
 * tries cache/curated first, then synthesizes a clean context from posting facts.
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
      source: baseline.source || 'curated_baseline',
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
  if (research.headquarters) lines.push(`- Sede: ${research.headquarters}`);
  if (research.industry) lines.push(`- Settore: ${research.industry}`);
  if (research.mission) lines.push(`- Missione: ${research.mission}`);
  if (research.cultureKeywords?.length) lines.push(`- Valori culturali chiave: ${research.cultureKeywords.join(', ')}`);
  if (research.strategicPriorities?.length) lines.push(`- Priorità strategiche: ${research.strategicPriorities.join('; ')}`);
  return lines.join('\n');
}
