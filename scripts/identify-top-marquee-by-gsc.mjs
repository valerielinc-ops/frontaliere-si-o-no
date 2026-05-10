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
 * Auth: Firebase Service Account at `mcp-gsc-main/service_account_credentials.json`.
 * Memory note `reference_firebase_sa_doubles_as_gsc.md` confirms the same SA
 * has Search Console permissions, so we sign a JWT manually (no new deps).
 *
 * Usage:
 *   node scripts/identify-top-marquee-by-gsc.mjs
 *
 * Idempotent. Graceful degradation: if SA missing or GSC API fails, writes
 * empty output with `_error` field and exits 0 (orchestrator can fall back
 * to the hand-curated list).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SITE_URL = 'https://frontaliereticino.ch/';
const LOOKBACK_DAYS = 90;
const ROW_LIMIT = 25000; // GSC max per request
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

function failGracefully(errorMsg) {
  log('⚠️', errorMsg);
  writeOutput({
    _generatedAt: new Date().toISOString(),
    _error: errorMsg,
    _dataRange: null,
    candidates: [],
  });
  process.exit(0);
}

// ── Service Account discovery ───────────────────────────────────────────
function loadServiceAccount() {
  const expected = path.join(ROOT, 'mcp-gsc-main', 'service_account_credentials.json');
  if (fs.existsSync(expected)) {
    try {
      return JSON.parse(fs.readFileSync(expected, 'utf8'));
    } catch (e) {
      throw new Error(`Failed to parse SA at ${expected}: ${e.message}`);
    }
  }
  // Fallback: any *.json in mcp-gsc-main/ that looks like a SA
  const dir = path.join(ROOT, 'mcp-gsc-main');
  if (!fs.existsSync(dir)) {
    throw new Error(`mcp-gsc-main/ directory not found at ${dir}`);
  }
  const candidates = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  for (const f of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (j && j.type === 'service_account' && j.private_key && j.client_email) {
        log('ℹ️', `Using SA fallback: ${f}`);
        return j;
      }
    } catch {
      // ignore
    }
  }
  throw new Error('No usable service_account JSON found in mcp-gsc-main/');
}

// ── JWT → access token (no extra deps) ──────────────────────────────────
function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

async function getAccessTokenFromSA(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: sa.private_key_id };
  const claims = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const sig = signer.sign(sa.private_key);
  const jwt = `${unsigned}.${base64url(sig)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Token exchange failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('Token exchange returned no access_token');
  return data.access_token;
}

// ── GSC Search Analytics query ──────────────────────────────────────────
async function querySearchAnalytics(token, siteUrl, startDate, endDate) {
  // Try canonical site first; if 403, fall back to sc-domain: form. We use
  // the property exactly as configured in GSC; canonical is the URL property.
  const tryUrls = [siteUrl, 'sc-domain:frontaliereticino.ch'];
  let lastErr = null;
  for (const candidate of tryUrls) {
    const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(candidate)}/searchAnalytics/query`;
    const body = {
      startDate,
      endDate,
      dimensions: ['query'],
      rowLimit: ROW_LIMIT,
      type: 'web',
    };
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      log('ℹ️', `GSC property ${candidate} returned ${data.rows?.length || 0} rows`);
      return data.rows || [];
    }
    const text = await res.text().catch(() => '');
    lastErr = `HTTP ${res.status} on ${candidate}: ${text.slice(0, 200)}`;
    if (res.status !== 403 && res.status !== 404) break;
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
    sa = loadServiceAccount();
    log('ℹ️', `Loaded SA: ${sa.client_email}`);
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
    token = await getAccessTokenFromSA(sa);
    log('✅', 'Acquired GSC access token');
  } catch (e) {
    return failGracefully(`Auth failed: ${e.message}`);
  }

  let rows;
  try {
    rows = await querySearchAnalytics(token, SITE_URL, startStr, endStr);
  } catch (e) {
    return failGracefully(`GSC query failed: ${e.message}`);
  }

  if (!rows.length) {
    log('⚠️', 'GSC returned 0 rows');
    writeOutput({
      _generatedAt: new Date().toISOString(),
      _dataRange: `${startStr} to ${endStr}`,
      _note: 'GSC returned no rows for the requested window.',
      candidates: [],
    });
    return;
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

main().catch((err) => {
  failGracefully(`Unexpected error: ${err.message || err}`);
});
