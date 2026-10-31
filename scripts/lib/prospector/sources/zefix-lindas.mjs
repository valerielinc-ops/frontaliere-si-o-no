/**
 * Zefix, the federal index of the commercial registers, read from the LINDAS
 * SPARQL endpoint of the Swiss administration.
 *
 * It is the only source that sees a company before the company does anything:
 * no ad, no website, no map entry. That is also its limit. A registry entry
 * proves a legal name and a seat, and nothing about hiring, so the fields kept
 * here are identity only. No ad count, no titles, no purpose text: every later
 * stage must find its own evidence on the employer's site.
 *
 * Terms: opendata.swiss publishes the dataset under "Open use. Must provide the
 * source" and LINDAS declares `TermsOfUse/Provide-the-Source`, so the source is
 * credited in THIRD_PARTY_NOTICES.md. `robots.txt` on the three LINDAS hosts is
 * a blanket `Disallow: /`, which concerns page crawlers: the dataset metadata
 * names this endpoint as its machine access, and as with SECO, Overpass and
 * Common Crawl the request goes to a published API, one query at a time.
 */
import fs from 'node:fs';
import path from 'node:path';
import { politeFetch } from '../polite-fetch.mjs';
import { ZEFIX_CURSORS_PATH } from '../config.mjs';

/** The `void:sparqlEndpoint` declared by https://register.ld.admin.ch/.well-known/dataset/foj-zefix */
export const LINDAS_ENDPOINT = 'https://register.ld.admin.ch/query';

const ZEFIX_GRAPH = 'https://lindas.admin.ch/foj/zefix';
const LEGAL_FORM_BASE = 'https://ld.admin.ch/ech/97/legalforms/';

/**
 * eCH-0097 legal forms that plausibly employ staff. Left out on purpose: sole
 * proprietorships (0101), whose name is a person; associations (0109), mostly
 * without staff; investment vehicles and registered powers of attorney.
 */
export const EMPLOYER_LEGAL_FORMS = Object.freeze([
  '0103', // general partnership
  '0104', // limited partnership
  '0106', // SA/AG
  '0107', // Sagl/GmbH
  '0108', // cooperative
  '0110', // foundation
  '0111', // branch of a foreign company
  '0117', // public-law institution
  '0151', // Swiss branch
]);

/** BFS municipality number ranges per canton. A canton's numbers are contiguous. */
export const CANTON_BFS_RANGES = Object.freeze({
  ZH: [1, 261], BE: [301, 996], LU: [1001, 1151], UR: [1201, 1220], SZ: [1301, 1373],
  OW: [1401, 1407], NW: [1501, 1511], GL: [1630, 1632], ZG: [1701, 1711], FR: [2004, 2338],
  SO: [2401, 2622], BS: [2701, 2703], BL: [2761, 2895], SH: [2901, 2974], AR: [3001, 3038],
  AI: [3101, 3111], SG: [3201, 3444], GR: [3506, 3986], AG: [4001, 4323], TG: [4401, 4953],
  TI: [5001, 5399], VD: [5401, 5939], VS: [6002, 6300], NE: [6404, 6512], GE: [6601, 6645],
  JU: [6701, 6811],
});

/** The clause that states the business. Later text is boilerplate every SA carries. */
const PURPOSE_HEAD_CHARS = 130;
const PASSIVE_PURPOSE_RX = /partecipazion|beteiligung|participation|holding|immobil|liegenschaft|grundst[uü]ck|immeuble/i;
const PENSION_RX = /previdenza|vorsorge|pr[eé]voyance|personalf[uü]rsorge|pensionskasse|wohlfahrt/i;
const LIQUIDATION_RX = /\b(?:in|en) liq(?:uidazione|uidation)?\b/i;

/**
 * Why a registry entry cannot be an employer worth tracing, or null when it can.
 * Holdings and property vehicles are the bulk of what a canton like Ticino
 * registers, and they rarely have staff.
 *
 * @param {{ name: string, purpose: string }} entry
 * @returns {'liquidation'|'no-purpose'|'pension'|'passive'|null}
 */
export function zefixExclusion({ name, purpose }) {
  if (LIQUIDATION_RX.test(name)) return 'liquidation';
  if (!purpose) return 'no-purpose';
  if (PENSION_RX.test(name) || PENSION_RX.test(purpose.slice(0, PURPOSE_HEAD_CHARS))) return 'pension';
  if (PASSIVE_PURPOSE_RX.test(purpose.slice(0, PURPOSE_HEAD_CHARS))) return 'passive';
  return null;
}

