/**
 * Chiave di identita' per un URL di fonte news — sorgente unica di verita'.
 *
 * ── IL DIFETTO CHE QUESTO MODULO ESISTE PER TOGLIERE ────────────────────────
 *
 * `normalizeNewsUrl` in `scripts/create-article.mjs` buttava via l'INTERA
 * query e teneva solo schema+host+path. Su una fonte che identifica il
 * documento solo nella query — `ti.ch/…/dettaglio-comunicato/?NEWS_ID=<n>`,
 * `uil.it/newssx.asp?ID_News=<n>` — ogni item del feed collassava sulla stessa
 * chiave: il primo articolo veniva registrato e tutti i successivi della stessa
 * fonte risultavano «gia' usati», cioe' scartati senza che nessuno lo dicesse.
 *
 * Gemello di `generator/scripts/lib/source-url-ledger.mjs` sul corpus
 * (nanakokyobashi-rgb/frontaliere-articles#427). Qui e' un modulo a se' e non
 * un blocco dentro `create-article.mjs` per una ragione operativa: quel file e'
 * 11.675 righe e importarlo in un test tira dentro mezza pipeline, mentre
 * queste tre funzioni sono pure e si testano in isolamento.
 *
 * ⚠️ QUESTE SONO CHIAVI PERSISTITE. Cambiare l'output osservabile di
 * `newsUrlKey` ri-chiave ogni voce gia' scritta nei ledger di sezione. La
 * compatibilita' regge su una proprieta' precisa, verificata dai test: se dopo
 * il filtro non resta nessun parametro identificante, `newsUrlKey` torna un
 * valore **identico** a `legacyNewsUrlKey`. Quindi le voci storiche di URL
 * senza query — la stragrande maggioranza — non si spostano affatto.
 */

/**
 * Marcatori di campagna/tracciamento: non identificano il documento, e due URL
 * che differiscono solo per uno di questi sono lo stesso articolo.
 */
const TRACKING_PARAM_NAMES = new Set([
  'fbclid', 'gclid', 'gbraid', 'wbraid', 'dclid', 'msclkid', 'yclid', 'twclid',
  'igshid', 'mc_cid', 'mc_eid', 'ref', 'referrer', 'referer', 'source', 'src',
  'cmpid', 'cmp', 'spm', 'xtor', 'ito', 'ncid', 'sref', 'share', 'sharedfrom',
  'feature', 'trk', 'trkcampaign', 'rss', 'from',
  // ── SELETTORI DI LOCALE/OUTPUT, non identita' del documento ───────────────
  //
  // Divergenza DELIBERATA dalla lista del gemello sul corpus, e la ragione e'
  // misurata su questo lato: i ledger del sito contengono 27 voci
  // `news.google.com/rss/articles/<id-base64>`, dove l'identita' e' INTERA nel
  // path. Gli URL che Google News emette nel feed portano pero'
  // `?oc=5&hl=it-IT&gl=IT&ceid=IT:it`, e senza questa riga lo stesso articolo
  // ripreso con un locale diverso produrrebbe due chiavi: il dedup si
  // frammenterebbe e lo stesso pezzo potrebbe essere consumato due volte.
  //
  // E' l'errore SPECULARE a quello che questa fix toglie — li' si fondeva cio'
  // che andava distinto, qui si distinguerebbe cio' che va fuso — e su un
  // cambio di chiave persistita vanno chiusi tutti e due nello stesso giro.
  'hl', 'gl', 'ceid', 'oc',
]);

/** Prefissi delle famiglie di tracciamento (Google, AT Internet, Matomo, HubSpot). */
const TRACKING_PARAM_PREFIXES = ['utm_', 'at_', 'pk_', 'mtm_', 'piwik_', 'ns_', 'hsa_', '_ga', '_gl'];

/**
 * Oltre questo numero di parametri identificanti la chiave si tronca. Il taglio
 * e' su una lista GIA' ordinata, quindi resta deterministico. Massimo misurato
 * nel reale: 4.
 */
const MAX_KEY_PARAMS = 8;

/** @param {string} name @returns {boolean} */
export function isTrackingParam(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return true;
  if (TRACKING_PARAM_NAMES.has(n)) return true;
  return TRACKING_PARAM_PREFIXES.some((p) => n.startsWith(p));
}

/** La base della chiave, comune alle due forme: schema + host + path. */
function urlKeyBase(u) {
  return `${u.protocol}//${u.hostname}${u.pathname}`.replace(/\/$/, '').toLowerCase();
}

/**
 * La chiave di forma **1**, storica: path soltanto, query buttata via.
 *
 * Non e' codice morto e non va tolta: e' la forma in cui sono scritte le voci
 * gia' presenti nei ledger di sezione, ed e' cio' contro cui
 * `isSourceUrlAlreadyUsed` interroga il ponte di compatibilita'.
 *
 * @param {string} rawUrl
 * @returns {string}
 */
export function legacyNewsUrlKey(rawUrl) {
  // Stesso pre-decode di newsUrlKey: nel ramo catch (URL non parsabile) la
  // stringa grezza finisce nella chiave cosi' com'e', e senza questo passaggio
  // le due funzioni divergerebbero sullo stesso input malformato.
  const raw = String(rawUrl ?? '').replace(/&amp;/gi, '&');
  try {
    return urlKeyBase(new URL(raw));
  } catch {
    return raw.toLowerCase().replace(/\/$/, '');
  }
}

/**
 * La chiave di forma **2**: path + i parametri di query che identificano il
 * documento, ordinati, con i marcatori di tracciamento tolti.
 *
 * Il NOME del parametro viene minuscolizzato (uil.it emette lo stesso feed con
 * `ID_News` e `ID_NEWS`: e' lo stesso documento), il VALORE no — un id puo'
 * essere base64 o un hashid, e minuscolizzarlo fonderebbe due documenti
 * diversi. E' la stessa direzione di rischio che questa fix esiste per togliere.
 *
 * @param {string} rawUrl
 * @returns {string}
 */
export function newsUrlKey(rawUrl) {
  // `&amp;` → `&` prima di parsare: gli item RSS arrivano con la query
  // XML-escapata, e senza questo passaggio il primo parametro si chiamerebbe
  // `amp;id` invece di `id`.
  const raw = String(rawUrl ?? '').replace(/&amp;/gi, '&');
  let u;
  try {
    u = new URL(raw);
  } catch {
    return raw.toLowerCase().replace(/\/$/, '');
  }
  const base = urlKeyBase(u);
  const parts = [];
  for (const [name, value] of u.searchParams) {
    if (isTrackingParam(name)) continue;
    const v = String(value ?? '');
    // Un parametro senza valore non identifica niente (`?id=`): tenerlo
    // renderebbe la chiave diversa da quella dello stesso URL senza il
    // parametro, cioe' romperebbe il dedup senza guadagnare identita'.
    if (!v) continue;
    parts.push([name.toLowerCase(), v]);
  }
  if (parts.length === 0) return base;
  parts.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  // Nome e valore tornano CODIFICATI. `searchParams` li consegna decodificati,
  // quindi un valore che contiene `&` o `=` (arrivato come `%26`/`%3D`)
  // rientrerebbe nella chiave come separatore vero: `?id=1%26p%3D2` e
  // `?id=1&p=2` collasserebbero su una chiave sola pur essendo due documenti.
  const query = parts
    .slice(0, MAX_KEY_PARAMS)
    .map(([n, v]) => `${encodeURIComponent(n)}=${encodeURIComponent(v)}`)
    .join('&');
  return `${base}?${query}`;
}
