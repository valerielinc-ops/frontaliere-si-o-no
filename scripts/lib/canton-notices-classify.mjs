/**
 * canton-notices-classify.mjs — a quale categoria di hub appartiene un avviso.
 *
 * Tre casi, in ordine di affidabilita':
 *
 *  1. Fonte di categoria (`categoryDataSources.<cat>` del profilo): il feed e'
 *     gia' tematico (Steuerverwaltung, cassa AVS, ufficio mobilita'), la
 *     categoria e' quella della fonte. Nessuna parola chiave.
 *  2. Fonte istituzionale generalista con UN solo tema avvisi dichiarato
 *     (ospedale cantonale → servizi): categoria fissa, ma i fatti di cronaca
 *     e le offerte di lavoro restano fuori.
 *  3. Fonte generalista con piu' temi (zh.ch, bs.ch, ar.ch …): la categoria si
 *     decide sul titolo, SOLO fra i temi che la fonte dichiara. Un titolo che
 *     non tocca nessuno di quei temi NON viene assegnato al piu' vicino: resta
 *     fuori (`null`). Meglio un avviso in meno che una notizia di cronaca nel
 *     blocco «fisco» di un hub (AGENTS.md #6: un dato ambiguo resta unknown).
 *
 * Per be.ch l'API porta `topicTags` strutturati: se uno combacia con un tema
 * dichiarato vince sulle parole chiave.
 */

export const NOTICE_CATEGORIES = Object.freeze(['fisco', 'pensioni', 'mobilita', 'servizi', 'eventi', 'carburanti']);

/** Ordine di precedenza a parita' di punteggio: i temi piu' specifici prima. */
const PRECEDENCE = ['fisco', 'pensioni', 'carburanti', 'mobilita', 'servizi', 'eventi'];

/**
 * Radici per categoria (de/fr/it). Una radice semplice combacia anche dentro
 * una parola composta (`steuer` in «Quellensteuer»); con `=` davanti combacia
 * solo come parola intera (sigle corte e parole ambigue: `=ahv`, `=bus`).
 */
const KEYWORDS = {
  fisco: [
    'steuer', 'etax', 'e-tax', 'vstax', 'veranlagung', 'eigenmietwert', 'kalte progression', 'mehrwertsteuer',
    'impôt', 'impot', 'fiscal', '=fisc', 'taxation', 'déclaration d’impôt', "déclaration d'impôt", 'contribuable',
    'imposta', 'imposte', 'fiscale', 'dichiarazione dei redditi', 'contribuent',
  ],
  pensioni: [
    '=ahv', '=avs', 'ahv/iv', 'avs/ai', 'rente', 'pension', 'vorsorge', '=bvg', '=lpp', 'ergänzungsleistung',
    'prestations complémentaires', 'prévoyance', 'retraite', 'previdenza', 'invalidenversicherung', 'assurance-invalidité',
    'erwerbsersatz', '=eo', '=apg', 'familienzulage', 'allocations familiales', 'ausgleichskasse', 'caisse de compensation',
    'deckungsgrad', 'umwandlungssatz', 'taux de conversion',
  ],
  carburanti: ['benzin', 'diesel', 'tankstelle', 'treibstoff', 'carburant', '=essence', 'gazole', 'carburante', 'benzina', 'gasolio'],
  mobilita: [
    'verkehr', 'strasse', 'straße', 'baustelle', 'bauarbeiten', 'sperrung', 'gesperrt', 'umleitung', 'bahn', '=bus', 'busse',
    'buslinie', '=tram', '=öv', 'fahrplan', 'haltestelle', 'velo', 'parkplatz', 'parkier', 'tunnel', 'brücke', 'belag',
    'grenzübergang', '=zoll', 'trafic', 'circulation', '=route', 'routier', 'routière', 'chantier', 'travaux', 'fermeture',
    'déviation', 'transports publics', 'horaire', '=gare', '=train', 'ferroviaire', 'mobilité', 'mobilite', 'douane',
    'viabilità', 'traffico', 'cantiere', 'strada', 'stradale', 'chiusura', 'treno', 'ferrovi', 'autostrad', 'valico',
    'trasporti', 'mobilità', '=a1', '=a2', '=a3', '=a4', '=a9', '=a13',
  ],
  servizi: [
    'spital', 'klinik', 'gesundheit', 'prämie', 'krankenversicherung', 'krankenkasse', 'prämienverbilligung', 'migration',
    'aufenthalt', 'bewilligung', 'ausweis', 'schalter', 'öffnungszeit', 'apotheke', 'notfall', 'impf', 'arbeitslos',
    '=rav', 'grenzgänger', 'einbürgerung', 'hôpital', 'santé', '=primes', 'assurance-maladie', 'subside', 'permis', 'guichet',
    "horaires d'ouverture", 'pharmacie', 'urgence', 'vaccin', 'chômage', 'frontalier', 'naturalisation',
    'ospedale', 'sanità', 'cassa malati', 'premi di cassa', 'permesso', 'sportello', 'farmacia', 'vaccinazion',
    'disoccupazione', 'frontalieri',
  ],
  eventi: [
    'veranstaltung', 'anlass', 'festival', 'konzert', 'ausstellung', '=messe', 'markt', 'manifestation', 'concert',
    'exposition', '=fête', '=foire', '=marché', 'evento', '=mostra', 'concerto', '=sagra', '=fiera',
  ],
};

