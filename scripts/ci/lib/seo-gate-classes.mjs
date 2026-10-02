/**
 * seo-gate-classes.mjs — la classificazione UNICA dei gate SEO post-deploy.
 *
 * Perché esiste
 * -------------
 * Lo stesso gate viveva in due posti con due modalità diverse:
 *   - `cathedral-seo-gates-check.yml` fallisce la propria run e apre una issue
 *     su OGNI regressione dei suoi sei gate, ma nessun altro workflow legge il
 *     suo esito (nessun `needs:`, non è un required check);
 *   - `post-deploy-validate-dist.yml` → `classify-validate-dist-failures.mjs`
 *     teneva cinque di quei sei gate in `QUALITY_GATES`, cioè non bloccanti per
 *     `publish`.
 * Il proprietario (2026-10-02): «quei tipi di check non sono opzionali». La
 * risposta non è rendere tutto bloccante né tutto advisory, ma classificare
 * ogni gate su EVIDENZA ESTERNA (documentazione Google Search Central, web.dev,
 * dichiarazioni Google) e derivare la modalità dalla classe, in UN posto solo.
 *
 * Le tre classi
 * -------------
 *   A — bloccante assoluto: misura un dato/markup richiesto da Google o un
 *       danno reale certo (pagina che non serve contenuto, JSON-LD illeggibile,
 *       sitemap/canonical che `publish` invierebbe tali e quali). Qualunque
 *       fallimento sequestra `publish`.
 *   B — bloccante sulla regressione: impatto documentato su indicizzazione,
 *       ranking o UX, ma con un arretrato storico misurato da un ratchet (o da
 *       un tetto). Il gate fallisce SOLO quando il suo ratchet segnala una
 *       regressione rispetto alla baseline; quel fallimento sequestra `publish`
 *       come per A. Un miglioramento non stringe mai la baseline (VISION.md D9).
 *   C — advisory: nessuna evidenza di impatto (euristica di tool terzi, o
 *       raccomandazione senza effetto misurabile). Il fallimento NON sequestra
 *       `publish`; la run resta rossa e la issue di tracking si apre lo stesso
 *       (una regressione resta root-cause-first, D9). La fonte che motiva il C
 *       è nel campo `evidence`, come per A e B.
 *
 * `modeOverride` esiste per UN caso: l'evidenza indica una classe meno severa
 * di quella applicata oggi, ma declassare un gate verde è una decisione del
 * proprietario (AGENTS.md non-negotiable #2), non di questo file. La modalità
 * effettiva resta quella di oggi finché il proprietario non decide; il motivo è
 * scritto accanto.
 *
 * Chi la legge
 * ------------
 *   - `scripts/ci/classify-validate-dist-failures.mjs`: `QUALITY_GATES` = i gate
 *     in modalità advisory. Il default-deny resta là: un gate assente da qui
 *     (es. i validatori non SEO) blocca `publish` come prima.
 *   - `scripts/cathedral-seo-gates-check.mjs`: ogni gate dichiara la sua
 *     `gateKey` qui dentro; il verdetto riporta classe e modalità e la issue di
 *     regressione prende la priorità dalla classe.
 *   - `scripts/ci/seo-gates-improvement-report.mjs`: un miglioramento apre una
 *     issue di rebaseline solo per la classe A (D9 vieta di stringere B e C).
 *
 * Le chiavi sono i nomi che `validate-dist-postbuild` scrive in `failed_gates`
 * (`audit:all/<auditor>` per i sotto-auditor di `scripts/audit-all.mjs`).
 */

/** Fonti. Ogni URL è stato letto il 2026-10-02; le citazioni sono nella proposta. */
const SRC = Object.freeze({
  titleLinks: 'https://developers.google.com/search/docs/appearance/title-link',
  newsArticlePages: 'https://support.google.com/news/publisher-center/answer/9607104',
  googlebotLimits: 'https://developers.google.com/search/docs/crawling-indexing/googlebot',
  links: 'https://developers.google.com/search/docs/crawling-indexing/links-crawlable',
  hreflang: 'https://developers.google.com/search/docs/specialty/international/localized-versions',
  imageLicense: 'https://developers.google.com/search/docs/appearance/structured-data/image-license-metadata',
  faqPage: 'https://developers.google.com/search/docs/appearance/structured-data/faqpage',
  spamPolicies: 'https://developers.google.com/search/docs/essentials/spam-policies',
  snippet: 'https://developers.google.com/search/docs/appearance/snippet',
  coreWebVitals: 'https://developers.google.com/search/docs/appearance/core-web-vitals',
  optimizeCls: 'https://web.dev/articles/optimize-cls',
  jobPosting: 'https://developers.google.com/search/docs/appearance/structured-data/job-posting',
  sdPolicies: 'https://developers.google.com/search/docs/appearance/structured-data/sd-policies',
  sitemaps: 'https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap',
  canonical: 'https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls',
  httpErrors: 'https://developers.google.com/search/docs/crawling-indexing/http-network-errors',
  breadcrumb: 'https://developers.google.com/search/docs/appearance/structured-data/breadcrumb',
  textHtmlRatioMueller: 'https://www.searchenginejournal.com/ranking-factors/code-to-text-ratio/',
  multipleH1Mueller: 'https://www.searchenginejournal.com/h1-headings-for-google/406720/',
  clickDepthMueller: 'https://www.searchenginejournal.com/google-click-depth-matters-seo-url-structure/256779/',
});

