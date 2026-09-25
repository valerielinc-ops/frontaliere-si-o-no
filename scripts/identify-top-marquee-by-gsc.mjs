#!/usr/bin/env node
/**
 * identify-top-marquee-by-gsc.mjs  —  Cathedral Phase 2 / T2.8
 *
 * Pulls top performing search queries from Google Search Console for
 * `https://frontaliereticino.ch/` over the last 90 days, extracts CH-employer
 * NAMES from "{company} jobs" / "lavoro {company}" / "{company} carriere" /
 * etc. patterns (IT/EN/DE/FR), cross-references them against
 * `data/marquee-companies-list.json`, and writes
 * `data/gsc-top-marquee-candidates.json`.
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────
 * `build-plugins/shared/employerProfileConfig.mjs` counts the employer-profile
 * indexability floor in ANNUNCI, not in DOMANDA, and its block comment names
 * this script as the one missing piece: the promotion half needs a
 * company-keyed demand table, `gsc.queries` in data/evidence-index.json has no
 * company key, and neither of the two ways of adding one there survives
 * measurement. This script keys demand by employer NAME instead, which is the
 * shape that works. Scheduled by .github/workflows/refresh-gsc-marquee-demand.yml
 * so the artifact is committed and therefore readable at build time; before
 * that workflow existed, nothing invoked this and the output was never
 * committed, so the floor could not be made demand-aware at all.
 *
 * ── AUTH ────────────────────────────────────────────────────────────────
 * The project's Firebase service account doubles as a Search Console
 * credential (same note scripts/lib/evidence/gscFetcher.mjs carries, and the
 * reason build-evidence-and-tune.yml can pull GSC daily with it). Resolution
 * order, CI-first:
 *
 *   1. GOOGLE_APPLICATION_CREDENTIALS  — the path every workflow's "Prepare
 *      Firebase credentials" step writes; ALSO already exported by
 *      ~/.bash_profile on the maintainer's machine.
 *   2. FIREBASE_SERVICE_ACCOUNT_JSON   — the raw secret, for callers that pass
 *      it without materialising a file.
 *   3. mcp-gsc-main/*.json             — the original local-only path this
 *      script was written against. Kept last and never in the repo: it is a
 *      developer convenience, and looking there FIRST is what made this script
 *      unrunnable in CI (that directory does not exist in the repo, so every
 *      run would have degraded before touching the network).
 *
 * The JWT is signed by scripts/lib/google-service-account-token.mjs, not by a
 * fourth local copy of the same twenty lines — that module exists precisely
 * because credential-signing code had already been duplicated twice
 * (AGENTS.md Non-Negotiable #6).
 *
 * Usage:
 *   node scripts/identify-top-marquee-by-gsc.mjs
 *
 * ── DEGRADATION: LAST-GOOD WINS ─────────────────────────────────────────
 * Idempotent, and exits 0 on every failure so a scheduled run never goes red
 * for a transient GSC hiccup. What it does NOT do any more is write an empty
 * `{ candidates: [], _error }` stub: once this artifact is COMMITTED, that stub
 * is a data-refresh that replaces a good demand table with an empty one, and a
 * floor reading it would silently demote everything. A degraded run therefore
 * writes NOTHING at all — the previous artifact stays exactly as it was, the
 * failure is logged as a `::warning::` annotation, and a consumer reading a
 * missing or stale file falls back to the hand-curated list the same way it
 * would have fallen back to an empty one.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getServiceAccountAccessToken } from './lib/google-service-account-token.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SITE_URL = 'https://frontaliereticino.ch/';
const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const LOOKBACK_DAYS = 90;
const ROW_LIMIT = 25000; // GSC hard cap per request
// Pagination cap. 8 × 25 000 = 200 000 query rows, comfortably above what a
// 90-day window returns for this property (~795 000 impressions over 93 918
// distinct pages), so the cap is a runaway guard and not the real limit.
const MAX_PAGES = 8;
const MARQUEE_LIST_PATH = path.join(ROOT, 'data', 'marquee-companies-list.json');
const OUTPUT_PATH = path.join(ROOT, 'data', 'gsc-top-marquee-candidates.json');

// ── Helpers ─────────────────────────────────────────────────────────────
function log(prefix, msg) {
  console.log(`${prefix} ${msg}`);
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function writeOutput(payload) {
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  log('💾', `Wrote ${path.relative(ROOT, OUTPUT_PATH)}`);
}

/**
 * Abandon the run WITHOUT touching the artifact — see the DEGRADATION note in
 * the header. `::warning::` so a scheduled run that quietly stops producing
 * data is still visible in the Actions log instead of looking like a success.
 */
