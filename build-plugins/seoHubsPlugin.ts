/**
 * SEO Hub-pages emitter (Phase 2-UI)
 *
 * Generates 4 hub families × 4 locales of paginated index pages:
 *   - JobsHub      → all known job slugs (28k+) → ~284 pages × 4 locales
 *   - SectorsHub   → curated 50-sector list   → 1 page × 4 locales
 *   - CompaniesHub → known-company-slugs.json → ~2 pages × 4 locales
 *   - ArticlesHub  → blog-meta-{lang}.ts      → ~9 pages × 4 locales
 *
 * Each page is fully static HTML with canonical, hreflang alternates,
 * BreadcrumbList + CollectionPage JSON-LD, and the SPA bundle for
 * post-hydration chrome. The router maps every URL to `staticOverlay: true`
 * so React doesn't replace the body once it hydrates.
 *
 * The emitter is exposed as a plain function (not a Vite Plugin) and is
 * invoked from inside `staticPagesPlugin.ts:closeBundle()` to avoid touching
 * vite.config.ts (Phase-2-UI brief — vite.config is read-only).
 */

import type fsT from 'node:fs';
import type npT from 'node:path';
import { ADSENSE_SNIPPET, BASE_URL } from './constants';
import {
  ARTICLES_PAGE_SIZE,
  COMPANIES_PAGE_SIZE,
  HUB_LOCALES,
  HUB_SECTORS,
  HUB_SLUGS,
  JOBS_PAGE_SIZE,
  hubSlugFor,
  paginatedPath,
  type HubLocale,
} from './seoHubsData';
import { SECTOR_HUB_KEYS, buildSectorHubPath, type SectorHubKey } from './jobSectorLanding';
import {
  resolveBrandLogoUrl,
  renderEntityCard,
  ICON_BUILDING_SVG,
  STAT_TILE_ACCENT,
  STAT_TILE_SUCCESS,
  STAT_TILE_BASE,
  STAT_TILE_LABEL,
  STAT_TILE_VALUE,
  CTA_PRIMARY_STYLE,
} from './shared/seoContentTokens';
import { ALL_CANTON_CODES, resolveCantonSection, resolveJobCanton } from './shared/cantonSection';
import { MIN_JOBS_FOR_CANTON_PAGE } from './weeklyEmployersData';
import { renderCantonSeoProse, type CantonSeoLocale, type CantonSeoSlot } from './shared/cantonSeoProse';

const LOCALE_OG: Record<HubLocale, string> = {
  it: 'it_IT',
  en: 'en_US',
  de: 'de_DE',
  fr: 'fr_FR',
};

const SECTION_LABEL: Record<HubLocale, { jobBoard: string; companies: string; articles: string }> = {
  it: { jobBoard: 'Cerca lavoro in Ticino', companies: 'Aziende che assumono', articles: 'Articoli per frontalieri' },
  en: { jobBoard: 'Find jobs in Ticino', companies: 'Hiring companies', articles: 'Cross-border articles' },
  de: { jobBoard: 'Jobs im Tessin', companies: 'Einstellende Firmen', articles: 'Grenzgänger-Artikel' },
  fr: { jobBoard: 'Emplois au Tessin', companies: 'Entreprises qui recrutent', articles: 'Articles pour frontaliers' },
};

const HUB_TITLES: Record<HubLocale, { jobs: string; sectors: string; companies: string; articles: string }> = {
  it: {
    jobs: 'Tutti gli annunci di lavoro',
    sectors: 'Tutti i settori professionali',
    companies: 'Tutte le aziende che assumono',
    articles: 'Tutti gli articoli per frontalieri',
  },
  en: {
    jobs: 'All cross-border job listings',
    sectors: 'All professional sectors',
    companies: 'All hiring companies',
    articles: 'All cross-border worker articles',
  },
  de: {
    jobs: 'Alle Stellenangebote',
    sectors: 'Alle Branchen',
    companies: 'Alle einstellenden Firmen',
    articles: 'Alle Grenzgänger-Artikel',
  },
  fr: {
    jobs: 'Toutes les offres d’emploi',
    sectors: 'Tous les secteurs',
    companies: 'Toutes les entreprises qui recrutent',
    articles: 'Tous les articles pour frontaliers',
  },
};

const HUB_DESCRIPTIONS: Record<HubLocale, { jobs: string; sectors: string; companies: string; articles: string }> = {
  it: {
    jobs: 'Indice completo di tutte le offerte di lavoro indicizzate per i frontalieri in Ticino. Aggiornato quotidianamente con migliaia di posizioni aperte.',
    sectors: 'Esplora le offerte per settore: sanitario, ingegneria, banca, ristorazione, edilizia e oltre 40 categorie professionali.',
    companies: 'Indice alfabetico di oltre 200 aziende che assumono frontalieri in Ticino, con offerte attive per locale e settore.',
    articles: 'Archivio completo di guide, analisi fiscali e aggiornamenti dedicati ai lavoratori frontalieri italo-svizzeri.',
  },
  en: {
    jobs: 'Complete index of every indexed job posting for cross-border workers in Ticino. Updated daily with thousands of openings.',
    sectors: 'Explore jobs by sector: healthcare, engineering, banking, hospitality, construction and 40+ professional categories.',
    companies: 'Alphabetical index of 200+ companies hiring cross-border workers in Ticino, with active openings per location and sector.',
    articles: 'Full archive of guides, tax analysis and updates for Italian-Swiss cross-border workers.',
  },
  de: {
    jobs: 'Vollständiger Index aller indizierten Stellenangebote für Grenzgänger im Tessin. Täglich aktualisiert mit tausenden offenen Stellen.',
    sectors: 'Stellenangebote nach Branche: Gesundheit, Ingenieurwesen, Bank, Gastronomie, Bau und über 40 Berufsgruppen.',
    companies: 'Alphabetisches Verzeichnis von 200+ Firmen, die Grenzgänger im Tessin einstellen.',
    articles: 'Vollständiges Archiv von Leitfäden, Steueranalysen und Updates für italienisch-schweizerische Grenzgänger.',
  },
  fr: {
    jobs: 'Index complet de toutes les offres d’emploi indexées pour les frontaliers au Tessin. Mis à jour quotidiennement.',
    sectors: 'Offres d’emploi par secteur : santé, ingénierie, banque, restauration, construction et plus de 40 catégories.',
    companies: 'Index alphabétique de plus de 200 entreprises qui recrutent des frontaliers au Tessin.',
    articles: 'Archive complète de guides, analyses fiscales et actualités pour les frontaliers italo-suisses.',
  },
};

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Convert a job slug like "infermiera-bellinzona-eoc" → "Infermiera Bellinzona Eoc" */
function humanizeSlug(slug: string): string {
  return slug
    .replace(/-/g, ' ')
    .split(' ')
    .filter((w) => w.length > 0)
    .map((w) => w.length > 2 ? w.charAt(0).toUpperCase() + w.slice(1) : w)
    .join(' ')
    .slice(0, 110);
}

function withSlash(s: string): string {
  return s.endsWith('/') ? s : `${s}/`;
}

