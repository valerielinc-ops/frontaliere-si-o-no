/**
 * Road events (chiusure, cantieri, traffico, trasporto pubblico) per canton.
 *
 * Pure helpers behind scripts/collect-road-events.mjs: every parser takes a
 * string and returns plain records, so the fixtures in
 * tests/road-events.test.ts exercise the mapping without network access.
 *
 * Two kinds of source:
 *
 *  - ASTRA DATEX II "traffic situations" (opentransportdata.swiss, SOAP pull).
 *    National, structured, but with NO canton field: 95% of the situations
 *    are located through ALERT-C location codes and only ~5% carry
 *    coordinates. The canton is therefore resolved from the official place
 *    names the situation text itself carries (interchanges, localities,
 *    postal codes) against the BFS/swisstopo gazetteer already committed in
 *    data/ — see buildCantonGazetteer(). A situation whose places do not
 *    resolve to exactly one canton is DROPPED, never guessed: a closure shown
 *    under the wrong canton is worse than one missing.
 *
 *    `parseSwissDatexXml()` in official-traffic-sources.mjs is NOT reused: it
 *    maps coordinates to the nearest border crossing for the live wait-time
 *    collector, and only the coordinate-bearing ~5% of situations can reach
 *    it. It stays where it is, for that purpose.
 *
 *  - Cantonal RSS feeds dedicated to mobility (or institutional/police feeds
 *    filtered by keyword). Each feed belongs to exactly one canton URL group,
 *    so its canton is declared, not inferred.
 *
 * `canton` is always the URL GROUP code of data/canton-url-slugs.json (AI/AR
 * -> APPENZELLO, BL/BS -> BASILEA), the convention every per-canton dataset
 * shares.
 */

export const ROAD_EVENTS_SCHEMA_VERSION = 1;

/** Record types, in display priority (a situation that closes AND has works is a closure). */
export const ROAD_EVENT_TYPES = Object.freeze(['chiusura', 'cantiere', 'traffico', 'tp']);

export const ROAD_EVENTS_USER_AGENT =
  'frontaliereticino-road-events/1.0 (+https://frontaliereticino.ch)';

export const DATEX_SITUATIONS_URL =
  'https://api.opentransportdata.swiss/TDP/Soap_Datex2/TrafficSituations/Pull';
export const DATEX_SOAP_ACTION =
  'http://opentransportdata.swiss/TDP/Soap_Datex2/Pull/v1/pullTrafficMessages';

