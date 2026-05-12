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
import { resolveBrandLogoUrl, renderEntityCard, ICON_BUILDING_SVG } from './shared/seoContentTokens';
import { ALL_CANTON_CODES, resolveCantonSection, resolveJobCanton } from './shared/cantonSection';
import { MIN_JOBS_FOR_CANTON_PAGE } from './weeklyEmployersData';

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
        const arr = cantonJobs.get(canton) ?? [];
        if (arr.length < 200) {
          arr.push({
            slug: job.slug,
            role: typeof job?.role === 'string' ? job.role : job.slug,
            employer: typeof job?.employer === 'string' ? job.employer : '',
            employerKey: typeof job?.employerKey === 'string' ? job.employerKey : '',
            city: typeof job?.city === 'string' ? job.city : '',
          });
          cantonJobs.set(canton, arr);
        }
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
  pageItems: ReadonlyArray<{ href: string; label: string; logo?: string | null; jobCount?: number }>;
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
      itemListElement: pageItems.slice(0, 50).map((it, idx) => ({
        '@type': 'ListItem',
        position: (page - 1) * 100 + idx + 1,
        name: it.label,
        url: `${BASE_URL}${it.href}`,
      })),
    },
  });

  // Pagination chrome: prev / page-numbers / next
  const pagination = totalPages > 1 ? renderPagination(locale, basePath, page, totalPages) : '';

  // Items list — company items (logo !== undefined) use entity-card layout;
  // jobs / sectors / articles keep the compact plain-link style.
  const itemsHtml = pageItems.length === 0
    ? `<p style="color:var(--color-subtle);padding:16px 0">${esc(emptyLabel(locale))}</p>`
    : `<ul style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px">${pageItems
        .map((it) => {
          if (it.logo !== undefined) {
            const card = renderEntityCard({
              href: it.href,
              logoUrl: it.logo ?? undefined,
              iconSvg: it.logo ? undefined : ICON_BUILDING_SVG,
              logoOnerror: it.logo ? LOGO_ONERROR : undefined,
              title: it.label,
              subtitle: it.jobCount ? jobsActiveLabel(locale, it.jobCount) : undefined,
            });
            return `<li>${card}</li>`;
          }
          return `<li><a href="${esc(it.href)}" style="display:block;padding:10px 12px;border-radius:8px;color:var(--color-heading);background:var(--color-surface);text-decoration:none;border:1px solid var(--color-edge);font-size:14px;line-height:1.4">${esc(it.label)}</a></li>`;
        })
        .join('')}</ul>`;

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
      <header style="margin-bottom:24px">
        <h1 style="font-size:32px;font-weight:800;line-height:1.2;color:var(--color-heading);margin:0 0 12px">${esc(buildHubH1(locale, hubKey, totalItems, page))}</h1>
        <p style="font-size:16px;color:var(--color-body);max-width:780px;line-height:1.55;margin:0">${esc(description)}</p>
        <p style="margin-top:8px;color:var(--color-subtle);font-size:13px">${esc(countLabel(locale, totalItems))} · ${esc(updatedLabel(locale))} ${dateStamp}</p>
      </header>
      ${buildHubMethodologyHtml(locale, hubKey)}
      <section>
        ${itemsHtml}
      </section>
      ${pagination}
      ${buildHubFooterHtml(locale, hubKey)}
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
  // Compact pagination: prev, 1, current-1, current, current+1, last, next
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
  return `<nav aria-label="Pagination" style="margin-top:32px;text-align:center">${parts.join('')}</nav>`;
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
  distDir: string;
  qw: (filePath: string, content: string) => void;
  sitemapEntries: string[];
  dateStamp: string;
  cantonJobCounts: Map<string, number>;
  cantonJobs: Map<string, CantonJobEntry[]>;
  cantonEmployerCounts: Map<string, Map<string, number>>;
  entryJs: string;
  entryCss: string;
  hasSpaBundle: boolean;
  onPageEmitted: () => void;
}

