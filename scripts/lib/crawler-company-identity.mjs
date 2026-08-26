/**
 * Chi e' l'azienda dietro un crawler — deciso in modo deterministico.
 *
 * `data/crawler-companies-auto.json` alimenta la directory aziende pubblica
 * (`components/vita/TicinoCompanies.tsx`) e tre script di outreach. Il nome di
 * un'entry e' quindi contenuto, non diagnostica: sbagliarlo si vede in pagina.
 *
 * Il generatore lo prendeva da `jobs[0].company` dello slice del crawler. Uno
 * slice pero' NON e' garantito mono-datore: `coop-ticino` copre legittimamente
 * Fust, Jumbo e Interdiscount, `volg-fenaco` copre VOLG, LANDI e TRAVECO,
 * `burkhalter` copre 84 ragioni sociali del gruppo. Il primo record e' l'ordine
 * di crawl, non l'identita' del crawler — misurati 19 slice multi-datore su 609
 * runner, e su quelli il primo record dava `fust -> Coop Genossenschaft`,
 * `volg -> TRAVECO Transporte AG`, `hilcona -> Eisberg Osterreich GmbH`.
 *
 * Le due funzioni qui sotto sono pure e senza I/O apposta: il generatore fa
 * l'I/O, e il test puo' esercitare la regola su fixture in memoria senza
 * materializzare i 444 MB di `data/jobs/by-crawler/` (assenti in un worktree
 * sparse).
 */
import fs from 'node:fs';
import { matchFirstQuotedLiteral } from './js-string-literal.mjs';

/**
 * I prefissi si fermano PRIMA della virgoletta: il literal lo legge lo scanner
 * di `js-string-literal.mjs`, non una classe di caratteri.
 *
 * Stanno qui e non nel generatore perche' il test li usa per verificare
 * l'invariante sul dato pubblicato — «la scheda porta il nome che il crawler
 * dichiara» — e una copia della lista nel test sarebbe una copia che deriva.
 */
export const DECLARED_NAME_PREFIXES = [
  /(?:COMPANY_NAME|companyLabel)\s*[:=]\s*/,
  /const\s+\w+_COMPANY_NAME\s*=\s*/,
  /company:\s*/,
];
export const DECLARED_DOMAIN_PREFIXES = [
  /(?:COMPANY_DOMAIN|COMPANY_HOST|companyDomain)\s*[:=]\s*/,
  /const\s+\w+_COMPANY_DOMAIN\s*=\s*/,
];
export const DECLARED_CAREERS_PREFIXES = [/CAREERS_URL\s*=\s*/, /careersUrl\s*[:=]\s*/];

/**
 * Cio' che un runner o un parser DICHIARA su di se': nome, dominio, careers URL.
 *
 * E' l'affermazione del crawler su quale datore sta seguendo, e batte quello che
 * lo slice ha trovato — vedi `summariseSliceCompanies` per il perche'.
 *
 * @param {string} filePath
 * @returns {{ company?: string, companyDomain?: string, careersUrl?: string }}
 */
export function extractDeclaredIdentity(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const src = fs.readFileSync(filePath, 'utf8');
    const result = {};

    const company = matchFirstQuotedLiteral(src, DECLARED_NAME_PREFIXES);
    if (company) result.company = company;

    const companyDomain = matchFirstQuotedLiteral(src, DECLARED_DOMAIN_PREFIXES);
    if (companyDomain) result.companyDomain = companyDomain;

    const careersUrl = matchFirstQuotedLiteral(src, DECLARED_CAREERS_PREFIXES);
    if (careersUrl) result.careersUrl = careersUrl;

    return result;
  } catch {
    return {};
  }
}

/**
 * Slug che il generatore NON deve mai promuovere a voce della directory.
 *
 * Il prospector sintetizza un runner per ogni tenant che scopre, e lo slug
 * nasce dal percorso dell'URL: quando il datore non compare nel path restano
 * frammenti come `careers`, `de` o l'id numerico del tenant ATS
 * (`recruitingapp-2649`). Sono crawler validi — i job che raccolgono sono
 * veri — ma non sono un'azienda: in pagina diventerebbero una scheda intestata
 * a «Careers» o «Recruitingapp 2649».
 *
 * Escluderli qui li toglie dalla DIRECTORY, non dal crawling: il runner resta,
 * lo slice resta, i job restano pubblicati.
 */
const NON_EMPLOYER_SLUGS = new Set([
  'careers',
  'career',
  'jobs',
  'job',
  'offres',
  'emploi',
  'emplois',
  'lavoro',
  'karriere',
  'stellen',
  'vacancies',
  'home',
  'www',
  'de',
  'en',
  'fr',
  'it',
]);

/**
 * Id di tenant su una piattaforma ATS ospitata: numero puro dietro il nome del
 * vendor. `recruitingapp-2649` e' l'identificativo della Alexander von
 * Humboldt-Stiftung dentro Rexx, non un nome d'azienda.
 */
const ATS_TENANT_SLUG_RE =
  /^(?:recruitingapp|recruitee|workable|greenhouse|smartrecruiters|personio|lever|jobs?)-\d+$/;