/** SOAP pull body (DATEX II 2.3, opentransportdata.swiss cookbook). */
export function datexPullRequestBody() {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <d2LogicalModel xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" modelBaseVersion="2" xmlns="http://datex2.eu/schema/2/2_0">
      <exchange>
        <supplierIdentification><country>ch</country><nationalIdentifier>frontaliereticino</nationalIdentifier></supplierIdentification>
        <subscription>
          <operatingMode>operatingMode1</operatingMode>
          <subscriptionStartTime>2025-01-01T00:00:00+00:00</subscriptionStartTime>
          <subscriptionState>active</subscriptionState>
          <updateMethod>singleElementUpdate</updateMethod>
          <target><address></address><protocol>http</protocol></target>
        </subscription>
      </exchange>
    </d2LogicalModel>
  </soap:Body>
</soap:Envelope>`;
}

/**
 * Cantonal feeds. Verified 2026-10-05: HTTP 200, robots.txt of each host does
 * not disallow the feed path for `*` and has no group for AI crawlers that
 * would apply to this honest user agent (policy D10: no disguised UA, robots
 * respected). `requireKeyword` marks generalist institutional/police feeds:
 * only items whose title/summary name a road or public-transport disruption
 * are kept.
 */
export const ROAD_EVENT_FEEDS = Object.freeze([
  Object.freeze({
    id: 'ne-mobilite',
    canton: 'NE',
    url: 'https://www.ne.ch/actualites/21/rss.xml',
    publisher: 'République et canton de Neuchâtel — mobilité',
    defaultType: 'traffico',
    requireKeyword: false,
  }),
  Object.freeze({
    id: 'ne-territoire',
    canton: 'NE',
    url: 'https://www.ne.ch/actualites/15/rss.xml',
    publisher: 'République et canton de Neuchâtel — territoire',
    defaultType: 'cantiere',
    requireKeyword: true,
  }),
  Object.freeze({
    id: 'fr-mobilite',
    canton: 'FR',
    url: 'https://www.fr.ch/directions-services/182/rss.xml',
    publisher: 'Etat de Fribourg — mobilité',
    defaultType: 'traffico',
    requireKeyword: false,
  }),
  Object.freeze({
    id: 'fr-police',
    canton: 'FR',
    url: 'https://www.fr.ch/directions-services/113/rss.xml',
    publisher: 'Police cantonale fribourgeoise',
    defaultType: 'traffico',
    requireKeyword: true,
  }),
  Object.freeze({
    id: 'ge-police',
    canton: 'GE',
    url: 'https://www.ge.ch/rss/organisation/122',
    publisher: 'Police genevoise',
    defaultType: 'traffico',
    requireKeyword: true,
  }),
  Object.freeze({
    id: 'ge-mobilite',
    canton: 'GE',
    url: 'https://www.ge.ch/rss/organisation/102',
    publisher: 'République et canton de Genève — santé et mobilités',
    defaultType: 'traffico',
    requireKeyword: true,
  }),
  Object.freeze({
    id: 'vd-police',
    canton: 'VD',
    url: 'https://www.vd.ch/djes/polcant/flux.rss',
    publisher: 'Police cantonale vaudoise',
    defaultType: 'traffico',
    requireKeyword: true,
  }),
  Object.freeze({
    id: 'vd-mobilis',
    canton: 'VD',
    url: 'https://www.mobilis-vaud.ch/feed/',
    publisher: 'Mobilis Vaud',
    defaultType: 'tp',
    requireKeyword: false,
  }),
  Object.freeze({
    id: 'basilea-bvb',
    canton: 'BASILEA',
    url: 'https://www.bvb.ch/de/feed/',
    publisher: 'Basler Verkehrs-Betriebe',
    defaultType: 'tp',
    requireKeyword: true,
  }),
  Object.freeze({
    id: 'appenzello-polizei',
    canton: 'APPENZELLO',
    url: 'https://www.ai.ch/polizeimeldungen/news_listing_rss',
    publisher: 'Kantonspolizei Appenzell Innerrhoden',
    defaultType: 'traffico',
    requireKeyword: true,
  }),
  Object.freeze({
    id: 'ti-polizia',
    canton: 'TI',
    url: 'https://www3.ti.ch/xml/rss/rss-comunicati-1108.xml',
    publisher: 'Polizia cantonale ticinese',
    defaultType: 'traffico',
    requireKeyword: true,
  }),
]);

// ─── text helpers ───────────────────────────────────────────────────────────

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function stripCdata(value) {
  return String(value ?? '').replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
}

/** Plain text: CDATA unwrapped, tags removed, entities decoded, whitespace collapsed. */
export function plainText(value) {
  return decodeEntities(stripCdata(value).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function firstTag(block, tag) {
  const m = String(block).match(
    new RegExp(`<(?:[A-Za-z0-9_]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_]+:)?${tag}>`, 'i'),
  );
  return m ? m[1] : null;
}

function blocks(text, tag) {
  return (
    String(text ?? '').match(
      new RegExp(`<(?:[A-Za-z0-9_]+:)?${tag}\\b[^>]*>[\\s\\S]*?<\\/(?:[A-Za-z0-9_]+:)?${tag}>`, 'gi'),
    ) ?? []
  );
}

function isoOrNull(value) {
  if (!value) return null;
  const t = Date.parse(String(value).trim());
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// ─── type classification ────────────────────────────────────────────────────

const CLOSURE_RE =
  /\b(chius[aeo]|chiusura|interrott[aeo]|sbarrat[aeo]|ferm[ée]e?s?|fermeture|barr[ée]e?s?|gesperrt|sperrung|vollsperrung|strassensperrung|closed|closure)\b/i;
const WORKS_RE =
  /\b(cantier[ei]|lavori|manutenzione|chantiers?|travaux|réfection|baustellen?|bauarbeiten|sanierung|belagsarbeiten|roadworks|maintenance)\b/i;
const ROAD_RE =
  /\b(strada|strade|stradale|autostrada|galleria|ponte|route|routes|routière|routier|autoroute|chaussée|tunnel|pont|strasse|strassen|autobahn|brücke|kantonsstrasse|road|motorway|déplacements|mobilité|mobilités|mobilität|mobilità)\b/i;
const TRAFFIC_RE =
  /\b(traffico|circolazione|incolonnament\w*|deviazione|viabilità|circulation|trafic|déviation|bouchons?|accidents?|verkehr|verkehrs\w*|umleitung|stau|unfall|traffic|detour)\b/i;
const TRANSIT_RE =
  /\b(tram|trams|bus|autobus|ersatzbus|postauto|car postal|autopostale|treno|treni|train|trains|zug|züge|s-bahn|ferrovia|cff|sbb|ffs|horaire|fahrplan|orario|haltestellen?|arrêts?|fermata|fermate)\b/i;
const TRANSIT_DISRUPTION_RE =
  /\b(umleitung|umleitungen|ersatzbus|unterbruch|déviation|interruption|interruzione|deviazione|fahrplan|horaire|orario|tarif|tarifs|tariffe)\b/i;

const TRANSIT_COMPOUND_RE = /(?:bus|tram)(?:umleitung|ersatz|unterbruch|sperrung)/i;

/**
 * True when a title/summary names a road or public-transport disruption.
 * A closure or works word alone is not enough ("fermeture des caisses"): it
 * has to sit next to a road word. `transit` widens the test to service
 * disruptions of a public-transport operator's own feed.
 */
export function isMobilityRelevant(text, { transit = false } = {}) {
  const s = String(text ?? '');
  if (TRAFFIC_RE.test(s)) return true;
  if ((CLOSURE_RE.test(s) || WORKS_RE.test(s)) && ROAD_RE.test(s)) return true;
  if (!transit) return false;
  // German compounds (Busumleitungen, Tramersatz) have no word boundary.
  if (TRANSIT_COMPOUND_RE.test(s)) return true;
  return TRANSIT_RE.test(s) && (TRANSIT_DISRUPTION_RE.test(s) || CLOSURE_RE.test(s) || WORKS_RE.test(s));
}

/** chiusura > cantiere > tp > traffico, falling back to the feed default. */
export function classifyRoadEventType(text, defaultType = 'traffico') {
  const s = String(text ?? '');
  if (CLOSURE_RE.test(s)) return 'chiusura';
  if (WORKS_RE.test(s)) return 'cantiere';
  if (defaultType === 'tp' || (TRANSIT_RE.test(s) && !TRAFFIC_RE.test(s) && !ROAD_RE.test(s))) return 'tp';
  return ROAD_EVENT_TYPES.includes(defaultType) ? defaultType : 'traffico';
}

// ─── RSS / Atom ─────────────────────────────────────────────────────────────

/** RSS 2.0 `<item>` or Atom `<entry>` → { title, url, publishedAt, summary }. */
export function parseFeedItems(xml) {
  const text = String(xml ?? '');
  const rss = blocks(text, 'item');
  const nodes = rss.length ? rss : blocks(text, 'entry');
  return nodes.map((node) => {
    let url = plainText(firstTag(node, 'link') ?? '');
    if (!url) {
      const href = node.match(/<(?:[A-Za-z0-9_]+:)?link\b[^>]*\bhref=["']([^"']+)["']/i);
      url = href ? decodeEntities(href[1]).trim() : '';
    }
    const published =
      firstTag(node, 'pubDate') ?? firstTag(node, 'published') ?? firstTag(node, 'updated') ?? firstTag(node, 'date');
    return {
      title: plainText(firstTag(node, 'title') ?? ''),
      url: url || null,
      publishedAt: isoOrNull(plainText(published ?? '')),
      summary: plainText(firstTag(node, 'description') ?? firstTag(node, 'summary') ?? '').slice(0, 400),
    };
  });
}

/**
 * Feed items → road-event records. Undated items are dropped: without a date
 * an item cannot be told apart from last year's closure. Items older than
 * `maxAgeDays` are dropped for the same reason.
 */
export function feedItemsToEvents(feed, items, { now = new Date(), maxAgeDays = 21 } = {}) {
  const observedAt = now.toISOString();
  const oldest = now.getTime() - maxAgeDays * 86_400_000;
  const out = [];
  for (const item of items) {
    if (!item.title || !item.url || !item.publishedAt) continue;
    const t = Date.parse(item.publishedAt);
    if (t < oldest || t > now.getTime() + 86_400_000) continue;
    const haystack = `${item.title} ${item.summary}`;
    if (feed.requireKeyword && !isMobilityRelevant(haystack, { transit: feed.defaultType === 'tp' })) continue;
    out.push({
      id: `${feed.id}:${item.url}`,
      canton: feed.canton,
      type: classifyRoadEventType(haystack, feed.defaultType),
      title: item.title.slice(0, 240),
      url: item.url,
      validFrom: null,
      validTo: null,
      publishedAt: item.publishedAt,
      source: feed.id,
      observedAt,
    });
  }
  return out;
}

// ─── canton gazetteer ───────────────────────────────────────────────────────

/** Exonyms/variants used by DATEX texts that are not BFS municipality names. */
const PLACE_ALIASES = Object.freeze({
  Genf: 'GE', Genève: 'GE', Ginevra: 'GE',
  Freiburg: 'FR', Friborgo: 'FR',
  Neuenburg: 'NE',
  Basilea: 'BS', Bâle: 'BS',
  Berna: 'BE', Berne: 'BE', Biel: 'BE', Bienne: 'BE',
  Lucerna: 'LU', Lucerne: 'LU',
  Zurigo: 'ZH', Zurich: 'ZH', Zürich: 'ZH',
  Soletta: 'SO', Soleure: 'SO',
  Sciaffusa: 'SH', Schaffhouse: 'SH',
  Coira: 'GR', Coire: 'GR',
  Sitten: 'VS', Sion: 'VS',
  'San Gallo': 'SG', 'Saint-Gall': 'SG', 'St. Gallen': 'SG',
  Losanna: 'VD', Lausanne: 'VD',
  Bellinzone: 'TI', Bellenz: 'TI', Lugano: 'TI', Chiasso: 'TI',
});

function normaliseName(name) {
  return String(name ?? '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * name → canton code (BFS, not grouped) for every municipality/locality name
 * that belongs to exactly ONE canton. Ambiguous names (Buchs, Wil, …) are left
 * out on purpose; the CAP map is built the same way.
 *
 * @param {{ municipalities: object, localities: object }} inputs
 *   municipalities: data/canton-municipalities.json, localities:
 *   data/swiss-locality-postal-codes.json
 */
export function buildCantonGazetteer({ municipalities, localities }) {
  const names = new Map();
  const localityNames = new Map();
  const caps = new Map();
  const add = (map, key, canton) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(canton);
  };
  for (const [canton, entry] of Object.entries(municipalities?.cantons ?? {})) {
    for (const name of entry?.municipalities ?? []) add(names, normaliseName(name), canton);
  }
  for (const [canton, entries] of Object.entries(localities?.cantons ?? {})) {
    for (const [name, cap] of Object.entries(entries ?? {})) {
      add(localityNames, normaliseName(name), canton);
      add(caps, String(cap), canton);
    }
  }
  // A BFS municipality name is authoritative: a postal locality of the same
  // name can straddle the cantonal border (Versoix: GE municipality, locality
  // perimeter also in VD) and must not make it ambiguous — nor disambiguate a
  // name that several cantons' municipalities share (Buchs AG/SG/ZH).
  for (const [name, set] of localityNames) if (!names.has(name)) names.set(name, set);
  const unique = (map) => {
    const out = new Map();
    for (const [key, set] of map) if (set.size === 1 && key.length >= 3) out.set(key, [...set][0]);
    return out;
  };
  const byName = unique(names);
  for (const [alias, canton] of Object.entries(PLACE_ALIASES)) byName.set(alias, canton);
  return { byName, byCap: unique(caps) };
}

/** BFS canton → URL group (AI/AR → APPENZELLO, BL/BS → BASILEA). */
export function buildCantonGroupMap(cantonUrlSlugs) {
  const map = new Map();
  for (const [group, def] of Object.entries(cantonUrlSlugs?.cantonGroups ?? {})) {
    for (const member of def?.members ?? []) map.set(member, group);
  }
  return (canton) => (canton ? map.get(canton) ?? canton : null);
}

// DATEX location descriptors, as they appear in the de-CH / fr-CH / it-CH texts.
const LOCATION_TYPE_WORDS = [
  'Halbanschluss', 'Anschluss', 'Verzweigung', 'Autobahndreieck', 'Ortschaft', 'Tunnel', 'Pass',
  'Raststätte', 'Rastplatz', 'Brücke', 'Zoll', 'Grenzübergang', 'Kreuzung', 'Kreisel', 'Parkplatz',
  'Ausfahrt', 'Einfahrt', 'Galerie', 'Viadukt',
  'Jonction', 'Demi-jonction', 'Jonction autoroutière', 'Échangeur', 'Localité', 'Tunnel', 'Col',
  'Aire de repos', 'Aire de ravitaillement', 'Pont', 'Douane', 'Carrefour', 'Giratoire', 'Parking',
  'Svincolo autostradale', 'Raccordo autostradale', 'Diramazione', 'Galleria', 'Luogo', 'Passo',
  'Area di servizio', 'Area di sosta', 'Ponte', 'Dogana', 'Incrocio', 'Rotonda', 'Parcheggio',
];
const TYPE_ALT = LOCATION_TYPE_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .sort((a, b) => b.length - a.length)
  .join('|');
const TYPED_PLACE_RE = new RegExp(
  `(?:^|\\s)(?:${TYPE_ALT})\\s+(.+?)(?=\\s+(?:und|et|e|E)\\s|\\s+(?:${TYPE_ALT})\\s|$)`,
  'g',
);
const STATUS_SPLIT_RE = /\s(?:Sachlage|Situation|Situazione|Dauer|Durée|Durata)\s*:/;
const PREFIX_RE = /^\s*(?:Freigegeben|Libéré|Approvato|Released)\s*:\s*/;
const CAP_RE = /\b([1-9]\d{3})\s+[A-ZÀ-ÖØ-Þ][\p{L}.'-]+/gu;

function lookupPhrase(phrase, byName) {
  const p = normaliseName(phrase).replace(/[.,;:]+$/, '');
  if (!p) return null;
  if (byName.has(p)) return byName.get(p);
  const parts = p.split(/\s*[,/]\s*|\s+-\s+/).filter(Boolean);
  for (const part of parts) if (part !== p && byName.has(part)) return byName.get(part);
  for (const part of parts) {
    for (const piece of part.split('-')) if (piece.length >= 3 && byName.has(piece)) return byName.get(piece);
  }
  const words = p.split(' ');
  for (let len = Math.min(words.length, 4); len >= 1; len -= 1) {
    for (let i = 0; i + len <= words.length; i += 1) {
      const gram = words.slice(i, i + len).join(' ');
      if (gram.length >= 3 && byName.has(gram)) return byName.get(gram);
    }
  }
  return null;
}

/**
 * Canton (BFS code) of a DATEX situation from its texts, or null.
 * Order: postal code in an address → typed place names (interchange,
 * locality, tunnel, …) → named point descriptors. All resolved places must
 * agree: two different cantons (a stretch across a cantonal border) → null.
 */
export function resolveCantonFromTexts(texts, gazetteer) {
  const found = new Set();
  for (const raw of texts) {
    const text = decodeEntities(String(raw ?? ''));
    for (const m of text.matchAll(CAP_RE)) {
      const canton = gazetteer.byCap.get(m[1]);
      if (canton) found.add(canton);
    }
  }
  if (found.size === 0) {
    for (const raw of texts) {
      const head = decodeEntities(String(raw ?? '')).replace(PREFIX_RE, '').split(STATUS_SPLIT_RE)[0];
      for (const m of head.matchAll(TYPED_PLACE_RE)) {
        const canton = lookupPhrase(m[1], gazetteer.byName);
        if (canton) found.add(canton);
      }
      if (found.size) break;
    }
  }
  if (found.size === 0) {
    for (const raw of texts) {
      const canton = lookupPhrase(decodeEntities(String(raw ?? '')).split(STATUS_SPLIT_RE)[0], gazetteer.byName);
      if (canton) {
        found.add(canton);
        break;
      }
    }
  }
  return found.size === 1 ? [...found][0] : null;
}

// ─── DATEX II situations ────────────────────────────────────────────────────

function situationRecordType(record) {
  const m = record.match(/<(?:[A-Za-z0-9_]+:)?situationRecord\b[^>]*xsi:type="(?:[A-Za-z0-9_]+:)?([A-Za-z]+)"/);
  return m ? m[1] : null;
}

function recordRoadEventType(record) {
  const kind = situationRecordType(record);
  const management = plainText(firstTag(record, 'roadOrCarriagewayOrLaneManagementType') ?? '');
  if (kind === 'RoadOrCarriagewayOrLaneManagement' && /closed|closure/i.test(management)) return 'chiusura';
  if (kind === 'MaintenanceWorks' || kind === 'ConstructionWorks') return 'cantiere';
  return 'traffico';
}

function localizedComments(situation) {
  const byLang = {};
  for (const comment of blocks(situation, 'generalPublicComment')) {
    for (const m of comment.matchAll(/<(?:[A-Za-z0-9_]+:)?value\b[^>]*\blang="([a-z]{2})[^"]*"[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?value>/gi)) {
      const lang = m[1].toLowerCase();
      if (!byLang[lang]) byLang[lang] = plainText(m[2]);
    }
  }
  return byLang;
}

function headline(text) {
  return decodeEntities(String(text ?? ''))
    .replace(PREFIX_RE, '')
    .split(/\s(?:Dauer|Durée|Durata)\s*:/)[0]
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

/**
 * DATEX II pull response → road-event records.
 * Keeps situations that are still valid at `now` or start within
 * `horizonDays`; drops those whose canton cannot be resolved (counted in
 * `stats.unresolved`, so the collector can print the coverage every run).
 */
export function parseDatexSituations(xml, { gazetteer, toGroup = (c) => c, now = new Date(), horizonDays = 14 } = {}) {
  const observedAt = now.toISOString();
  const nowMs = now.getTime();
  const horizonMs = nowMs + horizonDays * 86_400_000;
  const stats = { situations: 0, expired: 0, unresolved: 0, kept: 0 };
  const events = [];
  for (const situation of blocks(xml, 'situation')) {
    stats.situations += 1;
    const idMatch = situation.match(/<(?:[A-Za-z0-9_]+:)?situation\b[^>]*\bid="([^"]+)"/);
    const records = blocks(situation, 'situationRecord');
    if (!idMatch || records.length === 0) continue;

    let type = 'traffico';
    let validFrom = null;
    let validTo = null;
    for (const record of records) {
      const t = recordRoadEventType(record);
      if (ROAD_EVENT_TYPES.indexOf(t) < ROAD_EVENT_TYPES.indexOf(type)) type = t;
      const starts = [firstTag(record, 'startOfPeriod'), firstTag(record, 'overallStartTime')].map((v) => isoOrNull(plainText(v ?? '')));
      const ends = [firstTag(record, 'endOfPeriod'), firstTag(record, 'overallEndTime')].map((v) => isoOrNull(plainText(v ?? '')));
      for (const s of starts) if (s && (!validFrom || s < validFrom)) validFrom = s;
      for (const e of ends) if (e && (!validTo || e > validTo)) validTo = e;
    }
    if ((validTo && Date.parse(validTo) < nowMs) || (validFrom && Date.parse(validFrom) > horizonMs)) {
      stats.expired += 1;
      continue;
    }

    const comments = localizedComments(situation);
    const pointNames = [...situation.matchAll(/<(?:[A-Za-z0-9_]+:)?descriptor\b[\s\S]*?<(?:[A-Za-z0-9_]+:)?value\b[^>]*>([^<]+)</gi)].map((m) => plainText(m[1]));
    const canton = resolveCantonFromTexts(
      [comments.de, comments.fr, comments.it, ...pointNames].filter(Boolean),
      gazetteer,
    );
    if (!canton) {
      stats.unresolved += 1;
      continue;
    }
    const lat = Number(plainText(firstTag(situation, 'latitude') ?? ''));
    const lng = Number(plainText(firstTag(situation, 'longitude') ?? ''));
    const titles = {};
    for (const lang of ['it', 'de', 'fr']) if (comments[lang]) titles[lang] = headline(comments[lang]);
    const title = titles.it ?? titles.de ?? titles.fr ?? pointNames[0];
    if (!title) {
      stats.unresolved += 1;
      continue;
    }
    events.push({
      id: `astra-datex2:${idMatch[1]}`,
      canton: toGroup(canton),
      type,
      title,
      titleByLocale: titles,
      url: null,
      validFrom,
      validTo,
      publishedAt: null,
      source: 'astra-datex2',
      observedAt,
      ...(Number.isFinite(lat) && Number.isFinite(lng) && plainText(firstTag(situation, 'latitude') ?? '') !== ''
        ? { geo: { lat, lng } }
        : {}),
    });
    stats.kept += 1;
  }
  return { events, stats };
}

/**
 * Same title in the same canton (the two directions of one closure are two
 * situations with one text) → one record; the earliest start and latest end
 * are kept.
 */
export function dedupeRoadEvents(events) {
  const byKey = new Map();
  for (const event of events) {
    const key = `${event.canton}|${event.type}|${event.title.toLowerCase()}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...event });
      continue;
    }
    if (event.validFrom && (!prev.validFrom || event.validFrom < prev.validFrom)) prev.validFrom = event.validFrom;
    if (event.validTo && (!prev.validTo || event.validTo > prev.validTo)) prev.validTo = event.validTo;
  }
  return [...byKey.values()].sort(
    (a, b) =>
      a.canton.localeCompare(b.canton) ||
      ROAD_EVENT_TYPES.indexOf(a.type) - ROAD_EVENT_TYPES.indexOf(b.type) ||
      String(b.publishedAt ?? b.validFrom ?? '').localeCompare(String(a.publishedAt ?? a.validFrom ?? '')) ||
      a.id.localeCompare(b.id),
  );
}