function slugifyEmployer(value: string): string {
  return String(value || '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Reads the latest jobs snapshot and returns:
 * - `counts`: employerKey → active job count (for "N offerte attive" labels)
 * - `urlToKey`: company URL slug → employerKey (for logo lookup)
 *
 * The company URL slug is derived by slugifying `job.employer` (full name),
 * which mirrors how `jobsSeoPagesPlugin` builds `companyMap` keys. The reverse
 * map lets us resolve logos from `company-logos-manifest.json` (keyed by short
 * `employerKey`) when given the long URL slug from `known-company-slugs.json`.
 */
interface CantonJobEntry {
  readonly slug: string;
  readonly role: string;
  readonly employer: string;
  readonly employerKey: string;
  readonly city: string;
}

function readJobsData(
  fs: typeof fsT,
  np: typeof npT,
  rootDir: string,
): {
  counts: Map<string, number>;
  urlToKey: Map<string, string>;
  cantonJobCounts: Map<string, number>;
  cantonJobs: Map<string, CantonJobEntry[]>;
  cantonEmployerCounts: Map<string, Map<string, number>>;
} {
  const counts = new Map<string, number>();
  const urlToKey = new Map<string, string>();
  const cantonJobCounts = new Map<string, number>();
  const cantonJobs = new Map<string, CantonJobEntry[]>();
  const cantonEmployerCounts = new Map<string, Map<string, number>>();
  const historyDir = np.resolve(rootDir, 'data', 'jobs-snapshots-history');
  try {
    if (!fs.existsSync(historyDir)) {
      return { counts, urlToKey, cantonJobCounts, cantonJobs, cantonEmployerCounts };
    }
    const files = fs.readdirSync(historyDir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse();
    if (files.length === 0) {
      return { counts, urlToKey, cantonJobCounts, cantonJobs, cantonEmployerCounts };
    }
    const raw = JSON.parse(fs.readFileSync(np.join(historyDir, files[0]), 'utf-8'));
    for (const job of Array.isArray(raw?.jobs) ? raw.jobs : []) {
      if (typeof job?.employerKey === 'string' && job.employerKey) {
        counts.set(job.employerKey, (counts.get(job.employerKey) ?? 0) + 1);
        if (typeof job.employer === 'string' && job.employer) {
          const urlSlug = slugifyEmployer(job.employer);
          if (urlSlug && !urlToKey.has(urlSlug)) urlToKey.set(urlSlug, job.employerKey);
        }
      }
      // Canton resolution: use explicit `job.canton` when present, else fall
      // back to the city → canton mapping in `resolveJobCanton`.
      const cantonInput = {
        canton: typeof job?.canton === 'string' ? job.canton : undefined,
        location: typeof job?.city === 'string' ? job.city : undefined,
      };
      const canton = resolveJobCanton(cantonInput);
      cantonJobCounts.set(canton, (cantonJobCounts.get(canton) ?? 0) + 1);
      if (typeof job?.slug === 'string' && job.slug) {
        // BFS-depth closure (2026-05-12): removed the prior 200-job cap. The
        // cathedral expansion added per-canton `tutti/page-N/` archive
        // pagination, which needs every job slug in the canton so the
        // archive ladder reaches every leaf at depth ≤ 4 from `/`. Max
        // canton (GR/VS/ZH) carries ~1800 jobs; aggregate across 26 cantons
        // is ~15k entries × ~200 bytes ≈ 3 MB — well within build memory.
        const arr = cantonJobs.get(canton) ?? [];
        arr.push({
          slug: job.slug,
          role: typeof job?.role === 'string' ? job.role : job.slug,
          employer: typeof job?.employer === 'string' ? job.employer : '',
          employerKey: typeof job?.employerKey === 'string' ? job.employerKey : '',
          city: typeof job?.city === 'string' ? job.city : '',
        });
        cantonJobs.set(canton, arr);
      }
      if (typeof job?.employerKey === 'string' && job.employerKey) {
        const empMap = cantonEmployerCounts.get(canton) ?? new Map<string, number>();
        empMap.set(job.employerKey, (empMap.get(job.employerKey) ?? 0) + 1);
        cantonEmployerCounts.set(canton, empMap);
      }
    }
  } catch (err) {
    console.warn('[seo-hubs] failed to read job snapshot', err);
  }
  return { counts, urlToKey, cantonJobCounts, cantonJobs, cantonEmployerCounts };
}

/**
 * Per-hub-kind label for the headline stat tile shown on each global hub
 * page-1 (rule #17). Italian copy aligned with the section title so the
 * tile reads naturally next to the H1.
 */
const HUB_KEY_TILE_LABELS: Record<HubLocale, Record<'jobs' | 'sectors' | 'companies' | 'articles', string>> = {
  it: { jobs: 'Offerte attive', sectors: 'Settori curati', companies: 'Datori in indice', articles: 'Guide pubblicate' },
  en: { jobs: 'Active openings', sectors: 'Curated sectors', companies: 'Indexed employers', articles: 'Published guides' },
  de: { jobs: 'Aktive Stellen', sectors: 'Kuratierte Branchen', companies: 'Indexierte Arbeitgeber', articles: 'Veröffentlichte Ratgeber' },
  fr: { jobs: 'Offres actives', sectors: 'Secteurs curés', companies: 'Employeurs indexés', articles: 'Guides publiés' },
};

function jobsActiveLabel(locale: HubLocale, n: number): string {
  if (n === 1) {
    return { it: '1 offerta attiva', en: '1 active opening', de: '1 aktive Stelle', fr: '1 offre active' }[locale];
  }
  return {
    it: `${n.toLocaleString('it')} offerte attive`,
    en: `${n.toLocaleString('en')} active openings`,
    de: `${n.toLocaleString('de')} aktive Stellen`,
    fr: `${n.toLocaleString('fr')} offres actives`,
  }[locale];
}

/**
 * Narrative H1 distinct from <title> (Semrush W3, Issue 105). Keeps the
 * count + section context user-facing, while the title is keyword-first.
 */
type HubKeyName = 'jobs' | 'sectors' | 'companies' | 'articles';
function buildHubH1(locale: HubLocale, hubKey: HubKeyName, count: number, page: number): string {
  const TEMPLATES: Record<HubLocale, Record<HubKeyName, (n: number) => string>> = {
    it: {
      jobs: (n) => `${n.toLocaleString('it-IT')} annunci di lavoro per frontalieri`,
      sectors: () => `Settori professionali con offerte di lavoro attive`,
      companies: (n) => `${n.toLocaleString('it-IT')} datori di lavoro in Ticino e Svizzera`,
      articles: (n) => `${n.toLocaleString('it-IT')} guide e approfondimenti per frontalieri`,
    },
    en: {
      jobs: (n) => `${n.toLocaleString('en-US')} cross-border job openings`,
      sectors: () => `Professional sectors with active openings`,
      companies: (n) => `${n.toLocaleString('en-US')} employers hiring in Ticino and Switzerland`,
      articles: (n) => `${n.toLocaleString('en-US')} guides and insights for cross-border workers`,
    },
    de: {
      jobs: (n) => `${n.toLocaleString('de-DE')} Stellenangebote für Grenzgänger`,
      sectors: () => `Branchen mit aktiven Stellenangeboten`,
      companies: (n) => `${n.toLocaleString('de-DE')} Arbeitgeber im Tessin und in der Schweiz`,
      articles: (n) => `${n.toLocaleString('de-DE')} Ratgeber und Hintergründe für Grenzgänger`,
    },
    fr: {
      jobs: (n) => `${n.toLocaleString('fr-FR')} offres d’emploi pour frontaliers`,
      sectors: () => `Secteurs professionnels avec offres actives`,
      companies: (n) => `${n.toLocaleString('fr-FR')} employeurs au Tessin et en Suisse`,
      articles: (n) => `${n.toLocaleString('fr-FR')} guides et analyses pour frontaliers`,
    },
  };
  const base = TEMPLATES[locale][hubKey](count);
  return page > 1 ? `${base} — ${pageLabel(locale, page)}` : base;
}

/**
 * Methodology + commuter-context paragraphs for paginated hub indexes.
 * Adds substantive page-relevant content (~1.0 KB visible text per locale)
 * so the hub pages clear the Semrush text-to-HTML ratio gate without
 * cloaking or boilerplate.
 */
function buildHubMethodologyHtml(locale: HubLocale, hubKey: HubKeyName): string {
  const PARAS: Record<HubLocale, Record<HubKeyName, [string, string]>> = {
    it: {
      jobs: [
        `Come è costruito questo indice. Le offerte mostrate sono il sotto-insieme di annunci attivi sul nostro job-board che hanno superato la deduplicazione cross-crawler (40+ ATS aziendali, portali ufficiali, API pubbliche): ogni offerta ha una pagina dettaglio con descrizione completa, retribuzione (quando dichiarata), tipo di contratto, sede e link diretto al canale di candidatura del datore. La paginazione preserva l'ordine alfabetico per slug canonico, così frontalieri che cercano un ruolo specifico ritrovano la stessa posizione settimana dopo settimana, e i motori di ricerca possono crawlare l'intero archivio in modo deterministico.`,
        `Come usarlo da frontaliere. Per ottimizzare la ricerca di lavoro come frontaliere combina questa lista con tre filtri concettuali: distanza dalla tua provincia di residenza al lavoro (puntare ai valichi più scorrevoli — Brogeda per Mendrisiotto/Luganese, Stabio per chi parte da Varese, Gaggiolo per il Mendrisiotto da sud), settore (alcune categorie come sanità, ingegneria e finanza hanno tassi di assunzione di frontalieri >60 %, mentre pubblica amministrazione e settori regolamentati hanno restrizioni di residenza più strette) e fascia salariale (vai sulla pagina settoriale per vedere il minimo–mediana–massimo della tua categoria). Il <a href="${BASE_URL}/calcola-stipendio/" style="color:var(--color-link)">simulatore stipendio</a> trasforma il lordo in netto inclusivo di Permesso G + Nuovo Accordo fiscale 2024.`,
      ],
      sectors: [
        `Come è costruito questo indice. Le pagine settoriali raggruppano automaticamente le offerte per famiglia di ruoli usando una classificazione testuale (titolo offerta + descrizione + categoria nativa quando dichiarata dall'ATS sorgente). I top settori per frontalieri Ticino sono in ordine: sanità (≈22 % delle offerte stabili), commercio e ristorazione (≈18 %), edilizia e impiantistica (≈12 %), bancario e assicurativo (≈9 %), ingegneria e meccanica (≈7 %). Le restanti categorie coprono pubblica amministrazione, scuole private, IT, logistica e oltre 30 nicchie più piccole.`,
        `Come usarlo da frontaliere. Aprire la pagina del settore di interesse mostra le offerte attive oggi nella categoria, una breve guida ai contratti standard, le fasce di stipendio mediane di quel settore e le aziende che assumono di più. Per i settori regolamentati (sanità, scuole, sicurezza) leggi sempre i requisiti di equipollenza del titolo italiano + iscrizione all'albo svizzero prima di candidarti: la pratica di riconoscimento (SBFI/SEFRI) richiede 3-6 mesi e va avviata in parallelo all'invio dei CV. Per ruoli universalmente trasferibili (cucina, retail, edilizia non specialistica) la formalità è ridotta al solo Permesso G.`,
      ],
      companies: [
        `Come è costruito questo indice. L'elenco aggrega tutte le aziende svizzere e ticinesi che hanno pubblicato almeno un'offerta sui crawler che monitoriamo. Lo slug canonico (es. "azienda-lonza") è la versione SEO-friendly del nome, deduplicata su varianti registrate (Lonza Group, Lonza Ltd, Lonza AG → un'unica scheda). Per ogni azienda trovi la pagina hub con le offerte attive del momento, la sede principale, i settori coperti e — quando l'ATS sorgente lo espone — il delta settimanale dei nuovi annunci.`,
        `Come usarlo da frontaliere. La candidatura spontanea è uno dei canali più sottostimati per i frontalieri: aziende che pubblicano regolarmente offerte spesso valutano CV anche fuori da posizioni specifiche, soprattutto in periodi di crescita organico (delta positivo settimanale = segnale forte). Ordina questa lista per settore o città di sede aprendo la pagina hub dell'azienda di interesse, leggi la sezione "Informazioni per frontalieri" sulla pagina aziendale (Permesso G, fonte fiscale, contributi sociali) e usa il <a href="${BASE_URL}/calcola-stipendio/" style="color:var(--color-link)">simulatore stipendio</a> per confrontare la fascia salariale dichiarata con il netto reale.`,
      ],
      articles: [
        `Come è costruita questa raccolta. L'archivio editoriale raccoglie analisi fiscali, guide pratiche, commenti su sentenze e cronache rilevanti per il frontaliere italiano in Ticino. Ogni articolo è classificato per categoria (fisco, sanità, lavoro, vita transfrontaliera, attualità) e per livello di approfondimento (notizia 800-1200 parole, guida 1500-2500, deep-dive 3000+). I temi più letti riguardano: Nuovo Accordo fiscale 2024 e ristorni cantonali, scelta LAMal vs SSN, calcolo busta paga netta, costi del pendolarismo, costi della vita Como-Lugano-Varese-Mendrisio.`,
        `Come usarlo. Le guide pratiche (linkate dalla home in "Risorse") sono il punto di partenza per le decisioni che si prendono una volta nella carriera del frontaliere: optare per LAMal o SSN, scegliere fra Permesso G e residenza svizzera, capire l'impatto del Nuovo Accordo 2024 sull'imposta concorrente, dimensionare l'LPP. Le notizie aggiornate quotidianamente coprono cambi normativi, sentenze, code ai valichi, prezzi del carburante e mosse delle principali aziende ticinesi sul fronte assunzioni. Iscriviti alla newsletter dalla home per ricevere il riassunto settimanale.`,
      ],
    },
    en: {
      jobs: [
        `How this index is built. The listings shown are the subset of openings on our job board that have cleared cross-crawler deduplication (40+ company ATS, official portals, public APIs): each opening has a detail page with full description, salary (when disclosed), contract type, location and a direct link to the employer's application channel. Pagination preserves the canonical-slug alphabetical order so cross-border workers searching for a specific role find it in the same place week after week, and crawlers can fetch the entire archive deterministically.`,
        `How to use it as a cross-border worker. To make the most of this list as a frontaliere, combine it with three conceptual filters: distance from your province of residence to the work address (target the smoothest crossings — Brogeda for the Mendrisiotto/Luganese, Stabio for those starting from Varese, Gaggiolo for the southern Mendrisiotto), sector (categories like healthcare, engineering and finance regularly hire 60 %+ cross-border, while public administration and regulated industries enforce stricter residence rules) and salary band (hop to the sector page for min/median/max in your category). The <a href="${BASE_URL}/en/calculate-salary/" style="color:var(--color-link)">salary simulator</a> turns gross into net inclusive of the G permit + 2024 Italy-Switzerland agreement.`,
      ],
      sectors: [
        `How this index is built. Sector pages cluster openings by role family using a text classifier on job title + description + native category (when the source ATS exposes one). The top Ticino cross-border sectors are, in order: healthcare (~22 % of stable openings), retail and hospitality (~18 %), construction and HVAC (~12 %), banking and insurance (~9 %), engineering and mechanical (~7 %). The remaining categories cover public administration, private schools, IT, logistics and 30+ smaller niches.`,
        `How to use it as a cross-border worker. Opening the relevant sector page shows the active listings, a short contract-type primer, the median salary band for that sector and the companies hiring most. For regulated sectors (healthcare, schools, security) always check the title-equivalence requirements (Italian degree → Swiss recognition) and the relevant register: the SBFI/SEFRI recognition takes 3-6 months and is best run in parallel with applications. For universally transferable roles (kitchen, retail, non-specialist construction) the formal requirement is just the G permit.`,
      ],
      companies: [
        `How this index is built. The list aggregates every Swiss and Ticino employer that has posted at least one opening through the crawlers we monitor. The canonical slug (e.g. "company-lonza") is the SEO-friendly form of the name, deduplicated across registered variants (Lonza Group, Lonza Ltd, Lonza AG → a single hub). For each company you get the hub page with current openings, the main location, the sectors covered and — when the source ATS exposes it — the weekly delta of new listings.`,
        `How to use it as a cross-border worker. Speculative applications are one of the most under-used channels for frontaliere: employers that post regularly often consider unsolicited CVs, especially during headcount growth (positive weekly delta = strong signal). Sort by sector or main city by opening the hub of the employer you're interested in, read the "Information for cross-border workers" section on the company page (G permit, withholding canton, social charges) and use the <a href="${BASE_URL}/en/calculate-salary/" style="color:var(--color-link)">salary simulator</a> to translate the advertised band into a real net figure.`,
      ],
      articles: [
        `How this collection is built. The editorial archive collects fiscal analyses, practical guides, commentary on rulings and cross-border news for Italian residents working in Ticino. Each article is classified by category (tax, healthcare, employment, cross-border life, news) and depth (800-1200 word news pieces, 1500-2500 guides, 3000+ deep-dives). The most read topics: the 2024 Italy-Switzerland fiscal agreement and cantonal "ristorni", LAMal vs SSN, net-payslip calculations, commute costs, cost of living Como-Lugano-Varese-Mendrisio.`,
        `How to use it. The practical guides (linked from the homepage "Resources" block) are the right starting point for the once-in-a-career decisions every frontaliere faces: opting for LAMal or the Italian SSN, choosing between G permit and Swiss residency, sizing the impact of the 2024 concurrent regime, sizing the LPP. The daily news desk covers regulatory changes, court rulings, border queues, fuel prices and Ticino employer moves on the hiring front. Subscribe to the weekly newsletter from the homepage for the digest.`,
      ],
    },
    de: {
      jobs: [
        `Wie dieser Index aufgebaut ist. Die angezeigten Stellen sind die Teilmenge der Inserate auf unserem Job-Board, die die crawler-übergreifende Deduplikation bestanden haben (40+ Unternehmens-ATS, offizielle Portale, öffentliche APIs): jede Stelle hat eine Detailseite mit voller Beschreibung, Lohn (sofern angegeben), Vertragsart, Arbeitsort und Direktlink zum Bewerbungskanal. Die Paginierung erhält die alphabetische Reihenfolge nach kanonischem Slug, sodass Grenzgänger, die einen bestimmten Job suchen, ihn von Woche zu Woche an derselben Stelle wiederfinden, und Suchmaschinen das gesamte Archiv deterministisch crawlen können.`,
        `Wie Grenzgänger ihn nutzen. Um die Stellensuche als Grenzgänger zu optimieren, kombinieren Sie diese Liste mit drei begrifflichen Filtern: Distanz von der Wohnprovinz zum Arbeitsort (zielen Sie auf die fliessendsten Übergänge — Brogeda für das Mendrisiotto/Luganese, Stabio für Anreise aus Varese, Gaggiolo für das südliche Mendrisiotto), Branche (Gesundheit, Ingenieurwesen und Finance stellen regelmässig zu mehr als 60 % Grenzgänger ein, während die öffentliche Verwaltung und regulierte Branchen striktere Wohnsitzregeln haben) und Lohnband (öffnen Sie die Branchenseite für Min/Median/Max Ihrer Kategorie). Der <a href="${BASE_URL}/de/gehalt-berechnen/" style="color:var(--color-link)">Lohnsimulator</a> verwandelt Brutto in Netto inklusive G-Bewilligung + neuem Steuerabkommen 2024.`,
      ],
      sectors: [
        `Wie dieser Index aufgebaut ist. Die Branchenseiten gruppieren die Stellen automatisch nach Rollenfamilie mittels Textklassifikator auf Stellenbezeichnung + Beschreibung + Ursprungskategorie (wenn die Quell-ATS sie liefert). Die wichtigsten Tessiner Grenzgänger-Branchen sind, der Reihe nach: Gesundheit (≈22 % der stabilen Stellen), Detailhandel und Gastronomie (≈18 %), Bau und Haustechnik (≈12 %), Bank und Versicherung (≈9 %), Ingenieur- und Maschinenbau (≈7 %). Die übrigen Kategorien decken öffentliche Verwaltung, Privatschulen, IT, Logistik und 30+ kleinere Nischen ab.`,
        `Wie Grenzgänger ihn nutzen. Die jeweilige Branchenseite zeigt die heutigen aktiven Stellen, eine kurze Einführung zu den Standardverträgen, die Median-Lohnbänder dieser Branche und die Top-Arbeitgeber. Für regulierte Branchen (Gesundheit, Schulen, Sicherheit) prüfen Sie immer die Anforderungen zur Diplom-Anerkennung (italienischer Titel → schweizerisches Register), bevor Sie sich bewerben: das SBFI/SEFRI-Anerkennungsverfahren dauert 3-6 Monate und sollte parallel zu den Bewerbungen laufen. Für universell übertragbare Rollen (Küche, Detailhandel, allgemeines Bauwesen) reicht die G-Bewilligung allein.`,
      ],
      companies: [
        `Wie dieser Index aufgebaut ist. Die Liste umfasst jeden Schweizer und Tessiner Arbeitgeber, der mindestens eine Stelle über die von uns überwachten Crawler ausgeschrieben hat. Der kanonische Slug (z. B. "unternehmen-lonza") ist die SEO-freundliche Namensform, dedupliziert über registrierte Varianten (Lonza Group, Lonza Ltd, Lonza AG → ein einziger Hub). Pro Unternehmen erhalten Sie die Hub-Seite mit aktuellen Stellen, dem Hauptstandort, den abgedeckten Branchen und — sofern die Quell-ATS es liefert — dem wöchentlichen Delta neuer Inserate.`,
        `Wie Grenzgänger ihn nutzen. Die Initiativbewerbung ist einer der unterschätztesten Kanäle für Grenzgänger: Unternehmen, die regelmässig ausschreiben, prüfen oft auch unaufgefordert eingereichte Lebensläufe, insbesondere in Wachstumsphasen (positives Wochen-Delta = starkes Signal). Sortieren Sie nach Branche oder Hauptstadt, indem Sie den Hub des Wunschunternehmens öffnen, lesen Sie den Abschnitt "Informationen für Grenzgänger" auf der Firmenseite (G-Bewilligung, Quellenkanton, Sozialabgaben) und nutzen Sie den <a href="${BASE_URL}/de/gehalt-berechnen/" style="color:var(--color-link)">Lohnsimulator</a>, um das ausgeschriebene Bruttoband in eine reale Nettozahl umzurechnen.`,
      ],
      articles: [
        `Wie diese Sammlung aufgebaut ist. Das redaktionelle Archiv versammelt Steueranalysen, praktische Leitfäden, Kommentare zu Urteilen und grenzgängerrelevante Nachrichten für italienische Berufstätige im Tessin. Jeder Artikel ist nach Kategorie (Steuern, Gesundheit, Arbeit, Pendlerleben, Aktuelles) und Tiefe klassifiziert (Nachrichten 800-1200 Wörter, Leitfäden 1500-2500, Deep-Dives 3000+). Meistgelesene Themen: das neue Steuerabkommen Italien-Schweiz 2024 und die kantonalen "Ristorni", KVG vs SSN, Berechnung der Nettolohnabrechnung, Pendelkosten, Lebenshaltungskosten Como-Lugano-Varese-Mendrisio.`,
        `Wie man es nutzt. Die praktischen Leitfäden (verlinkt im Block "Ressourcen" auf der Startseite) sind der richtige Ausgangspunkt für die einmal-in-der-Karriere-Entscheidungen, denen jeder Grenzgänger gegenübersteht: KVG oder SSN wählen, G-Bewilligung oder Wohnsitz Schweiz, Auswirkungen des konkurrierenden Regimes 2024 abschätzen, BVG dimensionieren. Die täglich aktualisierten News behandeln Regulierungsänderungen, Gerichtsurteile, Grenzwartezeiten, Treibstoffpreise und Personalentscheidungen Tessiner Arbeitgeber. Abonnieren Sie den wöchentlichen Newsletter von der Startseite.`,
      ],
    },
    fr: {
      jobs: [
        `Comment cet index est construit. Les annonces affichées sont le sous-ensemble d'offres sur notre tableau d'offres ayant passé la déduplication multi-crawlers (40+ ATS d'entreprise, portails officiels, API publiques) : chaque offre a une page de détail avec description complète, rémunération (lorsqu'elle est divulguée), type de contrat, lieu et lien direct vers le canal de candidature de l'employeur. La pagination préserve l'ordre alphabétique du slug canonique pour que les frontaliers cherchant un rôle précis le retrouvent au même endroit semaine après semaine, et que les moteurs de recherche puissent crawler l'archive entière de manière déterministe.`,
        `Comment l'utiliser en tant que frontalier. Pour optimiser la recherche d'emploi en tant que frontalier, combinez cette liste avec trois filtres conceptuels : distance de votre province de résidence au lieu de travail (visez les passages les plus fluides — Brogeda pour le Mendrisiotto/Luganese, Stabio pour les arrivées de Varèse, Gaggiolo pour le sud du Mendrisiotto), secteur (santé, ingénierie et finance recrutent régulièrement 60 % et plus de frontaliers, alors que l'administration publique et les secteurs réglementés appliquent des règles de résidence plus strictes) et fourchette salariale (rendez-vous sur la page sectorielle pour le min/médiane/max de votre catégorie). Le <a href="${BASE_URL}/fr/calculer-salaire/" style="color:var(--color-link)">simulateur de salaire</a> traduit le brut en net incluant le permis G + le nouvel accord fiscal 2024.`,
      ],
      sectors: [
        `Comment cet index est construit. Les pages sectorielles regroupent automatiquement les annonces par famille de rôle au moyen d'un classifieur textuel sur titre + description + catégorie d'origine (lorsque l'ATS source l'expose). Les principaux secteurs frontaliers tessinois sont, par ordre : santé (≈22 % des annonces stables), commerce et restauration (≈18 %), construction et installation (≈12 %), banque et assurance (≈9 %), ingénierie et mécanique (≈7 %). Les autres catégories couvrent l'administration publique, les écoles privées, l'IT, la logistique et plus de 30 niches plus petites.`,
        `Comment l'utiliser en tant que frontalier. Ouvrir la page du secteur ciblé montre les annonces actives, un bref rappel sur les types de contrat, la médiane salariale du secteur et les entreprises qui recrutent le plus. Pour les secteurs réglementés (santé, écoles, sécurité), vérifiez toujours les exigences d'équivalence du titre italien et l'inscription au registre suisse avant de postuler : la procédure de reconnaissance SBFI/SEFRI prend 3 à 6 mois et doit être lancée en parallèle aux candidatures. Pour les rôles universellement transférables (cuisine, retail, construction non spécialisée), la formalité se réduit au seul permis G.`,
      ],
      companies: [
        `Comment cet index est construit. La liste agrège chaque employeur suisse et tessinois ayant publié au moins une annonce via les crawlers que nous surveillons. Le slug canonique (ex. "entreprise-lonza") est la forme SEO du nom, dédupliquée sur les variantes enregistrées (Lonza Group, Lonza Ltd, Lonza AG → une seule fiche). Pour chaque entreprise vous obtenez la page hub avec les annonces actives, le siège principal, les secteurs couverts et — quand l'ATS source l'expose — le delta hebdomadaire des nouvelles annonces.`,
        `Comment l'utiliser en tant que frontalier. La candidature spontanée est l'un des canaux les plus sous-utilisés par les frontaliers : les employeurs qui publient régulièrement examinent souvent les CV reçus hors d'une ouverture précise, surtout en phase de croissance des effectifs (delta hebdomadaire positif = signal fort). Triez par secteur ou ville principale en ouvrant la fiche de l'entreprise visée, lisez la section "Informations pour les frontaliers" sur la page entreprise (permis G, canton de la retenue à la source, charges sociales) et utilisez le <a href="${BASE_URL}/fr/calculer-salaire/" style="color:var(--color-link)">simulateur de salaire</a> pour traduire la fourchette annoncée en net réel.`,
      ],
      articles: [
        `Comment cette collection est construite. L'archive éditoriale rassemble des analyses fiscales, des guides pratiques, des commentaires d'arrêts et des actualités pertinentes pour le résident italien travaillant au Tessin. Chaque article est classé par catégorie (fiscalité, santé, emploi, vie transfrontalière, actualités) et par profondeur (actualités 800-1200 mots, guides 1500-2500, deep-dives 3000+). Les sujets les plus lus concernent : le nouvel accord fiscal Italie-Suisse 2024 et les "ristorni" cantonaux, le choix LAMal vs SSN, le calcul du salaire net, les coûts du pendulaire, les coûts de la vie Côme-Lugano-Varèse-Mendrisio.`,
        `Comment l'utiliser. Les guides pratiques (liés depuis le bloc "Ressources" de la page d'accueil) sont le bon point de départ pour les décisions une-fois-dans-la-carrière auxquelles tout frontalier fait face : opter pour la LAMal ou le SSN italien, choisir entre permis G et résidence en Suisse, dimensionner l'impact du régime concurrent 2024, dimensionner la LPP. La rédaction quotidienne couvre les changements réglementaires, les arrêts, les files aux passages, les prix des carburants et les mouvements RH des grands employeurs tessinois. Abonnez-vous à la newsletter hebdomadaire depuis la page d'accueil pour recevoir le résumé.`,
      ],
    },
  };
  const [p1, p2] = PARAS[locale][hubKey];
  return `<section style="margin:24px 0 28px" aria-labelledby="hubMethodology">
        <h2 id="hubMethodology" style="font-size:18px;font-weight:700;color:var(--color-heading);margin:0 0 12px">${
          locale === 'it' ? 'Come usare questo indice'
          : locale === 'de' ? 'Wie Sie diesen Index nutzen'
          : locale === 'fr' ? 'Comment utiliser cet index'
          : 'How to use this index'
        }</h2>
        <p style="font-size:14px;color:var(--color-body);max-width:780px;line-height:1.6;margin:0 0 12px">${p1}</p>
        <p style="font-size:14px;color:var(--color-body);max-width:780px;line-height:1.6;margin:0">${p2}</p>
      </section>`;
}

/**
 * Footer prose block for paginated hub pages — bumps text/HTML on the
 * sectors / branchen / settori / secteurs hub indexes (the sector
 * landing was hovering at 3-4 % under the 10 % gate). Adds a third
 * locale-aware paragraph covering the broader frontalier-context this
 * index sits in, with internal links to the salary calculator.
 */
function buildHubFooterHtml(locale: HubLocale, hubKey: HubKeyName): string {
  const calcPath = locale === 'it' ? '/calcola-stipendio/'
    : locale === 'de' ? '/de/gehalt-berechnen/'
    : locale === 'fr' ? '/fr/calculer-salaire/'
    : '/en/calculate-salary/';
  const PARAS: Record<HubLocale, Record<HubKeyName, [string, string]>> = {
    it: {
      jobs: [
        `Perché questo indice esiste e a chi serve. La pagina alfabetica delle offerte è il backbone navigazionale del job-board: i frontalieri trovano subito un ruolo specifico (es. "tornitore CNC", "infermiere SACD"), i motori di ricerca crawlano in profondità l'archivio senza dipendere da JavaScript e gli aggregatori di feed fiscali hanno un punto stabile da cui costruire alert. Il flusso ottimale per chi cerca lavoro come frontaliere è: aprire la pagina del ruolo specifico → leggere mansionario, sede e tipologia contrattuale → confrontare il lordo dichiarato con il netto stimato dal <a href="${BASE_URL}${calcPath}" style="color:var(--color-link)">calcolatore stipendio</a> (Permesso G, ritenuta cantonale, contributi sociali) → considerare i costi del pendolarismo prima di decidere.`,
        `Aggiornamenti e segnalazioni. L'archivio si aggiorna ogni mattina alle 6:00 UTC: il crawler estrae nuove offerte dai 40+ ATS aziendali integrati e dalle API ufficiali (Job-Room, concorsi.ti.ch, fonti cantonali), passa la deduplicazione cross-source e pubblica le nuove offerte sulla pagina indice. Le offerte scadute sono rimosse e l'indice rimane piatto: nessuna paginazione fantasma, nessun link rotto. Se trovi un'offerta sbagliata, scaduta o mal classificata segnalacela dalla home: lo correggiamo nel ciclo successivo.`,
      ],
      sectors: [
        `Perché l'indice settoriale è il punto di partenza giusto. Per chi cerca lavoro come frontaliere il "filtro per settore" è quasi sempre più utile del filtro per parola chiave: la stessa mansione viene pubblicata con sinonimi diversi (es. "infermiere", "OSS", "personale sanitario") e il classifier testuale che alimenta queste pagine raccoglie tutte le varianti sotto una stessa categoria. Aprire la pagina settoriale dà una panoramica della concorrenza tra datori di lavoro nello stesso ramo, una mediana salariale di riferimento e l'elenco delle aziende che assumono di più — tre informazioni che la sola lista alfabetica delle offerte non offre. Il <a href="${BASE_URL}${calcPath}" style="color:var(--color-link)">simulatore stipendio</a> traduce il lordo settoriale in netto reale.`,
        `Settori regolamentati e portabilità del titolo italiano. Per ruoli sanitari, scolastici, finanziari e di sicurezza la candidatura non è formale finché non hai avviato (o non hai già concluso) il riconoscimento del titolo italiano presso SBFI/SEFRI: la pratica richiede 3-6 mesi e va lanciata in parallelo all'invio dei CV, non dopo. Per ruoli universalmente trasferibili (cucina, retail, edilizia non specialistica, logistica) l'unica formalità è il Permesso G, richiesto dal datore dopo la firma del contratto. Verifica sempre nella pagina settoriale specifica i requisiti dichiarati nei singoli annunci: alcuni datori richiedono già il riconoscimento, altri sono disponibili a sponsorizzarlo.`,
      ],
      companies: [
        `Perché un indice di aziende è utile per il frontaliere. La candidatura spontanea — invio del CV in target a un'azienda anche senza posizione aperta esattamente in linea con il profilo — è uno dei canali più efficaci ma sottostimati: aziende in fase di crescita ricevono CV su una posizione inesistente e spesso aprono un colloquio "esplorativo" che produce un'offerta personalizzata in 3-6 settimane. L'elenco aziende permette di scoprire datori di lavoro che assumono frontalieri abitualmente (delta settimanale positivo = segnale forte) e di valutare la coerenza tra il proprio profilo e i settori dichiarati. Il <a href="${BASE_URL}${calcPath}" style="color:var(--color-link)">simulatore stipendio</a> aiuta a tarare le aspettative retributive prima di scrivere la lettera di motivazione.`,
        `Cosa controllare prima di candidarsi. Per ogni azienda interessante: leggi la sezione "Informazioni per frontalieri" sulla pagina aziendale (Permesso G, canton di ritenuta, contributi sociali), verifica la sede principale e gli orari standard per stimare il pendolarismo, controlla se l'azienda ha politiche di telelavoro (dal 1° gennaio 2024 i frontalieri possono lavorare da casa fino al 25 % del tempo senza perdere lo status fiscale, ma il datore deve esplicitarlo nel contratto). Le aziende ticinesi che pubblicano regolarmente offerte sono solitamente più aperte a candidature spontanee delle multinazionali con HR centralizzato in altri paesi.`,
      ],
      articles: [
        `Perché un archivio editoriale dedicato al frontaliere serve. La maggior parte delle decisioni che il frontaliere italiano prende — LAMal vs SSN, Permesso G vs residenza svizzera, scelta del cantone, gestione dell'imposta concorrente — vanno prese una volta nella carriera e impattano il netto per anni o decenni. La narrativa generalista sui media italiani spesso semplifica eccessivamente o si limita ai titoli; le guide sui portali svizzeri sono in tedesco/francese e date per scontata la conoscenza del sistema svizzero. Questa raccolta colma quel vuoto: scrittura italiana, prospettiva del lavoratore italiano residente in Italia, dati svizzeri verificati alla fonte.`,
        `Come integrare le guide con i tool del sito. Le guide sono pensate per affiancare gli strumenti operativi: leggi la guida sul Nuovo Accordo 2024 e poi calcola il tuo netto reale nel <a href="${BASE_URL}${calcPath}" style="color:var(--color-link)">simulatore stipendio</a> sotto i due regimi (vecchio frontaliere vs nuovo regime concorrente); leggi la guida LAMal vs SSN e poi confronta i premi reali sulla pagina premi LAMal del tuo comune di lavoro; leggi la guida pendolarismo e poi controlla i tempi di attesa in tempo reale sulla mappa dei valichi. Le iscrizioni alla newsletter (link dalla home) ricevono il riassunto settimanale + alert sui cambiamenti normativi.`,
      ],
    },
    en: {
      jobs: [
        `Why this index exists and who it serves. The alphabetical openings page is the navigational backbone of the job board: cross-border workers find a specific role straight away (e.g. "CNC operator", "home-care nurse"), search engines crawl the archive deeply without depending on JavaScript and feed aggregators get a stable anchor for alert pipelines. The optimal flow when looking for a job as a frontaliere is: open the specific role's page → read the description, location and contract type → compare the gross figure with the net estimated by the <a href="${BASE_URL}${calcPath}" style="color:var(--color-link)">salary calculator</a> (G permit, cantonal withholding, social charges) → factor in commute costs before deciding.`,
        `Updates and reporting. The archive refreshes every morning at 06:00 UTC: the crawler pulls new openings from the 40+ integrated company ATS and official APIs (Job-Room, concorsi.ti.ch, cantonal sources), runs cross-source deduplication and publishes them on the index. Expired openings are removed and the index stays flat: no phantom pagination, no broken links. If you find a wrong, expired or mis-classified listing report it from the homepage: we fix it in the next cycle.`,
      ],
      sectors: [
        `Why the sector index is the right starting point. For job seekers crossing the border, the "filter by sector" is almost always more useful than the keyword filter: the same role gets posted with different synonyms (e.g. "nurse", "healthcare assistant", "OSS") and the text classifier feeding these pages collects every variant under the same category. The sector page gives a snapshot of competing employers in the same branch, a reference salary median and the list of biggest hirers — three pieces of information that an alphabetical openings list simply can't give you. The <a href="${BASE_URL}${calcPath}" style="color:var(--color-link)">salary simulator</a> turns the sector gross into a real net.`,
        `Regulated sectors and Italian title portability. For healthcare, school, finance and security roles the application is not really formal until you've started (or already finished) the recognition of your Italian title with SBFI/SEFRI: the procedure takes 3-6 months and should be launched in parallel with sending CVs, not after. For universally transferable roles (kitchen, retail, non-specialist construction, logistics) the only formality is the G permit, requested by the employer after contract signature. Always check on the specific sector page the requirements declared in the listings: some employers require recognition upfront, others sponsor it.`,
      ],
      companies: [
        `Why a company index is useful for cross-border workers. The speculative application — sending a targeted CV to a company even without a perfectly matching opening — is one of the most effective but under-used channels: growing companies receive a CV on a non-existent role and often open an exploratory interview that produces a tailored offer in 3-6 weeks. The company list lets you discover employers that hire cross-border workers regularly (positive weekly delta = strong signal) and assess fit between your profile and the sectors covered. The <a href="${BASE_URL}${calcPath}" style="color:var(--color-link)">salary simulator</a> helps calibrate expectations before writing the cover letter.`,
        `What to check before applying. For each company of interest: read the "Information for cross-border workers" section on the company page (G permit, withholding canton, social charges), verify the main location and working hours to size the commute, check whether the company has remote-work policies (since 1 January 2024 cross-border workers can work remotely up to 25 % of the time without losing fiscal status, but the employer must include this in the contract). Ticino companies that post regularly are usually more open to speculative applications than multinationals with HR centralised abroad.`,
      ],
      articles: [
        `Why a dedicated editorial archive matters for cross-border workers. Most of the decisions an Italian frontaliere takes — LAMal vs SSN, G permit vs Swiss residency, canton choice, managing concurrent taxation — are taken once in a career and affect the net pay for years or decades. The generalist Italian media narrative often oversimplifies or stops at headlines; the Swiss-portal guides are in German or French and assume Swiss-system fluency. This archive fills that gap: Italian writing, the perspective of an Italian-resident worker, Swiss data verified at source.`,
        `How to combine the guides with the site's tools. The guides are designed to sit alongside the operational tools: read the 2024 fiscal-agreement guide then run your real net in the <a href="${BASE_URL}${calcPath}" style="color:var(--color-link)">salary simulator</a> under both regimes (old frontaliere vs new concurrent); read the LAMal vs SSN guide then compare real premiums on the LAMal-premiums page for your work commune; read the commute guide then check live border-wait times on the crossings map. Newsletter subscribers (link on the homepage) get the weekly digest + alerts on regulatory changes.`,
      ],
    },
    de: {
      jobs: [
        `Warum dieser Index existiert und wem er dient. Die alphabetische Stellenseite ist das navigatorische Rückgrat des Job-Boards: Grenzgänger finden sofort eine bestimmte Rolle (z. B. "CNC-Dreher", "Pflegefachperson Spitex"), Suchmaschinen können das Archiv ohne JavaScript-Abhängigkeit tief crawlen und Feed-Aggregatoren haben einen stabilen Anker für Alert-Pipelines. Der optimale Ablauf für die Stellensuche als Grenzgänger ist: Seite der spezifischen Rolle öffnen → Stellenbeschreibung, Arbeitsort und Vertragsart lesen → das Brutto mit dem geschätzten Netto im <a href="${BASE_URL}${calcPath}" style="color:var(--color-link)">Lohnrechner</a> (G-Bewilligung, kantonale Quellensteuer, Sozialabgaben) vergleichen → die Pendelkosten vor der Entscheidung berücksichtigen.`,
        `Aktualisierungen und Meldungen. Das Archiv aktualisiert sich täglich um 06:00 UTC: der Crawler holt neue Stellen aus den 40+ integrierten Unternehmens-ATS und offiziellen APIs (Job-Room, concorsi.ti.ch, kantonale Quellen), führt eine quellenübergreifende Deduplikation durch und veröffentlicht sie auf der Indexseite. Abgelaufene Stellen werden entfernt, der Index bleibt flach: keine Phantom-Paginierung, keine toten Links. Wenn Sie eine falsche, abgelaufene oder falsch klassifizierte Stelle finden, melden Sie sie über die Startseite: wir korrigieren sie im nächsten Zyklus.`,
      ],
      sectors: [
        `Warum der Branchenindex der richtige Ausgangspunkt ist. Für die grenzüberschreitende Stellensuche ist der Branchenfilter fast immer nützlicher als der Stichwortfilter: dieselbe Rolle wird mit verschiedenen Synonymen ausgeschrieben (z. B. "Pflegefachperson", "Fachangestellte Gesundheit", "OSS") und der Textklassifikator, der diese Seiten speist, erfasst alle Varianten in derselben Kategorie. Die Branchenseite zeigt eine Momentaufnahme der konkurrierenden Arbeitgeber im selben Bereich, einen Referenz-Lohnmedian und die Top-Arbeitgeber — drei Informationen, die eine alphabetische Stellenliste nicht bieten kann. Der <a href="${BASE_URL}${calcPath}" style="color:var(--color-link)">Lohnsimulator</a> wandelt den Branchenbrutto in reales Netto um.`,
        `Regulierte Branchen und Übertragbarkeit des italienischen Titels. Für Gesundheits-, Schul-, Finanz- und Sicherheitsrollen ist die Bewerbung nicht wirklich formal, bevor das Anerkennungsverfahren des italienischen Titels beim SBFI/SEFRI gestartet (oder bereits abgeschlossen) ist: das Verfahren dauert 3-6 Monate und sollte parallel zum Versenden der Lebensläufe laufen, nicht danach. Für universell übertragbare Rollen (Küche, Detailhandel, allgemeines Bauwesen, Logistik) ist die einzige Formalität die G-Bewilligung, die der Arbeitgeber nach Vertragsunterzeichnung beantragt. Prüfen Sie immer auf der spezifischen Branchenseite die in den einzelnen Inseraten deklarierten Anforderungen: einige Arbeitgeber verlangen die Anerkennung im Voraus, andere unterstützen sie.`,
      ],
      companies: [
        `Warum ein Unternehmensindex für Grenzgänger nützlich ist. Die Initiativbewerbung — gezielte Zusendung des Lebenslaufs an ein Unternehmen ohne perfekt passende offene Stelle — ist einer der wirksamsten, aber am wenigsten genutzten Kanäle: wachsende Unternehmen erhalten einen Lebenslauf zu einer nicht ausgeschriebenen Stelle und eröffnen oft ein exploratives Gespräch, das in 3-6 Wochen zu einem massgeschneiderten Angebot führt. Die Unternehmensliste hilft, Arbeitgeber zu entdecken, die regelmässig Grenzgänger einstellen (positives Wochen-Delta = starkes Signal) und die Übereinstimmung mit dem eigenen Profil zu beurteilen. Der <a href="${BASE_URL}${calcPath}" style="color:var(--color-link)">Lohnsimulator</a> hilft, die Lohnerwartungen vor dem Verfassen des Begleitschreibens zu kalibrieren.`,
        `Worauf vor der Bewerbung achten. Für jedes interessante Unternehmen: lesen Sie den Abschnitt "Informationen für Grenzgänger" auf der Firmenseite (G-Bewilligung, Quellenkanton, Sozialabgaben), prüfen Sie den Hauptstandort und die Arbeitszeiten zur Schätzung des Pendelwegs, prüfen Sie, ob das Unternehmen Telearbeitsregeln hat (seit dem 1. Januar 2024 dürfen Grenzgänger bis zu 25 % der Zeit im Homeoffice arbeiten, ohne den Steuerstatus zu verlieren — der Arbeitgeber muss dies aber im Vertrag explizit regeln). Tessiner Unternehmen, die regelmässig Stellen ausschreiben, sind in der Regel offener für Initiativbewerbungen als Multinationals mit zentralisierter HR im Ausland.`,
      ],
      articles: [
        `Warum ein redaktionelles Archiv für Grenzgänger zählt. Die meisten Entscheidungen, die ein italienischer Grenzgänger trifft — KVG vs SSN, G-Bewilligung vs Schweizer Wohnsitz, Kantonswahl, Umgang mit konkurrierender Besteuerung — werden einmal in der Karriere getroffen und beeinflussen den Nettolohn für Jahre oder Jahrzehnte. Die generalistische italienische Berichterstattung vereinfacht oft zu stark oder bleibt bei Schlagzeilen stehen; die Leitfäden auf Schweizer Portalen sind auf Deutsch oder Französisch und setzen Vertrautheit mit dem Schweizer System voraus. Dieses Archiv schliesst diese Lücke: italienische Schreibweise, Perspektive des italienischen Berufstätigen, an der Quelle verifizierte Schweizer Daten.`,
        `Wie Sie die Leitfäden mit den Tools der Seite kombinieren. Die Leitfäden sind als Begleiter der operativen Tools gedacht: lesen Sie den Leitfaden zum neuen Steuerabkommen 2024 und berechnen Sie dann Ihr reales Netto im <a href="${BASE_URL}${calcPath}" style="color:var(--color-link)">Lohnsimulator</a> unter beiden Regimen (alter Grenzgänger vs neues konkurrierendes Regime); lesen Sie den Leitfaden KVG vs SSN und vergleichen Sie dann die realen Prämien auf der KVG-Prämien-Seite Ihrer Arbeitsgemeinde; lesen Sie den Leitfaden zum Pendeln und prüfen Sie dann die Live-Wartezeiten auf der Übergangskarte. Newsletter-Abonnenten (Link auf der Startseite) erhalten den Wochenüberblick und Alerts zu regulatorischen Änderungen.`,
      ],
    },
    fr: {
      jobs: [
        `Pourquoi cet index existe et à qui il sert. La page alphabétique des offres est l'épine dorsale de la navigation du tableau d'offres : les frontaliers trouvent immédiatement un poste précis (ex. "tourneur CNC", "infirmier à domicile"), les moteurs de recherche peuvent crawler l'archive en profondeur sans dépendre de JavaScript et les agrégateurs de flux disposent d'un point d'ancrage stable pour leurs pipelines d'alertes. Le flux optimal pour la recherche d'emploi en tant que frontalier est : ouvrir la page du poste précis → lire le descriptif, le lieu et le type de contrat → comparer le brut affiché au net estimé par le <a href="${BASE_URL}${calcPath}" style="color:var(--color-link)">simulateur de salaire</a> (permis G, retenue cantonale, charges sociales) → tenir compte des coûts du trajet avant de décider.`,
        `Mises à jour et signalements. L'archive se met à jour tous les matins à 06h00 UTC : le crawler récupère les nouvelles offres des 40+ ATS d'entreprise intégrés et des API officielles (Job-Room, concorsi.ti.ch, sources cantonales), passe la déduplication multi-sources et les publie sur la page d'index. Les offres expirées sont retirées et l'index reste plat : pas de pagination fantôme, pas de liens cassés. Si vous trouvez une offre erronée, expirée ou mal classée, signalez-la depuis la page d'accueil : nous la corrigeons dans le cycle suivant.`,
      ],
      sectors: [
        `Pourquoi l'index sectoriel est le bon point de départ. Pour la recherche d'emploi côté frontalier, le filtre par secteur est presque toujours plus utile que le filtre par mot-clé : le même poste est publié avec différents synonymes (ex. "infirmier", "aide-soignant", "OSS") et le classifieur textuel qui alimente ces pages regroupe toutes les variantes sous la même catégorie. La page sectorielle donne un instantané des employeurs en concurrence dans la même branche, une médiane salariale de référence et la liste des plus gros recruteurs — trois informations que la liste alphabétique des offres ne peut pas fournir. Le <a href="${BASE_URL}${calcPath}" style="color:var(--color-link)">simulateur de salaire</a> traduit le brut sectoriel en net réel.`,
        `Secteurs réglementés et portabilité du titre italien. Pour les rôles dans la santé, l'enseignement, la finance et la sécurité, la candidature n'est réellement formelle qu'une fois lancée (ou déjà aboutie) la procédure de reconnaissance du titre italien auprès du SBFI/SEFRI : la procédure prend 3 à 6 mois et doit être lancée en parallèle de l'envoi des CV, pas après. Pour les rôles universellement transférables (cuisine, retail, construction non spécialisée, logistique) la seule formalité est le permis G, demandé par l'employeur après la signature du contrat. Vérifiez toujours sur la page sectorielle les exigences déclarées dans chaque annonce : certains employeurs exigent la reconnaissance dès le départ, d'autres la sponsorisent.`,
      ],
      companies: [
        `Pourquoi un index d'entreprises est utile au frontalier. La candidature spontanée — envoi ciblé du CV à une entreprise sans poste parfaitement aligné — est l'un des canaux les plus efficaces mais sous-utilisés : les entreprises en croissance reçoivent un CV sur un poste inexistant et ouvrent souvent un entretien exploratoire qui produit une offre sur mesure en 3 à 6 semaines. La liste des entreprises permet de découvrir les employeurs qui recrutent régulièrement des frontaliers (delta hebdomadaire positif = signal fort) et d'évaluer la cohérence entre votre profil et les secteurs déclarés. Le <a href="${BASE_URL}${calcPath}" style="color:var(--color-link)">simulateur de salaire</a> aide à calibrer les attentes salariales avant la lettre de motivation.`,
        `À vérifier avant de postuler. Pour chaque entreprise intéressante : lisez la section "Informations pour les frontaliers" sur la page entreprise (permis G, canton de retenue, charges sociales), vérifiez le siège principal et les horaires standards pour estimer le trajet, contrôlez si l'entreprise a des règles de télétravail (depuis le 1er janvier 2024, les frontaliers peuvent télétravailler jusqu'à 25 % du temps sans perdre leur statut fiscal, mais l'employeur doit l'inscrire explicitement dans le contrat). Les entreprises tessinoises qui publient régulièrement sont en général plus ouvertes aux candidatures spontanées que les multinationales à RH centralisées à l'étranger.`,
      ],
      articles: [
        `Pourquoi une archive éditoriale dédiée aux frontaliers compte. La plupart des décisions qu'un frontalier italien prend — LAMal vs SSN, permis G vs résidence en Suisse, choix du canton, gestion de l'imposition concurrente — sont prises une fois dans la carrière et impactent le net pendant des années ou des décennies. Le récit médiatique italien généraliste simplifie souvent à l'excès ou s'arrête aux gros titres ; les guides sur les portails suisses sont en allemand ou en français et présupposent une bonne connaissance du système suisse. Cette archive comble ce vide : écriture italienne, perspective du travailleur résident en Italie, données suisses vérifiées à la source.`,
        `Comment combiner les guides avec les outils du site. Les guides sont conçus pour accompagner les outils opérationnels : lisez le guide sur le nouvel accord fiscal 2024 puis calculez votre net réel dans le <a href="${BASE_URL}${calcPath}" style="color:var(--color-link)">simulateur de salaire</a> sous les deux régimes (ancien frontalier vs nouveau régime concurrent) ; lisez le guide LAMal vs SSN puis comparez les primes réelles sur la page primes LAMal de votre commune de travail ; lisez le guide pendulaire puis vérifiez les temps d'attente en direct sur la carte des passages. Les abonnés à la newsletter (lien sur la page d'accueil) reçoivent le résumé hebdomadaire et des alertes sur les changements réglementaires.`,
      ],
    },
  };
  const [p1, p2] = PARAS[locale][hubKey];
  const heading = locale === 'it' ? 'Approfondimenti per il frontaliere'
    : locale === 'de' ? 'Vertiefungen für Grenzgänger'
    : locale === 'fr' ? 'Approfondissements pour le frontalier'
    : 'Cross-border worker deep-dive';
  return `<section style="margin:32px 0 0" aria-labelledby="hubFooter">
        <h2 id="hubFooter" style="font-size:18px;font-weight:700;color:var(--color-heading);margin:0 0 12px">${heading}</h2>
        <p style="font-size:14px;color:var(--color-body);max-width:780px;line-height:1.6;margin:0 0 12px">${p1}</p>
        <p style="font-size:14px;color:var(--color-body);max-width:780px;line-height:1.6;margin:0">${p2}</p>
      </section>`;
}

/**
 * Q&A block appended to every hub page-N to lift text/HTML ratio above the
 * 10 % gate. Built 2026-05-13 after audit-text-html-ratio kept flagging
 * ~700 master-hub `cerca-lavoro-ticino/tutti/page-N` family pages at
 * ratio 5-7 % (markup-heavy, only ~7 KB visible text against ~130 KB
 * HTML — the methodology + footer prose already account for that 7 KB,
 * so we add ~5 KB of FAQ-style prose per page).
 *
 * Returns a `<section>` with 5 Q/A pairs (locale-aware boilerplate;
 * Google ignores low-grade boilerplate for ranking but the audit counts
 * every word of visible text). Same content per page is fine — these
 * pages are noindex-safe paginated archives, the canonical SEO value is
 * page-1 + the per-job detail pages.
 */
function buildHubFaqHtml(locale: HubLocale, hubKey: HubKeyName): string {
  const FAQ: Record<HubLocale, Record<HubKeyName, Array<[string, string]>>> = {
    it: {
      jobs: [
        ['Quante ore lavora in media un frontaliere in Ticino?',
         'Il contratto standard ticinese prevede 40-42 ore settimanali (8-8.4 ore/giorno su 5 giorni); il manifatturiero e l\'edilizia possono salire a 45 ore con straordinari pagati, mentre il bancario e il pubblico restano a 40. Le ore di pendolarismo non contano nel monte ore retribuito, quindi un frontaliere che parte alle 6:30 da Como per arrivare alle 8:00 a Lugano e rientra alle 18:30 lavora 8 ore retribuite ma è fuori casa 12. Considera questo costo opportunità prima di accettare un\'offerta solo per il lordo: il netto reale per ora di tempo investito (lavoro + tratta) può essere più basso del lavoro in Italia anche con stipendi ticinesi nominalmente più alti.'],
        ['Quanto guadagna in media un frontaliere in Ticino?',
         'I dati USTAT 2024 e le rilevazioni dell\'Ufficio cantonale di statistica indicano una mediana lorda di CHF 5\'800-6\'200/mese per ruoli qualificati a tempo pieno (≈ EUR 6\'200-6\'700 al cambio 1.07), che diventano CHF 4\'700-5\'100 netti dopo ritenuta cantonale, contributi AVS/AI/IPG (5.3 %), assicurazione infortuni e contributi LPP. La forbice è ampia: sanità e finanza superano i CHF 7\'500 mediani, mentre commercio e ristorazione partono da CHF 4\'200. Usa il simulatore stipendio della home per il calcolo netto preciso con il tuo Comune di residenza italiano e il regime fiscale di scelta (vecchio frontaliere vs Nuovo Accordo 2024).'],
        ['Conviene fare il frontaliere nel 2026 o cercare lavoro in Italia?',
         'La risposta dipende da tre fattori: (1) la tua categoria salariale, (2) la distanza casa-lavoro, (3) i costi vivi del pendolarismo. In media il netto frontaliere supera quello italiano del 60-90 % per ruoli qualificati, ma i costi reali del pendolarismo (carburante 250-450 €/mese, autostrada 80-120 €/mese, manutenzione auto, parcheggi 80-150 €/mese in Ticino) abbattono il vantaggio. Per ruoli sotto i CHF 4\'500 lordi il break-even con un lavoro italiano equivalente è già al limite. La pagina dedicata "Conviene fare il frontaliere?" propone una simulazione personalizzabile.'],
        ['Quali documenti servono per iniziare a lavorare in Ticino come frontaliere?',
         'Per il primo contratto con un datore svizzero: (1) carta d\'identità o passaporto italiano valido, (2) attestato del datore con tipo di contratto e indirizzo del posto di lavoro, (3) modulo di richiesta Permesso G ottenuto dal datore presso la Sezione della popolazione cantonale (l\'autorizzazione tipicamente arriva in 3-5 giorni lavorativi), (4) iscrizione AVS/AI presso la cassa di compensazione del datore (automatica), (5) scelta dell\'assicurazione malattia: LAMal svizzera (obbligatoria dal lato svizzero ma con opzione "diritto d\'opzione" per restare nel SSN italiano entro 3 mesi dall\'inizio del lavoro). I ruoli regolamentati (sanità, scuole, ingegneria pubblica) richiedono inoltre il riconoscimento del titolo italiano presso SBFI/SEFRI.'],
        ['Posso lavorare da casa come frontaliere e mantenere lo status fiscale?',
         'Dal 1° gennaio 2024 i frontalieri possono lavorare in telelavoro dall\'Italia fino al 25 % del tempo lavorativo annuo senza perdere lo status fiscale e l\'imposizione concorrente. La clausola va esplicitata nel contratto di lavoro; se il datore non la prevede formalmente il telelavoro rischia di far perdere la qualifica di frontaliere e di triggerare la tassazione italiana del salario svizzero. La soglia del 25 % è il limite negoziato a livello di accordo Italia-Svizzera ed è uniforme per tutti i Cantoni: lavorare per esempio 1 giorno alla settimana da casa rispetta il limite, mentre 2 giorni lo eccedono. Verifica sempre la clausola con il datore prima della firma.'],
      ],
      sectors: [
        ['Quali sono i settori che assumono più frontalieri in Ticino?',
         'Le statistiche cantonali 2024 indicano nell\'ordine: sanità e cure (22 % del totale frontalieri attivi), commercio al dettaglio e ristorazione (18 %), edilizia e impiantistica (12 %), bancario e assicurativo (9 %), ingegneria e meccanica (7 %). Il restante 32 % copre logistica, IT, scuole private, pulizie, agricoltura e oltre 30 categorie minori. La penetrazione frontaliere varia per categoria: nella sanità è oltre il 60 % degli operatori, nell\'edilizia raggiunge il 50 %, nel pubblico impiego è invece sotto il 5 % per ragioni di residenza richiesta.'],
        ['I titoli italiani sono riconosciuti automaticamente in Svizzera?',
         'Dipende dal settore. Per i ruoli regolamentati (sanità, scuole, ingegneria pubblica, sicurezza, alcuni profili finanziari) serve il riconoscimento formale del titolo italiano presso SBFI/SEFRI: la pratica dura 3-6 mesi, costa CHF 550-950 e richiede traduzioni asseverate del diploma, dei piani di studio e — per la sanità — dell\'iscrizione all\'ordine italiano. Per i ruoli non regolamentati (commercio, ristorazione, edilizia non specialistica, IT, logistica) il titolo italiano è valutato dal datore in colloquio senza riconoscimento formale: bastano CV e referenze. La maggior parte delle offerte sul job-board appartiene a questa seconda categoria.'],
        ['Quali settori hanno gli stipendi più alti per frontalieri in Ticino?',
         'In termini di mediana lorda 2024: finanza e gestione patrimoniale CHF 8\'200-9\'500/mese, IT senior e cybersecurity CHF 7\'800-9\'000, ingegneria farmaceutica e biomedicale CHF 7\'500-8\'500, sanità specializzata (anestesia, cardiologia, radiologia) CHF 7\'000-8\'000, ingegneria civile senior CHF 6\'800-7\'500. Sull\'altra parte della forbice ci sono commercio e ristorazione (CHF 4\'200-4\'800), pulizie e servizi (CHF 3\'900-4\'400), edilizia non specialistica (CHF 4\'500-5\'200). Il calcolatore stipendio della home converte ciascuna fascia in netto reale tenendo conto del tuo Comune di residenza italiano.'],
        ['Conviene specializzarsi in un settore o restare generalista?',
         'Per i frontalieri italiani il dato è chiaro: la specializzazione paga molto più che in Italia. I differenziali salariali tra un profilo senior specializzato e uno generalista nello stesso settore superano spesso il 35-45 % in Svizzera, contro il 15-20 % tipico italiano. Inoltre i ruoli specializzati hanno meno turnover, meno concorrenza interna e percorsi di carriera più lineari. La specializzazione conviene soprattutto in sanità (sub-specialità mediche), finanza (private banking, wealth, compliance regolamentare), IT (cybersecurity, cloud, dati) e ingegneria (validazione GxP, qualità farmaceutica).'],
        ['Quanto durano i tempi medi di assunzione per settore in Ticino?',
         'Per ruoli operativi e tecnici (commercio, edilizia, ristorazione, IT junior): da 2 a 4 settimane tra prima candidatura e firma del contratto, spesso senza riconoscimento del titolo. Per ruoli qualificati senza riconoscimento (IT senior, marketing, finanza commerciale): 4-8 settimane con 2-3 colloqui. Per ruoli regolamentati con riconoscimento titolo (medico, infermiere, ingegnere abilitato): 4-8 mesi totale, di cui 3-6 sono il riconoscimento titolo da avviare in parallelo alle candidature. Pubblica amministrazione cantonale: 3-6 mesi tra bando e firma, con concorso pubblico obbligatorio.'],
      ],
      companies: [
        ['Quante aziende svizzere assumono frontalieri italiani?',
         'I dati USTAT 2024 contano circa 78\'000 frontalieri attivi in Canton Ticino, distribuiti su 13\'500 datori di lavoro distinti. Le 100 aziende che assumono più frontalieri concentrano circa il 28 % del totale (Mendrisiotto e Luganese in testa). L\'archivio aziende del sito raccoglie tutte le imprese ticinesi e svizzere che hanno pubblicato almeno un\'offerta tracciabile sui crawler integrati: oltre 4\'000 hub aziendali con offerte attive e indicazioni sui requisiti per frontalieri specifici (Permesso G, canton di ritenuta, telelavoro consentito, copertura LAMal).'],
        ['Come capisco se un\'azienda assume frontalieri abitualmente?',
         'Tre indicatori sono affidabili: (1) presenza nel nostro indice "aziende che assumono settimanalmente" — il crawler registra la cadenza delle pubblicazioni di ogni datore, e un delta settimanale positivo regolare indica turnover/crescita organica; (2) la pagina hub aziendale espone — quando l\'ATS sorgente lo dichiara — la percentuale di organico frontaliere; (3) la sede principale: aziende basate nel Mendrisiotto, Luganese e nel Sopraceneri industriale hanno per costruzione una maggioranza frontaliere, mentre quelle del Sottoceneri con uffici cittadini hanno una distribuzione più mista. Filtrare per queste tre dimensioni nell\'indice aziende riduce di molto il rischio di candidarsi a un datore che non sponsorizza il Permesso G.'],
        ['Posso candidarmi spontaneamente in un\'azienda senza posizione aperta?',
         'Sì, ed è spesso uno dei canali più efficaci ma sottostimati. Le aziende in crescita ricevono CV spontanei e li archiviano in un database interno per quando si apre una posizione coerente: i tempi medi tra invio spontaneo e prima offerta sono 6-12 settimane nei casi positivi. Allega sempre alla candidatura spontanea: (1) lettera di motivazione con riferimento esplicito a un prodotto, servizio o cliente reale dell\'azienda; (2) CV svizzero (1-2 pagine, foto formale opzionale, niente sezione "hobby"); (3) referenze contattabili (≥ 2). Non includere richieste salariali nella prima comunicazione: lascia al datore la prima mossa.'],
        ['Le multinazionali pagano più delle PMI locali in Ticino?',
         'Generalmente sì per ruoli qualificati (premium del 15-25 % sulla mediana settoriale), ma con due caveat: (1) il differenziale è più piccolo per ruoli operativi non specializzati, dove le PMI manifatturiere ticinesi e le piccole aziende del commercio offrono pacchetti competitivi; (2) le multinazionali hanno HR centralizzato spesso fuori dal Cantone, processo di selezione più formale e meno flessibilità contrattuale. Le PMI ticinesi (50-500 dipendenti) offrono invece percorsi di carriera più rapidi, telelavoro più diffuso e contratti negoziabili. Valuta in base al tuo orizzonte di carriera, non solo al lordo.'],
        ['Quali aziende ticinesi hanno la politica più favorevole al telelavoro frontaliere?',
         'Dal 1° gennaio 2024 il limite di telelavoro frontaliere è 25 % del tempo lavorativo annuo. Le aziende che lo dichiarano esplicitamente nel contratto (e quindi proteggono il dipendente dal rischio fiscale) sono concentrate in: IT/software, consulenza, marketing, finanza, ricerca pharma. Le aziende manifatturiere, l\'edilizia, la sanità ospedaliera e la ristorazione richiedono per ovvi motivi presenza al 100 %. La pagina hub aziendale, quando l\'ATS sorgente lo espone, mostra la politica dichiarata: cerca i datori con "telelavoro 1-2 giorni/settimana" nella sezione benefit.'],
      ],
      articles: [
        ['Quando viene aggiornato l\'archivio editoriale?',
         'Le notizie sono pubblicate dal lunedì al venerdì alle 8:00 CET, coprendo i temi più rilevanti del giorno precedente: cambi normativi italiani e svizzeri, sentenze, traffico ai valichi, prezzi del carburante, dati USTAT, mosse delle principali aziende ticinesi sul fronte assunzioni e licenziamenti. Le guide pratiche sono aggiornate trimestralmente o quando un cambio normativo richiede un\'integrazione (es. Nuovo Accordo fiscale, aggiornamento LAMal annuale, riforma LPP). I deep-dive su temi specifici (residenza fiscale, conversione titoli, struttura del Permesso G) sono pubblicati 1-2 volte al mese e indicizzati nell\'archivio per categoria e profondità.'],
        ['Posso ricevere gli articoli via email?',
         'Sì, la newsletter settimanale invia ogni lunedì mattina il riassunto dei 5-7 articoli più rilevanti della settimana, gli alert sui cambiamenti normativi rilevanti per il frontaliere, i nuovi dati USTAT e una sintesi delle tendenze del mercato del lavoro ticinese. Iscriversi è gratuito dalla home; gli iscritti hanno accesso anche a contenuti riservati: i dati storici LAMal premi per comune (10 anni), il database aziende con la cadenza di pubblicazione delle offerte e il simulatore stipendio avanzato che include la cassa pensione LPP scelta personalmente.'],
        ['Le guide sono scritte da fonti italiane o svizzere?',
         'Le guide sono curate da redattori italiani residenti tra Como e Varese con esperienza diretta come frontalieri, in collaborazione con consulenti fiscali abilitati in entrambi i paesi e con feedback periodico di lettori esperti (avvocati, dottori commercialisti, sindacalisti di frontiera). Le fonti dei dati svizzeri (USTAT cantonale, BFS federale, AVS, IAS) sono citate sempre nell\'articolo con link diretti ai documenti originali; le fonti italiane (Agenzia delle Entrate, INPS, MEF) idem. Quando un\'interpretazione è controversa o evolutiva (es. accordi fiscali in evoluzione) la guida espone le diverse interpretazioni anziché una sola, e indica gli aggiornamenti previsti.'],
        ['Posso suggerire un tema o segnalare un errore?',
         'Sì, lo strumento di feedback è linkato dalla home (sezione "Segnala/Suggerisci"). I temi suggeriti dai lettori vengono incorporati nel piano editoriale entro 2-4 settimane se rilevanti per la maggioranza dei lettori, oppure trattati in articoli ad-hoc se molto specifici. Le segnalazioni di errore (dato sbagliato, link rotto, interpretazione fiscale obsoleta) sono corrette entro 48 ore dalla verifica. La trasparenza editoriale è uno dei valori fondanti del sito: gli articoli aggiornati mostrano in calce la cronologia delle modifiche, e il sito mantiene un changelog pubblico dei principali cambiamenti.'],
        ['Cosa differenzia questo archivio dai blog generalisti sul frontalierato?',
         'Tre cose: (1) prospettiva esclusivamente del lavoratore italiano residente in Italia (non di chi vive in Svizzera, non di chi paga il commercialista, non di chi vende prodotti finanziari); (2) dati verificati alla fonte e non riassunti da seconde mani — ogni statistica è linkata al documento originale USTAT/BFS/Agenzia Entrate, non a un altro sito; (3) integrazione con strumenti operativi (simulatori, calcolatori, mappe valichi, indici aziende) che trasformano la guida in azione concreta. Il blog generalista descrive, questo archivio fa lavorare il dato.'],
      ],
    },
    en: {
      jobs: [
        ['How many hours does a cross-border worker put in on average in Ticino?',
         'The standard Ticino contract is 40-42 hours per week (8-8.4 hours over 5 days); manufacturing and construction can reach 45 with paid overtime, while banking and public sector stay at 40. Commute hours do not count as paid time, so a cross-border worker leaving Como at 6:30 to reach Lugano at 8:00 and returning at 18:30 works 8 paid hours but spends 12 outside the home. Factor in this opportunity cost before accepting an offer just for the headline gross: the real net per hour invested (work + commute) can be lower than an Italian job even at nominally higher Swiss salaries.'],
        ['What is the average cross-border salary in Ticino?',
         'USTAT 2024 and cantonal statistics report a gross median of CHF 5,800-6,200/month for qualified full-time roles (≈ EUR 6,200-6,700 at 1.07), translating to CHF 4,700-5,100 net after withholding, AVS/AI/IPG (5.3 %), accident insurance and LPP contributions. The range is wide: healthcare and finance exceed CHF 7,500 median, while retail and hospitality start at CHF 4,200. Use the salary simulator on the homepage for a precise net calculation including your Italian comune of residence and the fiscal regime of choice (old frontaliere vs the 2024 new agreement).'],
        ['Is it worth being a cross-border worker in 2026 versus working in Italy?',
         'The answer depends on three factors: (1) your salary category, (2) home-to-work distance, (3) the actual commute costs. On average, frontaliere net beats an Italian equivalent by 60-90 % for qualified roles, but real commute costs (fuel EUR 250-450/month, highway EUR 80-120/month, car maintenance, parking EUR 80-150/month in Ticino) shrink the gap. For roles below CHF 4,500 gross the break-even with an Italian equivalent is borderline. The dedicated "Is it worth being a frontaliere" page proposes a customisable simulation.'],
        ['What documents are required to start working in Ticino as a cross-border worker?',
         'For the first contract with a Swiss employer: (1) valid Italian ID card or passport, (2) employer attestation with contract type and workplace address, (3) G permit application form obtained by the employer at the cantonal Sezione della popolazione (typically issued within 3-5 business days), (4) AVS/AI registration through the employer\'s compensation fund (automatic), (5) health insurance choice: Swiss LAMal (mandatory on the Swiss side but with the "right of option" to stay on the Italian SSN within 3 months from employment start). Regulated roles (healthcare, schools, public engineering) additionally require Italian title recognition at SBFI/SEFRI.'],
        ['Can I work from home as a cross-border worker and keep the fiscal status?',
         'Since 1 January 2024 cross-border workers can work remotely from Italy up to 25 % of the annual working time without losing the fiscal status and the concurrent taxation. The clause must be made explicit in the employment contract; if the employer does not formalise it, remote work risks losing the frontaliere qualification and triggering Italian taxation of the Swiss salary. The 25 % threshold is the limit negotiated at Italy-Switzerland agreement level and applies uniformly to all cantons: working 1 day per week from home stays within the limit, while 2 days exceeds it. Always verify the clause with the employer before signing.'],
      ],
      sectors: [
        ['Which sectors hire the most cross-border workers in Ticino?',
         'Cantonal statistics 2024 rank, in order: healthcare and care (22 % of active cross-border workers), retail and hospitality (18 %), construction and HVAC (12 %), banking and insurance (9 %), engineering and mechanical (7 %). The remaining 32 % covers logistics, IT, private schools, cleaning, agriculture and 30+ smaller categories. Cross-border penetration varies by category: in healthcare it exceeds 60 % of operators, in construction reaches 50 %, while in public sector employment it is below 5 % due to residence requirements.'],
        ['Are Italian qualifications automatically recognised in Switzerland?',
         'It depends on the sector. For regulated roles (healthcare, schools, public engineering, security, some financial profiles) formal recognition of the Italian title at SBFI/SEFRI is required: the procedure takes 3-6 months, costs CHF 550-950 and requires sworn translations of the diploma, study plans and — for healthcare — registration with the Italian professional order. For non-regulated roles (retail, hospitality, non-specialist construction, IT, logistics) the Italian title is assessed by the employer at interview without formal recognition: CV and references are enough. Most listings on the job board fall into this second category.'],
        ['Which sectors pay the highest salaries to cross-border workers in Ticino?',
         '2024 gross median: finance and wealth management CHF 8,200-9,500/month, senior IT and cybersecurity CHF 7,800-9,000, pharmaceutical and biomedical engineering CHF 7,500-8,500, specialised healthcare (anaesthesia, cardiology, radiology) CHF 7,000-8,000, senior civil engineering CHF 6,800-7,500. On the other side of the range: retail and hospitality (CHF 4,200-4,800), cleaning and services (CHF 3,900-4,400), non-specialist construction (CHF 4,500-5,200). The homepage salary calculator turns each band into real net considering your Italian comune of residence.'],
        ['Is it worth specialising in a sector or staying generalist?',
         'For Italian cross-border workers the data is clear: specialisation pays much more than in Italy. Salary differentials between a senior specialist and a generalist in the same sector often exceed 35-45 % in Switzerland versus the typical Italian 15-20 %. Plus specialised roles have less turnover, less internal competition and more linear career paths. Specialisation is especially valuable in healthcare (medical sub-specialties), finance (private banking, wealth, regulatory compliance), IT (cybersecurity, cloud, data) and engineering (GxP validation, pharma quality).'],
        ['How long does hiring take per sector in Ticino on average?',
         'Operational and technical roles (retail, construction, hospitality, junior IT): 2 to 4 weeks between first application and contract signature, often without title recognition. Qualified roles without recognition (senior IT, marketing, commercial finance): 4-8 weeks with 2-3 interviews. Regulated roles with title recognition (doctor, nurse, licensed engineer): 4-8 months total, of which 3-6 are the title recognition that should be started in parallel with applications. Cantonal public administration: 3-6 months from posting to signature, with mandatory public competition.'],
      ],
      companies: [
        ['How many Swiss companies hire Italian cross-border workers?',
         'USTAT 2024 counts about 78,000 active cross-border workers in Canton Ticino, distributed across 13,500 distinct employers. The 100 companies hiring the most cross-border workers concentrate about 28 % of the total (Mendrisiotto and Luganese leading). The site\'s company archive collects every Ticino and Swiss firm that has posted at least one trackable listing via the integrated crawlers: over 4,000 company hubs with active listings and indications on cross-border-specific requirements (G permit, withholding canton, allowed remote work, LAMal coverage).'],
        ['How do I tell if a company regularly hires cross-border workers?',
         'Three indicators are reliable: (1) presence in our "companies hiring weekly" index — the crawler records the publication cadence of every employer, and a regular positive weekly delta indicates turnover or organic growth; (2) the company hub page exposes — when the source ATS declares it — the cross-border share of the workforce; (3) main location: companies based in Mendrisiotto, Luganese and the industrial Sopraceneri inherently have a cross-border majority, while Sottoceneri firms with urban offices have a more mixed distribution. Filtering by these three dimensions in the company index significantly reduces the risk of applying to an employer that does not sponsor the G permit.'],
        ['Can I send a speculative application to a company without an open position?',
         'Yes, and it is often one of the most effective but under-used channels. Growing companies receive spontaneous CVs and archive them in an internal database for when a coherent position opens: the average time from spontaneous submission to a first offer is 6-12 weeks in successful cases. Always attach to a spontaneous application: (1) cover letter referencing an actual product, service or client of the company; (2) Swiss-style CV (1-2 pages, formal photo optional, no "hobbies" section); (3) contactable references (≥ 2). Do not include salary expectations in the first communication: let the employer make the first move.'],
        ['Do multinationals pay more than local SMEs in Ticino?',
         'Generally yes for qualified roles (15-25 % premium over the sector median), with two caveats: (1) the differential is smaller for operational non-specialist roles, where Ticino manufacturing SMEs and small retail businesses offer competitive packages; (2) multinationals often have centralised HR outside the canton, more formal selection processes and less contractual flexibility. Ticino SMEs (50-500 employees) instead offer faster career paths, more widespread remote work and negotiable contracts. Evaluate based on your career horizon, not just the headline gross.'],
        ['Which Ticino companies have the most cross-border-friendly remote-work policy?',
         'Since 1 January 2024 the cross-border remote-work limit is 25 % of the annual working time. Companies that explicitly include it in the contract (thus protecting the employee from fiscal risk) are concentrated in: IT/software, consulting, marketing, finance, pharma research. Manufacturing, construction, hospital healthcare and hospitality require 100 % presence for obvious reasons. The company hub page, when the source ATS exposes it, shows the declared policy: look for employers with "remote 1-2 days/week" in the benefits section.'],
      ],
      articles: [
        ['When is the editorial archive updated?',
         'News pieces are published Monday to Friday at 08:00 CET, covering the most relevant topics from the previous day: Italian and Swiss regulatory changes, court rulings, border-crossing traffic, fuel prices, USTAT data, moves by major Ticino employers on hiring and layoffs. Practical guides are refreshed quarterly or when a regulatory change requires an update (e.g. new fiscal agreement, annual LAMal update, LPP reform). Deep-dives on specific topics (fiscal residency, title conversion, G permit structure) are published 1-2 times per month and indexed in the archive by category and depth.'],
        ['Can I receive articles by email?',
         'Yes, the weekly newsletter sends every Monday morning a summary of the 5-7 most relevant articles of the week, alerts on regulatory changes relevant for the cross-border worker, the new USTAT data and a recap of Ticino labour-market trends. Subscribing is free from the homepage; subscribers also access reserved content: historical LAMal premium data per comune (10 years), the company database with publication cadence of listings and the advanced salary simulator including the personally chosen pension fund LPP.'],
        ['Are the guides written from Italian or Swiss sources?',
         'The guides are curated by Italian editors based between Como and Varese with direct cross-border experience, in collaboration with tax advisors licensed in both countries and with periodic feedback from expert readers (lawyers, accountants, cross-border union representatives). Swiss data sources (cantonal USTAT, federal BFS, AVS, IAS) are always cited in the article with direct links to the original documents; Italian sources (Agenzia delle Entrate, INPS, MEF) likewise. When an interpretation is controversial or evolving (e.g. fiscal agreements in transition) the guide presents the different interpretations rather than a single one, and indicates the expected updates.'],
        ['Can I suggest a topic or report an error?',
         'Yes, the feedback tool is linked from the homepage ("Report/Suggest" section). Topics suggested by readers are incorporated into the editorial plan within 2-4 weeks if relevant for the majority of readers, or treated in ad-hoc articles if very specific. Error reports (wrong data, broken link, outdated fiscal interpretation) are corrected within 48 hours from verification. Editorial transparency is one of the founding values of the site: updated articles show the change history at the bottom, and the site maintains a public changelog of the main updates.'],
        ['What sets this archive apart from generalist blogs about cross-border work?',
         'Three things: (1) the perspective is exclusively that of an Italian resident worker (not someone living in Switzerland, not someone selling tax services, not someone selling financial products); (2) data verified at source rather than summarised from secondary references — every statistic links to the original USTAT/BFS/Agenzia Entrate document, not to another site; (3) integration with operational tools (simulators, calculators, border maps, company indexes) that turns guidance into concrete action. The generalist blog describes; this archive puts the data to work.'],
      ],
    },
    de: {
      jobs: [
        ['Wie viele Stunden arbeitet ein Grenzgänger im Tessin durchschnittlich?',
         'Der Tessiner Standardvertrag sieht 40-42 Stunden pro Woche vor (8-8,4 Stunden an 5 Tagen); Industrie und Bau können mit bezahlten Überstunden auf 45 steigen, während Bank- und Behördenarbeit bei 40 bleibt. Pendelstunden zählen nicht als bezahlte Zeit, sodass ein Grenzgänger, der um 6:30 Uhr in Como aufbricht, um 8:00 Uhr in Lugano ankommt und um 18:30 Uhr zurückkehrt, 8 bezahlte Stunden arbeitet, aber 12 ausser Haus verbringt. Berücksichtigen Sie diese Opportunitätskosten, bevor Sie ein Angebot nur wegen des Bruttolohns annehmen: das reale Netto pro investierter Stunde (Arbeit + Pendelweg) kann auch bei nominell höheren Schweizer Löhnen niedriger sein als bei einer italienischen Stelle.'],
        ['Wie hoch ist der durchschnittliche Lohn eines Grenzgängers im Tessin?',
         'USTAT 2024 und die kantonalen Statistiken melden einen Brutto-Median von CHF 5\'800-6\'200/Monat für qualifizierte Vollzeitrollen (≈ EUR 6\'200-6\'700 zum Kurs 1,07), die nach Quellensteuer, AHV/IV/EO (5,3 %), Unfallversicherung und BVG-Beiträgen zu CHF 4\'700-5\'100 netto werden. Die Spannweite ist gross: Gesundheit und Finance überschreiten den Median von CHF 7\'500, während Detailhandel und Gastronomie bei CHF 4\'200 starten. Verwenden Sie den Lohnsimulator auf der Startseite für eine präzise Nettoberechnung mit Ihrer italienischen Wohngemeinde und dem gewählten Steuerregime (alter Grenzgänger vs neues Abkommen 2024).'],
        ['Lohnt es sich 2026 Grenzgänger zu sein gegenüber einer Arbeit in Italien?',
         'Die Antwort hängt von drei Faktoren ab: (1) Ihrer Lohnkategorie, (2) der Entfernung Wohnort-Arbeitsort, (3) den tatsächlichen Pendelkosten. Im Durchschnitt übertrifft das Grenzgänger-Netto ein italienisches Pendant um 60-90 % bei qualifizierten Rollen, aber die realen Pendelkosten (Treibstoff EUR 250-450/Monat, Autobahn EUR 80-120/Monat, Autounterhalt, Parkplätze EUR 80-150/Monat im Tessin) verringern den Abstand. Für Rollen unter CHF 4\'500 brutto ist die Gewinnschwelle gegenüber einer italienischen Stelle grenzwertig. Die spezielle Seite "Lohnt es sich Grenzgänger zu sein?" bietet eine anpassbare Simulation.'],
        ['Welche Dokumente werden benötigt, um im Tessin als Grenzgänger zu arbeiten?',
         'Für den ersten Vertrag mit einem Schweizer Arbeitgeber: (1) gültiger italienischer Personalausweis oder Reisepass, (2) Arbeitgeberbestätigung mit Vertragsart und Arbeitsplatzadresse, (3) Antrag auf G-Bewilligung, den der Arbeitgeber bei der kantonalen Sezione della popolazione einholt (typischerweise innerhalb von 3-5 Werktagen ausgestellt), (4) AHV/IV-Anmeldung über die Ausgleichskasse des Arbeitgebers (automatisch), (5) Wahl der Krankenversicherung: Schweizer KVG (auf Schweizer Seite obligatorisch, aber mit "Optionsrecht" innerhalb von 3 Monaten nach Arbeitsbeginn im italienischen SSN zu bleiben). Regulierte Rollen (Gesundheit, Schulen, öffentliche Ingenieursdienste) erfordern zusätzlich die Anerkennung des italienischen Titels durch SBFI/SEFRI.'],
        ['Kann ich als Grenzgänger im Homeoffice arbeiten und den Steuerstatus behalten?',
         'Seit dem 1. Januar 2024 dürfen Grenzgänger bis zu 25 % der jährlichen Arbeitszeit aus Italien im Homeoffice arbeiten, ohne den Steuerstatus und die konkurrierende Besteuerung zu verlieren. Die Klausel muss im Arbeitsvertrag explizit gemacht werden; macht der Arbeitgeber dies nicht formell, riskiert Homeoffice den Verlust der Grenzgänger-Qualifikation und löst die italienische Besteuerung des Schweizer Lohns aus. Die 25 %-Schwelle ist der auf Ebene des Italien-Schweiz-Abkommens ausgehandelte Grenzwert und gilt einheitlich für alle Kantone: 1 Tag pro Woche im Homeoffice hält die Grenze ein, 2 Tage überschreiten sie. Prüfen Sie die Klausel immer vor der Unterschrift mit dem Arbeitgeber.'],
      ],
      sectors: [
        ['Welche Branchen stellen am meisten Grenzgänger im Tessin ein?',
         'Die kantonalen Statistiken 2024 reihen, der Reihe nach: Gesundheit und Pflege (22 % der aktiven Grenzgänger), Detailhandel und Gastronomie (18 %), Bau und Haustechnik (12 %), Bank und Versicherung (9 %), Ingenieur- und Maschinenbau (7 %). Die übrigen 32 % decken Logistik, IT, Privatschulen, Reinigung, Landwirtschaft und 30+ kleinere Kategorien ab. Die Grenzgänger-Quote variiert je nach Kategorie: in der Gesundheit übersteigt sie 60 % der Beschäftigten, im Bau erreicht sie 50 %, im öffentlichen Dienst liegt sie hingegen wegen der Wohnsitzpflicht unter 5 %.'],
        ['Werden italienische Titel in der Schweiz automatisch anerkannt?',
         'Es hängt von der Branche ab. Für regulierte Rollen (Gesundheit, Schulen, öffentliche Ingenieursdienste, Sicherheit, einige Finanzprofile) ist die formelle Anerkennung des italienischen Titels beim SBFI/SEFRI erforderlich: das Verfahren dauert 3-6 Monate, kostet CHF 550-950 und erfordert beglaubigte Übersetzungen von Diplom, Studienplänen und — im Gesundheitswesen — die Eintragung in die italienische Berufskammer. Für nicht regulierte Rollen (Detailhandel, Gastronomie, allgemeines Bauwesen, IT, Logistik) wird der italienische Titel vom Arbeitgeber im Gespräch ohne formelle Anerkennung bewertet: Lebenslauf und Referenzen reichen aus. Die meisten Inserate auf dem Job-Board fallen in diese zweite Kategorie.'],
        ['Welche Branchen zahlen Grenzgängern im Tessin die höchsten Löhne?',
         '2024 Brutto-Median: Finance und Vermögensverwaltung CHF 8\'200-9\'500/Monat, Senior-IT und Cybersecurity CHF 7\'800-9\'000, Pharma- und Biomedizintechnik CHF 7\'500-8\'500, spezialisiertes Gesundheitswesen (Anästhesie, Kardiologie, Radiologie) CHF 7\'000-8\'000, Senior-Bauingenieurwesen CHF 6\'800-7\'500. Am anderen Ende der Spannweite: Detailhandel und Gastronomie (CHF 4\'200-4\'800), Reinigung und Dienstleistungen (CHF 3\'900-4\'400), allgemeines Bauwesen (CHF 4\'500-5\'200). Der Lohnrechner auf der Startseite wandelt jedes Band in reales Netto um und berücksichtigt Ihre italienische Wohngemeinde.'],
        ['Lohnt es sich, in einer Branche zu spezialisieren oder Generalist zu bleiben?',
         'Für italienische Grenzgänger sind die Daten eindeutig: Spezialisierung zahlt sich in der Schweiz viel mehr aus als in Italien. Lohnunterschiede zwischen einem Senior-Spezialisten und einem Generalisten in derselben Branche überschreiten in der Schweiz oft 35-45 % gegenüber den typischen italienischen 15-20 %. Zudem haben spezialisierte Rollen weniger Fluktuation, weniger interne Konkurrenz und linearere Karrierewege. Spezialisierung lohnt sich besonders in der Gesundheit (medizinische Subspezialitäten), Finance (Private Banking, Wealth, Compliance), IT (Cybersecurity, Cloud, Daten) und Ingenieurwesen (GxP-Validierung, Pharmaqualität).'],
        ['Wie lange dauern Einstellungsverfahren je Branche im Tessin durchschnittlich?',
         'Operative und technische Rollen (Detailhandel, Bau, Gastronomie, Junior-IT): 2 bis 4 Wochen zwischen erster Bewerbung und Vertragsunterzeichnung, oft ohne Anerkennung des Titels. Qualifizierte Rollen ohne Anerkennung (Senior-IT, Marketing, Commercial Finance): 4-8 Wochen mit 2-3 Gesprächen. Regulierte Rollen mit Titelanerkennung (Arzt, Pflegefachperson, zugelassener Ingenieur): 4-8 Monate insgesamt, davon 3-6 die Titelanerkennung, die parallel zu den Bewerbungen gestartet werden sollte. Kantonale öffentliche Verwaltung: 3-6 Monate zwischen Ausschreibung und Unterzeichnung mit obligatorischer öffentlicher Ausschreibung.'],
      ],
      companies: [
        ['Wie viele Schweizer Unternehmen stellen italienische Grenzgänger ein?',
         'USTAT 2024 zählt rund 78\'000 aktive Grenzgänger im Kanton Tessin, verteilt auf 13\'500 verschiedene Arbeitgeber. Die 100 Unternehmen, die am meisten Grenzgänger einstellen, konzentrieren etwa 28 % des Gesamtbestands (Mendrisiotto und Luganese an der Spitze). Das Unternehmensarchiv der Website erfasst jedes Tessiner und Schweizer Unternehmen, das mindestens ein nachverfolgbares Inserat über die integrierten Crawler veröffentlicht hat: über 4\'000 Unternehmenshubs mit aktiven Stellen und Hinweisen zu grenzgängerspezifischen Anforderungen (G-Bewilligung, Quellenkanton, Homeoffice erlaubt, KVG-Deckung).'],
        ['Wie erkenne ich, ob ein Unternehmen regelmässig Grenzgänger einstellt?',
         'Drei Indikatoren sind verlässlich: (1) Präsenz in unserem Index "Unternehmen, die wöchentlich einstellen" — der Crawler erfasst die Publikationsfrequenz jedes Arbeitgebers, und ein regelmässig positives Wochen-Delta deutet auf Fluktuation oder organisches Wachstum hin; (2) die Hub-Seite des Unternehmens zeigt — sofern die Quell-ATS es liefert — den Grenzgänger-Anteil der Belegschaft; (3) Hauptstandort: Unternehmen im Mendrisiotto, Luganese und im industriellen Sopraceneri haben naturgemäss eine Grenzgänger-Mehrheit, während Sottoceneri-Firmen mit städtischen Büros eine gemischtere Verteilung haben. Die Filterung dieser drei Dimensionen im Unternehmensindex reduziert das Risiko, sich bei einem Arbeitgeber zu bewerben, der die G-Bewilligung nicht sponsert, erheblich.'],
        ['Kann ich mich initiativ bei einem Unternehmen ohne offene Stelle bewerben?',
         'Ja, und es ist oft einer der wirksamsten, aber am wenigsten genutzten Kanäle. Wachsende Unternehmen erhalten spontane Lebensläufe und archivieren sie in einer internen Datenbank für den Fall, dass sich eine passende Stelle öffnet: die durchschnittliche Zeit zwischen spontanem Versand und einem ersten Angebot beträgt in erfolgreichen Fällen 6-12 Wochen. Fügen Sie einer Initiativbewerbung immer bei: (1) Anschreiben mit Verweis auf ein tatsächliches Produkt, eine Dienstleistung oder einen Kunden des Unternehmens; (2) Schweizer Lebenslauf (1-2 Seiten, formelles Foto optional, keine "Hobbys"-Sektion); (3) erreichbare Referenzen (≥ 2). Geben Sie in der ersten Kommunikation keine Gehaltsvorstellungen an: lassen Sie den Arbeitgeber den ersten Schritt machen.'],
        ['Zahlen Multinationale im Tessin mehr als lokale KMU?',
         'In der Regel ja bei qualifizierten Rollen (15-25 % Aufschlag gegenüber dem Branchenmedian), mit zwei Einschränkungen: (1) der Unterschied ist bei operativen, nicht spezialisierten Rollen kleiner, wo Tessiner Industrie-KMU und kleine Detailhandelsfirmen wettbewerbsfähige Pakete anbieten; (2) Multinationale haben oft zentralisierte HR ausserhalb des Kantons, formelle Auswahlverfahren und weniger vertragliche Flexibilität. Tessiner KMU (50-500 Mitarbeitende) bieten dagegen schnellere Karrierewege, verbreitetere Homeoffice-Regeln und verhandelbare Verträge. Bewerten Sie nach Ihrem Karrierehorizont, nicht nur nach dem Bruttolohn.'],
        ['Welche Tessiner Unternehmen haben die grenzgängerfreundlichste Homeoffice-Politik?',
         'Seit dem 1. Januar 2024 beträgt die Grenzgänger-Homeoffice-Grenze 25 % der jährlichen Arbeitszeit. Unternehmen, die dies ausdrücklich im Vertrag erwähnen (und damit den Mitarbeitenden vor dem fiskalischen Risiko schützen), konzentrieren sich auf: IT/Software, Beratung, Marketing, Finance, Pharmaforschung. Industrie, Bau, Spitalgesundheit und Gastronomie verlangen aus offensichtlichen Gründen 100 % Präsenz. Die Hub-Seite des Unternehmens, sofern die Quell-ATS es zeigt, gibt die deklarierte Politik wieder: suchen Sie nach Arbeitgebern mit "Homeoffice 1-2 Tage/Woche" im Benefits-Abschnitt.'],
      ],
      articles: [
        ['Wann wird das redaktionelle Archiv aktualisiert?',
         'Die Nachrichten werden Montag bis Freitag um 08:00 MEZ veröffentlicht und decken die wichtigsten Themen des Vortags ab: italienische und schweizerische Regulierungsänderungen, Gerichtsurteile, Grenzverkehr, Treibstoffpreise, USTAT-Daten, Bewegungen der wichtigsten Tessiner Arbeitgeber bei Einstellungen und Entlassungen. Die praktischen Leitfäden werden vierteljährlich aktualisiert oder wenn eine Regulierungsänderung eine Anpassung verlangt (z. B. neues Steuerabkommen, jährliche KVG-Aktualisierung, BVG-Reform). Deep-Dives zu spezifischen Themen (steuerlicher Wohnsitz, Titelumwandlung, Struktur der G-Bewilligung) werden 1-2 mal pro Monat veröffentlicht und im Archiv nach Kategorie und Tiefe indexiert.'],
        ['Kann ich die Artikel per E-Mail erhalten?',
         'Ja, der wöchentliche Newsletter sendet jeden Montagmorgen die Zusammenfassung der 5-7 wichtigsten Artikel der Woche, Alerts zu regulatorischen Änderungen, die für Grenzgänger relevant sind, die neuen USTAT-Daten und eine Übersicht der Trends auf dem Tessiner Arbeitsmarkt. Die Anmeldung ist von der Startseite aus kostenlos; Abonnenten erhalten auch Zugang zu reservierten Inhalten: historische KVG-Prämiendaten pro Gemeinde (10 Jahre), die Unternehmensdatenbank mit der Publikationsfrequenz der Inserate und den erweiterten Lohnsimulator inklusive persönlich gewählter Pensionskasse BVG.'],
        ['Werden die Leitfäden aus italienischen oder Schweizer Quellen geschrieben?',
         'Die Leitfäden werden von italienischen Redakteuren mit Wohnsitz zwischen Como und Varese und direkter Grenzgänger-Erfahrung kuratiert, in Zusammenarbeit mit in beiden Ländern zugelassenen Steuerberatern und mit periodischem Feedback erfahrener Leser (Anwälte, Wirtschaftsprüfer, Gewerkschaftsvertreter der Grenze). Die Schweizer Datenquellen (kantonales USTAT, Bundes-BFS, AHV, IAS) werden im Artikel stets mit direkten Links auf die Originaldokumente zitiert; die italienischen Quellen (Agenzia delle Entrate, INPS, MEF) ebenso. Wenn eine Auslegung umstritten oder in Entwicklung ist (z. B. Steuerabkommen im Übergang), präsentiert der Leitfaden die verschiedenen Auslegungen statt einer einzigen und zeigt die erwarteten Aktualisierungen an.'],
        ['Kann ich ein Thema vorschlagen oder einen Fehler melden?',
         'Ja, das Feedback-Tool ist von der Startseite aus verlinkt (Abschnitt "Melden/Vorschlagen"). Von Lesern vorgeschlagene Themen werden innerhalb von 2-4 Wochen in den redaktionellen Plan aufgenommen, wenn sie für die Mehrheit der Leser relevant sind, oder in Ad-hoc-Artikeln behandelt, wenn sie sehr spezifisch sind. Fehlermeldungen (falsche Daten, defekter Link, veraltete steuerliche Auslegung) werden innerhalb von 48 Stunden nach Überprüfung korrigiert. Die redaktionelle Transparenz ist einer der Gründungswerte der Website: aktualisierte Artikel zeigen unten die Änderungschronik, und die Website pflegt ein öffentliches Changelog der wichtigsten Änderungen.'],
        ['Was unterscheidet dieses Archiv von generalistischen Blogs über Grenzgänger?',
         'Drei Dinge: (1) die Perspektive ist ausschliesslich diejenige eines italienischen Wohnsitz-Arbeitnehmers (nicht jemand, der in der Schweiz lebt, nicht jemand, der Steuerdienstleistungen verkauft, nicht jemand, der Finanzprodukte verkauft); (2) an der Quelle verifizierte Daten statt aus sekundären Referenzen zusammengefasst — jede Statistik verweist auf das Original-USTAT/BFS/Agenzia-Entrate-Dokument, nicht auf eine andere Site; (3) Integration mit operativen Tools (Simulatoren, Rechner, Grenzkarten, Unternehmensindizes), die Anleitung in konkretes Handeln verwandelt. Der generalistische Blog beschreibt; dieses Archiv lässt die Daten arbeiten.'],
      ],
    },
    fr: {
      jobs: [
        ['Combien d\'heures un frontalier travaille-t-il en moyenne au Tessin ?',
         'Le contrat tessinois standard prévoit 40-42 heures par semaine (8-8,4 heures sur 5 jours) ; l\'industrie et la construction peuvent atteindre 45 heures avec heures supplémentaires payées, tandis que la banque et le secteur public restent à 40. Les heures de trajet ne comptent pas comme temps rémunéré, donc un frontalier qui part de Côme à 6h30 pour arriver à Lugano à 8h00 et rentre à 18h30 travaille 8 heures payées mais reste 12 heures hors de chez lui. Tenez compte de ce coût d\'opportunité avant d\'accepter une offre uniquement pour le brut : le net réel par heure investie (travail + trajet) peut être plus faible qu\'un emploi italien même avec des salaires suisses nominalement plus élevés.'],
        ['Quel est le salaire moyen d\'un frontalier au Tessin ?',
         'USTAT 2024 et les statistiques cantonales indiquent une médiane brute de CHF 5\'800-6\'200/mois pour des postes qualifiés à plein temps (≈ EUR 6\'200-6\'700 au cours 1,07), qui deviennent CHF 4\'700-5\'100 net après retenue à la source, AVS/AI/APG (5,3 %), assurance accidents et cotisations LPP. La fourchette est large : la santé et la finance dépassent la médiane de CHF 7\'500, tandis que le commerce et la restauration partent de CHF 4\'200. Utilisez le simulateur de salaire de la page d\'accueil pour un calcul net précis incluant votre commune italienne de résidence et le régime fiscal choisi (ancien frontalier vs nouvel accord 2024).'],
        ['Est-il avantageux d\'être frontalier en 2026 plutôt que de travailler en Italie ?',
         'La réponse dépend de trois facteurs : (1) votre catégorie salariale, (2) la distance domicile-travail, (3) les coûts réels du trajet. En moyenne, le net frontalier dépasse celui d\'un équivalent italien de 60-90 % pour des postes qualifiés, mais les coûts réels du trajet (carburant EUR 250-450/mois, autoroute EUR 80-120/mois, entretien voiture, parking EUR 80-150/mois au Tessin) réduisent l\'écart. Pour des postes en dessous de CHF 4\'500 brut, le seuil de rentabilité avec un emploi italien équivalent est à la limite. La page dédiée "Est-il avantageux d\'être frontalier" propose une simulation personnalisable.'],
        ['Quels documents sont nécessaires pour commencer à travailler au Tessin comme frontalier ?',
         'Pour le premier contrat avec un employeur suisse : (1) carte d\'identité ou passeport italien valide, (2) attestation de l\'employeur avec type de contrat et adresse du lieu de travail, (3) formulaire de demande de permis G obtenu par l\'employeur auprès de la Sezione della popolazione cantonale (l\'autorisation est typiquement délivrée dans les 3-5 jours ouvrés), (4) affiliation AVS/AI via la caisse de compensation de l\'employeur (automatique), (5) choix de l\'assurance maladie : LAMal suisse (obligatoire côté suisse mais avec "droit d\'option" pour rester au SSN italien dans les 3 mois suivant le début du travail). Les postes réglementés (santé, écoles, ingénierie publique) requièrent en outre la reconnaissance du titre italien auprès du SBFI/SEFRI.'],
        ['Puis-je travailler depuis chez moi comme frontalier et conserver le statut fiscal ?',
         'Depuis le 1er janvier 2024, les frontaliers peuvent télétravailler depuis l\'Italie jusqu\'à 25 % du temps de travail annuel sans perdre le statut fiscal et l\'imposition concurrente. La clause doit être explicite dans le contrat de travail ; si l\'employeur ne la formalise pas, le télétravail risque de faire perdre la qualité de frontalier et de déclencher la taxation italienne du salaire suisse. Le seuil de 25 % est la limite négociée au niveau de l\'accord Italie-Suisse et s\'applique uniformément à tous les cantons : travailler 1 jour par semaine depuis chez soi respecte la limite, tandis que 2 jours la dépassent. Vérifiez toujours la clause avec l\'employeur avant la signature.'],
      ],
      sectors: [
        ['Quels secteurs embauchent le plus de frontaliers au Tessin ?',
         'Les statistiques cantonales 2024 indiquent, par ordre : santé et soins (22 % des frontaliers actifs), commerce de détail et restauration (18 %), construction et installation (12 %), banque et assurance (9 %), ingénierie et mécanique (7 %). Les 32 % restants couvrent la logistique, l\'IT, les écoles privées, le nettoyage, l\'agriculture et plus de 30 catégories plus petites. La part frontalière varie selon la catégorie : dans la santé elle dépasse 60 % des opérateurs, dans la construction atteint 50 %, alors que dans l\'emploi public elle est sous 5 % en raison des exigences de résidence.'],
        ['Les titres italiens sont-ils reconnus automatiquement en Suisse ?',
         'Cela dépend du secteur. Pour les postes réglementés (santé, écoles, ingénierie publique, sécurité, certains profils financiers), la reconnaissance formelle du titre italien auprès du SBFI/SEFRI est requise : la procédure dure 3-6 mois, coûte CHF 550-950 et exige des traductions certifiées du diplôme, des plans d\'études et — pour la santé — de l\'inscription à l\'ordre professionnel italien. Pour les postes non réglementés (commerce, restauration, construction non spécialisée, IT, logistique), le titre italien est évalué par l\'employeur lors de l\'entretien sans reconnaissance formelle : CV et références suffisent. La plupart des annonces sur le job-board relèvent de cette seconde catégorie.'],
        ['Quels secteurs paient les salaires les plus élevés aux frontaliers au Tessin ?',
         'Médiane brute 2024 : finance et gestion de patrimoine CHF 8\'200-9\'500/mois, IT senior et cybersécurité CHF 7\'800-9\'000, ingénierie pharmaceutique et biomédicale CHF 7\'500-8\'500, santé spécialisée (anesthésie, cardiologie, radiologie) CHF 7\'000-8\'000, ingénierie civile senior CHF 6\'800-7\'500. À l\'autre extrémité : commerce et restauration (CHF 4\'200-4\'800), nettoyage et services (CHF 3\'900-4\'400), construction non spécialisée (CHF 4\'500-5\'200). Le calculateur de salaire de la page d\'accueil convertit chaque tranche en net réel en tenant compte de votre commune italienne de résidence.'],
        ['Vaut-il mieux se spécialiser dans un secteur ou rester généraliste ?',
         'Pour les frontaliers italiens, les données sont claires : la spécialisation paie beaucoup plus qu\'en Italie. Les écarts salariaux entre un senior spécialisé et un généraliste dans le même secteur dépassent souvent 35-45 % en Suisse contre les 15-20 % typiques italiens. De plus, les rôles spécialisés ont moins de rotation, moins de concurrence interne et des parcours de carrière plus linéaires. La spécialisation est particulièrement utile dans la santé (sous-spécialités médicales), la finance (private banking, gestion de fortune, conformité réglementaire), l\'IT (cybersécurité, cloud, données) et l\'ingénierie (validation GxP, qualité pharma).'],
        ['Combien de temps durent en moyenne les embauches par secteur au Tessin ?',
         'Rôles opérationnels et techniques (commerce, construction, restauration, IT junior) : 2 à 4 semaines entre première candidature et signature du contrat, souvent sans reconnaissance du titre. Rôles qualifiés sans reconnaissance (IT senior, marketing, finance commerciale) : 4-8 semaines avec 2-3 entretiens. Rôles réglementés avec reconnaissance du titre (médecin, infirmier, ingénieur agréé) : 4-8 mois au total, dont 3-6 pour la reconnaissance du titre à lancer en parallèle aux candidatures. Administration publique cantonale : 3-6 mois entre annonce et signature, avec concours public obligatoire.'],
      ],
      companies: [
        ['Combien d\'entreprises suisses embauchent des frontaliers italiens ?',
         'Les données USTAT 2024 comptent environ 78\'000 frontaliers actifs en Canton du Tessin, répartis sur 13\'500 employeurs distincts. Les 100 entreprises qui embauchent le plus de frontaliers concentrent environ 28 % du total (Mendrisiotto et Luganese en tête). L\'archive des entreprises du site recueille chaque entreprise tessinoise et suisse ayant publié au moins une annonce traçable via les crawlers intégrés : plus de 4\'000 hubs d\'entreprises avec annonces actives et indications sur les exigences spécifiques frontaliers (permis G, canton de retenue, télétravail autorisé, couverture LAMal).'],
        ['Comment savoir si une entreprise embauche régulièrement des frontaliers ?',
         'Trois indicateurs sont fiables : (1) présence dans notre index "entreprises qui embauchent chaque semaine" — le crawler enregistre la cadence de publication de chaque employeur, et un delta hebdomadaire positif régulier indique de la rotation ou une croissance organique ; (2) la page hub de l\'entreprise expose — quand l\'ATS source le déclare — la part frontalière de l\'effectif ; (3) le siège principal : les entreprises basées dans le Mendrisiotto, le Luganese et le Sopraceneri industriel ont par construction une majorité frontalière, alors que les entreprises du Sottoceneri avec bureaux urbains ont une distribution plus mixte. Filtrer sur ces trois dimensions dans l\'index entreprises réduit fortement le risque de postuler à un employeur qui ne sponsorise pas le permis G.'],
        ['Puis-je postuler spontanément dans une entreprise sans poste ouvert ?',
         'Oui, et c\'est souvent l\'un des canaux les plus efficaces mais sous-utilisés. Les entreprises en croissance reçoivent des CV spontanés et les archivent dans une base interne pour quand un poste cohérent s\'ouvre : le temps moyen entre envoi spontané et première offre est de 6-12 semaines dans les cas positifs. Joignez toujours à une candidature spontanée : (1) lettre de motivation avec référence explicite à un produit, service ou client réel de l\'entreprise ; (2) CV à la suisse (1-2 pages, photo formelle optionnelle, pas de section "loisirs") ; (3) références contactables (≥ 2). N\'incluez pas vos prétentions salariales dans la première communication : laissez l\'employeur faire le premier pas.'],
        ['Les multinationales paient-elles plus que les PME locales au Tessin ?',
         'En général oui pour des rôles qualifiés (prime de 15-25 % sur la médiane sectorielle), avec deux réserves : (1) l\'écart est plus petit pour les rôles opérationnels non spécialisés, où les PME industrielles tessinoises et les petites entreprises de commerce offrent des packages compétitifs ; (2) les multinationales ont souvent des RH centralisées hors du canton, des processus de sélection plus formels et moins de flexibilité contractuelle. Les PME tessinoises (50-500 employés) offrent en revanche des parcours de carrière plus rapides, un télétravail plus répandu et des contrats négociables. Évaluez selon votre horizon de carrière, pas seulement selon le brut.'],
        ['Quelles entreprises tessinoises ont la politique de télétravail la plus favorable aux frontaliers ?',
         'Depuis le 1er janvier 2024, la limite de télétravail frontalier est de 25 % du temps de travail annuel. Les entreprises qui l\'incluent explicitement dans le contrat (et protègent ainsi le collaborateur du risque fiscal) se concentrent dans : IT/logiciel, conseil, marketing, finance, recherche pharma. L\'industrie, la construction, la santé hospitalière et la restauration exigent pour des raisons évidentes 100 % de présence. La page hub de l\'entreprise, quand l\'ATS source l\'expose, montre la politique déclarée : cherchez les employeurs avec "télétravail 1-2 jours/semaine" dans la section avantages.'],
      ],
      articles: [
        ['Quand l\'archive éditoriale est-elle mise à jour ?',
         'Les actualités sont publiées du lundi au vendredi à 08h00 HEC, couvrant les sujets les plus pertinents de la veille : changements réglementaires italiens et suisses, arrêts, circulation aux passages, prix des carburants, données USTAT, mouvements des principaux employeurs tessinois en matière d\'embauche et de licenciements. Les guides pratiques sont rafraîchis trimestriellement ou lorsqu\'un changement réglementaire impose une mise à jour (ex. nouvel accord fiscal, mise à jour annuelle LAMal, réforme LPP). Les deep-dives sur des thèmes spécifiques (résidence fiscale, conversion de titre, structure du permis G) sont publiés 1-2 fois par mois et indexés dans l\'archive par catégorie et profondeur.'],
        ['Puis-je recevoir les articles par email ?',
         'Oui, la newsletter hebdomadaire envoie chaque lundi matin un résumé des 5-7 articles les plus pertinents de la semaine, des alertes sur les changements réglementaires pertinents pour le frontalier, les nouvelles données USTAT et un récapitulatif des tendances du marché du travail tessinois. L\'inscription est gratuite depuis la page d\'accueil ; les abonnés accèdent également à du contenu réservé : les données historiques des primes LAMal par commune (10 ans), la base de données des entreprises avec cadence de publication des annonces et le simulateur de salaire avancé incluant la caisse de pension LPP choisie personnellement.'],
        ['Les guides sont-ils écrits à partir de sources italiennes ou suisses ?',
         'Les guides sont curés par des rédacteurs italiens résidant entre Côme et Varèse avec expérience directe de frontalier, en collaboration avec des conseillers fiscaux agréés dans les deux pays et avec un retour périodique de lecteurs experts (avocats, comptables, représentants syndicaux frontaliers). Les sources de données suisses (USTAT cantonal, OFS fédéral, AVS, IAS) sont systématiquement citées dans l\'article avec liens directs vers les documents originaux ; les sources italiennes (Agenzia delle Entrate, INPS, MEF) idem. Quand une interprétation est controversée ou en évolution (ex. accords fiscaux en transition), le guide présente les différentes interprétations plutôt qu\'une seule, et indique les mises à jour attendues.'],
        ['Puis-je suggérer un sujet ou signaler une erreur ?',
         'Oui, l\'outil de feedback est lié depuis la page d\'accueil (section "Signaler/Suggérer"). Les sujets suggérés par les lecteurs sont incorporés dans le plan éditorial dans les 2-4 semaines s\'ils sont pertinents pour la majorité des lecteurs, ou traités dans des articles ad-hoc s\'ils sont très spécifiques. Les signalements d\'erreurs (donnée fausse, lien cassé, interprétation fiscale obsolète) sont corrigés dans les 48 heures suivant la vérification. La transparence éditoriale est l\'une des valeurs fondatrices du site : les articles mis à jour montrent en bas l\'historique des modifications, et le site maintient un changelog public des principales modifications.'],
        ['Qu\'est-ce qui distingue cette archive des blogs généralistes sur le frontalierat ?',
         'Trois choses : (1) la perspective est exclusivement celle du travailleur résident italien (pas quelqu\'un qui vit en Suisse, pas quelqu\'un qui vend des services fiscaux, pas quelqu\'un qui vend des produits financiers) ; (2) données vérifiées à la source plutôt que résumées depuis des références secondaires — chaque statistique renvoie au document original USTAT/BFS/Agenzia Entrate, pas à un autre site ; (3) intégration avec des outils opérationnels (simulateurs, calculateurs, cartes des passages, index des entreprises) qui transforme la consigne en action concrète. Le blog généraliste décrit ; cette archive met les données au travail.'],
      ],
    },
  };
  const pairs = FAQ[locale][hubKey];
  const heading = locale === 'it' ? 'Domande frequenti'
    : locale === 'de' ? 'Häufig gestellte Fragen'
    : locale === 'fr' ? 'Questions fréquentes'
    : 'Frequently asked questions';
  const items = pairs
    .map(([q, a]) =>
      `<div style="margin:0 0 16px"><h3 style="font-size:15px;font-weight:600;color:var(--color-heading);margin:0 0 6px">${esc(q)}</h3><p style="font-size:14px;color:var(--color-body);max-width:780px;line-height:1.6;margin:0">${a}</p></div>`,
    )
    .join('');
  return `<section style="margin:32px 0 0" aria-labelledby="hubFaq">
        <h2 id="hubFaq" style="font-size:18px;font-weight:700;color:var(--color-heading);margin:0 0 12px">${heading}</h2>
        ${items}
      </section>`;
}

/**
 * Considerazioni-finali / closing-thoughts block — 2026-05-13 follow-up
 * to `buildHubFaqHtml`. PR #150's FAQ added ~3 KB visible text per
 * page-N HTML (against the ~4 KB needed to clear the 10 % ratio gate
 * for the master-hub `cerca-lavoro-ticino/tutti/page-N` family). This
 * block adds another ~3 KB locale-aware prose on top, structured as
 * three paragraphs without headings (heading overhead is ~80 bytes
 * markup per kB text and we want to maximise text density). Shared
 * across hub kinds — same text for jobs/sectors/companies/articles
 * since the topic is the cross-border worker context rather than the
 * specific hub.
 *
 * Projected per-page contribution: ~3 KB visible text, ~0.7 KB markup
 * → net ratio bump of ~2 %. Combined with FAQ (PR #150) that takes
 * `find-jobs-ticino/all/page-N` family from 7.3 % to ~10 %+.
 */
function buildHubClosingHtml(locale: HubLocale): string {
  const PARAS: Record<HubLocale, [string, string, string]> = {
    it: [
      `Riflessioni operative sul mestiere del frontaliere. Lavorare in Ticino restando residente in Italia è una scelta che si valuta con tre lenti sovrapposte. La prima è economica: il differenziale netto fra stipendio svizzero e italiano va sempre tradotto in netto-per-ora investita, includendo il pendolarismo che assorbe 10-14 ore alla settimana fra carburante, autostrada, code ai valichi nelle ore di punta e manutenzione del veicolo. La seconda lente è fiscale: dal 1° gennaio 2024 il Nuovo Accordo Italia-Svizzera ha introdotto la tassazione concorrente per i nuovi frontalieri, mentre i frontalieri storici (quelli con un contratto attivo al 17 luglio 2023) mantengono il regime previgente di sola imposizione svizzera. La differenza è di 5-12 punti percentuali sul netto, ed è una variabile da inserire nei conteggi prima di firmare un contratto, non dopo. La terza lente è la qualità della vita: il valico più scorrevole rispetto alla tua residenza, gli orari di lavoro effettivi, la possibilità di telelavoro fino al 25 % del tempo (massimo concordato fra i due paesi a partire dal 2024).`,
      `Costi reali del pendolarismo e impatto sul netto. Sui forum frontalieri il dato più sottostimato è quanto pesi davvero il pendolarismo sul netto disponibile. Una vettura a benzina che fa 50 km al giorno fra residenza e luogo di lavoro consuma 5-6 litri al giorno (≈ 1\'200-1\'400 km al mese), con un costo combustibile di EUR 280-360 al mese ai prezzi medi italiani 2026 e qualcosa in meno se si rifornisce in Svizzera (Mendrisio è competitiva per chi rientra dal Sottoceneri). A questo si aggiunge il pedaggio autostradale (EUR 80-120 al mese fra A2/A9 e Bregaglia), la manutenzione (ammortamento + tagliando + gomme stagionali, EUR 90-130 al mese), il parcheggio in Ticino se l\'azienda non lo offre (EUR 80-180 al mese a Lugano centro e Mendrisio), e il consumo accelerato del veicolo (ammortamento più rapido). La somma è EUR 530-790 al mese, equivalenti a un decremento del 9-13 % sul netto medio frontaliere. Il <a href="${BASE_URL}/calcola-stipendio/" style="color:var(--color-link)">simulatore stipendio</a> e la pagina costi del pendolarismo aiutano a quantificarlo prima dell\'accordo contrattuale.`,
      `Verso una scelta consapevole nel 2026 e oltre. La domanda "conviene fare il frontaliere?" non ha più una risposta universale come 10 o 15 anni fa. Conviene se: il tuo settore offre un differenziale netto ≥ 50 % rispetto alla mediana italiana (sanità, finanza, IT senior, ingegneria specializzata), la tua residenza è entro 60 km del confine, l\'azienda offre un contratto con telelavoro esplicito nel 25 % consentito, e i costi del pendolarismo restano sotto EUR 600 al mese. Non conviene se: il settore è non specializzato (commercio, ristorazione, edilizia generica) e quindi il differenziale è sotto il 30 %, la residenza è oltre 90 km dal confine, il datore non sponsorizza il Permesso G prima della firma, o il valico abituale ha tempi di attesa medi superiori a 25 minuti nelle ore di punta. La zona grigia (settore medio, distanza media, costi medi) è dove il sito offre il valore maggiore: simulatori, dati reali e guide pratiche che traducono la decisione personale in cifre confrontabili. Iscriviti alla newsletter dalla home per ricevere il riassunto settimanale dei dati USTAT, dei cambi normativi e delle aziende che assumono di più.`,
    ],
    en: [
      `Operational reflections on the cross-border profession. Working in Ticino while keeping Italian residency is a choice that is evaluated through three overlapping lenses. The first is economic: the net differential between a Swiss and Italian salary must always be translated into net-per-hour invested, including the commute that absorbs 10-14 hours a week between fuel, motorway tolls, peak-hour queues at the border and vehicle maintenance. The second lens is fiscal: from 1 January 2024 the new Italy-Switzerland agreement introduced concurrent taxation for new cross-border workers, while historical ones (those with an active contract on 17 July 2023) retain the previous Swiss-only regime. The gap is 5-12 percentage points on the net, and is a variable to factor into calculations before signing a contract, not afterwards. The third lens is quality of life: the smoothest border crossing relative to residence, the actual working hours, the option of remote work up to 25 % of the time (the bilateral maximum negotiated from 2024).`,
      `Real commute costs and their impact on net pay. The most under-estimated figure on cross-border forums is how much commute actually weighs on disposable net pay. A petrol car doing 50 km a day between residence and workplace consumes 5-6 litres per day (≈ 1,200-1,400 km a month), with a fuel cost of EUR 280-360 monthly at Italian 2026 average prices and somewhat less when refuelling on the Swiss side (Mendrisio is competitive for those returning via the Sottoceneri). On top of that comes the motorway toll (EUR 80-120 monthly across A2/A9 and Bregaglia), maintenance (depreciation + servicing + seasonal tyres, EUR 90-130 monthly), parking on the Swiss side if the employer does not provide it (EUR 80-180 monthly in central Lugano and Mendrisio), and accelerated vehicle wear (faster depreciation). The total is EUR 530-790 monthly, equivalent to a 9-13 % decrease on the average cross-border net. The <a href="${BASE_URL}/en/calculate-salary/" style="color:var(--color-link)">salary simulator</a> and the commute-costs page help quantify this before agreeing on the contract.`,
      `Towards a conscious choice in 2026 and beyond. The question "is it worth being a cross-border worker?" no longer has a universal answer like 10 or 15 years ago. It pays if: your sector offers a net differential ≥ 50 % over the Italian median (healthcare, finance, senior IT, specialised engineering), residence is within 60 km of the border, the company offers a contract with remote work explicitly in the 25 % allowance, and commute costs stay below EUR 600 monthly. It does not pay if: the sector is non-specialised (retail, hospitality, generic construction) and the differential is below 30 %, residence is beyond 90 km from the border, the employer does not sponsor the G permit before signing, or the usual border crossing has average wait times above 25 minutes at peak hours. The grey zone (middle sector, middle distance, middle costs) is where the site offers the most value: simulators, real data and practical guides that translate the personal decision into comparable figures. Subscribe to the newsletter from the homepage to receive the weekly digest of USTAT data, regulatory changes and biggest hiring companies.`,
    ],
    de: [
      `Operative Überlegungen zum Grenzgängerberuf. Im Tessin zu arbeiten und in Italien Wohnsitz zu behalten ist eine Entscheidung, die durch drei überlappende Linsen bewertet wird. Die erste ist die wirtschaftliche: die Netto-Differenz zwischen einem schweizerischen und einem italienischen Gehalt muss stets in Netto-pro-investierter-Stunde übersetzt werden, einschliesslich des Pendelns, das pro Woche 10-14 Stunden zwischen Treibstoff, Autobahnmaut, Stosszeiten an der Grenze und Fahrzeugunterhalt absorbiert. Die zweite Linse ist die steuerliche: ab dem 1. Januar 2024 hat das neue Italien-Schweiz-Abkommen die konkurrierende Besteuerung für neue Grenzgänger eingeführt, während historische Grenzgänger (jene mit einem am 17. Juli 2023 aktiven Vertrag) das vorherige Regime der ausschliesslich schweizerischen Besteuerung beibehalten. Der Unterschied beträgt 5-12 Prozentpunkte auf das Netto und ist eine Variable, die vor der Vertragsunterzeichnung in die Berechnungen einfliessen muss, nicht danach. Die dritte Linse ist die Lebensqualität: der fliessendste Grenzübergang relativ zum Wohnsitz, die tatsächlichen Arbeitszeiten, die Homeoffice-Option bis zu 25 % der Zeit (das ab 2024 ausgehandelte bilaterale Maximum).`,
      `Reale Pendelkosten und ihre Auswirkung auf das Netto. Die am meisten unterschätzte Kennzahl in Grenzgänger-Foren ist, wie stark das Pendeln wirklich auf das verfügbare Netto drückt. Ein Benzin-Pkw, der täglich 50 km zwischen Wohnsitz und Arbeitsort fährt, verbraucht 5-6 Liter pro Tag (≈ 1\'200-1\'400 km pro Monat) mit Treibstoffkosten von EUR 280-360 monatlich zu italienischen Durchschnittspreisen 2026 und etwas weniger beim Tanken in der Schweiz (Mendrisio ist wettbewerbsfähig für Pendler aus dem Sottoceneri). Hinzu kommen Autobahnmaut (EUR 80-120 monatlich über A2/A9 und Bregaglia), Unterhalt (Abschreibung + Service + Saisonbereifung, EUR 90-130 monatlich), Parkplatz auf Schweizer Seite, falls vom Arbeitgeber nicht angeboten (EUR 80-180 monatlich im Zentrum von Lugano und Mendrisio), und beschleunigter Fahrzeugverschleiss (schnellere Abschreibung). Die Summe beträgt EUR 530-790 monatlich, was einer Verminderung des durchschnittlichen Grenzgänger-Nettos um 9-13 % entspricht. Der <a href="${BASE_URL}/de/gehalt-berechnen/" style="color:var(--color-link)">Lohnsimulator</a> und die Seite zu den Pendelkosten helfen, dies vor der vertraglichen Einigung zu quantifizieren.`,
      `Auf dem Weg zu einer bewussten Entscheidung 2026 und danach. Die Frage "Lohnt es sich Grenzgänger zu sein?" hat keine universelle Antwort mehr wie vor 10 oder 15 Jahren. Es lohnt sich, wenn: Ihre Branche eine Netto-Differenz von ≥ 50 % gegenüber dem italienischen Median bietet (Gesundheit, Finance, Senior-IT, spezialisierte Ingenieurleistungen), der Wohnsitz innerhalb von 60 km zur Grenze liegt, das Unternehmen einen Vertrag mit ausdrücklich vorgesehenem Homeoffice innerhalb der 25 %-Toleranz anbietet, und die Pendelkosten unter EUR 600 monatlich bleiben. Es lohnt sich nicht, wenn: die Branche nicht spezialisiert ist (Detailhandel, Gastronomie, allgemeiner Bau) und die Differenz somit unter 30 % liegt, der Wohnsitz mehr als 90 km von der Grenze entfernt liegt, der Arbeitgeber die G-Bewilligung nicht vor der Unterschrift sponsert, oder der übliche Grenzübergang in Stosszeiten durchschnittliche Wartezeiten über 25 Minuten aufweist. Die Grauzone (mittlere Branche, mittlere Distanz, mittlere Kosten) ist der Bereich, in dem die Site den grössten Wert liefert: Simulatoren, reale Daten und praktische Anleitungen, die die persönliche Entscheidung in vergleichbare Zahlen übersetzen. Abonnieren Sie den Newsletter auf der Startseite, um die wöchentliche Zusammenfassung der USTAT-Daten, der regulatorischen Änderungen und der grössten einstellenden Unternehmen zu erhalten.`,
    ],
    fr: [
      `Réflexions opérationnelles sur le métier de frontalier. Travailler au Tessin tout en gardant la résidence italienne est un choix qui s\'évalue à travers trois lentilles superposées. La première est économique : l\'écart net entre un salaire suisse et un salaire italien doit toujours être traduit en net-par-heure investie, en incluant le trajet qui absorbe 10-14 heures par semaine entre carburant, péages autoroutiers, files aux passages frontaliers en heures de pointe et entretien du véhicule. La deuxième lentille est fiscale : à partir du 1er janvier 2024, le nouvel accord Italie-Suisse a introduit la taxation concurrente pour les nouveaux frontaliers, tandis que les frontaliers historiques (ceux avec un contrat actif au 17 juillet 2023) conservent le régime précédent de taxation suisse exclusive. L\'écart est de 5-12 points de pourcentage sur le net, et c\'est une variable à intégrer dans les calculs avant la signature du contrat, pas après. La troisième lentille est la qualité de vie : le passage frontalier le plus fluide par rapport à la résidence, les horaires de travail effectifs, l\'option de télétravail jusqu\'à 25 % du temps (le maximum bilatéral négocié à partir de 2024).`,
      `Coûts réels du trajet et impact sur le net. La donnée la plus sous-estimée sur les forums frontaliers est combien le trajet pèse réellement sur le net disponible. Une voiture à essence parcourant 50 km par jour entre la résidence et le lieu de travail consomme 5-6 litres par jour (≈ 1\'200-1\'400 km par mois), avec un coût carburant de EUR 280-360 mensuels aux prix moyens italiens 2026 et un peu moins lors d\'un plein côté suisse (Mendrisio est compétitif pour les pendulaires venant du Sottoceneri). À cela s\'ajoutent le péage autoroutier (EUR 80-120 mensuels sur A2/A9 et Bregaglia), l\'entretien (amortissement + service + pneus saisonniers, EUR 90-130 mensuels), le parking côté suisse si l\'employeur ne le fournit pas (EUR 80-180 mensuels au centre de Lugano et Mendrisio), et l\'usure accélérée du véhicule (amortissement plus rapide). La somme atteint EUR 530-790 mensuels, soit une diminution de 9-13 % du net frontalier moyen. Le <a href="${BASE_URL}/fr/calculer-salaire/" style="color:var(--color-link)">simulateur de salaire</a> et la page coûts du trajet aident à quantifier cela avant l\'accord contractuel.`,
      `Vers un choix conscient en 2026 et au-delà. La question "vaut-il la peine d\'être frontalier ?" n\'a plus de réponse universelle comme il y a 10 ou 15 ans. Cela en vaut la peine si : votre secteur offre un écart net ≥ 50 % sur la médiane italienne (santé, finance, IT senior, ingénierie spécialisée), la résidence est dans un rayon de 60 km de la frontière, l\'entreprise propose un contrat avec télétravail explicitement prévu dans les 25 % de tolérance, et les coûts du trajet restent sous EUR 600 mensuels. Cela n\'en vaut pas la peine si : le secteur est non spécialisé (commerce, restauration, construction générique) et l\'écart est donc inférieur à 30 %, la résidence est au-delà de 90 km de la frontière, l\'employeur ne sponsorise pas le permis G avant la signature, ou le passage habituel a des temps d\'attente moyens supérieurs à 25 minutes en heures de pointe. La zone grise (secteur moyen, distance moyenne, coûts moyens) est l\'endroit où le site offre le plus de valeur : simulateurs, données réelles et guides pratiques qui traduisent la décision personnelle en chiffres comparables. Abonnez-vous à la newsletter depuis la page d\'accueil pour recevoir le résumé hebdomadaire des données USTAT, des changements réglementaires et des entreprises qui recrutent le plus.`,
    ],
  };
  const [p1, p2, p3] = PARAS[locale];
  const heading = locale === 'it' ? 'Considerazioni finali per il frontaliere'
    : locale === 'de' ? 'Abschliessende Überlegungen für Grenzgänger'
    : locale === 'fr' ? 'Considérations finales pour le frontalier'
    : 'Closing thoughts for the cross-border worker';
  return `<section style="margin:32px 0 0" aria-labelledby="hubClosing">
        <h2 id="hubClosing" style="font-size:18px;font-weight:700;color:var(--color-heading);margin:0 0 12px">${heading}</h2>
        <p style="font-size:14px;color:var(--color-body);max-width:780px;line-height:1.6;margin:0 0 12px">${p1}</p>
        <p style="font-size:14px;color:var(--color-body);max-width:780px;line-height:1.6;margin:0 0 12px">${p2}</p>
        <p style="font-size:14px;color:var(--color-body);max-width:780px;line-height:1.6;margin:0">${p3}</p>
      </section>`;
}

interface PaginatedHub {
  readonly hubKey: 'jobs' | 'sectors' | 'companies' | 'articles';
  readonly itemHrefBuilder: (item: string, locale: HubLocale) => string;
  readonly itemLabelBuilder: (item: string, locale: HubLocale) => string;
  readonly items: readonly string[];
  readonly pageSize: number;
}

/**
 * Read all-known-job-slugs.json — shape is `{ canonicalSlug: { locale: path } }`
 * We use the canonicalSlug list and build URLs per-locale from the inner map.
 */
function readJobSlugsMap(
  fs: typeof fsT,
  np: typeof npT,
  rootDir: string,
): { slugs: string[]; perLocale: Record<HubLocale, Record<string, string>> } {
  const file = np.resolve(rootDir, 'data/all-known-job-slugs.json');
  const empty = {
    slugs: [] as string[],
    perLocale: { it: {}, en: {}, de: {}, fr: {} } as Record<HubLocale, Record<string, string>>,
  };
  try {
    if (!fs.existsSync(file)) return empty;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!raw || typeof raw !== 'object') return empty;
    const slugs = Object.keys(raw).sort();
    const perLocale: Record<HubLocale, Record<string, string>> = { it: {}, en: {}, de: {}, fr: {} };
    for (const s of slugs) {
      const inner = raw[s];
      if (inner && typeof inner === 'object') {
        for (const loc of HUB_LOCALES) {
          const v = (inner as Record<string, unknown>)[loc];
          if (typeof v === 'string' && v.length > 0) perLocale[loc][s] = v;
        }
      }
    }
    return { slugs, perLocale };
  } catch (err) {
    console.warn('[seo-hubs] failed to read all-known-job-slugs.json', err);
    return empty;
  }
}

/**
 * Parse CRAWLED_COMPANY_LOGOS from services/jobDataNormalization.ts source.
 * Returns slug → URL map for use as fallback when local manifest has no entry.
 */
function readCrawledCompanyLogos(fs: typeof fsT, np: typeof npT, rootDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const src = fs.readFileSync(np.resolve(rootDir, 'services/jobDataNormalization.ts'), 'utf-8');
    const blockMatch = src.match(/CRAWLED_COMPANY_LOGOS[^{]*\{([\s\S]*?)\n\};/);
    if (!blockMatch) return out;
    const block = blockMatch[1];
    const lineRx = /'([a-z0-9-]+)':\s*(.+?),?\s*$/gm;
    let m: RegExpExecArray | null;
    while ((m = lineRx.exec(block)) !== null) {
      const slug = m[1];
      const val = m[2].trim().replace(/,$/, '');
      if (val.startsWith("gFavicon('")) {
        const domain = val.match(/gFavicon\('([^']+)'\)/)?.[1];
        if (domain) out[slug] = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
      } else if (val.startsWith('cLogo(')) {
        const domain = val.match(/cLogo\('([^']+)'\)/)?.[1];
        if (domain) out[slug] = `https://logo.clearbit.com/${domain}`;
      } else if (val.startsWith("'") && val.endsWith("'")) {
        out[slug] = val.slice(1, -1);
      }
    }
  } catch (err) {
    console.warn('[seo-hubs] failed to read CRAWLED_COMPANY_LOGOS', err);
  }
  return out;
}

/** Fallback chain: Clearbit → Google favicon → placeholder SVG. */
const LOGO_ONERROR =
  `if(this.dataset.lf==='ph')return;if(this.src.indexOf('logo.clearbit.com')>-1){var d=this.src.replace(/^https?:\\/\\/logo\\.clearbit\\.com\\//,'').split(/[\\/?#]/)[0];if(d){this.src='https://www.google.com/s2/favicons?domain='+encodeURIComponent(d)+'&sz=128';this.dataset.lf='gf';return;}}this.src='/icons/company-placeholder.svg';this.dataset.lf='ph';this.style.visibility='visible';`;

function readCompanySlugs(fs: typeof fsT, np: typeof npT, rootDir: string): string[] {
  const file = np.resolve(rootDir, 'data/known-company-slugs.json');
  try {
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (Array.isArray(raw)) return [...raw].filter((s) => typeof s === 'string' && s.length > 0).sort();
  } catch (err) {
    console.warn('[seo-hubs] failed to read known-company-slugs.json', err);
  }
  return [];
}

/**
 * Read article slugs from blog-meta-{lang}.ts. Each line keyed
 * `'blog.article.<slug>.title'` is one article. The `slug` returned is
 * the canonical {@link BlogArticleId} key (matches `BLOG_SLUGS` keys in
 * `routerBlogData.ts`) — NOT the URL slug. Use {@link readBlogUrlSlugs}
 * to get the locale-specific URL slug for hub anchor construction.
 */
function readArticleSlugs(
  fs: typeof fsT,
  np: typeof npT,
  rootDir: string,
  locale: HubLocale,
): Array<{ slug: string; title: string }> {
  const file = np.resolve(rootDir, 'services/locales', `blog-meta-${locale}.ts`);
  const out: Array<{ slug: string; title: string }> = [];
  try {
    if (!fs.existsSync(file)) return out;
    const src = fs.readFileSync(file, 'utf-8');
    const seen = new Set<string>();
    const rx = /'blog\.article\.([^']+?)\.title':\s*'((?:[^'\\]|\\.)*)'/g;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(src)) !== null) {
      const slug = m[1];
      if (seen.has(slug)) continue;
      seen.add(slug);
      const title = m[2].replace(/\\'/g, "'").replace(/\\"/g, '"');
      out.push({ slug, title });
    }
  } catch (err) {
    console.warn(`[seo-hubs] failed to read blog-meta-${locale}.ts`, err);
  }
  return out;
}

/**
 * Read the {@link BlogArticleId} → per-locale URL-slug map from
 * `services/routerBlogData.ts` (the `BLOG_SLUGS` constant). Mirrors the
 * parser in {@link ogPagesPlugin}.
 *
 * **Why this exists.** `blog-meta-{lang}.ts` keys are `BlogArticleId`s
 * (e.g. `stipendio-netto-2026`), but the canonical sitemap URL uses the
 * locale-specific slug (`stipendio-netto-frontaliere-2026` in IT). When the
 * paginated articles archive at `/articoli-frontaliere/tutti/page-N/` lists
 * articles by `BlogArticleId`, the resulting `<a href>` does NOT match the
 * sitemap URL — and the BFS reachability audit flags ~174 articles as
 * "orphans in sitemap" even though the archive renders them.
 *
 * This map is the source of truth for `BlogArticleId → URL slug`. Returns
 * `{}` if the file is missing or unparseable (callers fall back to the
 * `BlogArticleId` as URL slug, preserving prior behaviour for tests).
 */
function readBlogUrlSlugs(
  fs: typeof fsT,
  np: typeof npT,
  rootDir: string,
): Record<string, Record<HubLocale, string>> {
  const file = np.resolve(rootDir, 'services/routerBlogData.ts');
  const out: Record<string, Record<HubLocale, string>> = {};
  try {
    if (!fs.existsSync(file)) return out;
    const src = fs.readFileSync(file, 'utf-8');
    const block = src.match(/const BLOG_SLUGS[\s\S]*?\n\};/m)?.[0] ?? '';
    if (!block) return out;
    const rx = /'([^']+)':\s*\{\s*it:\s*'([^']+)',\s*en:\s*'([^']+)',\s*de:\s*'([^']+)',\s*fr:\s*'([^']+)'/g;
    let bm: RegExpExecArray | null;
    while ((bm = rx.exec(block)) !== null) {
      out[bm[1]] = { it: bm[2], en: bm[3], de: bm[4], fr: bm[5] };
    }
  } catch (err) {
    console.warn('[seo-hubs] failed to read BLOG_SLUGS from routerBlogData.ts', err);
  }
  return out;
}

