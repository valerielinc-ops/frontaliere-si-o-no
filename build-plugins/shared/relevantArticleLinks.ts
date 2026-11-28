/**
 * Reverse links (F6.3c, O3): job pages, profession/career landings → recent
 * articles that are actually relevant to the page.
 *
 * Pure and deterministic: the same index + the same context always yield the
 * same ordered list (score desc, date desc, id asc — no randomness, no clock),
 * so page bytes, incremental-reuse digests and snapshot tests stay stable.
 *
 * Relevance is deliberately narrow (AGENTS.md #6: no substring/first-match
 * fallbacks on ambiguous data):
 *   1. CANTON — an article of another canton's section is never offered; the
 *      offer's own canton section is preferred, then frontaliere/svizzera.
 *   2. TOPIC — the page and the article title must share a profession/sector
 *      GROUP (curated multilingual lexicon below) or a SPECIFIC title token
 *      (≥ 5 chars, not a generic word, not in more than TOKEN_DF_CEILING of the
 *      pool's titles). A canton match alone is not "relevant": it is fallback.
 *   3. FALLBACK — when fewer than `limit` relevant articles exist the block is
 *      completed with the latest articles of the offer's canton section, then
 *      of the frontaliere section (the previous behaviour was "latest 5").
 *
 * The index itself is read over HTTP from the published corpus API by
 * `publishedArticleLinkIndex.ts`; nothing here imports the corpus.
 */

export type LinkLocale = 'it' | 'en' | 'de' | 'fr';

export const LINK_LOCALES: readonly LinkLocale[] = ['it', 'en', 'de', 'fr'];

/** Hard cap on links per block (brief: "Tetto 5 link"). */
export const MAX_RELEVANT_ARTICLE_LINKS = 5;

/** A token in more than this share of a pool's titles is too generic to match on. */
const TOKEN_DF_CEILING = 0.03;

export interface LinkArticle {
  id: string;
  /** `frontaliere`, `svizzera` or `canton-xx`. */
  section: string;
  /** Canton group code (`TI`, `ZH`, `APPENZELLO`…) for canton sections, else null. */
  canton: string | null;
  /** Title in the page language. */
  title: string;
  /** ISO date used for recency ordering. */
  date: string;
  /** Root-relative, indexable article path (verified against the published sitemap). */
  href: string;
}

export interface ArticleLinkIndex {
  /** Corpus commit the index was read at (diagnostics only). */
  commit: string;
  byLocale: Record<LinkLocale, LinkArticle[]>;
}

export interface LinkContext {
  locale: LinkLocale;
  /** Job canton group code (`TI`, `ZH`…); null = unknown. */
  canton?: string | null;
  /** Offer title in the page language. */
  title?: string;
  /** Job category key (`health`, `finance`…). */
  category?: string;
  /** Topic groups declared by the page itself (landings). */
  groups?: readonly string[];
  /** Extra specific keywords declared by the page itself (landings). */
  keywords?: readonly string[];
  limit?: number;
}

export interface SelectedArticle {
  article: LinkArticle;
  /** true when chosen for topic relevance, false when a recency fallback. */
  relevant: boolean;
  score: number;
}

// ── Text normalisation ───────────────────────────────────────────────────────

