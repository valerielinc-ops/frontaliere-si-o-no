/**
 * Editorial sanitizers applied after IT content generation, before
 * fact-check and translation in scripts/create-article.mjs.
 *
 * Two concerns, both observed live on 2026-05-12 run 25714951592
 * (article `temporali-grandine-luganese-11-maggio-2026`):
 *
 * 1) Competitor promotion — the LLM lifts phrasing from the source
 *    article and ends up recommending the SOURCE's own newsletter
 *    instead of ours. Example shipped:
 *      "...i frontalieri possono iscriversi alla newsletter
 *       giornaliera di Tio."
 *    The source list mirrors NEWS_SOURCES in create-article.mjs.
 *
 * 2) Semantic mismatch on nav: links — the existing validation in
 *    create-article.mjs only checks that the `nav:<action>` token
 *    is in VALID_NAV_ACTIONS, but does NOT check that the visible
 *    link TEXT corresponds to the action's semantic. Examples
 *    shipped: `[calcolatore di tragitti](nav:calculator)` —
 *    nav:calculator is the FISCAL calculator (stipendio/tasse),
 *    not a route planner. `[comparatore di condizioni
 *    meteorologiche](nav:exchange)` — nav:exchange is the CHF/EUR
 *    currency comparator, not weather. The link sends users to a
 *    page that has nothing to do with the surrounding text.
 *
 * Both functions return the sanitized text and never throw.
 */

// ─── Competitor newsletter / service promotion ────────────────────────
//
// Domains and brand names corresponding to the NEWS_SOURCES list in
// create-article.mjs. We strip any sentence that recommends a
// newsletter / subscription / service belonging to one of these
// sources. Sources are matched as case-insensitive brand fragments
// (so "newsletter di Tio" / "Newsletter del Corriere" / "newsletter
// quotidiana di CDT" all match).
//
// The list is intentionally tight — adding a brand here protects
// against future LLM lifts of that source's CTAs. Order: domains
// scraped today, brand variants (with/without .ch/.it), known
// abbreviations.
const COMPETITOR_BRANDS = [
  // Ticino dailies
  'tio', 'tio\\.ch',
  'cdt', 'cdt\\.ch', 'corriere\\s+del\\s+ticino',
  'la\\s*regione', 'laregione', 'laregione\\.ch',
  'ticinonews', 'ticinonews\\.ch',
  'rsi', 'rsi\\.ch', 'radiotelevisione\\s+svizzera',
  'tvsvizzera', 'tvsvizzera\\.it', 'tvs',
  'ilgiornaledelticino', 'il\\s+giornale\\s+del\\s+ticino',
  // Italian-side
  'varesenews', 'varesenews\\.it',
  'varesenoi', 'varesenoi\\.it',
  'comozero', 'comozero\\.it',
  'corriere', 'corriere\\.it', 'corriere\\s+della\\s+sera',
  // CH federal / sindacati / official
  'swissinfo', 'swissinfo\\.ch',
  'cgil', 'cgil\\s+lombardia',
  'uil', 'uil\\.it',
  // Other competitors that show up
  'ipsoa', 'fiscoetasse', 'commercialistatelematico',
];

const COMPETITOR_RE = new RegExp(
  String.raw`\b(?:${COMPETITOR_BRANDS.join('|')})\b`,
  'i',
);

// A "promotion sentence" recommends a newsletter / service / subscription /
// app / channel BELONGING to a competitor. We match permissively to catch
// rephrasings: any sentence containing both a promotion verb and a
// competitor brand is treated as promotion.
const PROMOTION_CUES = [
  // IT
  'newsletter', 'iscriviti', 'iscriversi', 'iscrivi', 'abbonati', 'abbonarsi',
  'sottoscrivi', 'segui sui social', 'segui su',
  'visita\\s+il\\s+sito',
  'app\\s+ufficiale', 'app\\s+(di|del)\\s+', 'consulta\\s+il\\s+sito',
  'leggi\\s+anche', 'rimani\\s+aggiornato\\s+(su|con)',
  // EN
  'subscribe', 'sign up', 'follow on',
  'official app',
  // DE
  'abonnieren', 'newsletter\\s+(von|der|des)',
  // FR
  'abonner', 'inscrivez',
];