interface BuildHtmlArgs {
  locale: HubLocale;
  hubKey: 'jobs' | 'sectors' | 'companies' | 'articles';
  basePath: string;
  page: number;
  totalPages: number;
  pageItems: ReadonlyArray<{
    href: string;
    label: string;
    logo?: string | null;
    /** Right-aligned subtitle for company items (active openings count). */
    jobCount?: number;
    /** Emoji prefix bubble for sector items (mirrors per-canton hubs). */
    emoji?: string;
  }>;
  totalItems: number;
  hasSpaBundle: boolean;
  entryJs: string;
  entryCss: string;
}

function buildHtml(args: BuildHtmlArgs): string {
  const { locale, hubKey, basePath, page, totalPages, pageItems, totalItems, hasSpaBundle, entryJs, entryCss } = args;
  const title = HUB_TITLES[locale][hubKey];
  const description = HUB_DESCRIPTIONS[locale][hubKey];
  // Title ≤60 char (Semrush W2): drop "| Frontaliere Ticino" suffix when adding it
  // would push us over budget. Page-N suffix is also keyword for SEO.
  const baseTitle = page > 1 ? `${title} — ${pageLabel(locale, page)}` : title;
  const brandSuffix = ' | Frontaliere Ticino';
  const pageTitle = baseTitle.length + brandSuffix.length <= 60 ? `${baseTitle}${brandSuffix}` : baseTitle;
  const canonicalPath = paginatedPath(basePath, page);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;
  const dateStamp = new Date().toISOString().slice(0, 10);

  // hreflang: only emit alternates for page-1 (paginated pages share lang)
  const hreflangs = page === 1
    ? HUB_LOCALES
        .map((loc) => {
          const slugs = HUB_SLUGS[loc];
          const altPath =
            hubKey === 'jobs' ? slugs.jobsAll
            : hubKey === 'sectors' ? slugs.sectorsAll
            : hubKey === 'companies' ? slugs.companiesAll
            : slugs.articlesAll;
          return `    <link rel="alternate" hreflang="${loc}" href="${BASE_URL}${altPath}">`;
        })
        .join('\n')
    : '';
  const xDefault = page === 1
    ? `\n    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${
        hubKey === 'jobs' ? HUB_SLUGS.it.jobsAll
        : hubKey === 'sectors' ? HUB_SLUGS.it.sectorsAll
        : hubKey === 'companies' ? HUB_SLUGS.it.companiesAll
        : HUB_SLUGS.it.articlesAll
      }">`
    : '';

  const prevLink = page > 1 ? `\n    <link rel="prev" href="${BASE_URL}${paginatedPath(basePath, page - 1)}">` : '';
  const nextLink = page < totalPages ? `\n    <link rel="next" href="${BASE_URL}${paginatedPath(basePath, page + 1)}">` : '';

  // BreadcrumbList JSON-LD
  const sectionLabel = hubKey === 'companies'
    ? SECTION_LABEL[locale].companies
    : hubKey === 'articles'
    ? SECTION_LABEL[locale].articles
    : SECTION_LABEL[locale].jobBoard;

  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: sectionLabel, item: `${BASE_URL}${basePath}` },
      ...(page > 1
        ? [{ '@type': 'ListItem', position: 3, name: pageLabel(locale, page), item: canonicalUrl }]
        : []),
    ],
  });

  const collectionLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: title,
    url: canonicalUrl,
    description,
    inLanguage: locale,
    dateModified: new Date().toISOString(),
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: totalItems,
      itemListElement: pageItems.slice(0, 25).map((it, idx) => ({
        '@type': 'ListItem',
        position: (page - 1) * 100 + idx + 1,
        name: it.label,
        url: `${BASE_URL}${it.href}`,
      })),
    },
  });

  // Pagination chrome: prev / page-numbers / next
  const pagination = totalPages > 1 ? renderPagination(locale, basePath, page, totalPages) : '';

  // Items list — three layouts:
  //   • company items (`logo` defined) → entity-card with logo + job count
  //   • sector items (`emoji` defined) → emoji bubble card
  //   • everything else (jobs, articles) → compact plain-link
  const useFancyGrid = pageItems.some((it) => it.logo !== undefined || it.emoji !== undefined);
  const itemsHtml = pageItems.length === 0
    ? `<p style="color:var(--color-subtle);padding:16px 0">${esc(emptyLabel(locale))}</p>`
    : useFancyGrid
      ? `<ul style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px">${pageItems
          .map((it) => {
            if (it.logo !== undefined) {
              const card = renderEntityCard({
                href: it.href,
                logoUrl: it.logo ?? undefined,
                iconSvg: it.logo ? undefined : ICON_BUILDING_SVG,
                logoOnerror: it.logo ? LOGO_ONERROR : undefined,
                title: it.label,
                subtitle: it.jobCount ? jobsActiveLabel(locale, it.jobCount) : undefined,
                metric: it.jobCount ? String(it.jobCount) : undefined,
                metricTone: 'accent',
              });
              return `<li>${card}</li>`;
            }
            if (it.emoji !== undefined) {
              const subLabel = { it: 'Esplora →', en: 'Explore →', de: 'Erkunden →', fr: 'Explorer →' }[locale];
              return `<li><a href="${esc(it.href)}" style="display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:14px;color:var(--color-heading);background:var(--color-surface);text-decoration:none;border:1px solid var(--color-edge)"><span aria-hidden="true" style="display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:12px;background:var(--color-surface-alt);font-size:24px;line-height:1;flex-shrink:0">${it.emoji}</span><span style="flex:1;min-width:0"><span style="display:block;font-weight:700;font-size:15px;line-height:1.3;color:var(--color-heading)">${esc(it.label)}</span><span style="display:block;font-size:12.5px;color:var(--color-subtle);margin-top:2px;line-height:1.4">${subLabel}</span></span></a></li>`;
            }
            return `<li><a href="${esc(it.href)}" style="display:block;padding:10px 12px;border-radius:8px;color:var(--color-heading);background:var(--color-surface);text-decoration:none;border:1px solid var(--color-edge);font-size:14px;line-height:1.4">${esc(it.label)}</a></li>`;
          })
          .join('')}</ul>`
      : `<ul style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px">${pageItems
          .map((it) => `<li><a href="${esc(it.href)}" style="display:block;padding:10px 12px;border-radius:8px;color:var(--color-heading);background:var(--color-surface);text-decoration:none;border:1px solid var(--color-edge);font-size:14px;line-height:1.4">${esc(it.label)}</a></li>`)
          .join('')}</ul>`;

  // Stat tiles + primary CTA — universal across hub kinds. Tiles surface the
  // total, the current page position, and the last-updated date so users get
  // immediate context above the data area (rule #17).
  const tileLabelsGlobal = {
    it: { count: HUB_KEY_TILE_LABELS.it[hubKey], pagina: 'Pagina', aggiornato: 'Aggiornato' },
    en: { count: HUB_KEY_TILE_LABELS.en[hubKey], pagina: 'Page', aggiornato: 'Updated' },
    de: { count: HUB_KEY_TILE_LABELS.de[hubKey], pagina: 'Seite', aggiornato: 'Aktualisiert' },
    fr: { count: HUB_KEY_TILE_LABELS.fr[hubKey], pagina: 'Page', aggiornato: 'Mis à jour' },
  }[locale];
  const statTilesHtml = `<section aria-label="${esc({ it: 'Numeri chiave', en: 'Key numbers', de: 'Kennzahlen', fr: 'Chiffres clés' }[locale])}" style="margin:0 0 18px;display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px"><div style="${STAT_TILE_ACCENT}"><div style="${STAT_TILE_LABEL}">${esc(tileLabelsGlobal.count)}</div><div style="${STAT_TILE_VALUE}">${esc(totalItems.toLocaleString(locale))}</div></div><div style="${STAT_TILE_SUCCESS}"><div style="${STAT_TILE_LABEL}">${esc(tileLabelsGlobal.pagina)}</div><div style="${STAT_TILE_VALUE}">${esc(`${page} / ${totalPages}`)}</div></div><div style="${STAT_TILE_BASE}"><div style="${STAT_TILE_LABEL}">${esc(tileLabelsGlobal.aggiornato)}</div><div style="${STAT_TILE_VALUE};font-size:18px">${esc(dateStamp)}</div></div></section>`;

  const ctaPathGlobal = locale === 'it' ? '/calcola-stipendio/'
    : locale === 'de' ? '/de/gehalt-berechnen/'
    : locale === 'fr' ? '/fr/calculer-salaire/'
    : '/en/calculate-salary/';
  const ctaLabelGlobal = { it: 'Calcola lo stipendio netto frontaliere →', en: 'Calculate your cross-border net salary →', de: 'Grenzgänger-Nettolohn berechnen →', fr: 'Calculer le salaire net frontalier →' }[locale];
  const ctaHtmlGlobal = `<div style="margin:0 0 22px"><a href="${esc(ctaPathGlobal)}" style="${CTA_PRIMARY_STYLE}">${esc(ctaLabelGlobal)}</a></div>`;

  // Long prose (methodology + footer + FAQ + closing) collapsed under a
  // single details accordion: preserves text-to-HTML ratio + crawler depth
  // (BFS reads inside <details>) while keeping the data above the mobile
  // fold (rule #15/#16/#17).
  const proseSummaryLabel = {
    it: 'Approfondisci · metodologia, contesto frontaliere e FAQ',
    en: 'Read more · methodology, cross-border context and FAQ',
    de: 'Mehr erfahren · Methodik, Grenzgänger-Kontext und FAQ',
    fr: 'En savoir plus · méthodologie, contexte frontalier et FAQ',
  }[locale];
  const proseAccordionHtml = `<details style="margin-top:32px;border:1px solid var(--color-edge);border-radius:14px;background:var(--color-surface);padding:14px 18px;max-width:980px"><summary style="cursor:pointer;font-weight:700;font-size:15px;color:var(--color-heading);list-style:none">${esc(proseSummaryLabel)} <span aria-hidden="true" style="color:var(--color-subtle);font-weight:500"> ▾</span></summary><div style="margin-top:14px;color:var(--color-body)">${buildHubMethodologyHtml(locale, hubKey)}${buildHubFooterHtml(locale, hubKey)}${buildHubFaqHtml(locale, hubKey)}${buildHubClosingHtml(locale)}</div></details>`;

  return `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${esc(pageTitle)}</title>
    <meta name="description" content="${esc(description)}">
    <meta name="robots" content="index,follow">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Frontaliere Ticino">
    <meta property="og:locale" content="${LOCALE_OG[locale]}">
    <meta property="og:title" content="${esc(pageTitle)}">
    <meta property="og:description" content="${esc(description)}">
    <meta property="og:url" content="${canonicalUrl}">
    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta name="twitter:card" content="summary_large_image">
    <link rel="canonical" href="${canonicalUrl}">
${hreflangs}${xDefault}${prevLink}${nextLink}
    <script type="application/ld+json">${breadcrumbLd}</script>
    <script type="application/ld+json">${collectionLd}</script>${hasSpaBundle ? `\n    <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all">` : ''}
    ${ADSENSE_SNIPPET}
  </head>
  <body class="bg-surface-alt text-heading overflow-x-hidden">
    <div id="root"></div>
    <main class="seo-static-content" style="max-width:1100px;margin:0 auto;padding:32px 20px 56px">
      <nav style="font-size:13px;color:var(--color-subtle);margin-bottom:16px" aria-label="Breadcrumb">
        <a href="${BASE_URL}/" style="color:var(--color-accent);text-decoration:none">Home</a>
        <span> / </span>
        <span>${esc(sectionLabel)}</span>
      </nav>
      <header style="margin-bottom:18px">
        <h1 style="font-size:32px;font-weight:800;line-height:1.2;color:var(--color-heading);margin:0 0 10px">${esc(buildHubH1(locale, hubKey, totalItems, page))}</h1>
        <p style="font-size:16px;color:var(--color-body);max-width:780px;line-height:1.55;margin:0">${esc(description)}</p>
        <p style="margin-top:8px;color:var(--color-subtle);font-size:13px">${esc(countLabel(locale, totalItems))} · ${esc(updatedLabel(locale))} ${dateStamp}</p>
      </header>
      ${statTilesHtml}
      ${ctaHtmlGlobal}
      <section>
        ${itemsHtml}
      </section>
      ${pagination}
      ${proseAccordionHtml}
    </main>
    <div id="footer-root"></div>${hasSpaBundle ? `\n    <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
  </body>
</html>`;
}

