/**
 * Wikidata SPARQL Company Intelligence
 * Arricchisce i profili aziendali con CEO, dipendenti, sito ufficiale,
 * ID LinkedIn e descrizione da Wikidata/Wikipedia.
 */

export const WIKIDATA_SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';
export const WIKIDATA_USER_AGENT = 'FrontaliereBot/1.0 (https://frontaliereticino.ch; info@frontaliereticino.ch)';

// Classi aziendali/organizzative ammesse (Anchor Positivi)
// Q4830453 = business enterprise, Q43229 = organization, Q6881511 = enterprise,
// Q783794 = company, Q891723 = public company, Q328664 = financial institution
export const POSITIVE_ORG_TYPES = [
  'wd:Q4830453',
  'wd:Q43229',
  'wd:Q6881511',
  'wd:Q783794',
  'wd:Q891723',
  'wd:Q328664'
];

// Classi geografiche/amministrative escluse (Anchor Negativi)
// Q2221906 = geographic location, Q56061 = administrative territorial entity
export const NEGATIVE_ORG_TYPES = [
  'wd:Q2221906',
  'wd:Q56061'
];

/**
 * Costruisce la query SPARQL certificata con anchor di inclusione ed esclusione.
 * @param {string} companyName
 * @param {string} [lang='it']
 * @returns {string}
 */
export function buildWikidataCompanySparql(companyName, lang = 'it') {
  const safeName = String(companyName || '').replace(/[\\"]/g, '\\$&').trim();
  const posTypes = POSITIVE_ORG_TYPES.join(' ');
  const negTypes = NEGATIVE_ORG_TYPES.join(' ');

  return `
SELECT ?company ?companyLabel ?ceoLabel ?employees ?website ?linkedin ?description WHERE {
  ?company rdfs:label "${safeName}"@${lang}.

  # ANCHOR POSITIVO: Deve discendere dalla classe azienda/organizzazione
  ?company wdt:P31/wdt:P279* ?orgType.
  VALUES ?orgType { ${posTypes} }

  # ANCHOR NEGATIVO: NON deve essere un'entità geografica o amministrativa
  FILTER NOT EXISTS {
    ?company wdt:P31/wdt:P279* ?excludedType.
    VALUES ?excludedType { ${negTypes} }
  }

  OPTIONAL { ?company wdt:P169 ?ceo. }
  OPTIONAL { ?company wdt:P1128 ?employees. }
  OPTIONAL { ?company wdt:P856 ?website. }
  OPTIONAL { ?company wdt:P2013 ?linkedin. }
  OPTIONAL { ?company schema:description ?description. FILTER(LANG(?description) = "${lang}") }

  SERVICE wikibase:label { bd:serviceParam wikibase:language "${lang},en". }
}
LIMIT 1`.trim();
}

/**
 * Parsifica la risposta JSON dell'endpoint SPARQL di Wikidata.
 * @param {object} jsonResponse
 * @returns {object|null}
 */
export function parseWikidataCompanyResult(jsonResponse) {
  const bindings = jsonResponse?.results?.bindings;
  if (!Array.isArray(bindings) || bindings.length === 0) return null;

  const row = bindings[0];
  const companyUri = row.company?.value || null;
  const qIdMatch = companyUri ? /\/(Q\d+)$/.exec(companyUri) : null;
  const wikidataId = qIdMatch ? qIdMatch[1] : null;

  const ceo = row.ceoLabel?.value || null;
  const rawEmployees = row.employees?.value;
  const employees = rawEmployees ? parseInt(rawEmployees, 10) : null;
  const website = row.website?.value || null;
  const rawLinkedin = row.linkedin?.value || null;
  const description = row.description?.value || null;

  // Normalizza LinkedIn: se è solo lo slug, costruisci l'URL completo
  let linkedInUrl = null;
  if (rawLinkedin) {
    if (rawLinkedin.startsWith('http://') || rawLinkedin.startsWith('https://')) {
      linkedInUrl = rawLinkedin;
    } else {
      linkedInUrl = `https://www.linkedin.com/company/${rawLinkedin}`;
    }
  }

  return {
    wikidataId,
    ceo,
    employees: Number.isNaN(employees) ? null : employees,
    website,
    linkedInUrl,
    description
  };
}

/**
 * Interroga l'API SPARQL di Wikidata per una determinata azienda.
 * @param {string} companyName
 * @param {object} [options]
 * @returns {Promise<object|null>}
 */
export async function queryWikidataCompany(companyName, { lang = 'it', fetchFn = globalThis.fetch } = {}) {
  const sparql = buildWikidataCompanySparql(companyName, lang);
  const url = `${WIKIDATA_SPARQL_ENDPOINT}?query=${encodeURIComponent(sparql)}&format=json`;

  const res = await fetchFn(url, {
    headers: {
      'User-Agent': WIKIDATA_USER_AGENT,
      'Accept': 'application/sparql-results+json'
    }
  });

  if (!res.ok) return null;
  const data = await res.json();
  return parseWikidataCompanyResult(data);
}
