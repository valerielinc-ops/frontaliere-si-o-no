#!/usr/bin/env node
/**
 * Detect and reset needsRetranslation for jobs where a non-IT locale slot
 * contains text in the wrong language (Italian in EN/DE/FR, or German in EN/FR, etc.)
 *
 * Detection strategy per locale:
 *  1. looksItalian(text)  → always wrong in EN/DE/FR slot
 *  2. isSameAsItalian(text, itText) → only flag if IT source text is actually Italian
 *  3. looksGerman(text) in EN/FR slot → wrong language
 *
 * A job is flagged (needsRetranslation = true) when at least one locale slot
 * (en/de/fr) in title OR description is in the wrong language.
 *
 * Usage:
 *   node scripts/reset-wrong-language-translations.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DRY_RUN = process.argv.includes('--dry-run');
const CRAWLERS_DIR = join(process.cwd(), 'data/jobs/by-crawler');

// ── Language markers ────────────────────────────────────────────────────────

/** Italian words/patterns that strongly indicate Italian text. */
const ITALIAN_MARKERS = new Set([
  // Contracted prepositions + articles (uniquely Italian)
  'del', 'della', 'delle', 'degli', 'dei',
  'dal', 'dalla', 'dalle', 'dagli', 'dai',
  'al', 'alla', 'alle', 'agli', 'ai',
  'nel', 'nella', 'nelle', 'negli', 'nei',
  'sul', 'sulla', 'sulle', 'sugli', 'sui',
  'col', 'coi',
  // Italian conjunctions/prepositions (uncommon standalone in EN/DE/FR)
  'tra', 'fra', 'senza', 'verso', 'oppure', 'però', 'dunque', 'quindi', 'eppure',
  'nonché',
  // Italian determiners/pronouns
  'questo', 'questa', 'questi', 'queste', 'quello', 'quella', 'quelli', 'quelle',
  'cui', 'gli',
  // Italian verb forms with accents
  'è', 'sarà', 'saranno', 'vengono', 'viene',
  // Italian verb forms (common in descriptions)
  'essere', 'avere', 'siamo', 'cerca', 'cerchiamo', 'ricerchiamo', 'ricerca',
  'offriamo', 'valutiamo', 'stiamo', 'prevede', 'prevista',
  // Italian occupation nouns (no English/German/French equivalent as-is)
  'autista', 'autisti',
  'infermiera', 'infermiere', 'infermieri',
  'cuoco', 'cuochi', 'cuoca',
  'cassiere', 'cassieri', 'cassiera',
  'commesso', 'commessi', 'commessa', 'commesse',
  'impiegato', 'impiegati', 'impiegata',
  'operaio', 'operai', 'operaia', 'operaie',
  'addetto', 'addetti', 'addetta',
  'venditore', 'venditori', 'venditrice',
  'montatore', 'montatori', 'montatrice',
  'macellaio', 'macellai', 'macellaia',
  'geometra', 'geometri',
  'perito', 'periti', 'perita',
  'ragioniere', 'ragionieri', 'ragioniera',
  // Job-domain Italian nouns
  'azienda', 'aziende', 'aziendale', 'aziendali',
  'esperienza', 'esperienze',
  'responsabile', 'responsabili', 'responsabilità',
  'settore', 'settori',
  'sviluppo', 'sviluppatore', 'sviluppatori',
  'gestione', 'gestire',
  'formazione',
  'candidato', 'candidati', 'candidatura',
  'profilo', 'profili',
  'requisiti', 'requisito',
  'mansioni', 'mansione',
  'contratto', 'contratti', 'contrattuale',
  'stipendio', 'stipendi',
  'retribuzione', 'retribuzioni',
  'orario', 'orari',
  'ruolo', 'ruoli',
  'attività',
  'competenze', 'competenza',
  'conoscenza', 'conoscenze',
  'laureato', 'laureati', 'laurea',
  'diplomato', 'diplomata', // "diploma" is also English — only flag Italian inflected forms
  'assunzione', 'assunzioni',
  'lavoro', 'lavorare', 'lavoratore', 'lavoratori',
  'ingegnere', 'ingegneri',
  'tecnico', 'tecnici', 'tecnica',
  'collaborazione',
  'offerta', 'offerte',
  'opportunità',
  'ambito',
  'sede', 'sedi',
  'presso',
  'disponibile', 'disponibili',
  'richiesto', 'richiesta', 'richiesti', 'richieste',
  'necessaria', 'necessario',
]);

