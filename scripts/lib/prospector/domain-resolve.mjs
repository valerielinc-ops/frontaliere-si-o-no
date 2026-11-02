/**
 * Resolve an employer NAME to its website, when a discovery source gave us a
 * name but no domain (the SECO feed carries a website on 3% of ads).
 *
 * Guess-and-verify, because Swiss SMEs overwhelmingly own their own name as a
 * domain. A first pass that accepted any single-token match resolved 63% of
 * names but produced junk like `CANTINA IL CAVALIERE SA -> cantina.com` and
 * `Cooperativa Migros -> cooperativa.com`: one generic word out of three is not
 * an identification. So verification here scores several independent pieces of
 * evidence and needs more than one of them to agree.
 *
 * A wrong domain is much more expensive than an unresolved one — it sends the
 * careers trail off to a stranger's site and can seed a false platform — so the
 * threshold is deliberately set to under-resolve.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { politeFetch } from './polite-fetch.mjs';
import { registrableDomain } from './registrable.mjs';
import { decodeEntities } from './entities.mjs';
import { jsonLdBlocks, textOf } from './extract.mjs';
import { NON_PLATFORM_HOSTS } from './config.mjs';
import { createSpecUrlPolicy, resolveProspectorFetch } from './public-fetch-policy.mjs';
import {
  googlePlacesStatus,
  isGooglePlacesStopStatus,
} from '../google-places-budget.mjs';

function retryableResponse(response) {
  if (response?.policyBlocked || response?.blockedByRobots) return false;
  const status = Number(response?.status) || 0;
  return status === 0 || status === 401 || status === 403 || status === 408
    || status === 425 || status === 429 || status >= 500
    || Boolean(response?.transportError);
}

const LEGAL_FORMS = 'sa|ag|sagl|gmbh|srl|sarl|spa|ltd|inc|llc|succursale|filiale';
const ARTICLES = 'di|e|the|of|und|et|il|lo|la|le|gli|der|die|das|les|des|del|della|dei';
const DESCRIPTORS = 'group|gruppo|holding|swiss|suisse|svizzera|schweiz|ticino|societa|società|cooperativa|fondazione|associazione|studio|ristorante|hotel|garage|azienda|centro|casa';
const STOPWORDS = new RegExp(`^(${LEGAL_FORMS}|${ARTICLES}|${DESCRIPTORS})$`);
const LEGAL_FORM_RX = new RegExp(`^(${LEGAL_FORMS})$`);
const ARTICLE_RX = new RegExp(`^(${ARTICLES})$`);
/** An article can open a name (`la-motta`); a preposition cannot (`di-locarno`). */
const OPENING_ARTICLE_RX = /^(the|il|lo|la|le|gli|der|die|das|les)$/;
/** Words that join two names, so they can stand for each other in a domain. */
const CONNECTOR_RX = /^(&|\+|and|e|und|et)$/;

/** A domain the legal name spells out, as in `Iride.ch SA` or `(bm-emplois.ch)`. */
const EMBEDDED_DOMAIN_RX = /(?<![a-z0-9@.-])(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:ch|swiss|li|com|net|org|eu|it|de|fr|at|io))(?![a-z0-9-]|\.[a-z0-9])/g;

const foldName = (name) => String(name).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * Domains the employer's legal name states outright. Job boards are dropped:
 * they name a marketplace, and the loop never treats one as an employer.
 *
 * @param {string} name
 * @returns {string[]}
 */
export function embeddedDomains(name = '') {
  const found = [...foldName(name).matchAll(EMBEDDED_DOMAIN_RX)].map((match) => registrableDomain(match[1]));
  return [...new Set(found)].filter((domain) => domain && !NON_PLATFORM_HOSTS.has(domain));
}

/** `iride.ch sa` -> `iride sa`: a TLD spelled in the name is not part of the name. */
function withoutEmbeddedTld(folded) {
  return folded.replace(EMBEDDED_DOMAIN_RX, (_, domain) => domain.split('.').slice(0, -1).join(' '));
}

/**
 * Significant tokens of a company name — the ones that identify it.
 * @param {string} name
 * @returns {string[]}
 */
export function nameTokens(name = '') {
  return withoutEmbeddedTld(foldName(name))
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.test(t));
}

