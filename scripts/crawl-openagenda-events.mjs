#!/usr/bin/env node
/**
 * Crawler — OpenAgenda API v2 (Ginevra e Nyon).
 *
 * Tre agende pubbliche lette con la API documentata
 * (`GET https://api.openagenda.com/v2/agendas/{uid}/events`):
 *   - Ville de Genève (17821345);
 *   - Association des communes genevoises, ACG (52853891);
 *   - Région de Nyon (31848826).
 *
 * Licenza: le CGU di OpenAgenda rendono gli annunci pubblici riutilizzabili
 * «conformément aux termes de la licence ouverte», cioè la Licence Ouverte 2.0
 * (Etalab): uso commerciale, modifica e traduzione ammessi a due condizioni,
 * entrambe rispettate a valle di questo file:
 *   1. fonte e data dell'ultimo aggiornamento sempre indicate — ogni record
 *      porta `sourceAgenda` e `sourceUpdatedAt`, che la pagina evento rende
 *      come «Fonte: OpenAgenda — <agenda>, aggiornato il <data>» col link;
 *   2. nessun avallo né carattere ufficiale suggerito — niente loghi, niente
 *      formule del Concédant, solo il nome della fonte.
 *
 * Chiave: `OPENAGENDA_PUBLIC_KEY` (chiave pubblica `oa_pk_`, creata dal
 * proprietario su openagenda.com/settings/apiKey e caricata da Remote Config
 * con scripts/load-rc-env.mjs). Va nell'header `key`, mai in query: la
 * documentazione lo sconsiglia perché la query finisce nei log. Senza chiave
 * il passo stampa un `::notice::`, esce 0 e NON tocca lo slice: i dispatch con
 * `dry_run` non caricano Remote Config, e prima che il proprietario crei la
 * chiave l'assenza è uno stato atteso, non un guasto.
 *
 * Campi mai scritti: `location.email`, `location.phone`, i recapiti di
 * `registration` e `conditions` (testo libero, al massimo 255 caratteri, mai
 * un prezzo). Il mapping legge campi nominati, quindi un campo nuovo della API
 * non entra nello slice per caso.
 *
 * Prezzo (regola H5: solo un campo strutturato, con la fonte nel dato): SOLO
 * il booleano `gratuit` dell'ACG, e solo quando vale `true`, diventa
 * `{ amount: 0, isFree: true, priceSource: 'openagenda', priceField: 'gratuit' }`.
 * Lo pubblica soltanto `hasConfidentPrice()`, cioè quando il registro
 * `EVENT_PRICE_SOURCES`/`STRUCTURED_EVENT_PRICE_FIELDS` di events-utils.mjs
 * ammette quella coppia: finché non la ammette il dato resta nello slice e la
 * pagina non mostra nessun prezzo.
 *
 * Immagini: la guida immagini di OpenAgenda ricorda che le agende sono
 * esportabili in licenza aperta e che chi pubblica deve avere i diritti per
 * una diffusione libera, ma il modulo della Ville accetta il credito «DR»
 * (droits réservés: 18 crediti su 100 nella Ville, 13 nell'ACG). Un'immagine
 * si specchia quindi solo se l'agenda ha una licenza dichiarata qui
 * (`license`) e il credito esiste e non riserva i diritti; altrimenti
 * nessuna immagine, mai il link remoto (no hotlink).
 *
 * Usage:
 *   node scripts/crawl-openagenda-events.mjs            # crawl + merge nello slice
 *   node scripts/crawl-openagenda-events.mjs --dry-run  # crawl senza scrivere
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  EVENT_SOURCES,
  EVENTS_SLICE_DIR,
  cleanEventText,
  eventStableId,
  loadCantonComuni,
  mirrorEventImage,
  normalizeText,
  resolveComuneNationwide,
} from './lib/events-utils.mjs';
import { fillEventPeopleDefaults } from './lib/event-metadata.mjs';
import { mergeEventsIntoSlice } from './lib/crawl-checkpoint.mjs';

const SOURCE = EVENT_SOURCES.openagenda;
export const OPENAGENDA_API_BASE = 'https://api.openagenda.com/v2';
export const OPENAGENDA_LICENSE = 'Licence Ouverte 2.0';
export const MISSING_KEY_NOTICE =
  "::notice::OPENAGENDA_PUBLIC_KEY assente: il proprietario deve creare l'account e la chiave";

/**
 * Agende lette, nell'ordine in cui un evento condiviso (stesso `uid` in più
 * agende) prende la sua agenda d'origine. `readsGratuit`: solo l'ACG espone il
 * campo aggiuntivo `gratuit` come booleano.
 */
