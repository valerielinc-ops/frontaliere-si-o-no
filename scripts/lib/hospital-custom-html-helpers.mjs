#!/usr/bin/env node
/**
 * Tiny shared helpers used by the custom-HTML hospital parsers
 * (CSVP Poschiavo, CS Bregaglia, CSVM Val Müstair, OSCAM Castelrotto, …).
 *
 * Each of these hospitals has a unique career-page layout with no shared
 * platform — but the boilerplate (HTML entity decoding, polite fetch with
 * timeout, category/employmentType heuristics for healthcare titles) is the
 * same. Keep this module DRY and importable from any hospital-specific parser.
 */

import { fetchWithRetry, RETRYABLE_STATUS, isTransientFetchError } from './transient-fetch.mjs';
import { fetchViaJina, detectJinaErrorBody } from './jina-proxy.mjs';

export const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  uuml: 'ü', ouml: 'ö', auml: 'ä', Uuml: 'Ü', Ouml: 'Ö', Auml: 'Ä',
  szlig: 'ß',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  Eacute: 'É', Egrave: 'È', Ecirc: 'Ê',
  agrave: 'à', acirc: 'â', aacute: 'á', aring: 'å', atilde: 'ã',
  iacute: 'í', igrave: 'ì', icirc: 'î', iuml: 'ï',
  oacute: 'ó', ograve: 'ò', ocirc: 'ô', otilde: 'õ',
  uacute: 'ú', ugrave: 'ù', ucirc: 'û',
  ccedil: 'ç', Ccedil: 'Ç', oelig: 'œ', OElig: 'Œ', aelig: 'æ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  hellip: '…', ndash: '–', mdash: '—', middot: '·', laquo: '«', raquo: '»',
  copy: '©', reg: '®', deg: '°',
};

export function decodeEntities(s = '') {
  return String(s || '')
    .replace(/&([a-zA-Z]+);/g, (m, n) => Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, n) ? NAMED_ENTITIES[n] : m)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

export function normalize(s = '') {
  return String(s || '').trim().toLowerCase();
}

export function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