/** The name in order, without legal forms: articles and descriptors can be part of a domain. */
function domainWords(name) {
  return withoutEmbeddedTld(foldName(name))
    .replace(/&/g, ' & ').replace(/\+/g, ' + ')
    .replace(/[^a-z0-9&+]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word && !LEGAL_FORM_RX.test(word));
}

/** The company proper: a branch suffix or a second clause names a place or a unit. */
function tradingName(name) {
  return String(name).split(/,| - | – |\(|\bsuccursale\b|\bfiliale\b|\bzweigniederlassung\b/i)[0];
}

/** Nobody registers a domain longer than this many words of a legal name. */
const MAX_RUN_WORDS = 4;

const isSignificant = (word) => word.length > 1 && !STOPWORDS.test(word) && !CONNECTOR_RX.test(word);

/** Every joined spelling of a run of words, with the connector written all the ways a domain writes it. */
function spellings(words) {
  const literal = words.find((word) => CONNECTOR_RX.test(word));
  const written = literal && !/^[&+]$/.test(literal) ? [literal] : [];
  const connectors = literal ? ['', ...new Set([...written, 'and', 'e'])] : [''];
  return connectors.flatMap((connector) => {
    const spelled = words.flatMap((word) => {
      if (!CONNECTOR_RX.test(word)) return [word];
      return connector ? [connector] : [];
    });
    return [spelled.join(''), spelled.join('-')];
  });
}

/** Contiguous runs, longest first, that hold a name and neither open nor close on a function word. */
function nameRuns(words) {
  const runs = [];
  for (let size = Math.min(words.length, MAX_RUN_WORDS); size >= 2; size--) {
    for (let start = 0; start + size <= words.length; start++) {
      const run = words.slice(start, start + size);
      if (!run.some(isSignificant)) continue;
      if (ARTICLE_RX.test(run[0]) && !OPENING_ARTICLE_RX.test(run[0])) continue;
      if (CONNECTOR_RX.test(run[0]) || CONNECTOR_RX.test(run.at(-1)) || ARTICLE_RX.test(run.at(-1))) continue;
      runs.push(run);
    }
  }
  return runs;
}

const MAX_GUESSES = 36;
const GOOGLE_PLACES_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const GOOGLE_PLACES_FIELD_MASK = 'places.id,places.displayName,places.websiteUri';
const SHARED_OR_AGENCY_DOMAINS = new Set([
  'admin.ch',
  'manpower.ch',
  'adecco.ch',
  'randstad.ch',
  'michaelpage.ch',
  'hays.ch',
  'easyapply.jobs',
]);

/**
 * Domains an employer of this name plausibly owns, best first.
 *
 * A single-token guess (`cantina.ch` from "Cantina Il Cavaliere") is only
 * offered when the trading name really is one token — that guess was the entire
 * source of the false positives measured above. Longer guesses keep the words
 * that identify nothing alone (`la-motta`, `garage-rossi`). The list is long
 * because DNS filters it before any request reaches the employer's server.
 *
 * @param {string} name
 * @returns {string[]}
 */
export function domainGuesses(name = '') {
  const bases = [];
  for (const source of [tradingName(name), name]) {
    const words = domainWords(source);
    const significant = words.filter(isSignificant);
    if (!significant.length) continue;
    const plain = words.filter((word) => !CONNECTOR_RX.test(word));
    for (const run of nameRuns(words)) bases.push(...spellings(run));
    if (plain.some((word) => !isSignificant(word)) && significant.length > 1) {
      bases.push(significant.join(''), significant.join('-'));
    }
    if (significant.length === 1) bases.push(significant[0]);
  }
  const usable = [...new Set(bases)].filter((base) => base.length >= 3 && base.length <= 45);
  const guesses = [...usable.map((base) => `${base}.ch`), ...usable.map((base) => `${base}.com`)];
  return [...new Set([...embeddedDomains(name), ...guesses])]
    .filter((domain) => !NON_PLATFORM_HOSTS.has(domain))
    .slice(0, MAX_GUESSES);
}

/** A short token must stand alone: `zio` is inside every `servizio`. */
function mentions(text, token) {
  if (token.length >= 5) return text.includes(token);
  return new RegExp(`(?:^|[^a-z0-9])${token}(?:$|[^a-z0-9])`).test(text);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pageMetaIdentityText(html) {
  const values = [];
  const source = String(html || '');
  for (const match of source.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const attributes = Object.fromEntries([...tag.matchAll(/([a-z:-]+)\s*=\s*["']([^"']*)["']/gi)]
      .map((entry) => [entry[1].toLowerCase(), decodeEntities(entry[2])]));
    const key = String(attributes.name || attributes.property || '').toLowerCase();
    if (['og:title', 'og:site_name'].includes(key) && attributes.content) {
      values.push(attributes.content);
    }
  }
  return values.join(' ');
}

function jsonLdIdentityText(html) {
  const values = [];
  const identityKeys = new Set([
    'name', 'legalname', 'streetaddress', 'addresslocality', 'postalcode',
    'addresscountry',
  ]);
  const visit = (value, key = '') => {
    if (values.length >= 60) return;
    if (typeof value === 'string') {
      if (identityKeys.has(key.toLowerCase())) values.push(value.slice(0, 600));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [childKey, childValue] of Object.entries(value)) visit(childValue, childKey);
  };
  for (const block of jsonLdBlocks(html)) visit(block);
  return values.join(' ');
}

function pageIdentityText(html) {
  return [
    textOf(html),
    /<title[^>]*>([\s\S]{0,500}?)<\/title>/i.exec(String(html || ''))?.[1] || '',
    pageMetaIdentityText(html),
    jsonLdIdentityText(html),
  ].map(decodeEntities).join(' ');
}

function hasNamePhrase(text, tokens) {
  if (tokens.length < 2) return false;
  const phrase = tokens.map(escapeRegExp).join('[^a-z0-9]+');
  return new RegExp(`(?:^|[^a-z0-9])${phrase}(?:$|[^a-z0-9])`).test(text);
}

/**
 * Score how strongly a fetched page belongs to this employer.
 *
 * @param {string} html
 * @param {{ name: string, city?: string, zip?: string }} employer
 * @returns {{ score: number, evidence: string[] }}
 */
export function verifyOwnership(html, employer) {
  const evidence = [];
  // Fold accents on the PAGE too, not just on the name tokens. Tokens are
  // already accent-folded (`Zürich` -> `zurich`), so comparing them against a raw
  // page means an accented employer name can never match its own website —
  // silently unresolvable, and the failure looks like "no site found".
  const fold = (v) => String(v).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const body = fold(decodeEntities(pageIdentityText(html)));
  const title = fold(decodeEntities(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html)?.[1] || ''));
  const tokens = nameTokens(employer.name);
  if (!tokens.length || body.length < 200) return { score: 0, evidence };

  const hits = tokens.filter((t) => mentions(body, t));
  const coverage = hits.length / tokens.length;
  let score = 0;
  if (coverage === 1 && tokens.length >= 2) { score += 2; evidence.push('all-tokens'); }
  else if (coverage >= 0.5) { score += 1; evidence.push(`tokens:${hits.length}/${tokens.length}`); }

  if (hasNamePhrase(body, tokens)) evidence.push('name-phrase');

  if (tokens.filter((t) => mentions(title, t)).length >= Math.min(2, tokens.length)) {
    score += 1.5; evidence.push('title');
  }
  if (employer.zip && body.includes(String(employer.zip))) { score += 1.5; evidence.push('zip'); }
  if (employer.city) {
    const city = String(employer.city).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[ ,(]/)[0];
    if (city.length > 2 && body.includes(city)) { score += 1; evidence.push('city'); }
  }
  // A Swiss employer's own site nearly always names the country or a CH phone
  // prefix somewhere; a squatted generic .com usually does not.
  if (/\+41|\bsvizzera\b|\bschweiz\b|\bsuisse\b|\bswitzerland\b/.test(body)) { score += 0.5; evidence.push('ch-signal'); }
  return { score, evidence };
}

/** The application address already vouches for the domain, so one more signal beside the name settles it. */
const HINTED_DOMAIN_MIN_SCORE = 2;

/**
 * HTTP calls one employer may cost: pages, redirects and robots.txt, across
 * every domain tried. DNS spends them on domains that exist.
 */
const MAX_HTTP_CALLS = 10;
/** Below this a response is a parking page or a redirect stub, not a site to read. */
const MIN_SITE_BODY_CHARS = 400;
const DNS_LOOKUP_BATCH = 6;
const DNS_MISSING_CODES = new Set(['ENOTFOUND', 'ENODATA', 'EAI_NONAME', 'EAI_NODATA']);

/**
 * @param {string} host
 * @param {typeof dnsLookup} lookupImpl
 * @returns {Promise<'live'|'absent'|'unknown'>}
 */
async function dnsState(host, lookupImpl) {
  try {
    const answer = await lookupImpl(host, { all: true });
    return (Array.isArray(answer) ? answer.length : answer) ? 'live' : 'absent';
  } catch (error) {
    return DNS_MISSING_CODES.has(error?.code) ? 'absent' : 'unknown';
  }
}

/**
 * A guess built from part of the name can land on a namesake: `team.ch` is not
 * "das team ag". It holds if the page places the employer, names it in full, or
 * the domain itself spells every word of the trading name.
 *
 * @param {string[]} evidence
 * @param {string} domain
 * @param {string} name
 * @returns {boolean}
 */
function identifiesEmployer(evidence, domain, name) {
  if (evidence.some((e) => e === 'all-tokens' || e === 'zip' || e === 'city')) return true;
  if (!evidence.some((e) => /^tokens:(\d+)\/\1$/.test(e))) return false;
  const label = domain.split('.')[0].replace(/-/g, '');
  return domainWords(tradingName(name))
    .filter((word) => !CONNECTOR_RX.test(word))
    .every((word) => label.includes(word));
}

function compactDomainLabel(domain) {
  return registrableDomain(domain).split('.')[0].replace(/[^a-z0-9]/g, '');
}

function domainLabelAlignsWithEmployer(domain, name) {
  const label = compactDomainLabel(domain);
  const tokens = nameTokens(tradingName(name));
  return tokens.length > 0 && tokens.every((token) => label.includes(token));
}

function domainOwnerNames(domain, owners) {
  if (!owners) return [];
  const raw = owners instanceof Map ? owners.get(domain) : owners[domain];
  const values = raw instanceof Set ? [...raw] : (Array.isArray(raw) ? raw : raw ? [raw] : []);
  return values.map((value) => (typeof value === 'string' ? value : value?.name)).filter(Boolean);
}

function sameEmployerName(left, right) {
  const a = nameTokens(left).join(' ');
  const b = nameTokens(right).join(' ');
  return Boolean(a && b && a === b);
}

/**
 * A Places result is a lead, not proof that the returned domain belongs to the
 * candidate. Shared staffing/government domains and domains already attached
 * to another employer are rejected before a result can be persisted.
 */
function googleDomainAllowed(domain, employer, evidence, knownDomainOwners) {
  if (SHARED_OR_AGENCY_DOMAINS.has(registrableDomain(domain))) return false;
  const owners = domainOwnerNames(registrableDomain(domain), knownDomainOwners);
  if (owners.length > 1 || (owners.length === 1 && !sameEmployerName(owners[0], employer.name))) return false;
  if (domainLabelAlignsWithEmployer(domain, employer.name)) return true;
  return evidence.includes('name-phrase') && evidence.includes('title') && evidence.includes('zip');
}

function rememberGoogleDomainOwner(domain, employer, knownDomainOwners) {
  if (!(knownDomainOwners instanceof Map)) return;
  const key = registrableDomain(domain);
  const owners = knownDomainOwners.get(key) || new Set();
  owners.add(employer.name);
  knownDomainOwners.set(key, owners);
}

function googleDisplayName(place) {
  return typeof place?.displayName === 'string'
    ? place.displayName
    : (place?.displayName?.text || '');
}

function googleDisplayNameMatches(place, employer) {
  const display = String(googleDisplayName(place)).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const tokens = nameTokens(employer.name);
  return tokens.length > 0 && tokens.every((token) => mentions(display, token));
}

function websiteHint(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const domain = registrableDomain(url.hostname);
    if (!domain || NON_PLATFORM_HOSTS.has(domain)) return null;
    return { url: url.toString(), domain };
  } catch {
    return null;
  }
}

