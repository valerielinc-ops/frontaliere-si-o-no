#!/usr/bin/env node
/**
 * Dedicated LIS (Lugano Istituti Sociali) crawler runner.
 * Runs only LIS jobs (Arca24 ATS at lavoraconnoi.lugano-lis.ch)
 * and enforces full locale coverage for SEO-critical fields.
 *
 * The LIS careers portal uses the Arca24 recruitment platform.
 * The Arca24 platform requires a recognised bot User-Agent header
 * to serve full HTML content without session cookies (it checks for
 * known bot names such as "Slackbot", "Applebot", "YandexBot", etc.).
 * We set JOBS_CRAWLER_USER_AGENT to include "Slackbot" so the base
 * crawler receives proper HTML from the Arca24 host.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { printPublishedJobUrls, writeJobsSummary, snapshotJobSlugs, computeCrawlDiff, printCrawlChangeSummary, writeCrawlChangeSummaryToGH, setCrawlerStartTime, getCrawlerElapsedMs } from './jobs-url-helper.mjs';
import {
  writeJobsCrawlerSlice,
  writeSummaryCrawlerSlice,
  registerCrawlerSummaryGuard,
  assembleJobsDataset,
  readExistingCrawlerJobs,
} from './assemble-jobs-dataset.mjs';
import {
  runDedicatedBaseCrawler,
  validateDedicatedLocaleCoverage,
  mergeLocaleTextMap,
  isSlugStable,
} from './lib/dedicated-crawler-common.mjs';
import { callLLM, flushScores, isAnyModelAvailable } from './lib/ai-models.mjs';
import {
  fetchLisJobUrls,
  fetchLisDetailPage,
  buildLisJob,
} from './lib/lis-lugano-istituti-sociali-job-parser.mjs';
import { getCompanyDefaults } from './lib/crawler-location-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_JOBS = path.resolve(ROOT, 'data', 'jobs.json');
const PUBLIC_DATA_JOBS = path.resolve(ROOT, 'public', 'data', 'jobs.json');
const ADAPTERS_DIR = path.resolve(ROOT, 'data', 'jobs-crawler-adapters', 'adapters');
const LIS_KEY = 'lis-lugano-istituti-sociali';
const LOCALES = ['it', 'en', 'de', 'fr'];
const LIS_SALARY_STRATEGY_VERSION = 'lis_salary_v2';
const LIS_SALARY_LLM_FALLBACK_ENABLED = String(process.env.JOBS_LIS_SALARY_LLM_FALLBACK || '1') !== '0';
const LIS_SALARY_LLM_MAX_JOBS = Math.max(0, Number.parseInt(process.env.JOBS_LIS_SALARY_LLM_MAX_JOBS || '8', 10) || 0);
const LIS_SALARY_LLM_TIMEOUT_MS = Math.max(5000, Number.parseInt(process.env.JOBS_LIS_SALARY_LLM_TIMEOUT_MS || '22000', 10) || 22000);

/**
 * Arca24 listing URL for LIS jobs.
 * The ?custom2=Yes flag filters for published positions.
 * Pagination follows ?page=N pattern (currently 2 pages).
 */
const LIS_LISTING_URLS = [
  'https://lavoraconnoi.lugano-lis.ch/jobs.php?custom2=Yes&source=direct',
  'https://lavoraconnoi.lugano-lis.ch/jobs.php?custom2=Yes&source=direct&page=2',
];

/**
 * User-Agent that Arca24 recognises as a bot and serves full HTML to.
 * We identify ourselves transparently while including "Slackbot" so
 * the Arca24 bot-detection whitelist lets us through without cookies.
 */
const LIS_USER_AGENT =
  'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/; Slackbot compatible)';

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function normalize(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function detectLang(text = '') {
  const t = ` ${normalize(text)} `;
  // Keep LIS source language detection conservative: generic articles such as
  // "das/la/il" create false positives on mixed-content ATS pages.
  if (/( luogo di lavoro | data di scadenza | concorso pubblico | candidatura | candidati | svizzera | ticino )/.test(t)) return 'it';
  if (/( work location | expiry date | job description | requirements | apply now )/.test(t)) return 'en';
  if (/( arbeitsort | stellenbeschreibung | anforderungen | bewerben )/.test(t)) return 'de';
  if (/( lieu de travail | date d expiration | description du poste | exigences | postuler | envoyer )/.test(t)) return 'fr';
  return 'it';
}

/**
 * Match a job object as belonging to the LIS crawl.
 */
function isLisJob(job) {
  const key = normalizeKey(job?.companyKey || job?.company || '');
  const company = normalize(job?.company || '');
  const url = String(job?.url || '').toLowerCase();
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  return (
    key === LIS_KEY ||
    key.includes('lugano-istituti-sociali') ||
    key.includes('lis-lugano') ||
    host.includes('lugano-lis.ch') ||
    host.includes('arca24.careers') ||
    (company.includes('lis') && company.includes('istituti sociali')) ||
    company.includes('lugano istituti sociali')
  );
}

/**
 * Check whether a URL belongs to one of LIS's trusted domains.
 */
function isTrustedLisDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host.endsWith('lugano-lis.ch') || host.includes('arca24.careers');
  } catch {
    return false;
  }
}

function deriveLocalizedSlug(job, locale) {
  const explicit = String(job?.slugByLocale?.[locale] || '').trim();
  if (explicit) return explicit;
  return String(job?.slug || '').trim();
}