function failGracefully(errorMsg) {
  log('⚠️', errorMsg);
  const existing = fs.existsSync(OUTPUT_PATH);
  console.log(
    `::warning::identify-top-marquee-by-gsc degraded: ${errorMsg} — ` +
      `${existing ? 'keeping the previously committed artifact' : 'no artifact written'}.`,
  );
  process.exit(0);
}

// ── Service Account discovery ───────────────────────────────────────────

/**
 * Resolve the service-account JSON, CI paths first. Exported for the unit test
 * that pins the ORDER: a regression to "local directory first" is invisible on
 * a developer machine and fatal in CI, which is exactly how this script came to
 * be unschedulable.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ sa: object, source: string }}
 */
export function resolveServiceAccount(env = process.env) {
  const parse = (text, where) => {
    let j;
    try {
      j = JSON.parse(text);
    } catch (e) {
      throw new Error(`Failed to parse service account from ${where}: ${e.message}`);
    }
    if (!j || j.type !== 'service_account' || !j.private_key || !j.client_email) {
      throw new Error(`${where} is not a usable service_account JSON`);
    }
    return j;
  };

  const credPath = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credPath && fs.existsSync(credPath)) {
    return { sa: parse(fs.readFileSync(credPath, 'utf8'), 'GOOGLE_APPLICATION_CREDENTIALS'), source: 'GOOGLE_APPLICATION_CREDENTIALS' };
  }

  const raw = env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw && raw.trim()) {
    return { sa: parse(raw, 'FIREBASE_SERVICE_ACCOUNT_JSON'), source: 'FIREBASE_SERVICE_ACCOUNT_JSON' };
  }

  // Local-only convenience, never present in the repo. Any *.json in there that
  // looks like a service account will do; the file name has never been stable.
  const dir = path.join(ROOT, 'mcp-gsc-main');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      try {
        return { sa: parse(fs.readFileSync(path.join(dir, f), 'utf8'), f), source: `mcp-gsc-main/${f}` };
      } catch {
        // keep scanning — the directory holds unrelated JSON too
      }
    }
  }

  throw new Error(
    'no service-account credentials (GOOGLE_APPLICATION_CREDENTIALS, FIREBASE_SERVICE_ACCOUNT_JSON, or mcp-gsc-main/*.json)',
  );
}

// ── GSC Search Analytics query ──────────────────────────────────────────