/**
 * Keep the guesses DNS knows, in order, until the probe budget is full. A site
 * can answer on the apex, on `www.` only, or on both; `unknown` means the
 * resolver failed, which proves nothing about the domain.
 *
 * @param {string[]} guesses
 * @param {typeof dnsLookup} lookupImpl
 * @param {number} wanted
 * @returns {Promise<{ live: { domain: string, hosts: string[] }[], unknown: number, absent: number }>}
 */
async function filterByDns(guesses, lookupImpl, wanted) {
  const live = [];
  let unknown = 0;
  let absent = 0;
  for (let start = 0; start < guesses.length && live.length < wanted; start += DNS_LOOKUP_BATCH) {
    const checked = await Promise.all(guesses.slice(start, start + DNS_LOOKUP_BATCH).map(async (domain) => {
      const hosts = [domain, `www.${domain}`];
      return { domain, hosts, states: await Promise.all(hosts.map((host) => dnsState(host, lookupImpl))) };
    }));
    for (const { domain, hosts, states } of checked) {
      const liveHosts = hosts.filter((_, index) => states[index] === 'live');
      if (liveHosts.length) live.push({ domain, hosts: liveHosts });
      else if (states.includes('unknown')) unknown++;
      else absent++;
    }
  }
  return { live: live.slice(0, wanted), unknown, absent };
}