/**
 * @param {string} slug
 * @returns {boolean} true se lo slug e' un frammento di URL o un id di tenant,
 *   non l'identita' di un datore di lavoro.
 */
export function isNonEmployerSlug(slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (!s) return true;
  return NON_EMPLOYER_SLUGS.has(s) || ATS_TENANT_SLUG_RE.test(s);
}

/**
 * Conteggio deterministico: piu' frequente prima, poi ordine alfabetico a
 * parita' di conteggio, cosi' due run sullo stesso slice danno lo stesso nome.
 *
 * @param {Iterable<string>} values
 * @returns {Array<[string, number]>}
 */
function tally(values) {
  const counts = new Map();
  for (const raw of values) {
    const value = String(raw || '').trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'it'));
}

/**
 * Nome e dominio che uno slice puo' affermare da solo.
 *
 * La regola e' la **maggioranza assoluta**, non la moda. Una moda esiste sempre
 * e su uno slice di gruppo e' semplicemente il marchio piu' prolifico: su
 * `coop-ticino` sarebbe «Coop Genossenschaft» con il 45% dei job, che verrebbe
 * scritto come nome del crawler `coop`. Senza maggioranza lo slice dichiara
 * `name: ''` — cioe' **si astiene**, e il generatore ricade sul nome dichiarato
 * dal runner o sullo slug. Un'astensione e' recuperabile; un nome sbagliato in
 * pagina no.
 *
 * Il dominio non si sceglie insieme al nome ma **dopo**, e per il nome che ha
 * vinto davvero. Il chiamante puo' preferire il nome DICHIARATO dal runner a
 * quello dello slice (ed e' quello che fa), quindi un dominio deciso qui
 * seguirebbe il marchio sbagliato: su `fust` il nome finale e' «Fust» mentre la
 * maggioranza dello slice e' «Coop Genossenschaft», e accoppiarli darebbe la
 * scheda «Fust» con il dominio di Coop. Per questo `domains` e' una mappa
 * nome -> dominio dominante, e `domain` e' solo la voce del nome che lo slice
 * stesso avrebbe scelto.
 *
 * @param {ReadonlyArray<{ company?: string, companyDomain?: string }>} jobs
 * @returns {{
 *   name: string,
 *   domain: string,
 *   domains: Record<string, string>,
 *   total: number,
 *   named: number,
 *   distinct: number,
 *   topName: string,
 *   topCount: number,
 * }}
 */
export function summariseSliceCompanies(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  const ranked = tally(list.map((j) => j?.company));
  const named = ranked.reduce((sum, [, n]) => sum + n, 0);
  const [topName = '', topCount = 0] = ranked[0] || [];

  const hasMajority = named > 0 && topCount * 2 > named;
  const name = hasMajority ? topName : '';

  /** @type {Record<string, string>} */
  const domains = {};
  for (const [candidate] of ranked) {
    const domain = tally(
      list
        .filter((j) => String(j?.company || '').trim() === candidate)
        .map((j) => j?.companyDomain),
    )[0]?.[0];
    if (domain) domains[candidate] = domain;
  }

  return {
    name,
    domain: name ? domains[name] || '' : '',
    domains,
    total: list.length,
    named,
    distinct: ranked.length,
    topName,
    topCount,
  };
}

/** Case/whitespace-insensitive: solo per confrontare, mai per pubblicare. */
function normalizeCompanyName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Dominio che lo slice associa a un nome gia' scelto.
 *
 * Il lookup diretto puo' mancare per pura formattazione — costante del runner
 * vs stringa crawlata (spazi, maiuscole) — e in quel caso un confronto
 * case/whitespace-insensitive sulle chiavi di `domains` lo recupera comunque:
 * e' lo STESSO brand, solo scritto diverso.
 *
 * Se invece il nome scelto non compare in `domains` con NESSUNA normalizzazione,
 * non e' un problema di formattazione: e' un brand diverso da quello che lo
 * slice conosce (es. runner dichiara «Fust», slice e' a maggioranza «Coop
 * Genossenschaft» — la forma vera di questo crawler). Ricadere qui su
 * `summary.domain` accoppierebbe il nome scelto al dominio del vincitore di
 * maggioranza, cioe' esattamente l'attribuzione sbagliata che questo modulo
 * esiste per evitare (vedi il docblock in testa al file). Si ritorna quindi
 * stringa vuota: il chiamante ha gia' un fallback successivo al dominio
 * DICHIARATO dal runner/parser (vedi `generate-crawler-companies.mjs`), che e'
 * la fonte giusta quando lo slice non sa nulla del nome scelto.
 *
 * @param {ReturnType<typeof summariseSliceCompanies>|null|undefined} summary
 * @param {string} chosenName
 * @returns {string}
 */
export function sliceDomainForName(summary, chosenName) {
  if (!summary) return '';
  const trimmed = String(chosenName || '').trim();
  const direct = summary.domains?.[trimmed];
  if (direct) return direct;

  const normalizedChosen = normalizeCompanyName(trimmed);
  if (!normalizedChosen) return '';
  for (const [candidate, domain] of Object.entries(summary.domains || {})) {
    if (normalizeCompanyName(candidate) === normalizedChosen) return domain;
  }
  return '';
}