export const OPENAGENDA_AGENDAS = Object.freeze([
  Object.freeze({ uid: 17821345, slug: 'ville-de-geneve', title: 'Ville de Genève', cantonHint: 'GE', license: OPENAGENDA_LICENSE, readsGratuit: false }),
  Object.freeze({ uid: 52853891, slug: 'geneve-communes', title: 'Association des communes genevoises', cantonHint: 'GE', license: OPENAGENDA_LICENSE, readsGratuit: true }),
  Object.freeze({ uid: 31848826, slug: 'region-nyon', title: 'Région de Nyon', cantonHint: 'VD', license: OPENAGENDA_LICENSE, readsGratuit: false }),
]);

// Massimo della API (`size`): con 300 eventi per pagina le ~2.600 schede
// correnti o future delle tre agende stanno in una decina di richieste.
export const PAGE_SIZE = 300;
// Tetto di sicurezza per agenda: 40 × 300 = 12.000 eventi, ben sopra i ~1.300
// dell'agenda più grande. Un cursore che non si chiude non gira all'infinito.
const MAX_PAGES_PER_AGENDA = 40;
const DEFAULT_HORIZON_DAYS = 365;
const POLITE_DELAY_MS = 2000;
const FETCH_TIMEOUT_MS = 30000;
const USER_AGENT = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch)';
const LOCALES = ['it', 'en', 'de', 'fr'];
// `attendanceMode` 2 = solo online: senza un luogo la pagina evento non ha
// comune né mappa, e non è un evento «a Ginevra».
const ATTENDANCE_ONLINE_ONLY = 2;
// `status` della API: 1 programmato, 2 riprogrammato, 3 spostato online,
// 4 rinviato, 5 completo, 6 annullato.
const STATUS_TO_EVENT_STATUS = Object.freeze({ 4: 'postponed', 6: 'cancelled' });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Credito che riserva i diritti («DR», «droits réservés», «all rights reserved»…). */
const RIGHTS_RESERVED_RE = /^(?:©\s*)?d\s*\.?\s*r\s*\.?$|droits?\s+r[ée]serv[ée]s?|all\s+rights\s+reserved|alle\s+rechte\s+vorbehalten|tutti\s+i\s+diritti\s+riservati/iu;

/**
 * Un'immagine è riusabile solo se l'agenda ha una licenza dichiarata e il
 * credito esiste e non riserva i diritti. Un credito vuoto non dice chi ha i
 * diritti, quindi non basta.
 */
export function isReusableImageCredit(credit, agenda) {
  if (!agenda?.license) return false;
  if (typeof credit !== 'string') return false;
  const trimmed = credit.replace(/\s+/g, ' ').trim();
  if (!trimmed) return false;
  return !RIGHTS_RESERVED_RE.test(trimmed);
}

/** URL della variante `base` (700 px di larghezza) di un'immagine OpenAgenda. */
export function openAgendaImageUrl(image) {
  if (!image || typeof image.filename !== 'string' || !image.filename) return undefined;
  const base = typeof image.base === 'string' && /^https:\/\//i.test(image.base) ? image.base : undefined;
  if (!base) return undefined;
  return `${base.endsWith('/') ? base : `${base}/`}${image.filename}`;
}