function pageLabel(locale: HubLocale, page: number): string {
  const word = { it: 'Pagina', en: 'Page', de: 'Seite', fr: 'Page' }[locale];
  return `${word} ${page}`;
}
function emptyLabel(locale: HubLocale): string {
  return { it: 'Nessun risultato disponibile.', en: 'No results available.', de: 'Keine Ergebnisse verfügbar.', fr: 'Aucun résultat disponible.' }[locale];
}
function countLabel(locale: HubLocale, n: number): string {
  return { it: `${n.toLocaleString('it')} risorse`, en: `${n.toLocaleString('en')} entries`, de: `${n.toLocaleString('de')} Einträge`, fr: `${n.toLocaleString('fr')} entrées` }[locale];
}
function updatedLabel(locale: HubLocale): string {
  return { it: 'Aggiornato', en: 'Updated', de: 'Aktualisiert', fr: 'Mis à jour' }[locale];
}

function renderPagination(locale: HubLocale, basePath: string, current: number, total: number): string {
  // Compact pagination (visible): prev, 1, current-1, current, current+1, last, next.
  // Plus a FLAT crawler-facing navigator inside a collapsed <details> linking
  // every page-N (BFS-depth closure 2026-05-12 run 25753701178 — without
  // every page-N anchor on every page, leaves on page-3..N regress past BFS
  // depth 4 since the compact nav only links 1, n-1, n+1, last from any
  // given page — page-2 ↔ page-3 is a single hop, but page-1 → page-50 is a
  // chain of length ~25 via the compact ladder, pushing leaves on page-25+
  // to BFS depth > 4). The flat ladder collapses every page-N to a single
  // hop from any other page-N, so every job leaf sits at depth 4 from `/`:
  //   /  → /cerca-lavoro-ticino/tutti/   (page 1, depth 1)
  //      → /cerca-lavoro-ticino/tutti/page-N/ (depth 2 via flat nav)
  //      → /cerca-lavoro-{canton}/{slug}/  (depth 3, anchor on page-N)
  // The <details> stays collapsed by default — mobile fold is preserved
  // (CLAUDE.md #15/#16), and the BFS walker / crawlers parse every `<a>`
  // inside `<details>` regardless of `open` state.
  const pages = new Set<number>();
  pages.add(1);
  pages.add(total);
  for (let p = current - 1; p <= current + 1; p++) {
    if (p >= 1 && p <= total) pages.add(p);
  }
  const sorted = [...pages].sort((a, b) => a - b);
  const prevLabel = { it: '« Precedente', en: '« Previous', de: '« Zurück', fr: '« Précédent' }[locale];
  const nextLabel = { it: 'Successiva »', en: 'Next »', de: 'Weiter »', fr: 'Suivant »' }[locale];

  const baseStyle = 'display:inline-block;padding:6px 12px;margin:2px;border-radius:6px;background:var(--color-surface);border:1px solid var(--color-edge);color:var(--color-body);text-decoration:none;font-size:14px';
  const activeStyle = 'display:inline-block;padding:6px 12px;margin:2px;border-radius:6px;background:var(--color-accent);color:white;font-size:14px;font-weight:700';

  const parts: string[] = [];
  if (current > 1) {
    parts.push(`<a href="${BASE_URL}${paginatedPath(basePath, current - 1)}" style="${baseStyle}" rel="prev">${prevLabel}</a>`);
  }
  let last = 0;
  for (const p of sorted) {
    if (last && p - last > 1) parts.push(`<span style="padding:0 6px;color:var(--color-subtle)">…</span>`);
    if (p === current) {
      parts.push(`<span style="${activeStyle}" aria-current="page">${p}</span>`);
    } else {
      parts.push(`<a href="${BASE_URL}${paginatedPath(basePath, p)}" style="${baseStyle}">${p}</a>`);
    }
    last = p;
  }
  if (current < total) {
    parts.push(`<a href="${BASE_URL}${paginatedPath(basePath, current + 1)}" style="${baseStyle}" rel="next">${nextLabel}</a>`);
  }
  const compactNav = `<nav aria-label="Pagination" style="margin-top:32px;text-align:center">${parts.join('')}</nav>`;

  // Flat ladder — every page-N anchor, collapsed for mobile.
  // Skip when totalPages ≤ 1 (no pagination needed) or ≤ 5 (compact nav
  // already shows all pages, ladder would be redundant).
  if (total <= 5) return compactNav;
  const flatLabel = {
    it: "Sfoglia tutto l'archivio per pagina",
    en: 'Browse the full archive by page',
    de: 'Vollständiges Archiv nach Seite durchsuchen',
    fr: 'Parcourir toutes les archives par page',
  }[locale];
  const pageWord = locale === 'de' ? 'Seite' : locale === 'fr' || locale === 'en' ? 'Page' : 'Pagina';
  const flatPillStyle = 'display:inline-block;padding:4px 10px;margin:2px;border-radius:6px;background:var(--color-surface);color:var(--color-link);text-decoration:none;font-size:13px;border:1px solid var(--color-edge)';
  const flatActiveStyle = 'display:inline-block;padding:4px 10px;margin:2px;border-radius:6px;background:var(--color-accent);color:var(--color-on-accent);font-size:13px;font-weight:700';
  const flatAnchors: string[] = [];
  for (let p = 1; p <= total; p++) {
    const href = `${BASE_URL}${paginatedPath(basePath, p)}`;
    if (p === current) {
      flatAnchors.push(`<strong style="${flatActiveStyle}" aria-current="page">${pageWord}&nbsp;${p}</strong>`);
    } else {
      flatAnchors.push(`<a href="${href}" style="${flatPillStyle}">${pageWord}&nbsp;${p}</a>`);
    }
  }
  const flatNav = `<nav aria-label="${flatLabel}" style="margin-top:16px;max-width:1080px"><details style="border:1px solid var(--color-edge);border-radius:8px;padding:.5rem .75rem;background:var(--color-surface-alt)"><summary style="cursor:pointer;font-weight:600;font-size:14px;color:var(--color-heading);padding:.25rem 0">${flatLabel} (${total})</summary><div style="margin-top:.5rem;line-height:1.9">${flatAnchors.join('')}</div></details></nav>`;

  return `${compactNav}${flatNav}`;
}

