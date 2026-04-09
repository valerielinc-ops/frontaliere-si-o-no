#!/usr/bin/env node
/**
 * create-article.mjs — Generate a complete blog article using Gemini AI.
 *
 * Usage:
 *   node scripts/create-article.mjs                 # auto-scan Ticino news sources
 *   node scripts/create-article.mjs <news-url>      # use specific URL
 *
 * Auto-scan mode (default):
 *   1. Scans multiple Ticino + frontalieri news sources for recent headlines
 *   2. Uses Gemini to select the most relevant article for frontalieri
 *   3. Checks against existing articles to avoid duplicates
 *   4. Generates full article in 4 languages + image
 *
 * Requires: GH_MODELS_PAT env var (text), GEMINI_API_KEY env var (images)
 *
 * What it does:
 *   1. Fetches the web page content at the given URL
 *   2. Calls Gemini 2.0 Flash to generate article data in 4 languages
 *   3. Generates a contextual article image using Gemini native image generation
 *   4. Validates CTA presence and enforces internal links to site tools
 *   5. Programmatically detects duplicates (Jaccard similarity on titles + ID/slug checks)
 *   6. Modifies 9 source files to register the new article
 *   5. Updates sitemap-blog.xml with the new article URL and hreflang alternates
 *   6. Stages all modified files with git add
 *
 * ══════════════════════════════════════════════════════════════
 * REGOLE EDITORIALI — Queste regole DEVONO essere rispettate:
 * ══════════════════════════════════════════════════════════════
 *
 * 1. ANTI-AI DETECTION: Gli articoli NON devono essere riconoscibili come
 *    generati da AI. Stile giornalistico italiano naturale, con variazione
 *    nella lunghezza delle frasi, dati specifici, riferimenti locali e nomi.
 *    Evitare pattern tipici dell'AI (frasi filler, strutture ripetitive).
 *
 * 2. IMMAGINE CONTESTUALE: Generare un'immagine contestuale all'articolo
 *    tramite Gemini native image generation (modello gemini-3-pro-image-preview
 *    con fallback gemini-2.5-flash-image).
 *    Fallback: immagine del Ticino dal catalogo AVAILABLE_IMAGES.
 *    Le immagini generate vanno in public/images/blog/{article-id}.{png|jpg}.
 *
 * 3. SEO IMMAGINI: Ogni immagine deve avere ALT tag descrittivi e parlanti,
 *    con informazioni necessarie per l'indicizzazione su Google e Bing.
 *    Il campo imageAlt viene aggiunto a i18n per tutte e 4 le lingue.
 *
 * 4. DATI STRUTTURATI: Ogni articolo include Schema.org Article + ImageObject
 *    per Google e Bing, con breadcrumb, headline, datePublished, author.
 *
 * 5. SITEMAP: La sitemap-blog.xml viene aggiornata automaticamente con il nuovo URL
 *    e le varianti hreflang per tutte e 4 le lingue (it/en/de/fr + x-default).
 *
 * 6. RILEVANZA TICINO: La notizia DEVE essere rilevante per il Canton Ticino
 *    e/o le province italiane di confine (Como, Varese, VCO). Non accettare
 *    notizie generiche svizzere o dal mondo.
 *
 * 7. CTA OBBLIGATORIA: Ogni articolo DEVE terminare con un link/CTA verso
 *    uno strumento del sito. Default: il comparatore (calcolatore stipendio).
 *    Se il tema riguarda assicurazioni, pensioni, costo della vita etc.,
 *    linkare allo strumento specifico.
 * ══════════════════════════════════════════════════════════════
 */

import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, copyFileSync, existsSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { callLLM as _aiCallLLM, AI_MODELS, getStats as getAiStats, initScoreStore, flushScores } from './lib/ai-models.mjs';

// ── Config ──────────────────────────────────────────────────
// Gemini — image generation (text calls now go through centralized ai-models.mjs)
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const IMAGE_MODEL_PRO = 'gemini-3-pro-image-preview';
const IMAGE_MODEL_FLASH = 'gemini-2.5-flash-image';
const BASE_URL = 'https://frontaliereticino.ch';

// Model aliases for callLLM opts (used by callers that pass opts.model)
const GH_MODEL_HEAVY = AI_MODELS.GPT4O;
const GH_MODEL_LIGHT = AI_MODELS.GPT4O_MINI;
const BLOG_IMAGE_TARGET_MAX_BYTES = 220 * 1024; // target ~220KB
const BLOG_IMAGE_HARD_MAX_BYTES = 320 * 1024;   // hard cap ~320KB
const MIN_BODY_CHARS = 800;                      // minimum article body length (plain text chars)

// Static places catalog
const PLACES_IMAGES = [
  'ascona.webp', 'bellinzona.webp', 'castelgrande.webp', 'film-festival.webp',
  'foroglio.webp', 'foxtown.webp', 'gandria.webp', 'lac-lugano.webp',
  'lago-lugano.webp', 'locarno.webp', 'lugano-view.webp', 'mendrisio.webp',
  'monte-bre.webp', 'monte-generoso.webp', 'monte-san-salvatore.webp',
  'swissminiatur.webp',
];

// Build full fallback pool: places + all existing blog images (auto-grows)
// Exclude the 10 most recent blog images so the homepage doesn't show duplicates
const BLOG_IMAGES = (() => {
  try {
    const all = readdirSync(resolve('public/images/blog')).filter(f => f.endsWith('.jpg')).sort();
    const light = all.filter((f) => {
      try {
        return statSync(resolve(`public/images/blog/${f}`)).size <= BLOG_IMAGE_HARD_MAX_BYTES;
      } catch {
        return false;
      }
    });
    // Prefer lightweight assets for fallback rotation; if none, keep full list.
    return light.length > 0 ? light : all;
  }
  catch { return []; }
})();

// Combined pool with full paths for fallback rotation
// Skip images used by the last 7 articles to avoid visual repetition on homepage
const RECENT_ARTICLE_IMAGE_COUNT = 7;

function _getRecentArticleImages() {
  try {
    // FRO-360: ARTICLES array is now in data/blog-articles-data.ts
    const blogSrc = readFileSync(resolve('data/blog-articles-data.ts'), 'utf8');
    // Extract all image: '...' values from the ARTICLES array
    const imageMatches = [...blogSrc.matchAll(/image:\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
    // Last N are the most recent articles
    return imageMatches.slice(-RECENT_ARTICLE_IMAGE_COUNT);
  } catch { return []; }
}

function _buildFallbackPool() {
  const recentImages = new Set(_getRecentArticleImages());
  const allImages = [
    ...PLACES_IMAGES.map(f => `/images/places/${f}`),
    ...BLOG_IMAGES.map(f => `/images/blog/${f}`),
  ];
  const filtered = allImages.filter(img => !recentImages.has(img));
  // If filtering removes too many, keep at least places
  return filtered.length > 5 ? filtered : allImages;
}

const FALLBACK_IMAGES = _buildFallbackPool();

// Legacy: keep AVAILABLE_IMAGES for prompt catalog (AI picks from places names)
const AVAILABLE_IMAGES = PLACES_IMAGES;

// ─── Keyword-based fallback image matching ───────────────────────────────
// Maps keywords (found in article title/id/category) to the best fallback image.
// First match wins. Keys are lowercase. Values are paths from any pool image.
//
// Strategy: first try blog images whose filename contains the keyword (e.g.
// "salario-minimo-ticino-..." matches keyword "salario"), then fall back to
// curated place image mappings for broader themes.
const IMAGE_KEYWORD_MAP = [
  // Ticino places → matching place images
  { keywords: ['ascona'], image: '/images/places/ascona.webp' },
  { keywords: ['bellinzona', 'gendarmi', 'polizia', 'cantone', 'cantonale', 'governo', 'gran consiglio', 'amministrazione'], image: '/images/places/bellinzona.webp' },
  { keywords: ['castelgrande', 'castello', 'castelli', 'patrimonio', 'unesco'], image: '/images/places/castelgrande.webp' },
  { keywords: ['film', 'festival', 'cinema', 'locarno festival'], image: '/images/places/film-festival.webp' },
  { keywords: ['foroglio', 'cascata', 'bavona', 'cevio', 'maggia', 'vallemaggia'], image: '/images/places/foroglio.webp' },
  { keywords: ['foxtown', 'outlet', 'shopping', 'moda', 'fashion', 'negozio', 'acquisti', 'commercio'], image: '/images/places/foxtown.webp' },
  { keywords: ['gandria', 'contrabbando', 'museo doganale'], image: '/images/places/gandria.webp' },
  { keywords: ['lac-lugano', 'ceresio', 'navigazione', 'battello', 'crociera'], image: '/images/places/lac-lugano.webp' },
  { keywords: ['lago', 'lugano', 'paradiso', 'campione'], image: '/images/places/lago-lugano.webp' },
  { keywords: ['locarno', 'locarnese', 'brissago', 'gambarogno', 'muralto'], image: '/images/places/locarno.webp' },
  { keywords: ['lugano', 'centro', 'città', 'urbano', 'usi', 'università'], image: '/images/places/lugano-view.webp' },
  { keywords: ['mendrisio', 'chiasso', 'dogana', 'confine', 'frontiera', 'frontalier', 'valico', 'stabio', 'bizzarone', 'como'], image: '/images/places/mendrisio.webp' },
  { keywords: ['monte brè', 'bré', 'funicolare'], image: '/images/places/monte-bre.webp' },
  { keywords: ['monte generoso', 'generoso', 'ferrovia', 'cremagliera'], image: '/images/places/monte-generoso.webp' },
  { keywords: ['san salvatore', 'salvatore', 'panorama'], image: '/images/places/monte-san-salvatore.webp' },
  { keywords: ['swissminiatur', 'miniatura', 'melide', 'turismo', 'attrazione'], image: '/images/places/swissminiatur.webp' },
  // Thematic fallbacks (broader topics)
  { keywords: ['fisco', 'fiscal', 'tass', 'imposta', 'irpef', 'iva', 'dichiarazione', 'reddito', 'stipendio', 'salario', 'busta paga'], image: '/images/places/lugano-view.webp' },
  { keywords: ['treno', 'tilo', 'ffs', 'sbb', 'trasporto', 'pendolar', 'ferrovia', 'trenitalia'], image: '/images/places/locarno.webp' },
  { keywords: ['ospedale', 'sanità', 'salute', 'medic', 'lamal', 'cassa malati', 'assicurazion'], image: '/images/places/bellinzona.webp' },
  { keywords: ['lavoro', 'occupazione', 'disoccupazione', 'impiego', 'assunzion', 'contratto'], image: '/images/places/lugano-view.webp' },
  { keywords: ['scuol', 'educazione', 'formazione', 'studio', 'studente'], image: '/images/places/bellinzona.webp' },
  { keywords: ['natura', 'montagna', 'sentiero', 'escursion', 'trekking', 'alpi'], image: '/images/places/monte-generoso.webp' },
  { keywords: ['sport', 'hockey', 'calcio', 'palestra', 'atletica'], image: '/images/places/lugano-view.webp' },
  { keywords: ['cultura', 'museo', 'arte', 'mostra', 'teatro', 'musica', 'concerto'], image: '/images/places/locarno.webp' },
  { keywords: ['meteo', 'clima', 'pioggia', 'neve', 'temperature', 'alluvione', 'maltempo'], image: '/images/places/lago-lugano.webp' },
  { keywords: ['auto', 'traffico', 'strada', 'autostrada', 'incidente', 'circolazione'], image: '/images/places/mendrisio.webp' },
  { keywords: ['immobiliare', 'casa', 'affitto', 'appartamento', 'abitazione', 'residenza'], image: '/images/places/ascona.webp' },
  { keywords: ['banca', 'credito', 'finanziario', 'borsa', 'cambio', 'chf', 'euro', 'franco'], image: '/images/places/lugano-view.webp' },
  { keywords: ['pensione', 'avs', 'lpp', 'previdenza', 'pilastro', 'rendita', 'inps'], image: '/images/places/monte-san-salvatore.webp' },
  { keywords: ['ristorante', 'gastronomia', 'cucina', 'vino', 'cibo', 'grotto'], image: '/images/places/ascona.webp' },
];

/**
 * Find the best fallback image matching article content by keywords.
 * 
 * Strategy (in order):
 * 1. Search existing blog image filenames for keyword overlap with article text.
 *    Blog images are named after their article (e.g. "salario-minimo-ticino-...jpg"),
 *    so matching a blog filename to article keywords gives a topically relevant image.
 * 2. Fall back to curated IMAGE_KEYWORD_MAP (places + thematic).
 * 3. Return null → caller uses hash-based random.
 *
 * Images used by the last 7 articles are excluded from all results.
 */
function findBestFallbackImage(data) {
  const recentImages = new Set(_getRecentArticleImages());

  const searchableText = [
    data.id || '',
    data.category || '',
    data.imagePrompt || '',
    (data.content?.it?.title || data.content?.title || ''),
    (data.content?.it?.excerpt || data.content?.excerpt || ''),
  ].join(' ').toLowerCase();

  // Extract meaningful words (3+ chars) from article text for matching against filenames
  const articleWords = searchableText
    .replace(/[^a-zà-ÿ0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(w => w.length >= 4);

  // Strategy 1: find a blog image whose filename shares keywords with the article
  // Score each blog image by how many article words appear in its filename
  let bestBlogMatch = null;
  let bestBlogScore = 0;
  for (const imgPath of FALLBACK_IMAGES) {
    if (recentImages.has(imgPath)) continue;
    if (!imgPath.startsWith('/images/blog/')) continue;
    const filename = imgPath.replace('/images/blog/', '').replace('.jpg', '').toLowerCase();
    let score = 0;
    for (const word of articleWords) {
      if (filename.includes(word)) score++;
    }
    if (score > bestBlogScore) {
      bestBlogScore = score;
      bestBlogMatch = imgPath;
    }
  }
  // Require at least 2 keyword overlaps to consider it a good match
  if (bestBlogMatch && bestBlogScore >= 2) {
    return bestBlogMatch;
  }

  // Strategy 2: curated keyword→image map (places + themes)
  for (const entry of IMAGE_KEYWORD_MAP) {
    if (recentImages.has(entry.image)) continue;
    for (const kw of entry.keywords) {
      if (searchableText.includes(kw)) {
        if (FALLBACK_IMAGES.includes(entry.image)) {
          return entry.image;
        }
      }
    }
  }

  return null;
}

const CATEGORIES = ['fiscale', 'pratico', 'novita', 'pensione'];
const SOURCE_QUOTA_FILE = 'data/article-source-quotas.json';
const SOURCE_URLS_FILE = 'data/article-source-urls.json';
const CREATE_ARTICLE_REPORT_FILE = process.env.CREATE_ARTICLE_REPORT_FILE || '.tmp/create-article-run-report.json';
const SOURCE_QUOTA_ENABLED = process.env.SOURCE_QUOTA_ENABLED !== '0';
const SOURCE_WEEKLY_QUOTA = Math.max(
  1,
  Number.parseInt(process.env.SOURCE_WEEKLY_QUOTA || '3', 10) || 3,
);
const CREATE_ARTICLE_MIN_IT_WORDS = Math.max(
  600,
  Number.parseInt(process.env.CREATE_ARTICLE_MIN_IT_WORDS || '900', 10) || 900,
);
// Hard cap per body field — prevents LLM overshoot during expansion from
// producing fields too large for free-tier translation models (output cap ~2048-4096 tokens).
// 1000 words ≈ 1500 tokens output → well within model caps. Fields >700 words
// are automatically sub-chunked during translation as a safety net.
const MAX_BODY_FIELD_WORDS = 1000;
const CREATE_ARTICLE_MIN_WORDS_RETRIES = Math.max(
  1,
  Number.parseInt(process.env.CREATE_ARTICLE_MIN_WORDS_RETRIES || '6', 10) || 6,
);
/** Model rotation for min-words retries: cycle through different models to maximize chances */
const MIN_WORDS_MODEL_ROTATION = [
  GH_MODEL_HEAVY,                    // attempt 1: gpt-4o (GitHub Models)
  AI_MODELS.GPT_4_1,                 // attempt 2: gpt-4.1 (GitHub Models, different daily limit)
  'gemini',                          // attempt 3: gemini-2.5-flash (Google, different provider)
  AI_MODELS.GPT_5_NANO,              // attempt 4: gpt-5-nano (GitHub Models, different limit)
  AI_MODELS.GROQ_KIMI_K2,            // attempt 5: Kimi K2 (Groq, different provider)
  GH_MODEL_LIGHT,                    // attempt 6: gpt-4o-mini (then expansion fallback)
];

const RUN_REPORT = {
  startedAt: new Date().toISOString(),
  endedAt: null,
  status: 'running',
  selectedArticleType: null, // news | evergreen_static | evergreen_dynamic
  selectedSource: null,
  selectedUrl: null,
  sources: {
    configured: 0,
    scanned: 0,
    succeeded: 0,
    failed: 0,
    domains: [],
  },
  headlines: {
    total: 0,
    recent: 0,
    undated: 0,
    usedRecent: 0,
    usedUndated: 0,
  },
  selectionUsage: {
    attemptsTotal: 0,
    attemptsRecent: 0,
    attemptsUndated: 0,
  },
  duplicateReasonBreakdown: {},
  article: {
    id: null,
    url: null,
    sourceDomain: null,
  },
  notes: [],
};

let REPORT_FINALIZED = false;

function addDuplicateReason(key) {
  const k = key || 'other';
  RUN_REPORT.duplicateReasonBreakdown[k] = (RUN_REPORT.duplicateReasonBreakdown[k] || 0) + 1;
}

function captureDuplicateReasons(errorMessage = '') {
  const msg = String(errorMessage || '');
  if (!msg.includes('DUPLICATO')) return;

  if (msg.includes('L\'ID "') && msg.includes('esiste già')) addDuplicateReason('id_exists');
  if (msg.includes('Lo slug "') && msg.includes('esiste già')) addDuplicateReason('slug_exists');

  const signalLine = msg.match(/Segnali:\s*(.+)/);
  if (signalLine?.[1]) {
    addDuplicateReason('multi_signal');
    const parts = signalLine[1].split('|').map((x) => x.trim().toLowerCase());
    for (const p of parts) {
      if (p.startsWith('id:')) addDuplicateReason('signal_id');
      else if (p.startsWith('titolo:')) addDuplicateReason('signal_title');
      else if (p.startsWith('excerpt:')) addDuplicateReason('signal_excerpt');
      else if (p.startsWith('combinato:')) addDuplicateReason('signal_combined');
      else addDuplicateReason('signal_other');
    }
  } else {
    addDuplicateReason('other');
  }
}

function finalizeRunReport(status, extra = {}) {
  if (REPORT_FINALIZED) return;
  REPORT_FINALIZED = true;

  RUN_REPORT.status = status || 'unknown';
  RUN_REPORT.endedAt = new Date().toISOString();
  Object.assign(RUN_REPORT, extra || {});

  try {
    const dir = path.dirname(resolve(CREATE_ARTICLE_REPORT_FILE));
    mkdirSync(dir, { recursive: true });
    write(CREATE_ARTICLE_REPORT_FILE, `${JSON.stringify(RUN_REPORT, null, 2)}\n`);
  } catch (e) {
    console.error(`  ⚠️  Impossibile scrivere ${CREATE_ARTICLE_REPORT_FILE}: ${e.message}`);
  }
}

// Map common AI-hallucinated categories to valid ones
const CATEGORY_MAP = {
  economia: 'fiscale',
  economica: 'fiscale',
  lavoro: 'pratico',
  salute: 'pratico',
  sanita: 'pratico',
  trasporti: 'pratico',
  news: 'novita',
  notizie: 'novita',
  attualita: 'novita',
  previdenza: 'pensione',
};

// ── Long-tail SEO: evergreen keyword topics ─────────────────
// On Mondays, the script may generate a strategic evergreen article
// targeting long-tail keywords instead of a news-based article.
// These topics are high-search-volume queries from frontalieri.
const PRIORITY_EVERGREEN_TOPICS = [
  { keyword: 'calcolo tasse frontalieri entro 20 km confine', angle: 'Guida pratica al calcolo tasse per frontalieri entro 20 km dal confine: franchigia, credito d’imposta, differenze tra vecchio e nuovo regime' },
  { keyword: 'calcolo tasse frontalieri oltre 20 km confine', angle: 'Come cambia la tassazione per frontalieri oltre 20 km: quali agevolazioni non si applicano, impatto IRPEF e simulazioni con esempi reali' },
  { keyword: 'frontaliere contributi sociali svizzeri dettaglio busta paga', angle: 'Breakdown completo delle trattenute in busta paga svizzera: AVS, AI, IPG, AD, LPP, LAINF — cosa paga il datore e cosa il lavoratore frontaliere' },
  { keyword: 'quanto costa vivere a Lugano da frontaliere', angle: 'Analisi costi reali: affitto, trasporti, assicurazione, spesa alimentare per un frontaliere che valuta il trasferimento' },
  { keyword: 'frontaliere permesso G vantaggi svantaggi', angle: 'Pro e contro completi del permesso G: fisco, previdenza, sanità, mobilità lavorativa. Quando conviene e quando no' },
  { keyword: 'calcolo pensione frontaliere AVS italiana', angle: 'Come funziona la pensione da frontaliere: contributi AVS svizzeri + INPS italiana, totalizzazione, tempistica' },
  { keyword: 'frontaliere nuovo accordo fiscale 2026 simulazione', angle: 'Impatto concreto del nuovo accordo fiscale: simulazione con stipendio reale, confronto vecchio vs nuovo regime' },
  { keyword: 'LAMal o CMI frontaliere quale conviene 2026', angle: 'Confronto aggiornato LAMal vs CMI: premi, coperture, franchigia, casi pratici per famiglie e single' },
  { keyword: 'frontaliere doppia imposizione credito imposta come funziona', angle: 'Come evitare la doppia tassazione: meccanismo del credito d\'imposta per frontalieri, quadro CE del 730, esempi pratici con cifre reali' },
  { keyword: 'costo auto pendolare frontaliere Ticino', angle: 'Tutti i costi dell\'auto per il pendolare: benzina, vignette, parcheggio, usura, confronto con treno e bus' },
  { keyword: 'dichiarazione redditi frontaliere 730 guida', angle: 'Guida passo passo alla dichiarazione dei redditi: quadro CE, credito d\'imposta, documenti necessari, scadenze' },
  { keyword: 'frontaliere documenti necessari inizio lavoro Svizzera', angle: 'Checklist completa dei documenti per iniziare a lavorare in Svizzera: permesso G, contratto, apertura conto, iscrizione AVS, assicurazione, codice fiscale svizzero' },
  { keyword: 'telelavoro frontaliere quanti giorni 2026', angle: 'Regole telelavoro Italia-Svizzera: 25% massimo, accordo bilaterale, impatto fiscale, come comunicare al datore' },
  { keyword: 'frontaliere con figli asilo nido Svizzera', angle: 'Guida pratica per frontalieri con figli: asili nido ticinesi, costi, lista d\'attesa, sussidi, alternative italiane' },
  { keyword: 'aprire conto bancario svizzero da frontaliere', angle: 'Quale banca scegliere in Ticino: costi di gestione, carte, online banking, requisiti per frontalieri' },
  { keyword: 'ristorni fiscali frontaliere come funzionano', angle: 'Meccanismo completo dei ristorni: chi li paga, quanto valgono, come si calcolano, futuro post nuovo accordo' },
  { keyword: 'indennità disoccupazione frontaliere Italia', angle: 'NASpI per ex-frontalieri: requisiti, calcolo importo, durata, come fare domanda, differenze con la disoccupazione svizzera' },
  { keyword: 'frontaliere cambio euro franco conviene', angle: 'Strategie di cambio CHF-EUR: quando cambiare, piattaforme migliori, conto multi-valuta, impatto sullo stipendio' },
  { keyword: 'assicurazione malattia frontaliere famiglia', angle: 'Copertura sanitaria per tutta la famiglia: opzioni LAMal, EHIC, assicurazione integrativa, emergenze all\'estero' },
  { keyword: 'secondo pilastro LPP frontaliere prelievo', angle: 'Prelievo del secondo pilastro: quando si può, tassazione Italia e Svizzera, strategia di uscita ottimale' },
  { keyword: 'frontaliere acquisto casa mutuo Italia', angle: 'Comprare casa in Italia con stipendio svizzero: mutuo frontaliere, documenti, garanzie, banche specializzate' },
  { keyword: 'frontaliere maternità paternità congedo parentale Svizzera Italia', angle: 'Diritti di maternità e paternità per frontalieri: congedo svizzero vs italiano, indennità giornaliere, come richiedere le prestazioni, casi pratici per neo-genitori' },
  // Nuove keyword strategiche 2026
  { keyword: 'frontaliere bonus famiglia 2026', angle: 'Tutti i bonus e agevolazioni per famiglie frontalieri: assegni familiari, bonus nido, detrazioni, novità 2026.' },
  { keyword: 'frontaliere smart working regole aggiornate', angle: 'Regole e limiti per lo smart working transfrontaliero: percentuali, fiscalità, procedure, casi pratici.' },
  { keyword: 'frontaliere assicurazione auto Svizzera Italia', angle: 'Confronto tra assicurazioni auto svizzere e italiane per frontalieri: costi, coperture, sinistri, consigli.' },
  { keyword: 'frontaliere detrazioni fiscali Italia 2026', angle: 'Guida alle detrazioni fiscali per frontalieri in Italia: quali spese si possono scaricare, documenti, limiti.' },
  { keyword: 'frontaliere mutuo casa Svizzera requisiti', angle: 'Come ottenere un mutuo per acquistare casa in Svizzera da frontaliere: banche, requisiti, procedure.' },
  { keyword: 'frontaliere pensione complementare terzo pilastro', angle: 'Vantaggi e funzionamento del terzo pilastro per frontalieri: deducibilità, rendimenti, casi pratici.' },
  { keyword: 'frontaliere permesso B differenze con G', angle: 'Tutte le differenze tra permesso B e G per frontalieri: residenza, fiscalità, diritti, scelta ottimale.' },
  { keyword: 'frontaliere spese sanitarie rimborsabili Italia', angle: 'Quali spese sanitarie sostenute in Svizzera sono rimborsabili in Italia per frontalieri, procedure e limiti.' },
  { keyword: 'frontaliere lavoro stagionale Ticino', angle: 'Regole, diritti e opportunità per lavoro stagionale in Ticino: permessi, contratti, fiscalità.' },
  { keyword: 'frontaliere trasporto pubblico abbonamenti sconti', angle: 'Guida agli abbonamenti e sconti per frontalieri sui trasporti pubblici Ticino-Lombardia: treno, bus, agevolazioni.' },
  { keyword: 'lavorare come educatore dell\'infanzia in Ticino stipendio requisiti', angle: 'Guida completa per diventare educatore dell\'infanzia in Ticino: diploma SSS richiesto, stipendio CHF 73K–97K, LIS e altri datori di lavoro, processo per ottenere il Permesso G, confronto salariale con Italia e Germania' },
];

// ── News sources to auto-scan ───────────────────────────────
const NEWS_SOURCES = [
  // tvsvizzera
  'https://www.tvsvizzera.it/tvs/',
  'https://www.tvsvizzera.it/tvs/attualit%c3%a0/',
  'https://www.tvsvizzera.it/tvs/lavoro-ed-economia/',
  // ticinonews
  'https://www.ticinonews.ch/ticino',
  // tio.ch (RSS)
  'https://media.tio.ch/files/domains/tio.ch/rss/rss_ticino.xml',
  'https://media.tio.ch/files/domains/tio.ch/rss/rss_home.xml',
  // cdt
  'https://www.cdt.ch/news/ticino',
  // rsi.ch (RSS)
  'https://www.rsi.ch/info/ticino-grigioni-e-insubria/',
  'https://www.rsi.ch/info/ticino-e-grigioni-e-insubria/?f=rss',
  // laregione (RSS)
  'https://media.laregione.ch/files/domains/laregione.ch/rss/rss_ticino.xml',
  'https://media.laregione.ch/files/domains/laregione.ch/rss/rss_aperture.xml',
  'https://media.laregione.ch/files/domains/laregione.ch/rss/feed_rss.xml',
  // Canton Ticino istituzionale (RSS)
  'https://www3.ti.ch/xml/rss/rss-comunicati-1108.xml',
  'https://www3.ti.ch/xml/rss/rss-attualita.xml',
  // comozero
  'https://comozero.it/',
  'https://www.comozero.it/feed/',
  // varesenews (tag frontalieri + generale)
  'https://www.varesenews.it/tag/frontalieri/feed/',
  'https://www.varesenews.it/feed/',
  // varesenoi
  'https://www.varesenoi.it/rss.xml',
  // il giornale del ticino
  'https://www.ilgiornaledelticino.ch/feed/',
  // copertura categoria economia per aumentare topic finanziari/lavoro
  'https://www.cdt.ch/news/economia',
  'https://www.cdt.ch/news/svizzera',
  'https://www.tio.ch/ticino/economia',  // was /economia (404), fixed to /ticino/economia (FRO-415)
  'https://www.tio.ch/ticino/cronaca',
  'https://www.rsi.ch/info/economia/',
  'https://www.rsi.ch/info/svizzera/?f=rss',
  // swissinfo.ch RSS removed — 410 Gone (FRO-415)
  // admin.ch RSS removed — WAF challenge blocks scraping (FRO-415)
];

// Fallback: when an RSS feed yields 0 recent items, scrape the base HTML site instead
const RSS_FALLBACK_MAP = {
  'https://media.tio.ch/files/domains/tio.ch/rss/rss_ticino.xml': 'https://www.tio.ch/ticino',
  'https://media.tio.ch/files/domains/tio.ch/rss/rss_home.xml': 'https://www.tio.ch/',
  'https://www.rsi.ch/info/ticino-e-grigioni-e-insubria/?f=rss': 'https://www.rsi.ch/info/ticino-grigioni-e-insubria/',
  'https://media.laregione.ch/files/domains/laregione.ch/rss/rss_ticino.xml': 'https://www.laregione.ch/ticino',
  'https://media.laregione.ch/files/domains/laregione.ch/rss/rss_aperture.xml': 'https://www.laregione.ch/',
  'https://media.laregione.ch/files/domains/laregione.ch/rss/feed_rss.xml': 'https://www.laregione.ch/',
  'https://www3.ti.ch/xml/rss/rss-comunicati-1108.xml': 'https://www.ti.ch/comunicati',
  'https://www3.ti.ch/xml/rss/rss-attualita.xml': 'https://www.ti.ch/attualita',
  'https://www.comozero.it/feed/': 'https://www.comozero.it/',
  'https://www.varesenews.it/tag/frontalieri/feed/': 'https://www.varesenews.it/tag/frontalieri/',
  'https://www.varesenews.it/feed/': 'https://www.varesenews.it/',
  'https://www.varesenoi.it/rss.xml': 'https://www.varesenoi.it/sommario/argomenti/economia-7.html',
  'https://www.ilgiornaledelticino.ch/feed/': 'https://www.ilgiornaledelticino.ch',
  'https://www.rsi.ch/info/svizzera/?f=rss': 'https://www.rsi.ch/info/svizzera/',
  // swissinfo.ch removed — 410 Gone (FRO-415)
  // admin.ch removed — WAF challenge (FRO-415)
};

const PROJECT_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

// ── Helpers ─────────────────────────────────────────────────
function resolve(rel) {
  return `${PROJECT_ROOT}/${rel}`;
}

function read(rel) {
  return readFileSync(resolve(rel), 'utf-8');
}

function write(rel, content) {
  writeFileSync(resolve(rel), content, 'utf-8');
}

function getIsoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7; // Mon=1 .. Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // nearest Thursday
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function normalizeSourceDomain(domain) {
  return String(domain || '')
    .toLowerCase()
    .trim()
    .replace(/^www\d?\./, '');
}

// ── Source URL tracking: prevent re-using the same news source URL ─────
function loadSourceUrls() {
  try {
    const raw = read(SOURCE_URLS_FILE);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveSourceUrls(map) {
  try {
    // Keep only last 500 entries to avoid unbounded growth
    const entries = Object.entries(map);
    const trimmed = entries.length > 500
      ? Object.fromEntries(entries.slice(-500))
      : map;
    write(SOURCE_URLS_FILE, `${JSON.stringify(trimmed, null, 2)}\n`);
  } catch (e) {
    console.error(`  ⚠️  Impossibile salvare source URLs: ${e.message}`);
  }
}

/** Normalize a news source URL for dedup: strip query params, hash, trailing slash */
function normalizeNewsUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    // Remove tracking params, keep the path
    return `${u.protocol}//${u.hostname}${u.pathname}`.replace(/\/$/, '').toLowerCase();
  } catch {
    return rawUrl.toLowerCase().replace(/\/$/, '');
  }
}

/** Extract slug words from a URL path for fuzzy matching against article IDs */
function extractUrlSlugWords(rawUrl) {
  try {
    const u = new URL(rawUrl);
    // Get the last meaningful path segment (the article slug)
    const segments = u.pathname.split('/').filter(s => s.length > 0);
    const slug = segments[segments.length - 1] || '';
    // Remove numeric suffixes (article IDs like -427715)
    const cleaned = slug.replace(/-\d{4,}$/, '');
    return cleaned.split('-').filter(w => w.length > 1);
  } catch {
    return [];
  }
}

/** Check if a headline URL was already used for an existing article */
function isSourceUrlAlreadyUsed(headlineUrl) {
  const sourceUrls = loadSourceUrls();
  const normalized = normalizeNewsUrl(headlineUrl);
  // Exact match
  if (sourceUrls[normalized]) {
    return { used: true, articleId: sourceUrls[normalized], signal: 'exact_url' };
  }
  // Fuzzy URL slug vs existing article ID match
  const urlWords = extractUrlSlugWords(headlineUrl);
  if (urlWords.length < 2) return { used: false };

  // Load existing article IDs
  const routerSrc = read('services/routerBlogData.ts');
  const idMatch = routerSrc.match(/ALL_BLOG_ARTICLE_IDS.*?\[([^\]]+)\]/s);
  const existingIds = idMatch ? idMatch[1].match(/'([^']+)'/g)?.map(s => s.slice(1, -1)) || [] : [];

  for (const existingId of existingIds) {
    const idWords = existingId.split('-').filter(w => w.length > 1);
    if (idWords.length < 2) continue;
    // Compute Jaccard similarity between URL slug words and article ID words
    const setA = new Set(urlWords);
    const setB = new Set(idWords);
    const intersection = [...setA].filter(w => setB.has(w)).length;
    const union = new Set([...setA, ...setB]).size;
    const sim = union === 0 ? 0 : intersection / union;
    // Threshold 0.45: source URL slugs are very descriptive of the article content
    // e.g. "lavori-di-risanamento-sulla-a13-cadenazzo-s-antonino" vs "lavori-risanamento-a13-cadenazzo-2026"
    if (sim >= 0.45) {
      return { used: true, articleId: existingId, signal: 'url_slug_match', sim };
    }
  }
  return { used: false };
}

/** Record a source URL after successful article generation */
function recordSourceUrl(sourceUrl, articleId) {
  if (!sourceUrl || sourceUrl.startsWith('evergreen://')) return;
  const map = loadSourceUrls();
  const normalized = normalizeNewsUrl(sourceUrl);
  map[normalized] = articleId;
  saveSourceUrls(map);
  console.error(`  📎 Source URL registrata: ${normalized} → ${articleId}`);
}

function loadSourceQuotaState() {
  try {
    const raw = read(SOURCE_QUOTA_FILE);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid quota state');
    if (!parsed.weeks || typeof parsed.weeks !== 'object') parsed.weeks = {};

    // Keep state compact: retain only last 8 ISO weeks.
    const weekKeys = Object.keys(parsed.weeks).sort();
    const keep = new Set(weekKeys.slice(-8));
    for (const k of weekKeys) {
      if (!keep.has(k)) delete parsed.weeks[k];
    }
    return parsed;
  } catch {
    return { weeks: {} };
  }
}

function saveSourceQuotaState(state) {
  try {
    write(SOURCE_QUOTA_FILE, `${JSON.stringify(state, null, 2)}\n`);
  } catch (e) {
    console.error(`  ⚠️  Impossibile salvare quota fonti: ${e.message}`);
  }
}

function getWeeklySourceCount(domain) {
  const state = loadSourceQuotaState();
  const weekKey = getIsoWeekKey();
  return Number(state.weeks?.[weekKey]?.[normalizeSourceDomain(domain)] || 0);
}

function incrementWeeklySourceCount(domain) {
  const normalized = normalizeSourceDomain(domain);
  if (!normalized || normalized === 'evergreen') return;

  const state = loadSourceQuotaState();
  const weekKey = getIsoWeekKey();
  if (!state.weeks[weekKey]) state.weeks[weekKey] = {};
  state.weeks[weekKey][normalized] = Number(state.weeks[weekKey][normalized] || 0) + 1;
  saveSourceQuotaState(state);
  console.error(`  📈 Quota fonti aggiornata: ${normalized} = ${state.weeks[weekKey][normalized]}/${SOURCE_WEEKLY_QUOTA} (${weekKey})`);
}

function buildSourceQuotaPools(headlines) {
  if (!SOURCE_QUOTA_ENABLED) {
    return { inQuota: headlines, outOfQuota: [], quotaApplied: false, fallbackNeeded: false };
  }

  const withCounts = (headlines || []).map((h) => {
    const sourceDomain = normalizeSourceDomain(h.source);
    const weeklyCount = getWeeklySourceCount(sourceDomain);
    return { ...h, _sourceDomain: sourceDomain, _weeklyCount: weeklyCount };
  });

  const inQuota = withCounts
    .filter((h) => h._weeklyCount < SOURCE_WEEKLY_QUOTA)
    .sort((a, b) => a._weeklyCount - b._weeklyCount);
  const outOfQuota = withCounts
    .filter((h) => h._weeklyCount >= SOURCE_WEEKLY_QUOTA)
    .sort((a, b) => a._weeklyCount - b._weeklyCount);

  const uniqueOutDomains = [...new Set(outOfQuota.map((h) => h._sourceDomain))];
  if (withCounts.length > 0) {
    console.error(`  🧮 Source quota settimanale: max ${SOURCE_WEEKLY_QUOTA} articoli/dominio`);
    console.error(`     In quota: ${inQuota.length} headline | Out of quota: ${outOfQuota.length} headline`);
    if (uniqueOutDomains.length > 0) {
      console.error(`     Domini out of quota: ${uniqueOutDomains.join(', ')}`);
    }
  }

  return {
    inQuota,
    outOfQuota,
    quotaApplied: true,
    fallbackNeeded: inQuota.length === 0 && outOfQuota.length > 0,
  };
}

function buildDynamicEvergreenTopics() {
  const y = new Date().getFullYear();
  const pillars = [
    { k: `frontaliere tasse italia svizzera ${y}`, a: `Guida aggiornata ${y} sulla tassazione del frontaliere: regole pratiche, errori da evitare e casi reali.` },
    { k: `frontalieri busta paga svizzera ${y}`, a: `Analisi completa busta paga svizzera ${y}: trattenute, contributi e netto reale per frontalieri.` },
    { k: `frontaliere credito imposta ${y}`, a: `Credito d'imposta per frontalieri nel ${y}: calcolo, limiti e compilazione dichiarazione italiana.` },
    { k: `frontaliere cambio chf eur strategia ${y}`, a: `Strategie operative di cambio CHF-EUR nel ${y}: timing, rischio e strumenti pratici.` },
    { k: `frontaliere pensione avs inps ${y}`, a: `Pensione frontaliere ${y}: coordinamento AVS/INPS, finestre temporali e pianificazione.` },
    { k: `permesso g vs b frontalieri ${y}`, a: `Confronto tecnico tra Permesso G e B nel ${y}: quando conviene davvero cambiare status.` },
  ];
  const addOns = [
    'entro 20 km',
    'oltre 20 km',
    'famiglia con figli',
    'single',
    'simulazione pratica',
    'errori comuni',
  ];

  const out = [];
  for (const base of pillars) {
    out.push({ keyword: base.k, angle: base.a });
    for (const addon of addOns) {
      out.push({
        keyword: `${base.k} ${addon}`,
        angle: `${base.a} Focus su "${addon}" con checklist operativa e confronto scenari.`,
      });
    }
  }
  return out;
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((res) => {
    rl.question(question, (answer) => {
      rl.close();
      res(answer.trim());
    });
  });
}

function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function runShell(cmd) {
  try {
    execSync(cmd, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function optimizeImageToJpeg(inputPath, outputPath) {
  // Prefer a built-in optimizer for CI reliability (no system binaries required).
  try {
    const sharpModule = await import('sharp');
    const sharp = sharpModule.default || sharpModule;

    const encodeWithQuality = async (quality) => {
      return sharp(inputPath)
        .rotate()
        .resize({ width: 1200, height: 675, fit: 'cover', position: 'attention' })
        .jpeg({
          quality,
          progressive: true,
          mozjpeg: true,
          chromaSubsampling: '4:2:0',
        })
        .toBuffer();
    };

    const before = statSync(inputPath).size;
    let outBuffer = await encodeWithQuality(72);
    const qualityPasses = [68, 62, 56, 50];
    for (const q of qualityPasses) {
      if (outBuffer.length <= BLOG_IMAGE_TARGET_MAX_BYTES) break;
      outBuffer = await encodeWithQuality(q);
    }

    writeFileSync(outputPath, outBuffer);
    const after = outBuffer.length;
    return { ok: true, before, after };
  } catch {
    // Fallback to system binaries below.
  }

  const tools = {
    magick: commandExists('magick'),
    convert: commandExists('convert'),
    ffmpeg: commandExists('ffmpeg'),
    sips: commandExists('sips'),
    cwebp: commandExists('cwebp'),
  };

  const encodeCommands = [
    tools.magick && `magick "${inputPath}" -auto-orient -strip -interlace Plane -sampling-factor 4:2:0 -resize "1200x675^" -gravity center -extent 1200x675 -quality 72 "${outputPath}"`,
    tools.convert && `convert "${inputPath}" -auto-orient -strip -interlace Plane -sampling-factor 4:2:0 -resize "1200x675^" -gravity center -extent 1200x675 -quality 72 "${outputPath}"`,
    tools.ffmpeg && `ffmpeg -y -i "${inputPath}" -vf "scale=1200:675:force_original_aspect_ratio=increase,crop=1200:675" -q:v 4 -frames:v 1 "${outputPath}"`,
    tools.sips && `sips -s format jpeg --resampleWidth 1200 -s formatOptions 72 "${inputPath}" --out "${outputPath}"`,
  ].filter(Boolean);

  let encoded = false;
  for (const cmd of encodeCommands) {
    if (runShell(cmd)) {
      encoded = true;
      break;
    }
  }

  if (!encoded) {
    if (inputPath !== outputPath) copyFileSync(inputPath, outputPath);
  }

  if (!existsSync(outputPath)) return { ok: false, before: 0, after: 0 };
  const before = existsSync(inputPath) ? statSync(inputPath).size : statSync(outputPath).size;

  // Additional JPEG quality tuning to keep files lightweight without visible degradation.
  const qualityPasses = [68, 62, 56, 50];
  for (const q of qualityPasses) {
    const currentSize = statSync(outputPath).size;
    if (currentSize <= BLOG_IMAGE_TARGET_MAX_BYTES) break;

    const recompressCommands = [
      tools.magick && `magick "${outputPath}" -strip -interlace Plane -sampling-factor 4:2:0 -quality ${q} "${outputPath}"`,
      tools.convert && `convert "${outputPath}" -strip -interlace Plane -sampling-factor 4:2:0 -quality ${q} "${outputPath}"`,
      tools.sips && `sips -s format jpeg -s formatOptions ${q} "${outputPath}" --out "${outputPath}"`,
      tools.ffmpeg && `ffmpeg -y -i "${outputPath}" -q:v 6 -frames:v 1 "${outputPath}"`,
    ].filter(Boolean);

    let passDone = false;
    for (const cmd of recompressCommands) {
      if (runShell(cmd)) {
        passDone = true;
        break;
      }
    }
    if (!passDone) break;
  }

  // Generate WebP sidecar when available (future-proof for <picture> usage).
  if (tools.cwebp) {
    const webpPath = outputPath.replace(/\.jpg$/i, '.webp');
    runShell(`cwebp -quiet -q 72 "${outputPath}" -o "${webpPath}"`);
  }

  const after = statSync(outputPath).size;
  return { ok: true, before, after };
}

function truncateAtWordBoundary(text, maxLen) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen + 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), maxLen - 12)).trim().replace(/[,:;.\-–—\s]+$/, '');
}

const REQUIRED_IT_BODY_FIELDS = ['title', 'excerpt', 'body1', 'body2', 'body3'];

function normalizeItalianContentFromPayload(payload, locale = 'it') {
  const content = payload?.content;
  const candidates = [];

  if (content && typeof content === 'object') {
    if (content[locale] && typeof content[locale] === 'object') candidates.push(content[locale]);
    candidates.push(content);
  }
  candidates.push(payload);

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const block = {};
    let hasAnyField = false;

    for (const field of REQUIRED_IT_BODY_FIELDS) {
      const value = typeof candidate[field] === 'string' ? candidate[field].trim() : '';
      if (value) hasAnyField = true;
      block[field] = value;
    }

    if (hasAnyField) return block;
  }

  return null;
}

