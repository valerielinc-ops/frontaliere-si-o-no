/**
 * Dove i Comuni ticinesi pubblicano i concorsi: gli adapter della famiglia.
 *
 *  - `assolo`: 59 Comuni su 100 usano il CMS ASSOLO. L'albo e' un form
 *    `fric_<id>` con filtro di categoria e ricerca testuale, entrambi in GET.
 *    La skin cambia da Comune a Comune (`ogg_liste_data`, `ObjListData`,
 *    `ItemAlbo`): il parser si aggancia alla struttura del documento, non alle
 *    classi. La categoria da sola non basta: Blenio tiene il concorso per la
 *    direzione fuori da «Concorsi», e lo trova solo la ricerca testuale.
 *  - `page`: una pagina dedicata con i link ai bandi (WordPress, Webflow,
 *    Squarespace...), letta dal contenitore che il registro dichiara.
 *  - `rendered-cityos`: Chiasso costruisce l'elenco lato client. Lo legge un
 *    browser vero, come qualunque visitatore; il token del frontend non si
 *    riusa: e' dato al sito, non a noi.
 *
 * Ogni parser dice anche se ha riconosciuto la pagina: una pagina
 * irriconoscibile non e' un albo vuoto, e la differenza decide se i posti gia'
 * pubblicati vengono ritirati (vedi authoritative-empty-snapshot.mjs).
 */
import { JSDOM } from 'jsdom';

import { normalizeSpace, parseMunicipalDate } from './ticino-comuni-job-parser.mjs';

export const ASSOLO_TEXT_QUERY = 'concorso';
export const MAX_ASSOLO_PAGES = 5;