/**
 * Count every HTTP call of one employer. A probe has no internal retries: a
 * transient failure marks the candidate retryable and TRACE returns on its own
 * schedule, instead of spending the budget on the same host now.
 *
 * @param {Record<string, any>} opts
 * @returns {{ left: number, refused: boolean, opts: Record<string, any> }}
 */
function httpBudget(opts) {
  const requestFetch = resolveProspectorFetch(opts.fetchImpl);
  const budget = {
    left: MAX_HTTP_CALLS,
    refused: false,
    opts: {
      retries: 0,
      ...opts,
      /** @type {typeof fetch} */
      fetchImpl: (...request) => {
        if (budget.left <= 0) {
          budget.refused = true;
          throw new Error('prospector domain probe budget spent');
        }
        budget.left--;
        return requestFetch(...request);
      },
    },
  };
  return budget;
}

/**
 * Fetch an employer's homepage on the apex or on `www.`, stopping at the first
 * host that serves a real page. A short 200 on the apex says nothing about `www.`.
 *
 * `politeFetch` allows only the origin of the URL it is given, and most Swiss
 * SME sites redirect the apex to `www.`, so without both origins in the policy
 * the redirect is a policy rejection and a real site reads as no site. Any other
 * cross-origin redirect stays rejected: the guess was this domain, not that one.
 *
 * @param {string} domain
 * @param {string[]} hosts
 * @param {ReturnType<typeof httpBudget>} budget  shared by every domain of one employer
 * @returns {Promise<{ response: any, failures: any[] }>}
 */