function validateItalianPayload(contentIt, locale = 'it') {
  for (const field of REQUIRED_IT_BODY_FIELDS) {
    if (!contentIt?.[field] || contentIt[field].trim().length < 1) {
      throw new Error(`Campo ${field} mancante per ${locale}`);
    }
  }

  if (contentIt.body2.trim().length < 40) {
    throw new Error(`Campo body2 troppo corto per ${locale}`);
  }
}

function assertTaxHealthConsistency(contentIt, sourceContext = null, pageContent = '') {
  const sourceBlob = `${sourceContext?.headline || ''} ${sourceContext?.url || ''} ${pageContent || ''}`.toLowerCase();
  // Apply guard only when the source topic is clearly about "tassa salute"
  if (!/tassa\s+(della\s+)?salute/.test(sourceBlob)) return;

  const articleText = [
    contentIt?.title || '',
    contentIt?.excerpt || '',
    contentIt?.body1 || '',
    contentIt?.body2 || '',
    contentIt?.body3 || '',
  ].join(' ').toLowerCase();

  // Known bad inversion seen in production:
  // "lavorano in Lombardia e risiedono in Ticino"
  const invertedAudiencePattern =
    /(lavor\w+\s+in\s+lombardia[\s\S]{0,160}(risied\w+|resident\w+)\s+in\s+ticino)|((risied\w+|resident\w+)\s+in\s+ticino[\s\S]{0,160}lavor\w+\s+in\s+lombardia)/i;

  if (invertedAudiencePattern.test(articleText)) {
    throw new Error('Articolo rigettato: platea tassa salute potenzialmente invertita (Lombardia↔Ticino).');
  }
}

/**
 * Fact-check: BLOCKING — reject articles with too many unsourced numbers.
 * Throws if > 50% of specific numbers in the article are not found in the source.
 * For evergreen articles (no source), blocks if > 3 suspiciously precise numbers are present.
 */
// factCheckNumbers() REMOVED — replaced by LLM-based fact-checking (llmFactCheck).
// Regex number comparison was fragile: legal reference numbers (D.Lgs 241/1997),
// convention years (1976), and known tax rates kept causing false positives.

// KNOWN_LEGAL_REFS removed — legal reference verification is now handled entirely
// by llmFactCheck() which has broader knowledge than a static whitelist.

// Patterns that signal fabricated content
const FABRICATED_INSTITUTION_PATTERNS = [
  /codice\s+federale\s+del\s+lavoro/i,
  /\bCFL\b(?!\s*[A-Z])/,
  /dipartimento\s+delle\s+entrate\b/i,
  /codice\s+federale\s+(?:della\s+)?(?:salute|sanità)/i,
  /ministero\s+(?:federale|cantonale)\s+del(?:la)?\s+(?:lavoro|salute|finanz)/i,
  /ufficio\s+federale\s+del(?:la)?\s+(?:lavoro\s+transfrontaliero|migrazione\s+lavorativa)/i,
  /legge\s+cantonale\s+(?:sui|del)\s+frontalier/i,
  /regolamento\s+ticinese\s+(?:del|sul)\s+lavoro/i,
  /commissione\s+(?:federale|cantonale)\s+(?:per\s+i\s+)?frontalier/i,
  /osservatorio\s+nazionale\s+(?:del|sulla)\s+sicurezza\s+(?:sul\s+)?lavoro/i,
  // Patterns from 45-article audit (April 2026)
  /commissione\s+di\s+bilancio\s+e\s+vigilanza\s+del\s+canton/i,
  /compagnia\s+di\s+assicurazione/i,
  /decreto\s+federale\s+sul\s+rispetto\s+ambientale/i,
  /\bDEMAS\b/,
  /legge\s+(?:federale\s+)?sulla\s+protezione\s+dell['']ambiente\s+e\s+della\s+sicurezza\s+pubblica/i,
  /legge\s+sulla\s+cooperazione\s+transfrontaliera/i,
  /tariffa\s+del\s+peccato/i,
  /\bSS\s+39\b(?!.*Alto\s+Adige)/i,  // SS 39 is in Alto Adige, not Ticino
  /\bSS\s+415\b/i,                    // Italian road designation, not Swiss
];

// Fabricated Swiss/Italian acronyms that LLMs love to invent
const FABRICATED_ACRONYMS = [
  { pattern: /\bUFOL\b/, real: 'SECO' },
  { pattern: /\bUWL\b/, real: 'SECO' },
  { pattern: /\bUSTTI\b/, real: 'USTAT' },
  { pattern: /\bUBSP\b/, real: 'UFSP/BAG' },
  { pattern: /\bONSSL\b/, real: 'SUVA' },
  { pattern: /\bROSSL\b/, real: 'SUVA' },
  { pattern: /\bLCFL\b/, real: 'LL/ArG' },
  { pattern: /\bLFP\b(?!\s*(?:pension|previd))/i, real: 'LPP' },
  { pattern: /\bRTL\b(?!\s*(?:radio|tv))/i, real: 'LL/ArG' },
  { pattern: /\bLTL\b/, real: 'LL/ArG' },
  { pattern: /\bCCFL\b/, real: 'non esiste' },
  { pattern: /\bUFML\b/, real: 'SEM' },
  // Patterns from 45-article audit (April 2026)
  { pattern: /\bUFIS\b/, real: 'UFSP/BAG (Ufficio federale della sanità pubblica)' },
  { pattern: /\bDLGS\s+299\/2006\b/i, real: 'legge inesistente' },
  { pattern: /\bD\.?Lgs\.?\s+299\/2006\b/i, real: 'legge inesistente' },
];

/**
 * BLOCKING — Detect fabricated legal references, fake institutions, and hallucinated laws.
 * Throws if the article contains references to non-existent laws or institutions.
 */