/** Query della lista eventi: correnti e futuri, entro l'orizzonte, cursore `after`. */
export function buildEventsUrl(agendaUid, { after, horizonIso, size = PAGE_SIZE } = {}) {
  const url = new URL(`${OPENAGENDA_API_BASE}/agendas/${agendaUid}/events`);
  url.searchParams.append('relative[]', 'current');
  url.searchParams.append('relative[]', 'upcoming');
  if (horizonIso) url.searchParams.append('timings[lte]', horizonIso);
  url.searchParams.append('size', String(size));
  url.searchParams.append('detailed', '1');
  url.searchParams.append('includeLabels', '1');
  for (const value of Array.isArray(after) ? after : []) {
    url.searchParams.append('after[]', String(value));
  }
  return url.toString();
}

function localizedMap(value) {
  if (!value || typeof value !== 'object') return {};
  const out = {};
  for (const locale of LOCALES) {
    const text = cleanEventText(value[locale]);
    if (text) out[locale] = text;
  }
  return out;
}

function firstText(value, preferred = 'fr') {
  if (typeof value === 'string') return cleanEventText(value);
  if (!value || typeof value !== 'object') return '';
  const direct = cleanEventText(value[preferred]);
  if (direct) return direct;
  for (const candidate of Object.values(value)) {
    const text = cleanEventText(candidate);
    if (text) return text;
  }
  return '';
}

const localPartsCache = new Map();
function localFormatter(timeZone) {
  if (!localPartsCache.has(timeZone)) {
    localPartsCache.set(timeZone, new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }));
  }
  return localPartsCache.get(timeZone);
}