/** Modalità derivata dalla classe. */
export const CLASS_MODE = Object.freeze({
  A: 'blocking',
  B: 'blocking-on-regression',
  C: 'advisory',
});

/** Priorità della issue di regressione (github-issue-creator.mjs: 1 = più alta). */
export const CLASS_ISSUE_PRIORITY = Object.freeze({ A: 1, B: 2, C: 3 });

/**
 * @param {'A'|'B'|'C'} cls
 * @param {string} why
 * @param {string[]} evidence
 * @param {{mode: string, reason: string}} [modeOverride]
 */
function gate(cls, why, evidence, modeOverride) {
  return Object.freeze({
    class: cls,
    why,
    evidence: Object.freeze([...evidence]),
    ...(modeOverride ? { modeOverride: Object.freeze({ ...modeOverride }) } : {}),
  });
}

export const SEO_GATE_CLASSES = Object.freeze({
  // ── A — bloccante assoluto ───────────────────────────────────────────────
  'gate:seo-source': gate('A',
    'suite vitest tests/seo/ (hreflang reciproco, JSON-LD, canonical, robots): test a tolleranza zero (AGENTS.md #1, eccezione 2026-08-20)',
    [SRC.hreflang, SRC.canonical]),
  'validate:jobposting-schema': gate('A',
    'i 9 campi JobPosting di AGENTS.md #3; Google: proprietà richieste mancanti = niente rich result, violazioni = manual action',
    [SRC.jobPosting, SRC.sdPolicies]),
  'validate:sitemap-pages': gate('A',
    'publish invia le URL della sitemap tali e quali; Google vuole URL assolute e canoniche',
    [SRC.sitemaps]),
  'validate:sitemap-links': gate('A',
    'publish invia le URL della sitemap tali e quali',
    [SRC.sitemaps]),
  'audit:canonical-trailing-slash': gate('A',
    'canonical: dato che Google usa per consolidare i duplicati (D9: canonical a tolleranza zero)',
    [SRC.canonical]),
  'audit:news-sitemap': gate('A',
    'validità della sitemap news inviata a Google',
    [SRC.sitemaps]),
  'audit:no-dotfile-html': gate('A',
    'integrità del dist: pagine che non dovrebbero esistere',
    [SRC.httpErrors]),
  'audit:spa-bundle-injection': gate('A',
    'integrità del dist: shell senza bundle = pagina che non si idrata',
    [SRC.httpErrors]),
  'audit:all/footer-root-presence': gate('A',
    'shell di idratazione rotta: la pagina serve un guscio vuoto (soft 404)',
    [SRC.httpErrors]),
  'audit:all/jsonld-no-nested-scripts': gate('A',
    'JSON-LD annidato non è parsabile: il dato strutturato (anche JobPosting) sparisce',
    [SRC.sdPolicies, SRC.jobPosting]),
  'audit:all/image-object-license': gate('A',
    'ImageObject: Google richiede contentUrl + una fra creator/creditText/copyrightNotice/license; il gate chiede tutti e cinque (più severo di Google, oggi a 0 offender)',
    [SRC.imageLicense]),
  'audit:all/faqpage-validity': gate('C',
    'dal 2023-09-14 il rich result FAQ è mostrato solo a siti governativi/sanitari autorevoli: un FAQPage invalido qui non cambia la SERP',
    [SRC.faqPage],
    {
      mode: 'blocking',
      reason: 'resta bloccante finché il proprietario non approva il declassamento (AGENTS.md #2): oggi è verde, nessuna urgenza',
    }),

  // ── B — bloccante sulla regressione ──────────────────────────────────────
  'audit:max-bfs-depth': gate('B',
    'Google scopre le pagine dai link; la profondità di click da / pesa sull\'importanza (Mueller). Ratchet per-sitemap sul tasso',
    [SRC.links, SRC.clickDepthMueller]),
  'audit:orphan-sitemap-pages': gate('B',
    '«Every page you care about should have a link from at least one other page»; la sitemap è solo un suggerimento',
    [SRC.links, SRC.sitemaps]),
  'audit:hreflang': gate('B',
    'hreflang non reciproco viene ignorato: la pagina perde il targeting di lingua. Baseline 0 (tolleranza zero, D9)',
    [SRC.hreflang]),
  'audit:all/information-gain': gate('B',
    'famiglie mail-merge a basso valore = rischio «scaled content abuse» delle spam policy; soglia per coorte',
    [SRC.spamPolicies]),
  'audit:all/page-weight': gate('B',
    'Googlebot indicizza solo i primi 2MB di HTML; <img> senza width/height causa CLS (Core Web Vitals). Baseline 0',
    [SRC.googlebotLimits, SRC.coreWebVitals, SRC.optimizeCls]),

  // ── C — advisory ─────────────────────────────────────────────────────────
  'audit:all/text-html-ratio': gate('C',
    'euristica Semrush: Google non guarda il rapporto testo/HTML (Mueller, 2018)',
    [SRC.textHtmlRatioMueller]),
  'audit:all/title-length': gate('C',
    'Google: nessun limite di lunghezza per <title>, il title link è solo troncato in SERP',
    [SRC.titleLinks]),
  'audit:all/title-no-disambig-hash': gate('C',
    'cosmetica di CTR: Google sconsiglia testo boilerplate nei title, senza effetto su indicizzazione',
    [SRC.titleLinks]),
  'audit:all/h1-title-duplicates': gate('C',
    'regola Semrush; Google News chiede al contrario <title> = <h1> sugli articoli, e Google usa l\'h1 come fonte del title link',
    [SRC.newsArticlePages, SRC.titleLinks]),
  'audit:all/single-h1-per-page': gate('C',
    'Google: più <h1> sulla stessa pagina non sono un problema (Mueller)',
    [SRC.multipleH1Mueller]),
  'audit:all/content-duplicates': gate('C',
    'Google consolida i duplicati e sceglie un canonical; nessuna penalità per sé',
    [SRC.canonical]),
  'audit:all/duplicate-meta-description': gate('C',
    'Google raccomanda description uniche ma genera lo snippet soprattutto dal contenuto',
    [SRC.snippet]),
  'audit:all/duplicate-structured-data': gate('C',
    'un @type duplicato costa al massimo quel rich result; la pagina resta indicizzabile',
    [SRC.sdPolicies]),
  'audit:all/link-anchor-text': gate('C',
    'Google raccomanda anchor descrittivi (best practice, impatto non misurato); tetto per famiglia',
    [SRC.links]),
  'audit:all/breadcrumb-coverage': gate('C',
    'BreadcrumbList è un miglioramento opzionale dell\'aspetto in SERP',
    [SRC.breadcrumb]),
  'audit:all/no-literal-markdown': gate('C',
    'difetto visivo nel corpo dell\'annuncio; nessuna evidenza di impatto su indicizzazione',
    []),
  'audit:all/salary-landing-template': gate('C',
    'deriva del template interno, non un segnale Google',
    []),
  'validate:jobs-quality': gate('C',
    'completezza dei record job; i campi JobPosting richiesti sono già gate A in validate:jobposting-schema',
    [SRC.jobPosting]),
  'dist:quality-tests': gate('C',
    'file vitest RUN_DIST_GATES residui (contratto related-search-cluster): qualità, la pagina serve',
    []),
});