/**
 * German markers: German-specific vocabulary that is not Italian/English/French.
 * Presence in EN or FR slot indicates wrong language.
 */
const GERMAN_MARKERS = new Set([
  'und', 'der', 'die', 'das', 'für', 'mit', 'ein', 'eine', 'dem', 'den',
  // NOTE: "des" removed — it is also a French article (partitive)

  'ist', 'als', 'auf', 'bei', 'im', 'zu', 'von', 'aus', 'am', 'nach', 'über',
  'oder', 'aber', 'wenn', 'dass', 'nicht', 'auch', 'wird', 'werden', 'haben',
  'sein', 'wir', 'sie', 'uns', 'euch', 'ihnen', 'mehr', 'sehr', 'noch', 'schon',
  'immer', 'alle', 'allem', 'allen', 'sowie', 'welche', 'welcher',
  // German job words
  'fachfrau', 'fachmann', 'fachwirt', 'fachkraft',
  'kaufmann', 'kauffrau',
  'leitung', 'führung', 'beratung', 'verwaltung',
  'abteilung', 'unternehmen', 'mitarbeiter', 'mitarbeiterin',
  'verkauf', 'einkauf', 'vertrieb',
  'stelle', 'stellen', 'stellenanteil',
  'suchen', 'gesucht',
  'verantwortung', 'aufgaben',
  'kenntnisse', 'erfahrung', 'erfahrungen',
  'abschluss',
]);

/** Words that are safe/identical across languages (technical, English-origin) */
const SAFE_IDENTICAL_WORDS = new Set([
  'manager', 'senior', 'junior', 'specialist', 'director', 'developer',
  'engineer', 'consultant', 'analyst', 'coordinator', 'assistant',
  'software', 'hardware', 'network', 'cloud', 'data', 'it', 'hr',
  'finance', 'marketing', 'sales', 'support', 'project', 'product',
  'fullstack', 'frontend', 'backend', 'devops', 'qa', 'ux', 'ui',
  'ceo', 'cto', 'cfo', 'coo',
  'receptionist', 'controller', 'intern',
]);

const MIN_TEXT_LENGTH = 10;

// ── Helpers ──────────────────────────────────────────────────────────────────