/**
 * The EHRA number grows with registration, and the graph has no date, so it is
 * the only ordering by age there is. The query binds it from the company URI.
 *
 * @param {{ canton: string, above?: number|null, below?: number|null, ascending?: boolean, limit: number }} page
 * @returns {string}
 */
export function buildZefixQuery({ canton, above = null, below = null, ascending = false, limit }) {
  const [first, last] = CANTON_BFS_RANGES[canton];
  const forms = EMPLOYER_LEGAL_FORMS.map((form) => `<${LEGAL_FORM_BASE}${form}>`).join(' ');
  const window = [
    above === null ? '' : `FILTER(?ehra > ${Number(above)})`,
    below === null ? '' : `FILTER(?ehra < ${Number(below)})`,
  ].filter(Boolean).join(' ');
  return `PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
PREFIX schema: <http://schema.org/>
PREFIX admin: <https://schema.ld.admin.ch/>
SELECT ?company ?name ?purpose ?zip ?city WHERE { GRAPH <${ZEFIX_GRAPH}> {
  VALUES ?form { ${forms} }
  ?company a admin:ZefixOrganisation ; schema:legalName ?name ; schema:additionalType ?form ;
    admin:municipality ?municipality ; schema:address ?address .
  OPTIONAL { ?company schema:description ?purpose }
  OPTIONAL { ?address schema:postalCode ?zip }
  OPTIONAL { ?address schema:addressLocality ?city }
  BIND(xsd:integer(STRAFTER(STR(?municipality), "municipality/")) AS ?bfs)
  FILTER(?bfs >= ${first} && ?bfs <= ${last})
  BIND(xsd:integer(STRAFTER(STR(?company), "/company/")) AS ?ehra)
  ${window}
} } ORDER BY ${ascending ? 'ASC' : 'DESC'}(?ehra) LIMIT ${Number(limit)}`;
}

/**
 * @typedef {Object} ZefixEntry
 * @property {number} zefixId  EHRA number
 * @property {string} name
 * @property {string} purpose
 * @property {string} city
 * @property {string} zip
 */

/** @param {any} binding @returns {ZefixEntry|null} */
function entryFromBinding(binding) {
  const zefixId = Number(/\/company\/(\d+)$/.exec(String(binding?.company?.value || ''))?.[1]);
  const name = String(binding?.name?.value || '').trim();
  if (!Number.isSafeInteger(zefixId) || !zefixId || !name) return null;
  return {
    zefixId,
    name,
    purpose: String(binding?.purpose?.value || '').trim(),
    city: String(binding?.city?.value || '').trim(),
    zip: String(binding?.zip?.value || '').trim(),
  };
}

/**
 * @param {string} query
 * @param {{ fetchImpl?: typeof fetch, sleepImpl?: (ms: number) => Promise<unknown>, lookupImpl?: any }} opts
 * @returns {Promise<{ entries: ZefixEntry[]|null, outcome: string, errorCode: string|null }>}
 */
async function runQuery(query, opts) {
  let res;
  try {
    res = await politeFetch(LINDAS_ENDPOINT, {
      method: 'POST',
      accept: 'application/sparql-results+json',
      contentType: 'application/x-www-form-urlencoded',
      body: `query=${encodeURIComponent(query)}`,
      ignoreRobots: true,
      timeoutMs: 120000,
      fetchImpl: opts.fetchImpl,
      sleepImpl: opts.sleepImpl,
      lookupImpl: opts.lookupImpl,
    });
  } catch {
    return { entries: null, outcome: 'unavailable', errorCode: 'network_error' };
  }
  if (!res.ok) return { entries: null, outcome: 'unavailable', errorCode: `http_${res.status}` };
  let payload;
  try { payload = JSON.parse(res.body); } catch {
    return { entries: null, outcome: 'malformed', errorCode: 'malformed_json' };
  }
  const bindings = payload?.results?.bindings;
  if (!Array.isArray(bindings)) return { entries: null, outcome: 'malformed', errorCode: 'unexpected_payload' };
  const entries = bindings.map(entryFromBinding).filter(Boolean);
  if (bindings.length && !entries.length) return { entries: null, outcome: 'malformed', errorCode: 'unexpected_rows' };
  return { entries, outcome: 'complete', errorCode: null };
}

/**
 * New candidates per run. TRACE gives a candidate without a domain about 90
 * slots a day, shared with every other weak lead, and a Zefix row is the
 * weakest lead there is: measured on 80 recent Ticino companies, 15 had a site.
 * At this rate the Ticino backlog alone lasts well over a year.
 */
export const ZEFIX_DAILY_BUDGET = 60;

const PAGE_SIZE = 300;
const MAX_QUERIES_PER_RUN = 6;