/** `{ date: 'YYYY-MM-DD', time: 'HH:MM' }` di un istante, nel fuso dell'evento. */
export function localDateTime(isoInstant, timeZone = 'Europe/Zurich') {
  const instant = new Date(isoInstant);
  if (Number.isNaN(instant.getTime())) return null;
  let parts;
  try {
    parts = localFormatter(timeZone).formatToParts(instant);
  } catch {
    parts = localFormatter('Europe/Zurich').formatToParts(instant);
  }
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

/**
 * Date dell'evento dalle sue `timings`, nel fuso dell'evento: inizio della
 * PRIMA fascia e fine dell'ULTIMA. Il primo inizio resta fisso da un run
 * all'altro (lo slug della pagina contiene `startDate`, e un inizio che
 * avanzasse ogni giorno cambierebbe URL ogni giorno) ed è la stessa
 * convenzione «Du X au Y» del crawler HTML ge-agenda, che la deduplica in
 * assemble confronta per titolo, data e luogo.
 */
export function eventDatesFromTimings(timings, timeZone) {
  const valid = (Array.isArray(timings) ? timings : [])
    .filter((timing) => timing && !Number.isNaN(Date.parse(timing.begin)))
    .sort((a, b) => Date.parse(a.begin) - Date.parse(b.begin));
  if (!valid.length) return null;
  const first = localDateTime(valid[0].begin, timeZone);
  const lastEnd = valid.reduce((latest, timing) => {
    const end = Date.parse(timing.end);
    const value = Number.isNaN(end) ? Date.parse(timing.begin) : end;
    return value > latest ? value : latest;
  }, Date.parse(valid[0].begin));
  const last = localDateTime(new Date(lastEnd).toISOString(), timeZone);
  if (!first || !last) return null;
  const days = new Set(valid.map((timing) => localDateTime(timing.begin, timeZone)?.date).filter(Boolean));
  return {
    startDate: first.date,
    startTime: first.time,
    endDate: last.date > first.date ? last.date : undefined,
    recurring: days.size > 1,
  };
}

/** Via senza la coda «, 1208 Genève» quando il CAP è già un campo a sé. */
function streetFromAddress(address) {
  const text = cleanEventText(address);
  if (!text) return undefined;
  const stripped = text.replace(/,?\s*\b\d{4}\s+[^,\d][^,]*$/u, '').trim();
  return stripped || text;
}

function finiteNumber(value) {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function choiceLabel(value) {
  const entry = Array.isArray(value) ? value[0] : value;
  if (!entry || typeof entry !== 'object') return undefined;
  return firstText(entry.label) || undefined;
}

function httpsUrl(value) {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Pagina pubblica dell'evento su OpenAgenda (il link dell'attribuzione). */
export function openAgendaEventUrl(agenda, raw) {
  if (typeof raw?.slug === 'string' && raw.slug) {
    return `https://openagenda.com/fr/${agenda.slug}/events/${encodeURIComponent(raw.slug)}`;
  }
  return `https://openagenda.com/agendas/${agenda.uid}/events/${raw.uid}`;
}

/**
 * `location.city` is the municipality field of the API, so an exact name
 * match within the agenda's canton is the strongest signal. The official
 * list disambiguates homonyms with a canton suffix ("Carouge (GE)"), which
 * the word-boundary matcher of resolveComuneNationwide never matches against
 * a bare "Carouge": compare without the suffix, in the hinted canton only.
 */
function comuneByCityName(city, cantonHint) {
  if (!city || !cantonHint) return undefined;
  const wanted = normalizeText(city);
  return loadCantonComuni(cantonHint).find((name) => normalizeText(name.replace(/\s*\([A-Z]{2}\)$/, '')) === wanted);
}

function resolveVenueComune(location, agenda) {
  const city = cleanEventText(location?.city || location?.adminLevel4);
  const exactCity = comuneByCityName(city, agenda.cantonHint);
  if (exactCity) return { comune: exactCity, canton: agenda.cantonHint, method: 'exact' };
  if (city) {
    const byCity = resolveComuneNationwide({ venue: city, title: '', region: '' }, agenda.cantonHint);
    if (byCity.comune) return byCity;
  }
  const byVenue = resolveComuneNationwide({ venue: cleanEventText(location?.name), title: '', region: '' }, agenda.cantonHint);
  return byVenue.comune ? byVenue : { comune: null, canton: null, method: null };
}

/**
 * Un evento della API → record evento dello slice (stessi campi di guidle e
 * MySwitzerland). Restituisce `null` per un evento senza titolo, senza date o
 * solo online. Pura: nessuna rete, nessun file.
 */
export function mapOpenAgendaEvent(raw, agenda) {
  if (!raw || raw.uid === undefined || raw.uid === null) return null;
  if (raw.attendanceMode === ATTENDANCE_ONLINE_ONLY) return null;
  const titleByLocale = localizedMap(raw.title);
  const title = firstText(raw.title);
  if (!title) return null;
  const timeZone = typeof raw.timezone === 'string' && raw.timezone ? raw.timezone : 'Europe/Zurich';
  const dates = eventDatesFromTimings(raw.timings, timeZone);
  if (!dates) return null;

  const descriptionByLocale = localizedMap(raw.description);
  const description = firstText(raw.description) || undefined;
  const location = raw.location && typeof raw.location === 'object' ? raw.location : {};
  const venue = cleanEventText(location.name) || undefined;
  const city = cleanEventText(location.city || location.adminLevel4) || undefined;
  const postalCode = cleanEventText(location.postalCode) || undefined;
  const street = streetFromAddress(location.address);
  const lat = finiteNumber(location.latitude);
  const lng = finiteNumber(location.longitude);
  const { comune, canton, method } = resolveVenueComune(location, agenda);

  const credit = typeof raw.imageCredits === 'string' ? raw.imageCredits.replace(/\s+/g, ' ').trim() : '';
  const imageSourceUrl = isReusableImageCredit(credit, agenda) ? openAgendaImageUrl(raw.image) : undefined;

  const organizerName = cleanEventText(raw.organisator);
  const organizerUrl = httpsUrl(raw.organisator_url);
  const eventStatus = STATUS_TO_EVENT_STATUS[raw.status];

  const record = {
    id: eventStableId(SOURCE.key, raw.uid),
    title,
    ...(Object.keys(titleByLocale).length ? { titleByLocale } : {}),
    ...(description ? { description } : {}),
    ...(Object.keys(descriptionByLocale).length ? { descriptionByLocale } : {}),
    startDate: dates.startDate,
    ...(dates.endDate ? { endDate: dates.endDate } : {}),
    startTime: dates.startTime,
    ...(choiceLabel(raw['type-devenement']) ? { category: choiceLabel(raw['type-devenement']) } : {}),
    ...(venue ? { venue } : {}),
    ...(city ? { region: city } : {}),
    ...(comune ? { comune, comuneMatch: method } : {}),
    ...(comune && canton ? { canton } : {}),
    url: openAgendaEventUrl(agenda, raw),
    ...(street || postalCode || city
      ? { address: { ...(street ? { street } : {}), ...(postalCode ? { postalCode } : {}), ...(city ? { locality: city } : {}) } }
      : {}),
    ...(lat !== undefined && lng !== undefined ? { geo: { lat, lng } } : {}),
    ...(dates.recurring ? { recurring: true } : {}),
    ...(eventStatus ? { eventStatus } : {}),
    ...(organizerName
      ? { organizer: { '@type': 'Organization', name: organizerName, ...(organizerUrl ? { url: organizerUrl } : {}) } }
      : {}),
    ...(imageSourceUrl ? { imageUrl: imageSourceUrl, imageCredit: credit } : {}),
    sourceAgenda: agenda.title,
    sourceAgendaUid: agenda.uid,
    ...(typeof raw.updatedAt === 'string' && !Number.isNaN(Date.parse(raw.updatedAt))
      ? { sourceUpdatedAt: raw.updatedAt }
      : {}),
  };
  if (agenda.readsGratuit && raw.gratuit === true) {
    record.price = { amount: 0, currency: 'CHF', isFree: true, priceSource: 'openagenda', priceField: 'gratuit' };
  }
  return record;
}

async function fetchJson(url, key, fetchImpl) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, {
        headers: { key, Accept: 'application/json', 'User-Agent': USER_AGENT },
        signal: controller.signal,
      });
      if (res.ok) return await res.json();
      lastError = new Error(`HTTP ${res.status}`);
      // 4xx diverso da 429 (403 = chiave rifiutata) non migliora riprovando.
      if (res.status !== 429 && res.status < 500) break;
    } catch (err) {
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
    await sleep(POLITE_DELAY_MS);
  }
  throw lastError || new Error('richiesta fallita');
}