export function normalizeForMatch(input: string): string {
  return String(input ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Words that never identify a topic: generic job-board / site vocabulary,
// seniority and contract words, the border-worker brand terms every article
// carries, and locale function words. Compared after normalizeForMatch.
const GENERIC_TOKENS = new Set(
  (
    'lavoro lavori lavorare ricerca cerchiamo cerca offerta offerte posto posti annuncio annunci ' +
    'candidatura candidato candidati nuovo nuova nuovi nuove team azienda societa gruppo ' +
    'svizzera svizzere svizzero svizzeri ticino ticinese ticinesi frontaliere frontalieri frontaliera ' +
    'italia italiano italiani italiana grenzgaenger grenzganger frontalier frontaliers switzerland swiss ' +
    'schweiz suisse tessin ticino cross border borders crossborder ' +
    'tempo pieno parziale indeterminato determinato percentuale junior senior capo responsabile ' +
    'addetto addetta addetti collaboratore collaboratrice specialista esperto esperta manager ' +
    'mitarbeiter mitarbeiterin stelle stellen gesucht vollzeit teilzeit unbefristet befristet ' +
    'employee employer specialist expert full time part jobs job work working ' +
    'emploi poste recherche collaborateur collaboratrice temps plein partiel ' +
    'anni anno oggi come cosa quali quale perche quando tutto tutti ecco dopo prima nelle degli delle ' +
    'della dello dell sulla sulle sugli sono sara nuovi nuove per con che non piu dei del nel nella ' +
    'with from that this have will what when your their about into over after before ' +
    'nach eine einen einer dein ihre sind wird ' +
    'dans pour avec cette leurs sont plus ' +
    'cantone canton kanton ' +
    'lugano zurigo zurich berna bern losanna lausanne ginevra geneve geneva basilea basel lucerna luzern ' +
    'friburgo fribourg freiburg bellinzona locarno chiasso mendrisio sion sitten neuchatel neuenburg ' +
    'coira chur argovia aargau turgovia thurgau sciaffusa soletta solothurn glarona zugo ' +
    'giura vallese wallis vaud grigioni graubuenden uri svitto'
  ).split(' '),
);

const MIN_SPECIFIC_TOKEN_LENGTH = 5;

function tokenize(text: string): string[] {
  return normalizeForMatch(text)
    .split(' ')
    .filter((t) => t.length >= MIN_SPECIFIC_TOKEN_LENGTH && !GENERIC_TOKENS.has(t) && !/^\d+$/.test(t));
}

// ── Topic groups (multilingual stems, prefix-matched on word starts) ─────────

interface TopicGroup {
  id: string;
  /** Word-start stems, already normalised (lowercase, no accents). */
  stems: readonly string[];
}

export const TOPIC_GROUPS: readonly TopicGroup[] = [
  {
    id: 'health',
    stems: [
      'infermier', 'ospedal', 'clinic', 'pflege', 'spital', 'krankenhaus', 'nurse', 'nursing', 'hospital',
      'soignant', 'infirmi', 'hopita', 'medico', 'medicina', 'medicin', 'arzt', 'aerzt', 'fisioterap', 'physio', 'ostetric',
      'hebamme', 'sage femme', 'farmacist', 'apothek', 'pharmac', 'psicolog', 'psycholog', 'logoped',
      'dentale', 'dentist', 'zahnarzt', 'radiolog', 'sanitari', 'gesundheitswesen', 'oss ', 'ortoped',
      'orthop', 'ambulator', 'ginecolog', 'gynaek', 'geriatri', 'therapeut', 'terapist',
    ],
  },
  {
    id: 'construction',
    stems: [
      'edil', 'muratore', 'cantier', 'costruzion', 'maurer', 'baustell', 'construction', 'chantier',
      'architett', 'architekt', 'architect', 'carpent', 'idraulic', 'imbianch', 'impalcat',
    ],
  },
  {
    id: 'hospitality',
    stems: [
      'cuoco', 'cuochi', 'cucina', 'ristorant', 'ristorazion', 'cameriere', 'camerieri', 'albergh', 'hotel', 'gastro',
      'koch ', 'koeche', 'kellner', 'restaurant', 'serveur', 'cuisinier', 'barista', 'pizzaiol', 'chef ',
      'hotellerie', 'hospitality', 'catering',
    ],
  },
  {
    id: 'finance',
    stems: [
      'banca', 'banche', 'bancar', 'bank', 'banque', 'contabil', 'buchhalt', 'accounting', 'comptab',
      'private banking',
    ],
  },
  {
    id: 'tech',
    stems: [
      'informatic', 'software', 'sviluppator', 'developer', 'entwickler', 'devops', 'cyber', 'sistemista',
      'data scien', 'programmat', 'programmer', 'informatik', 'informatique',
    ],
  },
  {
    id: 'industry',
    stems: [
      'ingegner', 'engineer', 'ingenieur', 'meccanic', 'mechanic', 'mechanik', 'elettricist', 'electrician',
      'elektriker', 'industri', 'manifattur', 'operaio', 'operai ', 'produzion', 'production', 'produktion',
      'saldator', 'welder', 'schweisser', 'macchinist', 'automazion', 'fabbric', 'orologer', 'watch',
      'uhren', 'horlogerie',
    ],
  },
  {
    id: 'logistics',
    stems: [
      'autist', 'trasport', 'logistic', 'camion', 'fahrer', 'chauffeur', 'spedizion', 'magazzin',
      'lagerist', 'transport', 'driver',
    ],
  },
  {
    id: 'education',
    stems: [
      'educator', 'insegnant', 'docente', 'scuola', 'scuole', 'school', 'lehrer', 'schule', 'enseignant',
      'ecole', 'assistente social', 'sozialarbeit', 'social worker', 'asilo nido',
    ],
  },
  {
    id: 'retail',
    stems: ['vendit', 'commess', 'retail', 'verkauf', 'vente', 'negozi', 'supermerc', 'detailhandel'],
  },
  {
    id: 'admin',
    stems: [
      'impiegat', 'segretar', 'concors', 'sachbearbeit', 'secretariat', 'pubblica amministrazione',
      'public sector', 'oeffentlicher dienst', 'secteur public',
    ],
  },
  {
    id: 'contracts',
    stems: [
      'contratt', 'vertrag', 'contrat', 'arbeitsvertrag', 'ccl ', 'cct ', 'gav ', 'employment contract',
      'work contract',
    ],
  },
  {
    id: 'agencies',
    stems: [
      'interinal', 'agenzi', 'temporary', 'temp agenc', 'personalverm', 'temporaer', 'interim', 'recruit',
      'reclutament',
    ],
  },
  {
    id: 'internship',
    stems: ['stage ', 'stagist', 'tirocini', 'praktik', 'intern ', 'internship'],
  },
  {
    id: 'apprenticeship',
    stems: ['apprendist', 'lehrling', 'lehrstelle', 'apprentissage', 'apprentice'],
  },
];

const OFFER_EXCLUDED_GROUPS: ReadonlySet<string> = new Set(['contracts', 'agencies']);

/** Topic group ids found in `text` (word-start stem match on normalised text). */
export function topicGroupsOf(text: string, exclude: ReadonlySet<string> = new Set()): Set<string> {
  const hay = ` ${normalizeForMatch(text)} `;
  const out = new Set<string>();
  for (const g of TOPIC_GROUPS) {
    if (exclude.has(g.id)) continue;
    for (const stem of g.stems) {
      // Stems ending in a space are whole words; others are word-start prefixes.
      const needle = stem.endsWith(' ') ? ` ${stem}` : ` ${stem}`;
      if (hay.includes(needle)) {
        out.add(g.id);
        break;
      }
    }
  }
  return out;
}

// ── Index preparation ────────────────────────────────────────────────────────

interface PreparedArticle {
  article: LinkArticle;
  groups: Set<string>;
  tokens: Set<string>;
}

interface PreparedPool {
  items: PreparedArticle[];
  /** Tokens too common in this pool to be used as a specific match. */
  commonTokens: Set<string>;
}

const preparedCache = new WeakMap<LinkArticle[], PreparedPool>();

function preparePool(pool: LinkArticle[]): PreparedPool {
  const cached = preparedCache.get(pool);
  if (cached) return cached;
  const items: PreparedArticle[] = pool.map((article) => ({
    article,
    groups: topicGroupsOf(article.title),
    tokens: new Set(tokenize(article.title)),
  }));
  const df = new Map<string, number>();
  for (const it of items) for (const t of it.tokens) df.set(t, (df.get(t) ?? 0) + 1);
  const ceiling = Math.max(3, Math.floor(items.length * TOKEN_DF_CEILING));
  const commonTokens = new Set<string>();
  for (const [t, n] of df) if (n > ceiling) commonTokens.add(t);
  const prepared = { items, commonTokens };
  preparedCache.set(pool, prepared);
  return prepared;
}

const compareArticles = (a: LinkArticle, b: LinkArticle): number =>
  b.date.localeCompare(a.date) || a.id.localeCompare(b.id) || a.section.localeCompare(b.section);

// ── Selection ────────────────────────────────────────────────────────────────

/**
 * Pick up to `limit` articles for a page. Returns [] when the index has nothing
 * for the locale (callers then keep their previous behaviour).
 */
export function selectRelevantArticles(
  index: ArticleLinkIndex | null | undefined,
  ctx: LinkContext,
): SelectedArticle[] {
  if (!index) return [];
  const pool = index.byLocale[ctx.locale];
  if (!pool || pool.length === 0) return [];
  const limit = Math.max(0, Math.min(ctx.limit ?? MAX_RELEVANT_ARTICLE_LINKS, MAX_RELEVANT_ARTICLE_LINKS));
  if (limit === 0) return [];

  const prepared = preparePool(pool);
  const canton = ctx.canton ? String(ctx.canton).toUpperCase() : null;

  const pageGroups = new Set<string>(ctx.groups ?? []);
  // Offer titles never imply the landing-only groups: "gestione dei contratti" is not
  // about employment contracts, "agenzia generale" is not a temp agency.
  if (ctx.title) for (const g of topicGroupsOf(ctx.title, OFFER_EXCLUDED_GROUPS)) pageGroups.add(g);
  // `category` is deliberately NOT used as evidence: the crawler category is noisy
  // (measured: apprenticeships and M365 roles labelled "health"), so only the
  // offer's own title and the page's declared topics count.
  const titleTokens = new Set<string>(ctx.title ? tokenize(ctx.title) : []);
  const keywordTokens = new Set<string>((ctx.keywords ?? []).flatMap((k) => tokenize(k)));

  const eligible = prepared.items.filter(({ article }) => {
    if (article.section.startsWith('canton-')) return canton !== null && article.canton === canton;
    return true;
  });

  const scored: SelectedArticle[] = [];
  for (const it of eligible) {
    let groupHits = 0;
    for (const g of it.groups) if (pageGroups.has(g)) groupHits += 1;
    // Title tokens need TWO distinct specific matches (one shared word such as
    // "salute" or a street name is not topical); a keyword the page itself
    // declares (landings) is strong evidence on its own.
    let titleHits = 0;
    let keywordHits = 0;
    for (const t of it.tokens) {
      if (prepared.commonTokens.has(t)) continue;
      if (keywordTokens.has(t)) keywordHits += 1;
      else if (titleTokens.has(t)) titleHits += 1;
    }
    const tokenHits = keywordHits + (titleHits >= 2 ? titleHits : 0);
    if (groupHits === 0 && tokenHits === 0) continue;
    const sectionBonus = it.article.section.startsWith('canton-') ? 3 : it.article.section === 'frontaliere' ? 1 : 0;
    scored.push({
      article: it.article,
      relevant: true,
      score: 4 * tokenHits + 3 * groupHits + sectionBonus,
    });
  }
  scored.sort((a, b) => b.score - a.score || compareArticles(a.article, b.article));

  const picked: SelectedArticle[] = scored.slice(0, limit);
  if (picked.length >= limit) return picked;

  const taken = new Set(picked.map((p) => `${p.article.section}|${p.article.id}`));
  const fill = (candidates: PreparedArticle[]) => {
    const sorted = candidates.map((c) => c.article).sort(compareArticles);
    for (const article of sorted) {
      if (picked.length >= limit) return;
      const key = `${article.section}|${article.id}`;
      if (taken.has(key)) continue;
      taken.add(key);
      picked.push({ article, relevant: false, score: 0 });
    }
  };
  if (canton) fill(eligible.filter((it) => it.article.section.startsWith('canton-') && it.article.canton === canton));
  fill(eligible.filter((it) => it.article.section === 'frontaliere'));
  fill(eligible.filter((it) => it.article.section === 'svizzera'));
  return picked;
}

// ── Rendering ────────────────────────────────────────────────────────────────

export const RELEVANT_ARTICLES_LABEL: Record<LinkLocale, string> = {
  it: 'Articoli correlati',
  en: 'Related articles',
  de: 'Verwandte Artikel',
  fr: 'Articles liés',
};

export interface RelevantArticlesMarkup {
  sectionClass: string;
  headingClass?: string;
  headingStyle?: string;
  listClass: string;
  itemClass: string;
  linkClass?: string;
  linkStyle?: string;
}

/** Same markup contract as the host page's own related-links lists. */
export function renderRelevantArticlesBlock(
  selected: readonly SelectedArticle[],
  label: string,
  markup: RelevantArticlesMarkup,
  esc: (s: unknown) => string,
): string {
  if (selected.length === 0) return '';
  const items = selected
    .map(({ article }) => {
      const cls = markup.linkClass ? ` class="${markup.linkClass}"` : '';
      const style = markup.linkStyle ? ` style="${markup.linkStyle}"` : '';
      return `<li class="${markup.itemClass}"><a${cls}${style} href="${esc(article.href)}">${esc(article.title)}</a></li>`;
    })
    .join('');
  const hCls = markup.headingClass ? ` class="${markup.headingClass}"` : '';
  const hStyle = markup.headingStyle ? ` style="${markup.headingStyle}"` : '';
  return `<section class="${markup.sectionClass}" data-relevant-articles="1"><h2${hCls}${hStyle}>${esc(label)}</h2><ul class="${markup.listClass}">${items}</ul></section>`;
}

// ── Landing topics (profession / career landings are Ticino pages) ───────────

export interface LandingTopic {
  groups: readonly string[];
  keywords?: readonly string[];
}

export const PROFESSION_LANDING_TOPICS: Record<string, LandingTopic> = {
  infermiere: { groups: ['health'], keywords: ['infermiere', 'infermieri'] },
  operaio: { groups: ['industry'] },
  impiegato: { groups: ['admin'] },
  ingegnere: { groups: ['industry'], keywords: ['ingegnere', 'ingegneri'] },
  educatore: { groups: ['education'] },
  autista: { groups: ['logistics'] },
  muratore: { groups: ['construction'] },
  cuoco: { groups: ['hospitality'] },
  cameriere: { groups: ['hospitality'] },
  elettricista: { groups: ['industry'], keywords: ['elettricista', 'elettricisti'] },
  psicologo: { groups: ['health'], keywords: ['psicologo', 'psicologi'] },
  fisioterapista: { groups: ['health'], keywords: ['fisioterapista', 'fisioterapisti'] },
  logopedista: { groups: ['health'], keywords: ['logopedista'] },
  farmacista: { groups: ['health'], keywords: ['farmacista', 'farmacisti', 'farmacia'] },
  ostetrica: { groups: ['health'], keywords: ['ostetrica', 'ostetriche'] },
  'assistente-dentale': { groups: ['health'], keywords: ['dentale', 'dentista'] },
  'tecnico-radiologia': { groups: ['health'], keywords: ['radiologia'] },
  oss: { groups: ['health'] },
  'ottico-optometrista': { groups: ['health'], keywords: ['ottico', 'optometrista', 'ottici'] },
  contabile: { groups: ['finance'], keywords: ['contabile', 'contabili'] },
  'assistente-sociale': { groups: ['education'], keywords: ['sociale'] },
  macellaio: { groups: [], keywords: ['macellaio', 'macellai'] },
  saldatore: { groups: ['industry'], keywords: ['saldatore', 'saldatori'] },
  architetto: { groups: ['construction'], keywords: ['architetto', 'architetti'] },
};

export const CAREER_LANDING_TOPICS: Record<string, LandingTopic> = {
  'agenzie-lavoro-lugano': { groups: ['agencies'] },
  'concorsi-pubblici-lugano': { groups: ['admin'], keywords: ['concorsi', 'concorso'] },
  'stage-lugano': { groups: ['internship'] },
  'contratti-lavoro-frontalieri': { groups: ['contracts'] },
};
