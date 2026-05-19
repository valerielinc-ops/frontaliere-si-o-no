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
  return decodeEntities(
    String(html || '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/ {2,}/g, ' '),
  ).trim();
}

export async function fetchHtml(url, { timeoutMs } = {}) {
  const t = timeoutMs || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), t);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml,application/rss+xml,*/*', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
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