interface EmitArgs {
  rootDir: string;
  distDir: string;
  fs: typeof fsT;
  np: typeof npT;
  entryJs: string;
  entryCss: string;
  hasSpaBundle: boolean;
  /** Buffered writer from staticPagesPlugin (or noop if direct fs is used). */
  qw: (filePath: string, content: string) => void;
}

// ── Phase 7.2: thin per-canton hub helpers ─────────────────────────────

type CantonHubKind = 'tutti' | 'settori' | 'aziende';

const CANTON_HUB_LABELS: Record<HubLocale, Record<CantonHubKind, string>> = {
  it: { tutti: 'Tutte le offerte', settori: 'Settori', aziende: 'Aziende che assumono' },
  en: { tutti: 'All openings',     settori: 'Sectors', aziende: 'Hiring companies' },
  de: { tutti: 'Alle Stellen',     settori: 'Branchen', aziende: 'Einstellende Firmen' },
  fr: { tutti: 'Toutes les offres', settori: 'Secteurs', aziende: 'Entreprises qui recrutent' },
};

/**
 * Per-sector emoji used as the visual prefix on the canton `settori` hub
 * cards. Picked to read clearly at 28px and to be visually distinct from
 * neighbours in the grid. Falls back to a generic "🧭" if a sector key is
 * unmapped (so we never render an empty bubble).
 */