function assertNoFabricatedReferences(contentIt) {
  const articleText = [
    contentIt?.title || '',
    contentIt?.body1 || '', contentIt?.body2 || '', contentIt?.body3 || '',
  ].join(' ');
  const articleLower = articleText.toLowerCase();
  const issues = [];

  // Check for fabricated institutions
  for (const pattern of FABRICATED_INSTITUTION_PATTERNS) {
    if (pattern.test(articleText)) {
      issues.push(`istituzione inesistente: "${pattern.source}"`);
    }
  }

  // Check for fabricated Swiss acronyms
  for (const { pattern, real } of FABRICATED_ACRONYMS) {
    if (pattern.test(articleText)) {
      issues.push(`acronimo inventato "${pattern.source}" (reale: ${real})`);
    }
  }

  // Legal reference verification is handled by llmFactCheck() which understands
  // context (e.g., "Legge 78/2010" referring to DL 78/2010 is a minor type error,
  // not a fabrication). The LLM correctly identifies truly fabricated laws.

  // Check for suspiciously specific fake percentages with "tassa" context
  let m;
  const taxRatePattern = /tass[ae]\s+(?:\w+\s+){0,5}(\d{1,2}(?:[.,]\d+)?)\s*%/gi;
  while ((m = taxRatePattern.exec(articleLower)) !== null) {
    const rate = parseFloat(m[1].replace(',', '.'));
    if (rate === 10 && /tassa\s+(?:sulla\s+)?salute/i.test(m[0])) {
      issues.push('"tassa sulla salute del 10%" è un dato inventato');
    }
  }

  // Check for commonly hallucinated convention date
  if (/convenzione.*9\s+marzo\s+1976/i.test(articleText) || /9\s+marzo\s+1976.*convenzione/i.test(articleText)) {
    issues.push('Convenzione italo-svizzera: 9 dicembre 1976, non 9 marzo');
  }

  // Check for fabricated "secondo uno studio/sondaggio" with suspiciously precise percentages
  const fakeStudyPattern = /secondo\s+(?:uno\s+)?(?:studio|sondaggio|indagine|ricerca)\b[^.]{0,80}?(\d{2,3}[.,]\d+\s*%)/gi;
  while ((m = fakeStudyPattern.exec(articleLower)) !== null) {
    issues.push(`statistica inventata con fonte vaga: "${m[0].slice(0, 80)}..."`);
  }

  // Check for fabricated annual reports with precise numbers
  const fakeReportPattern = /(?:rapporto|report)\s+(?:annuale\s+)?(?:20\d{2})\s+(?:del(?:la|l')?)\s+\w+[^.]{0,100}?(\d{2,3}[.,]\d+\s*%)/gi;
  while ((m = fakeReportPattern.exec(articleLower)) !== null) {
    issues.push(`rapporto con percentuale sospetta: "${m[0].slice(0, 80)}..."`);
  }

  if (issues.length > 0) {
    const msg = issues.map((i, idx) => `  ${idx + 1}. ${i}`).join('\n');
    throw new Error(`Articolo rigettato — ${issues.length} problemi di veridicità:\n${msg}`);
  }
}

// ── Reference sheet of verified domain facts ──
// Fed into the LLM fact-check prompt so the model cross-checks against known-good data
// instead of relying solely on training data.
const VERIFIED_DOMAIN_FACTS = `
FATTI VERIFICATI DI RIFERIMENTO — usa come ground truth:

CONVENZIONI E ACCORDI:
- Convenzione italo-svizzera contro le doppie imposizioni: firmata 9 DICEMBRE 1976 (NON marzo, NON 1974)
- Nuovo Accordo Frontalieri: firmato 23 DICEMBRE 2020, in vigore dal 1° GENNAIO 2024
- Periodo transitorio: dal 2024 al 2033 (10 anni) per chi era già frontaliere prima del 17/7/2023
- Ratifica italiana: Legge 83 del 13 GIUGNO 2023

ALIQUOTE SVIZZERE:
- AVS/AI/IPG: 5.3% dipendente (10.6% totale)
- AD (AC): 1.1% fino a CHF 148'200 (2024)
- LAINF (LAA): 0.7%-1.5% (varia per settore)
- IGM (IJM): ~0.5%-1.0% (perdita guadagno malattia, non obbligatoria federale)
- LPP: dal 25 anni, contributi variabili per fascia d'età (7%-18% salario coordinato)

ALIQUOTE ITALIANE (2024-2026):
- IRPEF: 23% fino €28'000, 35% €28'001-€50'000, 43% oltre €50'000
- Franchigia nuovo accordo: €10'000 esenti per NUOVI frontalieri (dal 2024)
- Vecchi frontalieri (ante 17/7/2023): esenzione €7'500 fino al 2033

ISTITUZIONI REALI:
- Svizzera: SECO, SEM, SUVA, USTAT, UFSP (BAG in tedesco), SUPSI, USI, EOC, DFE, DSS, ARE, BFS
- Italia: INPS, Agenzia delle Entrate, MEF, Guardia di Finanza, INAIL
- Bilaterali: non sono "accordi EU-Svizzera" (la Svizzera NON è membro UE/EEA)
- BPS (SUISSE), UFAS, UFG, UDSC, Fedpol = istituzioni REALI

NUMERI FRONTALIERI:
- Frontalieri in Ticino: ~79'000 (USTAT, 2024) — circa 30% della forza lavoro cantonale
- Frontalieri totali CH: ~400'000
- Quota ristorno fiscale ai comuni italiani: 40% dell'imposta alla fonte (vecchio accordo)

GEOGRAFIA:
- Valichi principali: Brogeda (Chiasso), Gaggiolo (Stabio), Ponte Tresa, Dirinella (Gandria)
- Autostrade svizzere: A2 (Chiasso-Gottardo), A13 (San Bernardino)
- In Svizzera NON esistono "SS" (Strade Statali) — quelle sono italiane
- Comuni frontalieri TI: Chiasso, Mendrisio, Stabio, Balerna, Vacallo, Novazzano, Coldrerio

ASSICURAZIONI:
- LAMal: obbligatoria per residenti CH. Frontalieri G hanno diritto d'opzione (LAMal o sistema italiano)
- Franchige LAMal adulti: CHF 300, 500, 1'000, 1'500, 2'000, 2'500
- LAMAL non è "tassa sulla salute" — è assicurazione malattia
`;

/**
 * PRIMARY BLOCKING — Multi-model consensus fact verification.
 *
 * Queries 2 DIFFERENT verification models and requires CONSENSUS to pass.
 * If either model finds critical issues, the article is blocked.
 * This prevents a single model from hallucinating "PASS" on fabricated content.
 *
 * Returns { passed: boolean, issues: object[] }
 */
async function llmFactCheck(contentIt, sourceContent = '', sourceUrl = '') {
  const articleText = [
    contentIt?.title || '',
    contentIt?.excerpt || '',
    contentIt?.body1 || '', contentIt?.body2 || '', contentIt?.body3 || '',
  ].join('\n\n');

  const isEvergreen = !sourceContent || sourceContent.length < 100 || sourceUrl.startsWith('evergreen://');

  const prompt = `Sei un fact-checker senior specializzato in diritto fiscale svizzero e italiano, con focus specifico su frontalieri e Canton Ticino.

ARTICOLO DA VERIFICARE:
"""
${articleText.slice(0, 8000)}
"""

${isEvergreen ? 'NOTA: Articolo evergreen senza fonte specifica. Verifica basandoti sulle tue conoscenze del dominio e sui fatti di riferimento sotto.' : `FONTE ORIGINALE (l'articolo doveva basarsi su questo testo):\n"""\n${sourceContent.slice(0, 6000)}\n"""`}

${VERIFIED_DOMAIN_FACTS}

VERIFICA SISTEMATICA — controlla OGNI categoria:

1. **LEGGI E DECRETI**: Ogni riferimento normativo (D.Lgs, DL, DPR, L.) deve esistere realmente con numero e anno corretti. Verifica che il contenuto attribuito alla legge sia corretto. Confronta con i fatti verificati sopra. ${isEvergreen ? '' : 'Se il riferimento NON è presente nella fonte originale, segnalalo come sospetto.'}

2. **ISTITUZIONI E ENTI**: Ogni istituzione menzionata deve esistere realmente. Confronta con la lista di istituzioni reali nei fatti verificati. Segnala qualsiasi acronimo NON presente in quella lista come sospetto. NON esiste: "Codice federale del lavoro", "CFL", "UFOL", "UWL", "Commissione federale per i frontalieri", "Ufficio federale dell'integrazione sanitaria (UFIS)".

3. **ALIQUOTE E CIFRE FISCALI**: Confronta OGNI aliquota con i valori nei fatti verificati. AVS=5.3%, AC=1.1%, IRPEF 23%/35%/43%. Se un'aliquota non corrisponde = critical.

4. **STATISTICHE E PERCENTUALI**: Percentuali precise con decimali (es. "il 73,2% dei frontalieri") DEVONO provenire da studi reali citati per nome E ISTITUTO. Senza attribuzione precisa = probabile invenzione. ECCEZIONE: arrotondamenti a numeri interi da fonti note (es. "circa il 30% della forza lavoro" da USTAT) sono accettabili.

5. **DATE E EVENTI**: Confronta con le date verificate: Convenzione 9/12/1976, Nuovo Accordo 23/12/2020, vigenza dal 1/1/2024, Legge 83/2023. ${isEvergreen ? '' : 'Date presenti nell\'articolo ma ASSENTI dalla fonte = altamente sospette.'}

6. **COERENZA CON LA FONTE**: ${isEvergreen ? 'N/A per evergreen.' : "VERIFICA CRITICA: confronta ogni affermazione dell'articolo con la fonte originale. Se l'articolo aggiunge fatti, cifre, date o dichiarazioni NON presenti nella fonte, segnalali come 'critical'. L'articolo doveva RISCRIVERE la fonte, non aggiungere informazioni inventate."}

7. **FATTI INVENTATI**: Cerca eventi, conferenze, referendum, proteste, dichiarazioni che sembrano plausibili ma potrebbero non essere mai avvenuti. SEGNALE D'ALLARME: eventi descritti con molti dettagli specifici (data precisa, luogo, partecipanti) che non appaiono in nessuna fonte nota.

8. **NOMI DI PERSONE E CITAZIONI**: Verifica che ogni persona citata (politici, consiglieri federali, funzionari) esista realmente con il ruolo indicato. Consiglieri federali attuali (2024-2027): Baume-Schneider, Parmelin, Cassis, Keller-Sutter, Amherd, Jans, Rösti. Citazioni dirette ("ha dichiarato:") di persone non verificabili sono quasi sempre inventate dall'IA.

9. **SVIZZERA ≠ UE**: La Svizzera NON è membro dell'Unione Europea né dello Spazio Economico Europeo (SEE/EEA). Frasi come "accordo EU-Svizzera", "normativa UE applicabile in Svizzera" o "la Svizzera come membro" sono ERRORI. I rapporti sono regolati da Accordi Bilaterali I (1999) e II (2004).

10. **PATTERN COMUNI DI HALLUCINATION IA**: Segnala come "critical" se trovi:
   - Decreti/leggi con acronimi inventati (DEMAS, LCFL, CFL, ecc.)
   - "Commissione" o "Osservatorio" con nomi troppo specifici e mai sentiti
   - Percentuali precise con decimali senza attribuzione a fonte reale
   - Leggi "entrate in vigore nel 20XX" senza numero di legge verificabile
   - "Tassa sulla salute" come imposta separata (non esiste — la LAMal è un'assicurazione)
   - Ministri o funzionari con nomi plausibili ma non verificabili
   - Accordi/protocolli bilaterali mai firmati (controllare attentamente)

CRITERI DI GIUDIZIO STRETTI:
- "critical" = fatto verificabilmente FALSO, o CONTRADDICE i fatti verificati di riferimento, o ASSENTE dalla fonte originale (legge inesistente, istituzione inventata, aliquota sbagliata, evento mai avvenuto)
- "major" = fatto sospetto non verificabile con certezza (percentuale senza fonte, dato plausibile ma non confermabile)
- "minor" = imprecisione che non fuorvia il lettore (arrotondamento, data approssimata)
- FAIL = almeno 1 critical O almeno 2 major
- PASS = nessun fatto verificabilmente falso, al massimo minor

ATTENZIONE: se hai dubbi su un fatto, è MEGLIO segnalarlo come "major" che ignorarlo. Un falso positivo (segnalare un fatto vero come sospetto) è preferibile a un falso negativo (non segnalare un fatto falso).

Rispondi SOLO in JSON valido:
{
  "verdict": "PASS" | "FAIL",
  "confidence": 0.0-1.0,
  "issues": [
    { "claim": "testo dell'affermazione", "reason": "perché è problematica", "severity": "critical|major|minor", "category": "categoria" }
  ]
}

Categorie valide: leggi, istituzioni, aliquote, statistiche, date, coerenza, fatti_inventati, persone, geografia, eu_svizzera`;

  // ── Multi-model consensus: query 2 models, require agreement ──
  const verificationModels = [
    AI_MODELS.GPT_4_1,
    AI_MODELS.GPT4O,
    AI_MODELS.GEMINI_FLASH,
  ].filter(Boolean);

  const modelResults = [];

  // Query up to 2 models in parallel for consensus
  const modelsToQuery = verificationModels.slice(0, 2);
  const promises = modelsToQuery.map(model => _runSingleFactCheck(model, prompt));
  const settled = await Promise.allSettled(promises);

  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === 'fulfilled' && s.value) {
      modelResults.push({ model: modelsToQuery[i], ...s.value });
    } else {
      const reason = s.status === 'rejected' ? s.reason?.message : 'no result';
      console.error(`  ⚠️  LLM fact-check (${modelsToQuery[i]}): fallito — ${reason}`);
    }
  }

  // If both primary models failed, try fallback
  if (modelResults.length === 0 && verificationModels.length > 2) {
    try {
      const fallback = await _runSingleFactCheck(verificationModels[2], prompt);
      if (fallback) modelResults.push({ model: verificationModels[2], ...fallback });
    } catch (err) {
      console.error(`  ⚠️  LLM fact-check fallback (${verificationModels[2]}): ${err.message}`);
    }
  }

  if (modelResults.length === 0) {
    console.error('  🚨 LLM fact-check: TUTTI i modelli di verifica hanno fallito — articolo bloccato per sicurezza');
    throw new Error('Fact-check impossibile: tutti i modelli di verifica non disponibili. Articolo bloccato per precauzione.');
  }

  // ── Consensus logic ──
  // Merge all critical/major issues found by ANY model (union of issues)
  const allCritical = [];
  const allMajor = [];
  const seenClaims = new Set();

  for (const r of modelResults) {
    for (const issue of r.issues) {
      // Deduplicate by claim text similarity (first 60 chars)
      const key = (issue.claim || '').slice(0, 60).toLowerCase().replace(/\s+/g, ' ');
      if (seenClaims.has(key)) continue;
      seenClaims.add(key);

      if (issue.severity === 'critical') allCritical.push(issue);
      else if (issue.severity === 'major') allMajor.push(issue);
    }
  }

  // Log per-model results
  for (const r of modelResults) {
    console.error(`  🔍 LLM fact-check (${r.model}): verdict=${r.verdict} confidence=${r.confidence.toFixed(2)} issues=${r.issues.length} (critical=${r.issues.filter(i => i.severity === 'critical').length}, major=${r.issues.filter(i => i.severity === 'major').length})`);
    for (const issue of r.issues) {
      console.error(`     ${issue.severity === 'critical' ? '🚨' : '⚠️'}  [${issue.category || '?'}] "${(issue.claim || '').slice(0, 80)}" — ${(issue.reason || '').slice(0, 100)}`);
    }
  }

  // BLOCKING: ANY model found critical issues → block
  if (allCritical.length > 0) {
    console.error(`  🚨 Consensus: ${allCritical.length} critical issues trovati — BLOCCATO`);
    return { passed: false, issues: allCritical };
  }

  // BLOCKING: 2+ major issues (lowered from 3 — stricter)
  if (allMajor.length >= 2) {
    console.error(`  🚨 Consensus: ${allMajor.length} major issues — BLOCCATO`);
    return { passed: false, issues: allMajor };
  }

  // If only 1 model ran and it said FAIL with low confidence, still block
  if (modelResults.length === 1 && modelResults[0].verdict === 'FAIL') {
    const r = modelResults[0];
    if (r.confidence >= 0.5 && (r.issues.filter(i => i.severity !== 'minor').length > 0)) {
      console.error(`  ⚠️  Single-model FAIL (${r.model}, confidence=${r.confidence.toFixed(2)}) — BLOCCATO per precauzione`);
      return { passed: false, issues: r.issues.filter(i => i.severity !== 'minor') };
    }
  }

  // Warn if there are major issues but not enough to block
  if (allMajor.length > 0) {
    console.error(`  ⚠️  Consensus: ${allMajor.length} major issue(s) — accettato con warning`);
  }

  return { passed: true, issues: [...allCritical, ...allMajor] };
}

/**
 * Run a single fact-check against one model. Returns parsed result or null.
 */
async function _runSingleFactCheck(model, prompt) {
  const raw = await callLLM(
    [{ role: 'user', content: prompt }],
    { model, temperature: 0.0, maxTokens: 4000, timeout: 120_000 }
  );

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error(`  ⚠️  LLM fact-check (${model}): risposta non JSON`);
    return null;
  }

  let result;
  try {
    result = JSON.parse(jsonMatch[0]);
  } catch {
    console.error(`  ⚠️  LLM fact-check (${model}): JSON non valido`);
    return null;
  }

  const verdict = (result.verdict || '').toUpperCase();
  const confidence = Number(result.confidence) || 0;
  const issues = Array.isArray(result.issues) ? result.issues : [];

  return { verdict, confidence, issues };
}

// assertNoFabricatedStatistics() REMOVED — replaced by LLM-based fact-checking.
// The LLM understands context ("73,2% dei frontalieri" is likely fabricated vs
// "5,3% AVS" is a real rate) far better than regex pattern matching.

// ── LLM call with body2 validation (model fallback via centralized ai-models.mjs) ──
async function callLLM(messages, opts = {}) {
  const maxBody2Retries = 5;
  const isBody2Check = opts.jsonMode && messages.some(m => m.content?.includes('body2'));
  for (let attempt = 1; attempt <= maxBody2Retries; attempt++) {
    const result = await _aiCallLLM(messages, { temperature: 0.7, maxTokens: 4000, timeout: 120_000, ...opts });
    if (isBody2Check) {
      let itContent = null;
      try {
        const parsed = JSON.parse(result.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim());
        itContent = normalizeItalianContentFromPayload(parsed);
      } catch {
        itContent = null;
      }

      const missing = [];
      if (!itContent) {
        missing.push('content.it non normalizzabile');
      } else {
        for (const field of REQUIRED_IT_BODY_FIELDS) {
          if (!itContent?.[field] || itContent[field].length < 1) {
            missing.push(field);
          }
        }
        if (itContent.body2 && itContent.body2.trim().length < 40) missing.push('body2<40');
      }

      if (missing.length > 0) {
        console.error(`  ⚠️  output JSON incompleto: ${missing.join(', ')} (tentativo ${attempt}/${maxBody2Retries}) — rigenero...`);
        if (attempt < maxBody2Retries) continue;
      }
    }
    return result;
  }
  throw new Error(`Output JSON non valido dopo ${maxBody2Retries} tentativi con validazione jsonMode`);
}

/** Convert article id like "tassa-salute-ticino" to camelCase slug key "blogTassaSaluteTicino" */
function idToSlugKey(id) {
  const camel = id.replace(/-(\w)/g, (_, c) => c.toUpperCase());
  return 'blog' + camel.charAt(0).toUpperCase() + camel.slice(1);
}

// ── Step 1: Fetch web page content ──────────────────────────
async function fetchPageContent(url) {
  // Handle evergreen topics — no URL to fetch, use keyword angle as content
  if (url.startsWith('evergreen://')) {
    const keyword = process.env._EVERGREEN_KEYWORD || decodeURIComponent(url.replace('evergreen://', ''));
    const angle = process.env._EVERGREEN_ANGLE || '';
    console.error(`📚 Articolo evergreen: "${keyword}"`);
    return `[ARTICOLO EVERGREEN SEO]\nKeyword target: ${keyword}\nAngolo editoriale: ${angle}\n\nGenera un articolo approfondito e pratico ottimizzato per questa keyword long-tail. Includi dati specifici, cifre reali 2026, esempi concreti per frontalieri Ticino.`;
  }
  console.error(`📰 Fetching: ${url}`);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    // Strip tags, keep text, truncate to ~8000 chars to fit Gemini context
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000);
    return text;
  } catch (e) {
    console.error(`⚠️  Impossibile scaricare la pagina: ${e.message}`);
    console.error('   L\'articolo verrà generato senza contesto dalla pagina web.');
    return '';
  }
}

// ── Date filtering: only articles from the last 3 days ──────
const MAX_ARTICLE_AGE_DAYS = 3;

/** Try to extract a publication date from a URL path (e.g. /2026/02/18/ or /20260218/) */
function extractDateFromUrl(url) {
  // Pattern: /YYYY/MM/DD/ in path
  const slashDate = url.match(/\/(20\d{2})\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])/);
  if (slashDate) {
    return new Date(`${slashDate[1]}-${slashDate[2]}-${slashDate[3]}T00:00:00`);
  }
  // Pattern: /YYYYMMDD/ in path
  const compactDate = url.match(/\/(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/);
  if (compactDate) {
    return new Date(`${compactDate[1]}-${compactDate[2]}-${compactDate[3]}T00:00:00`);
  }
  return null;
}

/** Build a map of URL → date from <time> elements found near <a> links in the HTML */
function extractDatesFromHtml(html) {
  const dateMap = new Map();
  // Match <time datetime="..."> anywhere in HTML — build global date context
  const timeRe = /<time[^>]*datetime=["']([^"']+)["'][^>]*>/gi;
  let tm;
  while ((tm = timeRe.exec(html)) !== null) {
    const dateStr = tm[1];
    const pos = tm.index;
    // Find the nearest <a href> within 500 chars before or after this <time>
    const context = html.slice(Math.max(0, pos - 500), pos + 500);
    const nearbyLink = context.match(/href=["'](https?:\/\/[^"']+)["']/);
    if (nearbyLink) {
      try {
        const d = new Date(dateStr);
        if (!isNaN(d.getTime())) dateMap.set(nearbyLink[1], d);
      } catch { /* skip invalid dates */ }
    }
  }
  return dateMap;
}

/** Check if a date is within the last N days */
function isWithinDays(date, days) {
  if (!date) return false;
  const now = new Date();
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return date >= cutoff;
}

// ── Step 1b: Extract links and headlines from an HTML page ──
function extractHeadlines(html, baseUrl) {
  const results = [];
  const htmlDateMap = extractDatesFromHtml(html);
  // Match <a href="...">text</a> — capture href and inner text
  const linkRe = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    let href = m[1];
    const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    // Only keep links with meaningful text (likely headlines)
    if (text.length < 15 || text.length > 300) continue;
    // Resolve relative URLs
    try {
      href = new URL(href, baseUrl).href;
    } catch { continue; }
    // Skip anchor links, javascript, mailto, etc.
    if (!href.startsWith('http')) continue;
    // Skip non-article links (categories, tags, pagination, login, etc.)
    if (/\/(tag|categor|page|login|registr|cookie|privacy|contatt|archiv|abonn)/i.test(href)) continue;
    // Extract date from URL path or from nearby <time> elements
    const date = extractDateFromUrl(href) || htmlDateMap.get(href) || null;
    results.push({ url: href, headline: text, date });
  }
  // Deduplicate by URL
  const seen = new Set();
  return results.filter(r => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

// ── Step 1b-bis: Extract items from RSS/Atom XML feeds ──────
/** Detect whether content is RSS/Atom XML */
function isRssFeed(content) {
  const head = content.slice(0, 500);
  return /<rss[\s>]/i.test(head)
    || /<feed[\s>]/i.test(head)
    || (/<\?xml/i.test(head) && /<channel[\s>]/i.test(content.slice(0, 2000)));
}

/** Parse RSS/Atom XML and return { url, headline, date }[] — same shape as extractHeadlines */
function extractRssItems(xml, feedUrl) {
  const results = [];
  const isAtom = /<feed[\s>]/i.test(xml.slice(0, 500));

  if (isAtom) {
    // Atom: <entry><title>…</title><link href="…"/><updated>…</updated></entry>
    const entryRe = /<entry[\s>][\s\S]*?<\/entry>/gi;
    let em;
    while ((em = entryRe.exec(xml)) !== null) {
      const block = em[0];
      const title = block.match(/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title[^>]*>([\s\S]*?)<\/title>/i);
      const link = block.match(/<link[^>]*href=["']([^"']+)["']/i)
        || block.match(/<link[^>]*>([^<]+)<\/link>/i);
      const date = block.match(/<updated>([^<]+)<\/updated>/i)
        || block.match(/<published>([^<]+)<\/published>/i);
      const headline = (title?.[1] || title?.[2] || '').replace(/<[^>]+>/g, '').trim();
      const href = (link?.[1] || '').trim();
      if (!headline || headline.length < 10 || !href) continue;
      let parsedDate = null;
      if (date?.[1]) { try { parsedDate = new Date(date[1]); if (isNaN(parsedDate.getTime())) parsedDate = null; } catch { parsedDate = null; } }
      results.push({ url: href, headline, date: parsedDate });
    }
  } else {
    // RSS 2.0: <item><title>…</title><link>…</link><pubDate>…</pubDate></item>
    const itemRe = /<item[\s>][\s\S]*?<\/item>/gi;
    let im;
    while ((im = itemRe.exec(xml)) !== null) {
      const block = im[0];
      const title = block.match(/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title[^>]*>([\s\S]*?)<\/title>/i);
      const link = block.match(/<link[^>]*>\s*<!\[CDATA\[([^\]]+)\]\]>\s*<\/link>|<link[^>]*>\s*([^<\s]+)\s*<\/link>/i);
      const date = block.match(/<pubDate>([^<]+)<\/pubDate>/i)
        || block.match(/<dc:date>([^<]+)<\/dc:date>/i)
        || block.match(/<date>([^<]+)<\/date>/i);
      const headline = (title?.[1] || title?.[2] || '').replace(/<[^>]+>/g, '').trim();
      let href = (link?.[1] || link?.[2] || '').trim();
      if (!headline || headline.length < 10) continue;
      // Resolve relative URLs
      if (href) { try { href = new URL(href, feedUrl).href; } catch { /* keep as-is */ } }
      if (!href || !href.startsWith('http')) continue;
      let parsedDate = null;
      if (date?.[1]) { try { parsedDate = new Date(date[1].trim()); if (isNaN(parsedDate.getTime())) parsedDate = null; } catch { parsedDate = null; } }
      results.push({ url: href, headline, date: parsedDate });
    }
  }

  // Deduplicate by URL
  const seen = new Set();
  return results.filter(r => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

// ── Step 1c: Scan all news sources for recent headlines ─────
async function scanNewsSources() {
  console.error('🔍 Scansione fonti di notizie ticinesi...\n');
  const allHeadlines = [];
  RUN_REPORT.sources.configured = NEWS_SOURCES.length;
  RUN_REPORT.sources.scanned = NEWS_SOURCES.length;
  RUN_REPORT.sources.domains = NEWS_SOURCES.map((u) => {
    try { return new URL(u).hostname.replace(/^www\d?\./, ''); } catch { return u; }
  });

  const fetches = NEWS_SOURCES.map(async (sourceUrl) => {
    const domain = new URL(sourceUrl).hostname.replace('www.', '').replace('www3.', '');
    try {
      const res = await fetch(sourceUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'application/rss+xml, application/xml, text/xml, text/html, application/xhtml+xml',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const content = await res.text();

      let headlines;
      if (isRssFeed(content)) {
        // ── RSS/Atom feed: use dedicated parser ──
        headlines = extractRssItems(content, sourceUrl);
        // Filter RSS items to last 3 days (RSS has reliable dates)
        const recent = headlines.filter(h => h.date && isWithinDays(h.date, MAX_ARTICLE_AGE_DAYS));
        if (recent.length > 0) {
          console.error(`  📡 ${domain}: ${recent.length} articoli RSS recenti (${headlines.length} totali)`);
          headlines = recent;
        } else if (headlines.length > 0) {
          console.error(`  📡 ${domain}: ${headlines.length} articoli RSS (nessuno negli ultimi ${MAX_ARTICLE_AGE_DAYS} giorni)`);
          // Fallback: scrape the base HTML site for this feed
          const fallbackUrl = RSS_FALLBACK_MAP[sourceUrl];
          if (fallbackUrl) {
            try {
              const fbRes = await fetch(fallbackUrl, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                  'Accept': 'text/html,application/xhtml+xml',
                },
                signal: AbortSignal.timeout(15000),
              });
              if (fbRes.ok) {
                const fbHtml = await fbRes.text();
                headlines = extractHeadlines(fbHtml, fallbackUrl);
                console.error(`  🌐 ${domain}: HTML fallback → ${headlines.length} articoli da ${new URL(fallbackUrl).hostname}`);
              }
            } catch (fbErr) {
              console.error(`  ⚠️ ${domain}: fallback HTML fallito: ${fbErr.message}`);
            }
          } else {
            // No fallback — use all RSS items even if older
            console.error(`  📡 ${domain}: nessun fallback, uso tutti gli articoli RSS`);
          }
        } else {
          console.error(`  📡 ${domain}: RSS vuoto (0 articoli)`);
          // Try fallback HTML
          const fallbackUrl = RSS_FALLBACK_MAP[sourceUrl];
          if (fallbackUrl) {
            try {
              const fbRes = await fetch(fallbackUrl, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                  'Accept': 'text/html,application/xhtml+xml',
                },
                signal: AbortSignal.timeout(15000),
              });
              if (fbRes.ok) {
                const fbHtml = await fbRes.text();
                headlines = extractHeadlines(fbHtml, fallbackUrl);
                console.error(`  🌐 ${domain}: HTML fallback → ${headlines.length} articoli`);
              }
            } catch (fbErr) {
              console.error(`  ⚠️ ${domain}: fallback HTML fallito: ${fbErr.message}`);
            }
          }
        }
      } else {
        // ── HTML page: use existing <a href> parser ──
        headlines = extractHeadlines(content, sourceUrl);
        console.error(`  🌐 ${domain}: ${headlines.length} articoli HTML`);
      }

      RUN_REPORT.sources.succeeded += 1;
      return (headlines || []).map(h => ({ ...h, source: domain }));
    } catch (e) {
      console.error(`  ⚠️ ${domain}: ${e.message}`);
      RUN_REPORT.sources.failed += 1;
      return [];
    }
  });

  const results = await Promise.all(fetches);
  for (const batch of results) {
    allHeadlines.push(...batch);
  }

  console.error(`\n  📊 Totale: ${allHeadlines.length} articoli trovati da ${NEWS_SOURCES.length} fonti`);

  // Filter: only keep articles from the last 3 days
  const recent = allHeadlines.filter(h => {
    if (!h.date) return false; // skip undated articles — can't verify recency
    return isWithinDays(h.date, MAX_ARTICLE_AGE_DAYS);
  });
  const undated = allHeadlines.filter(h => !h.date);
  RUN_REPORT.headlines.total = allHeadlines.length;
  RUN_REPORT.headlines.recent = recent.length;
  RUN_REPORT.headlines.undated = undated.length;

  console.error(`  📅 Filtro ultimi ${MAX_ARTICLE_AGE_DAYS} giorni: ${recent.length} articoli recenti\n`);
  if (undated.length > 0) {
    console.error(`  🕒 Articoli senza data esplicita: ${undated.length} (usati come fallback a bassa priorità)\n`);
  }

  // If no recent articles found, fall back to all headlines (homepage articles are likely recent)
  if (recent.length === 0) {
    console.error('  ⚠️  Nessun articolo con data negli ultimi 3 giorni — uso tutti gli headline\n');
    RUN_REPORT.headlines.usedRecent = 0;
    RUN_REPORT.headlines.usedUndated = undated.length;
    return prioritizeFrontalieriHeadlines(allHeadlines);
  }

  const undatedTop = undated.slice(0, 120).map(h => ({ ...h, _undatedFallback: true }));
  RUN_REPORT.headlines.usedRecent = recent.length;
  RUN_REPORT.headlines.usedUndated = undatedTop.length;
  return prioritizeFrontalieriHeadlines([...recent, ...undatedTop]);
}

// ── Frontalieri relevance pre-filter ────────────────────────
// Keywords that indicate an article is directly relevant to cross-border workers.
// Headlines matching these get boosted to the top of the list so Gemini picks from
// frontalieri-specific news first. If none match, we fall back to all headlines.
const FRONTALIERI_KEYWORDS = [
  'frontalier',     // covers frontaliere, frontalieri, frontaliero
  'transfrontalier', // transfrontaliero/a/i/e
  'cross-border',
  'grenzgänger',
  'pendolare',      // pendolari transfrontalieri
  'permesso g',
  'permesso b',
  'permesso di lavoro',
  'imposta alla fonte',
  'ristorn',        // ristorni, ristorno
  'nuovo accordo',  // nuovo accordo fiscale CH-IT
  'accordo fiscale',
  'dogana',         // dogana, doganale
  'valico',         // valichi di confine
  'brogeda',
  'gaggiolo',
  'ponte tresa',
  'chiasso',
  'lavoro svizzer', // lavoro svizzero, in svizzera
  'lavoro in ticino',
  'stipendio svizzer',
  'tassazione italo-svizzer',
  'lamal',
  'cassa malati',
  'avs',
  'secondo pilastro',
  'terzo pilastro',
  'doppia imposizione',
];

/** Split headlines into frontalieri-relevant (boosted) + rest, return boosted first */
function prioritizeFrontalieriHeadlines(headlines) {
  const boosted = [];
  const rest = [];

  for (const h of headlines) {
    const text = h.headline.toLowerCase();
    const url = h.url.toLowerCase();
    const isFrontalieri = FRONTALIERI_KEYWORDS.some(kw => text.includes(kw) || url.includes(kw));
    if (isFrontalieri) {
      boosted.push({ ...h, _frontalieriBoosted: true });
    } else {
      rest.push(h);
    }
  }

  if (boosted.length > 0) {
    console.error(`  🎯 Pre-filtro frontalieri: ${boosted.length} articoli direttamente rilevanti (su ${headlines.length} totali)`);
    console.error(`     Keyword trovate negli headline: ${boosted.map(h => `"${h.headline.slice(0, 60)}…"`).slice(0, 5).join(', ')}`);
    // Return boosted first, then the rest — Gemini will see the most relevant ones at the top
    return [...boosted, ...rest];
  }

  console.error(`  ℹ️  Nessun headline con keyword frontalieri esplicita — uso tutti gli ${headlines.length} articoli`);
  return headlines;
}

// ── Step 1d: Use Gemini to select the best article ──────────
async function selectArticle(headlines) {
  // Get existing article info for duplicate detection
  const routerSrc = read('services/routerBlogData.ts');
  const idMatch = routerSrc.match(/ALL_BLOG_ARTICLE_IDS.*?\[([^\]]+)\]/s);
  const existingIds = idMatch ? idMatch[1].match(/'([^']+)'/g)?.map(s => s.slice(1, -1)) || [] : [];

  // Get existing article titles AND excerpts from blog-meta-it.ts for robust duplicate detection
  const blogItSrc = read('services/locales/blog-meta-it.ts');
  const titleMatches = [...blogItSrc.matchAll(/'blog\.article\.([^.]+)\.title':\s*'([^']+)'/g)];
  const excerptMatches = [...blogItSrc.matchAll(/'blog\.article\.([^.]+)\.excerpt':\s*'([^']+)'/g)];
  const existingTitles = titleMatches.map(m => m[2]);
  // Build compact "title — excerpt" list for last 30 articles (most relevant for duplicate avoidance)
  const recentArticles = titleMatches.slice(-30).map(m => {
    const exMatch = excerptMatches.find(e => e[1] === m[1]);
    return `• [${m[1]}] ${m[2]}${exMatch ? ' — ' + exMatch[2].slice(0, 100) : ''}`;
  }).join('\n');

  // Chunking: if too many headlines, split into batches to avoid token overflow
  const MAX_HEADLINES_PER_BATCH = 50;
  let trimmed = headlines.slice(0, 500);
  let batchWinners = [];
  if (trimmed.length > MAX_HEADLINES_PER_BATCH) {
    // Split into batches
    const batches = [];
    for (let i = 0; i < trimmed.length; i += MAX_HEADLINES_PER_BATCH) {
      batches.push(trimmed.slice(i, i + MAX_HEADLINES_PER_BATCH));
    }
    // Run LLM selection for each batch
    for (const [batchIdx, batch] of batches.entries()) {
      const headlineList = batch.map((h, i) => {
        const tag = h._frontalieriBoosted ? ' ⭐FRONTALIERI' : '';
        const recencyTag = h._undatedFallback ? ' ⏳UNDATED' : '';
        return `[${i}] (${h.source}${tag}${recencyTag}) ${h.headline}`;
      }).join('\n');
      const prompt = `Sei un editor del sito Frontaliere Ticino (frontaliereticino.ch).
Devi scegliere UN articolo da queste headline di notizie ticinesi per scrivere un pezzo per i frontalieri.

HEADLINE DISPONIBILI:
${headlineList}

ARTICOLI GIÀ PUBBLICATI (NON scegliere argomenti simili o già coperti):
${recentArticles}

CRITERI DI SELEZIONE (in ordine di priorità):
1. ⭐ PRIORITÀ ASSOLUTA: Se ci sono headline marcate con ⭐FRONTALIERI, scegli TRA QUELLE — sono notizie che menzionano esplicitamente frontalieri, permessi, accordi fiscali, dogane o lavoro transfrontaliero
2. RILEVANZA FRONTALIERI: Priorità a notizie su lavoro transfrontaliero, fisco, permessi, stipendi, accordi CH-IT, economia ticinese, mercato del lavoro, trasporti transfrontalieri
2.1 CLUSTER SEO PRIORITARI: favorisci headline che possono intercettare query ad alta intenzione su:
   - calcolo tasse frontalieri entro/oltre 20km
   - pensione frontaliere (AVS/INPS, pilastri)
   - cambio CHF EUR e ottimizzazione conversione
3. NOVITÀ: Preferisci notizie recenti e con impatto concreto (nuove leggi, dati, statistiche)
4. ⚠️ NO DUPLICATI (CRITICO): Non scegliere MAI un tema già coperto. Se la headline tratta lo stesso argomento/dati/statistiche di un articolo esistente (anche con un angolo diverso), SCARTALA. Due articoli sugli stessi dati UST/SECO/BFS sono duplicati anche se il titolo è diverso.
5. NO CRONACA NERA: Evita incidenti, crimini, disastri naturali
6. NO SPORT: Evita risultati sportivi, partite, campionati
7. SPECIFICITÀ TICINO: La notizia deve riguardare il Canton Ticino o la regione di confine

Rispondi con un JSON object (no markdown, no code fences):
{
  "selectedIndex": <numero dell'headline scelta>,
  "reason": "<perché questa notizia è rilevante per i frontalieri, max 2 frasi>"
}`;
      console.error(`🤖 Selezione batch ${batchIdx + 1}/${batches.length} (${batch.length} headline)...`);
      const rawText = await callLLM(
        [{ role: 'user', content: prompt }],
        { model: GH_MODEL_LIGHT, temperature: 0.3, maxTokens: 512, jsonMode: true },
      );
      const cleaned = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      let selection;
      try {
        selection = JSON.parse(cleaned);
      } catch {
        const idxMatch = cleaned.match(/"selectedIndex"\s*:\s*(\d+)/);
        const reasonMatch = cleaned.match(/"reason"\s*:\s*"([^"]*)/);
        if (idxMatch) {
          console.error(`  ⚠️  JSON troncato — recovery da selectedIndex=${idxMatch[1]}`);
          selection = {
            selectedIndex: parseInt(idxMatch[1], 10),
            reason: reasonMatch ? reasonMatch[1] : '(reason troncata)',
          };
        } else {
          console.error(`  ⚠️  Batch ${batchIdx + 1}: impossibile parsare selezione, skip`);
          console.error(`     Risposta: ${cleaned.slice(0, 200)}`);
          continue;
        }
      }
      let idx = selection.selectedIndex;
      if (typeof idx !== 'number' || idx < 0 || idx >= batch.length) {
        console.error(`  ⚠️  Batch ${batchIdx + 1}: indice ${idx} fuori range (0-${batch.length - 1}), clamp a 0`);
        idx = 0;
      }
      batchWinners.push({ ...batch[idx], _batchReason: selection.reason });
    }
    // Now select from batch winners
    trimmed = batchWinners;
    console.error(`🔄 Batch selection completata: ${batchWinners.length} finalisti`);
  }
  // Single-batch or batch-winner selection
  const headlineList = trimmed.map((h, i) => {
    const tag = h._frontalieriBoosted ? ' ⭐FRONTALIERI' : '';
    const recencyTag = h._undatedFallback ? ' ⏳UNDATED' : '';
    return `[${i}] (${h.source}${tag}${recencyTag}) ${h.headline}`;
  }).join('\n');
  const prompt = `Sei un editor del sito Frontaliere Ticino (frontaliereticino.ch).
Devi scegliere UN articolo da queste headline di notizie ticinesi per scrivere un pezzo per i frontalieri.

HEADLINE DISPONIBILI:
${headlineList}

ARTICOLI GIÀ PUBBLICATI (NON scegliere argomenti simili o già coperti):
${recentArticles}

CRITERI DI SELEZIONE (in ordine di priorità):
1. ⭐ PRIORITÀ ASSOLUTA: Se ci sono headline marcate con ⭐FRONTALIERI, scegli TRA QUELLE — sono notizie che menzionano esplicitamente frontalieri, permessi, accordi fiscali, dogane o lavoro transfrontaliero
2. RILEVANZA FRONTALIERI: Priorità a notizie su lavoro transfrontaliero, fisco, permessi, stipendi, accordi CH-IT, economia ticinese, mercato del lavoro, trasporti transfrontalieri
2.1 CLUSTER SEO PRIORITARI: favorisci headline che possono intercettare query ad alta intenzione su:
   - calcolo tasse frontalieri entro/oltre 20km
   - pensione frontaliere (AVS/INPS, pilastri)
   - cambio CHF EUR e ottimizzazione conversione
3. NOVITÀ: Preferisci notizie recenti e con impatto concreto (nuove leggi, dati, statistiche)
4. ⚠️ NO DUPLICATI (CRITICO): Non scegliere MAI un tema già coperto. Se la headline tratta lo stesso argomento/dati/statistiche di un articolo esistente (anche con un angolo diverso), SCARTALA. Due articoli sugli stessi dati UST/SECO/BFS sono duplicati anche se il titolo è diverso.
5. NO CRONACA NERA: Evita incidenti, crimini, disastri naturali
6. NO SPORT: Evita risultati sportivi, partite, campionati
7. SPECIFICITÀ TICINO: La notizia deve riguardare il Canton Ticino o la regione di confine

Rispondi con un JSON object (no markdown, no code fences):
{
  "selectedIndex": <numero dell'headline scelta>,
  "reason": "<perché questa notizia è rilevante per i frontalieri, max 2 frasi>"
}`;
  console.error(`🤖 Selezione articolo finale tra ${trimmed.length} headline...`);
  const rawText = await callLLM(
    [{ role: 'user', content: prompt }],
    { model: GH_MODEL_LIGHT, temperature: 0.3, maxTokens: 512, jsonMode: true },
  );
  console.error(`  ✅ Selezione completata`);
  const cleaned = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  let selection;
  try {
    selection = JSON.parse(cleaned);
  } catch {
    const idxMatch = cleaned.match(/"selectedIndex"\s*:\s*(\d+)/);
    const reasonMatch = cleaned.match(/"reason"\s*:\s*"([^"]*)/);
    if (idxMatch) {
      console.error(`  ⚠️  JSON troncato — recovery da selectedIndex=${idxMatch[1]}`);
      selection = {
        selectedIndex: parseInt(idxMatch[1], 10),
        reason: reasonMatch ? reasonMatch[1] : '(reason troncata)',
      };
    } else {
      // Last resort: pick first headline
      console.error(`  ⚠️  Impossibile parsare selezione finale, fallback a indice 0`);
      console.error(`     Risposta: ${cleaned.slice(0, 200)}`);
      selection = { selectedIndex: 0, reason: '(selezione automatica — parse fallito)' };
    }
  }
  let idx = selection.selectedIndex;
  if (typeof idx !== 'number' || idx < 0 || idx >= trimmed.length) {
    console.error(`  ⚠️  Indice ${idx} fuori range (0-${trimmed.length - 1}), clamp a 0`);
    idx = 0;
  }
  const chosen = trimmed[idx];
  const tokenize = (s) => (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9àèéìòùäöüßç\s-]/gi, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3);
  const selectedTerms = new Set(tokenize(chosen.headline));
  const relatedHeadlines = trimmed
    .filter((h, i) => i !== idx)
    .map((h) => {
      const words = tokenize(h.headline);
      const overlap = words.filter(w => selectedTerms.has(w)).length;
      const sourceBoost = h.source === chosen.source ? 2 : 0;
      return { ...h, _score: overlap + sourceBoost };
    })
    .filter(h => h._score > 1)
    .sort((a, b) => b._score - a._score)
    .slice(0, 4)
    .map(({ headline, source, url }) => ({ headline, source, url }));

  chosen.relatedHeadlines = relatedHeadlines;
  console.error(`🎯 Articolo selezionato: "${chosen.headline}"`);
  console.error(`   Fonte: ${chosen.source}`);
  console.error(`   URL: ${chosen.url}`);
  if (relatedHeadlines.length > 0) {
    console.error(`   Contesto extra: ${relatedHeadlines.length} headline correlate incluse per arricchire il contenuto.`);
  }
  console.error(`   Motivo: ${selection.reason}`);
  return chosen;
}

// ── Step 2: Generate article via GitHub Models (multi-call) ─
async function callGemini(pageContent, url, sourceContext = null) {
  // Get existing article IDs to avoid duplicates
  const routerSrc = read('services/routerBlogData.ts');
  const idMatch = routerSrc.match(/ALL_BLOG_ARTICLE_IDS.*?\[([^\]]+)\]/s);
  const existingIds = idMatch ? idMatch[1].match(/'([^']+)'/g)?.map(s => s.slice(1, -1)) || [] : [];

  // ── Token budget management ──
  // Most models accept 128K+ context. We keep source generous (6000 chars)
  // to maximize factual grounding, and limit IDs to 50 for dedup.
  //
  // Strategy:
  //   1. Only send last 50 article IDs (recent ones matter most for dedup)
  //   2. Provide generous source content (6000 chars) so the model has facts to work with
  //   3. Send compact IT-only JSON template (EN/DE/FR generated in separate calls)
  //   4. Compress editorial rules (no repetition per locale)
  const MAX_SOURCE_CHARS = 6000;
  const MAX_IDS_TO_SEND = 50;

  const truncatedContent = pageContent
    ? (pageContent.length > MAX_SOURCE_CHARS
      ? pageContent.slice(0, MAX_SOURCE_CHARS) + '\n[...contenuto troncato per brevità]'
      : pageContent)
    : '(page content unavailable — generate based on URL topic)';

  // Send only recent IDs + count of older ones
  const recentIds = existingIds.slice(-MAX_IDS_TO_SEND);
  const olderCount = existingIds.length - recentIds.length;
  const idsSection = olderCount > 0
    ? `RECENT ARTICLE IDS (last ${MAX_IDS_TO_SEND} of ${existingIds.length} total — do NOT reuse): ${recentIds.join(', ')}`
    : `EXISTING ARTICLE IDS (do NOT reuse): ${recentIds.join(', ')}`;

  const relatedContext = sourceContext?.relatedHeadlines?.length
    ? sourceContext.relatedHeadlines.map((h, i) => `- [${i + 1}] (${h.source}) ${h.headline}`).join('\n')
    : '';

  const generationAttempt = Number(sourceContext?._generationAttempt || 1);
  const generationAttemptMax = Number(sourceContext?._generationAttemptMax || 1);
  const minItalianWords = Number(sourceContext?._minItalianWords || CREATE_ARTICLE_MIN_IT_WORDS);

  const prompt = `You are a senior financial journalist specializing in Swiss-Italian cross-border work and Ticino economics.
You write for "Frontaliere Ticino" (frontaliereticino.ch). Based on the following source, write a blog article.

SOURCE URL: ${url.startsWith('evergreen://') ? '(editorial research)' : url}
SOURCE CONTENT:
${truncatedContent}
${sourceContext?.headline ? `\nHEADLINE: ${sourceContext.headline}` : ''}
${relatedContext ? `\nRELATED:\n${relatedContext}` : ''}

${idsSection}
⚠️ The "id" must NOT share >60% words with any existing ID.

═══ REGOLA #1 — FEDELTÀ ALLA FONTE (PRIORITÀ MASSIMA) ═══

Il tuo articolo è una RISCRITTURA EDITORIALE della fonte, NON un articolo originale. Questo significa:
- OGNI fatto, cifra, data, legge, aliquota, istituzione e statistica DEVE essere presente nel SOURCE CONTENT sopra.
- Se la fonte dice "la nuova legge prevede X", scrivi "la nuova legge prevede X" — NON aggiungere dettagli che la fonte non menziona.
- Se la fonte NON specifica una data, un importo, un numero di legge o un nome di istituzione: NON inventarlo. Scrivi "non ancora specificato" o omettilo.
- Le citazioni dirette devono essere VERBATIM dalla fonte. Se parafrasate, usa il discorso indiretto.
- NON aggiungere "contesto di background" non verificabile (es. date di trattati, numeri di legge, statistiche) a meno che non sia nella fonte.

COME RAGGIUNGERE IL MINIMO DI PAROLE SENZA INVENTARE:
- Analizza le IMPLICAZIONI PRATICHE per i frontalieri (cosa cambia nella vita quotidiana)
- Descrivi PROCEDURE concrete (cosa fare, dove andare, quali documenti servono)
- Aggiungi SCENARI "cosa succede se" basati sui fatti della fonte
- Confronta con la situazione precedente (prima vs dopo il cambiamento descritto nella fonte)
- Includi una sezione FAQ con domande pratiche e risposte basate sulla fonte
- Usa tabelle comparative per rendere i dati della fonte più leggibili
- Collega agli strumenti del sito (calcolatore, comparatore, guide) per approfondire

═══ REGOLE EDITORIALI ═══

STILE: Scrivi come giornalista finanziario italiano reale, NON come AI. Varia lunghezza frasi (da 5 a 30 parole). Alterna paragrafi brevi (1-2 frasi) a paragrafi più lunghi. Usa numeri, date, luoghi reali, istituzioni — MA SOLO se presenti nella fonte. Colore locale: valichi (Brogeda, Gaggiolo), comuni (Chiasso, Mendrisio), uffici cantonali.
MAI usare: "In conclusione", "È importante notare", "In questo contesto", "Vale la pena", "È fondamentale", "Alla luce di", "Ecco cosa sapere", "Vediamo nel dettaglio", "Andiamo con ordine", "Non è un caso che", "Un aspetto cruciale", "Sempre più", "In un contesto di".
Linguaggio diretto: "conviene" non "potrebbe essere utile". Il testo DEVE superare AI detection.
ANTI-AI (CRITICO): Il testo NON deve sembrare generato da AI. Regole:
- MAI aprire body1 con una frase generica tipo "Il tema dei frontalieri...". Inizia con un FATTO concreto DALLA FONTE (data, numero, nome, luogo).
- MAI elenchi puntati di >5 elementi (spezzali in paragrafi narrativi)
- MAX 2 emoji callout (📊/💡/⚠️) per INTERO articolo (body1+body2+body3 combinati). Zero è meglio.
- Varia la struttura: non TUTTI i body devono avere un elenco puntato. Alterna prosa, tabelle, FAQ, citazioni.
- NON usare parallelismi strutturali tra body1/body2/body3 (se body1 ha ## + elenco, body2 deve avere ## + prosa + tabella).

TICINO: L'articolo DEVE riguardare Canton Ticino, confine italo-svizzero, o frontalieri. Riferimenti locali: Canton Ticino, SUPSI, USI, EOC, Lugano, Bellinzona, Locarno, Mendrisio, DFE, SECO.

═══ DIVIETI ANTI-ALLUCINAZIONE (BLOCCANTI — RIGETTO AUTOMATICO) ═══

L'articolo viene verificato da un SECONDO modello AI indipendente (fact-checker) che confronta OGNI affermazione con la fonte e con le proprie conoscenze. Inventare anche UN SOLO dato = rigetto.

LEGGI E DECRETI:
- Cita riferimenti normativi SOLO se appaiono LETTERALMENTE nella fonte.
- Se la fonte dice "la nuova normativa" senza specificare il numero, scrivi "la nuova normativa" — NON inventare "D.Lgs XXX/YYYY".
- Leggi verificate (usabili SOLO se pertinenti e nella fonte): DPR 917/1986 (TUIR), D.Lgs 147/2015, DL 167/2024, L. 207/2024 (Bilancio 2025), D.Lgs 241/1997, DL 78/2010.
- La Convenzione italo-svizzera è del 9 DICEMBRE 1976. Il Nuovo Accordo Frontalieri è stato firmato il 23 DICEMBRE 2020.

ISTITUZIONI:
- NON inventare acronimi. Enti reali: SECO, USTAT, UFSP/BAG, SUVA, DFE, DSS, SEM, INPS, Agenzia Entrate, MEF.
- NON esiste: "Codice federale del lavoro", "CFL", "UFOL", "UWL", "USTTI", "Commissione federale per i frontalieri".

STATISTICHE:
- MAI scrivere "secondo uno studio/sondaggio" senza NOME, ANNO e ISTITUTO presenti nella fonte.
- MAI inventare percentuali precise (es. "il 73,2%"). Se la fonte non le riporta, non usarle.
- MAI inventare "rapporti annuali" con dati specifici.

FATTI E DICHIARAZIONI:
- NON attribuire dichiarazioni a politici, enti o funzionari se non citate nella fonte.
- NON inventare eventi (conferenze, proteste, referendum) non menzionati nella fonte.
- Se non sei CERTO che un fatto sia nella fonte, OMETTILO.

ANTI-CLICKBAIT (CRITICO — Google Discover compliance):
- Il titolo DEVE essere DESCRITTIVO e SPECIFICO: soggetto + azione + contesto.
  ✅ Buono: "Aumento stipendi minimi in Ticino: +2.3% dal 1° gennaio 2026"
  ❌ Vietato: "Tutto quello che devi sapere sugli stipendi in Ticino"
- MAI titoli vaghi: "tutto cambia", "ecco perché", "scopri cosa", "shock", "clamoroso", "incredibile", "non crederai"
- MAI domande retoriche come titolo ("Ma davvero i frontalieri...?")

TOPIC GUARD: per articoli su "tassa salute", NON invertire la platea (es. "lavora in Lombardia e risiede in Ticino") se non esplicitamente indicata nella fonte.

CTA: body3 DEVE terminare con CTA verso strumenti del sito. Default: calcolatore stipendio. Temi specifici: assicurazione→health, pensioni→pension, costo vita→cost-of-living, cambio→exchange, IRPEF/comuni→border-map, auto→car-transfer, permessi→permit-compare, casa→renovation, telefonia→mobile, congedo→parental-leave, vivere CH→living-ch, vivibilità→livability.

LINK INTERNI — sintassi ESCLUSIVA: [testo](nav:azione)
Azioni: calculator, exchange, health, cost-of-living, pension, pillar3, payslip, tax-return, residency, ristorni, unemployment, jobs, companies, banks, first-day, permits, border, calendar, whatif, shopping, transport, salary-compare, traffic-history, border-map, municipalities, car-transfer, car-cost, permit-compare, renovation, mobile, ral, parental-leave, nursery, living-ch, living-it, livability.
MAI usare <a href> o URL diretti.

GRASSETTO: max 2-3 parole in grassetto per INTERO campo body. MAI grassetto su importi (350 CHF), etichette (Caso 1:), frasi >5 parole, nomi strumenti. Preferire ZERO grassetto.
FORMATTAZIONE: ## sottotitoli, ### sotto-sottotitoli, - elenchi, > citazioni (MAX 1 per articolo — solo se c'è una vera citazione dalla fonte), 📊 dati, 💡 consigli, ⚠️ avvertenze. Blocchi separati con \\n\\n. NON usare > per paragrafi normali — solo per citazioni dirette brevi (1-2 frasi).
STRUTTURA H3 (CRITICO): Ogni body con >250 parole DEVE avere almeno 1 sotto-sezione ### (H3).

ANTI-RIPETITIVITÀ (CRITICO): I tre body DEVONO avere contenuti DIVERSI. Mai ripetere lo stesso concetto tra body1, body2, body3.
- body1 = FATTI DALLA FONTE: chi ha deciso/annunciato cosa, quando, dove, perché. Cronaca pura basata sul SOURCE CONTENT.
- body2 = ANALISI PRATICA: implicazioni per i frontalieri, confronti prima/dopo, scenari concreti. Informazione che NON era nel body1.
- body3 = AZIONE: cosa fare concretamente, scadenze, procedura step-by-step, strumenti del sito. NON riassumere body1 o body2.

Genera JSON (no markdown, no code fences):
{
  "id": "kebab-case-3-5-words-max-40-chars",
  "category": "one of: ${CATEGORIES.join(', ')}",
  "image": "one of: ${AVAILABLE_IMAGES.slice(0, 15).join(', ')}... (scegli la più adatta)",
  "hasCalculator": true,
  "imagePrompt": "Prompt per immagine fotorealistica DSLR ambientata in Ticino. Max 2 frasi EN.",
  "imageAlt": { "it": "max 125 chars", "en": "max 125 chars", "de": "max 125 chars", "fr": "max 125 chars" },
  "slugs": { "it": "slug-it", "en": "slug-en", "de": "slug-de", "fr": "slug-fr" },
  "content": {
    "it": {
      "title": "Titolo giornalistico con keyword (max 60 chars)",
      "excerpt": "Sottotitolo con dati concreti DALLA FONTE (max 160 chars)",
      "body1": "Lead: FATTI dalla fonte (chi, cosa, dove, quando, perché). Solo cronaca verificabile. 300-400 parole. Min 1 ### sotto-sezione.",
      "body2": "Analisi pratica: implicazioni, confronti, scenari. Contenuto DIVERSO da body1. 300-400 parole. Min 1 ### sotto-sezione.",
      "body3": "Azione: procedura step-by-step, scadenze, strumenti + CTA finale. NON riassumere body1/body2. 300-400 parole.",
      "faq": [
        {"q": "Domanda frequente 1 basata sui fatti dell'articolo?", "a": "Risposta con dati DALLA FONTE. 50-100 parole."},
        {"q": "Domanda frequente 2?", "a": "Risposta pratica basata sulla fonte."},
        {"q": "Domanda frequente 3?", "a": "Risposta con procedura o scadenza dalla fonte."}
      ]
    }
  },
  "seo": {
    "title": "SEO Title | Frontaliere Ticino (max 60 chars)",
    "description": "Meta description 150-160 chars",
    "keywords": "6-8 keywords IT",
    "ogTitle": "OG title (max 60 chars)",
    "ogDescription": "OG desc (max 160 chars)",
    "headline": "Headline JSON-LD",
    "breadcrumbName": "Breadcrumb 2-3 parole"
  }
}

REGOLE FINALI:
- Contenuto IT primario, MINIMO 350 parole per body (body1/body2/body3). EN/DE/FR verranno generati separatamente.
- Per raggiungere il minimo: espandi con implicazioni pratiche, procedure, scenari, FAQ — NON con fatti inventati.
- Slug: lowercase, trattini, no accenti, max 50 chars
- hasCalculator: true sempre
- Apostrofi diritti ('), normative 2026
- imagePrompt: scena fotorealistica Ticino, DSLR, non sembrare AI
- FAQ: genera 3-5 coppie domanda/risposta basate sui FATTI della fonte. Risposte: 50-100 parole, con dati concreti dalla fonte.`;

  const minWordsInstruction = `\n\nMINIMUM LENGTH (CRITICAL — STRICTLY ENFORCED):
- body1+body2+body3 MUST total ≥${minItalianWords} words. This is HARD-enforced: content below this threshold will be REJECTED.
- EACH body field (body1, body2, body3) MUST be at least 300 words individually. Target 350-400 words each.
- Use detailed examples, step-by-step procedures, concrete numbers/dates, comparison tables, checklists, and FAQ sections to reach the target.
- Count your words before finalizing. If the total is <${minItalianWords}, ADD more content.
${generationAttempt > 1 ? `- ⚠️ RETRY ${generationAttempt}/${generationAttemptMax}: previous attempt was REJECTED because it was only ~${sourceContext?._previousWordCount || '???'} words (minimum: ${minItalianWords}). You MUST write SIGNIFICANTLY MORE this time. Each body: 350-450 words.${generationAttempt >= 4 ? ' Include: detailed FAQ (5+ questions), comparison tables, step-by-step guides with numbered steps, specific examples with real numbers.' : ''}` : ''}`;

  // ── Multi-call generation with automatic model fallback ──
  // Supports model override via sourceContext._forceModel and temperature via sourceContext._temperature
  const forceModel = sourceContext?._forceModel;
  const temperature = Number(sourceContext?._temperature || 0.7);
  const useGeminiDirect = forceModel === 'gemini';
  const effectiveModel = useGeminiDirect ? `Gemini ${AI_MODELS.GEMINI_FLASH}` : (forceModel || GH_MODEL_HEAVY);

  // Call 1: Italian content + metadata (id, category, image, slugs, imagePrompt, imageAlt)
  console.error(`🤖 [1/5] Generazione contenuto IT + metadata con ${effectiveModel}...`);

  const llmMessages = [
    { role: 'system', content: `Sei un giornalista finanziario esperto di lavoro transfrontaliero in Ticino che RISCRIVE articoli basandosi FEDELMENTE sulla fonte originale.

REGOLA FONDAMENTALE: Ogni fatto, dato, legge, data, cifra e istituzione nel tuo articolo DEVE provenire dal testo SOURCE CONTENT fornito. Se un'informazione NON è nella fonte, NON includerla. Mai inventare, dedurre o "completare" dati mancanti.

QUANDO LA FONTE NON CONTIENE UN DATO: scrivi "non ancora specificato", "in fase di definizione", o ometti il dettaglio. NON inventare numeri, date o riferimenti normativi per riempire il testo.

Rispondi SOLO con JSON valido, senza markdown.` },
    { role: 'user', content: prompt + minWordsInstruction + `\n\n⚠️ ISTRUZIONE SPECIALE PER QUESTA CHIAMATA:\nGenera SOLO il JSON con questi campi: id, category, image, hasCalculator, imagePrompt, imageAlt (4 lingue), slugs (4 lingue), content.it (title, excerpt, body1, body2, body3, faq), seo.\nNON includere content.en, content.de, content.fr — verranno generati separatamente.` }
  ];

  let itRaw;
  if (useGeminiDirect) {
    itRaw = await callLLM(llmMessages, { model: AI_MODELS.GEMINI_FLASH, temperature, maxTokens: 8000, jsonMode: true });
    console.error(`  ↪ Completato con Gemini ${AI_MODELS.GEMINI_FLASH}`);
  } else {
    itRaw = await callLLM(llmMessages, { model: forceModel || GH_MODEL_HEAVY, temperature, maxTokens: 8000, jsonMode: true });
  }
  let itData;
  try {
    itData = JSON.parse(itRaw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim());
  } catch (parseErr) {
    console.error(`❌ JSON parse error: ${parseErr.message}`);
    console.error(`   Raw response (last 200 chars): ...${itRaw.slice(-200)}`);
    throw new Error(`JSON non valido dalla generazione IT: ${parseErr.message}`);
  }
  const itContent = normalizeItalianContentFromPayload(itData);
  if (!itContent) {
    throw new Error('Risposta IT non contiene content.it e non può essere normalizzata');
  }
  validateItalianPayload(itContent, 'it');

  // Preserve FAQ from AI response (not in REQUIRED_IT_BODY_FIELDS, extracted separately)
  const rawFaq = itData?.content?.it?.faq || itData?.content?.faq || itData?.faq;
  if (rawFaq) {
    if (!Array.isArray(rawFaq)) {
      console.error('  ⚠️  FAQ non è un array, lo rimuovo');
    } else {
      const validFaq = rawFaq.filter(pair =>
        pair && typeof pair.q === 'string' && typeof pair.a === 'string' &&
        pair.q.length > 10 && pair.a.length > 20
      ).slice(0, 7);
      if (validFaq.length < 2) {
        console.error(`  ⚠️  FAQ troppo poche (${validFaq.length}), rimuovo`);
      } else {
        itContent.faq = validFaq;
        console.error(`  ✅ FAQ: ${validFaq.length} coppie valide`);
      }
    }
  }

  console.error(`  ✅ IT + metadata completati`);

  // Calls 2-4 are now deferred — see translateArticle() below
  // Return IT-only data so duplicate check can run before wasting translation API calls
  const result = {
    ...itData,
    content: {
      it: itContent,
    },
  };
  if (!result.seo && itData.seo) result.seo = itData.seo;
  console.error(`  ✅ Articolo IT generato`);
  return result;
}

function countWords(text = '') {
  return String(text)
    .replace(/\[[^\]]+\]\(nav:[^)]+\)/g, '$1')
    .replace(/[#>*`_~\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .length;
}

function italianBodyWordCount(data) {
  const it = data?.content?.it || {};
  return ['body1', 'body2', 'body3']
    .map((k) => countWords(it[k] || ''))
    .reduce((acc, n) => acc + n, 0);
}

/**
 * Expand short Italian body content by asking the LLM to enrich each body field.
 * This is a last-resort fallback that's far more effective than regenerating from scratch,
 * because it preserves the existing structure and just adds depth.
 */
async function expandShortItalianContent(data, targetWords) {
  const it = data?.content?.it;
  if (!it) return data;

  const currentTotal = italianBodyWordCount(data);
  const deficit = targetWords - currentTotal;
  const perField = Math.ceil(deficit / 3) + 30; // extra margin per field

  for (const field of ['body1', 'body2', 'body3']) {
    const currentText = it[field] || '';
    const currentWords = countWords(currentText);
    const targetFieldWords = currentWords + perField;

    const expandPrompt = `Sei un giornalista finanziario esperto di lavoro transfrontaliero in Ticino.

TESTO ATTUALE (${currentWords} parole):
${currentText}

TITOLO ARTICOLO: ${it.title || ''}

ISTRUZIONI:
- Riscrivi ed ESPANDI questo testo a circa ${targetFieldWords} parole (MASSIMO ${MAX_BODY_FIELD_WORDS} parole — NON superare questo limite)
- Mantieni lo stesso tono, stile e struttura
- Aggiungi: esempi concreti con numeri reali, riferimenti a comuni ticinesi specifici, normative con date e importi, checklist operative, confronti tra scenari pratici
- NON aggiungere frasi generiche o filler — solo informazioni utili e verificabili
- Mantieni la formattazione esistente (##, -, >, 📊, 💡, ⚠️). Citazioni (>) MAX 1 per articolo, solo per citazioni dirette brevi
- GRASSETTO: massimo 2-3 parole in grassetto nell'intero testo, preferisci ZERO
- NON cambiare il significato o la prospettiva dell'articolo
- Rispondi con il SOLO testo espanso, senza JSON, senza code fences`;

    try {
      const expanded = await callLLM(
        [
          { role: 'system', content: 'Sei un giornalista finanziario esperto. Rispondi con il solo testo richiesto, senza wrapper.' },
          { role: 'user', content: expandPrompt },
        ],
        { model: GH_MODEL_HEAVY, temperature: 0.7, maxTokens: 3000, timeout: 60_000 },
      );

      const expandedClean = expanded.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '').trim();
      const expandedWords = countWords(expandedClean);

      if (expandedWords > currentWords) {
        it[field] = expandedClean;
        console.error(`    📝 ${field}: ${currentWords} → ${expandedWords} parole`);

        // Hard cap: trim at paragraph boundary if LLM overshot the limit
        if (expandedWords > MAX_BODY_FIELD_WORDS) {
          const paragraphs = expandedClean.split(/\n\n+/);
          let trimmed = '';
          let trimmedWords = 0;
          for (const p of paragraphs) {
            const pWords = countWords(p);
            if (trimmedWords + pWords > MAX_BODY_FIELD_WORDS && trimmed) break;
            trimmed += (trimmed ? '\n\n' : '') + p;
            trimmedWords += pWords;
          }
          // Only trim if we kept at least some content
          if (trimmedWords >= currentWords && trimmedWords < expandedWords) {
            it[field] = trimmed;
            console.error(`    ✂️  ${field}: troncato a ${trimmedWords} parole (max ${MAX_BODY_FIELD_WORDS})`);
          }
        }
      } else {
        console.error(`    ⚠️  ${field}: espansione non ha aumentato le parole (${expandedWords} ≤ ${currentWords})`);
      }
    } catch (e) {
      console.error(`    ⚠️  ${field}: espansione fallita: ${e.message}`);
    }
  }

  return data;
}

/**
 * Translate article content from Italian to EN/DE/FR.
 * Called AFTER duplicate check to avoid wasting API calls on duplicates.
 */
async function translateArticle(data) {
  // repairJson: strips fences, extracts the JSON object, and escapes literal
  // newlines/carriage-returns inside string values (common LLM output issue).
  const repairJson = (s) => {
    let c = s.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    const start = c.indexOf('{'); const end = c.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) c = c.slice(start, end + 1);
    let out = ''; let inStr = false; let esc = false;
    for (let i = 0; i < c.length; i++) {
      const ch = c[i];
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = !inStr; out += ch; continue; }
      if (inStr && ch === '\n') { out += '\\n'; continue; }
      if (inStr && ch === '\r') { continue; }
      out += ch;
    }
    return out;
  };

  async function callWithRetry(prompt, maxTokens, label) {
    const raw = await callLLM(
      [{ role: 'user', content: prompt }],
      { temperature: 0.5, maxTokens, jsonMode: true },
    );
    try {
      return JSON.parse(repairJson(raw));
    } catch (parseErr) {
      console.error(`  ⚠️  JSON parse error (${label}): ${parseErr.message}`);
      console.error(`     Raw (last 200 chars): ...${raw.slice(-200)}`);
      // Detect truncation (model hit output cap): use 3× tokens on retry
      const isTruncation = parseErr.message.includes('Unterminated') || parseErr.message.includes('Unexpected end');
      const retry1Tokens = isTruncation ? Math.max(maxTokens * 3, 12000) : maxTokens + 4000;
      console.error(`  🔄 Retry ${label} con maxTokens=${retry1Tokens}${isTruncation ? ' (troncamento rilevato)' : ''}...`);
      const raw2 = await callLLM(
        [{ role: 'user', content: prompt }],
        { temperature: 0.5, maxTokens: retry1Tokens, jsonMode: true },
      );
      try {
        const result = JSON.parse(repairJson(raw2));
        console.error(`  ✅ Retry riuscito per ${label}`);
        return result;
      } catch (retryErr) {
        console.error(`  ⚠️  Retry 1 fallito (${label}): ${retryErr.message} — tentativo 2...`);
        // Third attempt with maximum tokens
        const retry2Tokens = 16000;
        const raw3 = await callLLM(
          [{ role: 'user', content: prompt }],
          { temperature: 0.3, maxTokens: retry2Tokens, jsonMode: true },
        );
        try {
          const result3 = JSON.parse(repairJson(raw3));
          console.error(`  ✅ Retry 2 riuscito per ${label}`);
          return result3;
        } catch (retry2Err) {
          console.error(`  ❌ Retry 2 fallito (${label}): ${retry2Err.message}`);
          throw new Error(`JSON non valido dalla traduzione ${label}: ${retry2Err.message}`);
        }
      }
    }
  }

  async function translateContent(sourceLang, targetLang, targetLabel, sourceContent) {
    // Use scored chain (no model pinning) — falls back through all models automatically
    const langName = targetLang === 'en' ? 'inglese' : targetLang === 'de' ? 'tedesco' : 'francese';
    console.error(`🤖 [${targetLabel}] Traduzione ${targetLang.toUpperCase()} tramite catena AI...`);

    const rules = `REGOLE DI TRADUZIONE:
- Traduzione COMPLETA, stessa profondità e lunghezza dell'italiano
- NON riassumere — traduci tutto il contenuto
- Mantieni la formattazione: ## per sottotitoli, - per elenchi, > per citazioni, emoji (📊💡⚠️) per box
- Mantieni i link interni esattamente come sono: [testo tradotto](nav:azione) — traduci solo il testo visibile, NON l'azione nav:
- GRASSETTO: max 2-3 parole in grassetto per INTERO campo body. Preferire ZERO grassetto.
- Usa fraseologia naturale nella lingua target, non traduzione letterale
- Apostrofi: usa sempre ' (diritto), mai virgolette curve`;

    // Split into 4 parallel calls — one per field group — to stay within model output limits.
    // German/French expand ~30% vs Italian; some models cap output at ~2048-4096 tokens.
    // Dynamic maxTokens based on input word count + sub-chunking for oversized fields.

    const makePrompt = (fields, schema) =>
      `Traduci il seguente contenuto giornalistico da italiano a ${langName} per il sito Frontaliere Ticino.\n\n${fields}\n\n${rules}\n\nRispondi con un JSON object (no markdown, no code fences):\n${schema}`;

    // Scale maxTokens to input size: ~2 tokens/word in, ~2.5 tokens/word out (translation expansion)
    const bodyTokens = (text) => Math.max(5000, Math.ceil(countWords(text || '') * 5));

    // For body fields exceeding this threshold, split into sub-chunks and translate separately
    const TRANSLATION_CHUNK_THRESHOLD = 700;

    async function translateBodyField(bodyKey, bodyText, lang) {
      const words = countWords(bodyText || '');

      if (words <= TRANSLATION_CHUNK_THRESHOLD) {
        // Normal single-call translation
        const result = await callWithRetry(makePrompt(
          `CONTENUTO ITALIANO DA TRADURRE:\n- ${bodyKey}: ${bodyText}`,
          `{"${bodyKey}": "..."}`,
        ), bodyTokens(bodyText), `${lang}:${bodyKey.replace('body', 'b')}`);
        if (result && typeof result[bodyKey] === 'string') {
          result[bodyKey] = sanitizeBodyText(result[bodyKey]);
        }
        return result;
      }

      // Sub-chunk: split at paragraph boundaries into ~500-word pieces
      console.error(`    📦 ${lang}:${bodyKey} = ${words} parole → sub-chunking...`);
      const paragraphs = (bodyText || '').split(/\n\n+/);
      const chunks = [];
      let currentChunk = '';
      let currentWords = 0;
      const chunkTarget = 500;

      for (const p of paragraphs) {
        const pWords = countWords(p);
        if (currentWords + pWords > chunkTarget && currentChunk) {
          chunks.push(currentChunk);
          currentChunk = p;
          currentWords = pWords;
        } else {
          currentChunk += (currentChunk ? '\n\n' : '') + p;
          currentWords += pWords;
        }
      }
      if (currentChunk) chunks.push(currentChunk);

      // Translate each chunk in parallel
      const translated = await Promise.all(
        chunks.map((chunk, i) =>
          callWithRetry(makePrompt(
            `CONTENUTO ITALIANO DA TRADURRE (parte ${i + 1} di ${chunks.length}):\n- ${bodyKey}: ${chunk}`,
            `{"${bodyKey}": "..."}`,
          ), bodyTokens(chunk), `${lang}:${bodyKey.replace('body', 'b')}-p${i + 1}`),
        ),
      );

      // Join translated chunks
      const joined = translated.map((r) => r[bodyKey] || '').join('\n\n');
      return { [bodyKey]: sanitizeBodyText(joined) };
    }

    // Translate FAQ if present (small payload, single call)
    const faqTranslation = sourceContent.faq && Array.isArray(sourceContent.faq) && sourceContent.faq.length > 0
      ? callWithRetry(makePrompt(
          `CONTENUTO ITALIANO DA TRADURRE:\n- faq: ${JSON.stringify(sourceContent.faq)}`,
          '{"faq": [{"q": "...", "a": "..."}]}',
        ), 1500, `${targetLang}:faq`).catch(err => {
          console.error(`  ⚠️  FAQ translation failed for ${targetLang}: ${err.message}`);
          return { faq: sourceContent.faq }; // Fallback to Italian
        })
      : Promise.resolve({});

    const [partMeta, partB1, partB2, partB3, partFaq] = await Promise.all([
      // Call 1: title + excerpt (small, ~300 tokens output)
      callWithRetry(makePrompt(
        `CONTENUTO ITALIANO DA TRADURRE:\n- title: ${sourceContent.title}\n- excerpt: ${sourceContent.excerpt}`,
        '{"title": "...", "excerpt": "..."}',
      ), 1000, `${targetLang}:meta`),
      // Call 2-4: body fields with dynamic sizing + sub-chunking safety
      translateBodyField('body1', sourceContent.body1, targetLang),
      translateBodyField('body2', sourceContent.body2, targetLang),
      translateBodyField('body3', sourceContent.body3, targetLang),
      // Call 5: FAQ (optional)
      faqTranslation,
    ]);

    const [partA, partB] = [{ ...partMeta, ...partB1 }, { ...partB2, ...partB3, ...partFaq }];

    const parsed = { ...partA, ...partB };
    console.error(`  ✅ ${targetLang.toUpperCase()} completato`);
    return parsed;
  }

  const itContent = data.content.it;
  const [enContent, deContent, frContent] = await Promise.all([
    translateContent('it', 'en', '2/5', itContent),
    translateContent('it', 'de', '3/5', itContent),
    translateContent('it', 'fr', '4/5', itContent),
  ]);
  console.error(`  ✅ Tutte le traduzioni completate`);

  data.content.en = enContent;
  data.content.de = deContent;
  data.content.fr = frContent;

  // Validate translated content fields
  for (const locale of ['en', 'de', 'fr']) {
    for (const field of ['title', 'excerpt', 'body1', 'body2', 'body3']) {
      if (!data.content[locale][field]) throw new Error(`Campo ${field} mancante nella traduzione ${locale}`);
    }
  }

  // Detect untranslated title/excerpt (identical to Italian = translation failure)
  // Retry once per affected locale; if still identical, warn but don't block.
  for (const locale of ['en', 'de', 'fr']) {
    for (const field of ['title', 'excerpt']) {
      const itVal = (itContent[field] || '').trim();
      const locVal = (data.content[locale][field] || '').trim();
      if (itVal && locVal === itVal) {
        const langName = locale === 'en' ? 'inglese' : locale === 'de' ? 'tedesco' : 'francese';
        console.error(`  ⚠️  [translation-check] ${locale.toUpperCase()}.${field} identico all'italiano — retry traduzione...`);
        try {
          const retryResult = await callWithRetry(makePrompt(
            `ATTENZIONE: la traduzione precedente è rimasta in ITALIANO. Traduci OBBLIGATORIAMENTE in ${langName}.\n\nCONTENUTO ITALIANO DA TRADURRE:\n- ${field}: ${itVal}`,
            `{"${field}": "..."}`,
          ), 1000, `${locale}:${field}-retry`);
          if (retryResult?.[field] && retryResult[field].trim() !== itVal) {
            data.content[locale][field] = retryResult[field];
            console.error(`  ✅ [translation-check] ${locale.toUpperCase()}.${field} ritradotto con successo`);
          } else {
            console.error(`  ⚠️  [translation-check] ${locale.toUpperCase()}.${field} ancora identico dopo retry — accettato con warning`);
          }
        } catch (retryErr) {
          console.error(`  ⚠️  [translation-check] Retry fallito per ${locale}.${field}: ${retryErr.message}`);
        }
      }
    }
  }

  console.error(`  ✅ Articolo assemblato — ${Object.keys(data.content).length} lingue`);
}

// ── Anti-clickbait title validation (Google Discover compliance) ──

const CLICKBAIT_PATTERNS = [
  { re: /\b(shock|clamoroso|incredibile|ecco perch[eé]|tutto cambia|scopri cosa|non crederai|assurdo|pazzesco)\b/i, label: 'sensational_word' },
  { re: /\b(segreto|trucco|metodo che|svela|rivela il)\b/i, label: 'curiosity_gap' },
  { re: /^\s*[A-ZÀ-Ú\s!]{10,}\s*:/, label: 'all_caps_prefix' },
  { re: /\?$/, label: 'rhetorical_question' },
  { re: /\.{3}$/, label: 'trailing_ellipsis' },
  { re: /\b(ecco cosa|ecco come|ecco quando|ecco chi)\b/i, label: 'ecco_pattern' },
];

/**
 * Validate a title against clickbait patterns. Returns { valid, reason } where
 * reason is the label of the first matching pattern (or null if valid).
 */
function validateTitle(title) {
  if (!title) return { valid: false, reason: 'empty' };
  for (const { re, label } of CLICKBAIT_PATTERNS) {
    if (re.test(title)) {
      console.warn(`  ⚠️ [anti-clickbait] Titolo sospetto: "${title}" — pattern: ${label}`);
      return { valid: false, reason: label };
    }
  }
  return { valid: true, reason: null };
}

// ── Step 3: Validate Gemini response ────────────────────────
function validate(data) {
  // `content` is the only truly irreplaceable field — everything else can be
  // synthesized from it. Smaller fallback models (Cerebras llama-3.1-8b, etc.)
  // frequently omit top-level metadata (`id`, `category`, `image`, `slugs`)
  // but still produce usable localized `content`. Fail ONLY if content is missing.
  if (!data || typeof data !== 'object') {
    throw new Error(`Campo mancante nella risposta AI: data (non è un oggetto)`);
  }
  if (!data.content || typeof data.content !== 'object') {
    throw new Error(`Campo mancante nella risposta AI: content`);
  }
  const itContent = data.content.it || data.content;
  if (!itContent || !itContent.title) {
    throw new Error(`Campo mancante nella risposta AI: content.it.title`);
  }

  // Synthesize id from the Italian title if the model omitted it.
  if (!data.id) {
    const generatedId = String(itContent.title)
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80);
    if (!generatedId) {
      throw new Error(`Campo mancante nella risposta AI: id (impossibile sintetizzare dal titolo "${itContent.title}")`);
    }
    console.error(`⚠️  Campo "id" mancante — sintetizzato dal titolo IT: "${generatedId}"`);
    data.id = generatedId;
  }

  // Default category to 'novita' (generic news) if missing — the mapping below
  // will normalize it further.
  if (!data.category) {
    console.error(`⚠️  Campo "category" mancante — uso fallback "novita"`);
    data.category = 'novita';
  }

  // Default image to the first available place image; the downstream image
  // validation block will pick a better fallback via keyword matching or hash.
  if (!data.image) {
    console.error(`⚠️  Campo "image" mancante — uso fallback "${PLACES_IMAGES[0]}"`);
    data.image = PLACES_IMAGES[0];
  }

  // Ensure slugs is an object so the per-locale fallback loop below can populate it.
  if (!data.slugs || typeof data.slugs !== 'object') {
    console.error(`⚠️  Campo "slugs" mancante — sarà derivato dai titoli per locale`);
    data.slugs = {};
  }

  // Synthesize seo from content.it if the model omitted it (common with smaller fallback models)
  if (!data.seo) {
    const it = data.content.it || data.content;
    const title = (it.title || data.id).slice(0, 57);
    const desc = (it.excerpt || it.title || '').slice(0, 160);
    console.error(`⚠️  Campo "seo" mancante — generato automaticamente da content.it`);
    data.seo = {
      title: `${title} | Frontaliere Ticino`,
      description: desc,
      keywords: `frontalieri, ticino, ${data.category || 'lavoro'}, svizzera, italia`,
      ogTitle: title,
      ogDescription: desc,
      headline: title,
      breadcrumbName: title.split(/[:.–—]/)[0].trim().slice(0, 40),
    };
  }

  for (const locale of ['it']) {
    if (!data.content[locale]) throw new Error(`Contenuto mancante per ${locale}`);
    // Auto-generate missing slug from title before failing
    if (!data.slugs[locale]) {
      const title = String(data.content[locale]?.title || '');
      if (title) {
        const generated = title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
        if (generated) {
          data.slugs[locale] = generated;
          console.warn(`  ⚠️  Slug ${locale} mancante, generato dal titolo: "${generated}"`);
        } else {
          throw new Error(`Slug mancante per ${locale} e titolo non utilizzabile per fallback`);
        }
      } else {
        throw new Error(`Slug mancante per ${locale}`);
      }
    }
    for (const field of ['title', 'excerpt', 'body1', 'body2', 'body3']) {
      if (!data.content[locale][field]) throw new Error(`Campo ${field} mancante per ${locale}`);
    }
  }

  // Anti-clickbait title validation (Google Discover compliance)
  const itTitle = (data.content.it || data.content)?.title || '';
  const titleCheck = validateTitle(itTitle);
  if (!titleCheck.valid) {
    console.warn(`  ⚠️ [anti-clickbait] Titolo IT non conforme: "${itTitle}" (${titleCheck.reason})`);
    // Non-blocking: log warning but don't reject the article outright,
    // as false positives are possible. The warning is visible in GH Actions.
  }
  // Thin content guard: warn but don't reject yet — the word-count retry loop
  // (later in the pipeline) will attempt to expand short articles via AI.
  // Final thin content check happens after all retry/expand attempts.
  const itBodyEarly = `${(data.content.it || data.content)?.body1 || ''} ${(data.content.it || data.content)?.body2 || ''} ${(data.content.it || data.content)?.body3 || ''}`;
  const itPlainCharsEarly = itBodyEarly.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().length;
  if (itPlainCharsEarly < MIN_BODY_CHARS) {
    console.warn(`  ⚠️  [thin-content] Articolo corto: ${itPlainCharsEarly} chars (min: ${MIN_BODY_CHARS}) — il retry loop tenterà di espandere`);
  }

  // Slug validation for translated locales (slugs come from IT generation call)
  // If the AI model omitted translated slugs, derive them from the IT slug.
  for (const locale of ['en', 'de', 'fr']) {
    if (!data.slugs[locale]) {
      // Fallback: use the translated title if available, otherwise the IT slug
      const title = String(data.content[locale]?.title || data.content.it?.title || '');
      const fallback = title
        ? title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80)
        : data.slugs.it;
      if (fallback) {
        data.slugs[locale] = fallback;
        console.warn(`  ⚠️  Slug ${locale} mancante, generato come fallback: "${fallback}"`);
      } else {
        throw new Error(`Slug mancante per ${locale}`);
      }
    }
  }
  if (!CATEGORIES.includes(data.category)) {
    const mapped = CATEGORY_MAP[data.category.toLowerCase()];
    if (mapped) {
      console.error(`⚠️  Categoria "${data.category}" mappata a "${mapped}"`);
      data.category = mapped;
    } else {
      console.error(`⚠️  Categoria "${data.category}" non riconosciuta, uso fallback "novita"`);
      data.category = 'novita';
    }
  }
  if (!AVAILABLE_IMAGES.includes(data.image)) {
    // Try keyword-based matching first, then fall back to hash-based rotation
    const matched = findBestFallbackImage(data);
    if (matched) {
      console.error(`⚠️  Immagine "${data.image}" non trovata, uso match per keyword: "${matched}"`);
      data._generatedImagePath = matched;
    } else {
      const hash = [...(data.id || '')].reduce((acc, c) => acc + c.charCodeAt(0), 0);
      const fallbackPath = FALLBACK_IMAGES[hash % FALLBACK_IMAGES.length];
      console.error(`⚠️  Immagine "${data.image}" non trovata, uso fallback casuale "${fallbackPath}" (pool: ${FALLBACK_IMAGES.length} immagini)`);
      data._generatedImagePath = fallbackPath;
    }
    data.image = PLACES_IMAGES[0]; // dummy value, _generatedImagePath takes priority
  }
  // Validate new image fields (non-blocking — provide defaults)
  if (!data.imagePrompt) {
    data.imagePrompt = `Professional editorial photo of Ticino Switzerland, Lake Lugano panorama, warm natural lighting`;
  }
  if (!data.imageAlt || typeof data.imageAlt !== 'object') {
    const itTitle = (data.content.it || data.content).title || data.id;
    data.imageAlt = {
      it: `Immagine editoriale relativa a: ${itTitle}`,
      en: `Editorial image related to: ${itTitle}`,
      de: `Redaktionelles Bild zu: ${itTitle}`,
      fr: `Image éditoriale relative à: ${itTitle}`,
    };
  }
  // Sanitize id
  data.id = data.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

  // Force Italian slug to match the article ID.
  // The AI can generate slugs.it ≠ id (e.g. "cadenazzo-s-antonino" vs "cadenazzo-2026"),
  // causing the logged/output URL to differ from the actual routed slug.
  // Convention: Italian slug === article id for all articles.
  data.slugs.it = data.id;

  // Sanitize ALL locale slugs: strip diacritics and non-ASCII characters.
  // AI models often generate slugs with accented characters (ä, ö, ü, é, è, etc.)
  // which cause XML parsing issues in sitemaps and Bing Webmaster Tools errors.
  for (const locale of ['en', 'de', 'fr']) {
    if (data.slugs[locale]) {
      const original = data.slugs[locale];
      data.slugs[locale] = String(data.slugs[locale])
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 80);
      if (data.slugs[locale] !== original) {
        console.warn(`  ⚠️  Slug ${locale} sanitizzato: "${original}" → "${data.slugs[locale]}"`);
      }
    }
  }

  // ── Validate internal links in body content ──
  const VALID_NAV_ACTIONS = new Set([
    'calculator', 'exchange', 'health', 'cost-of-living', 'pension', 'pillar3',
    'payslip', 'tax-return', 'residency', 'ristorni', 'unemployment', 'jobs', 'companies', 'banks',
    'first-day', 'permits', 'border', 'calendar', 'whatif', 'shopping', 'transport',
    'salary-compare', 'traffic-history',
    'border-map', 'municipalities', 'car-transfer', 'car-cost', 'permit-compare', 'renovation',
    'mobile', 'ral', 'parental-leave', 'nursery', 'living-ch', 'living-it', 'livability',
  ]);
  for (const locale of ['it', 'en', 'de', 'fr']) {
    if (!data.content[locale]) continue; // translations may not exist yet
    // Coerce content fields to strings — AI models can return objects/arrays/numbers
    for (const field of ['title', 'excerpt', 'body1', 'body2', 'body3']) {
      const val = data.content[locale][field];
      if (val != null && typeof val !== 'string') {
        data.content[locale][field] = typeof val === 'object' ? JSON.stringify(val) : String(val);
      }
    }
    for (const field of ['body1', 'body2', 'body3']) {
      let text = data.content[locale][field] || '';
      // Remove raw <a href="..."> tags the AI might have inserted — they cause redirect issues
      text = text.replace(/<a\s+href="[^"]*"[^>]*>(.*?)<\/a>/gi, '$1');
      // Validate [text](nav:action) links — remove invalid ones
      text = text.replace(/\[([^\]]+)\]\(nav:([a-z-]+)\)/g, (_m, linkText, action) => {
        if (VALID_NAV_ACTIONS.has(action)) return _m; // keep valid
        console.error(`  ⚠️  Link invalido [${linkText}](nav:${action}) in ${locale}.${field} — rimosso`);
        return linkText; // strip invalid nav link, keep text
      });
      data.content[locale][field] = text;
    }
    // Validate FAQ structure if present (keep as array, don't coerce to string)
    if (data.content[locale].faq) {
      const faq = data.content[locale].faq;
      if (typeof faq === 'string') {
        try { data.content[locale].faq = JSON.parse(faq); } catch { delete data.content[locale].faq; }
      }
      if (Array.isArray(data.content[locale].faq)) {
        data.content[locale].faq = data.content[locale].faq.filter(pair =>
          pair && typeof pair.q === 'string' && typeof pair.a === 'string' &&
          pair.q.length > 10 && pair.a.length > 20
        ).slice(0, 7);
        if (data.content[locale].faq.length < 2) delete data.content[locale].faq;
      } else {
        delete data.content[locale].faq;
      }
    }
  }

  // Coerce all seo fields to strings — AI models can return objects/arrays/numbers
  if (data.seo && typeof data.seo === 'object') {
    for (const key of ['title', 'description', 'keywords', 'ogTitle', 'ogDescription', 'headline', 'breadcrumbName']) {
      if (data.seo[key] != null && typeof data.seo[key] !== 'string') {
        data.seo[key] = typeof data.seo[key] === 'object' ? JSON.stringify(data.seo[key]) : String(data.seo[key]);
      }
    }
  }

  return data;
}
// Programmatic enforcement: strip excess **bold** from body content.
// Rules: max 3 bold spans per body field; each span max 5 words;
// never bold numbers with currency (e.g. **350 CHF**), case/scenario labels,
// or phrases longer than 5 words.
function sanitizeBoldFormatting(data) {
  const MAX_BOLD_PER_FIELD = 1;
  const MAX_BOLD_WORDS = 5;
  // Pattern: number + optional space + currency code or symbol
  const CURRENCY_RE = /^\d[\d.,]*\s*(?:CHF|EUR|€|Fr\.|franchi|euro)/i;
  // Pattern: "Caso N:" or "Case N:" or "Fall N:" or "Cas N:" style labels
  const CASE_LABEL_RE = /^(?:Caso|Case|Fall|Cas|Esempio|Example|Beispiel|Exemple)\s+\d/i;
  // Generic label pattern such as "Dati rilevanti:" / "Key updates:".
  const GENERIC_LABEL_RE = /^[\p{L}\s'-]{2,40}:$/u;
  // Do not bold names of internal tools/actions.
  const TOOL_NAME_RE = /\b(calcolatore|comparatore|simulatore|convertitore|rechner|calculator|comparator|simulator|converter|outil|tool|nav:)\b/i;

  let totalStripped = 0;

  for (const locale of ['it', 'en', 'de', 'fr']) {
    if (!data.content[locale]) continue; // translations may not exist yet
    for (const field of ['body1', 'body2', 'body3']) {
      let text = String(data.content[locale][field] || '');
      const boldMatches = [...text.matchAll(/\*\*([^*]+)\*\*/g)];
      if (boldMatches.length === 0) {
        data.content[locale][field] = text;
        continue;
      }

      let kept = 0;
      for (const match of boldMatches) {
        const boldContent = match[1].trim();
        const wordCount = boldContent.split(/\s+/).length;
        const isCurrency = CURRENCY_RE.test(boldContent);
        const isCaseLabel = CASE_LABEL_RE.test(boldContent);
        const isGenericLabel = GENERIC_LABEL_RE.test(boldContent);
        const isToolName = TOOL_NAME_RE.test(boldContent);
        const tooLong = wordCount > MAX_BOLD_WORDS;
        const overLimit = kept >= MAX_BOLD_PER_FIELD;

        if (isCurrency || isCaseLabel || isGenericLabel || isToolName || tooLong || overLimit) {
          // Strip bold markers, keep text
          text = text.replace(match[0], boldContent);
          totalStripped++;
        } else {
          kept++;
        }
      }

      data.content[locale][field] = text;
    }
  }

  if (totalStripped > 0) {
    console.error(`  ✂️  Grassetto ridotto: ${totalStripped} occorrenze rimosse (max ${MAX_BOLD_PER_FIELD}/campo, max ${MAX_BOLD_WORDS} parole)`);
  }

  return data;
}

// ── Step 3a.1: Validate CTA / internal links in body3 ──────
const CTA_KEYWORDS_IT = [
  'calcolatore', 'comparatore', 'simulatore', 'convertitore', 'pianificatore',
  'frontaliereticino', 'confronto', 'calcola', 'strumenti', 'strumento',
  'nostro sito', 'il nostro', 'piattaforma', 'scopri', 'prova',
];
const CTA_KEYWORDS_EN = ['calculator', 'comparator', 'simulator', 'converter', 'planner', 'our site', 'our platform', 'tool', 'try our', 'discover'];
const CTA_KEYWORDS_DE = ['rechner', 'vergleich', 'simulator', 'umrechner', 'planer', 'unsere plattform', 'tool', 'werkzeug', 'entdecken'];
const CTA_KEYWORDS_FR = ['calculateur', 'comparateur', 'simulateur', 'convertisseur', 'planificateur', 'notre site', 'notre plateforme', 'outil', 'découvrez'];

const CTA_POOL = [
  {
    it: '\n\nPer un calcolo preciso del tuo stipendio netto come frontaliere, usa il nostro [comparatore fiscale](nav:calculator): confronta il netto in busta tra permesso G e permesso B con tutte le deduzioni aggiornate al 2026.',
    en: '\n\nFor a precise net salary calculation, use our [tax comparator](nav:calculator): compare take-home pay between G and B permits with all 2026 deductions.',
    de: '\n\nFür eine genaue Nettogehaltsberechnung nutzen Sie unseren [Steuervergleichsrechner](nav:calculator): vergleichen Sie G- und B-Bewilligung mit allen Abzügen 2026.',
    fr: '\n\nPour un calcul précis du salaire net, utilisez notre [comparateur fiscal](nav:calculator) : comparez permis G et permis B avec toutes les déductions 2026.',
  },
  {
    it: '\n\nSe stai valutando un\'offerta in Ticino, simula la tua [busta paga netta](nav:payslip): inserisci RAL, stato civile e comune di residenza per un preventivo dettagliato.',
    en: '\n\nEvaluating a Ticino job offer? Simulate your [net payslip](nav:payslip): enter gross salary, marital status and municipality for a detailed breakdown.',
    de: '\n\nJobangebot im Tessin? Simulieren Sie Ihre [Netto-Gehaltsabrechnung](nav:payslip): Bruttolohn, Familienstand und Wohngemeinde eingeben.',
    fr: '\n\nOffre d\'emploi au Tessin? Simulez votre [fiche de paie nette](nav:payslip) : salaire brut, état civil et commune de résidence.',
  },
  {
    it: '\n\nConfronta il [tasso di cambio CHF/EUR](nav:exchange) in tempo reale tra i principali provider: risparmi fino a 1.5% sulle commissioni del bonifico mensile.',
    en: '\n\nCompare the [CHF/EUR exchange rate](nav:exchange) in real time across providers: save up to 1.5% on monthly transfer fees.',
    de: '\n\nVergleichen Sie den [CHF/EUR-Wechselkurs](nav:exchange) in Echtzeit: sparen Sie bis zu 1,5% bei den monatlichen Überweisungsgebühren.',
    fr: '\n\nComparez le [taux CHF/EUR](nav:exchange) en temps réel : économisez jusqu\'à 1,5% sur les frais de virement mensuel.',
  },
  {
    it: '\n\nScopri le [offerte di lavoro in Ticino](nav:jobs) aggiornate quotidianamente: oltre 4.000 posizioni da aziende svizzere che assumono frontalieri.',
    en: '\n\nDiscover [Ticino job offers](nav:jobs) updated daily: 4,000+ positions from Swiss companies hiring cross-border workers.',
    de: '\n\nEntdecken Sie [Stellenangebote im Tessin](nav:jobs) — täglich aktualisiert: über 4.000 Stellen von Schweizer Unternehmen.',
    fr: '\n\nDécouvrez les [offres d\'emploi au Tessin](nav:jobs) mises à jour quotidiennement : plus de 4.000 postes.',
  },
  {
    it: '\n\nPianifica la tua [previdenza da frontaliere](nav:pension): calcola AVS, secondo pilastro e coordinamento INPS per evitare sorprese al pensionamento.',
    en: '\n\nPlan your [cross-border pension](nav:pension): calculate AVS, second pillar and INPS coordination to avoid retirement surprises.',
    de: '\n\nPlanen Sie Ihre [Grenzgänger-Vorsorge](nav:pension): AHV, zweite Säule und INPS-Koordination berechnen.',
    fr: '\n\nPlanifiez votre [prévoyance frontalier](nav:pension) : calculez AVS, deuxième pilier et coordination INPS.',
  },
  {
    it: '\n\nConfronta i [premi LAMal delle casse malati](nav:health) svizzere: fino a 200 CHF di differenza mensile tra compagnie per lo stesso cantone e franchigia.',
    en: '\n\nCompare [LAMal health insurance premiums](nav:health): up to CHF 200 monthly difference between providers for the same canton and deductible.',
    de: '\n\nVergleichen Sie die [LAMal-Prämien der Krankenkassen](nav:health): bis zu 200 CHF monatlicher Unterschied zwischen Anbietern.',
    fr: '\n\nComparez les [primes LAMal](nav:health) : jusqu\'à 200 CHF de différence mensuelle entre assureurs pour le même canton.',
  },
  {
    it: '\n\nVerifica le [scadenze fiscali](nav:calendar) per frontalieri: 730, dichiarazione svizzera, ristorni — tutte le date in un calendario interattivo.',
    en: '\n\nCheck [tax deadlines](nav:calendar) for cross-border workers: returns, Swiss declarations, rebates — all dates in one interactive calendar.',
    de: '\n\nÜberprüfen Sie die [Steuerfristen](nav:calendar) für Grenzgänger: alle Termine in einem interaktiven Kalender.',
    fr: '\n\nVérifiez les [échéances fiscales](nav:calendar) : déclarations, ristournes — toutes les dates dans un calendrier interactif.',
  },
  {
    it: '\n\nÈ il tuo primo giorno come frontaliere? La nostra [guida pratica](nav:first-day) ti accompagna dalla registrazione cantonale al primo stipendio.',
    en: '\n\nFirst day as a cross-border worker? Our [practical guide](nav:first-day) walks you from cantonal registration to your first paycheck.',
    de: '\n\nErster Tag als Grenzgänger? Unser [praktischer Leitfaden](nav:first-day) begleitet Sie von der Anmeldung bis zum ersten Gehalt.',
    fr: '\n\nPremier jour en tant que frontalier? Notre [guide pratique](nav:first-day) vous accompagne de l\'inscription au premier salaire.',
  },
];

function pickDefaultCTA(articleCategory) {
  const preferred = { fiscale: [0, 1, 6], pratico: [1, 7, 3], novita: [3, 0, 2], pensione: [4, 0, 5] };
  const indices = preferred[articleCategory] || [0, 1, 2];
  return CTA_POOL[indices[Math.floor(Math.random() * indices.length)]];
}

const DEFAULT_CTA = CTA_POOL[0];

function validateAndEnforceCTA(data) {
  const localeKeywords = { it: CTA_KEYWORDS_IT, en: CTA_KEYWORDS_EN, de: CTA_KEYWORDS_DE, fr: CTA_KEYWORDS_FR };
  const cta = pickDefaultCTA(data.category);

  for (const locale of ['it', 'en', 'de', 'fr']) {
    if (!data.content[locale]) continue; // translations may not exist yet
    const body3 = (data.content[locale].body3 || '').toLowerCase();
    const keywords = localeKeywords[locale];
    const hasCTA = keywords.some(kw => body3.includes(kw));

    if (!hasCTA) {
      console.error(`  ⚠️  CTA mancante in body3 [${locale}] — aggiungo CTA (${data.category})`);
      data.content[locale].body3 += cta[locale];
    }
  }

  return data;
}

// ── Step 3a.2: Enforce strong internal-link clusters ───────
// Guarantees at least 2 internal nav links in article body for SEO distribution.
// Cluster focus: taxes (entro/oltre 20km), pension, exchange CHF/EUR.
const LINK_CLUSTER_PATTERNS = {
  taxes20km: /(20\s?km|entro\s*i\s*20|oltre\s*i\s*20|imposta|irpef|credito\s*d[' ]?imposta|doppia\s+imposizione|accordo\s+fiscale|fascia)/i,
  pension: /(pensione|avs|inps|lpp|secondo\s+pilastro|terzo\s+pilastro|pillar\s*3)/i,
  exchange: /(cambio|chf|eur|franco|euro|tasso\s*di\s*cambio|valuta|bonifico|wise)/i,
};

const LINK_CLUSTER_ACTIONS = {
  taxes20km: ['calculator', 'tax-return'],
  pension: ['pension', 'pillar3'],
  exchange: ['exchange', 'banks'],
  generic: ['calculator', 'exchange'],
};

const INTERNAL_LINK_BLOCK = {
  it: {
    taxes20km: '\n\n## Tool utili per il tuo caso\nPer verificare in modo pratico il tuo scenario entro/oltre 20 km, usa il [calcolatore stipendio netto](nav:calculator) e la [guida dichiarazione redditi](nav:tax-return).',
    pension: '\n\n## Tool utili per la pianificazione\nPer stimare la strategia previdenziale, prova il [pianificatore pensionistico](nav:pension) e il [simulatore 3° pilastro](nav:pillar3).',
    exchange: '\n\n## Tool utili per massimizzare il netto\nPer ridurre la perdita sul cambio, confronta il [cambio CHF-EUR](nav:exchange) e le [banche per frontalieri](nav:banks).',
    generic: '\n\n## Tool consigliati\nPer una stima aggiornata, usa il [calcolatore stipendio netto](nav:calculator) e il [comparatore cambio CHF-EUR](nav:exchange).',
  },
  en: {
    taxes20km: '\n\n## Useful tools for your case\nTo verify your within/over 20 km tax scenario, use the [net salary calculator](nav:calculator) and the [tax return guide](nav:tax-return).',
    pension: '\n\n## Useful planning tools\nTo estimate your pension strategy, use the [pension planner](nav:pension) and the [pillar 3 simulator](nav:pillar3).',
    exchange: '\n\n## Useful tools to protect your net income\nTo reduce FX leakage, compare [CHF-EUR exchange options](nav:exchange) and [banks for cross-border workers](nav:banks).',
    generic: '\n\n## Recommended tools\nFor an updated estimate, use the [net salary calculator](nav:calculator) and the [CHF-EUR exchange comparator](nav:exchange).',
  },
  de: {
    taxes20km: '\n\n## Nützliche Tools für Ihren Fall\nUm Ihr Steuer-Szenario innerhalb/außerhalb von 20 km zu prüfen, nutzen Sie den [Nettolohnrechner](nav:calculator) und den [Leitfaden zur Steuererklärung](nav:tax-return).',
    pension: '\n\n## Nützliche Tools für die Planung\nFür Ihre Vorsorgestrategie nutzen Sie den [Rentenplaner](nav:pension) und den [Säule-3-Simulator](nav:pillar3).',
    exchange: '\n\n## Nützliche Tools zum Schutz Ihres Nettolohns\nUm Wechselkursverluste zu reduzieren, vergleichen Sie [CHF-EUR-Wechseloptionen](nav:exchange) und [Banken für Grenzgänger](nav:banks).',
    generic: '\n\n## Empfohlene Tools\nFür eine aktuelle Schätzung nutzen Sie den [Nettolohnrechner](nav:calculator) und den [CHF-EUR-Wechselvergleich](nav:exchange).',
  },
  fr: {
    taxes20km: '\n\n## Outils utiles pour votre cas\nPour vérifier votre scénario fiscal dans/hors des 20 km, utilisez le [calculateur de salaire net](nav:calculator) et le [guide déclaration fiscale](nav:tax-return).',
    pension: '\n\n## Outils utiles pour la planification\nPour estimer votre stratégie retraite, utilisez le [planificateur retraite](nav:pension) et le [simulateur 3e pilier](nav:pillar3).',
    exchange: '\n\n## Outils utiles pour protéger votre net\nPour réduire les pertes de change, comparez le [change CHF-EUR](nav:exchange) et les [banques pour frontaliers](nav:banks).',
    generic: '\n\n## Outils recommandés\nPour une estimation à jour, utilisez le [calculateur de salaire net](nav:calculator) et le [comparateur CHF-EUR](nav:exchange).',
  },
};

function enforceStrongInternalLinks(data) {
  for (const locale of ['it', 'en', 'de', 'fr']) {
    if (!data.content[locale]) continue;

    const body1 = String(data.content[locale].body1 || '');
    const body2 = String(data.content[locale].body2 || '');
    const body3 = String(data.content[locale].body3 || '');
    const context = `${data.id} ${data.content[locale].title || ''} ${data.content[locale].excerpt || ''} ${body1} ${body2} ${body3}`;

    const cluster =
      LINK_CLUSTER_PATTERNS.taxes20km.test(context) ? 'taxes20km'
      : LINK_CLUSTER_PATTERNS.pension.test(context) ? 'pension'
      : LINK_CLUSTER_PATTERNS.exchange.test(context) ? 'exchange'
      : 'generic';

    const actions = LINK_CLUSTER_ACTIONS[cluster];
    const combined = `${body1}\n${body2}\n${body3}`;
    const existingActions = new Set(
      [...combined.matchAll(/\[[^\]]+\]\(nav:([a-z-]+)\)/g)].map((m) => m[1])
    );
    const hasAllClusterLinks = actions.every((action) => existingActions.has(action));
    const totalLinks = [...combined.matchAll(/\[[^\]]+\]\(nav:[a-z-]+\)/g)].length;

    if (!hasAllClusterLinks || totalLinks < 2) {
      data.content[locale].body2 = `${body2}${INTERNAL_LINK_BLOCK[locale][cluster]}`;
      console.error(`  🔗 Link interni rinforzati in ${locale}.body2 (cluster: ${cluster})`);
    }
  }

  return data;
}

function optimizeSeoMetadata(data) {
  const it = data.content?.it || {};
  if (!data.seo) data.seo = {};

  const TITLE_SUFFIX = ' | Frontaliere Ticino';
  const TITLE_MAX = 60;
  const coreBudget = TITLE_MAX - TITLE_SUFFIX.length; // 40 chars for the core title
  const baseTitle = truncateAtWordBoundary(it.title || data.id || 'Articolo frontalieri', coreBudget);
  const seoTitleCore = baseTitle.replace(/\s*\|\s*Frontaliere Ticino$/i, '');
  const fullTitle = `${seoTitleCore}${TITLE_SUFFIX}`;
  data.seo.title = fullTitle.length <= TITLE_MAX
    ? fullTitle
    : truncateAtWordBoundary(seoTitleCore, TITLE_MAX);
  data.seo.ogTitle = truncateAtWordBoundary(data.seo.ogTitle || seoTitleCore, TITLE_MAX);
  data.seo.headline = truncateAtWordBoundary(data.seo.headline || seoTitleCore, 100);
  data.seo.breadcrumbName = truncateAtWordBoundary(
    data.seo.breadcrumbName || seoTitleCore.split(/[:.–—]/)[0] || 'Articolo',
    42,
  );

  let desc = String(data.seo.description || it.excerpt || '').replace(/\s+/g, ' ').trim();
  if (!desc) desc = `${seoTitleCore}. Guida pratica per frontalieri tra Ticino e Italia con dati aggiornati 2026.`;
  if (desc.length < 145) {
    desc = `${desc}${desc.endsWith('.') ? '' : '.'} Dati aggiornati 2026 per frontalieri in Ticino.`;
  }
  data.seo.description = truncateAtWordBoundary(desc, 160);
  data.seo.ogDescription = truncateAtWordBoundary(data.seo.ogDescription || data.seo.description, 160);

  const STOP = new Set(['frontaliere', 'frontalieri', 'ticino', 'svizzera', 'italia', 'della', 'delle', 'degli', 'degli', 'come', 'guida', '2026']);
  const terms = `${it.title || ''} ${it.excerpt || ''} ${data.id || ''}`
    .toLowerCase()
    .replace(/[^a-z0-9àèéìòùäöüßç\s-]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w));

  const uniqueTerms = [];
  for (const t of terms) {
    if (!uniqueTerms.includes(t)) uniqueTerms.push(t);
    if (uniqueTerms.length >= 4) break;
  }
  const baseKeywords = ['frontalieri', 'ticino', 'svizzera', 'italia'];
  data.seo.keywords = [...baseKeywords, ...uniqueTerms].slice(0, 8).join(', ');

  return data;
}