/** Structural gate shared by the collector (before writing) and the tests. */
export function validateRoadEventsPayload(payload, { knownCantons } = {}) {
  const errors = [];
  if (!payload || typeof payload !== 'object') return ['payload is not an object'];
  if (payload.schemaVersion !== ROAD_EVENTS_SCHEMA_VERSION) errors.push(`schemaVersion ${payload.schemaVersion}`);
  if (!isoOrNull(payload.generatedAt)) errors.push('generatedAt is not an ISO date');
  if (!Array.isArray(payload.events)) return [...errors, 'events is not an array'];
  if (!Array.isArray(payload.sources)) errors.push('sources is not an array');
  payload.events.forEach((e, i) => {
    const where = `events[${i}]`;
    if (!e || typeof e !== 'object') return errors.push(`${where} is not an object`);
    if (typeof e.id !== 'string' || !e.id) errors.push(`${where}.id`);
    if (typeof e.canton !== 'string' || (knownCantons && !knownCantons.has(e.canton))) errors.push(`${where}.canton ${e.canton}`);
    if (!ROAD_EVENT_TYPES.includes(e.type)) errors.push(`${where}.type ${e.type}`);
    if (typeof e.title !== 'string' || !e.title.trim()) errors.push(`${where}.title`);
    if (e.url !== null && !/^https:\/\//.test(String(e.url))) errors.push(`${where}.url ${e.url}`);
    for (const k of ['validFrom', 'validTo', 'publishedAt']) {
      if (e[k] !== null && !isoOrNull(e[k])) errors.push(`${where}.${k}`);
    }
    if (typeof e.source !== 'string' || !e.source) errors.push(`${where}.source`);
    if (!isoOrNull(e.observedAt)) errors.push(`${where}.observedAt`);
  });
  return errors;
}