function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  return text.toLowerCase()
    .replace(/[''']/g, "'")
    .split(/[\s,;:()\[\]{}\-–—\/\|.!?&@#%°"«»]+/)
    .filter(w => w.length >= 2);
}

function normalizeForCompare(t) {
  return (t || '').toLowerCase().replace(/[^\wàèéìòù]/g, '').trim();
}

function scoreMarkers(words, markerSet) {
  return words.filter(w => markerSet.has(w)).length;
}

/**
 * True if text appears to be in Italian.
 */
function looksItalian(text) {
  if (!text || text.length < MIN_TEXT_LENGTH) return false;
  const words = tokenize(text);
  let score = 0;
  for (const w of words) {
    if (ITALIAN_MARKERS.has(w)) score++;
    // Italian suffix patterns (min word length to avoid false positives)
    if (w.length > 6 && /zione$|tore$|iere$|trice$|mente$|aggio$|anza$|enza$|ità$|ata$|uto$/.test(w)) score++;
  }
  return score >= 2;
}

/**
 * True if text appears to be in German.
 * German-specific characters (ä/ö/ü/ß) are conclusive — no other language uses them.
 * Fallback: 2+ German stop words for ASCII-only German text.
 */
function looksGerman(text) {
  if (!text || text.length < MIN_TEXT_LENGTH) return false;
  // German-specific characters are unambiguous (not French/Italian/Spanish)
  if (/[äöüÄÖÜß]/.test(text)) return true;
  const words = tokenize(text);
  return scoreMarkers(words, GERMAN_MARKERS) >= 2;
}

/**
 * True if the locale text is essentially the same as the IT source text
 * AND the IT source text is actually Italian (not English/German/French).
 *
 * Used to catch un-translated Italian titles (e.g. "Responsabile IT" in EN slot).
 * Does NOT flag English/German technical titles that are legitimately identical.
 */
function isSameAsItalian(localeText, itText, locale) {
  if (!localeText || !itText) return false;
  if (normalizeForCompare(localeText) !== normalizeForCompare(itText)) return false;

  const words = tokenize(itText);

  // If all words are safe (technical/English-origin), don't flag
  const allSafe = words.every(w => SAFE_IDENTICAL_WORDS.has(w) || /^\d+$/.test(w));
  if (allSafe) return false;

  // If the shared text looks German and we're checking DE slot → correct, don't flag
  if (locale === 'de' && looksGerman(itText)) return false;

  // If the shared text is German (and we're not in DE slot) → handled by looksGerman check elsewhere

  // If the shared text is itself Italian → flag (not translated)
  if (looksItalian(itText)) return true;

  // Conservative: for short texts (≤ 4 words) that don't look Italian or German,
  // assume they may be international/English and don't flag.
  if (words.length <= 4) return false;

  // For longer texts (5+ words) that are identical across IT/EN/DE/FR and not Italian/German,
  // flag anyway — long texts being identical almost always means not translated.
  return true;
}

/**
 * Returns reason string if the locale text is in the wrong language, else null.
 */
function wrongLanguageReason(localeText, itText, locale) {
  if (!localeText || localeText.trim() === '') return null;

  if (looksItalian(localeText)) {
    return `${locale} looks Italian`;
  }

  if (isSameAsItalian(localeText, itText, locale)) {
    return `${locale} identical to IT source (untranslated)`;
  }

  // German text in EN or FR slot = wrong language
  if (locale !== 'de' && looksGerman(localeText)) {
    return `${locale} looks German`;
  }

  return null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function processFile(filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.warn(`[skip] Could not parse: ${filePath}`);
    return { flagged: 0, total: 0 };
  }

  const jobs = data.jobs;
  if (!Array.isArray(jobs)) return { flagged: 0, total: 0 };

  let flagged = 0;
  let changed = false;

  for (const job of jobs) {
    const titleByLocale = job.titleByLocale || {};
    const descByLocale = job.descriptionByLocale || {};
    const itTitle = titleByLocale.it || job.title || '';
    const itDesc = descByLocale.it || job.description || '';

    let jobNeedsRetranslation = false;
    const reasons = [];

    for (const locale of ['en', 'de', 'fr']) {
      const localeTitle = titleByLocale[locale] || '';
      const localeDesc = descByLocale[locale] || '';

      const titleReason = wrongLanguageReason(localeTitle, itTitle, locale);
      if (titleReason) {
        jobNeedsRetranslation = true;
        reasons.push(`title.${titleReason}: ${localeTitle.slice(0, 60)}`);
      }

      const descReason = wrongLanguageReason(localeDesc, itDesc, locale);
      if (descReason) {
        jobNeedsRetranslation = true;
        reasons.push(`desc.${descReason}`);
      }
    }

    if (jobNeedsRetranslation && !job.needsRetranslation) {
      job.needsRetranslation = true;
      changed = true;
      flagged++;
      if (DRY_RUN) {
        console.log(`  [flag] ${job.slug || job.title}:`);
        for (const r of reasons) console.log(`         ${r}`);
      }
    }
  }

  if (changed && !DRY_RUN) {
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  return { flagged, total: jobs.length };
}

function main() {
  const files = readdirSync(CRAWLERS_DIR).filter(f => f.endsWith('.json'));
  console.log(`[reset-wrong-lang] Scanning ${files.length} crawler files${DRY_RUN ? ' (DRY RUN)' : ''}...`);

  let totalFlagged = 0;
  let totalJobs = 0;

  for (const file of files) {
    const filePath = join(CRAWLERS_DIR, file);
    const { flagged, total } = processFile(filePath);
    if (flagged > 0) {
      console.log(`  ${file}: flagged ${flagged}/${total} jobs`);
    }
    totalFlagged += flagged;
    totalJobs += total;
  }

  console.log(`\n[reset-wrong-lang] Done. Flagged ${totalFlagged} jobs across ${totalJobs} total.`);
  if (DRY_RUN) {
    console.log('[reset-wrong-lang] Dry run — no files modified.');
  } else {
    console.log('[reset-wrong-lang] Files updated in place.');
  }
}

main();
