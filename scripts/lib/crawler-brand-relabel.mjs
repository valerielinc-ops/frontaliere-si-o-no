/**
 * Riconciliazione del brand DICHIARATO su record gia' su disco.
 *
 * Un record porta `company` congelato al momento del crawl: se un parser
 * corregge la propria etichetta, le righe vecchie tengono quella sbagliata
 * finche' QUEL crawler non rigira. E' la stessa classe per cui esistono gia'
 * i due net di `assembleJobs()` (location e titolo markdown): la correzione
 * sta nel funnel di scrittura, ma le slice sono gia' sul disco.
 *
 * Qui pero' non e' solo cosmesi ritardata, e' un 404. Lo slug del profilo
 * datore deriva dall'ETICHETTA, non dalla chiave — `canonicalCompanyProfileSlug`
 * → `baseCompanySlug` → `rawCompanySlug(company)` in
 * `build-plugins/shared/companyProfileSlug.mjs` — e
 * `scripts/build-employer-profiles.mjs` raggruppa per quello slug, scartando
 * i gruppi sotto `BRIDGE_FLOOR`. Quando DUE crawler si scambiano l'etichetta e
 * vivono in workflow schedulati separatamente (`crawler-group-05` e
 * `crawler-group-22` per `ipersonal`/`med-ipersonal`), la prima run rietichetta
 * solo il proprio slice: per un intero ciclo entrambe le slice portano lo
 * stesso nome, il gruppo dell'altro slug resta a zero righe e la sua pagina
 * evergreen `/aziende/<slug>/` sparisce dal dataset — 404 su una route
 * indicizzata, piu' l'uscita dalla sitemap.
 *
 * Applicare la riconciliazione in assemblaggio rende lo scambio ATOMICO: il
 * primo deploy dopo il merge flippa entrambe le slice nello stesso passaggio,
 * qualunque sia l'ordine in cui i crawler rigireranno.
 *
 * La stringa non e' ricopiata qui: la si legge dal parser con
 * `extractDeclaredIdentity()`, cioe' dalla stessa fonte che alimenta la
 * directory aziende. Una lista che ripetesse l'etichetta sarebbe una terza
 * copia da tenere allineata a mano.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractDeclaredIdentity } from './crawler-company-identity.mjs';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Chiavi crawler la cui etichetta e' stata CORRETTA, e le cui righe pubblicate
 * possono quindi portare ancora quella vecchia.
 *
 * Deliberatamente una lista chiusa e non «tutti i crawler»: uno slice non e'
 * garantito mono-datore (`coop-ticino` copre Fust/Jumbo/Interdiscount,
 * `burkhalter` 84 ragioni sociali — vedi il docblock di
 * `crawler-company-identity.mjs`), e forzare li' l'etichetta dichiarata
 * collasserebbe marchi veri e distinti in uno solo. Le chiavi qui sotto sono
 * mono-datore per costruzione: il parser stampa una singola costante su OGNI
 * riga che emette.
 *
 * Una voce puo' essere rimossa quando il suo crawler ha rigirato e le righe
 * sul disco portano gia' l'etichetta dichiarata: da quel momento il net non
 * cambia piu' nulla.
 */
export const BRAND_RELABELLED_CRAWLER_KEYS = Object.freeze([
  // #7474 — le due etichette erano incrociate rispetto all'host davvero
  // visitato: il parser `ipersonal` crawla `med-ipersonal.ch` e viceversa.
  // Entrambi stampano una costante unica (`company: IPERSONAL_COMPANY_NAME` a
  // ipersonal-job-parser.mjs:183, `company: MED_IPERSONAL_COMPANY_NAME` a
  // med-ipersonal-job-parser.mjs:183), quindi lo slice e' mono-datore.
  'ipersonal',
  'med-ipersonal',
]);

/**
 * Percorso del parser dedicato per una chiave crawler.
 * @param {string} crawlerKey
 * @returns {string}
 */
export function parserPathForCrawlerKey(crawlerKey) {
  return path.join(LIB_DIR, `${crawlerKey}-job-parser.mjs`);
}

/**
 * Etichetta dichiarata per ogni chiave della lista, letta dal sorgente del
 * parser. Una chiave il cui parser non dichiara nulla viene semplicemente
 * omessa: senza dichiarazione non c'e' niente con cui riconciliare, e
 * sovrascrivere con una stringa vuota cancellerebbe il datore dal record.
 *
 * @param {ReadonlyArray<string>} [crawlerKeys]
 * @returns {Map<string, string>} chiave crawler → etichetta dichiarata
 */
export function declaredBrandLabels(crawlerKeys = BRAND_RELABELLED_CRAWLER_KEYS) {
  const labels = new Map();
  for (const key of crawlerKeys) {
    const declared = String(extractDeclaredIdentity(parserPathForCrawlerKey(key)).company || '').trim();
    if (declared) labels.set(key, declared);
  }
  return labels;
}

/**
 * Riallinea `company` all'etichetta dichiarata dal parser, in place.
 *
 * @param {object[]} jobs record gia' assemblati (mutati in place)
 * @param {Map<string, string>} [labels] chiave → etichetta, iniettabile nei test
 * @returns {{ relabelled: number, byKey: Record<string, number> }}
 */
export function applyDeclaredBrandRelabel(jobs, labels = declaredBrandLabels()) {
  const byKey = {};
  let relabelled = 0;
  if (labels.size === 0) return { relabelled, byKey };
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job || typeof job !== 'object') continue;
    const key = String(job.companyKey || '').toLowerCase();
    const declared = labels.get(key);
    if (!declared || job.company === declared) continue;
    job.company = declared;
    relabelled++;
    byKey[key] = (byKey[key] || 0) + 1;
  }
  return { relabelled, byKey };
}