/**
 * Legge un'agenda seguendo il cursore `after` fino a `after: null`, a una
 * pagina vuota o al tetto di sicurezza. Restituisce gli eventi grezzi e il
 * `total` dichiarato dalla API.
 */
export async function fetchAgendaEvents(agenda, { key, fetchImpl = fetch, horizonIso, delayMs = POLITE_DELAY_MS, maxPages = MAX_PAGES_PER_AGENDA } = {}) {
  const events = [];
  let after;
  let total;
  let pages = 0;
  for (; pages < maxPages; pages += 1) {
    if (pages > 0) await sleep(delayMs);
    const body = await fetchJson(buildEventsUrl(agenda.uid, { after, horizonIso }), key, fetchImpl);
    if (typeof body?.total === 'number') total = body.total;
    const batch = Array.isArray(body?.events) ? body.events : [];
    events.push(...batch);
    if (!batch.length || !Array.isArray(body?.after) || body.after.length === 0) {
      pages += 1;
      break;
    }
    after = body.after;
  }
  return { events, total, pages };
}

/**
 * Esegue il crawl completo. Non scrive mai lo slice senza chiave, in dry-run
 * o con zero eventi: lo slice è un archivio append-only (mergeEventsIntoSlice
 * non cancella), quindi un run vuoto non deve nemmeno toccarne la data.
 */