const ITALIAN_MONTHS = [
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
];
const ROW_DATE_RE = new RegExp(
  `(?<![\\d.])(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4}|\\d{2})(?![\\d.])|\\b(\\d{1,2})\\s+(${ITALIAN_MONTHS.join('|')})\\s+(\\d{4})\\b`,
  'i',
);
const ASSOLO_EMPTY_RE = /nessun\s+(?:documento|concorso)|documenti(?:\s+presenti)?\s*:\s*0\b|\b0\s+documenti\b/i;
const DOCUMENT_HREF_RE = /(?:\?|&)i=1(?:&|$)|downdoc\.php|\.pdf(?:[?#]|$)/i;
const ASSOLO_ITEM_HREF_RE = /-[0-9a-f]{8}(?:\?|$)/i;
const NAVIGATION_HREF_RE = /catinv=|ris_pg=|^javascript:|^mailto:|^tel:/i;
const GENERIC_ANCHOR_RE = /^(?:leggi(?:\s+(?:tutto|di\s+piu))?|scarica|download|apri|dettagli|\.\.\.)$/i;

function rowDate(text = '') {
  const match = ROW_DATE_RE.exec(text);
  if (!match) return '';
  if (match[5]) {
    const month = ITALIAN_MONTHS.indexOf(match[5].toLowerCase()) + 1;
    return parseMunicipalDate(`${match[4]}.${month}.${match[6]}`);
  }
  return parseMunicipalDate(`${match[1]}.${match[2]}.${match[3]}`);
}

/** Il testo di un nodo con gli elementi separati: «21.10.26» e «98 kB» non si fondono. */
function spacedText(node) {
  return normalizeSpace(String(node?.innerHTML || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' '));
}

/** La data della riga: risale dal link al primo antenato che ne porta una. */
function dateAround(anchor, stopAt, title) {
  let node = anchor;
  for (let depth = 0; depth < 7 && node && node !== stopAt; depth += 1) {
    node = node.parentElement;
    if (!node) break;
    const text = spacedText(node);
    if (text.length > title.length + 260) break;
    const date = rowDate(text.replace(title, ' '));
    if (date) return date;
  }
  return '';
}

/** La skin «a scheda» mette il titolo in un h3 e un link vuoto sopra la scheda. */
function cardTitle(anchor) {
  const card = anchor.closest('.ItemDoc, [class*="ItemAlbo"], [class*="ItemNews"]');
  return normalizeSpace(card?.querySelector('h1, h2, h3, h4')?.textContent);
}

function anchorRows(container, baseUrl, isDocument) {
  const rows = new Map();
  for (const anchor of container.querySelectorAll('a[href]')) {
    const href = String(anchor.getAttribute('href') || '').trim();
    if (!href || NAVIGATION_HREF_RE.test(href) || !isDocument(href, anchor)) continue;
    const text = normalizeSpace(anchor.textContent);
    const title = text && !GENERIC_ANCHOR_RE.test(text) ? text : cardTitle(anchor);
    if (!title) continue;
    let url;
    try {
      url = new URL(href, baseUrl).href;
    } catch {
      continue;
    }
    if (!rows.has(url)) rows.set(url, { title, url, date: dateAround(anchor, container, title) });
  }
  return [...rows.values()];
}

/**
 * L'URL GET di una vista dell'albo: la categoria «Concorsi» oppure la ricerca.
 * Le skin con il menu di categoria usano `catinv`, quelle col filtro `param_catN`.
 * @param {{ url: string, fric: string|number, catParam?: string, catId?: string|number, catinv?: string|number }} listing
 * @param {{ text?: string, page?: number, category?: boolean }} view
 */
export function assoloListingUrl(listing, { text = '', page = 1, category = false } = {}) {
  const url = new URL(listing.url);
  url.search = '';
  const params = url.searchParams;
  params.set('fric', String(listing.fric));
  params.set('ris_pg', String(page));
  params.set('param_textsearch', text);
  for (let index = 0; index < 5; index += 1) params.set(`param_cat${index}`, '0');
  if (category && listing.catParam) params.set(listing.catParam, String(listing.catId));
  if (category && listing.catinv) params.set('catinv', String(listing.catinv));
  for (const name of ['param_data', 'param_data1', 'param_data2']) params.set(name, '0000-00-00');
  params.set('param_parint', '0');
  return url.href;
}

/**
 * @param {string} html
 * @param {{ baseUrl: string, fric: string|number, catParam?: string, catId?: string|number, text?: string }} view
 * @returns {{ recognized: boolean, empty: boolean, rows: {title: string, url: string, date: string}[], hasNextPage: boolean, reason?: string }}
 */
export function parseAssoloListing(html, view) {
  const dom = new JSDOM(String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ''));
  try {
    const { document } = dom.window;
    const form = document.querySelector(`form[name="fric_${view.fric}"]`);
    if (!form) {
      return { recognized: false, empty: false, rows: [], hasNextPage: false, reason: `form fric_${view.fric} assente` };
    }
    let filterConfirmed = false;
    if (view.catParam) {
      // Un filtro ignorato restituirebbe l'albo intero, e una categoria sparita
      // sembrerebbe un albo vuoto: la selezione deve essere quella chiesta.
      const name = `fric_${view.fric}_cat${view.catParam.replace('param_cat', '')}`;
      const select = form.querySelector(`select[name="${name}"]`);
      const selected = select?.querySelector('option[selected]')?.getAttribute('value');
      if (select && String(selected) !== String(view.catId)) {
        return { recognized: false, empty: false, rows: [], hasNextPage: false, reason: `categoria ${view.catId} non selezionata` };
      }
      filterConfirmed = Boolean(select);
    }
    const rows = anchorRows(form, view.baseUrl, (href, anchor) => (
      DOCUMENT_HREF_RE.test(href) || (ASSOLO_ITEM_HREF_RE.test(href) && Boolean(cardTitle(anchor)))
    ));
    const hasNextPage = [...form.querySelectorAll('a[href]')]
      .some((anchor) => new RegExp(`[?&]ris_pg=${(view.page || 1) + 1}(?:&|$)`).test(anchor.getAttribute('href') || ''));
    // Alcune skin non scrivono niente quando la categoria e' vuota (Faido): il
    // form con la categoria chiesta gia' selezionata e' la prova.
    const empty = rows.length === 0 && (filterConfirmed || ASSOLO_EMPTY_RE.test(spacedText(form)));
    if (rows.length === 0 && !empty) {
      return { recognized: false, empty: false, rows, hasNextPage: false, reason: 'nessuna riga e nessun marcatore di albo vuoto' };
    }
    return { recognized: true, empty, rows, hasNextPage };
  } finally {
    dom.window.close();
  }
}

/**
 * @param {string} html
 * @param {{ baseUrl: string, containerSelector: string, marker?: string }} view
 */
export function parseDedicatedPage(html, view) {
  const dom = new JSDOM(String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ''));
  try {
    const container = dom.window.document.querySelector(view.containerSelector);
    if (!container) {
      return { recognized: false, empty: false, rows: [], hasNextPage: false, reason: `contenitore ${view.containerSelector} assente` };
    }
    const marker = view.marker ? String(view.marker).toLowerCase() : '';
    if (marker && !normalizeSpace(dom.window.document.body?.textContent).toLowerCase().includes(marker)) {
      return { recognized: false, empty: false, rows: [], hasNextPage: false, reason: `marcatore "${view.marker}" assente` };
    }
    const rows = anchorRows(container, view.baseUrl, (href) => DOCUMENT_HREF_RE.test(href));
    return { recognized: true, empty: rows.length === 0, rows, hasNextPage: false };
  } finally {
    dom.window.close();
  }
}