/**
 * Walk the registry until `budget` entries have been accepted: Ticino first,
 * new registrations first, then the backlog from newest to oldest. A cursor only
 * moves past an entry that was read, so a run cut short by the budget or by an
 * outage resumes on the next entry.
 *
 * @param {{
 *   cantons: string[],
 *   budget: number,
 *   cursors: { cantons: Record<string, { highest: number|null, lowest: number|null, exhausted: boolean, updatedAt?: string }> },
 *   accept: (employer: { zefixId: number, name: string, city: string, zip: string, canton: string }) => boolean,
 *   pageSize?: number,
 *   maxQueries?: number,
 *   fetchImpl?: typeof fetch,
 *   sleepImpl?: (ms: number) => Promise<unknown>,
 *   lookupImpl?: any,
 * }} options
 * @returns {Promise<{ accepted: number, recordsSeen: number, excluded: Record<string, number>, queries: number, outcome: string, errorCode: string|null, cantonsRead: string[] }>}
 */
export async function sweepZefix(options) {
  const { cantons, budget, cursors, accept } = options;
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const maxQueries = options.maxQueries ?? MAX_QUERIES_PER_RUN;
  const order = [...new Set(['TI', ...cantons])].filter((canton) => cantons.includes(canton));
  const result = {
    accepted: 0, recordsSeen: 0, excluded: {}, queries: 0, outcome: 'complete', errorCode: null, cantonsRead: [],
  };
  const consume = (canton, entry) => {
    result.recordsSeen++;
    const exclusion = zefixExclusion(entry);
    if (exclusion) {
      result.excluded[exclusion] = (result.excluded[exclusion] || 0) + 1;
      return;
    }
    const { zefixId, name, city, zip } = entry;
    if (accept({ zefixId, name, city, zip, canton })) result.accepted++;
  };
  /** @returns {Promise<{ entries: ZefixEntry[] }|null>} null when the source failed */
  const read = async (page) => {
    result.queries++;
    const { entries, outcome, errorCode } = await runQuery(buildZefixQuery({ ...page, limit: pageSize }), options);
    if (entries) return { entries };
    result.outcome = result.recordsSeen ? 'partial' : outcome;
    result.errorCode = errorCode;
    return null;
  };

  for (const canton of order) {
    if (result.accepted >= budget || result.queries >= maxQueries) break;
    const cursor = cursors.cantons[canton] ||= { highest: null, lowest: null, exhausted: false };
    result.cantonsRead.push(canton);
    const touch = () => { cursor.updatedAt = new Date().toISOString(); };

    // New registrations, oldest first so an interrupted run leaves no gap.
    if (cursor.highest !== null) {
      const fresh = await read({ canton, above: cursor.highest, ascending: true });
      if (!fresh) return result;
      for (const entry of fresh.entries) {
        if (result.accepted >= budget) break;
        consume(canton, entry);
        cursor.highest = entry.zefixId;
        touch();
      }
    }
    // The backlog, newest first.
    while (!cursor.exhausted && result.accepted < budget && result.queries < maxQueries) {
      const backlog = await read({ canton, below: cursor.lowest });
      if (!backlog) return result;
      for (const entry of backlog.entries) {
        if (result.accepted >= budget) break;
        consume(canton, entry);
        cursor.highest ??= entry.zefixId;
        cursor.lowest = entry.zefixId;
        touch();
      }
      if (backlog.entries.length < pageSize && result.accepted < budget) {
        cursor.exhausted = true;
        touch();
      }
    }
  }
  return result;
}

const EMPTY_CURSORS = { version: 1, updatedAt: null, cantons: {} };

const isCursorId = (value) => value === null || (Number.isSafeInteger(value) && value > 0);

/** @param {string} [file] */
export function loadZefixCursors(file = ZEFIX_CURSORS_PATH) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return structuredClone(EMPTY_CURSORS);
    throw new Error(`Cannot read Zefix cursors at ${file}`, { cause: error });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Malformed Zefix cursors at ${file}`, { cause: error });
  }
  const cantons = parsed?.cantons;
  if (!cantons || typeof cantons !== 'object' || Array.isArray(cantons)
    || !Object.entries(cantons).every(([canton, cursor]) => CANTON_BFS_RANGES[canton]
      && isCursorId(cursor?.highest) && isCursorId(cursor?.lowest) && typeof cursor?.exhausted === 'boolean')) {
    throw new Error(`Invalid Zefix cursor shape at ${file}`);
  }
  return { ...EMPTY_CURSORS, ...parsed };
}

/** @param {{ version: number, updatedAt: string|null, cantons: Record<string, unknown> }} state @param {string} [file] */
export function saveZefixCursors(state, file = ZEFIX_CURSORS_PATH) {
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