export function htmlToText(html = '') {
  const stripped = decodeEntities(
    String(html || '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/ {2,}/g, ' '),
  ).trim();
  return stripInlineJsCode(stripped);
}

/**
 * Some ATS pages (SAP SF, Stripe Freeform forms) inline JavaScript widget
 * code right inside the description container, NOT wrapped in `<script>`
 * tags — typically a job-share/email widget. The HTML stripper above
 * removes script tags but cannot reach JS that was already plain-text in
 * the source. Truncate at the first inline `function NAME(...)` signature
 * (these widgets always appear at the bottom, after real content).
 */
export function stripInlineJsCode(text = '') {
  if (!text) return text;
  // Match: optional leading whitespace + `function NAME(...)`, with at least
  // one alphanumeric name. Anchored against a newline to avoid mid-sentence
  // false positives like "the function `lookupX(...)` returns".
  const m = text.match(/(?:\n|^)\s*(?:\/\/\s*<!\[CDATA\[|\$\(|jQuery\(|function\s+\w*\s*\(|\(function\s*\()/);
  if (m && m.index > 0) {
    return text.slice(0, m.index).trimEnd();
  }
  // Fallback: orphan `var X = window.` / `var X = document.` declarations
  const m2 = text.match(/(?:\n|^)\s*var\s+\w+\s*=\s*(?:window|document|new\s+Object|\{)/);
  if (m2 && m2.index > 0) {
    return text.slice(0, m2.index).trimEnd();
  }
  return text;
}

export async function fetchHtml(url, { timeoutMs } = {}) {
  const t = timeoutMs || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  try {
    return await fetchWithRetry(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), t);
      try {
        const res = await fetch(url, {
          headers: { Accept: 'text/html,application/xhtml+xml,application/xml,application/rss+xml,*/*', 'User-Agent': USER_AGENT },
          signal: controller.signal,
        });
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status} from ${url}`);
          err.status = res.status;
          err.retryable = RETRYABLE_STATUS.has(res.status);
          throw err;
        }
        return await res.text();
      } finally {
        clearTimeout(timer);
      }
    }, { label: `hospital-custom-html ${url}` });
  } catch (err) {
    // The plain retries above all hit a connection-level `fetch failed`: the
    // GitHub runner's datacenter egress intermittently can't reach an otherwise
    // healthy site (~1-3% of fetches per wave; verified — the same sites return
    // 200 from a clean IP). Rather than give up (or keep retrying the same flaky
    // egress), fetch this once through the Jina Reader proxy: a reliable egress +
    // real browser that returns the page's raw HTML, so the parsers are
    // unchanged and the data IS collected. Only for connection-level transient
    // errors — HTTP 4xx/5xx and parse errors are real and still propagate.
    if (isTransientFetchError(err)) {
      let res;
      try {
        res = await fetchViaJina(url, { timeoutMs: t });
      } catch {
        // The proxy fetch itself failed — re-throw the ORIGINAL egress error so
        // the failure log reports the real cause, not a Jina-side error.
        throw err;
      }
      if (res.ok) {
        const html = await res.text();
        // Jina answers HTTP 200 even when it never reached the target (a
        // challenge / error / empty page). Feeding that non-target HTML to the
        // parsers would silently yield 0 jobs → on a multi-page crawler those
        // pages' jobs look "removed" → archived as expired → de-indexed. Detect
        // it and re-throw the original error instead (safe-fail: dataset
        // preserved, exactly the pre-proxy behaviour). Same guard as goline /
        // cambiavalute.
        const reason = detectJinaErrorBody(html);
        if (!reason) return html;
        console.warn(`⚠️ Jina egress returned a non-target body (${reason}) for ${url} — preserving safe-fail.`);
      }
    }
    throw err;
  }
}

/**
 * Healthcare-tuned category detector. Default = "Sanità / Ospedali" because
 * most jobs at a hospital are clinical.
 */
export function detectHealthcareCategory(text = '') {
  const t = normalize(text);
  if (/pfleg|infirm|cure|soin|aide.soignant|asa|asse|fage|spitex|nachtwache|geburts|hebamme|levatrice|ostetric/.test(t)) return 'Sanità / Ospedali';
  if (/arzt|ärztin|oberarzt|chefarzt|leitend|medizin|medic|chirurg|anästhes|onkolog|kardiolog|neurolog|pädiatr|gynäk|psichiatr|geriatr|m[ée]decin/.test(t)) return 'Sanità / Ospedali';
  if (/labor|laborant|biomedizin|analyse|radiolog|röntgen|mtra|mrt|physiother|ergo|logopäd|fisioterap|riabilit|rehabilit|apothek|farmac|farmacist/.test(t)) return 'Sanità / Ospedali';
  if (/techni|haustechni|facility|wartung|maintenan|manutenz|impianti/.test(t)) return 'Tecnica';
  if (/it\b|informatik|software|develop|programm|system|applikation/.test(t)) return 'IT';
  if (/admin|sekret|segret|buchhalt|sachbearbeit|finanz|controll|account|compta|amministra/.test(t)) return 'Amministrazione';
  if (/hr|human|personal|talent|recruit|rh\b|ressources humaines|risorse umane/.test(t)) return 'Risorse Umane';
  if (/küche|koch|gastro|hauswirt|reinig|hotellerie|cuisine|restauration|cucina|cuoco|ristoraz/.test(t)) return 'Ospitalità';
  if (/logist|magazz|lager|einkauf|transport|approvvig/.test(t)) return 'Logistica';
  if (/market|kommunik|communic|comunicaz/.test(t)) return 'Marketing';
  if (/lernend|praktik|ausbildung|apprenti|stage|stagiair|tirocin|formaz/.test(t)) return 'Formazione';
  return 'Sanità / Ospedali';
}

export function detectHealthcareExperienceLevel(text = '') {
  const t = normalize(text);
  if (/praktik|stage|stagiair|intern|apprendist|lehrling|lernend|apprenti|tirocin|werkstudent/.test(t)) return 'intern';
  if (/junior|jr|assistent|assistant/.test(t)) return 'junior';
  if (/senior|sr|lead|head|director|dirett|chef|verantwort|leiter|leitend|stationsleitung|oberarzt|chefarzt|primario|responsable|cadre|responsabile/.test(t)) return 'senior';
  return 'mid';
}

/**
 * Heuristic employment-type detector.
 *   Recognises percentages ("80%", "60-100%"), German keywords (Vollzeit/Teilzeit),
 *   French (temps plein/partiel) and Italian (tempo pieno/parziale).
 */
export function detectHealthcareEmploymentType(text = '') {
  const t = normalize(text);
  if (!t) return 'OTHER';
  const pct = t.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || t.match(/(\d{2,3})\s*%/);
  if (pct) {
    const maxPct = pct[2] ? parseInt(pct[2], 10) : parseInt(pct[1], 10);
    if (maxPct < 90) return 'PART_TIME';
    if (maxPct >= 90) return 'FULL_TIME';
  }
  if (/vollzeit|temps plein|tempo pieno|full.time/.test(t)) return 'FULL_TIME';
  if (/teilzeit|temps partiel|tempo parziale|part.time/.test(t)) return 'PART_TIME';
  return 'OTHER';
}