const CITYOS_LIST_SELECTOR = '#dataSmartAppConcorsi';
/** Attesa del browser: basta un link che possa essere un PDF, lo decide isPdfHref. */
const CITYOS_DETAIL_SELECTOR = 'main a[href*=".pdf" i]';

/** Un link a un PDF: conta il percorso, non il maiuscolo ne' la query string. */
export function isPdfHref(href, baseUrl) {
  try {
    return new URL(href, baseUrl).pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}

/** @param {string} html pagina gia' renderizzata @param {{ baseUrl: string }} view */
export function parseCityOsList(html, view) {
  const dom = new JSDOM(String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ''));
  try {
    const list = dom.window.document.querySelector(CITYOS_LIST_SELECTOR);
    if (!list || list.classList.contains('loading')) {
      return { recognized: false, empty: false, rows: [], hasNextPage: false, reason: 'elenco non renderizzato' };
    }
    const rows = [...list.querySelectorAll('.news-item')].map((item) => {
      const href = item.querySelector('a[href]')?.getAttribute('href') || '';
      return {
        title: normalizeSpace(item.querySelector('h3')?.textContent),
        date: parseMunicipalDate(normalizeSpace(item.querySelector('.news-date')?.textContent).replaceAll('/', '.')),
        url: href ? new URL(href, view.baseUrl).href : '',
      };
    }).filter((row) => row.title && row.url);
    return { recognized: true, empty: rows.length === 0, rows, hasNextPage: false };
  } finally {
    dom.window.close();
  }
}

/** I PDF allegati a una scheda di concorso. */
export function parseCityOsDetail(html, view) {
  const dom = new JSDOM(String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ''));
  try {
    const main = dom.window.document.querySelector('main') || dom.window.document.body;
    return [...main.querySelectorAll('a[href]')]
      .filter((anchor) => isPdfHref(anchor.getAttribute('href'), view.baseUrl))
      .map((anchor) => ({
        title: normalizeSpace(anchor.textContent).replace(/\.pdf$/i, ''),
        url: new URL(anchor.getAttribute('href'), view.baseUrl).href,
      }));
  } finally {
    dom.window.close();
  }
}

export { CITYOS_DETAIL_SELECTOR, CITYOS_LIST_SELECTOR };