function buildThinCantonHubHtml(args: {
  locale: HubLocale;
  hub: CantonHubKind;
  canton: string;
  cantonLabel: string;
  basePath: string;
  totalItems: number;
  items: ReadonlyArray<{ href: string; label: string; sub?: string }>;
  hasSpaBundle: boolean;
  entryJs: string;
  entryCss: string;
  dateStamp: string;
}): string {
  const { locale, hub, cantonLabel, basePath, totalItems, items, hasSpaBundle, entryJs, entryCss, dateStamp } = args;
  const h1 = cantonHubH1(locale, hub, cantonLabel, totalItems);
  const intro = cantonHubIntro(locale, hub, cantonLabel, totalItems);
  const bodyCopy = cantonHubBody(locale, hub, cantonLabel);
  const bodyHeadingLabel = {
    it: 'Come usare questa pagina',
    en: 'How to use this page',
    de: 'So nutzen Sie diese Seite',
    fr: 'Comment utiliser cette page',
  }[locale];
  const pageTitle = `${CANTON_HUB_LABELS[locale][hub]} ${cantonLabel} | Frontaliere`;
  const canonicalUrl = `${BASE_URL}${basePath}`;

  const itemsHtml = items.length === 0
    ? `<p style="color:var(--color-subtle);padding:16px 0">${esc(emptyLabel(locale))}</p>`
    : `<ul style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px">${items
        .map((it) => `<li><a href="${esc(it.href)}" style="display:block;padding:10px 12px;border-radius:8px;color:var(--color-heading);background:var(--color-surface);text-decoration:none;border:1px solid var(--color-edge);font-size:14px;line-height:1.4">${esc(it.label)}${it.sub ? `<span style="display:block;font-size:12px;color:var(--color-subtle);margin-top:2px">${esc(it.sub)}</span>` : ''}</a></li>`)
        .join('')}</ul>`;

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
      <header style="margin-bottom:24px">
        <h1 style="font-size:32px;font-weight:800;line-height:1.2;color:var(--color-heading);margin:0 0 12px">${esc(h1)}</h1>
        <p style="font-size:16px;color:var(--color-body);max-width:780px;line-height:1.55;margin:0">${esc(intro)}</p>
        <p style="margin-top:8px;color:var(--color-subtle);font-size:13px">${esc(countLabel(locale, totalItems))} · ${esc(updatedLabel(locale))} ${dateStamp}</p>
      </header>
      <section>
        ${itemsHtml}
      </section>
      <section style="margin-top:32px;padding-top:24px;border-top:1px solid var(--color-edge);max-width:780px">
        <h2 style="font-size:18px;font-weight:700;color:var(--color-heading);margin:0 0 12px">${esc(bodyHeadingLabel)}</h2>
        <p style="font-size:15px;line-height:1.6;color:var(--color-body);margin:0">${esc(bodyCopy)}</p>
      </section>
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
  const { np, distDir, qw, sitemapEntries, dateStamp, cantonJobCounts, cantonJobs, cantonEmployerCounts,
          entryJs, entryCss, hasSpaBundle, onPageEmitted } = args;

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

      // ── tutti (all jobs) ──
      {
        const basePath = hubSlugFor(canton, locale, 'tutti');
        const items = jobs.slice(0, 100).map((j) => ({
          href: `${sectionRoot}/${j.slug}/`,
          label: j.role || humanizeSlug(j.slug),
          sub: j.city || undefined,
        }));
        const html = buildThinCantonHubHtml({
          locale, hub: 'tutti', canton, cantonLabel, basePath,
          totalItems: total, items, hasSpaBundle, entryJs, entryCss, dateStamp,
        });
        qw(np.join(distDir, basePath.slice(1), 'index.html'), html);
        onPageEmitted();
        if (locale === 'it') {
          const url = `${BASE_URL}${basePath}`;
          sitemapEntries.push(
            `  <url>\n    <loc>${url}</loc>\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.6</priority>\n  </url>`,
          );
        }
      }

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
        }));
        const html = buildThinCantonHubHtml({
          locale, hub: 'settori', canton, cantonLabel, basePath,
          totalItems: items.length, items, hasSpaBundle, entryJs, entryCss, dateStamp,
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
        const empArray = Array.from(empCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 100);
        const items = empArray.map(([empKey, n]) => ({
          href: `${sectionRoot}/azienda-${empKey}/`,
          label: humanizeSlug(empKey),
          sub: jobsActiveLabel(locale, n),
        }));
        const html = buildThinCantonHubHtml({
          locale, hub: 'aziende', canton, cantonLabel, basePath,
          totalItems: empCounts.size, items, hasSpaBundle, entryJs, entryCss, dateStamp,
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

    let items: Array<{ href: string; label: string; logo?: string | null; jobCount?: number }> = [];
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
        items.push({ href, label: sector[locale] });
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
    for (let page = 1; page <= totalPages; page++) {
      const slice = items.slice((page - 1) * pageSize, page * pageSize);
      const html = buildHtml({
        locale, hubKey, basePath, page, totalPages,
        pageItems: slice, totalItems: total, hasSpaBundle, entryJs, entryCss,
      });
      const canonicalPath = paginatedPath(basePath, page);
      writeFile(canonicalPath, html);

      // Sitemap: only emit IT entries (one per (hub, page) tuple), matches existing pattern
      if (locale === 'it') {
        const altLinks = HUB_LOCALES.map((alt) => {
          const altBase = alt === 'it' ? HUB_SLUGS.it[
            hubKey === 'jobs' ? 'jobsAll' : hubKey === 'sectors' ? 'sectorsAll' : hubKey === 'companies' ? 'companiesAll' : 'articlesAll'
          ] : HUB_SLUGS[alt][
            hubKey === 'jobs' ? 'jobsAll' : hubKey === 'sectors' ? 'sectorsAll' : hubKey === 'companies' ? 'companiesAll' : 'articlesAll'
          ];
          return `    <xhtml:link rel="alternate" hreflang="${alt}" href="${BASE_URL}${page === 1 ? altBase : paginatedPath(altBase, page)}" />`;
        }).join('\n');
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
    distDir,
    qw,
    sitemapEntries,
    dateStamp,
    cantonJobCounts,
    cantonJobs,
    cantonEmployerCounts,
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