/**
 * Titoli che NON sono avvisi per un hub, anche se una parola chiave combacia:
 * cronaca di polizia (un «Unfall auf der A1» non e' un avviso di mobilita') e
 * offerte di lavoro dell'ente.
 */
const EXCLUDE = [
  'unfall', 'verletzt', 'festnahme', 'festgenommen', 'verhaftet', 'zeugenaufruf', 'vermisst', 'tötungsdelikt', 'raub',
  'einbruch', 'brand eines', '=brand', 'polizeieinsatz', 'kollision', 'tödlich',
  'accident', 'blessé', 'interpellé', 'incendie', 'disparu', 'cambriolage', 'collision', 'à contresens',
  'incidente', 'ferito', 'arrestato', 'incendio', 'scomparso',
  'offene stelle', 'stellenausschreibung', '=recrute', "offre d'emploi", 'posto vacante', 'concorso per',
];

const LETTER = /[\p{L}\p{N}]/u;

function compile(list) {
  return list.map((raw) => {
    const whole = raw.startsWith('=');
    const word = (whole ? raw.slice(1) : raw).toLowerCase();
    return { word, whole };
  });
}

const COMPILED = Object.fromEntries(Object.entries(KEYWORDS).map(([k, v]) => [k, compile(v)]));
const COMPILED_EXCLUDE = compile(EXCLUDE);

function hits(text, entries) {
  let n = 0;
  for (const { word, whole } of entries) {
    let from = 0;
    for (;;) {
      const i = text.indexOf(word, from);
      if (i === -1) break;
      from = i + word.length;
      if (whole) {
        const before = i > 0 ? text[i - 1] : '';
        const after = text[i + word.length] ?? '';
        if ((before && LETTER.test(before)) || (after && LETTER.test(after))) continue;
      }
      n++;
      break;
    }
  }
  return n;
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ');

export function isExcludedTitle(title) {
  return hits(norm(title), COMPILED_EXCLUDE) > 0;
}

/** Punteggio per categoria (solo per test e diagnostica). */
export function scoreTitle(title) {
  const t = norm(title);
  return Object.fromEntries(NOTICE_CATEGORIES.map((c) => [c, hits(t, COMPILED[c])]));
}

/** be.ch `topicTags` (`be-themen:<tema>`) → categoria. */
const BE_TOPIC_MAP = [
  [/strassen|mobilit|verkehr|oev|öv/i, 'mobilita'],
  [/steuer/i, 'fisco'],
  [/ahv|vorsorge|rente|sozialversicherung/i, 'pensioni'],
  [/gesundheit|soziales|migration|arbeit/i, 'servizi'],
  [/veranstaltung|kultur/i, 'eventi'],
];

/**
 * @param {{ title: string, meta?: { topicTags?: string[] } }} item
 * @param {{ fixedCategory?: string|null, categories: string[] }} source
 *   `fixedCategory` per le fonti di categoria; `categories` = temi avvisi dichiarati.
 * @returns {string|null}
 */
export function classifyNotice(item, source) {
  if (source.fixedCategory) return source.fixedCategory;
  const allowed = (source.categories ?? []).filter((c) => NOTICE_CATEGORIES.includes(c));
  if (!allowed.length) return null;
  if (isExcludedTitle(item.title)) return null;

  for (const tag of item.meta?.topicTags ?? []) {
    for (const [re, cat] of BE_TOPIC_MAP) if (re.test(tag) && allowed.includes(cat)) return cat;
  }

  const scores = scoreTitle(item.title);
  let best = null;
  for (const cat of PRECEDENCE) {
    if (!allowed.includes(cat) || scores[cat] === 0) continue;
    if (!best || scores[cat] > scores[best]) best = cat;
  }
  if (best) return best;
  // Un solo tema dichiarato (ospedale → servizi): la fonte e' gia' tematica.
  return allowed.length === 1 ? allowed[0] : null;
}
