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

import { fetchWithRetry, RETRYABLE_STATUS, WAF_IP_BLOCK_STATUS, isConnectionLevelFetchError } from './transient-fetch.mjs';
import { fetchHtmlViaJinaWithRetry, rescueHtmlIfChallenged } from './jina-proxy.mjs';

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
      // Convert each list item into a line-start bullet so the list structure
      // survives the tag strip. Without the `• ` marker, `<li>` items collapse
      // into newline-separated prose that the parser-quality audit's
      // `hasStructuredContent` check (looks for `<li>` OR `^[-•*]` OR `^\d.`)
      // can no longer detect as a list — the Spital-STS-class "10/10 flat"
      // regression. The bullet also survives a later `normalizeSpace()` collapse
      // as an inline `• `, which `normalizeDescriptionBullets` re-expands.
      .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/ {2,}/g, ' '),
  ).trim();
  return stripInlineJsCode(stripped);
}

/**
 * Some ATS pages (SAP SF, Stripe Freeform forms) inline JavaScript widget
 * code OR a trailing stylesheet right inside the description container, NOT
 * wrapped in `<script>`/`<style>` tags — typically a job-share/email widget
 * or a CSS theme dump (SuccessFactors CSB appends `.Job.benefits{display:flex}…`
 * as plain text, sometimes when `readPropertyBlock` truncates the opening
 * `<style>` tag so the `<style>…</style>` stripper above can't reach it).
 * Both always appear at the bottom, after real content — truncate at the
 * first such signature.
 */
export function stripInlineJsCode(text = '') {
  if (!text) return text;
  // Each probe matches the *start* of a leaked code/style block. Truncate at
  // the earliest match so a JS widget followed by a CSS dump (or vice-versa)
  // is removed in full.
  const probes = [
    // Inline JS: `function NAME(...)`, `$(`, `jQuery(`, CDATA. Anchored against
    // a newline to avoid mid-sentence false positives like "the function `x()`".
    /(?:\n|^)\s*(?:\/\/\s*<!\[CDATA\[|\$\(|jQuery\(|function\s+\w*\s*\(|\(function\s*\()/,
    // Orphan `var X = window.` / `var X = document.` declarations.
    /(?:\n|^)\s*var\s+\w+\s*=\s*(?:window|document|new\s+Object|\{)/,
    // Bare DOM/BOM-API calls leaked WITHOUT a `function(`/`$(`/`jQuery(`/`var X=`
    // wrapper — e.g. a SuccessFactors job-share widget that inlines
    // `document.getElementById(…)`, `window.location = …`, `.addEventListener('click', …)`
    // or `new Array(…)` as plain text. The deploy gate (validate-jobs-quality.mjs
    // CODE_PATTERNS) flags each of these independently of any wrapper, so the
    // stripper must too: a wrapper-less JS leak otherwise survives stripping yet
    // trips the gate → permanent CI fail / deploy blocked (#1765). Mirrors the
    // gate's DOM-API / window-API / addEventListener / JS-constructor patterns.
    /(?:\n|^|\s)(?:document\.(?:getElementById|querySelector|cookie|write)\b|window\.(?:location|addEventListener|onload)\b|\.addEventListener\s*\(\s*['"]|new\s+(?:Array|Object|Map|Set)\s*\()/,
    // Inline CSS: a class/id rule block carrying a real declaration, optionally
    // preceded by a `/* … */` build marker. Selector must start with `.`/`#`
    // so prose like "version 2.0 {note}" can't trip it.
    /(?:\n|^|\s)(?:\/\*[^*]{0,80}\*\/\s*)?[.#][\w-][\w.\-,#:>[\]='"\s]*?\{[^{}]{0,300}?(?:display|background(?:-image)?|margin|padding|grid(?:-\w+)?|flex(?:-\w+)?|width|height|font(?:-\w+)?|color|border|filter)\s*:[^{}]*\}/i,
  ];
  let cut = -1;
  for (const re of probes) {
    const m = text.match(re);
    if (m && m.index > 0 && (cut === -1 || m.index < cut)) cut = m.index;
  }
  return cut > 0 ? text.slice(0, cut).trimEnd() : text;
}

export async function fetchHtml(url, { timeoutMs } = {}) {
  const t = timeoutMs || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  try {
    const html = await fetchWithRetry(async () => {
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
    // 200-but-challenge (IP-reputation WAF served a challenge on a 200) → Jina.
    return await rescueHtmlIfChallenged(html, url, { timeoutMs: t });
  } catch (err) {
    // The plain retries above all hit a connection-level `fetch failed`: the
    // GitHub runner's datacenter egress intermittently can't reach an otherwise
    // healthy site (~1-3% of fetches per wave; verified — the same sites return
    // 200 from a clean IP). Rather than give up (or keep retrying the same flaky
    // egress), fetch this once through the Jina Reader proxy: a reliable egress +
    // real browser that returns the page's raw HTML, so the parsers are
    // unchanged and the data IS collected. Two cases route to the proxy: (a)
    // connection-level failures (no HTTP response received), and (b) an
    // IP-reputation WAF hard status (403/406/415/451, WAF_IP_BLOCK_STATUS) — the
    // server DID respond but with an anti-bot fence keyed on the datacenter
    // egress IP, which Jina's clean IP clears (#2025). Genuine 4xx (404/410 gone,
    // 401 auth) are NOT in the set and still propagate; if Jina also fails it
    // returns null → the original error re-throws, so a real break is unchanged.
    // (Parse errors are real and still propagate.)
    if (isConnectionLevelFetchError(err) || WAF_IP_BLOCK_STATUS.has(err?.status)) {
      // Retry the proxy: Jina's egress IP can be transiently 429'd or WAF-blocked
      // (200 challenge/empty body) — a retry lands on a different Jina IP and
      // usually succeeds. Returns null on exhaustion → safe-fail by re-throwing
      // the original error (dataset preserved). Body validation + original-error
      // preservation live in the shared helper.
      const html = await fetchHtmlViaJinaWithRetry(url, { timeoutMs: t });
      if (html != null) return html;
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