const PROMOTION_CUE_RE = new RegExp(
  `(?:${PROMOTION_CUES.join('|')})`,
  'i',
);

/**
 * Split a body field into sentences, drop any sentence that recommends
 * a competitor newsletter/service/subscription, and rejoin.
 *
 * The sentence splitter is intentionally conservative: it splits on
 * `.!?` followed by whitespace + capital letter or end of string,
 * which keeps URLs and abbreviations like "Fr." intact.
 *
 * @param {string} text — body content (markdown allowed)
 * @returns {{ text: string, removed: number, examples: string[] }}
 */
export function stripCompetitorPromotion(text) {
  if (!text || typeof text !== 'string') return { text: text || '', removed: 0, examples: [] };

  // Quick early-out: if no competitor brand appears anywhere, return as-is.
  if (!COMPETITOR_RE.test(text)) return { text, removed: 0, examples: [] };

  // Process paragraph by paragraph so we don't collapse markdown structure.
  const paragraphs = text.split(/\n\n+/);
  const examples = [];
  let removedSentences = 0;

  const cleanedParagraphs = paragraphs.map((para) => {
    // Don't touch the canonical "Fonte:" attribution line — sources are
    // expected and good (transparency about where the content came from).
    // Pattern matches `*Fonte: [example.com](https://example.com/...)*`
    // or plain `*Fonte: https://…*`.
    if (/^\s*\*?\s*Fonte\s*:/i.test(para)) return para;

    // Sentence-split on `.!?` followed by space + capital (handles abbreviations
    // by NOT splitting on `Fr.` / `LPP.` / `e.g.` etc).
    const sentences = para.split(/(?<=[.!?])\s+(?=[A-ZÀ-Ý"'\[])/);
    const kept = sentences.filter((sentence) => {
      const hasCompetitor = COMPETITOR_RE.test(sentence);
      const hasPromotion = PROMOTION_CUE_RE.test(sentence);
      if (hasCompetitor && hasPromotion) {
        removedSentences += 1;
        if (examples.length < 3) examples.push(sentence.trim().slice(0, 120));
        return false;
      }
      return true;
    });
    return kept.join(' ');
  });

  let cleaned = cleanedParagraphs.filter(p => p.trim().length > 0).join('\n\n');
  // If a heading is now followed by an empty section (we stripped its only
  // sentence), drop the orphan heading too. Match `### Heading\n\n###` or
  // heading immediately followed by another heading.
  cleaned = cleaned.replace(/^#{1,6}\s+[^\n]+\n\n(?=#{1,6}\s)/gm, '');
  // Same for trailing orphan heading at end of body.
  cleaned = cleaned.replace(/\n#{1,6}\s+[^\n]+\n?\s*$/m, '\n').trimEnd();

  return { text: cleaned, removed: removedSentences, examples };
}

// ─── Semantic validation of nav: links ────────────────────────────────
//
// Each valid nav: action has a per-locale allowlist of keywords. The
// visible link text must contain AT LEAST ONE keyword for the link to
// stay. Otherwise the nav: link is stripped (keep text), because
// sending users to a fiscal calculator when they clicked "calcolatore
// di tragitti" is worse than no link at all.
//
// We only enforce on IT (the primary locale). Translations inherit the
// nav: action token and just translate the visible text; if IT was
// valid, the translations will be too in shape; if IT was stripped,
// translations also drop the link via the existing per-locale validator.

const NAV_SEMANTIC_KEYWORDS_IT = {
  // Fiscal calculator (stipendio/imposte). NOT for route/trip/itinerary.
  calculator: [
    'calcolatore', 'calcola', 'simulatore', 'simulazione',
    'stipendio', 'salario', 'salari', 'busta', 'paga',
    'netto', 'lordo', 'fiscale', 'fisco', 'imposta', 'imposte', 'tasse',
    'cuneo', 'comparatore\\s+fiscale', 'tax',
  ],
  // CHF/EUR currency. NOT for weather, traffic, route.
  exchange: [
    'cambio', 'tasso', 'valuta', 'valute',
    'chf', 'eur', 'euro', 'euri', 'franco', 'franchi',
    'bonifico', 'rimessa', 'cross\\s*border\\s*payment',
  ],
  // LAMal/CMI health insurance.
  health: [
    'lamal', 'cmi', 'assicurazione', 'salute', 'sanità', 'sanitar',
    'cassa\\s+malati', 'premi?', 'malattia', 'mutua',
  ],
  // Cost of living comparator.
  'cost-of-living': [
    'costo', 'vita', 'spese', 'caro\\s+vita', 'comparatore\\s+costi',
  ],
  // Pensions (AVS/LPP).
  pension: [
    'pension', 'avs', 'lpp', 'rendita', 'rendite', 'pilastro',
    'previdenza',
  ],
  pillar3: [
    'pilastro\\s+3', 'terzo\\s+pilastro', '3°\\s*pilastro', '3a',
  ],
  // Payslip simulator.
  payslip: [
    'busta\\s+paga', 'paga', 'payslip', 'netto', 'cedolino',
  ],
  // Tax-return / dichiarazione redditi.
  'tax-return': [
    'dichiarazione', 'redditi', 'irpef', '730', 'unico', 'tax\\s+return',
  ],
  residency: [
    'residenza', 'residente', 'permesso\\s*b', 'permit\\s*b', 'domicilio',
  ],
  ristorni: ['ristorn'],
  unemployment: [
    'disoccup', 'naspi', 'indennità\\s+(di)?\\s*disoccup',
  ],
  jobs: [
    'lavoro', 'lavori', 'offert', 'posizion', 'annunc', 'job', 'jobs',
    'opportunit', 'recrut',
  ],
  companies: [
    'aziend', 'datori', 'datore', 'imprese', 'societ',
  ],
  banks: [
    'banc', 'conto', 'bonifico', 'bancari',
  ],
  'first-day': [
    'primo\\s+giorno', 'inizio\\s+lavoro', 'arrivo', 'checklist',
  ],
  permits: [
    'permess', 'permit', '\\bg\\b', '\\bb\\b', 'autorizzazion',
  ],
  border: [
    'dogan', 'confin', 'valic', 'brogeda', 'gaggiolo', 'chiasso',
    'ponte\\s+tresa', 'stabio', 'attes', 'coda', 'frontiera', 'tempi',
  ],
  calendar: [
    'calendar', 'scadenz', 'agenda', 'date',
  ],
  whatif: [
    'simul', 'scenario', 'what\\s*if', 'cosa\\s+succede',
  ],
  shopping: [
    'shopping', 'spesa', 'spese', 'acquist', 'prodott',
  ],
  transport: [
    'transport', 'trasport', 'mobilità', 'pendolar', 'tragitto',
    'tempo\\s+di\\s+viaggio', 'percorso',
  ],
  'salary-compare': [
    'stipend', 'salari', 'comparatore\\s+sal', 'comparazione',
  ],
  'traffic-history': [
    'traffic', 'storico', 'cronologia', 'history',
  ],
  'border-map': [
    'mappa', 'map', 'valic', 'dogan', 'confin', 'frontiera',
  ],
  municipalities: [
    'comune', 'comuni', 'municipalit', 'paese',
  ],
  'car-transfer': [
    'auto', 'macchina', 'trasferimento', 'targa', 'immatricol',
  ],
  'car-cost': [
    'auto', 'costo\\s+(auto|macchina)', 'carburant', 'benzina',
    'vignett', 'parcheggio',
  ],
  'permit-compare': [
    'permess', 'permit', 'comparatore\\s+permess', 'g\\s+vs\\s+b',
  ],
  renovation: [
    'rinnovo', 'rinnovi', 'rinnovare', 'rinnovazione', 'rinnova',
  ],
  mobile: ['mobile', 'cellulare', 'sim', 'roaming'],
  ral: ['ral', 'reddito\\s+annuo'],
  'parental-leave': [
    'parental', 'congedo', 'maternit', 'paternit', 'genitor',
  ],
  nursery: [
    'nido', 'asilo', 'scuola', 'infanzia', 'bambino', 'figli',
  ],
  'living-ch': [
    'svizzera', 'vivere\\s+in\\s+svizzera', 'permesso\\s*b',
  ],
  'living-it': [
    'italia', 'vivere\\s+in\\s+italia', 'frontaliere',
  ],
  livability: [
    'vivibilit', 'qualità\\s+(di\\s+)?vita', 'comune',
  ],
};

// Compile to RegExp once for performance.
const NAV_SEMANTIC_RE_IT = Object.fromEntries(
  Object.entries(NAV_SEMANTIC_KEYWORDS_IT).map(([action, words]) => [
    action,
    new RegExp(`(?:${words.join('|')})`, 'i'),
  ]),
);

// Per-action anti-keywords. If the link text contains any of these,
// the LLM has used the wrong action token — strip the link regardless
// of whether the visible text contains a generic positive keyword.
//
// Example: `[calcolatore di tragitti](nav:calculator)` would pass the
// positive allowlist (text contains "calcolatore"), but "tragitti" is
// in calculator's anti-list because nav:calculator is the FISCAL
// calculator, not a route planner.
//
// Adding "tragitto" to a tab's anti-list is fine: nav:transport (the
// only transit-related action) has no anti-keyword for "tragitto"
// since it's a legitimate transport-page concept. Each anti-list is
// scoped to that one action.
//
// Common off-topic themes that the LLM frequently misroutes to a
// fiscal/exchange/health action: route planners, weather widgets,
// generic live traffic dashboards. We don't ship any of these as
// nav: actions — when they appear they're always a hallucination.
const WEATHER_ANTI = [
  'meteo', 'meteorolog', 'weather', 'condizion[ie]\\s+meteo', 'condizion[ie]\\s+meteorologich',
  'previsioni\\s+meteo', 'temporal[ei]', 'piogg[ai]', 'grandine', 'maltempo',
  'allerta\\s+(maltempo|meteo)', 'temperatura', 'temperature', 'nev[ei]\\b',
];
const ROUTE_ANTI = [
  'tragitt[oi]', 'percors[oi]', 'route\\b', 'navigator',
  'itinerari[oi]', 'viaggio\\b',
];
const GENERIC_TRAFFIC_ANTI = [
  'traffico\\s+stradale', 'live\\s+traffic',
];

const NAV_ANTI_KEYWORDS_IT = {
  // Fiscal calculator (stipendio/imposte). Off-topic: weather, routes, traffic.
  calculator: [...WEATHER_ANTI, ...ROUTE_ANTI, ...GENERIC_TRAFFIC_ANTI],
  // CHF/EUR currency comparator. Same off-topic list.
  exchange: [...WEATHER_ANTI, ...ROUTE_ANTI, ...GENERIC_TRAFFIC_ANTI],
  // LAMal/CMI health insurance. Off-topic: weather, route.
  health: [...WEATHER_ANTI, ...ROUTE_ANTI],
  'cost-of-living': [...WEATHER_ANTI, ...ROUTE_ANTI],
  pension: [...WEATHER_ANTI, ...ROUTE_ANTI],
  pillar3: [...WEATHER_ANTI, ...ROUTE_ANTI],
  payslip: [...WEATHER_ANTI, ...ROUTE_ANTI],
  'tax-return': [...WEATHER_ANTI, ...ROUTE_ANTI],
  ristorni: [...WEATHER_ANTI, ...ROUTE_ANTI],
  // nav:transport / nav:car-cost / nav:traffic-history are legitimate
  // route/traffic homes — NO anti-keyword for those themes.
};

const NAV_ANTI_RE_IT = Object.fromEntries(
  Object.entries(NAV_ANTI_KEYWORDS_IT).map(([action, words]) => [
    action,
    new RegExp(`(?:${words.join('|')})`, 'i'),
  ]),
);

/**
 * Validate the SEMANTIC match between link text and nav: action for
 * the IT locale. Two checks in order:
 *   1. ANTI-KEYWORDS — if the link text contains a theme that doesn't
 *      belong to any tool on this site (route planner, weather, live
 *      traffic), strip the link regardless of the action. This catches
 *      the most common LLM hallucination: clicking a generic word like
 *      "calcolatore" to justify a nav:calculator link on a route-planner
 *      text.
 *   2. POSITIVE ALLOWLIST — if the action has a defined allowlist and
 *      the text contains NO allowlist keyword, strip the link.
 * Returns the sanitized text + count of stripped links + first few
 * examples for logging. Stripping = keep visible text, drop nav: link.
 *
 * @param {string} text — body content for IT locale
 * @returns {{ text: string, stripped: number, examples: string[] }}
 */
export function sanitizeNavLinkSemantics(text) {
  if (!text || typeof text !== 'string') return { text: text || '', stripped: 0, examples: [] };
  const examples = [];
  let stripped = 0;

  const result = text.replace(
    /\[([^\]]+)\]\(nav:([a-z0-9-]+)\)/g,
    (full, linkText, action) => {
      // Per-action anti-keyword check: highest-precedence. Catches
      // "calcolatore di tragitti"/"comparatore meteo" even when the action
      // token is valid and the link text contains a generic positive
      // keyword.
      const antiRe = NAV_ANTI_RE_IT[action];
      if (antiRe && antiRe.test(linkText)) {
        stripped += 1;
        if (examples.length < 3) examples.push(`[${linkText}](nav:${action}) — off-topic`);
        return linkText;
      }
      // Positive allowlist: text must contain at least one keyword for
      // the action's semantic.
      const re = NAV_SEMANTIC_RE_IT[action];
      // Unknown actions are handled by the existing VALID_NAV_ACTIONS
      // check in create-article.mjs — leave them alone here.
      if (!re) return full;
      if (re.test(linkText)) return full;
      stripped += 1;
      if (examples.length < 3) examples.push(`[${linkText}](nav:${action}) — no semantic match`);
      return linkText;
    },
  );

  return { text: result, stripped, examples };
}

// ─── Forced fabricated frontaliere examples ──────────────────────────
//
// Pattern observed live on 2026-05-12 article
// `direttrice-unispital-zurigo-whistleblower` (run 25715879161): the
// LLM took a Zurich whistleblower story and force-injected invented
// "frontaliere-relevant" cases to satisfy the keyword-density gate:
//
//   #### Esempi concreti
//   - Lugano: Un'infermiera frontaliera ha segnalato carenze igieniche…
//   - Chiasso: Un medico ha denunciato pratiche non etiche, ottenendo…
//
//   ### Esempi concreti
//   - Un infermiere dell'ORL ha segnalato irregolarità nella gestione
//     dei farmaci, portando a un'indagine interna e al recupero di
//     CHF 50.000.
//   - Un medico dell'Ospedale Civico di Lugano ha denunciato pratiche
//     di bilancio fraudolente, risultando in un'indagine della FINMA.
//
// All four bullets are fabricated. None appears in the source article.
// They exist only to bolt a Ticino frontaliere angle onto a story
// that has no such angle.
//
// Detection signal: a markdown heading (###, ####, ##) whose label
// contains "Esempi concreti / Casi pratici / Casi reali / Esempi
// reali / Per esempio" followed by 1+ bullets each matching:
//
//   - <CH city/locality>: …
//   - Un/Una <role> [in|a|dell'|del] <CH locality>… <specific outcome>
//
// where <role> is from a short list of medical/work roles and the
// outcome contains specific verbs (segnalato, denunciato, ottenuto,
// risultato, recupero, indagine, …) and/or specific numbers/currencies.
// Sections matching the heading + ≥1 suspicious bullet are STRIPPED
// (heading + all consecutive bullets dropped). Quality-preserving:
// the rest of the article is untouched.
//
// Conservative: requires BOTH the heading signal AND a suspicious
// bullet so we don't accidentally strip legitimate sections.

const FABRICATED_EXAMPLES_HEADING_RE = /^(?:#{2,4})\s*(?:Esempi\s+concreti|Esempi\s+pratici|Casi\s+pratici|Casi\s+reali|Esempi\s+reali|Casi\s+specifici|Per\s+esempio[:.]?)\s*$/im;

// Curated list of CH/IT-border localities that the LLM picks when
// fabricating examples. Lowercased, stem-friendly.
const CH_LOCALITY_TOKENS = [
  'lugano', 'bellinzona', 'mendrisio', 'chiasso', 'locarno', 'biasca',
  'gordola', 'massagno', 'paradiso', 'stabio', 'coldrerio', 'balerna',
  'morbio', 'caslano', 'breganzona', 'giubiasco', 'losone', 'capolago',
  'melide', 'rancate', 'comano', 'cadempino', 'manno', 'magliaso',
  'montagnola', 'sementina', 'tesserete', 'agno', 'taverne', 'cadenazzo',
  'gambarogno', 'lamone', 'savosa', 'porza', 'arbedo', 'cugnasco',
  'minusio', 'muralto', 'tenero', 'gentilino', 'collina d\'oro',
  'zurigo', 'zürich', 'berna', 'basilea', 'ginevra', 'losanna',
  'como', 'varese', 'milano', // (LLM also injects these as proximity hooks)
];
const CH_LOCALITY_RE = new RegExp(
  `\\b(?:${CH_LOCALITY_TOKENS.join('|')})\\b`,
  'i',
);

// Worker roles that the LLM consistently picks when fabricating.
// Italian plural/feminine forms: infermiere/infermiera/infermieri, etc.
const FAB_ROLE_RE = /\b(?:infermier[aei]\b|medico\b|medica\b|medici\b|dottore\b|dottoressa\b|dottori\b|impiegat[aoie]\b|operai[ao]\b|operaio\b|operaia\b|tecnic[aoi]\b|chirurg[aoi]\b|frontalier[aei]\b|lavorator[eai]\b)/i;

// Specific outcome verbs / nouns the LLM uses to make the case sound
// concrete and verifiable. Combined with role + locality + (number
// OR a definite article + named institution) → strong fabrication
// signal.
const FAB_OUTCOME_RE = /\b(?:ha\s+(?:segnalato|denunciato|ottenuto|ricevuto|recuperato|risultato)|denunci[oa]\b|segnal[oa]\b|risarciment|recupero\s+di|indagine\s+(?:interna|della\s+FINMA|delle?\s+autorit))/i;

// Specific monetary amount in CHF/EUR/euro/franchi as additional
// signal — fabricated examples almost always include a fake number to
// look convincing.
const FAB_MONEY_RE = /(?:CHF|EUR|€|euro|franchi|fr\.)\s*\d/i;

// "Lugano:" / "Chiasso:" / "Un'infermiera…" pattern in a bullet line.
const SUSPICIOUS_BULLET_RE = /^[\s>]*[-*•]\s*(?:[\p{Emoji}\p{Extended_Pictographic}]\s*)?(.{2,300})$/u;

function bulletLooksFabricated(line) {
  const m = line.match(SUSPICIOUS_BULLET_RE);
  if (!m) return false;
  const text = m[1];
  // Pattern A: "Lugano: …" / "Chiasso: …" — locality prefix on bullet
  const localityPrefix = /^\s*[A-ZÀ-Ý][\w\s'-]{2,30}:\s+/.test(text)
    && CH_LOCALITY_RE.test(text.slice(0, 40));
  // Pattern B: "Un/Una <role> dell'/della <named institution>…"
  const roleAndInstitution =
    FAB_ROLE_RE.test(text) &&
    (/\bdel(?:l['ae])?\s+[A-Z][\w\s]+/.test(text) || CH_LOCALITY_RE.test(text));
  // Strong signal: role + outcome + (locality OR amount)
  const roleOutcome = FAB_ROLE_RE.test(text) && FAB_OUTCOME_RE.test(text);
  const hasLocOrMoney = CH_LOCALITY_RE.test(text) || FAB_MONEY_RE.test(text);

  // A bullet is "fabricated-looking" when:
  //   • it has a locality prefix AND mentions a role, OR
  //   • it describes role+institution+outcome, OR
  //   • role + outcome + (locality OR money) — most common shipped pattern
  return (
    (localityPrefix && FAB_ROLE_RE.test(text)) ||
    (roleAndInstitution && FAB_OUTCOME_RE.test(text)) ||
    (roleOutcome && hasLocOrMoney)
  );
}

/**
 * Detect and strip "Esempi concreti / Casi" sections whose bullets
 * look fabricated (locality + role + specific outcome / amount).
 *
 * Conservative: requires BOTH the heading signal AND ≥1 fabricated
 * bullet. Legitimate sections without role+outcome patterns survive.
 *
 * Strips the heading + the consecutive bullet block (until first
 * non-bullet line or another heading). Leaves the rest intact.
 *
 * @param {string} text — IT body content
 * @returns {{ text: string, removedSections: number, examples: string[] }}
 */
export function stripFabricatedExamples(text) {
  if (!text || typeof text !== 'string') {
    return { text: text || '', removedSections: 0, examples: [] };
  }

  const lines = text.split('\n');
  const out = [];
  const examples = [];
  let removed = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!FABRICATED_EXAMPLES_HEADING_RE.test(line)) {
      out.push(line);
      i += 1;
      continue;
    }
    // Collect consecutive bullet lines + blank lines until next heading
    // or non-bullet/non-blank content.
    const sectionStart = i;
    let j = i + 1;
    const sectionBullets = [];
    while (j < lines.length) {
      const lj = lines[j];
      if (/^\s*$/.test(lj)) { j += 1; continue; }
      if (/^[\s>]*[-*•]\s+/.test(lj)) { sectionBullets.push(lj); j += 1; continue; }
      break; // hit heading or paragraph
    }

    const suspicious = sectionBullets.some(bulletLooksFabricated);
    if (suspicious) {
      removed += 1;
      if (examples.length < 3) {
        const sample = sectionBullets.find(bulletLooksFabricated) || sectionBullets[0] || '';
        examples.push(sample.trim().slice(0, 120));
      }
      // Drop heading + bullets entirely. Skip blank lines immediately
      // after so we don't leave a double newline gap.
      i = j;
      while (i < lines.length && /^\s*$/.test(lines[i])) i += 1;
      continue;
    }

    // Section looks legitimate — keep heading + bullets verbatim.
    for (let k = sectionStart; k < j; k += 1) out.push(lines[k]);
    i = j;
  }

  return { text: out.join('\n'), removedSections: removed, examples };
}

/**
 * Apply all sanitizers to a body field on the IT locale. Returns the
 * sanitized text plus per-step stats so the caller can log a single
 * summary line. Translations are NOT touched here — they go through
 * the per-locale nav-action validity check in create-article.mjs.
 *
 * Order: fabricated examples → competitor promo → nav: semantics.
 * Fabricated examples first so the stripped bullets don't accidentally
 * leave orphan "Iscriviti a X" or invalid nav links behind.
 *
 * @param {string} text
 * @returns {{
 *   text: string,
 *   competitorRemoved: number,
 *   competitorExamples: string[],
 *   navStripped: number,
 *   navExamples: string[],
 *   fabricatedSectionsRemoved: number,
 *   fabricatedExamples: string[],
 * }}
 */
export function sanitizeBodyIt(text) {
  const f = stripFabricatedExamples(text);
  const c = stripCompetitorPromotion(f.text);
  const n = sanitizeNavLinkSemantics(c.text);
  return {
    text: n.text,
    competitorRemoved: c.removed,
    competitorExamples: c.examples,
    navStripped: n.stripped,
    navExamples: n.examples,
    fabricatedSectionsRemoved: f.removedSections,
    fabricatedExamples: f.examples,
  };
}