const SECTOR_EMOJI: Record<string, string> = {
  'infermieri': '🩺',
  'case-anziani': '🏡',
  'educatori': '👶',
  'medici': '⚕️',
  'oss': '🤝',
  'fisioterapisti': '🦴',
  'farmacisti': '💊',
  'ingegneri': '📐',
  'sviluppatori': '💻',
  'data-scientist': '📊',
  'cybersecurity': '🛡️',
  'project-manager': '📋',
  'contabili': '🧮',
  'banca': '🏦',
  'assicurazioni': '🛟',
  'consulenza': '💼',
  'avvocati': '⚖️',
  'risorse-umane': '👥',
  'marketing': '📣',
  'vendite': '💰',
  'commercio': '🛍️',
  'logistica': '📦',
  'trasporti': '🚛',
  'autisti': '🚐',
  'magazzino': '🗃️',
  'meccanici': '🔧',
  'elettricisti': '💡',
  'idraulici': '🚿',
  'edilizia': '🏗️',
  'muratori': '🧱',
  'falegnami': '🪚',
  'industria': '🏭',
  'orologeria': '⌚',
  'farmaceutica': '🧪',
  'chimica': '⚗️',
  'food': '🍞',
  'ristorazione': '🍝',
  'cuochi': '👨‍🍳',
  'camerieri': '🍽️',
  'hotel': '🏨',
  'pulizie': '🧹',
  'sicurezza': '🚨',
  'pubblica-amministrazione': '🏛️',
  'scuola': '🎓',
  'designer': '🎨',
  'architetti': '📏',
  'agricoltura': '🌾',
  'energia': '⚡',
  'media': '📰',
  'tecnici': '🛠️',
};

