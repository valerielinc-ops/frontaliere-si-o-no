/**
 * seo-ctr-query-segments.mjs — segmentazione per query della misura del
 * monitor CTR per template (scripts/monitor-seo-ctr-by-template.mjs).
 *
 * ─── Perche' esiste ─────────────────────────────────────────────────────────
 * Decisione del proprietario I5 del 2026-10-05 (caso guida: issue 11198,
 * «Cerca lavoro Svizzera»). Il monitor misurava la CTR a livello di PAGINA, su
 * tutte le query. Due classi di query gonfiano le impressioni di una pagina di
 * ricerca lavoro senza alcuna possibilita' di click:
 *
 * - query PROMOZIONALI o di negozio: `ricerca-fielmann-spreitenbach` aveva 965
 *   impressioni a posizione 3,8 e CTR 0%, quasi tutte da «fielmann offerta» e
 *   «offerta fielmann». Chi cerca uno sconto non clicca su un elenco di posti;
 * - query AUTOMATICHE con operatori di ricerca (`-site:`, `site:`, `inurl:`…):
 *   strumenti SEO e scraper, non persone. Portano la maggior parte delle
 *   impressioni delle pagine minori.
 *
 * Contarle tiene la famiglia sotto la soglia per un motivo che nessun titolo
 * o descrizione puo' correggere. La correzione e' della MISURA, dichiarata: la
 * soglia (`effectiveTargetCtr`) NON cambia.
 *
 * ─── La misura ──────────────────────────────────────────────────────────────
 * metrica principale per pagina = totali di pagina − segmenti esclusi.
 *
 * I totali di pagina restano quelli di sempre (dimensione `page`, che include
 * anche le query anonimizzate); dei segmenti si scaricano solo le righe
 * pagina×query che il prefiltro RE2 (`segmentPrefilterRegex`) lascia passare,
 * e il classificatore decide riga per riga. Una query anonimizzata o non
 * classificata resta quindi DENTRO la metrica principale: si esclude solo cio'
 * che e' stato riconosciuto, mai per differenza.
 *
 * I segmenti esclusi non spariscono: impressioni, click e query principali
 * finiscono nello state file, nel log e nel corpo della issue
 * (`renderExcludedSegmentsSection`).
 *
 * ─── Versione della misura ──────────────────────────────────────────────────
 * Sul modello di `predicateVersion` della history delle traduzioni
 * (scripts/lib/incomplete-predicate-version.mjs): ogni voce di famiglia nello
 * state file porta `measureVersion`. Un salto della CTR fra due controlli con
 * versioni diverse e' un cambio di misura, non un miglioramento della SERP.
 * La versione e' un'impronta del classificatore e delle liste di parole: chi le
 * tocca cambia versione senza doverselo ricordare.
 */

import { createHash } from 'node:crypto';

/** La misura prima di questo modulo: CTR di pagina su tutte le query. */
export const LEGACY_CTR_MEASURE_VERSION = 'page-all-queries';

/**
 * Operatori di ricerca avanzata. Una query che ne contiene uno e' scritta da
 * uno strumento (o da chi fa SEO), non da chi cerca lavoro.
 */
export const SEARCH_OPERATOR_NAMES = Object.freeze([
  'site', 'inurl', 'allinurl', 'intitle', 'allintitle', 'intext', 'allintext',
  'inanchor', 'allinanchor', 'filetype', 'ext', 'related', 'cache', 'info',
  'link', 'before', 'after', 'daterange', 'source',
]);

/**
 * Parole promozionali o di negozio, in it/de/fr/en. Prese da sole indicano chi
 * cerca il negozio o lo sconto, non un posto di lavoro. Token interi: «offerta»
 * si', «stellenangebote» no (e' fra le parole di lavoro).
 */
export const PROMO_TOKENS = Object.freeze([
  // it
  'offerta', 'offerte', 'sconto', 'sconti', 'scontato', 'scontati', 'promo',
  'promozione', 'promozioni', 'coupon', 'buono', 'buoni', 'saldi', 'volantino',
  'aperto', 'aperti', 'aperta', 'apertura', 'aperture', 'orari', 'orario',
  'outlet', 'catalogo',
  // de
  'angebot', 'angebote', 'aktion', 'aktionen', 'rabatt', 'rabatte',
  'gutschein', 'gutscheine', 'gutscheincode', 'ausverkauf', 'prospekt',
  'öffnungszeiten', 'oeffnungszeiten', 'geöffnet', 'geoeffnet', 'offen',
  // fr
  'offre', 'offres', 'promotion', 'promotions', 'réduction', 'reduction',
  'réductions', 'reductions', 'solde', 'soldes', 'horaire', 'horaires',
  'ouvert', 'ouverte', 'ouverture',
  // en
  'offer', 'offers', 'deal', 'deals', 'discount', 'discounts', 'voucher',
  'vouchers', 'sale', 'opening', 'hours', 'open',
]);