/** @param {string} key @returns {ReturnType<typeof gate> | null} */
export function seoGateClass(key) {
  return Object.prototype.hasOwnProperty.call(SEO_GATE_CLASSES, key) ? SEO_GATE_CLASSES[key] : null;
}

/**
 * Modalità effettiva di un gate: quella della classe, salvo `modeOverride`.
 * `null` per un gate non classificato (il chiamante applica il proprio
 * default-deny).
 * @param {string} key
 * @returns {string | null}
 */
export function effectiveMode(key) {
  const entry = seoGateClass(key);
  if (!entry) return null;
  return entry.modeOverride?.mode ?? CLASS_MODE[entry.class];
}

/**
 * Gate che NON sequestrano `publish`: esattamente quelli in modalità advisory.
 * La forma `{gate: motivazione}` è quella che `QUALITY_GATES` ha sempre avuto.
 * @returns {Record<string, string>}
 */
export function advisoryGateRationales() {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, entry] of Object.entries(SEO_GATE_CLASSES)) {
    if (effectiveMode(key) === 'advisory') out[key] = `class ${entry.class}: ${entry.why}`;
  }
  return out;
}

/**
 * Nome "nudo" di un gate (dopo l'ultimo `:` o `/`), cioè il nome che usa
 * cathedral (`max-bfs-depth`, `text-html-ratio`, …).
 * @param {string} key
 */
export function bareGateName(key) {
  return key.slice(Math.max(key.lastIndexOf(':'), key.lastIndexOf('/')) + 1);
}