async function fetchSite(domain, hosts, budget) {
  const urlPolicy = createSpecUrlPolicy(
    { seedUrls: [`https://${domain}/`, `https://www.${domain}/`] },
    { lookupImpl: budget.opts.lookupImpl },
  );
  const failures = [];
  try {
    for (const host of hosts) {
      if (budget.left <= 0) break;
      let response;
      try {
        response = await politeFetch(`https://${host}/`, { ...budget.opts, urlPolicy, dispatcher: urlPolicy.dispatcher });
      } catch {
        response = { ok: false, status: 0, body: '', transportError: 'network' };
      }
      // A spent budget is this function's limit, not a site that failed.
      if (budget.refused) break;
      if (response.ok && response.body.length >= MIN_SITE_BODY_CHARS) return { response, failures: [] };
      if (!response.ok) failures.push(response);
    }
    return { response: null, failures };
  } finally {
    await urlPolicy.dispatcher?.close?.();
  }
}

/**
 * Fetch the transient Google website hint first, then its apex/www fallbacks.
 * The path matters: several Swiss SME sites put their identity on a landing
 * page while the root is a thin CMS shell. The URL is never returned or
 * persisted; only a domain that independently passes verifyOwnership is.
 */
async function fetchWebsiteHint(hint, budget) {
  const urls = [
    hint.url,
    `https://${hint.domain}/`,
    `https://www.${hint.domain}/`,
  ].filter((url, index, all) => all.indexOf(url) === index);
  const urlPolicy = createSpecUrlPolicy(
    { seedUrls: urls },
    { lookupImpl: budget.opts.lookupImpl },
  );
  const failures = [];
  try {
    for (const url of urls) {
      if (budget.left <= 0) break;
      let response;
      try {
        response = await politeFetch(url, { ...budget.opts, urlPolicy, dispatcher: urlPolicy.dispatcher });
      } catch {
        response = { ok: false, status: 0, body: '', transportError: 'network' };
      }
      if (budget.refused) break;
      if (response.ok && response.body.length >= MIN_SITE_BODY_CHARS) return { response, failures: [] };
      if (!response.ok) failures.push(response);
    }
    return { response: null, failures };
  } finally {
    await urlPolicy.dispatcher?.close?.();
  }
}