/**
 * Parole di lavoro, in it/de/fr/en. Una sola di queste riporta la query nella
 * metrica principale anche se contiene una parola promozionale: «offerte di
 * lavoro fielmann» e «fielmann lavoro» sono domande di lavoro.
 */
export const JOB_TOKENS = Object.freeze([
  // it
  'lavoro', 'lavori', 'lavorare', 'impiego', 'impieghi', 'posto', 'posti',
  'assunzione', 'assunzioni', 'assume', 'assumono', 'carriera', 'carriere',
  'candidatura', 'candidature', 'candidarsi', 'colloquio', 'stage', 'tirocinio',
  'apprendistato', 'apprendista', 'stipendio', 'stipendi', 'salario', 'salari',
  'personale', 'cercasi', 'annunci', 'annuncio', 'frontaliere', 'frontalieri',
  'commessa', 'commesso', 'commesse', 'commessi', 'addetto', 'addetta',
  'impiegato', 'impiegata', 'mansione',
  // de
  'job', 'jobs', 'stelle', 'stellen', 'stellenangebot', 'stellenangebote',
  'stellenanzeige', 'stellenanzeigen', 'arbeit', 'arbeiten', 'karriere',
  'lehrstelle', 'lehrstellen', 'lehre', 'ausbildung', 'praktikum', 'bewerbung',
  'bewerben', 'gehalt', 'lohn', 'löhne', 'mitarbeiter', 'mitarbeiterin',
  'verkäufer', 'verkäuferin', 'grenzgänger', 'teilzeit', 'vollzeit',
  // fr
  'emploi', 'emplois', 'travail', 'travailler', 'carrière', 'carrières',
  'recrutement', 'recrute', 'embauche', 'poste', 'postes',
  'salaire', 'salaires', 'apprentissage', 'candidature', 'frontalier',
  'frontaliers', 'vendeur', 'vendeuse',
  // en
  'career', 'careers', 'hiring', 'hire', 'vacancy', 'vacancies', 'work',
  'working', 'employment', 'position', 'positions', 'internship',
  'apprenticeship', 'salary', 'recruitment', 'recruiting',
]);

/** Le parole di lavoro che hanno senso solo dentro una locuzione. */
const JOB_PHRASES = Object.freeze([
  /\bpart[\s-]?time\b/u,
  /\bfull[\s-]?time\b/u,
  /\btemps\s+partiel\b/u,
]);

const PROMO_SET = new Set(PROMO_TOKENS);
const JOB_SET = new Set(JOB_TOKENS);

const OPERATOR_RE = new RegExp(`(?:^|[\\s(])-?(?:${SEARCH_OPERATOR_NAMES.join('|')}):\\S`, 'u');
// Virgolette usate da operatore: una frase esatta combinata con un'esclusione
// (`"x" -y`) o con un OR booleano. Le virgolette da sole restano dentro.
const QUOTED_WITH_OPERATOR_RE = /"[^"]+"/u;
const EXCLUSION_OR_BOOLEAN_RE = /(?:^|\s)-[^\s-]|\s(?:OR|\|)\s/u;