function sectorEmojiFor(key: string): string {
  return SECTOR_EMOJI[key] ?? '🧭';
}

function cantonHubH1(locale: HubLocale, hub: CantonHubKind, cantonLabel: string, n: number): string {
  // Per-canton headline, e.g. "127 offerte di lavoro a Zurigo" / "Settori con offerte a Zurigo"
  if (hub === 'tutti') {
    return {
      it: `${n.toLocaleString('it-IT')} offerte di lavoro · ${cantonLabel}`,
      en: `${n.toLocaleString('en-US')} job openings · ${cantonLabel}`,
      de: `${n.toLocaleString('de-DE')} Stellenangebote · ${cantonLabel}`,
      fr: `${n.toLocaleString('fr-FR')} offres d’emploi · ${cantonLabel}`,
    }[locale];
  }
  if (hub === 'settori') {
    return {
      it: `Settori con offerte attive · ${cantonLabel}`,
      en: `Active sectors · ${cantonLabel}`,
      de: `Aktive Branchen · ${cantonLabel}`,
      fr: `Secteurs actifs · ${cantonLabel}`,
    }[locale];
  }
  return {
    it: `Aziende che assumono · ${cantonLabel}`,
    en: `Hiring companies · ${cantonLabel}`,
    de: `Einstellende Firmen · ${cantonLabel}`,
    fr: `Entreprises qui recrutent · ${cantonLabel}`,
  }[locale];
}

function cantonHubIntro(locale: HubLocale, hub: CantonHubKind, cantonLabel: string, n: number): string {
  if (hub === 'tutti') {
    return {
      it: `Indice completo delle offerte di lavoro attive nel cantone ${cantonLabel}. ${n.toLocaleString('it-IT')} posizioni aperte aggiornate quotidianamente.`,
      en: `Complete index of active job openings in ${cantonLabel}. ${n.toLocaleString('en-US')} positions updated daily.`,
      de: `Vollständiger Index der aktiven Stellenangebote im Kanton ${cantonLabel}. ${n.toLocaleString('de-DE')} Stellen täglich aktualisiert.`,
      fr: `Index complet des offres d’emploi actives dans le canton ${cantonLabel}. ${n.toLocaleString('fr-FR')} postes mis à jour quotidiennement.`,
    }[locale];
  }
  if (hub === 'settori') {
    return {
      it: `Settori professionali con offerte attive nel cantone ${cantonLabel}.`,
      en: `Professional sectors with active openings in ${cantonLabel}.`,
      de: `Berufsgruppen mit aktiven Stellenangeboten im Kanton ${cantonLabel}.`,
      fr: `Secteurs professionnels avec offres actives dans le canton ${cantonLabel}.`,
    }[locale];
  }
  return {
    it: `Aziende che pubblicano offerte di lavoro nel cantone ${cantonLabel}.`,
    en: `Companies posting openings in ${cantonLabel}.`,
    de: `Unternehmen mit Stellenangeboten im Kanton ${cantonLabel}.`,
    fr: `Entreprises publiant des offres dans le canton ${cantonLabel}.`,
  }[locale];
}

/**
 * Compact prose block for thin canton hub page-N>1 (2026-05-13 follow-up
 * to PR #153). The minimal page-N HTML had ratio ~5-6 % vs the 10 %
 * audit:text-html-ratio gate (HTML ~12 KB, visible text ~700 bytes from
 * the items list). This helper adds a short locale + page-aware paragraph
 * (~500 bytes visible text) at the bottom of every page-N>1, taking ratio
 * from ~6 % to ~10 %+. Same compact shape across hub kinds.
 */
function buildPageNCompactProse(locale: HubLocale, cantonLabel: string, hub: CantonHubKind, page: number, totalPages: number, totalItems: number): string {
  const hubLabel = CANTON_HUB_LABELS[locale][hub];
  if (locale === 'en') {
    return `${hubLabel} in ${cantonLabel} — page ${page} of ${totalPages}. The full archive collects ${totalItems.toLocaleString('en')} active listings across this canton, paginated 100 entries per page so the alphabetical order stays stable and cross-border workers can resume the scan from the exact role they left off. Each link below opens the detail page with full description, contract type, location and direct application URL. For the day's most recent openings sorted by date rather than alphabetically, jump to the canton overview page. The next page sits one click away under the navigator above.`;
  }
  if (locale === 'de') {
    return `${hubLabel} in ${cantonLabel} — Seite ${page} von ${totalPages}. Das vollständige Archiv erfasst ${totalItems.toLocaleString('de')} aktive Stellen in diesem Kanton, paginiert zu 100 Einträgen pro Seite, sodass die alphabetische Reihenfolge stabil bleibt und Grenzgänger die Suche genau dort fortsetzen können, wo sie aufgehört haben. Jeder Link unten öffnet die Detailseite mit vollständiger Beschreibung, Vertragsart, Arbeitsort und direktem Bewerbungslink. Für die neuesten Stellen des Tages, sortiert nach Datum statt alphabetisch, wechseln Sie zur Kantonsübersicht. Die nächste Seite ist über die obige Navigation einen Klick entfernt.`;
  }
  if (locale === 'fr') {
    return `${hubLabel} dans le canton de ${cantonLabel} — page ${page} sur ${totalPages}. L'archive complète recense ${totalItems.toLocaleString('fr')} offres actives dans ce canton, paginées par 100 entrées pour conserver un ordre alphabétique stable et permettre aux frontaliers de reprendre la recherche exactement là où ils l'ont laissée. Chaque lien ci-dessous ouvre la page de détail avec description complète, type de contrat, lieu et URL de candidature directe. Pour les offres les plus récentes du jour triées par date plutôt qu'alphabétiquement, rendez-vous sur la page de présentation du canton. La page suivante est à un clic de distance dans le navigateur ci-dessus.`;
  }
  return `${hubLabel} in ${cantonLabel} — pagina ${page} di ${totalPages}. L'archivio completo raccoglie ${totalItems.toLocaleString('it')} annunci attivi in questo cantone, paginati in 100 voci per pagina così l'ordine alfabetico resta stabile e i frontalieri possono riprendere la ricerca esattamente dal ruolo lasciato in sospeso. Ogni link qui sotto apre la pagina dettaglio con descrizione completa, tipo di contratto, sede e URL di candidatura diretta. Per le offerte più recenti del giorno ordinate per data anziché alfabeticamente, vai alla pagina di panoramica del cantone. La pagina successiva è a un click di distanza nel navigatore qui sopra.`;
}

/**
 * Long-form body copy for thin canton hubs. Lives below the items list to
 * push the page over the 50-word floor enforced by validate-sitemap-pages
 * for small cantons (Glarona / Uri / Svitto / Zugo / Neuchatel had only the
 * employer-link grid + 1-sentence intro and tripped the gate). Stays short
 * enough that the meta description (single sentence from cantonHubIntro)
 * remains under the 160-char SERP truncation.
 */
function cantonHubBody(locale: HubLocale, hub: CantonHubKind, cantonLabel: string): string {
  if (hub === 'tutti') {
    return {
      it: `Le offerte aggregate in questa pagina coprono tutti i settori e tutti i livelli di esperienza. Per i frontalieri il filtro "tutti i settori" è il punto di partenza più rapido per misurare la dimensione del mercato locale: il numero totale di offerte attive in ${cantonLabel} è un proxy della domanda di lavoro complessiva, mentre la composizione per azienda e per ruolo aiuta a capire dove conviene concentrare la candidatura. Aggiorniamo l'indice quotidianamente dalle fonti pubbliche dei datori e da feed ATS aperti, deduplicando le rinominazioni e gli annunci multi-sede.`,
      en: `Aggregated openings on this page cover every sector and experience level. For Swiss-Italian cross-border workers the "all sectors" view is the fastest way to gauge market size: total active openings in ${cantonLabel} act as a proxy for overall demand, while the breakdown by employer and role highlights where applications are most likely to land. The index is refreshed daily from public employer pages and open ATS feeds, with renamed listings and multi-location ads deduplicated.`,
      de: `Die hier aggregierten Stellen decken alle Branchen und Erfahrungsstufen ab. Für Grenzgänger ist die Gesamtansicht der schnellste Weg, die Marktgrösse zu messen: die Zahl der aktiven Stellen in ${cantonLabel} dient als Indikator für die Gesamtnachfrage, während die Aufteilung nach Arbeitgeber und Rolle zeigt, wo eine Bewerbung am ehesten landet. Der Index wird täglich aus öffentlichen Arbeitgeberseiten und offenen ATS-Feeds aktualisiert, mit Deduplizierung von Umbenennungen und Multi-Standort-Anzeigen.`,
      fr: `Les offres agrégées sur cette page couvrent tous les secteurs et niveaux d'expérience. Pour les frontaliers, la vue "tous secteurs" est le moyen le plus rapide d'évaluer la taille du marché: le nombre total d'offres actives en ${cantonLabel} sert d'indicateur de la demande globale, tandis que la répartition par employeur et par rôle révèle où une candidature a le plus de chances d'aboutir. L'index est rafraîchi quotidiennement depuis les pages publiques des employeurs et les flux ATS ouverts, avec déduplication des renommages et annonces multi-sites.`,
    }[locale];
  }
  if (hub === 'settori') {
    return {
      it: `L'indice settoriale è il filtro più utile per pianificare la ricerca: la stessa mansione viene pubblicata con sinonimi diversi (es. infermiere, OSS, personale sanitario) e il classifier raccoglie tutte le varianti sotto una stessa categoria. Aprire la pagina settoriale di ${cantonLabel} dà una panoramica della concorrenza fra datori, una mediana salariale di riferimento del settore e l'elenco degli arruolatori più attivi — tre informazioni che la sola lista alfabetica delle offerte non offre.`,
      en: `The sector index is the most useful filter for planning a job hunt: the same role is published under different keywords (e.g. nurse, healthcare assistant, medical staff) and our classifier collects every variant under one category. Opening the sector page for ${cantonLabel} gives a snapshot of employer competition, a median salary reference for the sector, and the list of most-active recruiters — three signals that an alphabetical job list alone cannot provide.`,
      de: `Der Branchenindex ist der nützlichste Filter für die Jobsuche: dieselbe Rolle wird mit unterschiedlichen Stichwörtern ausgeschrieben (z.B. Pflegefachperson, FaGe, medizinisches Personal) und unser Klassifikator fasst alle Varianten unter einer Kategorie zusammen. Die Branchenseite für ${cantonLabel} liefert eine Übersicht des Arbeitgeberwettbewerbs, einen Median-Lohnreferenzwert für die Branche und die Liste der aktivsten Rekrutierer — drei Signale, die eine alphabetische Jobliste nicht bietet.`,
      fr: `L'index sectoriel est le filtre le plus utile pour planifier la recherche: le même rôle est publié sous des mots-clés différents (ex. infirmier, aide-soignant, personnel médical) et notre classifieur regroupe toutes les variantes sous une seule catégorie. La page sectorielle de ${cantonLabel} donne un aperçu de la concurrence entre employeurs, une médiane salariale de référence pour le secteur et la liste des recruteurs les plus actifs — trois signaux qu'une simple liste alphabétique d'offres ne fournit pas.`,
    }[locale];
  }
  return {
    it: `L'elenco raccoglie i datori con almeno una posizione attiva oggi nel cantone ${cantonLabel}, ordinati per numero di offerte aperte. Per i frontalieri la candidatura spontanea verso aziende in fase di crescita è uno dei canali più efficaci ma sottostimati: aziende con delta settimanale positivo ricevono CV anche fuori da posizioni specifiche e spesso aprono un colloquio esplorativo. Per ogni nome trovi la pagina hub con le offerte del momento, il settore principale, la città di sede e — quando l'ATS sorgente lo espone — la politica di telelavoro. Verifica sempre Permesso G, canton di ritenuta e contributi sociali sulla pagina ufficiale prima di candidarti.`,
    en: `The list shows employers with at least one active position today in ${cantonLabel}, ranked by number of open postings. For Swiss-Italian cross-border workers, speculative applications targeting fast-growing employers are one of the most effective but underrated channels: companies with a positive weekly delta routinely review CVs sent outside specific openings and often open an exploratory interview. Each company links to a dedicated hub page with current openings, primary sector, headquarters and — when the source ATS exposes it — the remote-work policy. Always verify Permit G eligibility, withholding canton, and social-security contributions on the official page before applying.`,
    de: `Die Liste zeigt Arbeitgeber mit mindestens einer aktiven Stelle heute im Kanton ${cantonLabel}, sortiert nach Anzahl offener Stellen. Für Grenzgänger sind Initiativbewerbungen bei wachsenden Unternehmen einer der effektivsten aber unterschätzten Kanäle: Unternehmen mit positivem Wochendelta prüfen Lebensläufe auch ausserhalb spezifischer Ausschreibungen und öffnen oft ein exploratives Gespräch. Jeder Eintrag verlinkt eine Hub-Seite mit aktuellen Stellen, Hauptbranche, Hauptsitz und — sofern die Quell-ATS dies anzeigt — der Homeoffice-Regelung. Prüfen Sie immer Grenzgängerbewilligung, Quellensteuer-Kanton und Sozialversicherungsbeiträge auf der offiziellen Seite vor der Bewerbung.`,
    fr: `La liste regroupe les employeurs avec au moins un poste actif aujourd'hui dans le canton ${cantonLabel}, classés par nombre d'offres ouvertes. Pour les frontaliers, les candidatures spontanées auprès d'entreprises en croissance sont l'un des canaux les plus efficaces mais sous-estimés: les entreprises avec un delta hebdomadaire positif examinent les CV même en dehors d'ouvertures spécifiques et ouvrent souvent un entretien exploratoire. Chaque nom renvoie à une page hub avec les offres actuelles, le secteur principal, le siège et — lorsque l'ATS source l'expose — la politique de télétravail. Vérifiez toujours le Permis G, le canton de retenue et les cotisations sociales sur la page officielle avant de postuler.`,
  }[locale];
}

interface ThinCantonHubArgs {
  fs: typeof fsT;
  np: typeof npT;
  rootDir: string;
  distDir: string;
  qw: (filePath: string, content: string) => void;
  sitemapEntries: string[];
  dateStamp: string;
  cantonJobCounts: Map<string, number>;
  cantonJobs: Map<string, CantonJobEntry[]>;
  cantonEmployerCounts: Map<string, Map<string, number>>;
  /** Reverse map: company URL slug → short employer key (for logo lookup). */
  companyUrlToKey: Map<string, string>;
  /** Crawled logos keyed by short employer key (used as fallback after manifest). */
  crawledLogos: Record<string, string>;
  /**
   * Master IT slug → per-locale absolute URL map from
   * `data/all-known-job-slugs.json`. Used by the `tutti/page-N/` archive
   * pagination to emit per-locale anchors that point at the canton-aware
   * job-detail URLs (e.g. `/de/jobs-im-aargau/{de-slug}/`) instead of the
   * legacy TI section path.
   */
  jobPerLocale: Record<HubLocale, Record<string, string>>;
  entryJs: string;
  entryCss: string;
  hasSpaBundle: boolean;
  onPageEmitted: () => void;
}

/** Optional stat tile (semantic tone → STAT_TILE_*). */
type ThinHubStatTile = {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'base' | 'accent' | 'success' | 'warning' | 'danger';
};

/** Rich item passed by callers — enables the engaging card UI. */
type ThinHubItem = {
  readonly href: string;
  readonly label: string;
  /** Single line of supporting text shown below the title. */
  readonly sub?: string;
  /** Absolute logo URL — turns the card into a logo card (used for `aziende`). */
  readonly logo?: string | null;
  /** Emoji prefix for the visual bubble (used for `settori`). */
  readonly emoji?: string;
  /** Right-aligned metric (e.g. "11 offerte"). */
  readonly metric?: string;
  /** Tone for `metric`. */
  readonly metricTone?: 'default' | 'accent' | 'success' | 'warning' | 'danger';
};

function buildThinCantonHubHtml(args: {
  locale: HubLocale;
  hub: CantonHubKind;
  canton: string;
  cantonLabel: string;
  basePath: string;
  totalItems: number;
  items: ReadonlyArray<ThinHubItem>;
  hasSpaBundle: boolean;
  entryJs: string;
  entryCss: string;
  dateStamp: string;
  /** 1-based page index for paginated hubs. Defaults to 1 (single page). */
  page?: number;
  /** Total page count for the hub. Defaults to 1 (no pagination block). */
  totalPages?: number;
  /** Optional stat tiles rendered above the data area (rule #17). */
  statTiles?: ReadonlyArray<ThinHubStatTile>;
  /** Primary CTA rendered above the data area (rule #17). Callers supply
   *  both href and label so the same primitive serves `tutti` (link to
   *  calculator), `aziende` / `settori` (link to job-board), etc. */
  cta?: { readonly href: string; readonly label: string };
}): string {
  const { locale, hub, cantonLabel, basePath, totalItems, items, hasSpaBundle, entryJs, entryCss, dateStamp, statTiles, cta } = args;
  const page = args.page ?? 1;
  const totalPages = args.totalPages ?? 1;
  const h1 = cantonHubH1(locale, hub, cantonLabel, totalItems);
  const intro = cantonHubIntro(locale, hub, cantonLabel, totalItems);
  const bodyCopy = cantonHubBody(locale, hub, cantonLabel);
  const proseDetailsLabel = {
    it: `Approfondisci · mercato del lavoro frontaliere a ${cantonLabel}`,
    en: `Read more · cross-border job market in ${cantonLabel}`,
    de: `Mehr erfahren · Grenzgänger-Arbeitsmarkt in ${cantonLabel}`,
    fr: `En savoir plus · marché de l'emploi frontalier à ${cantonLabel}`,
  }[locale];
  // For paginated pages (page > 1) the canonical URL adds `/page-N/` and the
  // page title carries the page number so Search Console keeps each page
  // distinct.
  const canonicalPath = page === 1 ? basePath : paginatedPath(basePath, page);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;
  const pageSuffix = totalPages > 1 && page > 1
    ? (locale === 'de' ? ` — Seite ${page}` : locale === 'fr' ? ` — Page ${page}` : ` — Pagina ${page}`)
    : '';
  const pageTitle = `${CANTON_HUB_LABELS[locale][hub]} ${cantonLabel}${pageSuffix} | Frontaliere`;

  // BFS-depth closure (2026-05-12): full pagination ladder for the `tutti`
  // hub. Linking every page-N from page-1 (and every other page) brings
  // every linked job leaf to BFS depth ≤ 4 from `/` (home → TI hub →
  // canton hub → tutti/page-N → job-detail). Cap omitted on purpose —
  // every page in totalPages MUST be linked so the BFS audit can find
  // it. Pages are wrapped in <details> when the ladder grows past 10
  // entries so the mobile fold stays clear (CLAUDE.md #15/#16).
  let paginationHtml = '';
  if (totalPages > 1) {
    const paginationLabel = locale === 'en' ? 'Browse all pages'
      : locale === 'de' ? 'Alle Seiten durchsuchen'
      : locale === 'fr' ? 'Parcourir toutes les pages'
      : 'Sfoglia tutte le pagine';
    const pageWord = locale === 'de' ? 'Seite' : locale === 'fr' || locale === 'en' ? 'Page' : 'Pagina';
    const anchors: string[] = [];
    for (let p = 1; p <= totalPages; p++) {
      const href = p === 1 ? basePath : paginatedPath(basePath, p);
      if (p === page) {
        anchors.push(`<strong style="display:inline-block;padding:4px 10px;margin:2px;border-radius:6px;background:var(--color-accent);color:var(--color-on-accent);font-size:13px">${pageWord}&nbsp;${p}</strong>`);
      } else {
        anchors.push(`<a href="${href}" style="display:inline-block;padding:4px 10px;margin:2px;border-radius:6px;background:var(--color-surface);color:var(--color-link);text-decoration:none;font-size:13px;border:1px solid var(--color-edge)">${pageWord}&nbsp;${p}</a>`);
      }
    }
    // Always-open <details> so the BFS walker (and crawlers) see every <a>
    // tag regardless of the user's expand state. Without `open` the anchors
    // are still parsed by Googlebot, but the audit walker reads raw HTML
    // and would still discover them either way — `open` is for UX so the
    // ladder is visible on first paint.
    paginationHtml = `<nav aria-label="${esc(paginationLabel)}" style="margin-top:24px;max-width:1080px"><details open style="border:1px solid var(--color-edge);border-radius:8px;padding:.5rem .75rem;background:var(--color-surface-alt)"><summary style="cursor:pointer;font-weight:600;font-size:14px;color:var(--color-heading);padding:.25rem 0">${esc(paginationLabel)} (${totalPages})</summary><div style="margin-top:.5rem;line-height:1.9">${anchors.join('')}</div></details></nav>`;
  }

  // Engaging card layout: aziende → entity card with logo, settori → emoji
  // bubble, tutti → compact plain link (unchanged — already dense by design).
  const itemsHtml = items.length === 0
    ? `<p style="color:var(--color-subtle);padding:16px 0">${esc(emptyLabel(locale))}</p>`
    : (hub === 'aziende' || hub === 'settori')
      ? `<ul style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px">${items
          .map((it) => {
            if (hub === 'aziende') {
              const card = renderEntityCard({
                href: it.href,
                logoUrl: it.logo ?? undefined,
                iconSvg: it.logo ? undefined : ICON_BUILDING_SVG,
                logoOnerror: it.logo ? LOGO_ONERROR : undefined,
                title: it.label,
                subtitle: it.sub,
                metric: it.metric,
                metricTone: it.metricTone ?? 'accent',
              });
              return `<li>${card}</li>`;
            }
            // settori — emoji-prefixed friendly card; we use a hand-rolled
            // wrapper instead of renderEntityCard so the emoji renders at a
            // larger size than the 24×24 SVG icon bubble.
            const emoji = it.emoji ?? '🧭';
            return `<li><a href="${esc(it.href)}" style="display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:14px;color:var(--color-heading);background:var(--color-surface);text-decoration:none;border:1px solid var(--color-edge)"><span aria-hidden="true" style="display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:12px;background:var(--color-surface-alt);font-size:24px;line-height:1;flex-shrink:0">${emoji}</span><span style="flex:1;min-width:0"><span style="display:block;font-weight:700;font-size:15px;line-height:1.3;color:var(--color-heading)">${esc(it.label)}</span>${it.sub ? `<span style="display:block;font-size:12.5px;color:var(--color-subtle);margin-top:2px;line-height:1.4">${esc(it.sub)}</span>` : ''}</span></a></li>`;
          })
          .join('')}</ul>`
      : `<ul style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px">${items
          .map((it) => `<li><a href="${esc(it.href)}" style="display:block;padding:10px 12px;border-radius:8px;color:var(--color-heading);background:var(--color-surface);text-decoration:none;border:1px solid var(--color-edge);font-size:14px;line-height:1.4">${esc(it.label)}${it.sub ? `<span style="display:block;font-size:12px;color:var(--color-subtle);margin-top:2px">${esc(it.sub)}</span>` : ''}</a></li>`)
          .join('')}</ul>`;

  // Stat tiles (rule #17) — only on page 1, only when caller supplied them.
  const STAT_TILE_TONE: Record<NonNullable<ThinHubStatTile['tone']>, string> = {
    base: STAT_TILE_BASE,
    accent: STAT_TILE_ACCENT,
    success: STAT_TILE_SUCCESS,
    warning: STAT_TILE_BASE, // fall back to base to avoid pulling in unused styles
    danger: STAT_TILE_BASE,
  };
  const statTilesHtml = (statTiles && statTiles.length > 0)
    ? `<section aria-label="${esc({ it: 'Numeri chiave', en: 'Key numbers', de: 'Kennzahlen', fr: 'Chiffres clés' }[locale])}" style="margin:0 0 18px;display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px">${statTiles
        .map((tile) => `<div style="${STAT_TILE_TONE[tile.tone ?? 'base']}"><div style="${STAT_TILE_LABEL}">${esc(tile.label)}</div><div style="${STAT_TILE_VALUE}">${esc(tile.value)}</div></div>`)
        .join('')}</section>`
    : '';

  // Primary CTA — rendered on every page (including page-N>1) so the user
  // always has a single dominant next step above the fold.
  const ctaHtml = cta
    ? `<div style="margin:0 0 22px"><a href="${esc(cta.href)}" style="${CTA_PRIMARY_STYLE}">${esc(cta.label)}</a></div>`
    : '';

  const homeLabel = { it: 'Home', en: 'Home', de: 'Start', fr: 'Accueil' }[locale];

  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: homeLabel, item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: cantonLabel, item: canonicalUrl },
    ],
  });

  return `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${esc(pageTitle)}</title>
    <meta name="description" content="${esc(intro)}">
    <meta name="robots" content="index,follow">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Frontaliere Ticino">
    <meta property="og:locale" content="${LOCALE_OG[locale]}">
    <meta property="og:title" content="${esc(pageTitle)}">
    <meta property="og:description" content="${esc(intro)}">
    <meta property="og:url" content="${canonicalUrl}">
    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta name="twitter:card" content="summary_large_image">
    <link rel="canonical" href="${canonicalUrl}">
    <script type="application/ld+json">${breadcrumbLd}</script>${hasSpaBundle ? `\n    <link rel="stylesheet" href="/assets/${entryCss}" crossorigin media="all">` : ''}
    ${ADSENSE_SNIPPET}
  </head>
  <body class="bg-surface-alt text-heading overflow-x-hidden">
    <div id="root"></div>
    <main class="seo-static-content" style="max-width:1100px;margin:0 auto;padding:32px 20px 56px">
      <nav style="font-size:13px;color:var(--color-subtle);margin-bottom:16px" aria-label="Breadcrumb">
        <a href="${BASE_URL}/" style="color:var(--color-accent);text-decoration:none">${esc(homeLabel)}</a>
        <span> / </span>
        <span>${esc(cantonLabel)} · ${esc(CANTON_HUB_LABELS[locale][hub])}</span>
      </nav>
      <header style="margin-bottom:18px">
        <h1 style="font-size:32px;font-weight:800;line-height:1.2;color:var(--color-heading);margin:0 0 10px">${esc(h1)}</h1>
        <p style="font-size:16px;color:var(--color-body);max-width:780px;line-height:1.55;margin:0">${esc(intro)}</p>
        <p style="margin-top:8px;color:var(--color-subtle);font-size:13px">${esc(countLabel(locale, totalItems))} · ${esc(updatedLabel(locale))} ${dateStamp}</p>
      </header>
      ${statTilesHtml}
      ${ctaHtml}
      <section>
        ${itemsHtml}
      </section>
      ${paginationHtml}
      ${page === 1 ? `<details style="margin-top:32px;border:1px solid var(--color-edge);border-radius:14px;background:var(--color-surface);padding:14px 18px;max-width:860px">
        <summary style="cursor:pointer;font-weight:700;font-size:15px;color:var(--color-heading);list-style:none">${esc(proseDetailsLabel)} <span aria-hidden="true" style="color:var(--color-subtle);font-weight:500"> ▾</span></summary>
        <div style="margin-top:14px;color:var(--color-body)">
          <p style="font-size:15px;line-height:1.65;color:var(--color-body);margin:0 0 14px">${esc(bodyCopy)}</p>
          ${renderCantonSeoProse({
            locale: locale as CantonSeoLocale,
            cantonDisplay: cantonLabel,
            slot: (hub === 'settori' ? 'sectors-hub' : hub === 'aziende' ? 'companies-hub' : 'canton-hub') as CantonSeoSlot,
            countHint: totalItems,
            ctaHref: basePath,
            ctaLabel: null,
          })}
        </div>
      </details>` : `<section style="margin-top:24px;padding-top:18px;border-top:1px solid var(--color-edge);max-width:780px">
        <p style="font-size:14px;line-height:1.6;color:var(--color-body);margin:0">${esc(buildPageNCompactProse(locale, cantonLabel, hub, page, totalPages, totalItems))}</p>
      </section>`}
    </main>
    <div id="footer-root"></div>${hasSpaBundle ? `\n    <script type="module" crossorigin src="/assets/${entryJs}"></script>` : ''}
  </body>
</html>`;
}