// ── Pre-flight evergreen keyword check ──────────────────────
// Lightweight duplicate check: compares evergreen keyword words against
// existing article titles using Jaccard similarity. Runs BEFORE calling
// Gemini to avoid wasting API calls on keywords that will certainly fail
// the post-generation duplicate detector.
function preFlightEvergreenCheck(keyword) {
  const blogItSrc = read('services/locales/blog-meta-it.ts');
  const titleMatches = [...blogItSrc.matchAll(/'blog\.article\.([^.]+)\.title':\s*'([^']+)'/g)];

  const STOP_WORDS_IT = new Set([
    'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', 'di', 'a', 'da',
    'in', 'con', 'su', 'per', 'tra', 'fra', 'e', 'o', 'ma', 'che', 'non',
    'del', 'al', 'dal', 'nel', 'sul', 'dello', 'alla', 'della', 'dei', 'degli',
    'delle', 'ai', 'dai', 'nei', 'sui', 'è', 'sono', 'come', 'più', 'anche',
    'già', 'ancora', 'questo', 'questa', 'questi', 'queste', 'quello', 'quella',
    'molto', 'poco', 'tutto', 'tutti', 'ogni', 'altro', 'altra', 'altri', 'altre',
    'suo', 'sua', 'suoi', 'sue', 'loro', 'chi', 'cosa', 'dove', 'quando',
    'mentre', 'dopo', 'prima', 'tra', 'fino', 'solo', 'nuovo', 'nuova', 'nuovi',
    'base', 'rispetto', 'ultimo', 'ultima', 'ultimi', 'ultime',
  ]);

  // ── Italian stemmer (suffix stripping) ──────────────────────
  function stemIt(word) {
    if (word.length <= 3) return word;
    const suffixes = [
      'izzazione', 'izzazioni',
      'amento', 'amenti', 'imento', 'imenti',
      'zione', 'zioni', 'sione', 'sioni',
      'abile', 'ibili', 'mente',
      'iere', 'ieri', 'iera', 'ance', 'enza', 'enze',
      'ante', 'anti', 'ente', 'enti',
      'ario', 'aria', 'ari',
      'tore', 'tori', 'trice', 'trici',
      'ista', 'isti', 'iste',
      'oso', 'osa', 'osi', 'ose',
      'ale', 'ali', 'ile', 'ili',
      'ato', 'ata', 'ati', 'ate', 'ito', 'ita', 'iti', 'ite',
      'ano', 'ana', 'ani', 'ane',
      'ino', 'ina', 'ini', 'ine',
      'one', 'oni',
      'ore', 'ori',
      'ura', 'ure',
      'io', 'ia', 'ie',
      'à', 'tà',
      'ere', 'are', 'ire',
    ];
    for (const s of suffixes) {
      if (word.endsWith(s) && (word.length - s.length) >= 3) {
        return word.slice(0, -s.length);
      }
    }
    if (/[aeiou]$/.test(word) && word.length > 4) {
      return word.slice(0, -1);
    }
    return word;
  }

  const SYNONYM_GROUPS = [
    ['maternità', 'maternita', 'paternità', 'paternita', 'congedo', 'parentale', 'genitoriale', 'nascita', 'neonato', 'gestante', 'puerperio'],
    ['imposta', 'tassa', 'tasse', 'fiscale', 'fiscali', 'fisco', 'tributario', 'tributaria', 'irpef', 'imposizione'],
    ['stipendio', 'salario', 'retribuzione', 'busta', 'paga', 'reddito', 'ral', 'compenso', 'emolumento'],
    ['frontaliere', 'frontalieri', 'frontaliera', 'transfrontaliero', 'transfrontaliera', 'pendolare', 'pendolari', 'cross-border'],
    ['assicurazione', 'assicurazioni', 'copertura', 'polizza', 'lamal', 'cassa', 'malati', 'premio', 'premi'],
    ['pensione', 'pensioni', 'pensionamento', 'previdenza', 'avs', 'lpp', 'pilastro', 'rendita', 'rendite'],
    ['permesso', 'permessi', 'autorizzazione', 'autorizzazioni', 'visto'],
    ['trasporto', 'trasporti', 'mobilità', 'mobilita', 'pendolarismo', 'treno', 'treni', 'bus', 'auto', 'traffico'],
    ['casa', 'abitazione', 'alloggio', 'affitto', 'immobiliare', 'immobile', 'appartamento'],
    ['banca', 'bancario', 'bancaria', 'conto', 'finanza', 'finanziario', 'finanziaria'],
    ['lavoro', 'lavorare', 'lavoratore', 'lavoratori', 'lavoratrice', 'occupazione', 'impiego', 'mestiere'],
    ['figlio', 'figli', 'figlia', 'figlie', 'bambino', 'bambini', 'bambina', 'bambine', 'minore', 'minori'],
    ['svizzera', 'svizzero', 'elvetico', 'elvetica', 'confederazione', 'ch'],
    ['italia', 'italiano', 'italiana', 'italiani', 'italiane', 'tricolore', 'belpaese'],
    ['cambio', 'valuta', 'tasso', 'conversione', 'forex', 'chf', 'eur', 'euro', 'franco', 'franchi'],
    ['costo', 'costi', 'spesa', 'spese', 'prezzo', 'prezzi', 'tariffa', 'tariffe'],
    ['guida', 'tutorial', 'manuale', 'istruzioni', 'procedura', 'procedure', 'howto'],
    ['scuola', 'scolastico', 'scolastica', 'istruzione', 'educazione', 'asilo', 'nido'],
    ['sanità', 'sanita', 'sanitario', 'sanitaria', 'salute', 'medico', 'medica', 'ospedale', 'clinica'],
    ['lavori', 'cantiere', 'cantieri', 'risanamento', 'manutenzione', 'interventi', 'costruzione', 'ristrutturazione', 'rifacimento', 'pavimentazione'],
    ['strada', 'stradale', 'stradali', 'autostrada', 'autostradale', 'viabilità', 'viabilita', 'carreggiata', 'corsia'],
  ];

  const synonymMap = new Map();
  for (const group of SYNONYM_GROUPS) {
    const canonical = group[0];
    for (const w of group) synonymMap.set(w, canonical);
  }

  function normalize(word) {
    if (synonymMap.has(word)) return synonymMap.get(word);
    const stemmed = stemIt(word);
    if (synonymMap.has(stemmed)) return synonymMap.get(stemmed);
    return stemmed;
  }

  function getWords(text) {
    return text.toLowerCase()
      .replace(/[^a-zàáèéìíòóùú0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS_IT.has(w))
      .map(w => normalize(w));
  }

  function jaccard(a, b) {
    const sa = new Set(a), sb = new Set(b);
    if (sa.size === 0 && sb.size === 0) return 0;
    const inter = [...sa].filter(w => sb.has(w)).length;
    const union = new Set([...sa, ...sb]).size;
    return union === 0 ? 0 : inter / union;
  }

  const kwWords = getWords(keyword);
  const PRE_FLIGHT_THRESHOLD = 0.58; // less aggressive to avoid blocking valid new evergreen topics

  for (const m of titleMatches) {
    const existingTitle = m[2];
    const existingId = m[1];
    const titleWords = getWords(existingTitle);
    const sim = jaccard(kwWords, titleWords);
    if (sim >= PRE_FLIGHT_THRESHOLD) {
      return { duplicate: true, sim, existingTitle, existingId };
    }
  }
  return { duplicate: false };
}

// ── Step 3a.2: Programmatic duplicate detection (multi-signal) ──
function checkForDuplicates(data) {
  // Read existing article titles AND excerpts from blog-meta-it.ts
  const blogItSrc = read('services/locales/blog-meta-it.ts');
  const titleMatches = [...blogItSrc.matchAll(/'blog\.article\.([^.]+)\.title':\s*'([^']+)'/g)];
  const excerptMatches = [...blogItSrc.matchAll(/'blog\.article\.([^.]+)\.excerpt':\s*'([^']+)'/g)];
  const existingArticles = titleMatches.map(m => {
    const id = m[1];
    const title = m[2];
    const exMatch = excerptMatches.find(e => e[1] === id);
    return { id, title, excerpt: exMatch ? exMatch[2] : '' };
  });

  // Also check IDs for exact match
  const routerSrc = read('services/routerBlogData.ts');
  const idMatch = routerSrc.match(/ALL_BLOG_ARTICLE_IDS.*?\[([^\]]+)\]/s);
  const existingIds = idMatch ? idMatch[1].match(/'([^']+)'/g)?.map(s => s.slice(1, -1)) || [] : [];

  // 1. Exact ID check
  if (existingIds.includes(data.id)) {
    throw new Error(`❌ DUPLICATO: L'ID "${data.id}" esiste già tra gli articoli pubblicati!`);
  }

  // ── NLP utilities ──────────────────────────────────────────
  const STOP_WORDS_IT = new Set([
    'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', 'di', 'a', 'da',
    'in', 'con', 'su', 'per', 'tra', 'fra', 'e', 'o', 'ma', 'che', 'non',
    'del', 'al', 'dal', 'nel', 'sul', 'dello', 'alla', 'della', 'dei', 'degli',
    'delle', 'ai', 'dai', 'nei', 'sui', 'è', 'sono', 'come', 'più', 'anche',
    'già', 'ancora', 'questo', 'questa', 'questi', 'queste', 'quello', 'quella',
    'molto', 'poco', 'tutto', 'tutti', 'ogni', 'altro', 'altra', 'altri', 'altre',
    'suo', 'sua', 'suoi', 'sue', 'loro', 'chi', 'cosa', 'dove', 'quando',
    'mentre', 'dopo', 'prima', 'tra', 'fino', 'solo', 'nuovo', 'nuova', 'nuovi',
    'base', 'rispetto', 'ultimo', 'ultima', 'ultimi', 'ultime',
  ]);

  // ── Italian stemmer (suffix stripping) ──────────────────────
  function stemIt(word) {
    if (word.length <= 3) return word;
    // Longest-suffix-first order
    const suffixes = [
      'izzazione', 'izzazioni',
      'amento', 'amenti', 'imento', 'imenti',
      'zione', 'zioni', 'sione', 'sioni',
      'abile', 'ibili', 'mente',
      'iere', 'ieri', 'iera', 'ance', 'enza', 'enze',
      'ante', 'anti', 'ente', 'enti',
      'ario', 'aria', 'ari',
      'tore', 'tori', 'trice', 'trici',
      'ista', 'isti', 'iste',
      'oso', 'osa', 'osi', 'ose',
      'ale', 'ali', 'ile', 'ili',
      'ato', 'ata', 'ati', 'ate', 'ito', 'ita', 'iti', 'ite',
      'ano', 'ana', 'ani', 'ane',
      'ino', 'ina', 'ini', 'ine',
      'one', 'oni',
      'ore', 'ori',
      'ura', 'ure',
      'io', 'ia', 'ie',
      'à', 'tà',
      'ere', 'are', 'ire',
    ];
    for (const s of suffixes) {
      if (word.endsWith(s) && (word.length - s.length) >= 3) {
        return word.slice(0, -s.length);
      }
    }
    // Strip trailing vowel if stem long enough
    if (/[aeiou]$/.test(word) && word.length > 4) {
      return word.slice(0, -1);
    }
    return word;
  }

  // ── Domain synonym groups ──────────────────────────────────
  const SYNONYM_GROUPS = [
    ['maternità', 'maternita', 'paternità', 'paternita', 'congedo', 'parentale', 'genitoriale', 'nascita', 'neonato', 'gestante', 'puerperio'],
    ['imposta', 'tassa', 'tasse', 'fiscale', 'fiscali', 'fisco', 'tributario', 'tributaria', 'irpef', 'imposizione'],
    ['stipendio', 'salario', 'retribuzione', 'busta', 'paga', 'reddito', 'ral', 'compenso', 'emolumento'],
    ['frontaliere', 'frontalieri', 'frontaliera', 'transfrontaliero', 'transfrontaliera', 'pendolare', 'pendolari', 'cross-border'],
    ['assicurazione', 'assicurazioni', 'copertura', 'polizza', 'lamal', 'cassa', 'malati', 'premio', 'premi'],
    ['pensione', 'pensioni', 'pensionamento', 'previdenza', 'avs', 'lpp', 'pilastro', 'rendita', 'rendite'],
    ['permesso', 'permessi', 'autorizzazione', 'autorizzazioni', 'visto'],
    ['trasporto', 'trasporti', 'mobilità', 'mobilita', 'pendolarismo', 'treno', 'treni', 'bus', 'auto', 'traffico'],
    ['casa', 'abitazione', 'alloggio', 'affitto', 'immobiliare', 'immobile', 'appartamento'],
    ['banca', 'bancario', 'bancaria', 'conto', 'finanza', 'finanziario', 'finanziaria'],
    ['lavoro', 'lavorare', 'lavoratore', 'lavoratori', 'lavoratrice', 'occupazione', 'impiego', 'mestiere'],
    ['figlio', 'figli', 'figlia', 'figlie', 'bambino', 'bambini', 'bambina', 'bambine', 'minore', 'minori'],
    ['svizzera', 'svizzero', 'elvetico', 'elvetica', 'confederazione', 'ch'],
    ['italia', 'italiano', 'italiana', 'italiani', 'italiane', 'tricolore', 'belpaese'],
    ['cambio', 'valuta', 'tasso', 'conversione', 'forex', 'chf', 'eur', 'euro', 'franco', 'franchi'],
    ['costo', 'costi', 'spesa', 'spese', 'prezzo', 'prezzi', 'tariffa', 'tariffe'],
    ['guida', 'tutorial', 'manuale', 'istruzioni', 'procedura', 'procedure', 'howto'],
    ['scuola', 'scolastico', 'scolastica', 'istruzione', 'educazione', 'asilo', 'nido'],
    ['sanità', 'sanita', 'sanitario', 'sanitaria', 'salute', 'medico', 'medica', 'ospedale', 'clinica'],
    ['lavori', 'cantiere', 'cantieri', 'risanamento', 'manutenzione', 'interventi', 'costruzione', 'ristrutturazione', 'rifacimento', 'pavimentazione'],
    ['strada', 'stradale', 'stradali', 'autostrada', 'autostradale', 'viabilità', 'viabilita', 'carreggiata', 'corsia'],
  ];

  // Build reverse lookup: word → canonical (first word of its group)
  const synonymMap = new Map();
  for (const group of SYNONYM_GROUPS) {
    const canonical = group[0];
    for (const w of group) synonymMap.set(w, canonical);
  }

  /** Stem + synonym-normalize a single word */
  function normalize(word) {
    // Check synonym map first (before stemming) for exact domain matches
    if (synonymMap.has(word)) return synonymMap.get(word);
    const stemmed = stemIt(word);
    if (synonymMap.has(stemmed)) return synonymMap.get(stemmed);
    return stemmed;
  }

  function getSignificantWords(text) {
    return text.toLowerCase()
      .replace(/[^a-zàáèéìíòóùú0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS_IT.has(w))
      .map(w => normalize(w));
  }

  function jaccardSimilarity(wordsA, wordsB) {
    const setA = new Set(wordsA);
    const setB = new Set(wordsB);
    if (setA.size === 0 && setB.size === 0) return 0;
    const intersection = [...setA].filter(w => setB.has(w)).length;
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 0 : intersection / union;
  }

  // Extract key numbers, percentages, and statistics from text
  // These are strong duplicate signals (e.g. both articles cite "411.000" and "-1,0%")
  function extractKeyEntities(text) {
    const entities = new Set();
    const s = String(text || '');
    // Normalize: keep digits, dots, commas, %, +/-
    // Numbers like 411.000, 78'809, 411000
    for (const m of s.matchAll(/\d[\d.'',]*\d/g)) {
      entities.add(m[0].replace(/[.''',]/g, '')); // normalize to plain digits
    }
    // Standalone single digits with context (e.g. "Q4", "1%")
    for (const m of s.matchAll(/\b(\d+)[.,]?(\d*)\s*%/g)) {
      entities.add(`${m[1]}${m[2]}%`);
    }
    return [...entities];
  }

  // ── Prepare new article signals ────────────────────────────
  const newIdWords = data.id.split('-').filter(w => w.length > 1).map(w => normalize(w));
  const newTitleWords = getSignificantWords(data.content.it.title);
  const newExcerptWords = getSignificantWords(data.content.it.excerpt || '');
  const newEntities = extractKeyEntities(
    data.content.it.title + ' ' + (data.content.it.excerpt || '')
  );

  // ── Thresholds ─────────────────────────────────────────────
  // Any single signal OR the combined score exceeding its threshold → duplicate
  const ID_THRESHOLD = 0.72;       // stricter: reduce false-positive duplicate IDs
  const TITLE_THRESHOLD = 0.58;    // stricter: similar theme is OK, near-identical title is not
  const EXCERPT_THRESHOLD = 0.50;  // stricter excerpt match
  const COMBINED_THRESHOLD = 0.48; // catch semantically similar articles with different wording

  console.error(`  🔍 Controllo duplicati multi-segnale (${existingArticles.length} articoli esistenti)...`);

  for (const existing of existingArticles) {
    const existingIdWords = existing.id.split('-').filter(w => w.length > 1).map(w => normalize(w));
    const existingTitleWords = getSignificantWords(existing.title);
    const existingExcerptWords = getSignificantWords(existing.excerpt);
    const existingEntities = extractKeyEntities(existing.title + ' ' + existing.excerpt);

    // Compute individual similarity scores
    const idSim = jaccardSimilarity(newIdWords, existingIdWords);
    const titleSim = jaccardSimilarity(newTitleWords, existingTitleWords);
    const excerptSim = jaccardSimilarity(newExcerptWords, existingExcerptWords);
    const entitySim = jaccardSimilarity(newEntities, existingEntities);

    // Weighted combined score
    const combinedScore =
      0.25 * idSim +
      0.30 * titleSim +
      0.25 * excerptSim +
      0.20 * entitySim;

    // Any signal OR combined score triggers duplicate detection
    const isDuplicate =
      (idSim >= ID_THRESHOLD && titleSim >= 0.40) ||
      titleSim >= TITLE_THRESHOLD ||
      (excerptSim >= EXCERPT_THRESHOLD && entitySim >= 0.20) ||
      // High entity overlap (same place/date/event) with moderate combined score
      (entitySim >= 0.55 && combinedScore >= 0.40) ||
      combinedScore >= COMBINED_THRESHOLD;

    if (isDuplicate) {
      const signals = [];
      if (idSim >= ID_THRESHOLD)
        signals.push(`ID: ${(idSim * 100).toFixed(0)}% ≥ ${ID_THRESHOLD * 100}%`);
      if (titleSim >= TITLE_THRESHOLD)
        signals.push(`Titolo: ${(titleSim * 100).toFixed(0)}% ≥ ${TITLE_THRESHOLD * 100}%`);
      if (excerptSim >= EXCERPT_THRESHOLD)
        signals.push(`Excerpt: ${(excerptSim * 100).toFixed(0)}% ≥ ${EXCERPT_THRESHOLD * 100}%`);
      if (combinedScore >= COMBINED_THRESHOLD)
        signals.push(`Combinato: ${(combinedScore * 100).toFixed(0)}% ≥ ${COMBINED_THRESHOLD * 100}%`);

      throw new Error(
        `❌ DUPLICATO RILEVATO:\n` +
        `   Nuovo:     "${data.content.it.title}" [${data.id}]\n` +
        `   Esistente: "${existing.title}" [${existing.id}]\n` +
        `   Segnali:   ${signals.join(' | ')}\n` +
        `   Dettaglio: ID=${(idSim * 100).toFixed(0)}% Titolo=${(titleSim * 100).toFixed(0)}% Excerpt=${(excerptSim * 100).toFixed(0)}% Entità=${(entitySim * 100).toFixed(0)}% Combinato=${(combinedScore * 100).toFixed(0)}%\n` +
        `   Scegli un argomento diverso o più specifico.`
      );
    }
  }

  // 3. Also check slug overlap (different title, same slug concept)
  for (const locale of ['it']) {
    const newSlug = data.slugs[locale];
    const slugPattern = new RegExp(`'${escapeRegex(newSlug)}'`, 'g');
    if (slugPattern.test(routerSrc)) {
      throw new Error(`❌ DUPLICATO: Lo slug "${newSlug}" esiste già in router.ts!`);
    }
  }

  console.error('  ✅ Nessun duplicato rilevato');
  return data;
}

// ── Image search helpers ──

/** Map of Italian keywords from article titles → English Wikimedia search terms */
const TOPIC_SEARCH_MAP = [
  { keywords: ['benzina', 'carburante', 'petrolio', 'diesel', 'rifornimento'], queries: ['fuel station Switzerland', 'gas pump Europe'] },
  { keywords: ['tasse', 'fiscale', 'imposta', 'irpef', 'fisco', 'deduzioni'], queries: ['tax office building', 'financial documents desk'] },
  { keywords: ['salute', 'malattia', 'lamal', 'assicurazione', 'premio'], queries: ['hospital Switzerland modern', 'health insurance card'] },
  { keywords: ['lavoro', 'impiego', 'occupazione', 'assunzione', 'disoccup'], queries: ['modern office workplace', 'job interview meeting'] },
  { keywords: ['confine', 'dogana', 'frontiera', 'frontalier', 'permesso'], queries: ['Swiss Italian border crossing', 'customs checkpoint Europe'] },
  { keywords: ['treno', 'ferrovia', 'trasporto', 'pendolar', 'tilo'], queries: ['train station Switzerland', 'commuter train Alps'] },
  { keywords: ['casa', 'affitto', 'immobiliare', 'appartamento', 'mutuo'], queries: ['apartment building Switzerland', 'residential area Ticino'] },
  { keywords: ['banca', 'finanziario', 'cambio', 'valuta', 'franco', 'euro'], queries: ['Swiss bank building', 'currency exchange counter'] },
  { keywords: ['scuola', 'formazione', 'educazione', 'universit', 'corso'], queries: ['university campus Switzerland', 'classroom education'] },
  { keywords: ['pensione', 'avs', 'pilastro', 'previdenza', 'anzian'], queries: ['retirement couple walking', 'pension fund documents'] },
  { keywords: ['salario', 'stipendio', 'busta paga', 'reddito', 'retribuzion'], queries: ['salary paycheck document', 'business accounting office'] },
  { keywords: ['dumping', 'sindacat', 'contratto', 'ccl'], queries: ['labor union protest Switzerland', 'workers rights demonstration'] },
  { keywords: ['voto', 'elezioni', 'referendum', 'iniziativa', 'parlament'], queries: ['Swiss parliament Bern', 'voting ballot Switzerland'] },
  { keywords: ['clima', 'meteo', 'alluvione', 'tempesta', 'neve'], queries: ['weather Alps Switzerland', 'storm clouds mountains'] },
  { keywords: ['polizia', 'sicurezza', 'reato', 'accident'], queries: ['police patrol Switzerland', 'road safety checkpoint'] },
  { keywords: ['ospedale', 'medico', 'farmacia', 'sanitar'], queries: ['medical center Switzerland', 'doctor consultation'] },
  { keywords: ['costruzione', 'cantiere', 'ediliz', 'ristrutturazione'], queries: ['construction site Switzerland', 'building renovation'] },
  { keywords: ['supermercato', 'spesa', 'prezzi', 'costo vita'], queries: ['supermarket grocery store', 'shopping food prices'] },
  { keywords: ['auto', 'macchina', 'traffico', 'stradale', 'autostrada'], queries: ['highway traffic Switzerland', 'car road Alps'] },
  { keywords: ['economia', 'pil', 'crescita', 'mercato', 'commercial'], queries: ['business district Zurich', 'economic growth chart'] },
  { keywords: ['bambini', 'famiglia', 'asilo', 'nido', 'genitor'], queries: ['family park Switzerland', 'kindergarten playground'] },
  { keywords: ['golfo', 'guerra', 'conflitto', 'geopolitica', 'medio oriente'], queries: ['oil tanker shipping port', 'cargo ship Mediterranean'] },
  { keywords: ['tecnologia', 'digitale', 'intelligenza artificiale', 'innovation'], queries: ['technology office workspace', 'digital innovation center'] },
];

/** Build topic-specific search queries from article data */
function _buildWikimediaQueries(data) {
  const title = (data.title || data.content?.it?.title || data.content?.title || '').toLowerCase();
  const category = (data.category || '').toLowerCase();
  const queries = [];

  // 1. Extract topic-based queries from title keywords
  for (const entry of TOPIC_SEARCH_MAP) {
    if (entry.keywords.some(k => title.includes(k))) {
      queries.push(...entry.queries);
      if (queries.length >= 3) break; // Max 3 topic queries
    }
  }

  // 2. Check for city names in title
  const cities = ['lugano', 'bellinzona', 'locarno', 'mendrisio', 'chiasso', 'ascona'];
  const cityMatch = cities.find(c => title.includes(c));
  if (cityMatch) {
    queries.push(`${cityMatch} Switzerland photo`);
  }

  // 3. Category-based fallback if no topic match
  if (queries.length === 0) {
    const catMap = {
      novita: ['Switzerland news editorial photo', 'Ticino newspaper press'],
      fisco: ['tax office documents Swiss', 'financial calculation desk'],
      lavoro: ['modern office workspace Swiss', 'job interview professional'],
      salute: ['Swiss hospital medical center', 'health care pharmacy'],
      vita: ['daily life Switzerland Ticino', 'Swiss town square people'],
      economia: ['business district Swiss bank', 'economy finance Zurich'],
    };
    if (catMap[category]) {
      queries.push(...catMap[category]);
    }
  }

  // 4. Diverse generic fallbacks (rotated by day to avoid repetition)
  const generics = [
    'Swiss Alps panorama mountain', 'Lake Lugano sunset boating',
    'Ticino village stone street', 'Bellinzona castle medieval',
    'Mendrisio vineyard autumn', 'Locarno piazza grande',
    'Swiss Italian architecture colorful', 'Gotthard pass scenic road',
    'Como lake panorama', 'Swiss railway bridge Ticino',
    'Ascona lakefront promenade', 'Lugano Monte Bre funicular',
  ];
  // Select 2-3 generics rotated by day of year
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86400000);
  for (let i = 0; i < 3; i++) {
    const idx = (dayOfYear + i * 4 + (data.id || '').length) % generics.length;
    if (!queries.includes(generics[idx])) {
      queries.push(generics[idx]);
    }
  }

  return queries;
}

/** Load previously used Wikimedia image URLs to avoid repeats */
function _loadUsedImageUrls() {
  const trackingFile = path.join(process.cwd(), 'data', 'blog-images-used.json');
  try {
    const raw = readFileSync(trackingFile, 'utf8');
    const entries = JSON.parse(raw);
    return new Set(Object.values(entries));
  } catch {
    return new Set();
  }
}

/** Save a used Wikimedia image URL for dedup tracking */
function _saveUsedImageUrl(articleId, imageUrl) {
  const trackingFile = path.join(process.cwd(), 'data', 'blog-images-used.json');
  let entries = {};
  try {
    entries = JSON.parse(readFileSync(trackingFile, 'utf8'));
  } catch { /* first use */ }
  entries[articleId] = imageUrl;
  writeFileSync(trackingFile, JSON.stringify(entries, null, 2) + '\n');
}

async function generateArticleImage(data) {
  const prompt = (data.imagePrompt || `Professional editorial photo for a news article about cross-border workers in Ticino, Switzerland. Lake Lugano, warm lighting.`)
    + '\n\nIMPORTANT: Generate ONLY the image, do NOT include any text, watermarks, labels, or captions on the image.'
    + '\n\nSTYLE: Photorealistic editorial photograph indistinguishable from a real DSLR/mirrorless camera shot. Include natural lens characteristics: shallow depth of field, subtle chromatic aberration, realistic bokeh on out-of-focus areas, natural film grain, slight vignetting. Lighting must be natural and ambient — avoid flat, evenly-lit AI look. Include micro-imperfections: slight motion blur on peripheral elements, natural color temperature shifts, realistic shadow falloff. Absolutely NO AI artifacts, NO unnaturally smooth textures, NO perfect symmetry, NO CGI plastic look, NO HDR over-processing.';

  const imgDir = resolve('public/images/blog');
  mkdirSync(imgDir, { recursive: true });
  const imgPath = resolve(`public/images/blog/${data.id}.jpg`);

  // ── Helper: save raw image buffer, optimize, return path or null ──
  async function _saveAndOptimize(rawBuffer, providerLabel, contentType = 'image/jpeg') {
    if (rawBuffer.length < 5000) {
      console.error(`  ⚠️ Immagine troppo piccola (${rawBuffer.length} bytes) da ${providerLabel}`);
      return null;
    }
    const sourceExt = (contentType || '').includes('png') ? 'png' : (contentType || '').includes('webp') ? 'webp' : 'jpg';
    const tempPath = resolve(`public/images/blog/${data.id}.source.${sourceExt}`);
    writeFileSync(tempPath, rawBuffer);
    const rawKB = (rawBuffer.length / 1024).toFixed(0);
    const result = await optimizeImageToJpeg(tempPath, imgPath);
    if (existsSync(tempPath)) unlinkSync(tempPath);

    if (result.ok) {
      const finalKb = (result.after / 1024).toFixed(0);
      const beforeKb = (result.before / 1024).toFixed(0);
      const overTarget = result.after > BLOG_IMAGE_HARD_MAX_BYTES ? ' ⚠️ sopra hard cap' : '';
      console.error(`  ✅ Immagine generata e ottimizzata: public/images/blog/${data.id}.jpg (${beforeKb} KB → ${finalKb} KB, ${providerLabel})${overTarget}`);
    } else {
      if (rawBuffer.length > BLOG_IMAGE_HARD_MAX_BYTES) {
        console.error(`  ⚠️ Immagine raw troppo pesante (${rawKB} KB) e optimizer non disponibile. Provo provider successivo...`);
        return null;
      }
      writeFileSync(imgPath, rawBuffer);
      console.error(`  ✅ Immagine generata (raw fallback): public/images/blog/${data.id}.jpg (${rawKB} KB, ${providerLabel})`);
    }

    // ── Post-save width enforcement ──
    // Google News, Discover, and Open Graph require ≥1200px wide images.
    // If the optimizer (sharp or system binaries) wasn't available, or if the
    // AI provider returned an undersized image, the saved file may be < 1200px.
    // Force-upscale to 1200px wide to guarantee visibility on all Google surfaces.
    try {
      const sharpMod = await import('sharp');
      const shp = sharpMod.default || sharpMod;
      const meta = await shp(imgPath).metadata();
      if (meta.width && (meta.width < 1200 || meta.height < 675)) {
        const buf = await shp(imgPath)
          .resize({ width: 1200, height: 675, fit: 'cover', position: 'attention' })
          .jpeg({ quality: 82, progressive: true, mozjpeg: true, chromaSubsampling: '4:2:0' })
          .toBuffer();
        writeFileSync(imgPath, buf);
        console.error(`  📐 Resized ${meta.width}×${meta.height} → 1200×675 (Google Discover minimum)`);
      }
    } catch {
      // sharp not available — image stays as-is (acceptable in rare CI edge cases)
    }

    return `/images/blog/${data.id}.jpg`;
  }

  // ── Strategy 1: Gemini native image generation (free tier) ──
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    const modelsToTry = [IMAGE_MODEL_FLASH, IMAGE_MODEL_PRO];
    let geminiQuotaExhausted = false;
    for (const model of modelsToTry) {
      if (geminiQuotaExhausted) break;
      try {
        const isPro = model === IMAGE_MODEL_PRO;
        console.error(`🎨 Generazione immagine con ${isPro ? 'Gemini 3 Pro Image' : 'Gemini 2.5 Flash Image'}...`);

        const endpoint = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;
        // Note: imageSize:'1K' removed — it causes Gemini to output 1024x1024 squares.
        // aspectRatio:'16:9' alone produces proper landscape output.
        const generationConfig = isPro
          ? { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9' } }
          : { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9' } };

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig,
          }),
          signal: AbortSignal.timeout(120000),
        });

        if (!res.ok) {
          // 429 = quota exceeded — account-wide, skip all remaining Gemini models
          if (res.status === 429) {
            geminiQuotaExhausted = true;
            throw new Error('quota Gemini esaurita (429)');
          }
          const errText = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status}: ${errText.slice(0, 120)}`);
        }

        const json = await res.json();
        const parts = json.candidates?.[0]?.content?.parts || [];
        const imagePart = parts.find(p => p.inlineData?.data && !p.thought);
        if (!imagePart) throw new Error('Nessuna immagine nella risposta Gemini');

        const base64 = imagePart.inlineData.data;
        const mimeType = imagePart.inlineData.mimeType || 'image/jpeg';
        const rawBuffer = Buffer.from(base64, 'base64');
        const saved = await _saveAndOptimize(rawBuffer, `Gemini/${model}`, mimeType);
        if (saved) return saved;
      } catch (e) {
        console.error(`  ⚠️  Gemini fallito: ${e.message}`);
      }
    }
  }

  // ── Strategy 2: Pollinations.ai (free, no API key) ──
  // https://gen.pollinations.ai — free AI image generation, no auth needed
  // Migrated from image.pollinations.ai/prompt/ → gen.pollinations.ai/image/ (2025)
  // Only try 2 models with 1 retry; if origin is down (530/502/503) skip all.
  const pollinationsModels = ['flux', 'flux-realism'];
  let pollinationsOriginDown = false;
  for (const pModel of pollinationsModels) {
    if (pollinationsOriginDown) break;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) {
          console.error(`  🔄 Retry Pollinations/${pModel} dopo 10s...`);
          await new Promise(r => setTimeout(r, 10000));
        }
        console.error(`🎨 Generazione immagine con Pollinations.ai (${pModel})...`);
        const encodedPrompt = encodeURIComponent(
          prompt.replace(/\n/g, ' ').slice(0, 800)
        );
        const pollinationsUrl = `https://gen.pollinations.ai/image/${encodedPrompt}?width=1280&height=720&model=${pModel}&nologo=true&seed=${Date.now()}`;

        const res = await fetch(pollinationsUrl, {
          signal: AbortSignal.timeout(120000),
          redirect: 'follow',
        });

        if (!res.ok) {
          if ((res.status === 530 || res.status === 502 || res.status === 503) && attempt < 1) {
            throw new Error(`HTTP ${res.status} (retry)`);
          }
          // Origin-level errors mean all models are down
          if (res.status === 530 || res.status === 502 || res.status === 503) {
            pollinationsOriginDown = true;
          }
          throw new Error(`HTTP ${res.status}`);
        }

        const contentType = res.headers.get('content-type') || '';
        if (!contentType.startsWith('image/')) {
          throw new Error(`Risposta non è un'immagine: ${contentType}`);
        }

        const arrayBuf = await res.arrayBuffer();
        const rawBuffer = Buffer.from(arrayBuf);
        const saved = await _saveAndOptimize(rawBuffer, `Pollinations/${pModel}`, contentType);
        if (saved) return saved;
        break;
      } catch (e) {
        console.error(`  ⚠️  Pollinations/${pModel} fallito: ${e.message}`);
        if (e.message.includes('(retry)')) continue;
        break;
      }
    }
  }
  if (pollinationsOriginDown) console.error('  ⚠️  Pollinations.ai non raggiungibile — origin down');

  // ── Strategy 2b: Together.ai (FLUX.1-schnell-Free, free tier with key) ──
  // https://www.together.ai — free model, needs TOGETHER_API_KEY secret in GH
  const togetherKey = process.env.TOGETHER_API_KEY;
  if (togetherKey) {
    try {
      console.error('🎨 Generazione immagine con Together.ai (FLUX.1-schnell-Free)...');
      const togetherRes = await fetch('https://api.together.xyz/v1/images/generations', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${togetherKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'black-forest-labs/FLUX.1-schnell-Free',
          prompt: prompt.replace(/\n/g, ' ').slice(0, 800),
          width: 1280,
          height: 720,
          steps: 4,
          n: 1,
          response_format: 'b64_json',
        }),
        signal: AbortSignal.timeout(90000),
      });
      if (!togetherRes.ok) {
        const errText = await togetherRes.text().catch(() => '');
        throw new Error(`HTTP ${togetherRes.status}: ${errText.slice(0, 200)}`);
      }
      const togetherJson = await togetherRes.json();
      const b64 = togetherJson.data?.[0]?.b64_json;
      if (!b64) throw new Error('Nessuna immagine nella risposta Together.ai');
      const rawBuffer = Buffer.from(b64, 'base64');
      const saved = await _saveAndOptimize(rawBuffer, 'Together.ai/FLUX-schnell', 'image/jpeg');
      if (saved) return saved;
    } catch (e) {
      console.error(`  ⚠️  Together.ai fallito: ${e.message}`);
    }
  }

  // ── Strategy 2c: Fal.ai (FLUX schnell, needs FAL_KEY secret in GH) ──
  // https://fal.ai — pay-per-use with free credits, very fast FLUX inference
  const falKey = process.env.FAL_KEY;
  if (falKey) {
    try {
      console.error('🎨 Generazione immagine con Fal.ai (FLUX schnell)...');
      const falRes = await fetch('https://fal.run/fal-ai/flux/schnell', {
        method: 'POST',
        headers: {
          Authorization: `Key ${falKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: prompt.replace(/\n/g, ' ').slice(0, 800),
          image_size: 'landscape_16_9',
          num_inference_steps: 4,
          num_images: 1,
        }),
        signal: AbortSignal.timeout(90000),
      });
      if (!falRes.ok) {
        const errText = await falRes.text().catch(() => '');
        throw new Error(`HTTP ${falRes.status}: ${errText.slice(0, 200)}`);
      }
      const falJson = await falRes.json();
      const falImgUrl = falJson.images?.[0]?.url;
      if (!falImgUrl) throw new Error('Nessuna immagine nella risposta Fal.ai');
      const falImgRes = await fetch(falImgUrl, { signal: AbortSignal.timeout(30000) });
      if (!falImgRes.ok) throw new Error(`Download HTTP ${falImgRes.status}`);
      const falBuf = Buffer.from(await falImgRes.arrayBuffer());
      const falContentType = falImgRes.headers.get('content-type') || 'image/jpeg';
      const saved = await _saveAndOptimize(falBuf, 'Fal.ai/FLUX-schnell', falContentType);
      if (saved) return saved;
    } catch (e) {
      console.error(`  ⚠️  Fal.ai fallito: ${e.message}`);
    }
  }

  // ── Strategy 3: HuggingFace Inference API (free, FLUX-schnell) ──
  // https://huggingface.co/docs/api-inference — free tier with HF_TOKEN
  // FLUX-1-schnell is one of the fastest open-source text-to-image models
  // NOTE: HF migrated from api-inference.huggingface.co → router.huggingface.co (2025)
  const hfToken = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN;
  if (hfToken) {
    const hfModels = [
      'black-forest-labs/FLUX.1-schnell',
      'stabilityai/stable-diffusion-xl-base-1.0',
    ];
    for (const hfModel of hfModels) {
      try {
        const shortName = hfModel.split('/').pop();
        console.error(`🎨 Generazione immagine con HuggingFace/${shortName}...`);
        const hfRes = await fetch(`https://router.huggingface.co/hf-inference/v2/models/${hfModel}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${hfToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            inputs: prompt.replace(/\n/g, ' ').slice(0, 800),
            parameters: { width: 1280, height: 720 },
          }),
          signal: AbortSignal.timeout(120000),
        });

        if (!hfRes.ok) {
          const errText = await hfRes.text().catch(() => '');
          throw new Error(`HTTP ${hfRes.status}: ${errText.slice(0, 200)}`);
        }

        const contentType = hfRes.headers.get('content-type') || '';
        if (!contentType.startsWith('image/')) {
          throw new Error(`Risposta non è un'immagine: ${contentType}`);
        }

        const rawBuffer = Buffer.from(await hfRes.arrayBuffer());
        const saved = await _saveAndOptimize(rawBuffer, `HuggingFace/${shortName}`, contentType);
        if (saved) return saved;
      } catch (e) {
        console.error(`  ⚠️  HuggingFace/${hfModel.split('/').pop()} fallito: ${e.message}`);
      }
    }
  }

  // ── Strategy 4: Wikimedia Commons (free, no API key, keyword search) ──
  // Searches Creative Commons licensed photos from Wikimedia. Very reliable.
  // Uses article-specific topic keywords + image URL dedup to avoid repeats.
  {
    const searchQueries = _buildWikimediaQueries(data);
    const usedUrls = _loadUsedImageUrls();

    for (const query of searchQueries) {
      try {
        console.error(`🖼️ Ricerca immagine da Wikimedia Commons ("${query}")...`);
        const wikiUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search` +
          `&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=12` +
          `&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=1280&format=json`;
        const res = await fetch(wikiUrl, {
          signal: AbortSignal.timeout(15000),
          headers: { 'User-Agent': 'FrontaliereBot/1.0 (https://frontaliereticino.ch; blog image)' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const pages = json.query?.pages || {};
        // Filter to JPEG/PNG images with a thumbnail URL, exclude already-used URLs
        const candidates = Object.values(pages)
          .filter(p => {
            const info = p.imageinfo?.[0];
            if (!info?.thumburl) return false;
            const mime = (info.mime || '').toLowerCase();
            if (!mime.startsWith('image/jpeg') && !mime.startsWith('image/png')) return false;
            // Dedup: skip images already used by other articles
            if (usedUrls.has(info.thumburl) || usedUrls.has(info.url)) return false;
            return true;
          })
          .sort((a, b) => {
            // Prefer landscape orientation and reasonable sizes
            const aInfo = a.imageinfo[0];
            const bInfo = b.imageinfo[0];
            const aRatio = (aInfo.width || 1) / (aInfo.height || 1);
            const bRatio = (bInfo.width || 1) / (bInfo.height || 1);
            // Score: prefer ratio > 1.3 (landscape) and larger images
            const aScore = (aRatio > 1.3 ? 10 : 0) + Math.min(aInfo.width || 0, 2000) / 200;
            const bScore = (bRatio > 1.3 ? 10 : 0) + Math.min(bInfo.width || 0, 2000) / 200;
            return bScore - aScore;
          });

        if (candidates.length === 0) {
          console.error(`  ⚠️  Wikimedia "${query}": nessun risultato (o tutti già usati)`);
          continue;
        }

        // Pick from top 5 candidates for variety (was top 3)
        const pick = candidates[Math.floor(Math.random() * Math.min(5, candidates.length))];
        const imgUrl = pick.imageinfo[0].thumburl;
        console.error(`  📥 Download: ${imgUrl.slice(0, 80)}...`);

        const imgRes = await fetch(imgUrl, {
          signal: AbortSignal.timeout(20000),
          headers: { 'User-Agent': 'FrontaliereBot/1.0' },
        });
        if (!imgRes.ok) throw new Error(`Download HTTP ${imgRes.status}`);
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const saved = await _saveAndOptimize(buf, `Wikimedia/${query}`, imgRes.headers.get('content-type'));
        if (saved) {
          _saveUsedImageUrl(data.id, imgUrl);
          return saved;
        }
      } catch (e) {
        console.error(`  ⚠️  Wikimedia "${query}" fallito: ${e.message}`);
      }
    }
  }

  // ── Strategy 5: Pixabay API (free, 100 req/min, needs key) ──
  // Uses article-specific keyword search for relevant stock photos.
  const pixabayKey = process.env.PIXABAY_API_KEY;
  if (pixabayKey) {
    // Build Pixabay queries from article topic (same extraction as Wikimedia)
    const articleTitle = (data.title || data.content?.it?.title || data.content?.title || '').toLowerCase();
    const pixabayQueries = _buildWikimediaQueries(data).slice(0, 2).map(q => q.replace(/\bcommons\b/gi, '').trim());
    if (pixabayQueries.length === 0) pixabayQueries.push('ticino switzerland');
    pixabayQueries.push('swiss landscape lake');

    for (const pxQuery of pixabayQueries) {
      try {
        console.error(`🖼️ Ricerca immagine stock da Pixabay ("${pxQuery}")...`);
        const q = encodeURIComponent(pxQuery);
        const res = await fetch(
          `https://pixabay.com/api/?key=${pixabayKey}&q=${q}&image_type=photo&orientation=horizontal&per_page=8&min_width=1280&safesearch=true`,
          { signal: AbortSignal.timeout(15000) },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const hits = json.hits || [];
        if (hits.length === 0) {
          console.error(`  ⚠️  Pixabay "${pxQuery}": nessun risultato`);
          continue;
        }
        // Pick from top results for variety
        const pick = hits[Math.floor(Math.random() * Math.min(5, hits.length))];
        const imgUrl = pick.largeImageURL || pick.webformatURL;
        if (imgUrl) {
          const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(20000) });
          if (imgRes.ok) {
            const buf = Buffer.from(await imgRes.arrayBuffer());
            const saved = await _saveAndOptimize(buf, `Pixabay/${pxQuery}`, imgRes.headers.get('content-type'));
            if (saved) return saved;
          }
        }
      } catch (e) {
        console.error(`  ⚠️  Pixabay "${pxQuery}" fallito: ${e.message}`);
      }
    }
  }

  // ── Strategy 5b: Pexels API (stock foto CC0, needs PEXELS_API_KEY secret in GH) ──
  // https://www.pexels.com/api/ — free tier 200 req/hour, landscape orientation, high quality
  const pexelsKey = process.env.PEXELS_API_KEY;
  if (pexelsKey) {
    const pexelsQueries = _buildWikimediaQueries(data).slice(0, 2).map(q => q.replace(/\bcommons\b/gi, '').trim());
    if (pexelsQueries.length === 0) pexelsQueries.push('ticino switzerland');
    pexelsQueries.push('swiss landscape lake');

    for (const pxQuery of pexelsQueries) {
      try {
        console.error(`🖼️ Ricerca immagine stock da Pexels ("${pxQuery}")...`);
        const q = encodeURIComponent(pxQuery);
        const res = await fetch(
          `https://api.pexels.com/v1/search?query=${q}&orientation=landscape&size=large&per_page=8`,
          {
            headers: { Authorization: pexelsKey },
            signal: AbortSignal.timeout(15000),
          },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const photos = json.photos || [];
        if (photos.length === 0) {
          console.error(`  ⚠️  Pexels "${pxQuery}": nessun risultato`);
          continue;
        }
        const pick = photos[Math.floor(Math.random() * Math.min(5, photos.length))];
        const imgUrl = pick.src?.large2x || pick.src?.large || pick.src?.original;
        if (imgUrl) {
          const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(20000) });
          if (imgRes.ok) {
            const buf = Buffer.from(await imgRes.arrayBuffer());
            const saved = await _saveAndOptimize(buf, `Pexels/${pxQuery}`, imgRes.headers.get('content-type'));
            if (saved) return saved;
          }
        }
      } catch (e) {
        console.error(`  ⚠️  Pexels "${pxQuery}" fallito: ${e.message}`);
      }
    }
  }

  // ── Strategy 6: Lorem Picsum (always works, random professional photo) ──
  // https://picsum.photos — Reliable service serving random stock photos.
  // Not topic-relevant, but always returns a valid image — last resort before fallback.
  try {
    console.error('🖼️ Immagine stock da Lorem Picsum (random)...');
    // Use article ID hash as seed for deterministic-per-article randomness
    const seed = (data.id || 'default').split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
    const absSeed = Math.abs(seed) % 10000;
    const res = await fetch(`https://picsum.photos/seed/${absSeed}/1280/720`, {
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
    });
    if (res.ok) {
      const contentType = res.headers.get('content-type') || '';
      if (contentType.startsWith('image/')) {
        const buf = Buffer.from(await res.arrayBuffer());
        const saved = await _saveAndOptimize(buf, 'Picsum', contentType);
        if (saved) return saved;
      }
    }
  } catch (e) {
    console.error(`  ⚠️  Lorem Picsum fallito: ${e.message}`);
  }

  console.error('  ❌ Tutti i provider di image generation hanno fallito.');
  console.error('     Uso immagine di fallback dal catalogo Ticino.');
  return null; // fallback to AVAILABLE_IMAGES in modifyBlogArticlesTsx
}

// ── Step 4: Modify source files ─────────────────────────────

/**
 * Sanitize AI-generated body text before it's serialized into TypeScript.
 *
 * The LLM occasionally produces stray `}` characters — typically at the end of
 * a sentence where a German low quote („ ") was mis-closed with `}`. Blog
 * body content is plain markdown and should never contain unbalanced braces;
 * when they slip through they (a) break string-unaware parsers like the old
 * i18n-completeness test and (b) look broken in the rendered article.
 *
 * This is defense in depth: the test parser is now string-aware, but we still
 * refuse to write corrupted output to source files. Strategy:
 *   - Walk the text, tracking `{` depth
 *   - Drop any `}` that appears while depth is already 0
 *   - Leave balanced `{...}` pairs intact (in case of anchors, placeholders)
 */
function sanitizeBodyText(s) {
  if (typeof s !== 'string' || s.length === 0) return s;
  const out = [];
  let depth = 0;
  let droppedCount = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') {
      depth++;
      out.push(ch);
    } else if (ch === '}') {
      if (depth === 0) {
        droppedCount++;
        continue; // stray — skip
      }
      depth--;
      out.push(ch);
    } else {
      out.push(ch);
    }
  }
  // If braces are still unbalanced (more `{` than `}`), strip the trailing
  // unmatched opens as well — they'd otherwise leave an open brace in the
  // serialized TS string that could hide downstream issues.
  if (depth > 0) {
    let i = out.length - 1;
    let toStrip = depth;
    while (i >= 0 && toStrip > 0) {
      if (out[i] === '{') {
        out[i] = '';
        toStrip--;
      }
      i--;
    }
    droppedCount += depth;
  }
  if (droppedCount > 0) {
    console.error(`    ⚠️  sanitizeBodyText: removed ${droppedCount} stray brace char(s)`);
  }
  return out.join('');
}

function escapeForSingleQuoteTS(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '');
}

/**
 * Validate that a generated .ts body file is syntactically valid.
 * Catches truncated FAQ strings and other escaping errors before they break the build.
 */
function validateBodyFileSyntax(filePath, content) {
  // Quick structural check: every opened single-quote string must close properly
  // Count unbalanced quotes (rough heuristic)
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Detect the specific truncation pattern: '}]', followed by raw text
    if (/\}]',\s*[a-zA-Z]/.test(line)) {
      throw new Error(`Body file ${filePath} line ${i + 1}: FAQ string appears truncated — raw text found after closing ']'. The AI likely produced malformed FAQ JSON.`);
    }
  }
  // Try to evaluate the TS as JS to catch syntax errors
  try {
    // Strip the export and type annotation to make it evaluable as JS
    const jsContent = content
      .replace(/:\s*Record<string,\s*string>\s*=/, ' =')
      .replace(/^export default .*/m, '');
    new Function(jsContent);
  } catch (e) {
    throw new Error(`Body file ${filePath} has syntax error: ${e.message}`);
  }
}

function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Find the last article ID from routerBlogData.ts */
function getLastArticleId(src) {
  const match = src.match(/ALL_BLOG_ARTICLE_IDS.*?\[([^\]]+)\]/s);
  if (!match) throw new Error('Cannot find ALL_BLOG_ARTICLE_IDS in routerBlogData.ts');
  const ids = match[1].match(/'([^']+)'/g)?.map(s => s.slice(1, -1)) || [];
  const lastId = ids[ids.length - 1];
  if (!lastId) throw new Error('No existing articles found in routerBlogData.ts');
  return lastId;
}

function modifyRouterTs(data) {
  // Step 1: BlogArticleId type union in router.ts
  const routerFile = 'services/router.ts';
  let routerSrc = read(routerFile);
  const lastId = getLastArticleId(read('services/routerBlogData.ts'));

  function checkedReplace(source, regex, replacement, stepName) {
    const result = source.replace(regex, replacement);
    if (result === source) {
      throw new Error(`modifyRouterTs step "${stepName}" failed: regex did not match.\n  Pattern: ${regex}\n  lastId=${lastId}, newId=${data.id}`);
    }
    return result;
  }

  // 1. BlogArticleId type union — append before the semicolon
  routerSrc = checkedReplace(routerSrc,
    new RegExp(`(\\| '${escapeRegex(lastId)}')(;)`),
    `$1 | '${data.id}'$2`,
    'BlogArticleId type union'
  );
  write(routerFile, routerSrc);
  console.error(`  ✅ ${routerFile}`);

  // Steps 2-3: ALL_BLOG_ARTICLE_IDS and BLOG_SLUGS in routerBlogData.ts
  const blogDataFile = 'services/routerBlogData.ts';
  let blogSrc = read(blogDataFile);

  // 2. ALL_BLOG_ARTICLE_IDS array — append before ]
  blogSrc = checkedReplace(blogSrc,
    new RegExp(`('${escapeRegex(lastId)}'\\])`),
    `'${lastId}', '${data.id}']`,
    'ALL_BLOG_ARTICLE_IDS array'
  );

  // 3. BLOG_SLUGS map — add new entry after last article entry
  const newSlugEntry = `  '${data.id}': { it: '${data.slugs.it}', en: '${data.slugs.en}', de: '${data.slugs.de}', fr: '${data.slugs.fr}' },`;
  blogSrc = checkedReplace(blogSrc,
    new RegExp(`('${escapeRegex(lastId)}':\\s*\\{[^}]+\\},)`),
    `$1\n${newSlugEntry}`,
    'BLOG_SLUGS map'
  );

  write(blogDataFile, blogSrc);
  console.error(`  ✅ ${blogDataFile}`);
}

function modifyBlogArticlesTsx(data) {
  // FRO-360: ARTICLES array extracted to data/blog-articles-data.ts (FRO-328)
  const file = 'data/blog-articles-data.ts';
  let src = read(file);
  const today = new Date().toISOString();

  // Use generated image if available, otherwise fallback to catalog image
  const imagePath = data._generatedImagePath || `/images/places/${data.image}`;

  const newEntry = `  {
    id: '${data.id}',
    category: '${data.category}',
    date: '${today}',
    image: '${imagePath}',
    hasCalculator: ${data.hasCalculator ? 'true' : 'false'},
  },`;

  // Insert before the closing ];
  const before = src;
  src = src.replace(
    /(    hasCalculator: (?:true|false),\n  },\n)(];)/,
    `$1${newEntry}\n$2`
  );
  if (src === before) {
    throw new Error(`modifyBlogArticlesTsx: regex did not match — cannot insert article entry in ${file}`);
  }

  write(file, src);
  console.error(`  ✅ ${file}`);
}

/** Build i18n block with only META keys (title, excerpt, imageAlt) */
function buildMetaBlock(data, locale) {
  const c = data.content[locale];
  const id = data.id;
  const lines = [
    `    'blog.article.${id}.title': '${escapeForSingleQuoteTS(c.title)}',`,
    `    'blog.article.${id}.excerpt': '${escapeForSingleQuoteTS(c.excerpt)}',`,
  ];
  const alt = data.imageAlt?.[locale];
  if (alt) {
    lines.push(`    'blog.article.${id}.imageAlt': '${escapeForSingleQuoteTS(alt)}',`);
  }
  return lines.join('\n');
}

/** Build a standalone per-article body file (body1, body2, body3) */
function buildBodyFile(data, locale) {
  const c = data.content[locale];
  const id = data.id;
  const camel = id.replace(/-(\w)/g, (_, ch) => ch.toUpperCase());
  const varName = 'body' + camel.charAt(0).toUpperCase() + camel.slice(1);

  // Build FAQ line if present — validate JSON roundtrip to catch malformed AI output
  let faqLine = '';
  if (c.faq && Array.isArray(c.faq) && c.faq.length > 0) {
    try {
      const faqJson = JSON.stringify(c.faq);
      // Roundtrip: verify the escaped string produces valid JSON when parsed back
      const escaped = escapeForSingleQuoteTS(faqJson);
      const unescaped = escaped.replace(/\\'/g, "'").replace(/\\\\/g, '\\').replace(/\\n/g, '\n');
      JSON.parse(unescaped);
      faqLine = `\n    'blog.article.${id}.faq': '${escaped}',`;
    } catch (e) {
      console.error(`  ⚠️ FAQ for ${locale}/${id} dropped — malformed JSON: ${e.message}`);
    }
  }

  return `const ${varName}: Record<string, string> = {
    'blog.article.${id}.body1': '${escapeForSingleQuoteTS(c.body1)}',
    'blog.article.${id}.body2': '${escapeForSingleQuoteTS(c.body2)}',
    'blog.article.${id}.body3': '${escapeForSingleQuoteTS(c.body3)}',${faqLine}
};

export default ${varName};
`;
}

function modifyI18nTs(data) {
  // 1. Append meta keys to blog-meta-it.ts
  const metaFile = 'services/locales/blog-meta-it.ts';
  let metaSrc = read(metaFile);
  const metaBlock = buildMetaBlock(data, 'it');
  const re = /('blog\.article\.[a-z0-9-]+\.[a-zA-Z]+':.*?,)\n+(\};)/;
  if (!re.test(metaSrc)) {
    throw new Error(`Cannot find blog article anchor in ${metaFile}`);
  }
  metaSrc = metaSrc.replace(re, `$1\n${metaBlock}\n$2`);
  write(metaFile, metaSrc);
  console.error(`  ✅ ${metaFile}`);

  // 2. Create per-article body file
  const bodyDir = 'services/locales/blog-body/it';
  mkdirSync(resolve(bodyDir), { recursive: true });
  const bodyFile = `${bodyDir}/${data.id}.ts`;
  const bodyContent = buildBodyFile(data, 'it');
  validateBodyFileSyntax(bodyFile, bodyContent);
  write(bodyFile, bodyContent);
  console.error(`  ✅ ${bodyFile}`);
}

function modifyLocaleFile(data, locale) {
  // 1. Append meta keys to blog-meta-{locale}.ts
  const metaFile = `services/locales/blog-meta-${locale}.ts`;
  let metaSrc = read(metaFile);
  const metaBlock = buildMetaBlock(data, locale);
  const re = /('blog\.article\.[a-z0-9-]+\.[a-zA-Z]+':.*?,)\n+(\};)/;
  if (!re.test(metaSrc)) {
    throw new Error(`Cannot find blog article anchor in ${metaFile}`);
  }
  metaSrc = metaSrc.replace(re, `$1\n${metaBlock}\n$2`);
  write(metaFile, metaSrc);
  console.error(`  ✅ ${metaFile}`);

  // 2. Create per-article body file
  const bodyDir = `services/locales/blog-body/${locale}`;
  mkdirSync(resolve(bodyDir), { recursive: true });
  const bodyFile = `${bodyDir}/${data.id}.ts`;
  const bodyContent = buildBodyFile(data, locale);
  validateBodyFileSyntax(bodyFile, bodyContent);
  write(bodyFile, bodyContent);
  console.error(`  ✅ ${bodyFile}`);
}

function toIsoWithTz(date = new Date()) {
  // Esempio output: 2026-02-26T09:51:00+01:00 (con offset locale)
  const pad = (n) => String(n).padStart(2, '0')
  const y = date.getFullYear()
  const m = pad(date.getMonth() + 1)
  const d = pad(date.getDate())
  const hh = pad(date.getHours())
  const mm = pad(date.getMinutes())
  const ss = pad(date.getSeconds())

  const offMin = -date.getTimezoneOffset() // minuti rispetto a UTC
  const sign = offMin >= 0 ? '+' : '-'
  const abs = Math.abs(offMin)
  const offH = pad(Math.floor(abs / 60))
  const offM = pad(abs % 60)

  return `${y}-${m}-${d}T${hh}:${mm}:${ss}${sign}${offH}:${offM}`
}


function modifySeoService(data) {
  const publishedAt = toIsoWithTz(new Date())
  const modifiedAt = publishedAt

  // Use generated image or fallback
  const imagePath = data._generatedImagePath
    ? data._generatedImagePath.replace(/^\//, '')
    : `images/places/${data.image}`;

  // 1. SEO entry → services/seo/seo-blog.ts (lazy-loaded chunk)
  const blogSeoFile = 'services/seo/seo-blog.ts';
  let blogSrc = read(blogSeoFile);

  const seoEntry = `
  'blog-${data.id}': {
    title: '${escapeForSingleQuoteTS(data.seo.title)}',
    description: '${escapeForSingleQuoteTS(data.seo.description)}',
    keywords: '${escapeForSingleQuoteTS(data.seo.keywords)}',
    ogTitle: '${escapeForSingleQuoteTS(data.seo.ogTitle)}',
    ogDescription: '${escapeForSingleQuoteTS(data.seo.ogDescription)}',
    canonicalPath: '/articoli-frontaliere/${data.slugs.it}',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "${String(data.seo.headline || '').replace(/"/g, '\\"')}",
      "description": "${String(data.seo.description || '').replace(/"/g, '\\"')}",
      "image": {
        "@type": "ImageObject",
        "url": \`\${BASE_URL}/${imagePath}\`,
        "width": ${data._generatedImagePath ? 1200 : 1200},
        "height": ${data._generatedImagePath ? 675 : 563},
        "caption": "${String(data.imageAlt?.it || data.seo.headline || '').replace(/"/g, '\\"')}"
      },
      "datePublished": "${publishedAt}",
      "dateModified": "${modifiedAt}",
      "inLanguage": "it",
      "author": {"@id": "${BASE_URL}/#organization"},
      "publisher": {"@id": "${BASE_URL}/#organization"},
      "mainEntityOfPage": \`\${BASE_URL}/articoli-frontaliere/${data.slugs.it}\`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },`;

  // Insert before the closing }; ... export default BLOG_SEO_METADATA;
  const blogEndRe = /(  \},)\s*(\n};)\s*(\nexport default BLOG_SEO_METADATA;)/;
  if (!blogEndRe.test(blogSrc)) {
    throw new Error(`Cannot find end of BLOG_SEO_METADATA in ${blogSeoFile}`);
  }
  blogSrc = blogSrc.replace(blogEndRe, `$1\n${seoEntry}\n$2\n$3`);
  write(blogSeoFile, blogSrc);
  console.error(`  ✅ ${blogSeoFile}`);

  // 2. Breadcrumb entry → services/seoService.ts
  const svcFile = 'services/seoService.ts';
  let svcSrc = read(svcFile);

  const breadcrumb = `    'blog-${data.id}': { name: '${escapeForSingleQuoteTS(data.seo.breadcrumbName)}', path: '/articoli-frontaliere/${data.slugs.it}', parent: 'blog' },`;
  const bcRe = /('blog-[a-z0-9-]+':.*?parent: 'blog' \},)\s*\n(\s*\};)/;
  if (!bcRe.test(svcSrc)) {
    throw new Error(`Cannot find last breadcrumb blog entry in ${svcFile}`);
  }
  svcSrc = svcSrc.replace(bcRe, `$1\n${breadcrumb}\n$2`);
  write(svcFile, svcSrc);
  console.error(`  ✅ ${svcFile}`);

  // 3. ItemList in services/seo/seo-pages.ts — increment numberOfItems + append ListItem
  const pagesFile = 'services/seo/seo-pages.ts';
  let pagesSrc = read(pagesFile);

  const itemCountRe = /("name": "Articoli Frontaliere",\s*"numberOfItems": )(\d+)/;
  const itemCountMatch = pagesSrc.match(itemCountRe);
  if (itemCountMatch) {
    const oldCount = parseInt(itemCountMatch[2], 10);
    const newCount = oldCount + 1;
    pagesSrc = pagesSrc.replace(itemCountRe, `$1${newCount}`);

    const headlineStr = String(data.seo.headline || '');
    const shortTitle = headlineStr.length > 50
      ? headlineStr.slice(0, 47) + '...'
      : headlineStr;
    const newListItem = `          { "@type": "ListItem", "position": ${newCount}, "name": "${shortTitle.replace(/"/g, '\\"')}", "url": \`\${BASE_URL}/articoli-frontaliere/${data.slugs.it}\` }`;

    const lastItemRe = /("url": `\$\{BASE_URL\}\/articoli-frontaliere\/[^`]+` \})\s*\n(\s*\])/;
    if (lastItemRe.test(pagesSrc)) {
      pagesSrc = pagesSrc.replace(lastItemRe, `$1,\n${newListItem}\n$2`);
    } else {
      console.error('  ⚠️ Could not find last ItemList entry to append new article');
    }
    write(pagesFile, pagesSrc);
    console.error(`  ✅ ${pagesFile}`);
  } else {
    console.error('  ⚠️ Could not find blog ItemList numberOfItems in seo-pages.ts');
  }
}

/**
 * Post-write validation: re-reads seo-blog.ts, extracts the new article's
 * SEO entry using the SAME regex ogPagesPlugin uses at build time, then builds and
 * parses the JSON-LD object. This catches escaping issues before they reach production.
 */
function validateStructuredData(data) {
  const src = read('services/seo/seo-blog.ts');
  const entryKey = `'blog-${data.id}'`;

  // 1. Verify the entry exists
  if (!src.includes(entryKey)) {
    throw new Error(`[validate-ld] SEO entry ${entryKey} not found in seo-blog.ts`);
  }

  // 2. Extract using the same regex ogPagesPlugin uses
  const keyRx = new RegExp(`'blog-${data.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}':\\s*\\{`);
  const km = src.match(keyRx);
  if (!km) throw new Error(`[validate-ld] Could not match entry ${entryKey}`);
  const start = km.index;
  const block = src.substring(start, Math.min(start + 3000, src.length));

  // Match single-quoted strings (same logic as ogPagesPlugin matchStr)
  const matchStr = (key) => {
    const rx = new RegExp(`${key}:\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'm');
    return block.match(rx)?.[1]?.replace(/\\(.)/g, (_, c) => c === 'n' ? ' ' : c === 'r' ? '' : c === 't' ? ' ' : c) ?? '';
  };
  const title = matchStr('title');
  const desc = matchStr('description');
  const ogT = matchStr('ogTitle') || title;
  const ogD = matchStr('ogDescription') || desc;
  const cp = block.match(/canonicalPath:\s*'([^']+)'/)?.[1] ?? '';
  const datePub = block.match(/"datePublished":\s*"([^"]+)"/)?.[1] ?? '';
  const dateMod = block.match(/"dateModified":\s*"([^"]+)"/)?.[1] ?? '';

  // 3. Verify we got meaningful values
  if (!title) throw new Error(`[validate-ld] Empty title for ${entryKey}`);
  if (!desc) throw new Error(`[validate-ld] Empty description for ${entryKey}`);
  if (!ogT) throw new Error(`[validate-ld] Empty ogTitle for ${entryKey}`);
  if (!ogD) throw new Error(`[validate-ld] Empty ogDescription for ${entryKey}`);
  if (!cp) throw new Error(`[validate-ld] Empty canonicalPath for ${entryKey}`);

  // 4. Build the same JSON-LD object ogPagesPlugin builds and verify JSON.stringify works
  const BASE = 'https://frontaliereticino.ch';
  const ldObj = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: ogT,
    description: ogD,
    image: `${BASE}${data._generatedImagePath || `/images/places/${data.image}`}`,
    url: `${BASE}${cp}`,
    publisher: {
      '@type': 'Organization', name: 'Frontaliere Ticino', url: BASE,
      logo: { '@type': 'ImageObject', url: `${BASE}/icons/icon-512x512.png` }
    },
    author: { '@type': 'Organization', name: 'Frontaliere Ticino', url: BASE },
    mainEntityOfPage: `${BASE}${cp}`,
  };
  if (datePub) ldObj.datePublished = datePub;
  if (dateMod) ldObj.dateModified = dateMod;

  // 4b. Verify date format: must be ISO 8601 with timezone (e.g. 2026-02-26T09:51:00+01:00)
  const ISO_WITH_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
  if (datePub && !ISO_WITH_TZ.test(datePub)) {
    throw new Error(`[validate-ld] datePublished "${datePub}" non è in formato ISO 8601 con fuso orario (atteso: YYYY-MM-DDTHH:MM:SS+HH:MM)`);
  }
  if (dateMod && !ISO_WITH_TZ.test(dateMod)) {
    throw new Error(`[validate-ld] dateModified "${dateMod}" non è in formato ISO 8601 con fuso orario (atteso: YYYY-MM-DDTHH:MM:SS+HH:MM)`);
  }

  const jsonStr = JSON.stringify(ldObj);

  // 5. Verify the JSON is parseable (roundtrip)
  try {
    const parsed = JSON.parse(jsonStr);
    if (!parsed.headline || !parsed.description) {
      throw new Error('Missing headline or description after roundtrip');
    }
  } catch (e) {
    throw new Error(`[validate-ld] JSON-LD roundtrip failed for ${entryKey}: ${e.message}\n  JSON: ${jsonStr.substring(0, 300)}`);
  }

  console.error(`  ✅ Dati strutturati validi (headline: "${ogT.substring(0, 50)}...")`);
}

/**
 * Update the lastmod date for a specific child sitemap in public/sitemap.xml.
 * Call this after modifying any child sitemap so the sitemap index stays fresh.
 */
function updateSitemapIndexLastmod(childSitemapUrl) {
  const file = 'public/sitemap.xml';
  let src = read(file);
  const today = new Date().toISOString().slice(0, 10);
  // Match the <sitemap> block containing this child URL and update its <lastmod>
  const escapedUrl = childSitemapUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = new RegExp(
    `(<loc>${escapedUrl}</loc>\\s*<lastmod>)\\d{4}-\\d{2}-\\d{2}(</lastmod>)`
  );
  if (rx.test(src)) {
    src = src.replace(rx, `$1${today}$2`);
    write(file, src);
    console.error(`  ✅ ${file} — updated lastmod for ${childSitemapUrl}`);
  }
}

/**
 * Strip JSON blobs and HTML tags from text intended for XML sitemap fields.
 * Prevents structured data leaking into <image:title> or similar plain-text fields.
 */
function sanitizePlainText(text) {
  let s = String(text || '');
  if (/^\s*[\[{]/.test(s)) s = '';
  s = s.replace(/<[^>]+>/g, '');
  return s.trim();
}

function modifySitemap(data) {
  const file = 'public/sitemap-blog.xml';
  let src = read(file);
  const today = new Date().toISOString().slice(0, 10);

  const imagePath = data._generatedImagePath
    ? data._generatedImagePath.replace(/^\//, '')
    : `images/places/${data.image}`;
  const imageCaption = sanitizePlainText(data.imageAlt?.it || data.seo.headline || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const imageTitle = sanitizePlainText(data.seo.headline || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const entry = `  <url>
    <loc>${BASE_URL}/articoli-frontaliere/${data.slugs.it}/</loc>
    <xhtml:link rel="alternate" hreflang="it" href="${BASE_URL}/articoli-frontaliere/${data.slugs.it}/" />
    <xhtml:link rel="alternate" hreflang="en" href="${BASE_URL}/en/cross-border-articles/${data.slugs.en}/" />
    <xhtml:link rel="alternate" hreflang="de" href="${BASE_URL}/de/grenzgaenger-artikel/${data.slugs.de}/" />
    <xhtml:link rel="alternate" hreflang="fr" href="${BASE_URL}/fr/articles-frontalier/${data.slugs.fr}/" />
    <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}/articoli-frontaliere/${data.slugs.it}/" />
    <image:image>
      <image:loc>${BASE_URL}/${imagePath}</image:loc>
      <image:title>${imageTitle}</image:title>
      <image:caption>${imageCaption}</image:caption>
    </image:image>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>`;

  // Insert before </urlset>
  src = src.replace(
    /(\n)<\/urlset>/,
    `$1${entry}\n\n</urlset>`
  );

  write(file, src);
  console.error(`  ✅ ${file}`);
  updateSitemapIndexLastmod('https://frontaliereticino.ch/sitemap-blog.xml');
}

function modifySitemapNews(data) {
  const file = 'public/sitemap-news.xml';
  let src = read(file);
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  // Ensure xmlns:image namespace is present (for Google News image discovery)
  if (!src.includes('xmlns:image=')) {
    src = src.replace(
      'xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"',
      'xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"\n        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"'
    );
  }

  // Ensure xmlns:xhtml namespace is present (for hreflang alternates)
  if (!src.includes('xmlns:xhtml=')) {
    src = src.replace(
      'xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"',
      'xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"\n        xmlns:xhtml="http://www.w3.org/1999/xhtml"'
    );
  }

  const imagePath = data._generatedImagePath
    ? data._generatedImagePath.replace(/^\//, '')
    : `images/places/${data.image}`;
  const imageTitle = sanitizePlainText(data.seo.headline || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const entry = `  <url>
    <loc>${BASE_URL}/articoli-frontaliere/${data.slugs.it}/</loc>
    <lastmod>${today}</lastmod>
    <xhtml:link rel="alternate" hreflang="it" href="${BASE_URL}/articoli-frontaliere/${data.slugs.it}/" />
    <xhtml:link rel="alternate" hreflang="en" href="${BASE_URL}/en/cross-border-articles/${data.slugs.en}/" />
    <xhtml:link rel="alternate" hreflang="de" href="${BASE_URL}/de/grenzgaenger-artikel/${data.slugs.de}/" />
    <xhtml:link rel="alternate" hreflang="fr" href="${BASE_URL}/fr/articles-frontalier/${data.slugs.fr}/" />
    <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}/articoli-frontaliere/${data.slugs.it}/" />
    <news:news>
      <news:publication>
        <news:name>Frontaliere Ticino</news:name>
        <news:language>it</news:language>
      </news:publication>
      <news:publication_date>${now}</news:publication_date>
      <news:title>${String(data.content.it.title || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</news:title>
      <news:keywords>${String(data.seo.keywords || 'frontalieri, ticino, svizzera').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</news:keywords>
    </news:news>
    <image:image>
      <image:loc>${BASE_URL}/${imagePath}</image:loc>
      <image:title>${imageTitle}</image:title>
    </image:image>
  </url>`;

  // Insert before </urlset>
  src = src.replace(
    /(\n)<\/urlset>/,
    `$1\n${entry}\n</urlset>`
  );

  write(file, src);
  console.error(`  ✅ ${file}`);
  updateSitemapIndexLastmod('https://frontaliereticino.ch/sitemap-news.xml');
}

// ── Step 5: Git add ─────────────────────────────────────────
function gitAddAll(data) {
  const files = [
    'services/router.ts',
    'services/routerBlogData.ts',
    'data/blog-articles-data.ts',
    'services/locales/blog-meta-it.ts',
    'services/locales/blog-meta-en.ts',
    'services/locales/blog-meta-de.ts',
    'services/locales/blog-meta-fr.ts',
    `services/locales/blog-body/it/${data.id}.ts`,
    `services/locales/blog-body/en/${data.id}.ts`,
    `services/locales/blog-body/de/${data.id}.ts`,
    `services/locales/blog-body/fr/${data.id}.ts`,
    'services/seo/seo-blog.ts',
    'services/seo/seo-pages.ts',
    'services/seoService.ts',
    'public/sitemap-blog.xml',
    'public/sitemap-news.xml',
    'public/sitemap.xml',
  ];
  if (existsSync(resolve(SOURCE_QUOTA_FILE))) {
    files.push(SOURCE_QUOTA_FILE);
  }
  if (existsSync(resolve(SOURCE_URLS_FILE))) {
    files.push(SOURCE_URLS_FILE);
  }
  // Include generated blog image if it exists (web path → filesystem path under public/)
  if (data?._generatedImagePath) {
    const webPath = data._generatedImagePath.replace(/^\//, '');
    files.push(`public/${webPath}`);
  }
  execSync(`git add ${files.join(' ')}`, { cwd: PROJECT_ROOT, stdio: 'inherit' });
  console.error('  ✅ Tutti i file modificati aggiunti a git');
}

// ── Main ────────────────────────────────────────────────────
const MAX_DUPLICATE_RETRIES = 8;

async function main() {
  let url = process.argv[2];
  let headlines = null;

  // ── Auto-scan mode: no URL provided → scan news sources first, then evergreen fallback ──
  if (!url) {
    const forceEvergreen = process.env.FORCE_EVERGREEN === '1';
    let newsSuccess = false;

    // ── Phase 1: Scan external news sources (skipped when FORCE_EVERGREEN=1) ──
    if (forceEvergreen) {
      console.error('📚 FORCE_EVERGREEN=1 — salto scan news, vado diretto a evergreen.\n');
    } else {
      console.error('🤖 Fase 1: Ricerca articolo da fonti ticinesi...\n');
      headlines = await scanNewsSources();
    }

    if (headlines && headlines.length > 0) {
      // ── Pre-filter: remove headlines whose source URL was already used ──
      const beforeSourceFilter = headlines.length;
      headlines = headlines.filter(h => {
        const check = isSourceUrlAlreadyUsed(h.url);
        if (check.used) {
          console.error(`  🔗 Headline scartata (URL già usata → ${check.articleId}): ${h.headline.slice(0, 60)}…`);
          return false;
        }
        return true;
      });
      if (beforeSourceFilter > headlines.length) {
        console.error(`  📋 Post-filtro URL: ${headlines.length}/${beforeSourceFilter} headline rimanenti\n`);
      }

      const quotaPools = buildSourceQuotaPools(headlines);
      const poolPlan = [];
      if (quotaPools.inQuota.length > 0) {
        poolPlan.push({ name: 'in-quota', headlines: quotaPools.inQuota });
      }
      if (quotaPools.outOfQuota.length > 0) {
        poolPlan.push({ name: 'out-of-quota', headlines: quotaPools.outOfQuota });
      }

      const triedUrls = new Set();

      for (let poolIndex = 0; poolIndex < poolPlan.length; poolIndex++) {
        const pool = poolPlan[poolIndex];
        if (poolIndex > 0) {
          console.error('\n⚠️  Nessuna opzione valida in quota: fallback su fonti out-of-quota.\n');
        }

        for (let attempt = 1; attempt <= MAX_DUPLICATE_RETRIES; attempt++) {
          try {
            console.error(`\n🧠 Selezione articolo con Gemini [${pool.name}] (tentativo ${attempt}/${MAX_DUPLICATE_RETRIES})...`);

            // Filter out already-tried URLs so Gemini picks something new
            const availableHeadlines = pool.headlines.filter(h => !triedUrls.has(h.url));
            if (availableHeadlines.length === 0) {
              console.error(`⚠️  Tutte le headline ${pool.name} sono state provate.`);
              break;
            }

            const chosen = await selectArticle(availableHeadlines);
            RUN_REPORT.selectionUsage.attemptsTotal += 1;
            if (chosen?._undatedFallback) RUN_REPORT.selectionUsage.attemptsUndated += 1;
            else RUN_REPORT.selectionUsage.attemptsRecent += 1;
            RUN_REPORT.selectedArticleType = 'news';
            RUN_REPORT.selectedSource = normalizeSourceDomain(chosen?.source || '');
            RUN_REPORT.selectedUrl = chosen?.url || null;
            triedUrls.add(chosen.url);
            url = chosen.url;
            console.error('');

            // Attempt the full article generation + duplicate check
            await generateAndValidateArticle(url, chosen);
            newsSuccess = true;
            return; // Success — exit main
          } catch (e) {
            const isDuplicate = e.message.includes('DUPLICATO');
            if (isDuplicate) captureDuplicateReasons(e.message);
            if (isDuplicate && attempt < MAX_DUPLICATE_RETRIES) {
              console.error(`\n🔄 Duplicato rilevato, riprovo con un altro articolo... (${attempt}/${MAX_DUPLICATE_RETRIES})\n`);
              url = null; // Reset for next iteration
              continue;
            }
            if (isDuplicate && attempt >= MAX_DUPLICATE_RETRIES) {
              console.error(`\n⚠️  ${MAX_DUPLICATE_RETRIES} tentativi ${pool.name} esauriti — tutti duplicati.`);
              break; // try next pool, then evergreen
            }
            // Fact-check / quality failures → skip this article, try next
            const isQualityReject = /fact-check|rigettato|veridicità|fabricat/i.test(e.message);
            if (isQualityReject && attempt < MAX_DUPLICATE_RETRIES) {
              console.error(`\n⚠️  Articolo rigettato per qualità — provo un altro headline... (${attempt}/${MAX_DUPLICATE_RETRIES})\n`);
              url = null;
              continue;
            }
            if (isQualityReject && attempt >= MAX_DUPLICATE_RETRIES) {
              console.error(`\n⚠️  ${MAX_DUPLICATE_RETRIES} tentativi ${pool.name} esauriti — qualità insufficiente.`);
              break; // try next pool, then evergreen
            }
            // Non-duplicate, non-quality error → propagate
            throw e;
          }
        }
      }
    } else {
      console.error('⚠️  Nessun headline trovato da nessuna fonte.\n');
    }

    // ── Phase 2: Evergreen fallback — only reached if news scan produced nothing usable ──
    if (!newsSuccess) {
      console.error('📚 Fase 2: Fallback evergreen — generazione articolo SEO long-tail...\n');

      // Pick an evergreen topic based on week number, with rotation on duplicate.
      // When static list is exhausted, append dynamic long-tail combinations.
      const dynamicTopics = buildDynamicEvergreenTopics();
      const topicPool = [...PRIORITY_EVERGREEN_TOPICS, ...dynamicTopics];
      const weekNum = Math.floor((Date.now() - new Date('2025-01-06').getTime()) / (7 * 24 * 60 * 60 * 1000));
      const baseIndex = weekNum % topicPool.length;
      const totalTopics = topicPool.length;

      // Pre-flight check — find first keyword that doesn't conflict with existing articles
      let selectedTopic = null;
      let selectedOffset = -1;
      console.error(`   Pre-flight check su ${totalTopics} keyword...\n`);

      for (let offset = 0; offset < totalTopics; offset++) {
        const idx = (baseIndex + offset) % totalTopics;
        const candidate = topicPool[idx];
        const check = preFlightEvergreenCheck(candidate.keyword);
        if (check.duplicate) {
          console.error(`   ⏭️  [${idx}] "${candidate.keyword}" → simile a "${check.existingTitle}" [${check.existingId}] (${(check.sim * 100).toFixed(0)}%) — skip`);
        } else {
          console.error(`   ✅ [${idx}] "${candidate.keyword}" → nessun conflitto — selezionato\n`);
          selectedTopic = candidate;
          selectedOffset = offset;
          break;
        }
      }

      if (!selectedTopic) {
        // Last-resort: pick a dynamic topic anyway and let full duplicate checker decide.
        selectedOffset = 0;
        selectedTopic = dynamicTopics[weekNum % dynamicTopics.length];
        console.error('\n⚠️  Tutte le keyword pre-flight risultano simili; uso fallback dinamico forzato.');
        console.error(`   ▶ Keyword fallback: "${selectedTopic.keyword}"\n`);
      }

      // Generate article with retry — rotate to next safe keyword on post-generation duplicate
      const triedOffsets = new Set([selectedOffset]);
      for (let attempt = 1; attempt <= Math.min(10, totalTopics); attempt++) {
        try {
          const topic = selectedTopic;
          const isStaticTopic = PRIORITY_EVERGREEN_TOPICS.includes(topic);
          RUN_REPORT.selectedArticleType = isStaticTopic ? 'evergreen_static' : 'evergreen_dynamic';
          RUN_REPORT.selectedSource = 'evergreen';
          RUN_REPORT.selectedUrl = `evergreen://${encodeURIComponent(topic.keyword)}`;
          console.error(`📚 Evergreen tentativo ${attempt}: keyword "${topic.keyword}"`);
          console.error(`   Angolo: ${topic.angle}\n`);
          url = `evergreen://${encodeURIComponent(topic.keyword)}`;
          process.env._EVERGREEN_ANGLE = topic.angle;
          process.env._EVERGREEN_KEYWORD = topic.keyword;

          await generateAndValidateArticle(url, { headline: topic.keyword, source: 'evergreen', relatedHeadlines: [] });
          return; // Success — exit main
        } catch (e) {
          const isDuplicate = e.message.includes('DUPLICATO');
          if (isDuplicate) captureDuplicateReasons(e.message);
          // Fact-check / quality failures → try next keyword instead of crashing
          const isQualityReject = /fact-check|rigettato|veridicità|fabricat/i.test(e.message);
          if (!isDuplicate && !isQualityReject) throw e; // Infrastructure error → propagate

          if (isQualityReject) {
            console.error(`\n⚠️  Articolo evergreen rigettato per qualità — cerco prossima keyword...\n`);
          } else {
            console.error(`\n🔄 Duplicato post-generazione, cerco prossima keyword sicura...\n`);
          }

          // Find next safe keyword we haven't tried yet
          selectedTopic = null;
          for (let offset = selectedOffset + 1; offset < selectedOffset + totalTopics; offset++) {
            const realOffset = offset % totalTopics;
            if (triedOffsets.has(realOffset)) continue;
            const idx = (baseIndex + realOffset) % totalTopics;
            const candidate = topicPool[idx];
            const check = preFlightEvergreenCheck(candidate.keyword);
            if (!check.duplicate) {
              selectedTopic = candidate;
              selectedOffset = realOffset;
              triedOffsets.add(realOffset);
              console.error(`   ✅ [${idx}] "${candidate.keyword}" → prossimo tentativo\n`);
              break;
            }
          }

          if (!selectedTopic) {
            // Final fallback: force one dynamic keyword not yet tried.
            const forced = dynamicTopics.find((t) => !triedOffsets.has(topicPool.indexOf(t)));
            if (forced) {
              selectedTopic = forced;
              selectedOffset = topicPool.indexOf(forced);
              triedOffsets.add(selectedOffset);
              console.error(`\n⚠️  Forzo keyword dinamica residuale: "${forced.keyword}"\n`);
              continue;
            }
            console.error('\n⚠️  Nessuna keyword evergreen disponibile. Push prosegue senza nuovo articolo.');
            finalizeRunReport('skipped', { notes: [...RUN_REPORT.notes, 'No evergreen keyword available after duplicate checks'] });
            process.exit(0);
          }
        }
      }

      // All retry attempts exhausted
      console.error('\n⚠️  Tentativi evergreen esauriti. Push prosegue senza nuovo articolo.');
      finalizeRunReport('skipped', { notes: [...RUN_REPORT.notes, 'Evergreen retries exhausted'] });
      process.exit(0);
    }
    return;
  }

  // ── Manual URL mode ──
  if (!url || (!url.startsWith('http') && !url.startsWith('evergreen://'))) {
    finalizeRunReport('error', { notes: [...RUN_REPORT.notes, 'Invalid URL input'] });
    console.error('❌ URL non valido. Uso: node scripts/create-article.mjs [url]');
    process.exit(1);
  }

  await generateAndValidateArticle(url, null);
}

/** Core article pipeline: fetch → generate IT → validate → duplicates → translate → sanitize → image → modify files → git */
async function generateAndValidateArticle(url, sourceContext = null) {
  // Step 1: Fetch page content
  const pageContent = await fetchPageContent(url);

  // Step 2: Generate Italian content + metadata (no translations yet), with aggressive min-word retries
  // Rotates through GPT-4o → GPT-4o-mini → Gemini with escalating prompts
  let data = null;
  let lastWordCount = 0;
  for (let attempt = 1; attempt <= CREATE_ARTICLE_MIN_WORDS_RETRIES; attempt++) {
    const modelSlot = MIN_WORDS_MODEL_ROTATION[Math.min(attempt - 1, MIN_WORDS_MODEL_ROTATION.length - 1)];
    const useGeminiDirect = modelSlot === 'gemini';
    // Higher temperature on later attempts to get more varied/longer output
    const tempBoost = attempt >= 7 ? 0.9 : (attempt >= 5 ? 0.8 : 0.7);
    const modelLabel = useGeminiDirect ? `Gemini ${AI_MODELS.GEMINI_FLASH}` : modelSlot;
    if (attempt > 1) {
      console.error(`  🔄 Tentativo ${attempt}/${CREATE_ARTICLE_MIN_WORDS_RETRIES} con ${modelLabel} (temp=${tempBoost})...`);
    }

    const genContext = {
      ...(sourceContext || {}),
      _generationAttempt: attempt,
      _generationAttemptMax: CREATE_ARTICLE_MIN_WORDS_RETRIES,
      _minItalianWords: CREATE_ARTICLE_MIN_IT_WORDS,
      _previousWordCount: lastWordCount || undefined,
      _forceModel: useGeminiDirect ? 'gemini' : modelSlot,
      _temperature: tempBoost,
    };

    let rawData;
    try {
      rawData = await callGemini(pageContent, url, genContext);
    } catch (e) {
      console.error(`  ⚠️  Tentativo ${attempt} fallito: ${e.message}`);
      if (attempt < CREATE_ARTICLE_MIN_WORDS_RETRIES) continue;
      throw e;
    }

    // Step 3: Validate (works on IT-only data)
    try {
      data = validate(rawData);
    } catch (validationErr) {
      console.error(`  ⚠️  Validazione fallita: ${validationErr.message}`);
      if (attempt < CREATE_ARTICLE_MIN_WORDS_RETRIES) {
        console.error(`  🔄 Rigenero contenuto per errore di validazione (${attempt}/${CREATE_ARTICLE_MIN_WORDS_RETRIES})...`);
        continue;
      }
      throw validationErr;
    }
    optimizeSeoMetadata(data);

    // Step 3a.0: Sanitize bold on IT content
    console.error('✂️  Sanitizzazione grassetto (IT):');
    sanitizeBoldFormatting(data);

    // Step 3a.0a: Domain-specific factual guard (tax-health audience inversion)
    try {
      assertTaxHealthConsistency(data.content.it, { ...(sourceContext || {}), url }, pageContent);
    } catch (consistencyErr) {
      console.error(`  ⚠️  ${consistencyErr.message}`);
      if (attempt < CREATE_ARTICLE_MIN_WORDS_RETRIES) {
        console.error(`  🔄 Rigenero contenuto IT per coerenza fattuale (${attempt}/${CREATE_ARTICLE_MIN_WORDS_RETRIES})...`);
        continue;
      }
      throw consistencyErr;
    }

    // Step 3a.0b: Fabricated references check — BLOCKING (fast regex pre-filter)
    try {
      assertNoFabricatedReferences(data.content.it);
    } catch (fabErr) {
      console.error(`  ⚠️  ${fabErr.message}`);
      if (attempt < CREATE_ARTICLE_MIN_WORDS_RETRIES) {
        console.error(`  🔄 Rigenero contenuto IT per riferimenti inventati (${attempt}/${CREATE_ARTICLE_MIN_WORDS_RETRIES})...`);
        continue;
      }
      throw fabErr;
    }

    // Step 3a.0c: LLM fact verification — PRIMARY BLOCKING GATE
    try {
      const factResult = await llmFactCheck(data.content.it, pageContent, url);
      if (!factResult.passed) {
        const issuesSummary = factResult.issues.map(i => `[${i.category || '?'}] "${(i.claim || '').slice(0, 60)}" — ${(i.reason || '').slice(0, 80)}`).join('; ');
        const err = new Error(`Articolo rigettato da fact-check: ${factResult.issues.length} problemi: ${issuesSummary}`);
        if (attempt < CREATE_ARTICLE_MIN_WORDS_RETRIES) {
          console.error(`  🔄 Rigenero contenuto IT per fact-check fallito (${attempt}/${CREATE_ARTICLE_MIN_WORDS_RETRIES})...`);
          continue;
        }
        throw err;
      }
    } catch (fcErr) {
      // Both fact-check rejections AND all-models-failed errors retry
      if (attempt < CREATE_ARTICLE_MIN_WORDS_RETRIES) {
        console.error(`  🔄 Rigenero per fact-check: ${fcErr.message.slice(0, 120)} (${attempt}/${CREATE_ARTICLE_MIN_WORDS_RETRIES})...`);
        continue;
      }
      throw fcErr;
    }

    const itWords = italianBodyWordCount(data);
    lastWordCount = itWords;
    if (itWords >= CREATE_ARTICLE_MIN_IT_WORDS) {
      // ── Repetition check INSIDE the loop — triggers retry if AI looped ──
      const itContentLoop = data.content.it || data.content;
      const allBodiesLoop = ['body1', 'body2', 'body3'].map(k => itContentLoop?.[k] || '');
      let hasRepetition = false;
      let repetitionReason = '';

      // 1. Detect repeated paragraphs within a single body field
      for (const [idx, body] of allBodiesLoop.entries()) {
        const paragraphs = body.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 60);
        const seen = new Map();
        let dupeCount = 0;
        for (const p of paragraphs) {
          const normalized = p.replace(/[.!?,;:\s]+$/g, '').toLowerCase().replace(/\s+/g, ' ');
          seen.set(normalized, (seen.get(normalized) || 0) + 1);
          if (seen.get(normalized) > 1) dupeCount++;
        }
        if (dupeCount >= 3) {
          hasRepetition = true;
          repetitionReason = `body${idx + 1} ha ${dupeCount} paragrafi ripetuti`;
          break;
        }
      }

      // 2. Detect sentences repeated 4+ times across all bodies
      if (!hasRepetition) {
        const allText = allBodiesLoop.join('\n\n');
        const sentences = allText.split(/[.!?]\s+/).map(s => s.trim().toLowerCase().replace(/\s+/g, ' ')).filter(s => s.length > 40);
        const sentCounts = new Map();
        for (const s of sentences) sentCounts.set(s, (sentCounts.get(s) || 0) + 1);
        const heavyRepeats = [...sentCounts.entries()].filter(([, c]) => c >= 4);
        if (heavyRepeats.length > 0) {
          hasRepetition = true;
          repetitionReason = `${heavyRepeats.length} frasi ripetute 4+ volte: "${heavyRepeats[0][0].substring(0, 60)}..." (${heavyRepeats[0][1]}x)`;
        }
      }

      if (hasRepetition) {
        console.error(`  ⚠️  AI loop rilevato: ${repetitionReason} — rigenero (${attempt}/${CREATE_ARTICLE_MIN_WORDS_RETRIES})...`);
        if (attempt < CREATE_ARTICLE_MIN_WORDS_RETRIES) continue;
        // Last attempt: auto-strip duplicate paragraphs as fallback
        console.error(`  🔧 Ultimo tentativo: auto-deduplica paragrafi ripetuti...`);
        for (const field of ['body1', 'body2', 'body3']) {
          if (itContentLoop?.[field]) {
            const paras = itContentLoop[field].split(/\n\n+/);
            const seen = new Set();
            const unique = [];
            for (const p of paras) {
              const norm = p.trim().replace(/[.!?,;:\s]+$/g, '').toLowerCase().replace(/\s+/g, ' ');
              if (norm.length < 60 || !seen.has(norm)) {
                seen.add(norm);
                unique.push(p);
              }
            }
            itContentLoop[field] = unique.join('\n\n');
          }
        }
        console.error(`  ✅ Auto-deduplica completata`);
        break;
      }

      // 3. Auto-strip title duplicated as first line in body fields
      const titleCheck = String(itContentLoop?.title || '').trim();
      if (titleCheck) {
        let titleInBodyCount = 0;
        for (const body of allBodiesLoop) {
          const firstLine = body.split('\n')[0].trim();
          if (firstLine === titleCheck || firstLine.startsWith(titleCheck)) titleInBodyCount++;
        }
        if (titleInBodyCount >= 2) {
          for (const field of ['body1', 'body2', 'body3']) {
            if (itContentLoop?.[field]) {
              const lines = itContentLoop[field].split('\n');
              if (lines[0].trim() === titleCheck || lines[0].trim().startsWith(titleCheck)) {
                lines.shift();
                while (lines.length > 0 && lines[0].trim() === '') lines.shift();
                itContentLoop[field] = lines.join('\n');
                console.error(`  🧹 Rimosso titolo duplicato da it.${field}`);
              }
            }
          }
        }
      }

      console.error(`  ✅ Soglia parole IT raggiunta: ${itWords} (min ${CREATE_ARTICLE_MIN_IT_WORDS}), nessun loop AI`);
      break;
    }
    if (attempt < CREATE_ARTICLE_MIN_WORDS_RETRIES) {
      console.error(`  ⚠️  Contenuto IT troppo corto: ${itWords} parole (min ${CREATE_ARTICLE_MIN_IT_WORDS}) — rigenero (${attempt}/${CREATE_ARTICLE_MIN_WORDS_RETRIES})...`);
      continue;
    }
    // ── Last resort: expand existing short content instead of failing ──
    console.error(`  🔧 Ultimo tentativo: espansione contenuto esistente (${itWords} → min ${CREATE_ARTICLE_MIN_IT_WORDS})...`);
    try {
      data = await expandShortItalianContent(data, CREATE_ARTICLE_MIN_IT_WORDS);
      const expandedWords = italianBodyWordCount(data);
      if (expandedWords >= CREATE_ARTICLE_MIN_IT_WORDS) {
        console.error(`  ✅ Espansione riuscita: ${expandedWords} parole (min ${CREATE_ARTICLE_MIN_IT_WORDS})`);
        break;
      }
      console.error(`  ⚠️  Espansione insufficiente: ${expandedWords} parole — fallback accettato`);
      // Accept the expanded content even if still slightly short (better than failing)
      if (expandedWords >= CREATE_ARTICLE_MIN_IT_WORDS * 0.85) {
        console.error(`  ✅ Contenuto accettato (≥85% soglia): ${expandedWords} parole`);
        break;
      }
    } catch (expandErr) {
      console.error(`  ⚠️  Espansione fallita: ${expandErr.message}`);
    }
    throw new Error(`Contenuto IT troppo corto dopo ${CREATE_ARTICLE_MIN_WORDS_RETRIES} tentativi + espansione (${italianBodyWordCount(data)}/${CREATE_ARTICLE_MIN_IT_WORDS} parole).`);
  }

  // Final thin content guard (after retry/expand attempts)
  {
    const itBodyFinal = `${(data.content.it || data.content)?.body1 || ''} ${(data.content.it || data.content)?.body2 || ''} ${(data.content.it || data.content)?.body3 || ''}`;
    const itPlainCharsFinal = itBodyFinal.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().length;
    if (itPlainCharsFinal < MIN_BODY_CHARS) {
      throw new Error(`Articolo troppo corto dopo retry: ${itPlainCharsFinal} chars (min: ${MIN_BODY_CHARS}). Google penalizza thin content.`);
    }
    console.error(`  ✅ [thin-content] Body finale: ${itPlainCharsFinal} chars (min: ${MIN_BODY_CHARS})`);
  }

    // Step 3a.0b: Strip leaked internal URLs from IT
  for (const field of ['body1', 'body2', 'body3']) {
    if (data.content.it?.[field]) {
      const before = data.content.it[field];
      data.content.it[field] = before.replace(/\n*📅[^\n]*evergreen:\/\/[^\n]*/g, '');
      if (before !== data.content.it[field]) {
        console.error(`  🧹 Rimosso URL interno da it.${field}`);
      }
    }
  }

  // Step 3a.2: Check for duplicates BEFORE translating (saves 3 API calls on duplicates)
  console.error('🔍 Verifica duplicati:');
  checkForDuplicates(data);

  // Step 3b: Translate to EN/DE/FR (only runs if not a duplicate)
  await translateArticle(data);

  // Step 3c: Sanitize bold + URLs + nav links on translated content
  console.error('✂️  Sanitizzazione grassetto (traduzioni):');
  sanitizeBoldFormatting(data);
  for (const locale of ['en', 'de', 'fr']) {
    for (const field of ['body1', 'body2', 'body3']) {
      if (data.content[locale]?.[field]) {
        let text = data.content[locale][field];
        // Strip leaked evergreen:// URLs
        text = text.replace(/\n*📅[^\n]*evergreen:\/\/[^\n]*/g, '');
        // Remove raw <a> tags
        text = text.replace(/<a\s+href="[^"]*"[^>]*>(.*?)<\/a>/gi, '$1');
        // Validate nav: links
        text = text.replace(/\[([^\]]+)\]\(nav:([a-z-]+)\)/g, (_m, linkText, action) => {
          const VALID_NAV_ACTIONS = new Set([
            'calculator', 'exchange', 'health', 'cost-of-living', 'pension', 'pillar3',
            'payslip', 'tax-return', 'residency', 'ristorni', 'unemployment', 'jobs', 'companies', 'banks',
            'first-day', 'permits', 'border', 'calendar', 'whatif', 'shopping', 'transport',
            'salary-compare', 'traffic-history',
            'border-map', 'municipalities', 'car-transfer', 'car-cost', 'permit-compare', 'renovation',
            'mobile', 'ral', 'parental-leave', 'nursery', 'living-ch', 'living-it', 'livability',
          ]);
          if (VALID_NAV_ACTIONS.has(action)) return _m;
          console.error(`  ⚠️  Link invalido [${linkText}](nav:${action}) in ${locale}.${field} — rimosso`);
          return linkText;
        });
        if (text !== data.content[locale][field]) data.content[locale][field] = text;
      }
    }
  }

  // Step 3d: Enforce CTA / internal links (all 4 locales)
  console.error('🔗 Verifica CTA e link interni:');
  validateAndEnforceCTA(data);
  enforceStrongInternalLinks(data);

  // Step 3e: Append source citation to body3 (E-E-A-T compliance)
  if (url && !url.startsWith('evergreen://')) {
    try {
      const sourceDomain = new URL(url).hostname.replace(/^www\./, '');
      const SOURCE_LABEL = { it: 'Fonte', en: 'Source', de: 'Quelle', fr: 'Source' };
      for (const locale of ['it', 'en', 'de', 'fr']) {
        if (!data.content[locale]?.body3) continue;
        const label = SOURCE_LABEL[locale] || 'Source';
        // Only append if not already present
        if (!data.content[locale].body3.includes(sourceDomain)) {
          data.content[locale].body3 += `\n\n*${label}: [${sourceDomain}](${url})*`;
        }
      }
      console.error(`  📰 Citazione fonte aggiunta: ${sourceDomain}`);
    } catch { /* invalid URL — skip */ }
  }

  console.error(`\n📝 Articolo generato: "${data.content.it.title}"`);
  console.error(`   ID: ${data.id}`);
  console.error(`   Categoria: ${data.category}`);
  console.error(`   Slug IT: ${data.slugs.it}`);
  console.error('');

  // Step 3b: Generate article image via Gemini native image generation
  console.error('🎨 Generazione immagine articolo:');
  const imagePath = await generateArticleImage(data);
  if (imagePath) {
    data._generatedImagePath = imagePath;
    console.error(`  ✅ Immagine generata: ${imagePath}`);
  } else {
    // Try keyword-based matching before falling back to AI-picked place image
    const matched = findBestFallbackImage(data);
    if (matched) {
      data._generatedImagePath = matched;
      console.error(`  ⚠️ Imagen non disponibile, uso match per keyword: ${matched}`);
    } else {
      console.error(`  ⚠️ Imagen non disponibile, uso immagine di fallback: /images/places/${data.image}`);
    }
  }

  // Step 4: Modify files
  console.error('\n📂 Modifica file sorgente:');
  modifyRouterTs(data);
  modifyBlogArticlesTsx(data);
  modifyI18nTs(data);
  modifyLocaleFile(data, 'en');
  modifyLocaleFile(data, 'de');
  modifyLocaleFile(data, 'fr');
  modifySeoService(data);
  modifySitemap(data);
  modifySitemapNews(data);

  // Step 4a.2: Regenerate RSS feeds (includes the new article)
  try {
    const { execSync } = await import('child_process');
    execSync('node scripts/generate-rss-feeds.mjs', { cwd: PROJECT_ROOT, stdio: 'inherit' });
  } catch (e) {
    console.error(`⚠️  RSS feed generation failed (non-blocking): ${e.message}`);
  }

  // Step 4b: Validate structured data (simulates ogPagesPlugin extraction)
  console.error('\n🔍 Validazione dati strutturati:');
  validateStructuredData(data);

  // Track source-domain weekly quotas only on successful article generation.
  const sourceDomain = normalizeSourceDomain(
    sourceContext?.source
      || (!url.startsWith('evergreen://') ? new URL(url).hostname : 'evergreen'),
  );
  if (SOURCE_QUOTA_ENABLED && sourceDomain && sourceDomain !== 'evergreen') {
    incrementWeeklySourceCount(sourceDomain);
  }

  // Track source URL for future duplicate prevention
  recordSourceUrl(url, data.id);

  // Step 5: Git add
  console.error('\n📦 Staging file:');
  gitAddAll(data);

  console.error('\n✅ Articolo creato! I test verificheranno la correttezza.');
  console.error(`   Titolo: ${data.content.it.title}`);
  console.error(`   URL: ${BASE_URL}/articoli-frontaliere/${data.id}`);
  RUN_REPORT.article.id = data.id;
  RUN_REPORT.article.url = `${BASE_URL}/articoli-frontaliere/${data.id}`;
  RUN_REPORT.article.sourceDomain = sourceDomain || null;

  // Write GitHub Actions outputs for downstream steps (Facebook posting, etc.)
  // Always use data.id (not data.slugs.it) — the router key is the article ID.
  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    const { appendFileSync } = await import('fs');
    const articleUrl = `${BASE_URL}/articoli-frontaliere/${data.id}`;
    const ogImagePath = data._generatedImagePath
      ? data._generatedImagePath.replace(/^\//, '')
      : `images/places/${data.image}`;
    appendFileSync(ghOutput, `article_id=${data.id}\n`);
    appendFileSync(ghOutput, `article_url=${articleUrl}\n`);
    appendFileSync(ghOutput, `source_url=${url}\n`);
    appendFileSync(ghOutput, `og_title=${data.seo.ogTitle}\n`);
    appendFileSync(ghOutput, `og_description=${data.seo.ogDescription}\n`);
    appendFileSync(ghOutput, `og_image=${BASE_URL}/${ogImagePath}\n`);
    appendFileSync(ghOutput, `category=${data.category}\n`);
    appendFileSync(ghOutput, `create_article_report=${CREATE_ARTICLE_REPORT_FILE}\n`);
    console.error('   📤 GitHub Actions outputs written');
  }

  // Log AI model stats & scoreboard
  const aiStats = getAiStats();
  console.error(`\n\ud83e\udd16 AI Model Stats: ${aiStats.calls} calls, ${aiStats.successes} successes, ${aiStats.retries} retries, ${aiStats.fallbacks} fallbacks`);
  if (aiStats.scoreBoard.length > 0) {
    console.error('\ud83d\udcca Model Scoreboard (top 5):');
    aiStats.scoreBoard.slice(0, 5).forEach(({ model, score }, i) =>
      console.error(`   ${i + 1}. ${model}: ${score >= 0 ? '+' : ''}${score}`)
    );
  }

  finalizeRunReport('generated');
}

main().catch((e) => {
  finalizeRunReport('error', { notes: [...RUN_REPORT.notes, `Error: ${e.message}`] });
  console.error(`\n❌ Errore: ${e.message}`);
  process.exit(1);
});