function tokens(query) {
  return String(query || '')
    .toLowerCase()
    .normalize('NFC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Il segmento di una query, per la misura del monitor:
 * - `operator`: query automatica con operatori di ricerca, esclusa;
 * - `promo`: promozionale o di negozio senza parole di lavoro, esclusa e
 *   contata a parte;
 * - `job`: tutto il resto, cioe' la metrica principale. Una query di solo
 *   marchio («fielmann spreitenbach») resta qui: su una pagina di ricerca
 *   lavoro non c'e' un segnale affidabile per dire che non cerca un posto.
 *
 * @param {string} query
 * @returns {'operator'|'promo'|'job'}
 */
export function classifyCtrQuery(query) {
  const raw = String(query || '');
  const lower = raw.toLowerCase();
  if (OPERATOR_RE.test(lower)) return 'operator';
  if (QUOTED_WITH_OPERATOR_RE.test(raw) && EXCLUSION_OR_BOOLEAN_RE.test(raw)) return 'operator';
  const words = tokens(raw);
  if (!words.some((word) => PROMO_SET.has(word))) return 'job';
  if (words.some((word) => JOB_SET.has(word))) return 'job';
  if (JOB_PHRASES.some((re) => re.test(lower))) return 'job';
  return 'promo';
}

/** I segmenti esclusi dalla metrica principale, nell'ordine del report. */
export const EXCLUDED_CTR_SEGMENTS = Object.freeze(['operator', 'promo']);

const SEGMENT_LABEL = Object.freeze({
  operator: 'Query con operatori di ricerca (automatiche)',
  promo: 'Query promozionali o di negozio, senza parole di lavoro',
});

function escapeRe2(text) {
  return text.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');
}

/**
 * Prefiltro RE2 per `dimensionFilterGroups` (operatore `includingRegex`) della
 * Search Console: lascia passare ogni query che il classificatore POTREBBE
 * escludere, cosi' si scaricano poche righe pagina×query invece di tutte. E'
 * un soprainsieme per costruzione (sottostringhe dei token, senza confini di
 * parola): la decisione resta a `classifyCtrQuery`, e il test lo verifica.
 */
export function segmentPrefilterRegex() {
  const operators = SEARCH_OPERATOR_NAMES.map((name) => `${name}:`);
  const alternatives = [...operators, '"', ...PROMO_TOKENS].map(escapeRe2);
  return `(?i)(${alternatives.join('|')})`;
}

function codeOnly(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * L'impronta della misura segmentata: i primi 12 hex dello sha256 del
 * classificatore, delle liste e dei pattern che legge. Cambia quando cambia
 * cosa si esclude, non quando cambia un commento.
 */
export function ctrMeasureVersion() {
  const material = JSON.stringify({
    classify: codeOnly(classifyCtrQuery.toString()),
    tokens: codeOnly(tokens.toString()),
    operators: SEARCH_OPERATOR_NAMES,
    promo: PROMO_TOKENS,
    job: JOB_TOKENS,
    phrases: JOB_PHRASES.map(String),
    patterns: [OPERATOR_RE, QUOTED_WITH_OPERATOR_RE, EXCLUSION_OR_BOOLEAN_RE].map(String),
  });
  return `query-segmented-${createHash('sha256').update(material).digest('hex').slice(0, 12)}`;
}

export const CTR_MEASURE_VERSION = ctrMeasureVersion();

function emptySegment() {
  return { impressions: 0, clicks: 0, positionWeight: 0, queries: new Map() };
}

/**
 * Applica la segmentazione alle righe di pagina.
 *
 * @param {Array<{path: string, clicks: number, impressions: number, ctr?: number|null, position?: number|null}>} pageRows
 *   totali per pagina (dimensione `page`, tutte le query).
 * @param {Array<{path: string, query: string, clicks: number, impressions: number, position?: number|null}>} queryRows
 *   righe pagina×query restituite dal prefiltro.
 * @returns {{
 *   rows: Array<{path: string, clicks: number, impressions: number, ctr: number|null, position: number|null}>,
 *   segments: Record<string, {impressions: number, clicks: number, ctr: number|null, topQueries: Array<{query: string, impressions: number, clicks: number}>}>,
 *   allQueries: {impressions: number, clicks: number, ctr: number|null},
 * }}
 *   `rows` sono le righe di pagina della metrica principale, da passare a
 *   `aggregateFamilyRows`; `segments` i totali di famiglia dei segmenti esclusi;
 *   `allQueries` la misura di prima, per confrontare i due numeri.
 */
export function segmentFamilyRows(pageRows, queryRows, { topQueries = 5 } = {}) {
  const excludedByPath = new Map();
  const segments = Object.fromEntries(EXCLUDED_CTR_SEGMENTS.map((name) => [name, emptySegment()]));
  for (const row of queryRows || []) {
    const segment = classifyCtrQuery(row.query);
    if (segment === 'job') continue;
    const impressions = Number(row.impressions || 0);
    const clicks = Number(row.clicks || 0);
    const position = Number(row.position);
    const weight = Number.isFinite(position) ? position * impressions : 0;
    const perPath = excludedByPath.get(row.path) || { impressions: 0, clicks: 0, positionWeight: 0 };
    perPath.impressions += impressions;
    perPath.clicks += clicks;
    perPath.positionWeight += weight;
    excludedByPath.set(row.path, perPath);
    const total = segments[segment];
    total.impressions += impressions;
    total.clicks += clicks;
    total.positionWeight += weight;
    const q = total.queries.get(row.query) || { query: row.query, impressions: 0, clicks: 0 };
    q.impressions += impressions;
    q.clicks += clicks;
    total.queries.set(row.query, q);
  }

  let allImpressions = 0;
  let allClicks = 0;
  const rows = (pageRows || []).map((page) => {
    const impressions = Number(page.impressions || 0);
    const clicks = Number(page.clicks || 0);
    allImpressions += impressions;
    allClicks += clicks;
    const excluded = excludedByPath.get(page.path);
    if (!excluded) return page;
    // Le righe pagina×query omettono le anonimizzate, quindi la loro somma
    // non supera i totali di pagina; i clamp coprono gli arrotondamenti GSC.
    const mainImpressions = Math.max(0, impressions - excluded.impressions);
    const mainClicks = Math.max(0, Math.min(mainImpressions, clicks - excluded.clicks));
    const pagePosition = Number(page.position);
    let position = null;
    if (mainImpressions > 0 && Number.isFinite(pagePosition)) {
      position = Math.max(1, (pagePosition * impressions - excluded.positionWeight) / mainImpressions);
    }
    return {
      ...page,
      clicks: mainClicks,
      impressions: mainImpressions,
      ctr: mainImpressions > 0 ? mainClicks / mainImpressions : null,
      position,
    };
  });

  const summarized = Object.fromEntries(Object.entries(segments).map(([name, s]) => [name, {
    impressions: s.impressions,
    clicks: s.clicks,
    ctr: s.impressions > 0 ? s.clicks / s.impressions : null,
    topQueries: [...s.queries.values()]
      .sort((a, b) => b.impressions - a.impressions || a.query.localeCompare(b.query))
      .slice(0, topQueries),
  }]));

  return {
    rows,
    segments: summarized,
    allQueries: {
      impressions: allImpressions,
      clicks: allClicks,
      ctr: allImpressions > 0 ? allClicks / allImpressions : null,
    },
  };
}

/**
 * Proiezione dei segmenti esclusi per lo state file: totali arrotondati e le
 * prime query, abbastanza per ritrovarle senza riaprire la Search Console.
 */
export function excludedSegmentsForState(segments, { topQueries = 3 } = {}) {
  return Object.fromEntries(EXCLUDED_CTR_SEGMENTS.map((name) => {
    const s = segments?.[name] || { impressions: 0, clicks: 0, ctr: null, topQueries: [] };
    return [name, {
      impressions: s.impressions,
      clicks: s.clicks,
      ctr: s.ctr === null ? null : Number(s.ctr.toFixed(4)),
      topQueries: (s.topQueries || []).slice(0, topQueries),
    }];
  }));
}

function pctCell(n) {
  return n === null || n === undefined ? 'n/a' : `${(n * 100).toFixed(2)}%`;
}

function mdQuery(query) {
  return `\`${String(query).replace(/`/g, "'").replace(/\|/g, '/')}\``;
}

/**
 * Sezione markdown della issue (e del log): cosa e' stato tolto dalla metrica
 * principale e quanto pesava. Senza, una famiglia che risale sopra la soglia
 * perche' la misura e' cambiata sembrerebbe guarita.
 */
export function renderExcludedSegmentsSection({ segments, allQueries, measureVersion = CTR_MEASURE_VERSION } = {}) {
  const lines = [
    '### Query escluse dalla metrica principale',
    '',
    `Misura \`${measureVersion}\` (decisione I5 del 2026-10-05): la CTR qui sopra conta solo le query`,
    'con intento plausibile di lavoro; la soglia e\' la stessa di prima. Le query anonimizzate',
    'della Search Console restano dentro la metrica principale.',
    '',
    '| Segmento | Impressioni | Click | CTR | Query principali |',
    '|---|---:|---:|---:|---|',
  ];
  for (const name of EXCLUDED_CTR_SEGMENTS) {
    const s = segments?.[name] || { impressions: 0, clicks: 0, ctr: null, topQueries: [] };
    const top = (s.topQueries || []).map((q) => `${mdQuery(q.query)} (${q.impressions})`).join(', ') || '—';
    lines.push(`| ${SEGMENT_LABEL[name]} | ${s.impressions} | ${s.clicks} | ${pctCell(s.ctr)} | ${top} |`);
  }
  if (allQueries) {
    lines.push(`| Tutte le query (misura precedente) | ${allQueries.impressions} | ${allQueries.clicks} | ${pctCell(allQueries.ctr)} | — |`);
  }
  return lines.join('\n');
}

/**
 * Riga che dichiara un cambio di misura fra il controllo precedente e questo.
 * Restituisce null quando la misura e' la stessa.
 */
export function describeMeasureChange(prior, { measureVersion = CTR_MEASURE_VERSION, allQueriesCtr = null } = {}) {
  const priorVersion = prior?.measureVersion || LEGACY_CTR_MEASURE_VERSION;
  if (priorVersion === measureVersion) return null;
  const priorCtr = typeof prior?.lastCtr === 'number' ? pctCell(prior.lastCtr) : 'n/a';
  return `Cambio di misura: il controllo precedente (${priorCtr}) usava \`${priorVersion}\`, questo \`${measureVersion}\`; `
    + `i due numeri non sono confrontabili. Sulla misura precedente (tutte le query) oggi: ${pctCell(allQueriesCtr)}.`;
}