async function googleResponsePayload(response) {
  if (!response || typeof response !== 'object' || response.ok === undefined) return response;
  if (!response.ok) {
    const error = new Error(`Google Places HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  if (typeof response.json === 'function') return response.json();
  if (typeof response.text === 'function') return JSON.parse(await response.text());
  return response;
}

/**
 * Search Places once. This function deliberately has no retry loop: a quota,
 * credential, or rate-limit response stops the lane immediately, and every
 * attempted request was reserved before entering it.
 */
async function resolveViaGooglePlaces(employer, minScore, budget, google, http) {
  const stats = {
    attempted: false,
    requests: 0,
    places: 0,
    websites: 0,
    verified: 0,
    rejected: 0,
    outcome: 'not_attempted',
    failureCode: null,
  };
  const apiKey = google?.apiKey ?? process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return { stats: { ...stats, outcome: 'api_key_missing' }, result: null };
  if (!budget?.reserve || !budget.reserve()) {
    const reason = budget?.reason?.() || 'budget_exhausted';
    return {
      stats: {
        ...stats,
        outcome: /^http_/.test(reason) ? 'api_stopped' : reason,
        failureCode: /^http_/.test(reason) ? reason : null,
      },
      result: null,
    };
  }
  stats.attempted = true;
  stats.requests = 1;

  const request = google.fetchJson || (async (url, init) => {
    const requestFetch = resolveProspectorFetch(google.fetchImpl);
    return requestFetch(url, init);
  });
  const query = [employer.name, employer.city].filter(Boolean).join(' ').trim();
  try {
    const raw = await request(GOOGLE_PLACES_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': GOOGLE_PLACES_FIELD_MASK,
      },
      body: JSON.stringify({ textQuery: query, regionCode: 'CH', pageSize: 1 }),
    });
    const payload = await googleResponsePayload(raw);
    const places = Array.isArray(payload?.places) ? payload.places : [];
    stats.places = places.length;
    const place = places[0];
    if (!place) return { stats: { ...stats, outcome: 'no_place' }, result: null };
    const hint = websiteHint(place.websiteUri);
    if (!hint) return { stats: { ...stats, outcome: 'no_website' }, result: null };
    stats.websites = 1;
    if (!googleDisplayNameMatches(place, employer)) {
      return { stats: { ...stats, rejected: 1, outcome: 'display_name_mismatch' }, result: null };
    }
    const { response, failures } = await fetchWebsiteHint(hint, http);
    if (!response) {
      for (const failure of failures) {
        const status = Number(failure?.status) || 0;
        if (status) stats.failureCode = `http_${status}`;
      }
      return {
        stats: { ...stats, outcome: 'site_unavailable' },
        result: null,
        failures,
      };
    }
    const verified = verifyOwnership(response.body, employer);
    if (verified.score < minScore || !googleDomainAllowed(hint.domain, employer, verified.evidence, google.knownDomainOwners)) {
      return { stats: { ...stats, rejected: 1, outcome: 'unverified' }, result: null };
    }
    rememberGoogleDomainOwner(hint.domain, employer, google.knownDomainOwners);
    stats.verified = 1;
    return {
      stats: { ...stats, outcome: 'resolved' },
      result: {
        domain: hint.domain,
        score: verified.score,
        evidence: [...verified.evidence, 'google-places'],
        ...(typeof place.id === 'string' && place.id ? { placeId: place.id } : {}),
      },
    };
  } catch (error) {
    const status = googlePlacesStatus(error);
    if (isGooglePlacesStopStatus(status)) {
      budget.stop(status);
      return {
        stats: { ...stats, outcome: 'api_stopped', failureCode: `http_${status}` },
        result: null,
        stopped: true,
      };
    }
    const retryable = status === 0 || status >= 500;
    return {
      stats: { ...stats, outcome: 'unavailable', failureCode: status ? `http_${status}` : 'transport' },
      result: null,
      retryable,
    };
  }
}

/**
 * @param {{ name: string, city?: string, zip?: string, domainHints?: string[] }} employer
 * @param {{ minScore?: number, lookupImpl?: typeof dnsLookup, googlePlaces?: { apiKey?: string, budget?: { reserve?: () => boolean, stop?: (status: number) => void, reason?: () => string, }, fetchJson?: Function, fetchImpl?: typeof fetch, knownDomainOwners?: Map<string, Set<string>> } }} [opts]
 * @returns {Promise<{ domain: string|null, score: number, evidence: string[], tried: number, retryable: boolean, failureStatuses: number[], dnsAbsent: number, source?: string|null, placeId?: string, googlePlaces?: object }>}
 */
export async function resolveDomain(employer, opts = {}) {
  const minScore = opts.minScore ?? 3;
  let best = { domain: null, score: 0, evidence: [], tried: 0, retryable: false, failureStatuses: [], dnsAbsent: 0, source: null };
  const recordFailures = (failures) => {
    for (const failure of failures) {
      best.failureStatuses.push(Number(failure.status) || 0);
      if (retryableResponse(failure)) best.retryable = true;
    }
  };
  const triedHints = [];
  const budget = httpBudget(opts);
  const vouched = [
    ...(employer.domainHints || []).map((domain) => ({ domain, proof: 'email-domain' })),
    ...embeddedDomains(employer.name).map((domain) => ({ domain, proof: 'name-domain' })),
  ];
  for (const { domain, proof } of vouched) {
    if (budget.left <= 0) break;
    best.tried++;
    if (proof === 'email-domain') triedHints.push(domain);
    const { response: res, failures } = await fetchSite(domain, [domain, `www.${domain}`], budget);
    if (!res) {
      recordFailures(failures);
      continue;
    }
    const v = verifyOwnership(res.body, employer);
    // An agency's site can match the town and the country, never the employer.
    const namesEmployer = v.evidence.some((e) => e === 'all-tokens' || e === 'title' || e.startsWith('tokens:'));
    if (namesEmployer && v.score >= HINTED_DOMAIN_MIN_SCORE) {
      return {
        ...best,
        domain: registrableDomain(new URL(res.url).hostname),
        score: v.score,
        evidence: [...v.evidence, proof],
        triedHints,
      };
    }
  }
  const tested = new Set(vouched.map(({ domain }) => domain));
  const guesses = domainGuesses(employer.name).filter((domain) => !tested.has(domain));
  const { live, unknown, absent } = await filterByDns(guesses, opts.lookupImpl || dnsLookup, budget.left);
  best.dnsAbsent = absent;
  if (unknown) best.retryable = true;
  for (const { domain, hosts } of live) {
    if (budget.left <= 0) break;
    best.tried++;
    const { response: res, failures } = await fetchSite(domain, hosts, budget);
    if (!res) {
      recordFailures(failures);
      continue;
    }
    const v = verifyOwnership(res.body, employer);
    if (v.score > best.score && identifiesEmployer(v.evidence, domain, employer.name)) {
      best = {
        ...best,
        domain: registrableDomain(new URL(res.url).hostname),
        score: v.score,
        evidence: v.evidence,
        tried: best.tried,
      };
    }
    if (best.score >= minScore + 1) break; // decisive, stop paying for more probes
  }
  // Free channels always get first refusal: email SECO hints, explicit name
  // domains, and the DNS-filtered generator above remain useful when the
  // Places allocation is exhausted or the key is unavailable.
  if (best.score >= minScore) return { ...best, triedHints };

  if (opts.googlePlaces) {
    const google = await resolveViaGooglePlaces(employer, minScore, opts.googlePlaces.budget, opts.googlePlaces, budget);
    best = { ...best, googlePlaces: google.stats };
    if (google.failures?.length) recordFailures(google.failures);
    if (google.retryable) best.retryable = true;
    if (google.result) {
      best = {
        ...best,
        ...google.result,
        source: 'google_places',
      };
      return { ...best, triedHints };
    }
  }
  return { ...best, domain: null, triedHints };
}
