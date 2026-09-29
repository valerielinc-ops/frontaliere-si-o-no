#!/usr/bin/env node
/**
 * Shared factory for Swiss employers using the Prospective.ch ATS.
 *
 * Prospective.ch (Aequivital AG, Zurich) is a Swiss-built HRIS used by many
 * hospitals, public administrations and large companies. Each tenant gets a
 * numeric `medium` ID and exposes a public JSON listing endpoint:
 *
 *   https://ohws.prospective.ch/public/v1/medium/{MEDIUM_ID}/jobs
 *     ?lang={de|fr|it|en}&offset=0&limit=100
 *
 * Response shape: { medium_id, total, jobs: [{ id, hk_id, viewkey, title,
 *   attributes, szas, links, start_date, last_modification_timestamp }] }
 *
 * Tenants identified so far in this codebase:
 *   - 1000745 — Kantonsspital Graubünden (KSGR)
 *   - 1002129 — Lindenhofgruppe Bern
 *   - (multiple, see ksgr/lindenhof parsers + USZ + Spital STS + Uster + UniSpital Basel)
 *
 * The pre-existing `lindenhofgruppe-job-parser.mjs` and `ksgr-job-parser.mjs`
 * predate this shared module; new Prospective-based crawlers should use this
 * factory.
 */
import { createHash } from 'node:crypto';
import { JSDOM, VirtualConsole } from 'jsdom';
import { detectLang, isLocationExplicitlyForeign } from './dedicated-crawler-common.mjs';
import { assertJsonListShape } from './assert-json-list-shape.mjs';
import { slugify, stripHtml, normalizeDescriptionBullets } from './crawler-template.mjs';
import { ALL_CANTON_CODES } from './crawler-location-config.mjs';
import {
  inferSwissTargetCanton,
  isKnownSwissMunicipality,
  isKnownSwissMunicipalityInCanton,
} from './target-swiss-locations.mjs';
import { fetchWithRetry, RETRYABLE_STATUS } from './transient-fetch.mjs';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

const PAGE_SIZE = 100;

function prospectiveSourceListingKey(listing = {}) {
  for (const value of [listing.id, listing.hk_id, listing.viewkey]) {
    const normalized = String(value ?? '').trim();
    if (normalized) return `id:${normalized}`;
  }
  const directLink = normalizeSpace(listing?.links?.directlink || '');
  return directLink ? `url:${directLink}` : '';
}