function extractLisJobId(rawUrl = '') {
  try {
    const idParam = String(new URL(rawUrl).searchParams.get('id') || '').trim();
    const match = idParam.match(/^(\d+)/);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

function normalizeLisUrlForDedup(rawUrl = '') {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    url.hash = '';
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const path = url.pathname.replace(/\/+$/, '').toLowerCase();
    const params = url.searchParams;
    const id = String(params.get('id') || '').trim().toLowerCase();
    if (id) return `${host}${path}?id=${id}`;

    const stable = new URLSearchParams();
    for (const [k, v] of params.entries()) {
      const key = String(k || '').toLowerCase();
      if (key === 'language' || key === 'lang') continue;
      if (key === 'source' || key === 'custom2' || key === 'page') continue;
      if (key.startsWith('utm_')) continue;
      if (key === 'gclid' || key === 'fbclid') continue;
      if (!String(v || '').trim()) continue;
      stable.set(key, String(v).trim().toLowerCase());
    }
    const query = [...stable.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    return query ? `${host}${path}?${query}` : `${host}${path}`;
  } catch {
    return normalizeKey(trimmed);
  }
}

function getLisUrlLanguage(rawUrl = '') {
  try {
    return String(new URL(rawUrl).searchParams.get('language') || '').trim().toLowerCase();
  } catch {
    return '';
  }
}

function lisJobQualityScore(job) {
  const desc = String(job?.description || '').trim();
  const title = String(job?.title || '').trim();
  const byLocale = job?.descriptionByLocale || {};
  const localeCoverage = LOCALES.reduce((acc, locale) => {
    const txt = String(byLocale?.[locale] || '').trim();
    return acc + (txt.length >= 120 ? 1 : 0);
  }, 0);
  const lang = getLisUrlLanguage(job?.url || '');
  const hasActionSuffix = /(envoyer|invia|send)$/i.test(title);
  let score = 0;
  score += Math.min(5000, desc.length);
  score += localeCoverage * 800;
  if (lang === 'it') score += 5000;
  if (lang === 'en') score += 150;
  if (!hasActionSuffix) score += 300;
  return score;
}

// ──────────────────────────────────────────────────────────────
// Arca24 description & data cleaning
// ──────────────────────────────────────────────────────────────

const LIS_COMPANY_NAME = 'LIS – Lugano Istituti Sociali';

/**
 * Clean an Arca24-scraped description by stripping UI chrome.
 *
 * Typical dirty layout (one long text blob):
 *   ## LIS – Lugano Istituti Sociali {Title} Invia Sei iscritto/a a questo
 *   annuncio ## Svizzera, Ticino, Pregassona Via …, Settore/…, Ruolo/…
 *   Luogo di lavoro: … Settore: … Ruolo: … Data ultimo aggiornamento: …
 *   Data di scadenza: … attività Stampa Dillo a un amico Segnalazione
 *   ## Descrizione annuncio Verifica la tua compatibilità con questo
 *   annuncio ? % Candidati  <<<--- real content starts here
 *   Il Consiglio di Amministrazione ...
 *   ## Vedi dettagli …                <<<--- real content ends here
 *   ## Mappa Candidati … (JS) … ## Annunci correlati … login form …
 */
function cleanLisDescription(dirty) {
  if (!dirty || typeof dirty !== 'string') return '';

  let desc = dirty;

  // ── 0. Strip old metadata headers from previous clean runs (for re-cleaning) ──
  desc = desc.replace(/^(?:📍[^\n]*\n*|🏢[^\n]*\n*|👤[^\n]*\n*|📅[^\n]*\n*)+/, '');
  desc = desc.trim();
  if (!desc) return '';

  // ── 1. Cut footer: everything from "## Vedi dettagli" / "## View details" / "## Voir les détails" / "## Details anzeigen" onward ──
  desc = desc.replace(/##\s*(Vedi dettagli|View details|See details|Voir l[ea]s d[ée]tails|Details anzeigen)[\s\S]*$/i, '');

  // ── 1b. Cut "similar jobs" section in all languages ──
  desc = desc.replace(/##\s*(Annunci correlati|Similar jobs|Offres d'emploi similaires|Ähnliche Stellenangebote)[\s\S]*$/i, '');

  // ── 1c. Cut sharing/login/apply modals ──
  desc = desc.replace(/##\s*(Partager l'offre|Condividi l'offerta|Share the offer|Angebot teilen)[\s\S]*$/i, '');
  desc = desc.replace(/##\s*(Connexion [àa]|Login a|Log ?in to|Anmeldung bei)\s+LIS[\s\S]*$/i, '');

  // ── 1d. Strip JSON-LD schema.org blocks ──
  desc = desc.replace(/\{\s*"@context"\s*:\s*"https?:\/\/schema\.org"[\s\S]*?\}\s*/g, '');

  // ── 1e. Strip embedded JavaScript (Indeed Apply, Careerjet, etc.) ──
  desc = desc.replace(/\(function\s*\(d,\s*s,\s*id\)\s*\{[\s\S]*?\}\s*\(\s*document[\s\S]*?\)\s*\)\s*;?\s*/g, '');
  desc = desc.replace(/var\s+careerjet_apply_data\s*=\s*\{[\s\S]*?\}\s*;?\s*/g, '');

  // ── 1f. Strip "## Carte" / "## Map" / "## Mappa" section (map widget) ──
  desc = desc.replace(/##\s*(Carte|Map|Mappa|Karte)\s+/gi, '');

  // ── 2. Cut header: everything up to and including "? % Candidati" / "? % Apply" / "? % Postuler" / "? % Bewerben" ──
  const candidatiCut = desc.replace(/^[\s\S]*?\?\s*%\s*(Candidati|Apply|Postuler|Bewerben)\s*/i, '');
  if (candidatiCut.length < desc.length * 0.9) {
    desc = candidatiCut;
  } else {
    // Fallback: try cutting at "## Descrizione annuncio" / "## Descrizione" / "## Job description" / "## Description de l'emploi" / "## Stellenbeschreibung"
    const descAnCut = desc.replace(/^[\s\S]*?##\s*(Descrizione(?:\s+annuncio)?|Job description|Description de l'emploi|Stellenbeschreibung)\s*/i, '');
    if (descAnCut.length < desc.length * 0.9) {
      desc = descAnCut;
      // Remove compatibility check prefix in all languages
      desc = desc.replace(/^(Verifica la tua compatibilit[àa] con questo annuncio|Verify your compatibility with this job ad|Vérifiez votre compatibilit[ée] avec cette offre d'emploi|Überprüfen Sie Ihre Kompatibilität mit diesem Stellenangebot)[^.]*\s*/i, '');
    }
  }

  // ── 3. Strip residual Arca24 UI noise (IT + EN + FR + DE) ──
  // IT
  desc = desc.replace(/(Sei iscritto\/a a questo annuncio)\s*/gi, '');
  desc = desc.replace(/(Stampa\s+Dillo a un amico\s+Segnalazione)\s*/gi, '');
  desc = desc.replace(/(Verifica la tua compatibilit[àa] con questo annuncio)[^.]*\s*/gi, '');
  desc = desc.replace(/attivit[àa]\s+Stampa\b/gi, '');
  desc = desc.replace(/(oppure\s+Condividi questo annuncio di lavoro)\s*/gi, '');
  // EN
  desc = desc.replace(/(You applied to this job)\s*/gi, '');
  desc = desc.replace(/(Print\s+Tell a friend\s+Report)\s*/gi, '');
  desc = desc.replace(/(Verify your compatibility with this job ad)[^.]*\s*/gi, '');
  desc = desc.replace(/activities\s+Print\b/gi, '');
  desc = desc.replace(/(or\s+Share this job)\s*/gi, '');
  // FR
  desc = desc.replace(/(Vous avez postul[ée] [àa] cette offre)\s*/gi, '');
  desc = desc.replace(/(Imprimez\s+Dites-le [àa] un ami\s+Signaler)\s*/gi, '');
  desc = desc.replace(/(Vérifiez votre compatibilit[ée] avec cette offre d'emploi)[^.]*\s*/gi, '');
  desc = desc.replace(/activit[ée]s\s+Imprimez\b/gi, '');
  desc = desc.replace(/(ou\s+Partager cette offre d'emploi sur)\s*/gi, '');
  desc = desc.replace(/(Partager cette offre d'emploi sur)\s*/gi, '');
  desc = desc.replace(/(Envoyer)\s*$/gim, '');
  // DE
  desc = desc.replace(/(Sie haben sich auf dieses Stellenangebot beworben)\s*/gi, '');
  desc = desc.replace(/(Drucken\s+Einem Freund mitteilen\s+Melden)\s*/gi, '');
  desc = desc.replace(/(Überprüfen Sie Ihre Kompatibilität mit diesem Stellenangebot)[^.]*\s*/gi, '');
  desc = desc.replace(/Aktivit[äa]ten\s+Drucken\b/gi, '');
  desc = desc.replace(/(oder\s+Dieses Stellenangebot teilen)\s*/gi, '');
  // All languages
  desc = desc.replace(/\?\s*%\s*(Candidati|Apply|Postuler|Bewerben)\s*/gi, '');
  desc = desc.replace(/Powered by\s*/gi, '');
  desc = desc.replace(/Ou\s*$/gim, '');  // French "Or" (login alternative)

  // ── 3b. Strip inline Arca24 metadata block ──
  // Arca24 outputs metadata as a continuous blob on one line (no newlines):
  //   "📍 Luogo: ... 🏢 Settore: ... Ruolo: ... 📅 Scadenza: DD/MM/YYYY {content}"
  // OR without emojis:
  //   "Luogo di lavoro: ... Settore: ... Ruolo: ... Data di scadenza: DD/MM/YYYY {content}"
  // Strip from location label through the expiry date value.
  desc = desc.replace(
    /(?:📍\s*)?(?:Luogo di lavoro|Work location|Lieu de travail|Arbeitsort)\s*:.*?(?:(?:Scadenza|Data di scadenza|Expiry date|Date d'[ée]ch[ée]ance|Ablaufdatum)\s*:\s*\d{2}\/\d{2}\/\d{4})\s*/gi,
    ''
  );
  // Strip remaining standalone metadata lines (with newlines)
  desc = desc.replace(/^##\s*Descrizione\s+/gim, '');
  desc = desc.replace(/^(Settore|Secteur|Sektor|Sector)\s*:.*$/gim, '');
  desc = desc.replace(/^(Poste|Position|Post|Ruolo)\s*:\s*(Sant[ée]|Salute|Health|Gesundheit|Medicina)[^\n]*$/gim, '');
  desc = desc.replace(/^(Date de la derni[èe]re mise [àa] jour|Datum der letzten Aktualisierung|Data ultimo aggiornamento|Date of last update)\s*:.*$/gim, '');
  desc = desc.replace(/^(Date d'[ée]ch[ée]ance|Ablaufdatum|Data di scadenza|Expiry date)\s*:.*$/gim, '');
  desc = desc.replace(/^(Gérera d'autres personnes|Gestirà altre persone|Will manage others?|Wird andere verwalten)\s*:.*$/gim, '');
  desc = desc.replace(/^(Type de contrat|Tipo di contratto|Contract type|Vertragstyp)\s*:.*$/gim, '');
  desc = desc.replace(/^(Niveau de carri[èe]re|Livello di carriera|Career level|Karrierestufe)\s*:.*$/gim, '');
  desc = desc.replace(/^(Settore di lavoro|Secteur d'emploi|Work sector|Arbeitssektor)\s*:.*$/gim, '');
  desc = desc.replace(/^(Personale di ruolo|Personnel permanent|Permanent staff|Festangestellte)\s*:.*$/gim, '');

  // ── 3c. Strip FR/DE location/sector header blocks (## Suisse, Tessin, ...) ──
  desc = desc.replace(/^##\s*(Suisse|Schweiz|Switzerland|Svizzera)\s*,\s*(Tessin|Ticino)[^\n]*/gm, '');

  // ── 4. Strip leftover markdown headers with company name ──
  desc = desc.replace(/^#+\s+LIS\s*[–-]\s*Lugano\s+Istituti\s+Sociali[^\n]*/gm, '');

  // ── 5. Decode HTML entities ──
  desc = desc.replace(/&(sol|comma|ndash|NewLine|colo|times|deg|amp|lt|gt|quot|apos);/gi, (m, ent) => {
    const map = {
      sol: '/', comma: ',', ndash: '–', NewLine: '\n', colo: ':',
      times: '×', deg: '°', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    };
    return map[ent.toLowerCase()] || m;
  });

  // ── 6. Extract metadata from the ORIGINAL dirty text (IT / EN / FR / DE) ──
  const meta = [];
  const locM = dirty.match(/(Luogo di lavoro|Work location|Lieu de travail|Arbeitsort):\s*([^#]+?)(?=(?:Settore|Sector|Secteur|Sektor|Ruolo|Role|Poste|Position|Data\s|Date\s|Expiry|Ablauf|Scadenza|📅|🏢|👤))/i);
  if (locM) meta.push(`📍 Luogo di lavoro: ${locM[2].replace(/\s+/g, ' ').trim()}`);
  const setM = dirty.match(/(Settore|Sector|Secteur|Sektor):\s*([^#]+?)(?=(?:Ruolo|Role|Poste|Position|Data\s|Date\s|Expiry|Ablauf|Scadenza|Luogo|Work loc|Lieu|Arbeitsort|📅|👤))/i);
  if (setM) meta.push(`🏢 Settore: ${setM[2].replace(/\s+/g, ' ').trim()}`);
  const ruoM = dirty.match(/(Ruolo|Role|Poste|Position):\s*([^#]+?)(?=(?:Data\s|Date\s|Expiry|Ablauf|Scadenza|Luogo|Work loc|Lieu|Arbeitsort|Settore|Sector|Secteur|Sektor|📍|📅|🏢))/i);
  if (ruoM) meta.push(`👤 Ruolo: ${ruoM[2].replace(/\s+/g, ' ').trim()}`);
  const scadM = dirty.match(/(Data di scadenza|Expiry date|Date d'[ée]ch[ée]ance|Ablaufdatum|Scadenza):\s*(\d[\d/]+)/i);
  if (scadM) meta.push(`📅 Scadenza: ${scadM[2].trim()}`);

  // ── 7. Combine metadata header + cleaned body ──
  const parts = [];
  if (meta.length > 0) parts.push(meta.join('\n'));

  const body = desc.replace(/\n{3,}/g, '\n\n').trim();
  if (body.length >= 30) parts.push(body);

  return parts.join('\n\n') || dirty; // fallback to original if cleaning removed everything
}

/**
 * Extract a clean location string from the dirty Arca24 description.
 * Pattern: "Luogo di lavoro: Svizzera , Ticino , Pregassona Via alla Bozzoreda 15"
 */
function extractLocation(desc, jobUrl) {
  // Try description first (IT / EN / FR / DE)
  // IT: "Luogo di lavoro: Svizzera , Ticino , Pregassona Via alla Bozzoreda 15"
  // EN: "Work location: Switzerland , Ticino , Pregassona Via alla Bozzoreda 15"
  // FR: "Lieu de travail: Suisse , Tessin , Pregassona Via alla Bozzoreda 15"
  // DE: "Arbeitsort: Schweiz , Tessin , Pregassona Via alla Bozzoreda 15"
  const locMatch = (desc || '').match(
    /(Luogo di lavoro|Work location|Lieu de travail|Arbeitsort):\s*(Svizzera|Switzerland|Suisse|Schweiz)\s*,\s*(Ticino|Tessin)\s*,\s*([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+)*?)(?=\s+Via\b|\s+\d|\s*,|\s*$)/i
  );
  if (locMatch) return locMatch[4].trim();

  // Try the ## header: "## Svizzera, Ticino, Pregassona Via …" / "## Suisse, Tessin, ..."
  const headerMatch = (desc || '').match(
    /##\s*(Svizzera|Switzerland|Suisse|Schweiz)\s*,\s*(Ticino|Tessin)\s*,\s*([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+)*?)(?=\s+Via\b|\s+\d|\s*,|\s*$)/i
  );
  if (headerMatch) return headerMatch[3].trim();

  // Fallback: last slug segment of the URL id param
  try {
    const idParam = new URL(jobUrl).searchParams.get('id') || '';
    const parts = idParam.split('-');
    if (parts.length >= 2) {
      const city = parts[parts.length - 1];
      return city.charAt(0).toUpperCase() + city.slice(1);
    }
  } catch { /* ignore */ }

  return 'Pregassona'; // most LIS facilities are in Pregassona
}

/**
 * Extract a clean job title from the dirty Arca24 title.
 * Dirty pattern: "LIS – Lugano Istituti Sociali {Title} Invia" / "... Send"
 */
function extractCleanTitle(dirtyTitle) {
  let t = String(dirtyTitle || '').trim();
  // Strip company prefix
  t = t.replace(/^LIS\s*[–-]\s*Lugano\s+Istituti\s+Sociali\s*/i, '');
  // Strip trailing button text
  t = t.replace(/\s+(Invia|Send|Envoyer)\s*$/i, '');
  t = t.trim();
  return t.length >= 3 ? t : dirtyTitle;
}

function parseLisSalaryNumber(raw) {
  const cleaned = String(raw || '')
    .replace(/['\u2019\s]/g, '')
    .replace(/,/g, '.')
    .replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
}

function extractLisSalaryFromDescription(text) {
  const source = String(text || '');
  if (!source) return null;

  const mins = [];
  const maxes = [];

  const classRangeRe = /min\.?\s*CHF\s*([0-9][0-9'\u2019.,\s]{2,20})\s*\/\s*max\.?\s*CHF\s*([0-9][0-9'\u2019.,\s]{2,20})/gi;
  let m;
  while ((m = classRangeRe.exec(source)) !== null) {
    const min = parseLisSalaryNumber(m[1]);
    const max = parseLisSalaryNumber(m[2]);
    if (!min || !max) continue;
    if (min < 20000 || min > 500000 || max < 20000 || max > 500000) continue;
    mins.push(min);
    maxes.push(max);
  }

  if (mins.length > 0 && maxes.length > 0) {
    let minValue = Math.min(...mins);
    let maxValue = Math.max(...maxes);
    if (minValue > maxValue) {
      const tmp = minValue;
      minValue = maxValue;
      maxValue = tmp;
    }
    return { min: minValue, max: maxValue, currency: 'CHF' };
  }

  const explicitRangeRe = /CHF\s*([0-9][0-9'\u2019.,\s]{2,20})\s*(?:-|–|a|to)\s*CHF?\s*([0-9][0-9'\u2019.,\s]{2,20})/gi;
  while ((m = explicitRangeRe.exec(source)) !== null) {
    const min = parseLisSalaryNumber(m[1]);
    const max = parseLisSalaryNumber(m[2]);
    if (!min || !max) continue;
    if (min < 20000 || min > 500000 || max < 20000 || max > 500000) continue;
    return min <= max
      ? { min, max, currency: 'CHF' }
      : { min: max, max: min, currency: 'CHF' };
  }

  const annualSingleRe = /(stipendio|salario|retribuzione|salary)[^.\n]{0,80}(annuo|annuale|annual|yearly)?[^0-9\n]{0,20}CHF\s*([0-9][0-9'\u2019.,\s]{2,20})/gi;
  while ((m = annualSingleRe.exec(source)) !== null) {
    const value = parseLisSalaryNumber(m[3]);
    if (!value || value < 20000 || value > 500000) continue;
    return { min: value, max: value, currency: 'CHF' };
  }

  return null;
}

function applyLisStructuredSalary(job, salary) {
  if (!job || !salary) return;
  const minValue = Number(salary.min);
  const maxValue = Number(salary.max);
  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue) || minValue <= 0 || maxValue <= 0) return;
  job.salaryMin = Math.round(Math.min(minValue, maxValue));
  job.salaryMax = Math.round(Math.max(minValue, maxValue));
  job.currency = 'CHF';
  job.baseSalary = {
    '@type': 'MonetaryAmount',
    currency: 'CHF',
    value: {
      '@type': 'QuantitativeValue',
      minValue: job.salaryMin,
      maxValue: job.salaryMax,
      unitText: 'YEAR',
    },
  };
}

function normalizeLisSalaryText(raw) {
  return String(raw || '')
    .replace(/&(sol|comma|ndash|NewLine|colo|times);/gi, (m, ent) => {
      const map = { sol: '/', comma: ',', ndash: '–', newline: '\n', colo: ':', times: '×' };
      return map[String(ent || '').toLowerCase()] || m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function hashLisSalaryText(raw) {
  const normalized = normalizeLisSalaryText(raw);
  if (!normalized) return '';
  return createHash('sha1').update(normalized).digest('hex').slice(0, 20);
}

function hasValidStructuredSalary(job) {
  const min = Number(job?.salaryMin);
  const max = Number(job?.salaryMax);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return false;
  if (min <= 0 || max <= 0) return false;
  if (min > max) return false;
  return true;
}

function setLisSalaryExtractionMeta(job, payload = {}) {
  job.salaryExtraction = {
    strategyVersion: LIS_SALARY_STRATEGY_VERSION,
    textHash: String(payload.textHash || ''),
    source: String(payload.source || 'unknown'),
    confidence: Number.isFinite(Number(payload.confidence)) ? Number(payload.confidence) : undefined,
    note: String(payload.note || '').trim() || undefined,
    extractedAt: new Date().toISOString(),
  };
}

function isLisSalaryExtractionCurrent(job, salaryTextHash) {
  const meta = job?.salaryExtraction;
  if (!meta || typeof meta !== 'object') return false;
  if (String(meta.strategyVersion || '') !== LIS_SALARY_STRATEGY_VERSION) return false;
  if (String(meta.textHash || '') !== String(salaryTextHash || '')) return false;
  const source = String(meta.source || '');
  if (source === 'lis_no_numeric_salary') return true;
  return hasValidStructuredSalary(job);
}

function shouldUseLisSalaryLlmFallback(text) {
  const source = String(text || '');
  if (source.length < 120) return false;
  const hasSalaryCue = /(stipendio|salario|retribuzione|salary|fascia|classe|classi|compenso)/i.test(source);
  const hasCurrencyCue = /(?:\bCHF\b|Fr\.?|franchi)/i.test(source);
  const hasNumericCue = /\d{2,}/.test(source);
  return hasSalaryCue && hasCurrencyCue && hasNumericCue;
}

function safeParseJsonObject(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    try {
      const parsed = JSON.parse(fenced[1]);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  return null;
}

async function extractLisSalaryWithLlm(text) {
  const source = normalizeLisSalaryText(text);
  if (!source || source.length < 120) return null;

  const prompt = [
    'Extract annual gross salary information from this LIS job description.',
    'Return STRICT JSON only with this schema:',
    '{"minAnnualChf":number|null,"maxAnnualChf":number|null,"confidence":number,"evidence":"string"}',
    'Rules:',
    '- Use ONLY explicit salary numbers found in the text.',
    '- Currency must be CHF only.',
    '- If multiple classes/ranges are present, return the lowest explicit minimum and highest explicit maximum.',
    '- If salary is not explicitly numeric, return null for minAnnualChf/maxAnnualChf.',
    '- confidence in [0,1].',
    '',
    source.slice(0, 14000),
  ].join('\n');

  try {
    const raw = await callLLM(
      [{ role: 'user', content: prompt }],
      {
        temperature: 0,
        maxTokens: 700,
        jsonMode: true,
        timeout: LIS_SALARY_LLM_TIMEOUT_MS,
      }
    );

    const parsed = safeParseJsonObject(raw);
    if (!parsed || typeof parsed !== 'object') return null;

    const min = parseLisSalaryNumber(parsed.minAnnualChf);
    const max = parseLisSalaryNumber(parsed.maxAnnualChf);
    const confidence = Number(parsed.confidence);
    const evidence = String(parsed.evidence || '').trim();

    if (!min || !max) return null;
    if (min < 20000 || min > 500000 || max < 20000 || max > 500000) return null;
    if (Number.isFinite(confidence) && confidence < 0.55) return null;

    return {
      min: Math.min(min, max),
      max: Math.max(min, max),
      currency: 'CHF',
      confidence: Number.isFinite(confidence) ? Number(confidence.toFixed(2)) : undefined,
      evidence: evidence.slice(0, 260),
    };
  } catch {
    return null;
  }
}

/**
 * Post-process LIS jobs in data/jobs.json to fix data quality issues
 * from the Arca24 HTML parser capturing UI elements as job content.
 *
 * Idempotent: detects already-cleaned jobs and skips them.
 * Returns the number of jobs cleaned.
 */
async function cleanLisJobs() {
  if (!fs.existsSync(DATA_JOBS)) return 0;

  const allJobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  if (!Array.isArray(allJobs)) return 0;

  let cleaned = 0;
  let salaryRegexApplied = 0;
  let salaryLlmApplied = 0;
  let salaryLlmTried = 0;
  let salaryLlmSkipped = 0;
  let salaryCanonicalSkipped = 0;
  let salaryNoNumeric = 0;
  let llmBudget = LIS_SALARY_LLM_MAX_JOBS;
  const llmAvailable = LIS_SALARY_LLM_FALLBACK_ENABLED && isAnyModelAvailable();

  for (const job of allJobs) {
    if (!isLisJob(job)) continue;

    // ── Company fields ──
    job.company = LIS_COMPANY_NAME;
    job.companyKey = LIS_KEY;
    job.companyDomain = 'lugano-lis.ch';

    // ── Title ──
    const cleanTitle = extractCleanTitle(job.title);
    job.title = cleanTitle;

    // ── Location ──
    const dirtyDesc = String(job.description || '');
    job.location = extractLocation(dirtyDesc, job.url);
    job.canton = getCompanyDefaults('lis').canton;

    // ── Description ──
    const cleanDesc = cleanLisDescription(dirtyDesc);
    if (cleanDesc.length >= 50) {
      job.description = cleanDesc;
    }

    // ── Slug ──
    const cleanSlug = normalizeKey(job.title);
    let slugChanged = false;
    if (cleanSlug.length >= 3) {
      const existingSlug = String(job.slug || '').trim();
      // Only update when genuinely different — minor title wording changes
      // (capitalisation, preposition swaps) should not generate new slugs.
      // Pass per-job location hint so isSlugStable can never collapse two
      // distinct city openings into the same slug.
      const _slugLocationHint = String(job.addressLocality || job.location || '');
      if (!isSlugStable(existingSlug, cleanSlug, {
        existingLocation: _slugLocationHint,
        newLocation: _slugLocationHint,
      })) {
        job.slug = cleanSlug;
        slugChanged = true;
      }
    }

    // ── titleByLocale ──
    if (!job.titleByLocale) job.titleByLocale = {};
    job.titleByLocale.it = job.title;

    // ── slugByLocale ──
    // LIS has no per-locale titles, so only the Italian slug is set.
    // Other locales are filled by the translation pipeline.
    if (!job.slugByLocale) job.slugByLocale = {};
    if (slugChanged || !job.slugByLocale.it) {
      job.slugByLocale.it = job.slug;
    }

    // ── descriptionByLocale ──
    if (!job.descriptionByLocale) job.descriptionByLocale = {};
    const itLocaleDesc = String(job.descriptionByLocale.it || '');
    if (itLocaleDesc.length < 120) {
      job.descriptionByLocale.it = job.description;
    } else {
      const cleanedIt = cleanLisDescription(itLocaleDesc);
      if (cleanedIt.length >= 120) {
        job.descriptionByLocale.it = cleanedIt;
      } else {
        job.descriptionByLocale.it = job.description;
      }
    }

    // ── sourceLang ──
    job.sourceLang = detectLang(job.description || job.title);

    // Canonical source for LIS should be Italian when available.
    const canonicalItDesc = String(job.descriptionByLocale?.it || '').trim();
    if (canonicalItDesc.length >= 120) {
      job.description = canonicalItDesc;
    }
    const canonicalItTitle = String(job.titleByLocale?.it || '').trim();
    if (canonicalItTitle.length >= 3) {
      job.title = canonicalItTitle;
    }

    const salarySourceText =
      String(job.descriptionByLocale?.it || '').trim() ||
      String(job.description || '').trim() ||
      String(dirtyDesc || '').trim();
    const salaryTextHash = hashLisSalaryText(salarySourceText);

    if (isLisSalaryExtractionCurrent(job, salaryTextHash)) {
      salaryCanonicalSkipped++;
    } else {
      const lisSalary = extractLisSalaryFromDescription(salarySourceText);
      if (lisSalary) {
        applyLisStructuredSalary(job, lisSalary);
        setLisSalaryExtractionMeta(job, {
          source: 'lis_regex_text',
          textHash: salaryTextHash,
          confidence: 0.98,
        });
        salaryRegexApplied++;
      } else {
        const shouldTryLlm = shouldUseLisSalaryLlmFallback(salarySourceText);
        if (shouldTryLlm && llmAvailable && llmBudget > 0) {
          llmBudget -= 1;
          salaryLlmTried++;
          const llmSalary = await extractLisSalaryWithLlm(salarySourceText);
          if (llmSalary) {
            applyLisStructuredSalary(job, llmSalary);
            setLisSalaryExtractionMeta(job, {
              source: 'lis_llm_fallback',
              textHash: salaryTextHash,
              confidence: llmSalary.confidence,
              note: llmSalary.evidence,
            });
            salaryLlmApplied++;
          } else {
            setLisSalaryExtractionMeta(job, {
              source: 'lis_no_numeric_salary',
              textHash: salaryTextHash,
              confidence: 0,
              note: 'llm_fallback_no_explicit_numeric_salary',
            });
            salaryNoNumeric++;
          }
        } else if (shouldTryLlm && (!llmAvailable || llmBudget <= 0)) {
          salaryLlmSkipped++;
        } else {
          setLisSalaryExtractionMeta(job, {
            source: 'lis_no_numeric_salary',
            textHash: salaryTextHash,
            confidence: 0,
            note: 'no_explicit_numeric_salary',
          });
          salaryNoNumeric++;
        }
      }
    }

    cleaned++;
  }

  // Dedupe same LIS position crawled across multiple language variants.
  const lisBestByKey = new Map();
  const toDrop = new Set();
  for (let idx = 0; idx < allJobs.length; idx += 1) {
    const job = allJobs[idx];
    if (!isLisJob(job)) continue;
    const lisId = extractLisJobId(String(job?.url || ''));
    const canonicalUrl = normalizeLisUrlForDedup(String(job?.url || ''));
    const titleLocKey = normalizeKey(`${job?.title || ''}|${job?.location || ''}`);
    const fallbackKey = normalizeKey(job?.slug || job?.title || '');
    const key =
      lisId ? `lis-id:${lisId}` :
      canonicalUrl ? `lis-url:${canonicalUrl}` :
      titleLocKey ? `lis-title-location:${titleLocKey}` :
      `fallback:${fallbackKey}`;
    const score = lisJobQualityScore(job);
    const prev = lisBestByKey.get(key);
    if (!prev) {
      lisBestByKey.set(key, { idx, score });
      continue;
    }
    if (score > prev.score) {
      toDrop.add(prev.idx);
      lisBestByKey.set(key, { idx, score });
    } else {
      toDrop.add(idx);
    }
  }
  const deduped = toDrop.size > 0
    ? allJobs.filter((_, idx) => !toDrop.has(idx))
    : allJobs;

  if (cleaned > 0 || toDrop.size > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(deduped, null, 2) + '\n');
    if (fs.existsSync(PUBLIC_DATA_JOBS)) {
      fs.writeFileSync(PUBLIC_DATA_JOBS, JSON.stringify(deduped, null, 2) + '\n');
    }
    console.log(`🧹 Cleaned ${cleaned} LIS jobs (company, title, location, description, slug).`);
    if (toDrop.size > 0) {
      console.log(`🧯 Deduped ${toDrop.size} LIS language-variant duplicates.`);
    }
    console.log(
      `💰 LIS salary canonicalization: regex=${salaryRegexApplied}, llm=${salaryLlmApplied}/${salaryLlmTried}, ` +
      `llm-skipped=${salaryLlmSkipped}, no-numeric=${salaryNoNumeric}, cached=${salaryCanonicalSkipped}, llm-budget-left=${llmBudget}`
    );
  }

  return cleaned;
}

/**
 * When JOBS_LIS_FORCE_RECRAWL=1, remove all LIS jobs from jobs.json
 * BEFORE running the base crawler so the skip-optimization does not
 * skip their detail pages.  The base crawler will re-scrape them.
 */
function purgeLisJobsForRecrawl() {
  const force = String(process.env.JOBS_LIS_FORCE_RECRAWL || '') === '1';
  if (!force) return 0;
  if (!fs.existsSync(DATA_JOBS)) return 0;

  const allJobs = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  if (!Array.isArray(allJobs)) return 0;

  const before = allJobs.length;
  const kept = allJobs.filter((j) => !isLisJob(j));
  const purged = before - kept.length;

  if (purged > 0) {
    fs.writeFileSync(DATA_JOBS, JSON.stringify(kept, null, 2) + '\n');
    console.log(`🗑️ Purged ${purged} LIS jobs from jobs.json for force-recrawl.`);
  }
  return purged;
}

// ──────────────────────────────────────────────────────────────
// Adapter setup
// ──────────────────────────────────────────────────────────────

/**
 * Ensure the LIS adapter JSON has the correct seed URLs.
 * The Arca24 platform serves content at lavoraconnoi.lugano-lis.ch
 * with pagination via ?page=N parameter.
 */
function ensureAdapterSeedUrls() {
  const adapterPath = path.join(ADAPTERS_DIR, `${LIS_KEY}.json`);
  const seedUrls = [...LIS_LISTING_URLS];

  if (!fs.existsSync(adapterPath)) {
    console.log(`⚠️ Adapter ${LIS_KEY}.json not found — creating it.`);
    const adapter = {
      companyKey: LIS_KEY,
      companyName: 'LIS – Lugano Istituti Sociali',
      companyHost: 'lavoraconnoi.lugano-lis.ch',
      enabled: true,
      priority: 10,
      crawlerModes: ['generic_ats', 'html', 'jsonld'],
      seedUrls,
      notes: 'Arca24 ATS at lavoraconnoi.lugano-lis.ch — requires bot-compatible User-Agent.',
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    return;
  }

  try {
    const adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf-8'));
    adapter.seedUrls = seedUrls;
    adapter.companyHost = adapter.companyHost || 'lavoraconnoi.lugano-lis.ch';
    if (!adapter.crawlerModes?.includes('generic_ats')) {
      adapter.crawlerModes = adapter.crawlerModes || [];
      adapter.crawlerModes.unshift('generic_ats');
    }
    adapter.priority = Math.max(adapter.priority || 0, 10);
    adapter.notes = 'Arca24 ATS at lavoraconnoi.lugano-lis.ch — requires bot-compatible User-Agent.';
    adapter.updatedAt = new Date().toISOString();
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2) + '\n');
    console.log(`📝 Adapter ${LIS_KEY} updated with ${seedUrls.length} seed URLs.`);
  } catch (err) {
    console.warn(`⚠️ Could not update adapter: ${err.message}`);
  }
}

// ──────────────────────────────────────────────────────────────
// Base crawler invocation
// ──────────────────────────────────────────────────────────────

function runBaseCrawler() {
  return runDedicatedBaseCrawler({
    root: ROOT,
    companyKeys: LIS_KEY,
    localizeOnlyCompanyKeys: LIS_KEY,
    disableWorkdayForce: true,
    extraEnv: {
      JOBS_CRAWLER_USER_AGENT: LIS_USER_AGENT,
    },
  });
}

// ──────────────────────────────────────────────────────────────
// Direct Arca24 scraping (bypasses shared pipeline discovery)
// ──────────────────────────────────────────────────────────────

/**
 * Crawl the Arca24 listing pages directly, fetch each detail page,
 * and merge discovered jobs into data/jobs.json.
 *
 * The shared crawler pipeline cannot discover Arca24 jobs because:
 *   1. lavoraconnoi.lugano-lis.ch is not in the isKnownAtsHost() list
 *   2. Adapter seed URLs are deprioritized behind career-hint URLs
 *      and hit the per-company career-page cap before being processed
 *
 * This function bypasses those issues by scraping Arca24 directly.
 */
async function crawlArca24Direct() {
  console.log('\n🔍 Direct Arca24 scraping: discovering job URLs...');
  const listingJobs = await fetchLisJobUrls({
    userAgent: LIS_USER_AGENT,
    timeoutMs: 15000,
  });
  console.log(`📋 Found ${listingJobs.length} job URLs on Arca24 listing pages`);
  if (listingJobs.length === 0) {
    console.warn('⚠️  No job URLs found on Arca24 listing pages — the ATS may be down or structure changed');
    return { discovered: 0, parsed: 0, merged: 0 };
  }

  // Fetch and parse each detail page
  console.log('\n📄 Fetching Arca24 detail pages...');
  const parsedJobs = [];
  const DETAIL_DELAY_MS = 800;
  for (const listing of listingJobs) {
    const detail = await fetchLisDetailPage(listing.url, {
      userAgent: LIS_USER_AGENT,
      timeoutMs: 15000,
    });
    if (detail) {
      const job = buildLisJob(listing.url, detail);
      if (job) {
        console.log(`  ✅ ${detail.title} → ${detail.location || 'unknown'} [${(detail.description || '').length} chars]`);
        parsedJobs.push(job);
      } else {
        console.log(`  ⏭️  ${listing.title} → could not build job object`);
      }
    } else {
      console.log(`  ⚠️  ${listing.url} → detail page parse failed`);
    }
    // Polite delay between requests
    if (parsedJobs.length < listingJobs.length) {
      await new Promise((r) => setTimeout(r, DETAIL_DELAY_MS));
    }
  }

  console.log(`\n🏛️ Parsed LIS jobs: ${parsedJobs.length} / ${listingJobs.length}`);
  if (parsedJobs.length === 0) {
    console.warn('⚠️  All detail pages failed to parse — Arca24 structure may have changed');
    return { discovered: listingJobs.length, parsed: 0, merged: 0 };
  }

  // Deduplicate by title+location
  const seenKeys = new Set();
  const deduplicated = [];
  for (const job of parsedJobs) {
    const key = `${normalize(job.title)}|${normalize(job.location)}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      deduplicated.push(job);
    }
  }
  if (deduplicated.length < parsedJobs.length) {
    console.log(`🔄 Deduplicated: ${parsedJobs.length} → ${deduplicated.length} unique`);
  }

  // Merge into jobs.json
  const existing = readExistingCrawlerJobs(LIS_KEY, DATA_JOBS);
  const allExisting = Array.isArray(existing) ? existing : [];
  const nonLisJobs = allExisting.filter((j) => !isLisJob(j));
  const lisExisting = allExisting.filter(isLisJob);
  const existingByUrl = new Map();
  for (const j of lisExisting) {
    const key = normalizeLisUrlForDedup(j.url);
    if (key) existingByUrl.set(key, j);
  }

  let added = 0;
  let updated = 0;
  const mergedLis = deduplicated.map((job) => {
    const key = normalizeLisUrlForDedup(job.url);
    const prev = existingByUrl.get(key);
    if (!prev) {
      added += 1;
      return job;
    }
    updated += 1;
    // Merge: preserve existing locale translations, update core fields
    return {
      ...prev,
      ...job,
      titleByLocale: mergeLocaleTextMap(prev.titleByLocale, job.titleByLocale, 3),
      descriptionByLocale: mergeLocaleTextMap(prev.descriptionByLocale, job.descriptionByLocale, 30),
      slugByLocale: mergeLocaleTextMap(prev.slugByLocale, job.slugByLocale, 3),
    };
  });

  const allJobs = [...nonLisJobs, ...mergedLis];
  fs.writeFileSync(DATA_JOBS, JSON.stringify(allJobs, null, 2) + '\n');
  if (fs.existsSync(PUBLIC_DATA_JOBS) || fs.existsSync(path.dirname(PUBLIC_DATA_JOBS))) {
    fs.writeFileSync(PUBLIC_DATA_JOBS, JSON.stringify(allJobs, null, 2) + '\n');
  }

  console.log(`\n📊 Merge result: ${mergedLis.length} LIS jobs (${added} added, ${updated} updated)`);
  return { discovered: listingJobs.length, parsed: deduplicated.length, merged: mergedLis.length };
}

// ──────────────────────────────────────────────────────────────
// Stats & validation
// ──────────────────────────────────────────────────────────────

function logLisJobStats(beforeSnapshot = new Map()) {
  if (!fs.existsSync(DATA_JOBS)) {
    console.log('ℹ️ jobs.json non trovato — nessuna statistica disponibile.');
    return { total: 0, ticino: 0, crawlDiff: { newJobs: [], updatedJobs: [], removedJobs: [], unchangedCount: 0, unchangedJobs: [] } };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8'));
  const allJobs = Array.isArray(raw) ? raw : [];
  const lisJobs = allJobs.filter(isLisJob);
  const ticinoJobs = lisJobs.filter((job) => normalize(job?.canton) === 'ti');
  const nonTicino = lisJobs.length - ticinoJobs.length;

  console.log(`\n📊 === LIS – Lugano Istituti Sociali Job Stats ===`);
  console.log(`  🏛️ Job totali trovati (LIS): ${lisJobs.length}`);
  console.log(`  ✅ Job in Ticino (canton=TI): ${ticinoJobs.length}`);
  if (nonTicino > 0) {
    console.log(`  ❌ Job scartati (location non Ticino): ${nonTicino}`);
    const examples = lisJobs
      .filter((job) => normalize(job?.canton) !== 'ti')
      .map((job) => `${job?.title || '?'} → ${job?.location || job?.canton || '?'}`)
      .slice(0, 10);
    for (const loc of examples) console.log(`     - ${loc}`);
  }
  console.log('');

  // Crawl change summary (new/updated/removed)
  const afterSnapshot = snapshotJobSlugs(lisJobs);
  const crawlDiff = computeCrawlDiff(beforeSnapshot, afterSnapshot);
  printCrawlChangeSummary(crawlDiff, 'LIS');
  writeCrawlChangeSummaryToGH(crawlDiff, 'LIS');

  return { total: lisJobs.length, ticino: ticinoJobs.length, crawlDiff };

}

function validateLisLocaleCoverage() {
  validateDedicatedLocaleCoverage({
    strictEnvVar: 'JOBS_LIS_STRICT',
    label: 'LIS',
    dataJobsPath: DATA_JOBS,
    isTargetJob: isLisJob,
    detectSourceLang: (text) => detectLang(text),
    // LIS source content is mostly Italian; translations can occasionally be
    // delayed by provider quotas. Keep strict checks for missing locale fields,
    // but avoid failing the whole crawler on untranslated variants.
    untranslatedCheck: false,
    deriveSlug: deriveLocalizedSlug,
    isTrustedDomain: isTrustedLisDomain,
    untrustedDomainReason: 'untrusted_domain_for_lis_job',
    noJobsMessage: 'Nessun job LIS trovato dopo il crawl — niente da validare.',
  });
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

async function main() {
  setCrawlerStartTime();
  registerCrawlerSummaryGuard(LIS_KEY, 'LIS');
  console.log('🏛️ Running dedicated LIS – Lugano Istituti Sociali jobs crawler...');

  // Ensure the adapter has the correct Arca24 seed URLs
  ensureAdapterSeedUrls();

  // Optionally purge LIS jobs before crawling to force re-scraping
  purgeLisJobsForRecrawl();

  // Snapshot company jobs before crawl for diff summary
    const _beforeSnapshot = snapshotJobSlugs(readExistingCrawlerJobs(LIS_KEY, DATA_JOBS).filter(isLisJob))

  // ── Step 1: Direct Arca24 scraping ──
  // The shared pipeline cannot discover Arca24 jobs due to host-matching
  // limitations (see parser module for details). Scrape directly first.
  const arca24Result = await crawlArca24Direct();

  // ── Step 2: Run shared pipeline for AI localization of discovered jobs ──
  // If we found jobs via direct scraping, run the base crawler in
  // localize-existing-only mode to handle AI translation.
  if (arca24Result.merged > 0) {
    console.log('\n🌐 Running shared pipeline for AI localization...');
    await runBaseCrawler();
  } else {
    // Still try the base crawler as a fallback in case Arca24 direct scraping fails
    console.log('\n🔄 Direct scraping found 0 jobs — trying shared pipeline as fallback...');
    await runBaseCrawler();
  }

  // Post-process: fix Arca24 HTML parsing artifacts
  await cleanLisJobs();

  // Log stats
  const stats = logLisJobStats(_beforeSnapshot);
  const crawlDiff = stats.crawlDiff;
  if (stats.total === 0) {
    console.warn('⚠️  WARNING: No LIS jobs found after both direct Arca24 scraping and shared pipeline.');
    console.warn('⚠️  This likely indicates the Arca24 ATS structure has changed or the site is down.');
    console.warn(`⚠️  Direct scraping discovered ${arca24Result.discovered} URLs, parsed ${arca24Result.parsed} jobs.`);
    process.exitCode = 1;
    return;
  }

  validateLisLocaleCoverage();
  await flushScores();

  // Write per-crawler slice and reassemble global dataset
  const _durationMs = getCrawlerElapsedMs();
  const _sliceRaw = fs.existsSync(DATA_JOBS) ? JSON.parse(fs.readFileSync(DATA_JOBS, 'utf-8')) : [];
  const _sliceJobs = Array.isArray(_sliceRaw) ? _sliceRaw.filter(isLisJob) : [];
  writeJobsCrawlerSlice(LIS_KEY, _sliceJobs);
  writeSummaryCrawlerSlice({
    key: LIS_KEY,
    label: 'LIS',
    generatedAt: new Date().toISOString(),
    total: _sliceJobs.length,
    newCount: crawlDiff.newJobs.length,
    updatedCount: crawlDiff.updatedJobs.length,
    removedCount: crawlDiff.removedJobs.length,
    unchangedCount: crawlDiff.unchangedCount,
    durationMs: _durationMs,
    avgDurationMs: _durationMs,
    durationHistory: [_durationMs],
    newJobs: crawlDiff.newJobs.slice(0, 30),
    updatedJobs: crawlDiff.updatedJobs.slice(0, 30),
    removedJobs: crawlDiff.removedJobs.slice(0, 30),
    unchangedJobs: (crawlDiff.unchangedJobs || []).slice(0, 30),
  });
  await assembleJobsDataset();
}

main().catch((err) => {
  console.error(`❌ LIS crawler failed: ${err?.message || err}`);
  process.exit(1);
});
