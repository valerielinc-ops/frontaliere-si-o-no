/**
 * canton-notices-parse.mjs — parser puri (nessuna rete) delle fonti
 * istituzionali LENTE dei cantoni: RSS/Atom, liste HTML, JSON nell'attributo
 * `data-entities` (CMS i-web di NW/OW/SH/UR), JSON di zh.ch, API XML di be.ch.
 *
 * Contratto comune: ogni parser ritorna `{ items, warnings }`, dove ogni item e'
 * `{ title, url, publishedAt }` e SOLO questo. Nessun testo dell'articolo,
 * nessun teaser: il dataset `canton-notices.json` e' un indice di metadati
 * (titolo + link + data) che rimanda alla fonte ufficiale.
 *
 * Date: `publishedAt` e' una stringa ISO (`YYYY-MM-DD` se la fonte da' solo il
 * giorno, ISO completo UTC se da' anche l'ora) oppure `null`. Una data che manca
 * o non si legge resta `null`: non viene MAI stimata (ne' dall'URL, ne' dalla
 * data di osservazione). Una data oltre `now + FUTURE_TOLERANCE_MS` non e' una
 * data di pubblicazione (e' la data di una chiusura stradale, di un evento, di
 * una scadenza): diventa `null`.
 */

import { XMLParser } from 'fast-xml-parser';

export const FUTURE_TOLERANCE_MS = 36 * 3600 * 1000;
export const MAX_TITLE_CHARS = 220;
export const MIN_TITLE_CHARS = 8;

// ── Entita' HTML e testo ─────────────────────────────────────────────────────

const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', ndash: '–', mdash: '—',
  laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', bdquo: '„',
  hellip: '…', shy: '', middot: '·', bull: '•', szlig: 'ß', euro: '€',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', Eacute: 'É', Egrave: 'È', Ecirc: 'Ê',
  agrave: 'à', aacute: 'á', acirc: 'â', Agrave: 'À', Acirc: 'Â',
  igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï',
  ograve: 'ò', oacute: 'ó', ocirc: 'ô', Ocirc: 'Ô',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', Ugrave: 'Ù',
  ccedil: 'ç', Ccedil: 'Ç', oelig: 'œ', OElig: 'Œ',
};

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return m;
      return String.fromCodePoint(cp);
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, e) ? NAMED_ENTITIES[e] : m;
  });
}

export const collapse = (s) => String(s).replace(/[\u00ad\u200b]/g, '').replace(/\s+/g, ' ').trim();
/** Un tag HTML, con gli attributi quotati che possono contenere `>` (classi Tailwind `[&_>div]:…`). */
const TAG_RE = /<(?:[^>"']|"[^"]*"|'[^']*')*>/g;
export const textOf = (html) => collapse(decodeEntities(String(html).replace(TAG_RE, ' ')));

const BLOCK_TAG_RE = /<\/?(?:div|p|li|ul|ol|h[1-6]|time|br|section|article|figure|figcaption|dl|dt|dd|table|tr|td|small)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
/** I blocchi di testo di un frammento, nell'ordine (una card = titolo, etichetta, teaser, data). */
export const textBlocks = (html) => String(html).replace(BLOCK_TAG_RE, '\u0000').split('\u0000').map(textOf).filter(Boolean);

// ── Date ─────────────────────────────────────────────────────────────────────

/** Mesi in de/fr/it/en, forme piene e abbreviate. Nessuna chiave ambigua fra lingue. */
const MONTHS = {
  januar: 1, jan: 1, janvier: 1, janv: 1, gennaio: 1, gen: 1, january: 1,
  februar: 2, feb: 2, febr: 2, fevrier: 2, février: 2, fevr: 2, févr: 2, febbraio: 2, february: 2,
  märz: 3, maerz: 3, mär: 3, mrz: 3, mars: 3, marzo: 3, mar: 3, march: 3,
  april: 4, apr: 4, avril: 4, avr: 4, aprile: 4,
  mai: 5, maggio: 5, mag: 5, may: 5,
  juni: 6, jun: 6, juin: 6, giugno: 6, giu: 6, june: 6,
  juli: 7, jul: 7, juillet: 7, juil: 7, luglio: 7, lug: 7, july: 7,
  august: 8, aug: 8, août: 8, aout: 8, agosto: 8, ago: 8,
  september: 9, sept: 9, sep: 9, septembre: 9, settembre: 9, set: 9, sett: 9,
  oktober: 10, okt: 10, octobre: 10, oct: 10, ottobre: 10, ott: 10, october: 10,
  november: 11, nov: 11, novembre: 11,
  dezember: 12, dez: 12, décembre: 12, decembre: 12, déc: 12, dec: 12, dicembre: 12, dic: 12, december: 12,
};

/** Parole che accompagnano una data e da sole non fanno un titolo (giorni, «Uhr», «News»). */
const DATE_FILLER = new Set([
  'lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche',
  'mo', 'di', 'mi', 'do', 'fr', 'sa', 'so', 'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag', 'sonntag',
  'lu', 'me', 'gi', 've', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato', 'domenica',
  'uhr', 'h', 'news', 'am', 'le', 'il', 'du', 'au', 'vom', 'bis', 'er',
]);

const ISO_RE = /\b(20\d\d)-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d)(?::(\d\d)(?:\.\d+)?)?(Z|[+-]\d\d:?\d\d)?)?/g;
const DMY_RE = /(?<![\d.\/])(\d{1,2})[./](\d{1,2})[./](20\d\d|\d\d)(?![\d])/g;
const DAY_MONTH_RE = /(?<![\d])(\d{1,2})(?:\.|er|º)?\s+([A-Za-zÀ-ÿ]{3,10})\.?\s+(20\d\d)\b/g;