export async function crawlOpenAgenda({
  key = process.env.OPENAGENDA_PUBLIC_KEY,
  agendas = OPENAGENDA_AGENDAS,
  fetchImpl = fetch,
  now = new Date(),
  horizonDays = DEFAULT_HORIZON_DAYS,
  sliceDir = EVENTS_SLICE_DIR,
  dryRun = false,
  delayMs = POLITE_DELAY_MS,
  mirrorImage = mirrorEventImage,
  log = console,
} = {}) {
  if (!key || !String(key).trim()) {
    log.log(MISSING_KEY_NOTICE);
    return { status: 'no-key', events: [], written: false, failures: [], perAgenda: [] };
  }
  const crawledAt = now.toISOString();
  const horizonIso = new Date(now.getTime() + horizonDays * 86400000).toISOString();
  const byId = new Map();
  const failures = [];
  const perAgenda = [];

  for (const [index, agenda] of agendas.entries()) {
    if (index > 0) await sleep(delayMs);
    let fetched;
    try {
      fetched = await fetchAgendaEvents(agenda, { key: String(key).trim(), fetchImpl, horizonIso, delayMs });
    } catch (err) {
      failures.push(agenda.uid);
      log.error(`[openagenda] agenda ${agenda.uid} (${agenda.title}): ${err?.message || err}`);
      continue;
    }
    let mapped = 0;
    for (const raw of fetched.events) {
      const record = mapOpenAgendaEvent(raw, agenda);
      if (!record) continue;
      mapped += 1;
      const existing = byId.get(record.id);
      if (!existing) {
        byId.set(record.id, record);
      } else if (!existing.price && record.price) {
        // Stesso evento aggregato in due agende: l'agenda d'origine resta la
        // prima, il booleano `gratuit` arriva solo dall'ACG.
        byId.set(record.id, { ...existing, price: record.price });
      }
    }
    // Riga di soli conteggi, per confronto col `total` dichiarato dalla API.
    log.log(`[openagenda] agenda ${agenda.uid} (${agenda.title}): total=${fetched.total ?? 'n/a'} received=${fetched.events.length} mapped=${mapped} pages=${fetched.pages}`);
    perAgenda.push({ uid: agenda.uid, total: fetched.total, received: fetched.events.length, mapped, pages: fetched.pages });
  }

  const fresh = [...byId.values()];
  if (!fresh.length) {
    const status = failures.length ? 'failed' : 'empty';
    log.log(`[openagenda] 0 eventi — slice lasciato com'era (${status})`);
    return { status, events: [], written: false, failures, perAgenda };
  }

  const source = SOURCE;
  const events = [];
  for (const event of fresh) {
    let withImage = { ...event, sourceKey: source.key, sourceName: source.label, crawledAt };
    if (withImage.imageUrl) {
      const mirrored = dryRun ? undefined : await mirrorImage(withImage.imageUrl, withImage.id);
      if (mirrored) {
        withImage.imageUrl = mirrored;
      } else {
        const { imageUrl: _dropped, imageCredit: _credit, ...rest } = withImage;
        withImage = rest;
      }
    }
    events.push(fillEventPeopleDefaults(withImage, source));
  }
  events.sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id));

  if (dryRun) {
    log.log(`[openagenda] dry-run: ${events.length} eventi, slice non scritto`);
    return { status: failures.length ? 'failed' : 'ok', events, written: false, failures, perAgenda };
  }

  const slicePath = path.join(sliceDir, `${source.key}.json`);
  const total = mergeEventsIntoSlice({
    slicePath,
    sourceKey: source.key,
    sourceName: source.label,
    canton: source.canton,
    freshEvents: events,
    goneIds: [],
    crawledAt,
    detailFailureIds: [],
    detailAttemptCount: events.length,
  });
  log.log(`[openagenda] merged ${events.length} eventi → ${total} nello slice ${path.basename(slicePath)}`);
  return { status: failures.length ? 'failed' : 'ok', events, written: true, failures, perAgenda };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const result = await crawlOpenAgenda({ dryRun });
  if (result.status === 'no-key') return;
  if (result.status === 'failed' || result.status === 'empty') {
    // Un'agenda fallita (o nessun evento con chiave presente) non è un no-op:
    // il passo del workflow è continue-on-error e il suo «Surface …» lo rende
    // visibile dopo la pubblicazione delle altre fonti.
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error(`[openagenda] crawl failed: ${err?.message || err}`);
    process.exit(1);
  });
}