function normalize(s = '') {
  return String(s || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

async function fetchPage(apiUrl) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  return fetchWithRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(apiUrl, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} from ${apiUrl}`);
        err.status = res.status;
        err.retryable = RETRYABLE_STATUS.has(res.status);
        throw err;
      }
      try {
        return await res.json();
      } catch (parseErr) {
        const err = new Error(`Invalid JSON from ${apiUrl}: ${parseErr?.message || parseErr}`);
        err.retryable = true;
        err.cause = parseErr;
        throw err;
      }
    } finally {
      clearTimeout(timer);
    }
  }, { label: `prospective-ch ${apiUrl}` });
}

const SWISS_COUNTRY_LABEL_RE = /^(?:ch|che|schweiz|suisse|svizzera|svizra|switzerland)$/i;
// Some Prospective tenants put a street address in `sza_location.city`
// (UZH: "Kurvenstrasse 31"). An address is not a place: it is skipped before
// the foreign-country heuristics run, because a Swiss street can carry a
// country name ("Rue de France 12", "Via Italia", "Frankreichstrasse 5").
// Shape = a word followed by a house number, or a street word/suffix. A BFS
// municipality or alias is never an address ("Davos Platz", "Weggis").
const HOUSE_NUMBER_RE = /\p{L}[\p{L}.'’-]*\s+\d{1,4}[a-z]?(?:[/-]\d+[a-z]?)?(?=$|[\s,])/iu;
const STREET_WORD_RE = new RegExp(
  '(?:^|[\\s,])(?:rue|route|chemin|avenue|boulevard|place|quai|via|viale|piazza|strada|corso|'
  + 'strasse|straße|gasse|weg|platz|allee)(?=$|[\\s,.])'
  + '|\\p{L}(?:strasse|straße|str\\.|gasse|weg|platz|allee)(?=$|[\\s,.\\d])',
  'iu',
);

function isAddressShaped(candidate = '') {
  if (isKnownSwissMunicipality(candidate)) return false;
  return HOUSE_NUMBER_RE.test(candidate) || STREET_WORD_RE.test(candidate);
}

// An address candidate may still name its place in another comma segment
// ("Lengghalde 2, Zürich", Schulthess Klinik): keep those segments, drop the
// street ones and bare country/canton labels.
function placeSegments(candidate = '') {
  if (!isAddressShaped(candidate)) return [candidate];
  return candidate.split(',').map((part) => normalizeSpace(part)).filter((part) => (
    part
    && !SWISS_COUNTRY_LABEL_RE.test(part)
    && !ALL_CANTON_CODES.includes(part)
    && !isAddressShaped(part)
  ));
}

/**
 * Source-backed location candidates, in the historical priority order. There
 * is deliberately no `defaultCity` entry: a listing that names no place has no
 * geography, and the caller drops it instead of stamping the HQ city on it
 * (issue 9844 — Bühler's foreign sites were published as Uzwil/SG).
 */
function pickLocationCandidates(job) {
  const szas = job?.szas || {};
  const candidates = [];
  const cityRaw = String(szas['sza_location.city'] || '').trim();
  if (cityRaw) {
    const m = cityRaw.match(/\b(\d{4})(?:\s+|-(?=\p{L}))(\p{L}[^\n,]*)/u);
    candidates.push(normalizeSpace(m ? m[2] : cityRaw));
  }
  // Some Prospective tenants store the city under `sza_workplace.city` (a
  // plain city name without postal prefix) — newer schema, e.g. asana Spital AG.
  // UZH fills `sza_location.city` with the street ("Kurvenstrasse 31") and
  // keeps the city here, so it is also the next candidate when the first one
  // does not resolve to a canton.
  const workplaceCity = String(szas['sza_workplace.city'] || '').trim();
  if (workplaceCity) candidates.push(normalizeSpace(workplaceCity));
  // Some tenants (e.g. Stadt Bern, medium 1840) expose a flat `sza_location`
  // string "Street Number, ZIP City" instead of the dotted `sza_location.city`
  // key above — parse the trailing "ZIP City" segment when present, otherwise
  // the last comma segment that is neither a bare Swiss country label nor a
  // bare canton code ("Bern", "Murtenstrasse 98, Bern", "St. Niklaus, VS,
  // Schweiz").
  const flatLocation = String(szas['sza_location'] || '').trim();
  if (flatLocation) {
    const flatMatch = flatLocation.match(/\b\d{4}(?:\s+|-(?=\p{L}))(\p{L}[^\n,]*)$/u);
    if (flatMatch) {
      candidates.push(normalizeSpace(flatMatch[1]));
    } else {
      const segments = flatLocation.split(',').map((part) => normalizeSpace(part)).filter(Boolean);
      while (segments.length && (
        SWISS_COUNTRY_LABEL_RE.test(segments[segments.length - 1])
        || ALL_CANTON_CODES.includes(segments[segments.length - 1])
      )) segments.pop();
      if (segments.length) candidates.push(segments[segments.length - 1]);
    }
  }
  if (candidates.length) return [...new Set(candidates.filter(Boolean))];
  // Sometimes the site label is in attributes[10] (legacy fallback), consulted
  // only when the listing has no location field at all. Skip it when it's
  // clearly a department code (2-5 letter all-caps) rather than a city.
  const attr10 = Array.isArray(job?.attributes?.['10']) ? job.attributes['10'][0] : '';
  if (attr10) {
    const trimmed = normalizeSpace(attr10);
    if (trimmed && !/^[A-Z]{2,5}$/.test(trimmed)) return [trimmed];
  }
  return [];
}

function normalizeSiteKey(value = '') {
  return normalizeSpace(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// City-gated HQ fallback: only borrow the configured default ZIP/street when
// the resolved location TEXT actually matches the HQ city — canton-level
// matching is wrong, since it would re-stamp HQ street/ZIP onto any other
// city in the same canton. A listing without a source location never reaches
// this point (it is dropped), so an empty location is never the HQ.
function isHqCity(location, defaultCity) {
  if (!location || !defaultCity) return false;
  const escaped = String(defaultCity).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(location);
}

function pickPostalCode(job, defaultPostal, location, defaultCity) {
  const cityRaw = String(job?.szas?.['sza_location.city'] || '').trim();
  const m = cityRaw.match(/\b(\d{4})\b/);
  if (m) return m[1];
  // Newer schema: explicit workplace ZIP field.
  const workplaceZip = String(job?.szas?.['sza_workplace.zip'] || '').trim();
  const m2 = workplaceZip.match(/\b(\d{4})\b/);
  if (m2) return m2[1];
  // Some tenants expose a standalone `sza_location.zip` field instead of
  // embedding the ZIP in the city string (e.g. medium 1005736 workplace
  // records: `sza_location.city: 'Solothurn'`, `sza_location.zip: '4500'`).
  const locationZip = String(job?.szas?.['sza_location.zip'] || '').trim();
  const m3 = locationZip.match(/\b(\d{4})\b/);
  if (m3) return m3[1];
  // Some tenants (e.g. Stadt Bern, medium 1840) expose a flat `sza_location`
  // string "Street Number, ZIP City" instead of the dotted keys above.
  const flatLocation = String(job?.szas?.['sza_location'] || '').trim();
  const m4 = flatLocation.match(/\b(\d{4})(?:\s+|-(?=\p{L}))\p{L}[^\n,]*$/u);
  if (m4) return m4[1];
  return isHqCity(location, defaultCity) ? defaultPostal : '';
}

function pickStreetAddress(job, defaultStreet, location, defaultCity) {
  const szas = job?.szas || {};
  // Explicit street fields, tried before the free-text `sza_workplace` parse
  // below (e.g. Volksschule Luzern medium 1005619; Stadt Luzern medium
  // 1005002: `sza_location.street: 'Hirschengraben 17'`, confirmed live —
  // each listing carries its own real office street, distinct from the
  // `sza_workplace.zip`-style variant already handled in `pickPostalCode`).
  const explicitStreet = normalizeSpace(szas['sza_location.street'] || '');
  if (explicitStreet) return explicitStreet;
  const workplaceStreetField = normalizeSpace(szas['sza_workplace.street'] || '');
  if (workplaceStreetField) return workplaceStreetField;
  // `sza_workplace` is often a free-text "Label, Street Number, ZIP City"
  // triple (e.g. "Baloise Solothurn, Amthausplatz 4, 4500 Solothurn"). The
  // comma-segment containing a digit but not starting with a 4-digit ZIP
  // is the street address.
  const workplace = String(szas.sza_workplace || '').trim();
  if (workplace) {
    const parts = workplace.split(',').map((p) => p.trim()).filter(Boolean);
    const streetPart = parts.find((p) => /\d/.test(p) && !/^\d{4}\b/.test(p));
    if (streetPart) return streetPart;
  }
  // Some tenants (e.g. Stadt Bern, medium 1840) expose a flat `sza_location`
  // string "Street Number, ZIP City" — same comma-segment heuristic applies.
  const flatLocation = String(job?.szas?.sza_location || '').trim();
  if (flatLocation) {
    const flatParts = flatLocation.split(',').map((p) => p.trim()).filter(Boolean);
    const flatStreetPart = flatParts.find((p) => /\d/.test(p) && !/^\d{4}\b/.test(p));
    if (flatStreetPart) return flatStreetPart;
  }
  return isHqCity(location, defaultCity) ? defaultStreet : '';
}

function pickEmploymentType(job) {
  const min = Number(job?.szas?.['sza_pensum.min'] || 0);
  const max = Number(job?.szas?.['sza_pensum.max'] || 0);
  if (max > 0 && max < 90) return 'PART_TIME';
  if (min >= 90 || max >= 90) return 'FULL_TIME';
  return 'OTHER';
}

function buildDescription(job) {
  const szas = job?.szas || {};
  const parts = [];
  const intro = normalizeSpace(szas.sza_introduction || '');
  if (intro) parts.push(intro);
  const tasks = stripHtml(szas.sza_tasks || '');
  if (tasks) parts.push(`Aufgaben:\n${tasks}`);
  const reqs = stripHtml(szas.sza_requirements || '');
  if (reqs) parts.push(`Anforderungen:\n${reqs}`);
  const benefits = stripHtml(szas.sza_benefits || '');
  if (benefits) parts.push(`Wir bieten:\n${benefits}`);
  const profile = stripHtml(szas.sza_company_profil || '');
  if (profile) parts.push(profile);
  return normalizeDescriptionBullets(parts.join('\n\n'));
}

/* ── Detail page (directlink) ─────────────────────────────────
 *
 * The listing API is not the whole vacancy. Each tenant renders its
 * `links.directlink` page from a template that adds what the listing never
 * carries: `sza_benefits_2…6`, `sza_application`, fields the tenant keeps out
 * of the listing payload ("Benefits dieser Stelle", "Lohn", "Weiteres zur
 * Stelle", "Abteilungsbeschrieb") and the employer's own benefit/about blocks.
 * Measured on the 2026-09-29 audit: the listing-only description was 9-45 %
 * of the rendered vacancy on 25 tenants. The rendered page is therefore the
 * source of the description; the listing text stays the fallback and the
 * yardstick (the page must contain it, or it is not this vacancy's body).
 */

// Never vacancy text: markup, media, widgets and navigation.
const DETAIL_DROP_TAGS = new Set([
  'script', 'style', 'noscript', 'svg', 'template', 'iframe', 'form', 'button', 'select',
  'textarea', 'input', 'label', 'nav', 'footer', 'img', 'picture', 'video', 'audio',
  'canvas', 'object', 'embed', 'dialog', 'map', 'head', 'link', 'meta', 'title',
]);
const DETAIL_BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'dd', 'details', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'header', 'hr', 'li', 'main', 'ol', 'p', 'pre',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);
// Class/id vocabulary of page chrome shared by the Prospective templates:
// contact cards and forms, apply/share/job-alert widgets, "other vacancies"
// rails, sticky headers, maps, galleries and slider controls/clones.
const DETAIL_CHROME_TOKEN_RX = /cookie|consent|onetrust|share|social|breadcrumb|sticky|navbar|navigation|menu|burger|modal|popup|contact|kontakt|apply|bewerb|application|jobabo|job-abo|newsletter|subscribe|similar|related|other-?jobs|more-?jobs|weitere|joblist|job-list|footer|print-?only|duplicate|cloned|pagination|swiper-button|slick-arrow|slick-dots|slider-?control|lang-?switch|language-?switch|googlemap|google-map|opengoogle|jobmeta|job-meta/i;
// Media words only as a whole class token or a dash/underscore segment:
// `video`, `image-gallery`, `map` are widgets, `videoTextArea` (Livit's
// "about us" copy next to a video) is not.
const DETAIL_MEDIA_TOKEN_RX = /(?:^|[-_])(?:video|gallery|logo|map|maps)(?:$|[-_])/i;
// A link to a map service is a route/"open in Maps" button, whatever its label
// says in whatever language ("Auf Google Maps öffnen" on UPD, "Arbeitsweg
// berechnen" on asana/Lindenhof, "Prise en compte du temps de trajet" on
// Equans, "Grösser Karte anzeigen" on PBL): drop the element by its target,
// not by a growing list of labels. A link whose label is an address (it
// carries a postal code) is kept: there the link text is the workplace.
const DETAIL_MAP_HREF_RX = /^(?:https?:)?\/\/(?:[\w-]+\.)*(?:google\.[a-z.]+\/maps\b|maps\.google\.[a-z.]+|goo\.gl\/maps\b|maps\.app\.goo\.gl|map\.search\.ch|openstreetmap\.org|maps\.apple\.com|bing\.com\/maps\b)/i;
const DETAIL_HEADING_CLASS_RX = /title|heading|headline/i;
// A heading that opens a chrome section: everything up to the next heading
// is contact data, the application procedure or links to other vacancies.
const DETAIL_CHROME_HEADING_RX = /^(?:ihr[e]? )?(?:kontakt|kontaktperson|ansprechpartner|ansprechperson|contact|contacts|contatto|contatti|personne de contact|persona di contatto|your contact|ta personne de contact)\b|^(?:bei |haben sie |hast du )?fragen\b|^(?:vos |your |le tue |deine |ihre )?questions?\b|^(?:weitere|andere|ähnliche|aehnliche|offene|verwandte) (?:offene )?(?:stellen|jobs|stellenangebote|angebote)\b|^(?:autres?|d['’]autres) (?:postes|offres|emplois)\b|^altr[ie] (?:posti|offerte|lavori)\b|^(?:other|similar|more|related) (?:open )?(?:jobs|positions|vacancies|roles)\b|^(?:der |unser )?bewerbungs(?:prozess|ablauf|verfahren)\b|^so bewirbst du dich\b|^(?:the )?application process\b|^processus de (?:candidature|recrutement)\b|^(?:teilen|share|partager|condividi)\b|^folgen sie uns\b|^follow us\b|^job-?abo\b|^newsletter\b|^einblicke\b|^impressionen\b|^(?:dein|ihr|euer) nächster schritt\b|^nächste schritte\b|^(?:your )?next steps?\b|^(?:la |les )?prochaines? étapes?\b|^kontaktformular\b/i;
// Button/link labels rendered as their own line.
const DETAIL_UI_LINE_RX = /^(?:jetzt (?:online )?bewerben|online bewerben|bewerben|bewerbung starten|zur bewerbung|apply(?: now)?|postuler(?: maintenant)?|postulez(?: maintenant)?|candidati(?: ora)?|candidarsi|mehr (?:erfahren|anzeigen|informationen)|weitere informationen|en savoir plus|read more|learn more|scopri di più|weiterlesen|zurück(?: zur übersicht)?|retour|back|drucken|print|teilen|share|merken|schliessen|schließen|close|senden|envoyer|linkedin|xing|facebook|twitter|instagram|whatsapp|youtube|e-?mail|mail|top|zur stellenübersicht|alle stellen|folgen sie uns|follow us|suivez-nous|seguici|weiter zurück|zurück weiter|link zu mehr informationen|alle benefits|mehr benefits|rechtliche grundlagen|zum inhalt springen|skip to (?:main )?content|download pdf|pdf herunterladen)[.!]?$/i;

// Legal/footer links that survive as short lines (privacy notice, imprint).
const DETAIL_LEGAL_LINE_RX = /datenschutz|protection des données|privacy|protezione dei dati|impressum|mentions légales|suis-nous|folge uns|seguici su/i;
// Contact data of a named recruiter (phone number or e-mail address): not
// vacancy text, and the apply link already is the way to reach them.
const DETAIL_CONTACT_LINE_RX = /(?:\+|00)41[\s\d]{8,}|\b0\d{2}[\s/]\d{3}[\s]?\d{2}[\s]?\d{2}\b|[\w.+-]+@[\w-]+\.[a-z]{2,}/i;

function detailLineKey(text = '') {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function detailWordSet(text = '') {
  return new Set(detailLineKey(text).split(' ').filter((word) => word.length >= 4));
}

/**
 * Share of the listing description's words (≥4 letters) that the rendered
 * page text also contains. The rendered page of the same vacancy prints every
 * listing field; a low share means the fetch served something else (a
 * careercenter shell, a login wall, an expired-vacancy page).
 */
export function prospectiveDetailCoverage(detailText = '', listingText = '') {
  const listingWords = detailWordSet(listingText);
  if (!listingWords.size) return 0;
  const detailWords = detailWordSet(detailText);
  let covered = 0;
  for (const word of listingWords) if (detailWords.has(word)) covered += 1;
  return covered / listingWords.size;
}

/**
 * Vacancy text of a Prospective directlink page, as markdown-ish lines
 * (`## heading`, `• item`, paragraphs) in page order: chrome elements, chrome
 * sections, button labels, the title and repeated lines (slider clones,
 * front/back cards) removed.
 *
 * `listingText` is the listing-derived description of the same vacancy: an
 * element whose chrome-looking class wraps listing text is a content
 * container (some templates put the whole vacancy in `.jobContent-apply`) and
 * is walked, not dropped.
 *
 * @param {string} html
 * @param {{ title?: string, listingText?: string }} [opts]
 * @returns {string}
 */
export function extractProspectiveDetailText(html = '', { title = '', listingText = '' } = {}) {
  if (!html) return '';
  // A detached virtual console: tenant stylesheets jsdom cannot parse would
  // otherwise print one "Could not parse CSS stylesheet" per page.
  const dom = new JSDOM(String(html), { virtualConsole: new VirtualConsole() });
  try {
    const { document } = dom.window;
    const body = document.body;
    if (!body) return '';
    // Probes: a few listing sentences. An element containing one of them
    // holds vacancy content and is never dropped as chrome.
    const probes = String(listingText || '').split(/\n+/)
      .map((line) => detailLineKey(line.replace(/^[•\-*]\s*/, '')))
      .filter((key) => key.length >= 40)
      .map((key) => key.slice(0, 60))
      .slice(0, 60);
    const holdsListingText = (el) => {
      if (!probes.length) return false;
      const key = detailLineKey(el.textContent || '');
      return probes.some((probe) => key.includes(probe));
    };
    const isChromeElement = (el) => {
      const tokens = `${el.getAttribute('class') || ''} ${el.getAttribute('id') || ''}`.split(/\s+/).filter(Boolean);
      if (tokens.some((token) => DETAIL_CHROME_TOKEN_RX.test(token) || DETAIL_MEDIA_TOKEN_RX.test(token))) return true;
      if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
      return /display\s*:\s*none/i.test(el.getAttribute('style') || '');
    };
    const hasBlockDescendant = (el) => [...el.querySelectorAll('*')]
      .some((child) => DETAIL_BLOCK_TAGS.has(child.tagName.toLowerCase()) && child.tagName.toLowerCase() !== 'br');

    const lines = [];
    let buffer = '';
    let bufferKind = 'text';
    const flush = () => {
      // Some templates print the card colour before the card text
      // (jobs.admin.ch: `<p>#F7B4B8<span>Arbeiten für die Schweiz</span>…`).
      const text = normalizeSpace(buffer).replace(/^#[0-9a-f]{6}(?=\S)/i, '');
      if (text) lines.push({ kind: bufferKind, text });
      buffer = '';
      bufferKind = 'text';
    };
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) { buffer += child.textContent; continue; }
        if (child.nodeType !== 1) continue;
        const tag = child.tagName.toLowerCase();
        if (DETAIL_DROP_TAGS.has(tag)) continue;
        if (isChromeElement(child) && !holdsListingText(child)) continue;
        // A map link labelled with the address itself (SWICA: `<a href=
        // "…google.com/maps…">Zürcherstrasse 31, 8401 Winterthur</a>`) is the
        // workplace, not a button: only label-only links (no postal code) go.
        if (tag === 'a' && DETAIL_MAP_HREF_RX.test(String(child.getAttribute('href') || '').trim())
          && !/\b\d{4}\b/.test(child.textContent || '')) continue;
        if (tag === 'br') {
          // A line break inside a list item continues the same item.
          if (bufferKind === 'item') buffer += ' ';
          else flush();
          continue;
        }
        const headingByClass = DETAIL_HEADING_CLASS_RX.test(child.getAttribute('class') || '')
          && normalizeSpace(child.textContent).length <= 80
          && !hasBlockDescendant(child);
        if (/^h[1-6]$/.test(tag) || headingByClass) {
          flush();
          const text = normalizeSpace(child.textContent);
          if (text) lines.push({ kind: tag === 'h1' ? 'title' : 'heading', text });
          continue;
        }
        if (tag === 'li') {
          flush();
          bufferKind = 'item';
          walk(child);
          flush();
          continue;
        }
        if (DETAIL_BLOCK_TAGS.has(tag)) {
          flush();
          walk(child);
          flush();
          continue;
        }
        walk(child);
      }
    };
    walk(body);
    flush();

    const titleKey = detailLineKey(title);
    const out = [];
    const seen = new Set();
    let skippingChromeSection = false;
    for (const line of lines) {
      const key = detailLineKey(line.text);
      if (!key) continue;
      if (line.kind === 'title' || line.kind === 'heading') {
        skippingChromeSection = DETAIL_CHROME_HEADING_RX.test(normalizeSpace(line.text));
        if (skippingChromeSection || line.kind === 'title') continue;
      }
      if (skippingChromeSection) continue;
      if (DETAIL_UI_LINE_RX.test(line.text)) continue;
      if (line.text.length <= 90 && DETAIL_LEGAL_LINE_RX.test(line.text)) continue;
      if (line.text.length <= 250 && DETAIL_CONTACT_LINE_RX.test(line.text)) continue;
      // The vacancy title (alone or followed by the pensum) is not body text.
      if (titleKey && (key === titleKey || (key.startsWith(titleKey) && key.length <= titleKey.length + 12))) continue;
      if (line.kind === 'heading') {
        // Flip cards and tab headers print the same label twice in a row.
        const previous = out[out.length - 1];
        if (previous?.kind === 'heading' && detailLineKey(previous.text) === key) continue;
        out.push(line);
        continue;
      }
      // Body text repeated by slider clones, print copies and card backs.
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
    // In a run of headings with no body between them only the last one heads
    // a section; the others are hero/fact labels (department, place, start
    // date) and read as plain lines.
    const kept = out.map((line, index) => (
      line.kind === 'heading' && out[index + 1]?.kind === 'heading'
        ? { kind: 'text', text: line.text }
        : line
    ));
    // Headings that end the page have no body: leftover labels.
    while (kept.length && kept[kept.length - 1].kind === 'heading') kept.pop();
    // A label heading over a single short value is a fact row, not a section:
    // "Arbeitsort" + "Zürich" reads as "Arbeitsort: Zürich".
    const merged = [];
    for (let index = 0; index < kept.length; index += 1) {
      const line = kept[index];
      const value = kept[index + 1];
      const after = kept[index + 2];
      if (line.kind === 'heading' && value && value.kind === 'text' && value.text.length <= 60
        && (!after || after.kind === 'heading')) {
        // A heading repeated as its own value (PBL prints the address as a
        // heading and again under it) is one line, not "X: X".
        const label = line.text.replace(/[:：]\s*$/, '');
        merged.push({
          kind: 'text',
          text: detailLineKey(label) === detailLineKey(value.text) ? value.text : `${label}: ${value.text}`,
        });
        index += 1;
        continue;
      }
      merged.push(line);
    }
    const text = merged.map((line, index) => {
      if (line.kind === 'heading') return `${index ? '\n' : ''}## ${line.text}`;
      if (line.kind === 'item') return `• ${line.text}`;
      return line.text;
    }).join('\n');
    return text;
  } finally {
    dom.window.close();
  }
}

// Below this share of the listing words the fetched page is not this
// vacancy's body (careercenter shell, login wall, another tenant's page).
// Measured 2026-09-29 on ~90 rendered vacancies of 40 tenants: a vacancy's own
// page covers 0.56-1.00 of its listing text (the low end = listing fields the
// template does not print, e.g. PDAG's `sza_benefits`, or listing noise such
// as Spital Bülach's icon file names); a page of another tenant covers at
// most 0.34. Gone vacancies answer 404/410 and never reach this check.
export const PROSPECTIVE_DETAIL_MIN_COVERAGE = 0.5;
const DETAIL_GONE_STATUS = new Set([404, 410]);

/**
 * The rendered vacancy text of `html` when it can replace the listing text,
 * else `{ text: '', reason }`: it must contain the listing text (coverage)
 * and not be shorter than it.
 *
 * Coverage is also the language check: a page rendered in another language
 * than the listing shares almost none of its words. The page language itself
 * is not compared — a tenant can print a German body inside an English
 * template (PwC "Your Team"/"Your Benefits" around German vacancy text,
 * 26/153 vacancies on 2026-09-29), and that page is the vacancy as published.
 *
 * @param {string} html  detail page already fetched by the caller
 * @param {{ title?: string, listingText?: string }} opts
 * @returns {{ text: string, reason: string }}
 */
export function selectProspectiveDetailDescription(html, { title = '', listingText = '' } = {}) {
  let text = '';
  try {
    text = extractProspectiveDetailText(html, { title, listingText });
  } catch {
    return { text: '', reason: 'extract-failed' };
  }
  if (!text || prospectiveDetailCoverage(text, listingText) < PROSPECTIVE_DETAIL_MIN_COVERAGE) {
    return { text: '', reason: 'not-this-vacancy' };
  }
  if (stripHtml(text).length < stripHtml(listingText).length) return { text: '', reason: 'shorter-than-listing' };
  return { text, reason: '' };
}

/**
 * The part of `fetch` the detail reader uses (tests pass a stub).
 * @typedef {(url: string, init?: object) => Promise<{ ok: boolean, status: number, url?: string,
 *   headers?: { get: (name: string) => string | null }, text: () => Promise<string> }>} DetailFetch
 */

/**
 * @param {string} url
 * @param {{ fetchImpl?: DetailFetch, timeoutMs?: number }} [opts]
 */
async function fetchDetailHtml(url, { fetchImpl = fetch, timeoutMs } = {}) {
  const limit = timeoutMs || Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  return fetchWithRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limit);
    try {
      const res = await fetchImpl(url, {
        headers: { Accept: 'text/html', 'User-Agent': USER_AGENT },
        redirect: 'follow',
        signal: controller.signal,
      });
      if (DETAIL_GONE_STATUS.has(res.status)) return { status: res.status, url: res.url || url, html: '' };
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} from ${url}`);
        err.status = res.status;
        err.retryable = RETRYABLE_STATUS.has(res.status);
        throw err;
      }
      // Only a declared HTML document is a rendered vacancy. A JSON or
      // plain-text answer (API error body, proxy page) can echo the listing
      // text and pass the coverage check, and so can an answer that declares
      // no type at all: fail closed before reading the body.
      const type = String(res.headers?.get?.('content-type') || '');
      if (!/\bhtml\b/i.test(type)) return { status: res.status, url: res.url || url, html: '', notHtml: true };
      return { status: res.status, url: res.url || url, html: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  }, { label: `prospective-ch detail ${url}` });
}

/**
 * Replace each job's listing-derived description with the vacancy text of its
 * rendered detail page (`job.url`, the Prospective directlink). The listing
 * text stays in place — never a job dropped — when the page cannot be read,
 * is not on a trusted host, is gone, or does not contain the listing text
 * (coverage below {@link PROSPECTIVE_DETAIL_MIN_COVERAGE}).
 *
 * @param {object[]} jobs  crawler jobs ({ url, title, description, descriptionByLocale, sourceLang })
 * @param {{ isTrustedDomain?: (url: string) => boolean, label?: string, concurrency?: number,
 *   delayMs?: number, fetchImpl?: DetailFetch }} [opts]
 * @returns {Promise<{ used: number, fallback: Record<string, number>, pageDescribed: Set<object> }>}
 */
export async function enrichProspectiveJobsFromDetailPages(jobs, {
  isTrustedDomain = () => true,
  label = 'prospective',
  concurrency = 3,
  delayMs = 250,
  fetchImpl = fetch,
} = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  const fallback = {};
  const pageDescribed = new Set();
  let used = 0;
  const miss = (reason) => { fallback[reason] = (fallback[reason] || 0) + 1; };
  const pageByUrl = new Map();
  let cursor = 0;
  const worker = async () => {
    while (cursor < list.length) {
      const job = list[cursor];
      cursor += 1;
      const url = String(job?.url || '');
      if (!/^https:\/\//i.test(url) || !isTrustedDomain(url)) { miss('untrusted-url'); continue; }
      let page;
      try {
        // One vacancy can back several records (PwC explodes a multi-city
        // listing per city): its page is fetched once.
        if (!pageByUrl.has(url)) {
          pageByUrl.set(url, fetchDetailHtml(url, { fetchImpl }).finally(
            () => (delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, delayMs)) : null),
          ));
        }
        page = await pageByUrl.get(url);
      } catch {
        miss('fetch-failed');
        continue;
      }
      if (!page.html) { miss(page.notHtml ? 'not-html' : `http-${page.status}`); continue; }
      if (page.url !== url && !isTrustedDomain(page.url)) { miss('untrusted-redirect'); continue; }
      const sourceLang = job.sourceLang || 'de';
      const listingText = job.descriptionByLocale?.[sourceLang] || job.description || '';
      const { text, reason } = selectProspectiveDetailDescription(page.html, {
        title: job.title,
        listingText,
      });
      if (!text) { miss(reason); continue; }
      // Runners that seed every locale with the source text until
      // translation fills them (Agroscope, PwC) keep that seed consistent.
      const byLocale = { ...(job.descriptionByLocale || {}) };
      for (const [locale, value] of Object.entries(byLocale)) {
        if (value === listingText) byLocale[locale] = text;
      }
      byLocale[sourceLang] = text;
      job.description = text;
      job.descriptionByLocale = byLocale;
      pageDescribed.add(job);
      used += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, worker));
  const fallbackSummary = Object.entries(fallback).map(([reason, count]) => `${count} ${reason}`).join(', ');
  console.log(`  📄 ${label}: ${used}/${list.length} descriptions from the rendered vacancy page${fallbackSummary ? ` (listing text kept: ${fallbackSummary})` : ''}`);
  return { used, fallback, pageDescribed };
}

// `fallbackCategory` lets non-healthcare tenants (e.g. a hospitality
// employer reusing this hospital-oriented factory) override the
// last-resort bucket for titles that don't match any keyword below.
// Defaults to the historical literal so every pre-existing call site
// (all hospital/insurance/finance consumers) is byte-identical.
function detectCategory(title = '', dept = '', fallbackCategory = 'Sanità / Ospedali') {
  const t = normalize(`${title} ${dept}`);
  if (/\b(pflege|pflegefach|stationsleitung|fage|spitex|nachtwache|geburts|hebamme)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(arzt|ärztin|oberarzt|chefarzt|leitend|medizin|chirurg|anästhes|onkolog|kardiolog|neurolog|pädiatr|gynäk|psychi|geriatr)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(labor|laborant|biomedizin|analyse|radiolog|röntgen|mtra|mrt|physiother|ergo|logopäd|rehabilit|apothek|pharma)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(praxisassistent|mpa|mfa)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(techni|haustechni|facility|wartung|maintenance)/.test(t)) return 'Tecnica';
  if (/\b(it|software|develop|programm|system|informatik)/.test(t)) return 'IT';
  if (/\b(admin|sekret|buchhalt|sachbearbeiter|finanz|controll|account)/.test(t)) return 'Amministrazione';
  if (/\b(hr|human|personal|talent|recruit)/.test(t)) return 'Risorse Umane';
  if (/\b(küche|koch|gastro|hauswirtschaft|reinigung|hotellerie)/.test(t)) return 'Ospitalità';
  if (/\b(logist|magazz|lager|einkauf|transport)/.test(t)) return 'Logistica';
  if (/\b(market|kommunik)/.test(t)) return 'Marketing';
  if (/\b(lernend|praktik|ausbildung|apprenti|werkstudent)/.test(t)) return 'Formazione';
  return fallbackCategory;
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|lehrling|lernend|apprenti)/.test(t)) return 'intern';
  if (/\b(junior|jr|assistent)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|chef|verantwort|leiter|leitend|stationsleitung|oberarzt|chefarzt)/.test(t)) return 'senior';
  return 'mid';
}

/**
 * The same vacancy published twice under two listing ids: identical title,
 * workplace and full rendered vacancy text, requisition number and bare
 * dates aside (a posting per headcount, or a re-post the tenant never
 * withdrew). A seeker
 * sees one vacancy, so the later copy is dropped.
 *
 * Only jobs in `pageDescribed` (description read from the rendered page) are
 * compared. A listing-derived text is not the whole vacancy and can hide what
 * tells two postings apart: GZ Dielsdorf's two "Fachperson Gesundheit EFZ"
 * share the listing text but one is "Befristet", the other "Unbefristet";
 * Lindenhof's two "Dipl. Pflegefachfrau/-mann FH/HF" differ by a "Gut zu
 * wissen" section the listing omits.
 *
 * @param {object[]} jobs
 * @param {string} [label]
 * @param {{ pageDescribed?: Set<object> }} [opts]
 * @returns {object[]}
 */
// Posting metadata, not vacancy content: a requisition/reference number or a
// bare date line (publication or start date). BKW publishes one "Lehrstelle
// Montage-Elektriker:in EFZ" per apprentice place in Thun, identical but for
// "Referenznummer A-2205668 / A-2205540"; Raiffeisen Egnach re-published its
// "Mitarbeiter Kreditadministration" on 11.09.2026 without withdrawing the
// 07.08.2026 copy (only the `.date` line differs).
const REQUISITION_LINE_RX = /^(?:[•\-*]\s*)?(?:referenz(?:nummer|-?nr\.?)|referenznr\.?|numéro de référence|numero di riferimento|reference(?: number| no\.?)?|ref\.?(?: no\.?| nr\.?)?|job-?id|stellen-?id|id)\s*[:#]?\s*[\w$./-]+$/i;
const BARE_DATE_LINE_RX = /^(?:[•\-*]\s*)?\d{1,2}\.\s?\d{1,2}\.\s?\d{2,4}$/;

function repostKeyText(description = '') {
  return String(description || '').split('\n')
    .filter((line) => !REQUISITION_LINE_RX.test(line.trim()) && !BARE_DATE_LINE_RX.test(line.trim()))
    .join('\n');
}

export function dropRepostedListings(jobs, label = 'prospective', { pageDescribed = new Set() } = {}) {
  const seen = new Set();
  const unique = [];
  let dropped = 0;
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!pageDescribed.has(job)) { unique.push(job); continue; }
    const key = [
      detailLineKey(job?.title),
      detailLineKey(job?.location),
      detailLineKey(job?.postalCode),
      detailLineKey(job?.streetAddress),
      detailLineKey(repostKeyText(job?.description)),
    ].join('||');
    if (seen.has(key)) { dropped += 1; continue; }
    seen.add(key);
    unique.push(job);
  }
  if (dropped > 0) console.log(`  ⏭️  ${label}: dropped ${dropped} re-posted listings (same title, workplace and rendered vacancy text)`);
  return unique;
}

/**
 * Create a Prospective.ch parser for one employer.
 *
 * @param {Object} config
 * @param {string} config.companyKey
 * @param {string} config.companyName
 * @param {string} config.companyDomain
 * @param {string|number} config.mediumId    Prospective tenant ID
 * @param {string} config.defaultCanton  HQ canton. It is NOT a fallback for a
 *   listing whose location is absent, foreign or unresolved — those listings
 *   are dropped (counted in `locationSkipped`, issue 9844). It is read only
 *   by `allSitesInDefaultCanton` below.
 * @param {string} config.defaultCity  HQ city. Used only to gate the HQ
 *   postal/street fallback when the listing's own city IS the HQ city; never
 *   substituted for a missing source location.
 * @param {string} config.defaultPostalCode
 * @param {boolean} [config.allSitesInDefaultCanton=false]  Declares that every
 *   workplace of this employer lies in `defaultCanton` by construction (a
 *   cantonal or municipal administration, never a multi-site group). It only
 *   disambiguates a source locality that is a BFS municipality of
 *   `defaultCanton` but that canton inference leaves unresolved because the
 *   name also exists elsewhere (`Oberwil`, BL/ZG). It never assigns a canton to
 *   an absent, explicitly foreign or non-municipality location.
 * @param {boolean} [config.singleLocality=false]  Declares that every
 *   workplace of this employer is in `defaultCity`/`defaultCanton` by
 *   construction (e.g. SPITEX BASEL, a home-care service for the city of
 *   Basel only). A listing whose source location is absent or does not
 *   resolve is then placed there instead of being dropped; an explicitly
 *   foreign location is still dropped. Never set it on a multi-site employer:
 *   that is exactly the HQ fallback this factory refuses by default.
 * @param {Record<string, string>} [config.siteCantons]  Verified sites of this
 *   employer that the BFS municipality registry cannot resolve on its own:
 *   sub-municipal localities (`Valens`, part of Pfäfers SG) or cross-canton
 *   homonyms whose canton the source proves (`Wald`, ZIP 8636 → ZH). Keys are
 *   matched against the whole source locality (case/diacritics-insensitive);
 *   values are canton codes. Never consulted for a location the source omits.
 * @param {string} [config.defaultStreetAddress] HQ street, used ONLY as a
 *   city-gated fallback (resolved location matches defaultCity) when a
 *   listing's own `sza_workplace` has no parseable street segment.
 * @param {string} [config.apiLang='de']     Listing language
 * @param {string} [config.publicCareerUrl]
 * @param {string} [config.defaultSourceLang='de']
 * @param {boolean} [config.strictPagination=false]  Fail on partial or
 *   undeclared source totals instead of returning a partial result.
 * @param {(listing: object) => {location: string, canton: string, valid?: boolean}} [config.locationResolver]
 *   Resolve and validate a source-backed location for multi-site employers.
 *   When supplied, no default city or canton is used.
 * @param {(canton: string, location: string, listing: object) => string} [config.postalCodeFallback]
 *   Return a safe canton-level postal fallback when the source omits a ZIP.
 * @param {string[]} [config.extraTrustedHosts]  Additional hosts to mark as trusted
 * @param {string[]} [config.acceptDirectlinkHosts]  Only ingest listings whose
 *   `links.directlink` hostname matches one of these. Use for shared Prospective
 *   tenants that mix multiple employers (e.g. medium 1008606 serves both PZM
 *   Münsingen and UPD Bern). Default: no filtering.
 * @param {boolean} [config.sharedMedium=false]  Set true when this `mediumId`
 *   is intentionally split across multiple companyKeys (discriminated via
 *   `filterListing` at fetch time, e.g. Baloise/Helvetia on medium 1005736).
 *   Disables the bare `/medium/{id}/` URL fallback in `isCompanyJob`, which
 *   would otherwise match jobs belonging to the *other* company sharing the
 *   tenant — that fallback is only safe when one company owns the medium.
 * @param {string} [config.sector='Sanità / Ospedali']  Override the sector
 *   label. All Prospective tenants onboarded so far are hospitals/clinics, so
 *   this defaults to healthcare; non-healthcare tenants (e.g. a school
 *   district) should pass their own sector.
 * @param {boolean} [config.detailPageDescription=false]  Read each vacancy's
 *   description from its rendered directlink page instead of the listing
 *   payload (see {@link enrichProspectiveJobsFromDetailPages}). Set it on a
 *   tenant whose template prints vacancy sections the listing API does not
 *   carry — measured, not assumed: the 2026-09-29 audit found the listing
 *   text at 9-45 % of the rendered vacancy on those tenants. The listing text
 *   remains the per-job fallback.
 * @param {(title: string, department: string) => string} [config.categoryFn]
 *   Override the per-job category classifier. Defaults to the shared
 *   healthcare-biased `detectCategory()` (its unmatched-role fallback is
 *   'Sanità / Ospedali', wrong for a non-healthcare tenant). Non-healthcare
 *   tenants with a single fixed category (e.g. a school district or municipal
 *   administration) can pass a constant-returning function.
 */
export function createProspectiveChParser(config) {
  const {
    companyKey,
    companyName,
    companyDomain,
    mediumId,
    apiLang = 'de',
    defaultCanton,
    defaultCity,
    defaultPostalCode,
    allSitesInDefaultCanton = false,
    singleLocality = false,
    siteCantons = {},
    defaultStreetAddress = '',
    publicCareerUrl,
    defaultSourceLang = 'de',
    strictPagination = false,
    locationResolver,
    postalCodeFallback,
    extraTrustedHosts = [],
    acceptDirectlinkHosts = [],
    sharedMedium = false,
    filterListing,
    // Both default to the historical hardcoded literal so every pre-existing
    // consumer (hospitals, insurers, finance — see file header) is
    // unaffected. Only a genuinely different-industry tenant (e.g. a
    // hospitality employer or municipal administration) needs to pass these.
    sector = 'Sanità / Ospedali',
    categoryFn = detectCategory,
    detailPageDescription = false,
  } = config;

  if (!companyKey || !companyName || !mediumId || (!defaultCanton && typeof locationResolver !== 'function')) {
    throw new Error('createProspectiveChParser: missing required config');
  }
  if ((allSitesInDefaultCanton || singleLocality) && !ALL_CANTON_CODES.includes(String(defaultCanton || '').toUpperCase())) {
    throw new Error(`createProspectiveChParser: allSitesInDefaultCanton/singleLocality need a Swiss canton code, got ${defaultCanton}`);
  }
  if (singleLocality && !normalizeSpace(defaultCity)) {
    throw new Error('createProspectiveChParser: singleLocality needs defaultCity');
  }
  const siteCantonByKey = new Map();
  for (const [site, code] of Object.entries(siteCantons || {})) {
    const canton = String(code || '').trim().toUpperCase();
    if (!normalizeSiteKey(site) || !ALL_CANTON_CODES.includes(canton)) {
      throw new Error(`createProspectiveChParser: invalid siteCantons entry ${site} → ${code}`);
    }
    siteCantonByKey.set(normalizeSiteKey(site), canton);
  }

  // Default branch (no `locationResolver`): the first source candidate that
  // resolves to a Swiss canton wins. Address-shaped candidates are never
  // classified; only their non-street comma segments are tried. An explicitly
  // foreign candidate does not decide on its
  // own: it drops the listing only when no later candidate proves a Swiss
  // place. When nothing resolves — absent location, or a place no rule can
  // prove Swiss — the listing is dropped: unknown geography stays fail-closed
  // and never inherits the HQ canton (owner rule, issue 9844). The only
  // exception is a tenant that declares `singleLocality`, and never for a
  // listing that named a foreign place.
  function resolveSourceLocation(listing) {
    let foreignSeen = false;
    for (const candidate of pickLocationCandidates(listing).flatMap(placeSegments)) {
      if (isLocationExplicitlyForeign(candidate)) {
        foreignSeen = true;
        continue;
      }
      const canton = siteCantonByKey.get(normalizeSiteKey(candidate))
        || inferSwissTargetCanton(candidate)
        || (allSitesInDefaultCanton && isKnownSwissMunicipalityInCanton(candidate, defaultCanton)
          ? String(defaultCanton).toUpperCase()
          : '');
      if (canton) return { location: candidate, canton };
    }
    if (foreignSeen) return null;
    if (singleLocality) {
      return { location: normalizeSpace(defaultCity), canton: String(defaultCanton).toUpperCase() };
    }
    return null;
  }

  const API_BASE = `https://ohws.prospective.ch/public/v1/medium/${mediumId}/jobs`;
  const corporateHost = String(companyDomain || '').replace(/^www\./, '').toLowerCase();
  const trustedHosts = new Set([
    corporateHost,
    ...extraTrustedHosts.map((h) => String(h).toLowerCase()),
  ].filter(Boolean));
  const directlinkHostAllowlist = new Set(
    (acceptDirectlinkHosts || []).map((h) => String(h).toLowerCase().replace(/^www\./, '')),
  );

  function isCompanyJob(job) {
    if (!job) return false;
    const key = normalize(job?.companyKey || '');
    const company = normalize(job?.company || '');
    const url = normalize(job?.url || '');
    if (key === companyKey) return true;
    // Match on display name verbatim or on the corporate-host basename
    // appearing inside the company string (same fuzzy rule the sibling
    // factories use, so `{ company: 'X' }` shapes are recognised).
    if (company && companyName && company === normalize(companyName)) return true;
    if (corporateHost && company && company.includes(corporateHost.split('.')[0])) return true;
    if (corporateHost && url.includes(corporateHost)) return true;
    if (!sharedMedium && url.includes(`/medium/${mediumId}/`)) return true;
    return false;
  }

  function isTrustedDomain(rawUrl = '') {
    try {
      const host = new URL(rawUrl).hostname.toLowerCase();
      if (trustedHosts.has(host)) return true;
      if (corporateHost && host.endsWith(`.${corporateHost}`)) return true;
      if (host === 'ohws.prospective.ch') {
        // Accept both tenant-scoped (/medium/{ID}/) and job-direct (/public/v1/jobs/{viewkey})
        // formats. The API returns the job-direct shape when a tenant has no
        // custom job-page URL configured (e.g. GZ Dielsdorf medium 1005824).
        if (rawUrl.includes(`/medium/${mediumId}/`)) return true;
        if (rawUrl.includes('/public/v1/jobs/')) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async function fetchAllJobs() {
    console.log(`🏥 Fetching ${companyName} jobs`);
    console.log(`   API: ${API_BASE} (Prospective medium ${mediumId})`);
    if (publicCareerUrl) console.log(`   Public: ${publicCareerUrl}`);
    console.log();

    const all = [];
    const seenSourceKeys = new Set();
    let offset = 0;
    let total = Infinity;
    let declaredTotal = null;
    while (offset < total) {
      const url = `${API_BASE}?lang=${apiLang}&offset=${offset}&limit=${PAGE_SIZE}`;
      console.log(`  📄 offset=${offset}…`);
      let data;
      try {
        data = await fetchPage(url);
      } catch (err) {
        if (strictPagination) {
          throw new Error(`Prospective ${companyName} pagination failed at offset=${offset}: ${err && err.message || err}`);
        }
        // Graceful degradation for the historical single-site consumers:
        // when their upstream is offline, preserve the established []/partial
        // result contract rather than crashing the cron workflow.
        console.warn(`  ⚠️  Prospective fetch failed at offset=${offset}: ${err && err.message || err}. Returning ${all.length} jobs collected so far.`);
        break;
      }
      const items = assertJsonListShape(data, { key: 'jobs', source: companyName, lang: apiLang });
      const pageTotal = Number(data?.total);
      const hasValidTotal = Number.isSafeInteger(pageTotal) && pageTotal >= 0;
      if (hasValidTotal) {
        if (declaredTotal !== null && pageTotal !== declaredTotal && strictPagination) {
          throw new Error(`Prospective ${companyName} source total changed during pagination: ${declaredTotal} → ${pageTotal}`);
        }
        declaredTotal = pageTotal;
        total = pageTotal;
      } else if (strictPagination) {
        throw new Error(`Prospective ${companyName} source did not declare a finite total at offset=${offset}`);
      }
      if (items.length === 0) {
        if (strictPagination && seenSourceKeys.size !== total) {
          throw new Error(`Prospective ${companyName} pagination incomplete: fetched ${seenSourceKeys.size}/${total} unique listings`);
        }
        break;
      }
      const pageNewItems = [];
      for (const [index, item] of items.entries()) {
        const key = prospectiveSourceListingKey(item);
        if (!key) {
          if (strictPagination) {
            throw new Error(
              `Prospective ${companyName} listing at offset=${offset}, row=${index} has no stable identity; pagination completeness is unverified`,
            );
          }
          pageNewItems.push(item);
          continue;
        }
        if (seenSourceKeys.has(key)) continue;
        seenSourceKeys.add(key);
        pageNewItems.push(item);
      }
      const added = pageNewItems.length;
      if (strictPagination && added === 0) {
        throw new Error(
          `Prospective ${companyName} pagination did not advance at offset=${offset}; repeated page has ${seenSourceKeys.size} unique listings`,
        );
      }
      all.push(...(strictPagination ? pageNewItems : items));
      offset += items.length;
      if (strictPagination && seenSourceKeys.size > total) {
        throw new Error(`Prospective ${companyName} pagination exceeded declared total: fetched ${seenSourceKeys.size}/${total} unique listings`);
      }
      if (items.length < PAGE_SIZE) {
        if (strictPagination && seenSourceKeys.size !== total) {
          throw new Error(`Prospective ${companyName} pagination incomplete: fetched ${seenSourceKeys.size}/${total} unique listings`);
        }
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (strictPagination && (declaredTotal === null || seenSourceKeys.size !== declaredTotal)) {
      throw new Error(`Prospective ${companyName} pagination incomplete: fetched ${seenSourceKeys.size}/${declaredTotal ?? 'unknown'} unique listings`);
    }
    console.log(`  ✓ ${all.length} Prospective jobs (API total=${total})\n`);
    if (!all.length) return [];

    const jobs = [];
    let directlinkSkipped = 0;
    let attributeSkipped = 0;
    let locationSkipped = 0;
    for (const listing of all) {
      const szas = listing?.szas || {};
      const title = normalizeSpace(szas.sza_title || listing.title || '');
      if (!title || title.length < 3) continue;

      // Caller-supplied predicate for shared tenants where the discriminator
      // is an attribute bucket (e.g. medium 1003280 tags KSNW vs LUKS via
      // attributes['40']). Returning false drops the listing.
      if (typeof filterListing === 'function') {
        let keep = true;
        try { keep = !!filterListing(listing); } catch { keep = false; }
        if (!keep) { attributeSkipped += 1; continue; }
      }

      // Multi-employer Prospective tenant filter: when configured, drop
      // listings whose directlink hostname doesn't match the allowlist.
      // This is for shared tenants like 1008606 (PZM Münsingen + UPD Bern).
      if (directlinkHostAllowlist.size > 0) {
        const dl = normalizeSpace(listing?.links?.directlink || '');
        if (dl) {
          try {
            const dlHost = new URL(dl).hostname.toLowerCase().replace(/^www\./, '');
            if (!directlinkHostAllowlist.has(dlHost)) {
              directlinkSkipped += 1;
              continue;
            }
          } catch {
            // Malformed URL — treat as not matching, skip.
            directlinkSkipped += 1;
            continue;
          }
        }
      }

      const directLink = normalizeSpace(listing?.links?.directlink || '');
      // `sza_apply_link` is meant to hold an absolute external apply URL
      // (confirmed real on e.g. VZ VermögensZentrum, medium 1003550), but
      // at least one tenant (Grand Resort Bad Ragaz, medium 1004484)
      // mis-maps it to a bare internal numeric reference ("1693") instead
      // of a URL. Guard with a shape check so a malformed value never
      // gets stamped as `applyUrl` — falls through to the real `directLink`
      // instead, same as the empty-field case already handled below.
      const rawApplyLink = normalizeSpace(szas.sza_apply_link || '');
      const applyLink = /^https?:\/\//i.test(rawApplyLink) ? rawApplyLink : '';
      const publicUrl = directLink || applyLink || publicCareerUrl || API_BASE;

      let location;
      let canton;
      if (typeof locationResolver === 'function') {
        let resolution;
        try { resolution = locationResolver(listing); } catch { resolution = null; }
        if (!resolution || resolution.valid === false || !resolution.location || !resolution.canton) {
          locationSkipped += 1;
          continue;
        }
        location = normalizeSpace(resolution.location);
        canton = String(resolution.canton || '').trim().toUpperCase();
      } else {
        const resolved = resolveSourceLocation(listing);
        if (!resolved) {
          locationSkipped += 1;
          continue;
        }
        ({ location, canton } = resolved);
      }
      const descriptionText = buildDescription(listing);
      const sourceLang = detectLang(descriptionText || title, defaultSourceLang);
      const jobSlug = slugify(`${title} ${companyKey} ${location}`);
      const urlHash = createHash('sha1').update(publicUrl).digest('hex').slice(0, 12);

      const postedDate = (() => {
        const raw = listing?.start_date || listing?.last_modification_timestamp || '';
        const d = new Date(String(raw || ''));
        if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
        return new Date().toISOString().slice(0, 10);
      })();

      const department = normalizeSpace(
        (Array.isArray(listing?.attributes?.['20']) ? listing.attributes['20'][0] : '')
          || szas.sza_company_branch || '',
      );

      jobs.push({
        id: `${companyKey}-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: companyName,
        companyKey,
        companyDomain,
        title,
        titleByLocale: { [sourceLang]: title },
        description: descriptionText || `${title} — ${companyName}`,
        descriptionByLocale: { [sourceLang]: descriptionText || `${title} — ${companyName}` },
        // Newly-discovered jobs ship with source-locale-only fields. The shared
        // AI-localization step clears this flag when it fills the remaining 3
        // locales; if it can't (cache miss + AI quota), the flag stays and
        // `translate-pending.yml` picks the job up out-of-band. Without this
        // flag the locale-completeness gate trips before translation can run.
        needsRetranslation: true,
        location,
        canton,
        url: publicUrl,
        source: `${companyName} Dedicated Parser (Prospective medium ${mediumId})`,
        sourceLang,
        crawledAt: new Date().toISOString(),

        addressLocality: location,
        addressRegion: canton,
        addressCountry: 'CH',
        country: 'CH',
        postalCode: pickPostalCode(listing, defaultPostalCode, location, defaultCity)
          || (typeof postalCodeFallback === 'function' ? postalCodeFallback(canton, location, listing) : ''),
        streetAddress: pickStreetAddress(listing, defaultStreetAddress, location, defaultCity),
        category: categoryFn(title, department),
        contract: 'full-time',
        employmentType: pickEmploymentType(listing),
        experienceLevel: detectExperienceLevel(title),
        sector,
        currency: 'CHF',
        featured: false,
        postedDate,
        applyUrl: applyLink || publicUrl,
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
      });
    }

    if (directlinkSkipped > 0) {
      console.log(`  ⏭️  Filtered out ${directlinkSkipped} listings (directlink host not in allowlist)`);
    }
    if (attributeSkipped > 0) {
      console.log(`  ⏭️  Filtered out ${attributeSkipped} listings (filterListing predicate)`);
    }
    if (locationSkipped > 0) {
      console.log(`  ⏭️  Filtered out ${locationSkipped} listings (unresolved/non-Swiss source location)`);
    }
    let pageDescribed = new Set();
    if (detailPageDescription && jobs.length) {
      ({ pageDescribed } = await enrichProspectiveJobsFromDetailPages(jobs, { isTrustedDomain, label: companyName }));
    }
    const unique = dropRepostedListings(jobs, companyName, { pageDescribed });
    console.log(`📋 Total ${companyName} jobs discovered: ${unique.length}`);
    return unique;
  }

  return { fetchAllJobs, isCompanyJob, isTrustedDomain };
}