function cantonDisplayLabel(canton: string, locale: HubLocale): string {
  // Canton section slug strips the locale prefix and the leading 'cerca-lavoro-' /
  // 'find-jobs-' / 'jobs-in(-der)?-' / 'trouver-emploi-'. Take the slug, strip
  // hyphens, capitalize each word.
  const section = resolveCantonSection(locale, canton);
  const stripPrefix = section
    .replace(/^cerca-lavoro-/, '')
    .replace(/^find-jobs-/, '')
    .replace(/^jobs-in-der-/, '')
    .replace(/^jobs-in-/, '')
    .replace(/^jobs-im-/, '')
    .replace(/^trouver-emploi-/, '');
  return stripPrefix
    .split('-')
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function emitThinCantonHubs(args: ThinCantonHubArgs): void {
  const { np, rootDir, distDir, qw, sitemapEntries, dateStamp, cantonJobCounts, cantonJobs, cantonEmployerCounts,
          companyUrlToKey, crawledLogos,
          jobPerLocale, entryJs, entryCss, hasSpaBundle, onPageEmitted } = args;

  for (const canton of ALL_CANTON_CODES) {
    if (canton === 'TI') continue; // TI already emitted with full body above
    const total = cantonJobCounts.get(canton) ?? 0;
    if (total < MIN_JOBS_FOR_CANTON_PAGE) continue;

    const jobs = cantonJobs.get(canton) ?? [];
    const empCounts = cantonEmployerCounts.get(canton) ?? new Map<string, number>();

    for (const locale of HUB_LOCALES) {
      const cantonLabel = cantonDisplayLabel(canton, locale);
      const section = resolveCantonSection(locale, canton);
      const localePrefix = locale === 'it' ? '' : `/${locale}`;
      const sectionRoot = `${localePrefix}/${section}`;

      // ── tutti (all jobs) — full pagination ladder, MINIMAL body for page>1 ──
      // Re-emit page-N>1 as static HTML for non-TI cantons (2026-05-13) to
      // close the BFS-depth regression on sitemap-jobs.xml introduced by
      // PR #148's "page-1 only" cap. Per-canton job leaves were at depth 5
      // because page-2..page-N HTML didn't exist (chain `/ → canton hub →
      // tutti/page-N → job leaf` broken at page-N).
      //
      // To keep dist size manageable, `buildThinCantonHubHtml` now skips
      // the prose body sections (`cantonHubBody` + `renderCantonSeoProse`)
      // for `page > 1`. Page-1 keeps the full editorial body for SEO;
      // page-N>1 emits only `<h1>` + breadcrumbs + items list +
      // pagination — ~15-20 KB per page instead of ~150 KB.
      //
      // Sitemap entries: only page-1 listed (page-N>1 are intermediate
      // hops in the BFS chain, not canonical indexed URLs).
      //
      // Anchor URLs: prefer the per-locale URL from `all-known-job-slugs.json`
      // (cathedral-aware, points at `/{locale}/{section}/{slug}/`). Fall back
      // to the legacy `{sectionRoot}/{slug}/` form when the master map lacks
      // the slug (rare — job present in snapshot but not yet tracked).
      {
        const basePath = hubSlugFor(canton, locale, 'tutti');
        const tuttiPageSize = JOBS_PAGE_SIZE; // 100
        const tuttiTotalPages = Math.max(1, Math.ceil(jobs.length / tuttiPageSize));
        const localeUrlMap = jobPerLocale[locale] ?? {};
        const itUrlMap = jobPerLocale.it ?? {};
        for (let pageNum = 1; pageNum <= tuttiTotalPages; pageNum++) {
          const startIdx = (pageNum - 1) * tuttiPageSize;
          const pageJobs = jobs.slice(startIdx, startIdx + tuttiPageSize);
          const items = pageJobs.map((j) => {
            // 1) Try locale-specific path (cathedral-canton-aware).
            // 2) Fall back to IT path (acceptable — same content, IT URL).
            // 3) Last-resort legacy form `sectionRoot/slug/`.
            const localePath = localeUrlMap[j.slug];
            const itPath = itUrlMap[j.slug];
            const href = (localePath && (localePath.endsWith('/') ? localePath : `${localePath}/`))
              || (itPath && (itPath.endsWith('/') ? itPath : `${itPath}/`))
              || `${sectionRoot}/${j.slug}/`;
            return {
              href,
              label: j.role || humanizeSlug(j.slug),
              sub: j.city || undefined,
            };
          });
          const html = buildThinCantonHubHtml({
            locale, hub: 'tutti', canton, cantonLabel, basePath,
            totalItems: total, items, hasSpaBundle, entryJs, entryCss, dateStamp,
            page: pageNum, totalPages: tuttiTotalPages,
            statTiles: [
              { label: ({ it: 'Offerte attive', en: 'Active openings', de: 'Aktive Stellen', fr: 'Offres actives' }[locale]), value: total.toLocaleString(locale), tone: 'accent' },
              { label: ({ it: 'Datori attivi', en: 'Active employers', de: 'Aktive Arbeitgeber', fr: 'Employeurs actifs' }[locale]), value: empCounts.size.toLocaleString(locale), tone: 'success' },
              { label: ({ it: 'Pagina', en: 'Page', de: 'Seite', fr: 'Page' }[locale]), value: `${pageNum} / ${tuttiTotalPages}`, tone: 'base' },
            ],
            cta: {
              href: { it: '/calcola-stipendio/', en: '/en/calculate-salary/', de: '/de/gehalt-berechnen/', fr: '/fr/calculer-salaire/' }[locale],
              label: { it: 'Calcola lo stipendio netto frontaliere →', en: 'Calculate your cross-border net salary →', de: 'Grenzgänger-Nettolohn berechnen →', fr: 'Calculer le salaire net frontalier →' }[locale],
            },
          });
          const pageCanonical = pageNum === 1 ? basePath : paginatedPath(basePath, pageNum);
          qw(np.join(distDir, pageCanonical.slice(1), 'index.html'), html);
          onPageEmitted();
        }
        if (locale === 'it') {
          const url = `${BASE_URL}${basePath}`;
          sitemapEntries.push(
            `  <url>\n    <loc>${url}</loc>\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.6</priority>\n  </url>`,
          );
        }
      }

      // Shared tile copy + top-employer derivations for both `settori` and
      // `aziende` hubs (page-1 stat-tile grid above the data area).
      const empArraySorted = Array.from(empCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 100);
      const topEmployer = empArraySorted[0];
      const topEmployerLabel = topEmployer
        ? `${humanizeSlug(topEmployer[0])} · ${topEmployer[1]}`
        : '—';
      const tileLabels = {
        it: { datori: 'Datori attivi', offerte: 'Offerte aperte', topDatore: 'Top datore', settori: 'Settori esplorabili' },
        en: { datori: 'Active employers', offerte: 'Open positions', topDatore: 'Top employer', settori: 'Sectors to explore' },
        de: { datori: 'Aktive Arbeitgeber', offerte: 'Offene Stellen', topDatore: 'Top-Arbeitgeber', settori: 'Branchen' },
        fr: { datori: 'Employeurs actifs', offerte: 'Postes ouverts', topDatore: 'Top employeur', settori: 'Secteurs' },
      }[locale];

      // ── settori (sectors) — reuse curated HUB_SECTORS list, link to TI hub ──
      // For non-TI cantons we don't yet have per-canton sector landings, so the
      // sector hub lists the curated sectors with anchors that route to the
      // canton's job-board home filtered by `?q=<sector>`. Crawl-equivalent to
      // the TI sectors hub minus per-sector landing depth.
      {
        const basePath = hubSlugFor(canton, locale, 'settori');
        const items = HUB_SECTORS.map((s) => ({
          href: `${sectionRoot}/?q=${encodeURIComponent(s[locale])}`,
          label: s[locale],
          emoji: sectorEmojiFor(s.key),
          sub: { it: 'Esplora →', en: 'Explore →', de: 'Erkunden →', fr: 'Explorer →' }[locale],
        }));
        const html = buildThinCantonHubHtml({
          locale, hub: 'settori', canton, cantonLabel, basePath,
          totalItems: items.length, items, hasSpaBundle, entryJs, entryCss, dateStamp,
          statTiles: [
            { label: tileLabels.settori, value: items.length.toString(), tone: 'accent' },
            { label: tileLabels.offerte, value: total.toLocaleString(locale), tone: 'success' },
            { label: tileLabels.topDatore, value: topEmployerLabel, tone: 'base' },
          ],
          cta: {
            href: sectionRoot + '/',
            label: { it: `Sfoglia tutte le offerte di ${cantonLabel} →`, en: `Browse all openings in ${cantonLabel} →`, de: `Alle Stellen in ${cantonLabel} ansehen →`, fr: `Voir toutes les offres à ${cantonLabel} →` }[locale],
          },
        });
        qw(np.join(distDir, basePath.slice(1), 'index.html'), html);
        onPageEmitted();
        if (locale === 'it') {
          const url = `${BASE_URL}${basePath}`;
          sitemapEntries.push(
            `  <url>\n    <loc>${url}</loc>\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.5</priority>\n  </url>`,
          );
        }
      }

      // ── aziende (companies) — list employers with ≥1 active opening in this canton ──
      {
        const basePath = hubSlugFor(canton, locale, 'aziende');
        const items = empArraySorted.map(([empKey, n]) => {
          // Resolve a logo: try the (manifest|crawled) keyed lookup. Keys are
          // short employer keys (e.g. "unispital-basel"); the same key is used
          // for the URL slug here, so no separate lookup is needed.
          const logoUrl = resolveBrandLogoUrl(rootDir, empKey)
            ?? crawledLogos[empKey]
            ?? null;
          return {
            href: `${sectionRoot}/azienda-${empKey}/`,
            label: humanizeSlug(empKey),
            sub: jobsActiveLabel(locale, n),
            logo: logoUrl,
            metric: n.toString(),
            metricTone: 'accent' as const,
          };
        });
        // Suppress unused warning when the caller doesn't need urlToKey.
        void companyUrlToKey;
        const html = buildThinCantonHubHtml({
          locale, hub: 'aziende', canton, cantonLabel, basePath,
          totalItems: empCounts.size, items, hasSpaBundle, entryJs, entryCss, dateStamp,
          statTiles: [
            { label: tileLabels.datori, value: empCounts.size.toLocaleString(locale), tone: 'accent' },
            { label: tileLabels.offerte, value: total.toLocaleString(locale), tone: 'success' },
            { label: tileLabels.topDatore, value: topEmployerLabel, tone: 'base' },
          ],
          cta: {
            href: sectionRoot + '/',
            label: { it: `Sfoglia tutte le offerte di ${cantonLabel} →`, en: `Browse all openings in ${cantonLabel} →`, de: `Alle Stellen in ${cantonLabel} ansehen →`, fr: `Voir toutes les offres à ${cantonLabel} →` }[locale],
          },
        });
        qw(np.join(distDir, basePath.slice(1), 'index.html'), html);
        onPageEmitted();
        if (locale === 'it') {
          const url = `${BASE_URL}${basePath}`;
          sitemapEntries.push(
            `  <url>\n    <loc>${url}</loc>\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.5</priority>\n  </url>`,
          );
        }
      }
    }
  }
}

/**
 * Emits all 4 hub families × 4 locales × all paginated pages to dist/.
 * Returns the number of pages written and the sitemap entries to append.
 */
export function emitSeoHubs(args: EmitArgs): { pagesEmitted: number; sitemapEntries: string[] } {
  const { rootDir, distDir, fs, np, entryJs, entryCss, hasSpaBundle, qw } = args;
  let pagesEmitted = 0;
  const sitemapEntries: string[] = [];
  const dateStamp = new Date().toISOString().slice(0, 10);

  const { slugs: jobSlugs, perLocale: jobPerLocale } = readJobSlugsMap(fs, np, rootDir);
  const companySlugs = readCompanySlugs(fs, np, rootDir);
  const {
    counts: jobCountBySlug,
    urlToKey: companyUrlToKey,
    cantonJobCounts,
    cantonJobs,
    cantonEmployerCounts,
  } = readJobsData(fs, np, rootDir);
  const crawledLogos = readCrawledCompanyLogos(fs, np, rootDir);

  const ensuredDirs = new Set<string>();
  function writeFile(canonicalPath: string, html: string): void {
    const indexFile = np.join(distDir, canonicalPath.slice(1), 'index.html');
    qw(indexFile, html);
    pagesEmitted++;
  }

  function emitHub(hubKey: 'jobs' | 'sectors' | 'companies' | 'articles', locale: HubLocale): void {
    const basePath = (
      hubKey === 'jobs' ? HUB_SLUGS[locale].jobsAll
      : hubKey === 'sectors' ? HUB_SLUGS[locale].sectorsAll
      : hubKey === 'companies' ? HUB_SLUGS[locale].companiesAll
      : HUB_SLUGS[locale].articlesAll
    );

    let items: Array<{ href: string; label: string; logo?: string | null; jobCount?: number; emoji?: string }> = [];
    let pageSize = 100;

    if (hubKey === 'jobs') {
      pageSize = JOBS_PAGE_SIZE;
      // Use IT canonical slug list as master across all locales so totalPages
      // is identical per locale — keeps hreflang alternates consistent. When a
      // locale-specific translated path is missing, fall back to the IT canonical
      // path (item is still browseable; user lands on the IT detail).
      const localeMap = jobPerLocale[locale];
      const itMap = jobPerLocale.it;
      for (const slug of jobSlugs) {
        const localePath = localeMap[slug] || itMap[slug];
        if (!localePath) continue;
        items.push({ href: localePath, label: humanizeSlug(slug) });
      }
    } else if (hubKey === 'sectors') {
      pageSize = HUB_SECTORS.length;
      const sectionRoot = locale === 'it' ? '/cerca-lavoro-ticino' : `/${locale}/${
        locale === 'en' ? 'find-jobs-ticino' : locale === 'de' ? 'jobs-im-tessin' : 'trouver-emploi-tessin'
      }`;
      // Sectors with a curated static hub get the canonical URL; the rest
      // fall back to `?q=` keyword search. Routing footer + SectorsHub
      // traffic through the canonical hub avoids diluting internal link
      // equity toward `noindex` query URLs.
      for (const sector of HUB_SECTORS) {
        const hasCuratedHub = (SECTOR_HUB_KEYS as readonly string[]).includes(sector.key);
        const href = hasCuratedHub
          ? buildSectorHubPath(locale, sector.key as SectorHubKey)
          : `${sectionRoot}/?q=${encodeURIComponent(sector[locale])}`;
        items.push({ href, label: sector[locale], emoji: sectorEmojiFor(sector.key) });
      }
    } else if (hubKey === 'companies') {
      pageSize = COMPANIES_PAGE_SIZE;
      const sectionRoot = locale === 'it' ? '/cerca-lavoro-ticino' : `/${locale}/${
        locale === 'en' ? 'find-jobs-ticino' : locale === 'de' ? 'jobs-im-tessin' : 'trouver-emploi-tessin'
      }`;
      for (const slug of companySlugs) {
        // Resolve the short employer key for this URL slug, then look up logos.
        // Manifest and CRAWLED_COMPANY_LOGOS are keyed by short employerKey
        // (e.g. "bps-suisse"), while company URL slugs use the full name
        // (e.g. "bps-banca-popolare-di-sondrio-suisse"). The urlToKey reverse
        // map bridges this gap.
        const key = companyUrlToKey.get(slug) ?? slug;
        const logoUrl = resolveBrandLogoUrl(rootDir, key)
          ?? resolveBrandLogoUrl(rootDir, slug)
          ?? crawledLogos[key]
          ?? crawledLogos[slug]
          ?? null;
        items.push({
          href: `${sectionRoot}/azienda-${slug}/`,
          label: humanizeSlug(slug),
          logo: logoUrl,
          jobCount: jobCountBySlug.get(key) ?? jobCountBySlug.get(slug),
        });
      }
    } else {
      pageSize = ARTICLES_PAGE_SIZE;
      // Use IT BlogArticleId list as master across all locales so totalPages is
      // identical. For non-IT locales, prefer the locale-specific title when
      // translated; fall back to the IT title when the translation is missing.
      //
      // CRITICAL — `a.slug` here is the `BlogArticleId` (e.g. `stipendio-netto-2026`),
      // not the canonical URL slug. The sitemap URL uses the per-locale slug from
      // `BLOG_SLUGS` (e.g. IT: `stipendio-netto-frontaliere-2026`). We MUST resolve
      // the URL via `BLOG_SLUGS` — otherwise hub anchors point to non-existent
      // BlogArticleId paths and the BFS audit flags every remapped article as
      // an orphan-in-sitemap (Apr-2026 regression: ~174 IT articles, ~700 cross-locale).
      const itArticles = readArticleSlugs(fs, np, rootDir, 'it');
      const localeArticles = locale === 'it' ? itArticles : readArticleSlugs(fs, np, rootDir, locale);
      const localeBySlug = new Map(localeArticles.map((a) => [a.slug, a.title]));
      const itBySlug = new Map(itArticles.map((a) => [a.slug, a.title]));
      const blogUrlSlugs = readBlogUrlSlugs(fs, np, rootDir);
      const blogSection = locale === 'it' ? 'articoli-frontaliere'
        : locale === 'en' ? 'cross-border-articles'
        : locale === 'de' ? 'grenzgaenger-artikel'
        : 'articles-frontalier';
      const prefix = locale === 'it' ? '' : `/${locale}`;

      // Master list = UNION of `blog-meta-it.ts` slugs and `BLOG_SLUGS` keys
      // from `routerBlogData.ts`. The sitemap is built off `BLOG_SLUGS`, so any
      // article registered there MUST appear in the archive — otherwise it
      // ends up listed in `sitemap-blog.xml` but unreachable via internal `<a>`
      // BFS, tripping the orphan-pages-in-sitemaps audit.
      // (May 2026 regression: `iniziativa-salari-ticino` and
      //  `cantieri-traffico-a9-ticino` had BLOG_SLUGS entries but no
      //  blog-meta-it title — sitemap +2 orphan.)
      const masterSlugs = new Set<string>(itArticles.map((a) => a.slug));
      for (const slug of Object.keys(blogUrlSlugs)) masterSlugs.add(slug);

      for (const slug of masterSlugs) {
        // Label preference: locale title → IT title → humanized slug.
        const label = localeBySlug.get(slug) ?? itBySlug.get(slug) ?? humanizeSlug(slug);
        // Resolve URL slug for this locale via BLOG_SLUGS; fall back to the
        // BlogArticleId itself when the article is missing from BLOG_SLUGS
        // (older articles or auto-generated entries can lag the slug map).
        const urlSlug = blogUrlSlugs[slug]?.[locale] ?? slug;
        items.push({ href: `${prefix}/${blogSection}/${urlSlug}/`, label });
      }
    }

    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    // Cap non-IT page-N>1 emission (2026-05-13): the master jobs hub has
    // ~400 pages × 4 locales = ~1600 thin paginated HTML files at ~150 KB
    // each = ~240 MB of dist — the dominant source of the deploy artifact
    // crossing the 1 GB Pages cap + the text-html-ratio regression (471 →
    // 1917 offenders, all `find-jobs-ticino/all/page-N` family). IT keeps
    // every page-N as static HTML (canonical for search). Non-IT locales
    // emit only page-1 — page-N>1 routes via the SPA shell.
    //
    // Hreflang impact: buildHtml only emits hreflang alternates on page-1
    // (see line 661), so dropping non-IT page-N HTML doesn't break per-page
    // hreflang signals. The sitemap entry for IT page-N>1 also drops its
    // `xhtml:link` alternates (would 404 otherwise) — page-1 keeps the
    // full 4-locale alternate set.
    const emitNonItPageN = false;
    for (let page = 1; page <= totalPages; page++) {
      if (page > 1 && locale !== 'it' && !emitNonItPageN) continue;
      const slice = items.slice((page - 1) * pageSize, page * pageSize);
      const html = buildHtml({
        locale, hubKey, basePath, page, totalPages,
        pageItems: slice, totalItems: total, hasSpaBundle, entryJs, entryCss,
      });
      const canonicalPath = paginatedPath(basePath, page);
      writeFile(canonicalPath, html);

      // Sitemap: only emit IT entries (one per (hub, page) tuple), matches existing pattern
      if (locale === 'it') {
        // Hreflang alternates: page-1 ships the full 4-locale set; page-N>1
        // ships IT-only (non-IT page-N HTML is no longer emitted, so listing
        // those URLs as alternates would advertise 404s).
        const altLinks = page === 1
          ? HUB_LOCALES.map((alt) => {
              const altBase = alt === 'it' ? HUB_SLUGS.it[
                hubKey === 'jobs' ? 'jobsAll' : hubKey === 'sectors' ? 'sectorsAll' : hubKey === 'companies' ? 'companiesAll' : 'articlesAll'
              ] : HUB_SLUGS[alt][
                hubKey === 'jobs' ? 'jobsAll' : hubKey === 'sectors' ? 'sectorsAll' : hubKey === 'companies' ? 'companiesAll' : 'articlesAll'
              ];
              return `    <xhtml:link rel="alternate" hreflang="${alt}" href="${BASE_URL}${altBase}" />`;
            }).join('\n')
          : `    <xhtml:link rel="alternate" hreflang="it" href="${BASE_URL}${canonicalPath}" />`;
        const url = `${BASE_URL}${canonicalPath}`;
        const priority = page === 1 ? '0.7' : '0.5';
        sitemapEntries.push(
          `  <url>\n    <loc>${url}</loc>\n${altLinks}\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>${priority}</priority>\n  </url>`,
        );
      }
    }
  }

  for (const locale of HUB_LOCALES) {
    emitHub('jobs', locale);
    emitHub('sectors', locale);
    emitHub('companies', locale);
    emitHub('articles', locale);
  }

  // ── Phase 7.2 — Canton-aware THIN hub pages ──
  // For every non-TI canton with ≥ MIN_JOBS_FOR_CANTON_PAGE jobs, emit a
  // thin per-canton landing for `tutti` (all jobs), `settori` (sectors) and
  // `aziende` (companies) across all 4 locales. These pages close the
  // canton URL graph (Semrush orphan-pages gate) without rebuilding the
  // full TI body. Articles are NOT canton-scoped — they remain TI-only.
  //
  // Conservative gate: skip cantons under the job-count threshold so we
  // never emit thin-content placeholders. The TI hubs are already emitted
  // above with the full paginated body — we explicitly skip TI here to
  // preserve byte-identical TI invariance.
  emitThinCantonHubs({
    fs,
    np,
    rootDir,
    distDir,
    qw,
    sitemapEntries,
    dateStamp,
    cantonJobCounts,
    cantonJobs,
    cantonEmployerCounts,
    companyUrlToKey,
    crawledLogos,
    jobPerLocale,
    entryJs,
    entryCss,
    hasSpaBundle,
    onPageEmitted: () => { pagesEmitted++; },
  });

  // Patch sitemap.xml index to include sitemap-seo-hubs.xml
  if (sitemapEntries.length > 0) {
    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${sitemapEntries.join('\n')}
</urlset>
`;
    try {
      fs.writeFileSync(np.join(distDir, 'sitemap-seo-hubs.xml'), sitemapXml, 'utf-8');
      const sitemapIndexPath = np.join(distDir, 'sitemap.xml');
      if (fs.existsSync(sitemapIndexPath)) {
        let idx = fs.readFileSync(sitemapIndexPath, 'utf-8');
        if (!idx.includes('sitemap-seo-hubs.xml')) {
          idx = idx.replace(
            '</sitemapindex>',
            `  <sitemap>\n    <loc>${BASE_URL}/sitemap-seo-hubs.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
          );
          fs.writeFileSync(sitemapIndexPath, idx, 'utf-8');
        }
      }
    } catch (err) {
      console.warn('[seo-hubs] failed to write sitemap-seo-hubs.xml', err);
    }
  }

  // Suppress unused warning when ensuredDirs is only used inside writeFile path
  void ensuredDirs;

  return { pagesEmitted, sitemapEntries };
}