async function gscPost(token, property, body) {
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`;
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

/**
 * All query rows for the window, PAGINATED.
 *
 * `rowLimit` alone caps a Search Analytics response at 25 000 rows and says
 * nothing about it — the response has no "there is more" field, so a single
 * request looks complete whatever the real row count is. That is fatal for
 * THIS artifact specifically: GSC orders rows by clicks descending, so the
 * rows a 25 000 cut discards are the low-click tail, and the whole point of
 * the table is to surface BELOW-FLOOR employers, who live in exactly that
 * tail. A one-shot pull would systematically drop the candidates the file
 * exists to find, while looking full.
 *
 * `startRow` walks past the cut; a short page (fewer than ROW_LIMIT rows) is
 * the only reliable end-of-data signal. If MAX_PAGES is hit while pages are
 * still full, the caller records `_truncated: true` so a consumer can reject
 * an incomplete set instead of reading it as "no more demand" — the same
 * discipline as reading `counts` out of the corpus manifest before using it.
 *
 * The two-property probe is unchanged: this project's GSC access is on the
 * `sc-domain:` property, but the URL-prefix property is tried first because
 * that is what the site is canonically configured as; 403/404 falls through.
 */
async function querySearchAnalytics(token, siteUrl, startDate, endDate) {
  const tryUrls = [siteUrl, 'sc-domain:frontaliereticino.ch'];
  let lastErr = null;

  for (const property of tryUrls) {
    const rows = [];
    let truncated = false;
    let pagesFetched = 0;
    let ok = true;

    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await gscPost(token, property, {
        startDate,
        endDate,
        dimensions: ['query'],
        rowLimit: ROW_LIMIT,
        startRow: page * ROW_LIMIT,
        type: 'web',
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        lastErr = `HTTP ${res.status} on ${property} (page ${page}): ${text.slice(0, 200)}`;
        // A mid-pagination failure is NOT a "try the other property" signal:
        // page 0 already proved this one works. Fail the whole pull rather than
        // silently returning a partial set under a different property.
        if (page > 0) throw new Error(`Search Analytics pagination failed: ${lastErr}`);
        ok = false;
        break;
      }
      const data = await res.json();
      const pageRows = data.rows || [];
      rows.push(...pageRows);
      pagesFetched++;
      if (pageRows.length < ROW_LIMIT) break;
      // Last allowed page came back FULL ⇒ GSC still had rows to give.
      if (page === MAX_PAGES - 1) truncated = true;
    }

    if (!ok) {
      // Only 403/404 mean "wrong property"; anything else is a real error.
      if (!/HTTP (403|404) /.test(lastErr)) break;
      continue;
    }

    log('ℹ️', `GSC property ${property} returned ${rows.length} rows over ${pagesFetched} page(s)${truncated ? ' (TRUNCATED)' : ''}`);
    return { rows, property, truncated };
  }

  throw new Error(`Search Analytics query failed: ${lastErr}`);
}

// ── Company-name extraction ─────────────────────────────────────────────
// Recognise queries that mention an employer in IT/EN/DE/FR job-search
// patterns. Capture the company-name token(s) — left- or right-of the
// keyword — and normalise.

const JOB_KEYWORDS = [
  // IT
  'lavoro', 'lavori', 'lavora', 'assunzioni', 'carriere', 'posti', 'offerte',
  'concorso', 'concorsi', 'stage', 'stipendio', 'stipendi', 'frontaliere',
  'frontalieri',
  // EN
  'jobs', 'job', 'careers', 'career', 'hiring', 'vacancies', 'opportunities',
  // DE
  'stellen', 'stelle', 'jobs', 'karriere', 'arbeit', 'arbeitsplatz',
  // FR
  'emploi', 'emplois', 'carrieres', 'recrutement', 'travail',
];

const STOP_TOKENS = new Set([
  // Geo / generic — never a company
  'ticino', 'lugano', 'mendrisio', 'bellinzona', 'locarno', 'chiasso',
  'svizzera', 'switzerland', 'schweiz', 'suisse', 'ch',
  'frontalieri', 'frontaliere', 'frontalier', 'frontaliers',
  'italia', 'italy', 'italien', 'italie',
  'cantone', 'canton', 'kanton',
  // Generic job words
  'lavoro', 'lavori', 'lavora', 'jobs', 'job', 'stelle', 'stellen',
  'carriere', 'careers', 'karriere', 'emploi', 'emplois',
  'offerte', 'offerta', 'assunzioni', 'concorso', 'concorsi',
  'stage', 'tirocinio', 'stipendio', 'stipendi', 'salary', 'salaire',
  'arbeit', 'travail', 'recrutement', 'hiring',
  // Sectors / professions / role nouns (extensive — these dominate query logs)
  'infermiere', 'infermieri', 'infermiera', 'nurse', 'nurses', 'pflege', 'infirmier',
  'autista', 'autisti', 'driver', 'drivers', 'fahrer', 'chauffeur',
  'ingegnere', 'ingegneri', 'engineer', 'engineers', 'ingenieur',
  'sviluppatore', 'developer', 'entwickler', 'developpeur',
  'operatore', 'operatori', 'oss', 'osa', 'osa', 'oss',
  'apprendista', 'apprendistato', 'apprenticeship', 'lehre',
  'cuoco', 'cuoca', 'cook', 'koch', 'cuisinier', 'chef',
  'cameriere', 'camerieri', 'waiter', 'kellner', 'serveur',
  'educatore', 'educatori', 'educatrice', 'teacher', 'lehrer', 'enseignant',
  'commesso', 'commessa', 'commessi', 'sales', 'verkauf', 'vendeur',
  'magazziniere', 'magazzinieri', 'logistician', 'lagerarbeiter',
  'meccanico', 'meccanici', 'mechanic', 'mechaniker', 'mecanicien',
  'elettricista', 'elettricisti', 'electrician', 'elektriker', 'electricien',
  'muratore', 'muratori', 'mason', 'maurer', 'macon',
  'segretaria', 'segretario', 'secretary', 'sekretarin', 'secretaire',
  'impiegato', 'impiegata', 'employee', 'angestellte', 'employe',
  'manager', 'direttore', 'direttrice', 'leiter', 'directeur',
  'medico', 'medici', 'doctor', 'arzt', 'medecin',
  'farmacista', 'pharmacist', 'apotheker', 'pharmacien',
  // Search-intent / generic noise
  'cerco', 'cercare', 'cerca', 'search', 'suche', 'cherche',
  'annunci', 'annuncio', 'ads', 'anzeigen', 'annonces',
  'vacanti', 'vacante', 'vacancy', 'offen', 'vacant',
  'part', 'time', 'full', 'tempo', 'pieno', 'parziale', 'teilzeit', 'vollzeit',
  'simulazione', 'simulation', 'calcolo', 'calcola', 'calculator',
  'tasse', 'tassa', 'tax', 'taxes', 'steuern', 'impots',
  'nuovi', 'nuovo', 'new', 'neu', 'nouveau',
  'urgente', 'urgent', 'subito', 'sofort', 'immediato',
  'sera', 'notte', 'giorno', 'night', 'day', 'tag', 'nacht',
  'remoto', 'remote', 'home', 'casa', 'maison',
  'liberi', 'libero', 'libera', 'libere', 'free', 'frei', 'libre',
  'estivi', 'estivo', 'estiva', 'estive', 'summer', 'sommer', 'ete',
  'invernali', 'invernale', 'winter', 'hiver',
  'amministrativo', 'amministrativa', 'administrative', 'verwaltung',
  'tecnico', 'tecnica', 'tecnici', 'technical', 'technisch', 'technique',
  'pubblico', 'pubblica', 'pubblici', 'public', 'oeffentlich',
  'privato', 'privata', 'private', 'privat',
  'tessin', 'tessine', // FR/DE forms of Ticino
  'agenzia', 'agenzie', 'agency', 'agentur', 'agence',
  'azienda', 'aziende', 'company', 'firma', 'entreprise',
  'settore', 'sector', 'branche', 'secteur',
  'stipendio', 'stipendi', 'salario', 'gehalt', 'lohn', 'salaire',
  'orario', 'orari', 'hours', 'stunden', 'horaires',
  'contratto', 'contratti', 'contract', 'vertrag', 'contrat',
  'colloquio', 'colloqui', 'interview', 'vorstellungsgesprach', 'entretien',
  'vendita', 'vendite', 'sale', 'verkauf', 'vente',
  'elenco', 'lista', 'list', 'liste',
  'comune', 'comuni', 'municipality', 'gemeinde', 'commune',
  'sociale', 'sociali', 'social', 'sozial',
  'pulizie', 'pulizia', 'cleaning', 'reinigung', 'nettoyage',
  'badante', 'badanti', 'caregiver', 'pflegekraft',
  'baby', 'sitter', 'tata',
  'edilizia', 'construction', 'bau', 'batiment',
  'pensione', 'pensioni', 'pension', 'rente', 'retraite',
  // Misc fillers
  'come', 'how', 'wie', 'comment', 'dove', 'where', 'wo', 'ou',
  'cosa', 'what', 'was', 'quoi', 'quanto', 'quanti',
  'in', 'a', 'al', 'alla', 'allo', 'di', 'del', 'della', 'dello',
  'the', 'der', 'die', 'das', 'le', 'la', 'les', 'el',
  'per', 'for', 'fur', 'pour', 'con', 'with', 'mit', 'avec',
  'e', 'and', 'und', 'et', 'o', 'or', 'oder', 'ou',
  // Very common non-company tokens that look capitalised in queries
  '2025', '2026', '2024', 'oggi', 'today',
]);

function normaliseCompanyToken(s) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenLooksLikeCompany(tok) {
  if (!tok) return false;
  if (tok.length < 3) return false;
  if (STOP_TOKENS.has(tok)) return false;
  if (/^\d+$/.test(tok)) return false;
  return true;
}

function extractCompanyFromQuery(rawQuery) {
  // GSC returns lower-cased queries. Normalise punctuation.
  const q = rawQuery
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!q) return null;
  const toks = q.split(' ');
  // Need at least one job keyword
  const kwIdx = toks.findIndex((t) => JOB_KEYWORDS.includes(t));
  if (kwIdx < 0) return null;

  // Strategy: take the run of non-stop, non-keyword tokens immediately
  // adjacent to the job keyword (right side first, then left side).
  // Limit to 3 consecutive tokens to capture multi-word names like
  // "raiffeisen schweiz" or "credit suisse" without going wild.
  const collect = (start, dir) => {
    const out = [];
    let i = start;
    while (i >= 0 && i < toks.length && out.length < 3) {
      const t = toks[i];
      if (JOB_KEYWORDS.includes(t)) break;
      if (!tokenLooksLikeCompany(t)) break;
      out.push(t);
      i += dir;
    }
    return dir === -1 ? out.reverse() : out;
  };

  const rightTokens = collect(kwIdx + 1, 1);
  const leftTokens = collect(kwIdx - 1, -1);

  // Prefer the longer run; if equal, prefer left (more idiomatic
  // "lavoro UBS" vs "UBS jobs", but both are common — left captures the
  // pattern "{kw} {company}" which is more specific).
  let candidate = '';
  if (rightTokens.length >= leftTokens.length && rightTokens.length > 0) {
    candidate = rightTokens.join(' ');
  } else if (leftTokens.length > 0) {
    candidate = leftTokens.join(' ');
  }
  if (!candidate) return null;
  // Single-token candidates: require ≥4 chars (drops "ch", "ag", noise)
  if (!candidate.includes(' ') && candidate.length < 4) return null;
  return candidate;
}

// ── Cross-reference with marquee list ───────────────────────────────────
function loadMarqueeIndex() {
  if (!fs.existsSync(MARQUEE_LIST_PATH)) {
    log('⚠️', `Marquee list not found at ${MARQUEE_LIST_PATH} — proceeding without cross-ref`);
    return { byToken: new Map(), companies: [] };
  }
  const data = JSON.parse(fs.readFileSync(MARQUEE_LIST_PATH, 'utf8'));
  const byToken = new Map(); // normalised name token -> {name, alreadyCrawled}
  for (const c of data.companies || []) {
    const normFull = normaliseCompanyToken(c.name);
    byToken.set(normFull, { name: c.name, alreadyCrawled: !!c.alreadyCrawled });
    // Also index the first token (often the brand: "ubs", "raiffeisen", "abb")
    const firstTok = normFull.split(' ')[0];
    if (firstTok && firstTok.length >= 3 && !byToken.has(firstTok)) {
      byToken.set(firstTok, { name: c.name, alreadyCrawled: !!c.alreadyCrawled });
    }
    // Index the slug as well
    if (c.slug_suggestion) {
      const slugNorm = normaliseCompanyToken(c.slug_suggestion).replace(/-/g, ' ');
      if (slugNorm && !byToken.has(slugNorm)) {
        byToken.set(slugNorm, { name: c.name, alreadyCrawled: !!c.alreadyCrawled });
      }
    }
  }
  return { byToken, companies: data.companies || [] };
}

function lookupMarquee(byToken, candidateNorm) {
  if (byToken.has(candidateNorm)) return byToken.get(candidateNorm);
  // Try first token of candidate
  const firstTok = candidateNorm.split(' ')[0];
  if (firstTok && byToken.has(firstTok)) return byToken.get(firstTok);
  return null;
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  log('🔍', 'identify-top-marquee-by-gsc — Cathedral Phase 2 / T2.8');

  let sa;
  try {
    const resolved = resolveServiceAccount();
    sa = resolved.sa;
    log('ℹ️', `Loaded SA: ${sa.client_email} (via ${resolved.source})`);
  } catch (e) {
    return failGracefully(`SA load failed: ${e.message}`);
  }

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const startStr = isoDate(startDate);
  const endStr = isoDate(endDate);
  log('📅', `Date range: ${startStr} → ${endStr}`);

  let token;
  try {
    token = await getServiceAccountAccessToken(sa, GSC_SCOPE);
    log('✅', 'Acquired GSC access token');
  } catch (e) {
    return failGracefully(`Auth failed: ${e.message}`);
  }

  let rows;
  let truncated;
  try {
    ({ rows, truncated } = await querySearchAnalytics(token, SITE_URL, startStr, endStr));
  } catch (e) {
    return failGracefully(`GSC query failed: ${e.message}`);
  }

  // Zero rows over 90 days on a property that takes ~795 000 impressions in
  // that window is a broken read, not a measurement of "no demand". Treated as
  // a degradation so it can never overwrite a good table with an empty one.
  if (!rows.length) {
    return failGracefully('GSC returned 0 rows for a 90-day window — treating as a failed read, not as zero demand');
  }

  const { byToken } = loadMarqueeIndex();

  // Aggregate candidates by normalised name
  const agg = new Map(); // norm -> { name, clicks, impressions, queries:Set }
  for (const row of rows) {
    const q = (row.keys && row.keys[0]) || '';
    const candidate = extractCompanyFromQuery(q);
    if (!candidate) continue;
    const norm = candidate;
    if (!agg.has(norm)) {
      agg.set(norm, {
        normalised: norm,
        // Display: title-case the normalised tokens
        company_name: norm
          .split(' ')
          .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
          .join(' '),
        estimated_clicks: 0,
        estimated_impressions: 0,
        queries: new Set(),
      });
    }
    const e = agg.get(norm);
    e.estimated_clicks += row.clicks || 0;
    e.estimated_impressions += row.impressions || 0;
    if (e.queries.size < 8) e.queries.add(q);
  }

  // Threshold + quality:
  //  - Marquee match: keep if any clicks OR ≥5 impressions (high signal).
  //  - Unknown candidate: stricter — must have ≥3 clicks OR ≥30 impressions
  //    AND either be multi-token OR a single token of ≥5 chars (filters out
  //    leftover role nouns that slipped through the stop-list).
  const enriched = [...agg.values()]
    .map((c) => {
      const m = lookupMarquee(byToken, c.normalised);
      return {
        _raw: c,
        company_name: m ? m.name : c.company_name,
        estimated_clicks: c.estimated_clicks,
        estimated_impressions: c.estimated_impressions,
        queries: [...c.queries],
        in_marquee_list: !!m,
        alreadyCrawled: m ? m.alreadyCrawled : false,
      };
    })
    .filter((c) => {
      if (c.in_marquee_list) {
        return c.estimated_clicks >= 1 || c.estimated_impressions >= 5;
      }
      if (c.estimated_clicks < 3 && c.estimated_impressions < 30) return false;
      const norm = c._raw.normalised;
      const isMulti = norm.includes(' ');
      const firstTok = norm.split(' ')[0];
      if (!isMulti && firstTok.length < 5) return false;
      return true;
    })
    .map(({ _raw, ...rest }) => rest)
    .sort((a, b) => b.estimated_clicks - a.estimated_clicks || b.estimated_impressions - a.estimated_impressions);

  const payload = {
    _generatedAt: new Date().toISOString(),
    _dataRange: `${startStr} to ${endStr}`,
    _totalGscRows: rows.length,
    // TRUE ⇒ the pull hit MAX_PAGES with pages still full, so the low-click
    // tail — where below-floor employers live — is incomplete. A consumer that
    // promotes on this table must refuse a truncated set rather than read the
    // missing tail as absent demand. See querySearchAnalytics.
    _truncated: truncated,
    _candidatesFound: enriched.length,
    _newCandidates: enriched.filter((c) => !c.in_marquee_list || !c.alreadyCrawled).length,
    candidates: enriched,
  };
  writeOutput(payload);

  // ── Summary report ──
  log('', '');
  log('📊', `Top 10 GSC marquee candidates (last ${LOOKBACK_DAYS}d)`);
  log('', `${'Company'.padEnd(36)} ${'Clicks'.padStart(7)} ${'Impr.'.padStart(8)}  Status`);
  log('', '─'.repeat(80));
  for (const c of enriched.slice(0, 10)) {
    const status = c.in_marquee_list
      ? c.alreadyCrawled
        ? 'in list (crawled)'
        : 'in list (NOT crawled)'
      : 'NEW (not in list)';
    log(
      '',
      `${c.company_name.slice(0, 36).padEnd(36)} ${String(c.estimated_clicks).padStart(7)} ${String(c.estimated_impressions).padStart(8)}  ${status}`,
    );
  }
  log('', '─'.repeat(80));
  log('✅', `${enriched.length} candidates total · ${payload._newCandidates} actionable (new or not yet crawled)`);
}

// Same guard as scripts/check-pages-publish-lag.mjs: the module now exports
// `resolveServiceAccount` for its unit test, and a bare `main()` call would run
// the whole GSC pull (and its process.exit) the moment vitest imported it.
const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (invokedDirectly) {
  main().catch((err) => {
    failGracefully(`Unexpected error: ${err.message || err}`);
  });
}