function validYmd(y, m, d) {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Tutte le date riconosciute in un testo, nell'ordine in cui compaiono.
 * @returns {{ index: number, length: number, value: string }[]}  value: 'YYYY-MM-DD' o ISO completo
 */
export function findDates(text) {
  const s = String(text ?? '');
  const out = [];
  for (const m of s.matchAll(ISO_RE)) {
    const day = validYmd(+m[1], +m[2], +m[3]);
    if (!day) continue;
    let value = day;
    if (m[4] && m[7]) {
      const t = Date.parse(`${day}T${m[4]}:${m[5]}:${m[6] ?? '00'}${m[7] === 'Z' ? 'Z' : m[7].replace(/^([+-]\d\d)(\d\d)$/, '$1:$2')}`);
      if (Number.isFinite(t)) value = new Date(t).toISOString();
    }
    out.push({ index: m.index, length: m[0].length, value });
  }
  for (const m of s.matchAll(DMY_RE)) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const day = validYmd(y, +m[2], +m[1]);
    if (day) out.push({ index: m.index, length: m[0].length, value: day });
  }
  for (const m of s.matchAll(DAY_MONTH_RE)) {
    const month = MONTHS[m[2].toLowerCase()];
    if (!month) continue;
    const day = validYmd(+m[3], month, +m[1]);
    if (day) out.push({ index: m.index, length: m[0].length, value: day });
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * Normalizza una data di pubblicazione. Accetta RFC 822 (`pubDate`), ISO, e
 * le forme testuali di `findDates`. Futuro oltre la tolleranza → null.
 */
export function normalizePublishedAt(raw, { now = Date.now() } = {}) {
  if (raw == null) return null;
  const s = collapse(String(raw));
  if (!s) return null;
  let value = null;
  // ISO o testuale prima: `Date.parse('04.10.2026')` in V8 legge mese/giorno all'americana.
  const found = findDates(s);
  if (found.length && found[0].index <= 4) value = found[0].value;
  else if (/^[A-Za-z]{3},?\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4}/.test(s) || /^\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d/.test(s)) {
    const t = Date.parse(s);
    if (Number.isFinite(t)) value = new Date(t).toISOString();
  } else if (found.length) value = found[0].value;
  if (!value) return null;
  const t = value.length === 10 ? Date.parse(`${value}T00:00:00Z`) : Date.parse(value);
  if (!Number.isFinite(t) || t > now + FUTURE_TOLERANCE_MS) return null;
  return value;
}

// ── Titoli ───────────────────────────────────────────────────────────────────

/** Testi di link che sono inviti all'azione, non titoli. */
const CTA_RE = /^(?:jetzt\s+(?:ansehen|lesen|entdecken)|mehr\s+dazu|zum\s+beitrag|weiter(?:\s*lesen)?|weiterlesen|mehr(?:\s+(?:erfahren|lesen|infos?|anzeigen))?|details?|zum\s+artikel|zum\s+presseartikel|news\s+lesen|lire\s+la\s+suite|en\s+savoir\s+plus|plus\s+d['’]infos?|voir\s+plus|leggi(?:\s+(?:tutto|di\s+più|di\s+piu))?|scopri\s+di\s+più|read\s+more|more|arrow_right_alt|alle\s+\S+\s+anzeigen|nächste\s+seite.*|vorherige\s+seite.*|page\s+suivante.*)$/i;

/** «Lire la suite de « X »» / «« Weiter lesen X »» → X. */
function unwrapReadMore(t) {
  const m = /^(?:lire la suite de|weiter lesen|leggi(?: tutto)?)\s*[«"“]\s*(.+?)\s*[»"”]?\s*$/i.exec(t)
    || /^«\s*weiter lesen\s+(.+?)\s*»\s*$/i.exec(t);
  return m ? m[1] : t;
}

export function cleanTitle(raw) {
  let t = collapse(decodeEntities(String(raw ?? '')));
  t = unwrapReadMore(t);
  // Etichette di formato in coda: «(PDF, 10 Seiten, 363 KB)», «(pdf, 54 KB)».
  t = t.replace(/\s*\((?:pdf|docx?|xlsx?)[^)]*\)\s*$/i, '');
  // Inviti all'azione in coda: «… Mehr erfahren», «… weiterlesen».
  t = t.replace(/\s+(?:mehr erfahren|weiterlesen|weiter lesen|lire la suite|en savoir plus|leggi tutto|read more)\s*[»›>]*$/i, '');
  // Inviti all'azione in testa: «mehr erfahren: X», «weiter zu Meldung: X», «Lesen Sie über X».
  t = t.replace(/^(?:mehr erfahren(?: über)?|weiter zu (?:meldung|artikel|beitrag)|lesen sie (?:über|mehr über)|zum artikel|en savoir plus sur|lire la suite de|leggi di più su)\s*[:–-]?\s*/i, '');
  t = t.replace(/^[»›>|\s]+|[«‹<|\s]+$/g, '').trim();
  if (t.length > MAX_TITLE_CHARS) {
    const cut = t.slice(0, MAX_TITLE_CHARS);
    const sp = cut.lastIndexOf(' ');
    t = `${(sp > MAX_TITLE_CHARS * 0.6 ? cut.slice(0, sp) : cut).trim()}…`;
  }
  return t;
}

export function isUsableTitle(t) {
  if (typeof t !== 'string') return false;
  const s = t.trim();
  if (s.length < MIN_TITLE_CHARS || CTA_RE.test(s)) return false;
  // Solo data / solo numeri: non e' un titolo («mer 30 sep», «24.09.2026», «News 01.10.2026»).
  const residue = s
    .replace(/\d+/g, ' ')
    .split(/[^A-Za-zÀ-ÿ]+/)
    .filter((w) => w && !Object.prototype.hasOwnProperty.call(MONTHS, w.toLowerCase()) && !DATE_FILLER.has(w.toLowerCase()));
  return residue.join('').length >= 3;
}

/** Toglie una data in testa al titolo («24.09.2026 – Mitteilung …», «News 01.10.2026 …»). */
export function stripLeadingDate(t) {
  const dates = findDates(t);
  if (!dates.length || dates[0].index > 12) return t;
  const head = t.slice(0, dates[0].index);
  if (!/^(?:news|actualit[ée]s?|aktuell|blog|emploi|immobilier|information générale|(?:lun|mar|mer|jeu|ven|sam|dim|mo|di|mi|do|fr|sa|so|lu|me|gi|ve)\.?)?\s*[–—|:,-]?\s*$/i.test(head)) return t;
  const out = t.slice(dates[0].index + dates[0].length).replace(/^[\s,–—|:-]+/, '').trim();
  return out.length >= MIN_TITLE_CHARS ? out : t;
}

// ── URL ──────────────────────────────────────────────────────────────────────

export function absoluteUrl(href, base) {
  try {
    const u = new URL(decodeEntities(String(href).trim()), base);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

/** La base per gli href relativi: `<base href>` se la pagina lo dichiara (ostwind.ch), altrimenti la pagina. */
export function documentBase(html, pageUrl) {
  const m = /<base\b(?:[^>"']|"[^"]*"|'[^']*')*?\bhref\s*=\s*["']([^"']+)["']/i.exec(String(html).slice(0, 20000));
  return (m && absoluteUrl(m[1], pageUrl)) || pageUrl;
}

const bareHost = (h) => h.toLowerCase().replace(/^www\./, '');
export const sameSite = (a, b) => bareHost(new URL(a).hostname) === bareHost(new URL(b).hostname);

// ── HTML: liste di link ──────────────────────────────────────────────────────

/**
 * Rimuove script, stili, commenti e i blocchi `<nav>`. NON toglie `<header>` e
 * `<footer>`: dentro le card (`<article><header><h3><a>`) portano titolo e data.
 * Il rumore di navigazione lo esclude il `linkPattern` curato, non la struttura.
 */
export function stripChrome(html) {
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ');
}

const HEADING_RE = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i;
const TITLE_CLASS_RE = /<([a-z0-9]+)\b[^>]*\bclass\s*=\s*["'][^"']*(?:title|titel|titre|heading|headline)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i;

/**
 * Estrae le voci da una pagina-lista HTML.
 *
 * Una voce e' un `<a href>` dello stesso sito (www indifferente) il cui
 * `pathname+search` combacia con `linkPattern` — il pattern e' curato per
 * fonte nel registro: la FORMA di un link non basta a dire che e' una
 * notizia (AGENTS.md #6), il contesto lo da' il pattern verificato sulla
 * pagina vera. Piu' ancore verso lo stesso URL (immagine + titolo + «weiter
 * lesen») collassano in una voce con il titolo migliore.
 *
 * Data: si cerca nell'ancora stessa, poi nel testo fra l'ancora precedente e
 * questa ('before'), poi fra questa e la successiva ('after'): la posizione
 * vincente e' quella che trova una data per piu' voci della pagina, cosi' una
 * lista «data, titolo, data, titolo» non assegna a ogni voce la data della
 * successiva. Nessuna data → null.
 */
export function parseHtmlLinks(html, { pageUrl, linkPattern, linkHosts = [], dropParams = [], datesInList = true, now = Date.now(), maxItems = 40 } = {}) {
  const warnings = [];
  if (!linkPattern) return { items: [], warnings: ['linkPattern mancante: fonte html-links non curata'], error: 'config' };
  const re = new RegExp(linkPattern, 'i');
  const extraHosts = new Set(linkHosts.map((h) => String(h).toLowerCase()));
  const cleaned = stripChrome(html);
  const page = new URL(pageUrl);
  const base = documentBase(html, page.href);
  const byUrl = new Map();
  const order = [];
  const anchorRe = /<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a>/gi;
  for (const m of cleaned.matchAll(anchorRe)) {
    const hm = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[1]);
    if (!hm) continue;
    const abs = absoluteUrl(hm[1] ?? hm[2] ?? hm[3] ?? '', base);
    if (!abs) continue;
    const u = new URL(abs);
    // Parametri di sola navigazione (il `redirect=` di Liferay su vs.ch) fuori
    // dall'URL: altrimenti la stessa voce ha N URL e l'id non e' stabile.
    for (const p of dropParams) u.searchParams.delete(p);
    const url = u.href;
    if (!sameSite(url, page.href) && !extraHosts.has(u.hostname.toLowerCase())) continue;
    if (u.hostname === page.hostname && u.pathname + u.search === page.pathname + page.search) continue;
    if (!re.test(u.pathname + u.search)) continue;
    const inner = m[2];
    // Candidati in ordine di affidabilita': heading/elemento «title» dentro
    // l'ancora, poi il primo blocco della card (una card avvolta dal link e'
    // titolo + etichetta + teaser + data: solo il primo e' il titolo), poi il
    // testo intero, poi l'attributo title.
    const ranked = [];
    const heading = HEADING_RE.exec(inner) || TITLE_CLASS_RE.exec(inner);
    if (heading) ranked.push([0, textOf(heading[heading.length - 1])]);
    const blocks = textBlocks(inner);
    if (blocks.length > 1) for (const b of blocks) ranked.push([1, b]);
    ranked.push([2, textOf(inner)]);
    for (const attr of ['title', 'aria-label']) {
      const am = new RegExp(`\\b${attr}\\s*=\\s*"([^"]{8,})"`, 'i').exec(m[1]);
      if (am) ranked.push([3, collapse(decodeEntities(am[1]))]);
    }
    let title = null;
    let rank = 9;
    for (const [r, c] of ranked) {
      const t = cleanTitle(stripLeadingDate(cleanTitle(c)));
      if (isUsableTitle(t)) {
        title = t;
        rank = r;
        break;
      }
    }
    let entry = byUrl.get(url);
    if (!entry) {
      entry = { url, anchors: [] };
      byUrl.set(url, entry);
      order.push(entry);
    }
    entry.anchors.push({ start: m.index, end: m.index + m[0].length, title, rank });
  }
  if (!order.length) return { items: [], warnings };

  // Le ancore di una voce che stanno vicine (immagine + titolo + «mehr»): una
  // stessa URL ripetuta lontano (box «in evidenza» + lista) non allarga lo span.
  const spanOf = (e) => {
    const first = e.anchors[0];
    const near = e.anchors.filter((a) => a.start - first.start < 1500);
    return { start: first.start, end: Math.max(...near.map((a) => a.end)) };
  };
  const windowText = (from, to) => textOf(cleaned.slice(Math.max(0, from), Math.max(0, to)));

  // Titolo: il migliore fra le ancore; se tutte sono inviti all'azione
  // («mehr erfahren»), l'ultimo heading prima della voce, dentro la sua card.
  const resolved = [];
  order.forEach((e, i) => {
    const span = spanOf(e);
    const own = e.anchors.filter((a) => a.title).sort((a, b) => a.rank - b.rank || b.title.length - a.title.length)[0];
    let title = own?.title ?? null;
    if (!title) {
      const prevEnd = i > 0 ? spanOf(order[i - 1]).end : 0;
      const slice = cleaned.slice(Math.max(prevEnd, span.start - 800), span.start);
      const heads = [...slice.matchAll(/<h[1-6]\b(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/h[1-6]>/gi)];
      const t = heads.length ? cleanTitle(textOf(heads[heads.length - 1][1])) : null;
      if (t && isUsableTitle(t)) title = t;
    }
    if (title) resolved.push({ url: e.url, title, span });
  });
  if (!resolved.length) return { items: [], warnings };

  const WINDOW = 320;
  const spans = resolved.map((r) => r.span);
  const positions = {
    // l'intero tratto fra la prima e l'ultima ancora della voce: immagine e
    // titolo sono spesso due <a> con la data in mezzo.
    inside: spans.map((sp) => windowText(sp.start, sp.end)),
    before: spans.map((sp, i) => windowText(Math.max(i > 0 ? spans[i - 1].end : 0, sp.start - WINDOW), sp.start)),
    after: spans.map((sp, i) => windowText(sp.end, Math.min(i < spans.length - 1 ? spans[i + 1].start : cleaned.length, sp.end + WINDOW))),
  };
  let chosen = null;
  if (datesInList) {
    let bestHits = 0;
    for (const pos of ['inside', 'before', 'after']) {
      const hits = positions[pos].filter((t) => findDates(t).length > 0).length;
      if (hits > bestHits) {
        bestHits = hits;
        chosen = pos;
      }
    }
  }

  const items = resolved.map((r, i) => {
    let publishedAt = null;
    if (chosen) {
      const ds = findDates(positions[chosen][i]);
      // 'before': la data piu' vicina all'ancora e' l'ultima della finestra.
      const pick = chosen === 'before' ? ds[ds.length - 1] : ds[0];
      if (pick) publishedAt = normalizePublishedAt(pick.value, { now });
    }
    return { title: r.title, url: r.url, publishedAt };
  });
  if (items.length > maxItems) warnings.push(`lista troncata a ${maxItems} voci su ${items.length}`);
  return { items: newestFirst(items).slice(0, maxItems), warnings };
}

/**
 * Le voci datate dalla piu' recente, poi quelle senza data nell'ordine della
 * pagina. Una pagina che elenca piu' anni (bls.ch: 2017, 2018 … in testa) non
 * deve riempire il tetto con l'archivio.
 */
export function newestFirst(items) {
  const dated = items.filter((i) => i.publishedAt).sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
  return [...dated, ...items.filter((i) => !i.publishedAt)];
}

// ── RSS / Atom ───────────────────────────────────────────────────────────────

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
  parseTagValue: false,
  isArray: (name) => name === 'item' || name === 'entry' || name === 'link',
});

const asText = (v) => {
  if (v == null) return '';
  if (Array.isArray(v)) return asText(v[0]);
  if (typeof v === 'object') return asText(v['#text'] ?? v['@_href'] ?? '');
  return String(v);
};

function atomLink(links) {
  const arr = Array.isArray(links) ? links : [links];
  const alt = arr.find((l) => l && typeof l === 'object' && (!l['@_rel'] || l['@_rel'] === 'alternate') && l['@_href']);
  if (alt) return alt['@_href'];
  const first = arr.find((l) => typeof l === 'string' || (l && typeof l === 'object' && l['#text']));
  return first ? asText(first) : null;
}

export function parseFeed(text, { pageUrl, emptyPubDate = false, now = Date.now(), maxItems = 40 } = {}) {
  const warnings = [];
  let doc;
  try {
    // Corpi e descrizioni non servono (il dataset tiene solo titolo, link e
    // data) e sono la parte che fa scattare il limite di espansione delle
    // entita' su feed con HTML escapato (ville-fribourg.ch: 1019 > 1000).
    // `<description/>` vuoto e autochiuso NON va toccato: la regex «fino al
    // prossimo </description>» si mangerebbe il primo <item> (ville-fribourg.ch).
    const lean = String(text).replace(/<(description|content:encoded|content|summary)(?:\s[^>]*)?(?<!\/)>[\s\S]*?<\/\1>/gi, '');
    doc = xml.parse(lean);
  } catch (err) {
    return { items: [], warnings: [`feed non parsabile: ${err.message}`], error: 'parse' };
  }
  const channel = doc?.rss?.channel ?? doc?.['rdf:RDF'] ?? null;
  const rawItems = channel?.item ?? doc?.['rdf:RDF']?.item ?? doc?.feed?.entry ?? null;
  if (!Array.isArray(rawItems)) return { items: [], warnings: ['nessun <item>/<entry>: non e\' un feed RSS/Atom'], error: 'shape' };
  const items = [];
  for (const it of rawItems) {
    const title = cleanTitle(textOf(asText(it.title)));
    const href = it.link ? (Array.isArray(it.link) && typeof it.link[0] === 'object' ? atomLink(it.link) : asText(it.link)) : asText(it.guid);
    const url = href ? absoluteUrl(href, pageUrl) : null;
    if (!url || !isUsableTitle(title)) continue;
    const rawDate = emptyPubDate ? null : (asText(it.pubDate) || asText(it['dc:date']) || asText(it.published) || asText(it.updated) || null);
    items.push({ title, url, publishedAt: normalizePublishedAt(rawDate, { now }) });
  }
  if (items.length > maxItems) warnings.push(`feed troncato a ${maxItems} voci su ${items.length}`);
  return { items: items.slice(0, maxItems), warnings };
}

// ── JSON in data-entities (CMS i-web: nw.ch, ow.ch, stadt-schaffhausen.ch) ──

/**
 * La lista e' un JSON HTML-escaped nell'attributo `data-entities` della
 * tabella; nel sorgente non ci sono `<a>` agli articoli. Ogni riga ha `name`
 * (con dentro `<a href="/_rte/information/<id>">titolo</a>`) e `_datum`
 * (`YYYY-MM-DD hh:mm:ss`, ora locale senza fuso → si tiene solo il giorno).
 */
export function parseJsonEntities(html, { pageUrl, now = Date.now(), maxItems = 40 } = {}) {
  const warnings = [];
  const items = [];
  const attrs = [...String(html).matchAll(/\bdata-entities\s*=\s*"([^"]*)"/gi)];
  if (!attrs.length) return { items: [], warnings: ['nessun attributo data-entities'], error: 'shape' };
  for (const a of attrs) {
    let doc;
    try {
      doc = JSON.parse(decodeEntities(a[1]));
    } catch (err) {
      warnings.push(`data-entities non e' JSON: ${err.message}`);
      continue;
    }
    for (const row of Array.isArray(doc?.data) ? doc.data : []) {
      const name = String(row?.name ?? '');
      const hm = /href\s*=\s*\\?["']([^"'\\]+)\\?["']/i.exec(name);
      const url = hm ? absoluteUrl(hm[1], pageUrl) : null;
      const title = cleanTitle(textOf(name));
      if (!url || !isUsableTitle(title)) continue;
      const day = /^(\d{4}-\d\d-\d\d)/.exec(String(row?._datum ?? ''))?.[1] ?? row?.datum ?? null;
      items.push({ title, url, publishedAt: normalizePublishedAt(day, { now }) });
    }
  }
  items.sort((x, y) => String(y.publishedAt ?? '').localeCompare(String(x.publishedAt ?? '')));
  return { items: items.slice(0, maxItems), warnings };
}

// ── JSON API: zh.ch e be.ch ──────────────────────────────────────────────────

/** zh.ch: `{ news: [{ title, date: 'dd.mm.yyyy', type, link }] }`, link relativo. */
export function parseZhNewsJson(text, { pageUrl, now = Date.now(), maxItems = 40 } = {}) {
  let doc;
  try {
    doc = JSON.parse(String(text));
  } catch (err) {
    return { items: [], warnings: [`risposta non JSON: ${err.message}`], error: 'parse' };
  }
  if (!Array.isArray(doc?.news)) return { items: [], warnings: ['manca news[]'], error: 'shape' };
  const items = [];
  for (const n of doc.news) {
    const url = n?.link ? absoluteUrl(n.link, pageUrl) : null;
    const title = cleanTitle(textOf(n?.title ?? ''));
    if (!url || !isUsableTitle(title)) continue;
    items.push({ title, url, publishedAt: normalizePublishedAt(n?.date ?? null, { now }), meta: { type: n?.type ?? null } });
  }
  return { items: items.slice(0, maxItems), warnings: [] };
}

/**
 * be.ch `/api/news`: XML `<Collection><item>` con `id`, `publishOn` (ora locale
 * senza fuso), `contentList/contentList/{title, languageCode}` e `topicTags`.
 * L'URL pubblico e' `https://www.be.ch/<lingua>/start.html?newsID=<id>`, la forma
 * del sitemap news del portale. Una voce con `publishOn` nel futuro NON e'
 * ancora pubblicata e viene scartata (non solo resa senza data).
 */
export function parseBeNewsApi(text, { now = Date.now(), maxItems = 40 } = {}) {
  let doc;
  try {
    doc = new XMLParser({ ignoreAttributes: true, parseTagValue: false, isArray: (n) => n === 'item' || n === 'contentList' || n === 'topicTags' }).parse(String(text));
  } catch (err) {
    return { items: [], warnings: [`risposta non XML: ${err.message}`], error: 'parse' };
  }
  const rows = doc?.Collection?.item;
  if (!Array.isArray(rows)) return { items: [], warnings: ['manca Collection/item'], error: 'shape' };
  const items = [];
  let unpublished = 0;
  for (const r of rows) {
    const id = asText(r.id);
    const contents = (r.contentList ?? []).flatMap((c) => c?.contentList ?? [c]);
    const content = contents.find((c) => c && asText(c.title)) ?? null;
    const lang = asText(content?.languageCode) || 'de';
    const title = cleanTitle(textOf(asText(content?.title)));
    if (!/^[0-9a-f-]{36}$/i.test(id) || !isUsableTitle(title) || !/^(de|fr)$/.test(lang)) continue;
    const publishOn = asText(r.publishOn);
    const day = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d)/.exec(publishOn);
    // ora locale Europe/Zurich: confronto prudente con un'ora di margine (UTC+1/+2)
    if (day && Date.parse(`${day[1]}T${day[2]}:00Z`) - 2 * 3600 * 1000 > now) {
      unpublished++;
      continue;
    }
    const tags = (r.topicTags ?? []).flatMap((t) => (Array.isArray(t?.topicTags) ? t.topicTags : [t?.topicTags ?? t])).map(asText).filter(Boolean);
    items.push({
      title,
      url: `https://www.be.ch/${lang}/start.html?newsID=${id}`,
      publishedAt: normalizePublishedAt(day ? day[1] : null, { now }),
      meta: { topicTags: tags },
    });
  }
  return { items: items.slice(0, maxItems), warnings: unpublished ? [`${unpublished} voci non ancora pubblicate scartate`] : [] };
}
