import { CROSS_BORDER_TAX_FACTS, CROSS_BORDER_TAX_SOURCE } from '../services/crossBorderEmploymentFacts';
/**
 * Orphan-query cluster landings — Vite build plugin.
 *
 * Reads `data/gsc-orphan-queries-clusters.json` (produced by
 * `scripts/cluster-orphan-queries.mjs`) and emits one indexable
 * static HTML page per (cluster) at
 *   IT: /ricerca/{slug}/
 *   EN: /en/search/{slug}/
 *   DE: /de/suche/{slug}/
 *   FR: /fr/recherche/{slug}/
 *
 * Each page carries:
 *   - H1 = canonical query
 *   - Editorial context (role-aware, ≥250 words)
 *   - ItemList JSON-LD of 5-15 matching JobPosting stubs
 *   - "Similar searches" internal-link section
 *   - BreadcrumbList + WebPage + ItemList structured data
 *   - Self-referent canonical, hreflang to other locales when the slug is
 *     present in the clusters file.
 *
 * Anti-doorway mitigations:
 *   - Clusters with <3 matching jobs at build time emit
 *     <meta name="robots" content="noindex,follow"> and are NOT added to
 *     the sitemap.
 *   - Role-aware editorial (tech / healthcare / retail / hospitality /
 *     office / logistics / generic) ensures pages are NOT templated copies.
 *
 * Gates:
 *   - SKIP_ORPHAN_LANDINGS=1 → fast-path exit, no files generated.
 *   - MAX_ORPHAN_LANDINGS (default 500) caps total pages per build.
 *
 * The plugin DEGRADES GRACEFULLY when the clusters file is missing —
 * it logs a warning and returns without failing the build.
 */

import path from 'node:path';
import fs from 'node:fs';
import type { Plugin } from 'vite';
import { truncateToClauseNonEmpty } from './shared/clauseTail.mjs';
import { WriteCollector } from './batchWrite';
import { shouldEmitLocale, EMIT_LOCALES } from './shared/localeEmitFilter';
import {
  BASE_URL,
  buildCanonicalBridgePage,
  countHtmlBodyWords,
  MIN_INDEXABLE_WORDS,
} from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import {
  H1_STYLE,
  HERO_EYEBROW_STYLE,
  LEDE_STYLE,
  LINK_ACCENT_STYLE,
  clampSiteSuffix,
} from './shared/seoContentTokens';
import {
  renderJobCardListHtml,
  type JobCardJob,
  type JobCardListItem,
} from './shared/jobCardHtml';
import {
  ORPHAN_LANDING_LOCALES,
  ORPHAN_LANDING_SECTION,
  ORPHAN_LANDING_LOCALE_PREFIX,
  ORPHAN_LANDING_OG_LOCALE,
  buildOrphanLandingPath,
  filterMatchingJobs,
  topCounts,
  type OrphanLandingLocale,
  type OrphanQueryCluster,
  type OrphanQueryClustersFile,
  type OrphanCountableJob,
  type OrphanLandingRoute,
} from './orphanQueryData';
import { generateRelatedLinksBlock } from './shared/relatedLinks';
import { adSlotHtml } from './lib/adSlotHtml';
import { CALC_HREF } from './shared/calcHref';
import { buildSalaryAnswer, searchSalaryMedian } from './shared/searchSalaryAnswer';
import { inlineScriptJson } from './shared/inlineJsonScript';
import { AGGREGATE_KEY, resolveCantonSection, resolveJobCanton } from './shared/cantonSection';
import { listSliceFileNames } from '../scripts/lib/crawler-slice-files.mjs';
import { intFromEnv } from '../scripts/lib/int-from-env.mjs';
import {
  resolveNursingOrphanQueryTarget,
  type NursingOrphanQueryTarget,
} from './nursingLandingsData';

const MIN_MATCHING_JOBS = 3;
const DEFAULT_MAX_LANDINGS = 500;

export function buildOrphanLandingHubPath(locale: OrphanLandingLocale): string {
  const prefix = ORPHAN_LANDING_LOCALE_PREFIX[locale];
  const section = ORPHAN_LANDING_SECTION[locale];
  return `${prefix}/${section}/`.replace(/\/+/g, '/');
}

export function buildOrphanLandingHubUrl(locale: OrphanLandingLocale): string {
  return `${BASE_URL}${buildOrphanLandingHubPath(locale)}`;
}

/**
 * A GSC query that is already covered by an evergreen nursing landing must not
 * create a second indexable doorway. Keep the historical orphan URL alive as a
 * noindex canonical bridge so crawlers and users converge on the real page.
 */
export function buildNursingOrphanCanonicalBridge(target: NursingOrphanQueryTarget): string {
  const canonicalUrl = `${BASE_URL}${target.path}`;
  const html = buildCanonicalBridgePage({
    canonicalUrl,
    pathLabel: target.path,
    title: 'Nursing jobs search moved | Frontaliere Ticino',
    description: 'This search is covered by the canonical nursing jobs landing page.',
    body: 'This search is covered by the canonical nursing jobs landing page. Open it for current Swiss nursing vacancies, salary guidance and cross-border requirements.',
    ctaLabel: 'Open nursing jobs in Switzerland',
    lang: target.locale,
    noindex: true,
  });
  return html.replace(
    '</head>',
    ` <meta http-equiv="refresh" content="0; url=${canonicalUrl}">\n </head>`,
  );
}

export function renderOrphanLandingHubHreflang(
  hasEntriesByLocale: Record<OrphanLandingLocale, boolean>,
): string {
  // All-or-nothing, mirroring the leaf `renderPage` hreflang contract
  // (`hasFullCluster`, L514) and the shared `build-plugins/shared/hreflang.ts`
  // helper: audit-hreflang requires either ZERO alternates or the FULL
  // 4-locale + x-default set. A partial set — e.g. a locale whose orphan
  // clusters are all sub-MIN (no indexable hub) → 3 locales + x-default = 4
  // entries with only 3 declared — trips audit-hreflang `[tooFew]`, the same
  // gate this plugin fixes. Emit only when every locale has indexable entries.
  const hasAll = ORPHAN_LANDING_LOCALES.every((alt) => hasEntriesByLocale[alt]);
  if (!hasAll) return '';

  const lines = ORPHAN_LANDING_LOCALES.map(
    (alt) => `    <link rel="alternate" hreflang="${alt}" href="${buildOrphanLandingHubUrl(alt)}">`,
  );
  lines.push(
    `    <link rel="alternate" hreflang="x-default" href="${buildOrphanLandingHubUrl('it')}">`,
  );
  return lines.join('\n');
}

/** Load and merge all jobs from main jobs.json + per-crawler slices. */
function loadAllJobs(rootDir: string): OrphanCountableJob[] {
  const dataDir = path.join(rootDir, 'data');
  const out: OrphanCountableJob[] = [];
  const seen = new Set<string>();

  const mainPath = path.join(dataDir, 'jobs.json');
  if (fs.existsSync(mainPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(mainPath, 'utf-8'));
      if (Array.isArray(raw)) {
        for (const j of raw) {
          const key = String(j?.slug || j?.id || '');
          if (key && !seen.has(key)) {
            seen.add(key);
            out.push(j as OrphanCountableJob);
          }
        }
      }
    } catch (err) {
      console.warn('[orphan-query-landings] failed to parse jobs.json:', err);
    }
  }

  const sliceDir = path.join(dataDir, 'jobs', 'by-crawler');
  if (fs.existsSync(sliceDir)) {
    for (const file of listSliceFileNames(sliceDir)) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(sliceDir, file), 'utf-8'));
        const jobs: unknown = Array.isArray(raw) ? raw : raw?.jobs;
        if (!Array.isArray(jobs)) continue;
        for (const j of jobs as OrphanCountableJob[]) {
          const key = String(j?.slug || (j as { id?: string })?.id || '');
          if (key && !seen.has(key)) {
            seen.add(key);
            out.push(j);
          }
        }
      } catch {
        /* slice parse failure — skip */
      }
    }
  }

  return out;
}

/** Pick a role-family editorial block (tech/healthcare/retail/hospitality/office/logistics/generic). */
function pickEditorialFamily(cluster: OrphanQueryCluster): 'tech' | 'healthcare' | 'retail' | 'hospitality' | 'office' | 'logistics' | 'generic' {
  const joined = [
    cluster.canonicalQuery.toLowerCase(),
    ...cluster.roleTokens,
  ].join(' ');
  const has = (patterns: string[]) => patterns.some((p) => joined.includes(p));

  if (has(['nurs', 'infermier', 'pfleg', 'care', 'caregiver', 'krankensch', 'sanita', 'sanità', 'medic', 'arzt', 'doctor', 'hospit', 'clinic', 'klinik', 'anzian'])) return 'healthcare';
  if (has(['dev', 'develop', 'engineer', 'ingegner', 'entwickl', 'programm', 'software', 'it-', ' it ', 'tech', 'data', 'cloud', 'devops', 'analyst', 'analist'])) return 'tech';
  if (has(['retail', 'vendit', 'sales', 'verkauf', 'boutique', 'outlet', 'store', 'cashier', 'cass', 'prada', 'commerc'])) return 'retail';
  if (has(['hotel', 'hotell', 'gastro', 'restaur', 'kitchen', 'kuechen', 'küch', 'service', 'receptionist', 'ristor'])) return 'hospitality';
  if (has(['chauffeur', 'driver', 'fahrer', 'autist', 'logisti', 'transport', 'warehouse', 'magazz', 'kurier'])) return 'logistics';
  if (has(['bank', 'assicur', 'insurance', 'versicher', 'compliance', 'legal', 'hr', 'administ', 'amminist', 'buchhalt', 'contabil', 'secretari', 'accountant', 'assistant', 'assist', 'segret', 'office'])) return 'office';
  return 'generic';
}

function editorialKey(fam: ReturnType<typeof pickEditorialFamily>): string {
  switch (fam) {
    case 'tech': return 'orphanLanding.editorialTech';
    case 'healthcare': return 'orphanLanding.editorialHealthcare';
    case 'retail': return 'orphanLanding.editorialRetail';
    case 'hospitality': return 'orphanLanding.editorialHospitality';
    case 'office': return 'orphanLanding.editorialOffice';
    case 'logistics': return 'orphanLanding.editorialLogistics';
    default: return 'orphanLanding.editorialGeneric';
  }
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Capitalize only the first letter of a string (no title-case). */
function cap(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Per-cluster extended FAQ accordion shown in fondo on every leaf landing.
 * Wrapped in closed <details> per CLAUDE.md rule #16 (mobile-first: filler
 * below the meaty content, expanded only on demand). Content references the
 * cluster's actual query / employer / city / median so every leaf carries
 * distinct prose — no boilerplate repeating verbatim across the corpus, no
 * display:none hidden text.
 *
 * Lifts the ~80 KB-chrome leaf pages from ~6-9 % text/HTML ratio (right at
 * the 10 % Semrush floor) to ~12-14 %. Pairs with the hub-page fix from
 * PR #70 (HUB_PROSE_ECON) which addresses the 3 locale-root indexes.
 */
interface ExtendedFaqCtx {
  query: string;
  employer: string;
  city: string;
  med: string;
}


function buildExtendedFaqAccordion(
  locale: OrphanLandingLocale,
  ctx: ExtendedFaqCtx,
): string {
  const q = esc(ctx.query);
  const city = ctx.city ? esc(ctx.city) : '';
  const med = ctx.med ? esc(ctx.med) : '';

  const SECTION_STYLE = 'margin:28px 0 0;padding-top:20px;border-top:1px solid var(--color-edge);max-width:860px';
  const SUMMARY_STYLE = 'font-weight:700;cursor:pointer;font-size:16px;color:var(--color-heading);line-height:1.5';
  const DETAILS_STYLE = 'padding:14px 16px;border:1px solid var(--color-edge);border-radius:12px;margin-bottom:10px;background:var(--color-surface)';
  const ANSWER_STYLE = 'margin:10px 0 0;color:var(--color-body);line-height:1.7;font-size:15px';

  type Faq = { q: string; a: string };

  const blocks: Record<OrphanLandingLocale, { heading: string; intro: string; faqs: Faq[] }> = {
    it: {
      heading: 'Approfondimento per chi cerca lavoro frontaliere',
      intro: 'Le risposte qui sotto coprono i punti più chiesti da chi valuta una posizione del tipo «' + q + '» come frontaliere italo-svizzero. Le abbiamo raccolte in formato accordion per non distrarre dalle offerte qui sopra: apri solo quando ti servono.',
      faqs: [
        { q: 'Che stipendio aspettarmi per «' + q + '» per questa ricerca?', a: buildSalaryAnswer(locale, med) },
        { q: 'Permesso G o permesso B: quale conviene per questo profilo?', a: "Il permesso G riguarda chi lavora in Svizzera mantenendo la residenza principale all’estero e rientrando almeno settimanalmente. Il permesso B riguarda il soggiorno in Svizzera: la scelta dipende dalla residenza effettiva, non da una convenienza fiscale automatica. Il limite dei 20 km appartiene alla definizione fiscale dell’accordo, non alla residenza richiesta per il permesso G UE/AELS. In Ticino rilascio e rinnovo del permesso G per cittadini UE/AELS maggiorenni costano CHF 75; altre pratiche e categorie hanno tariffe diverse. https://www4.ti.ch/di/spop/stranieri/richiesta-nuovo-g/" },
        { q: 'Cosa cambia col Nuovo Accordo 2026 sulla tassazione di un ruolo «' + q + '»?', a: CROSS_BORDER_TAX_FACTS[locale] + ' ' + CROSS_BORDER_TAX_SOURCE },
        { q: 'Quali costi nascosti erodono il netto di un\'offerta «' + q + '»' + (city ? ' a ' + city : '') + '?', a: "Confronta il lordo annuo e il netto stimato con le spese effettive della tua situazione: trasporto, parcheggio, copertura sanitaria e gestione familiare. Verifica le trattenute nel contratto e nella simulazione del datore di lavoro. Frequenza dei viaggi, sede e residenza cambiano il risultato: questa selezione non dispone di dati per attribuire una spesa media personale." },
        { q: 'Come faccio a candidarmi efficacemente alle offerte di questa pagina?', a: "Leggi requisiti, mansioni, sede, orari e modalità di candidatura nella fonte originale. Adatta il CV alle competenze richieste e allega i documenti indicati dal datore di lavoro. Verifica direttamente disponibilità del posto, scadenza e requisiti individuali per lavorare in Svizzera. La presenza in questa selezione non garantisce idoneità al permesso G o tempi di assunzione." },
      ],
    },
    en: {
      heading: 'Cross-border worker FAQ on this search',
      intro: 'The answers below cover the most common questions from candidates evaluating a «' + q + '» position as an Italian-Swiss cross-border worker. Folded into an accordion so the openings above stay the focus — expand only what you need.',
      faqs: [
        { q: 'What salary should I expect for «' + q + '» for this search?', a: buildSalaryAnswer(locale, med) },
        { q: 'G permit or B permit: which fits this profile?', a: "The G permit covers work in Switzerland while keeping the main residence abroad and returning at least weekly. The B permit concerns residence in Switzerland: the choice follows actual residence, not an automatic tax advantage. The 20 km limit belongs to the treaty tax definition, not the residence requirement for an EU/EFTA G permit. In Ticino, issuing or renewing a G permit for an adult EU/EFTA national costs CHF 75; other procedures and categories have different fees. https://www4.ti.ch/di/spop/stranieri/richiesta-nuovo-g/" },
        { q: 'What does the 2026 New Agreement change about taxation on a «' + q + '» role?', a: CROSS_BORDER_TAX_FACTS[locale] + ' ' + CROSS_BORDER_TAX_SOURCE },
        { q: 'Which hidden costs erode the net of a «' + q + '» offer' + (city ? ' in ' + city : '') + '?', a: "Compare annual gross pay and estimated net pay with your actual transport, parking, healthcare and family costs. Check deductions in the contract and employer calculation. Travel frequency, workplace and residence affect the result; this selection has no evidence for assigning a personal average expense." },
        { q: 'How do I apply effectively to the openings on this page?', a: "Read qualifications, responsibilities, location, hours and application instructions in the original listing. Tailor your CV to the requirements and attach the documents requested by the employer. Confirm vacancy status, deadline and your individual eligibility to work in Switzerland. Inclusion here does not guarantee G-permit eligibility or a hiring timeline." },
      ],
    },
    de: {
      heading: 'Häufige Fragen von italo-schweizerischen Grenzgängern zu dieser Suche',
      intro: 'Die folgenden Antworten decken die meistgestellten Fragen von Kandidaten ab, die eine Position vom Typ «' + q + '» als italo-schweizerischer Grenzgänger evaluieren. Im Akkordeon gefaltet, damit die Inserate oben im Fokus bleiben — nur öffnen, was relevant ist.',
      faqs: [
        { q: 'Welcher Lohn ist für «' + q + '» bei dieser Suche belegt?', a: buildSalaryAnswer(locale, med) },
        { q: 'G-Bewilligung oder B-Bewilligung: was passt zu diesem Profil?', a: "Die G-Bewilligung betrifft die Arbeit in der Schweiz bei Hauptwohnsitz im Ausland und mindestens wöchentlicher Rückkehr. Die B-Bewilligung betrifft den Aufenthalt in der Schweiz; entscheidend ist der tatsächliche Wohnsitz, kein pauschaler Steuervorteil. Die 20-km-Grenze gehört zur steuerlichen Abkommensdefinition, nicht zur Wohnsitzvoraussetzung der G-Bewilligung für EU/EFTA-Angehörige. Im Tessin kosten Erteilung und Verlängerung für volljährige EU/EFTA-Angehörige CHF 75; andere Verfahren und Kategorien haben andere Gebühren. https://www4.ti.ch/di/spop/stranieri/richiesta-nuovo-g/" },
        { q: 'Was ändert das Neue Abkommen 2026 für die Besteuerung einer «' + q + '»-Stelle?', a: CROSS_BORDER_TAX_FACTS[locale] + ' ' + CROSS_BORDER_TAX_SOURCE },
        { q: 'Welche versteckten Kosten zehren am Netto einer «' + q + '»-Offerte' + (city ? ' in ' + city : '') + '?', a: "Vergleichen Sie Jahresbruttolohn und geschätzten Nettolohn mit Ihren tatsächlichen Kosten für Fahrt, Parkplatz, Gesundheitsversorgung und Familie. Prüfen Sie Abzüge im Vertrag und in der Arbeitgeberberechnung. Fahrthäufigkeit, Arbeitsort und Wohnsitz beeinflussen das Ergebnis; diese Auswahl enthält keine Daten für persönliche Durchschnittskosten." },
        { q: 'Wie bewerbe ich mich erfolgreich auf die Stellen dieser Seite?', a: "Prüfen Sie Anforderungen, Aufgaben, Arbeitsort, Arbeitszeit und Bewerbungsweg in der Originalanzeige. Passen Sie den Lebenslauf an und reichen Sie die vom Arbeitgeber verlangten Unterlagen ein. Bestätigen Sie Stellenstatus, Frist und Ihre individuellen Voraussetzungen für die Arbeit in der Schweiz. Der Eintrag garantiert weder eine G-Bewilligung noch eine bestimmte Einstellungsdauer." },
      ],
    },
    fr: {
      heading: 'FAQ frontalier sur cette recherche',
      intro: 'Les réponses ci-dessous traitent des questions les plus fréquentes des candidats qui évaluent un poste «' + q + '» en tant que frontalier italo-suisse. Repliées dans un accordéon pour laisser la priorité aux offres ci-dessus — n\'ouvrez que ce qui vous intéresse.',
      faqs: [
        { q: 'Quel salaire attendre pour «' + q + '» pour cette recherche ?', a: buildSalaryAnswer(locale, med) },
        { q: 'Permis G ou permis B : lequel convient à ce profil ?', a: "Le permis G concerne le travail en Suisse avec résidence principale à l’étranger et retour au moins hebdomadaire. Le permis B concerne le séjour en Suisse; le choix dépend de la résidence effective, non d’un avantage fiscal automatique. La limite de 20 km relève de la définition fiscale de l’accord, non de la condition de résidence du permis G UE/AELE. Au Tessin, délivrance et renouvellement pour un ressortissant UE/AELE majeur coûtent CHF 75; les autres démarches et catégories ont des tarifs différents. https://www4.ti.ch/di/spop/stranieri/richiesta-nuovo-g/" },
        { q: 'Ce que change le Nouvel Accord 2026 sur la fiscalité d\'un rôle «' + q + '»', a: CROSS_BORDER_TAX_FACTS[locale] + ' ' + CROSS_BORDER_TAX_SOURCE },
        { q: 'Quels coûts cachés érodent le net d\'une offre «' + q + '»' + (city ? ' à ' + city : '') + ' ?', a: "Comparez le brut annuel et le net estimé avec vos frais réels de transport, stationnement, santé et famille. Vérifiez les retenues dans le contrat et le calcul de l’employeur. Fréquence des trajets, lieu de travail et résidence changent le résultat ; cette sélection ne fournit pas de données pour calculer vos dépenses moyennes personnelles." },
        { q: 'Comment postuler efficacement aux offres de cette page ?', a: "Consultez qualifications, missions, lieu, horaires et modalités de candidature dans l’annonce originale. Adaptez le CV et joignez les documents demandés par l’employeur. Confirmez la disponibilité du poste, la date limite et vos conditions personnelles pour travailler en Suisse. Cette sélection ne garantit ni l’accès au permis G ni un délai d’embauche." },
      ],
    },
  };

  const block = blocks[locale];
  const items = block.faqs
    .map(
      (f) => '<details class="s-j2wp2M"><summary class="s-iDY72K">' + esc(f.q) + '</summary><p class="s-E6DhdW">' + esc(f.a) + '</p></details>',
    )
    .join('');

  return '<section class="s-dc6Yoc"><h2 class="s-xa37_g">' + esc(block.heading) + '</h2><p class="s-gISFYN">' + esc(block.intro) + '</p>' + items + '</section>';
}

/** Build an editorialized H1 from the canonical query per locale. */
function buildEditorialH1(query: string, locale: OrphanLandingLocale): string {
  const q = cap(query);
  switch (locale) {
    case 'it': return `${q} — offerte e informazioni per frontalieri`;
    case 'en': return `${q} — answers for cross-border workers`;
    case 'de': return `${q} — Antworten für Grenzgänger`;
    case 'fr': return `${q} — réponses pour les frontaliers`;
  }
}

/**
 * Build an editorialised page title per locale, clamped to ≤66 chars
 * (audit:title-length deploy gate).
 *
 * Strategy mirrors {@link buildTitleWithBrand} from shared/titleSuffix.ts:
 *   1. `query | brand` fits inside MAX → append brand
 *   2. `query` alone fits → drop brand
 *   3. `query` itself exceeds MAX → cap on a whitespace boundary (no `…`)
 *
 * Long GSC queries (e.g. "help me find ticino caregiver jobs for elderly
 * care with live-in option and clear legal contract terms" — 107 chars)
 * push the bare query past the cap; capping on a word boundary keeps the
 * title readable while staying ≤66 chars and clearing the audit gate.
 *
 * Step 3 delegates to `truncateToClauseNonEmpty` (clauseTail.mjs) rather than
 * inlining the ladder, which is what it used to do. The NonEmpty variant is the
 * required one here: this function's return value IS the page's `<title>`, with
 * no downstream fallback, so the plain `truncateToClause` refusal (`''` when the
 * first token overflows the budget, #5452) would emit an empty title tag — see
 * PR #5515's review, which found that exact shape shipping elsewhere.
 */
function buildEditorialTitle(query: string, locale: OrphanLandingLocale): string {
  const MAX = 66;
  const q = cap(query);
  const brand =
    locale === 'it' ? 'Frontaliere Ticino'
    : locale === 'en' ? 'Cross-border Workers Ticino'
    : locale === 'de' ? 'Grenzgänger Tessin'
    : 'Frontaliers Tessin';
  const withBrand = `${q} | ${brand}`;
  if (withBrand.length <= MAX) return withBrand;
  if (q.length <= MAX) return q;
  return truncateToClauseNonEmpty(q, MAX);
}

/**
 * Build a cluster-specific "signals" paragraph that injects per-entity data
 * (role tokens, region tokens, top variant queries, impression volume) so the
 * body is unique even when the matching-jobs list is empty and the family
 * editorial block collapses to the generic fallback. Keeps the page indexable
 * by making body content unambiguously about the searched query, not about
 * "the Swiss labour market in general".
 *
 * IMPORTANT: all 4 locales return an editorial sentence — never an empty
 * string — so this paragraph is always a distinguishing signal regardless of
 * how sparse the cluster is.
 */
function buildClusterSignalsParagraph(
  cluster: OrphanQueryCluster,
  locale: OrphanLandingLocale,
): string {
  const q = cap(cluster.canonicalQuery);
  const roleTokens = cluster.roleTokens.slice(0, 5).filter(Boolean);
  const regionTokens = cluster.regionTokens.slice(0, 3).filter(Boolean);
  const variantQueries = cluster.queries
    .filter((v) => v.query && v.query !== cluster.canonicalQuery)
    .slice(0, 4)
    .map((v) => v.query);
  const variantCount = cluster.queries.length;
  const impressions = cluster.totalImpressions;
  const clicks = cluster.totalClicks;

  // Cross-border commuter context that varies by the FIRST region token.
  const region = regionTokens[0] || '';

  const formatList = (xs: string[], conj: string): string => {
    if (xs.length === 0) return '';
    if (xs.length === 1) return xs[0];
    return `${xs.slice(0, -1).join(', ')} ${conj} ${xs[xs.length - 1]}`;
  };

  if (locale === 'it') {
    const rolesPart = roleTokens.length > 0
      ? `Le varianti con cui gli utenti cercano questa posizione includono ${formatList(roleTokens, 'e')}.`
      : `Il cluster non contiene sinonimi consolidati.`;
    const regionPart = region
      ? ` Il volume principale di queste ricerche proviene dall'area di ${cap(region)}, un bacino rilevante per frontalieri italiani.`
      : '';
    const variantPart = variantQueries.length > 0
      ? ` Fra le ${variantCount} query raggruppate in questa pagina segnaliamo in particolare: "${variantQueries.join('", "')}".`
      : ` Questa pagina raggruppa ${variantCount} query affini.`;
    const volumePart = impressions > 0
      ? ` Secondo i dati Google Search Console, il cluster ha generato ${impressions.toLocaleString('it-CH')} impression e ${clicks.toLocaleString('it-CH')} clic nell'ultimo snapshot.`
      : '';
    return `Segnali specifici per ${q}. ${rolesPart}${regionPart}${variantPart}${volumePart}`;
  }
  if (locale === 'en') {
    const rolesPart = roleTokens.length > 0
      ? `People searching for this role often phrase it as ${formatList(roleTokens, 'or')}.`
      : `The cluster does not contain consolidated synonyms.`;
    const regionPart = region
      ? ` Most of this search volume comes from the ${cap(region)} area, an important catchment for Italian cross-border workers.`
      : '';
    const variantPart = variantQueries.length > 0
      ? ` Among the ${variantCount} grouped queries, the most typical variants are: "${variantQueries.join('", "')}".`
      : ` This page consolidates ${variantCount} related queries.`;
    const volumePart = impressions > 0
      ? ` According to Google Search Console, the cluster delivered ${impressions.toLocaleString('en-US')} impressions and ${clicks.toLocaleString('en-US')} clicks in the latest snapshot.`
      : '';
    return `Specific signals for ${q}. ${rolesPart}${regionPart}${variantPart}${volumePart}`;
  }
  if (locale === 'de') {
    const rolesPart = roleTokens.length > 0
      ? `Nutzer suchen diese Rolle häufig als ${formatList(roleTokens, 'oder')}.`
      : `Dieses Cluster enthält keine etablierten Synonyme.`;
    const regionPart = region
      ? ` Das Suchvolumen stammt hauptsächlich aus dem Raum ${cap(region)}, einem wichtigen Einzugsgebiet für italienische Grenzgänger.`
      : '';
    const variantPart = variantQueries.length > 0
      ? ` Unter den ${variantCount} gebündelten Suchanfragen fallen besonders auf: "${variantQueries.join('", "')}".`
      : ` Diese Seite bündelt ${variantCount} verwandte Suchanfragen.`;
    const volumePart = impressions > 0
      ? ` Laut Google Search Console generierte dieses Cluster im letzten Snapshot ${impressions.toLocaleString('de-CH')} Impressions und ${clicks.toLocaleString('de-CH')} Klicks.`
      : '';
    return `Spezifische Signale zu ${q}. ${rolesPart}${regionPart}${variantPart}${volumePart}`;
  }
  // fr
  const rolesPart = roleTokens.length > 0
    ? `Les internautes formulent cette recherche sous différentes variantes : ${formatList(roleTokens, 'ou')}.`
    : `Ce cluster ne contient pas de synonymes consolidés.`;
  const regionPart = region
    ? ` Le volume principal provient de la zone de ${cap(region)}, bassin de référence pour les frontaliers italiens.`
    : '';
  const variantPart = variantQueries.length > 0
    ? ` Parmi les ${variantCount} requêtes regroupées, les variantes les plus typiques sont : « ${variantQueries.join(' », « ')} ».`
    : ` Cette page regroupe ${variantCount} requêtes apparentées.`;
  const volumePart = impressions > 0
    ? ` D'après Google Search Console, le cluster a enregistré ${impressions.toLocaleString('fr-CH')} impressions et ${clicks.toLocaleString('fr-CH')} clics dans le dernier instantané.`
    : '';
  return `Signaux propres à ${q}. ${rolesPart}${regionPart}${variantPart}${volumePart}`;
}

/** Build an editorialized meta description per locale. */
function buildEditorialDescription(query: string, locale: OrphanLandingLocale, editorial: string): string {
  const q = cap(query);
  const prefix: Record<OrphanLandingLocale, string> = {
    it: `${q} — `,
    en: `${q} — `,
    de: `${q} — `,
    fr: `${q} — `,
  };
  return (prefix[locale] + editorial).slice(0, 155);
}

async function loadLocaleStrings(rootDir: string, locale: OrphanLandingLocale): Promise<Record<string, string>> {
  const modPath = path.join(rootDir, 'services', 'locales', `${locale}-orphan-landings.ts`);
  // Plain regex parse — avoid bundling TS at build time.
  if (!fs.existsSync(modPath)) return {};
  const src = fs.readFileSync(modPath, 'utf-8');
  const entries: Record<string, string> = {};
  // Very conservative: matches  'key': "value" or 'key': 'value' lines.
  const re = /'([^']+)':\s*'((?:[^'\\]|\\.)*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    entries[m[1]] = m[2].replace(/\\'/g, "'").replace(/\\n/g, '\n');
  }
  return entries;
}

function jobLocalizedUrl(job: OrphanCountableJob, locale: OrphanLandingLocale): string {
  const prefix = ORPHAN_LANDING_LOCALE_PREFIX[locale];
  const section = resolveCantonSection(locale, resolveJobCanton(job));
  const slug = job.slugByLocale?.[locale] || job.slug || '';
  const rel = `${prefix}/${section}/${slug}/`.replace(/\/+/g, '/');
  return `${BASE_URL}${rel}`;
}

function jobLocalizedTitle(job: OrphanCountableJob, locale: OrphanLandingLocale): string {
  return job.titleByLocale?.[locale] || job.title || '';
}

interface RenderedPageResult {
  /** Canonical URL path (trailing slash). */
  urlPath: string;
  /** Full HTML document. */
  html: string;
  /** Word count of body content (excluding tags). */
  wordCount: number;
  /** Number of matching jobs rendered. */
  matchingJobsCount: number;
  /** Whether this page should be indexed. */
  indexable: boolean;
}

function renderPage(opts: {
  cluster: OrphanQueryCluster;
  matchingJobs: OrphanCountableJob[];
  strings: Record<string, string>;
  dateStamp: string;
  knownSlugsByLocale: Map<OrphanLandingLocale, Set<string>>;
  /** dist directory for entry-asset resolution. Omit in tests. */
  distDir?: string;
}): RenderedPageResult {
  const { cluster, matchingJobs, strings, dateStamp, knownSlugsByLocale, distDir } = opts;
  const locale = cluster.locale;
  const urlPath = buildOrphanLandingPath(locale, cluster.canonicalSlug);
  const canonicalUrl = `${BASE_URL}${urlPath}`;

  const t = (key: string, fallback = ''): string => strings[key] || fallback;

  // Alternates: only link to other locales that actually have the same slug
  // in the clusters set (avoids fake hreflang). audit-hreflang requires
  // either ZERO entries or the full 4-locale cluster + x-default. If some
  // locales are missing a translation, skip hreflang entirely and rely on
  // <link rel="canonical"> to tell Google this is a single-locale page.
  const itSet = knownSlugsByLocale.get('it');
  const itHasSlug = Boolean(itSet && itSet.has(cluster.canonicalSlug));
  const availableAlts = ORPHAN_LANDING_LOCALES.filter((alt) => {
    if (alt === locale) return true;
    const set = knownSlugsByLocale.get(alt);
    return Boolean(set && set.has(cluster.canonicalSlug));
  });
  const hasFullCluster = ORPHAN_LANDING_LOCALES.every((alt) => availableAlts.includes(alt));
  const xDefaultHref = itHasSlug
    ? `${BASE_URL}${buildOrphanLandingPath('it', cluster.canonicalSlug)}`
    : canonicalUrl;
  const alternates = hasFullCluster
    ? [
      ...ORPHAN_LANDING_LOCALES.map((alt) => {
        if (alt === locale) {
          return `    <link rel="alternate" hreflang="${alt}" href="${canonicalUrl}">`;
        }
        const altPath = buildOrphanLandingPath(alt, cluster.canonicalSlug);
        return `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${altPath}">`;
      }),
      `    <link rel="alternate" hreflang="x-default" href="${xDefaultHref}">`,
    ].join('\n')
    : '';

  // Generic "all jobs" / "similar queries" link — not scoped to any single
  // job's canton, so it points at the Switzerland-wide aggregate board
  // (same pattern as legacyRedirectsPlugin.ts's `_AGGREGATE_` fallback).
  const jobBoardRootPath = `${ORPHAN_LANDING_LOCALE_PREFIX[locale]}/${resolveCantonSection(locale, AGGREGATE_KEY)}/`.replace(/\/+/g, '/');

  const editorialFam = pickEditorialFamily(cluster);
  const editorialBody = t(editorialKey(editorialFam),
    'Swiss cross-border job market: competitive wages, withholding tax, mandatory health insurance, and 13th-month pay. The 2026 Cross-Border Workers Agreement applies within 20 km of the border.',
  );
  const genericBody = t('orphanLanding.editorialGeneric',
    'The Swiss labour market offers attractive economic and legal conditions for Italian cross-border workers.',
  );

  const medianSalary = searchSalaryMedian(matchingJobs);
  const salaryExplanation = buildSalaryAnswer(locale, medianSalary > 0 ? `CHF ${medianSalary.toLocaleString('de-CH')}` : '');
  const topEmployers = topCounts(matchingJobs.map((j) => j.company), 5);
  const topCities = topCounts(matchingJobs.map((j) => j.addressLocality || j.location), 3);

  // Similar queries
  const similar = cluster.queries.slice(0, 15);

  // Job cards — SPA-matching markup via shared renderer
  const cardItems: JobCardListItem[] = matchingJobs.slice(0, 15).map((j) => {
    // Force a localized title onto a shallow copy so the shared renderer
    // (which prefers titleByLocale[locale] then job.title) picks up the
    // orphan-landing fallback ("Posizione aperta") when both are empty.
    const localizedTitle =
      jobLocalizedTitle(j, locale) || t('orphanLanding.openPosition', 'Posizione aperta');
    const enrichedJob: JobCardJob = {
      ...(j as unknown as JobCardJob),
      title: localizedTitle,
      titleByLocale: { ...(j as JobCardJob).titleByLocale, [locale]: localizedTitle },
    };
    return {
      job: enrichedJob,
      href: jobLocalizedUrl(j, locale),
    };
  });
  const jobCards = renderJobCardListHtml(cardItems, { locale });

  const similarList = similar.map((q) => `<li class="s-F6hoFh"><a href="${esc(jobBoardRootPath)}" style="${LINK_ACCENT_STYLE}">${esc(q.query)}</a> <span class="s-7pwP-Z">(${q.impressions})</span></li>`).join('');

  const employerList = topEmployers.length > 0
    ? topEmployers.map((e) => `<li>${esc(e.name)} (${e.count})</li>`).join('')
    : '';
  const cityList = topCities.length > 0
    ? topCities.map((c) => `<li>${esc(c.name)}</li>`).join('')
    : '';

  const itemListLd = matchingJobs.length > 0 ? JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: cluster.canonicalQuery,
    numberOfItems: matchingJobs.length,
    itemListElement: matchingJobs.slice(0, 15).map((j, idx) => ({
      '@type': 'ListItem',
      position: idx + 1,
      name: jobLocalizedTitle(j, locale),
      url: jobLocalizedUrl(j, locale),
    })),
  }) : '';

  const h1ForLd = buildEditorialH1(cluster.canonicalQuery, locale);

  const breadcrumbLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: t('orphanLanding.breadcrumbHome', 'Home'), item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: h1ForLd, item: canonicalUrl },
    ],
  });

  const webPageLd = inlineScriptJson({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: h1ForLd,
    url: canonicalUrl,
    description: editorialBody.slice(0, 200),
    inLanguage: locale,
    isPartOf: { '@type': 'WebSite', url: `${BASE_URL}/`, name: 'Frontaliere Ticino' },
  });

  // Decide indexability — <MIN_MATCHING_JOBS jobs → noindex (anti-doorway).
  const indexable = matchingJobs.length >= MIN_MATCHING_JOBS;

  const body = `
    <nav class="s-bcr">
      <a href="/" class="s-bcl">${esc(t('orphanLanding.breadcrumbHome', 'Home'))}</a>
      <span> / </span>
      <span>${esc(cluster.canonicalQuery)}</span>
    </nav>
    <header class="s-YcUNX5">
      <p style="${HERO_EYEBROW_STYLE}">${esc(t('orphanLanding.updatedLabel', 'Updated'))} · ${esc(dateStamp)}</p>
      <h1 style="${H1_STYLE}">${esc(buildEditorialH1(cluster.canonicalQuery, locale))}</h1>
      <p style="${LEDE_STYLE}">${esc(matchingJobs.length > 0 ? (locale === 'it' ? `${matchingJobs.length} offerte attive per "${cluster.canonicalQuery}"${medianSalary > 0 ? ` · mediana salario CHF ${medianSalary.toLocaleString('de-CH')}` : ''}.` : locale === 'en' ? `${matchingJobs.length} active openings for "${cluster.canonicalQuery}"${medianSalary > 0 ? ` · median salary CHF ${medianSalary.toLocaleString('de-CH')}` : ''}.` : locale === 'de' ? `${matchingJobs.length} aktive Stellen für "${cluster.canonicalQuery}"${medianSalary > 0 ? ` · Median CHF ${medianSalary.toLocaleString('de-CH')}` : ''}.` : `${matchingJobs.length} offres actives pour « ${cluster.canonicalQuery} »${medianSalary > 0 ? ` · médiane CHF ${medianSalary.toLocaleString('de-CH')}` : ''}.`) : esc(t('orphanLanding.noResults', 'No openings.')))}</p>
    </header>
    <section class="s-IdxvJZ">
      <div class="s-tbase">
        <div class="s-tlbl">${esc(t('orphanLanding.medianSalary', 'Median salary'))}</div>
        <div class="s-tval">${medianSalary > 0 ? `CHF ${medianSalary.toLocaleString('de-CH')}` : esc(t('orphanLanding.medianSalaryNA', 'N/A'))}</div>
      </div>
      ${topEmployers.length > 0 ? `<div class="s-tbase">
        <div class="s-tlbl">${esc(t('orphanLanding.topEmployers', 'Top employers'))}</div>
        <ul class="s-qVzgqV">${employerList}</ul>
      </div>` : ''}
      ${topCities.length > 0 ? `<div class="s-tbase">
        <div class="s-tlbl">${esc(t('orphanLanding.topCities', 'Top cities'))}</div>
        <ul class="s-qVzgqV">${cityList}</ul>
      </div>` : ''}
    </section>
    <p class="s-WzYXnb">${esc(salaryExplanation)}</p>
    <section class="s-KZc0LQ">
      <h2 class="s-sOn5-B">${esc(t('orphanLanding.resultsLabel', 'Openings'))}</h2>
      ${matchingJobs.length > 0
        ? jobCards
        : `<p class="s-WzYXnb">${esc(t('orphanLanding.noResults', 'No openings.'))}</p>`}
    </section>
    ${similar.length > 1 ? `<section class="s-KZc0LQ">
      <h2 class="s-sOn5-B">${esc(t('orphanLanding.similarQueries', 'Similar searches'))}</h2>
      <ul class="s-LvQ0sH">${similarList}</ul>
    </section>` : ''}
    <section class="s-KZc0LQ">
      <h2 class="s-sOn5-B">${esc(t('orphanLanding.faqH2', 'FAQ'))}</h2>
      <details class="s-bOXb_q">
        <summary class="s-evnceI">${esc(t('orphanLanding.faqQ1', ''))}</summary>
        <p class="s-dbDev_">${esc(t('orphanLanding.faqA1', ''))}</p>
      </details>
      <details class="s-bOXb_q">
        <summary class="s-evnceI">${esc(t('orphanLanding.faqQ2', ''))}</summary>
        <p class="s-dbDev_">${esc(t('orphanLanding.faqA2', ''))}</p>
      </details>
    </section>
    <section class="s-p1QaOi">
      <a href="${esc(jobBoardRootPath)}" class="s-cta">${esc(t('orphanLanding.ctaAllJobs', 'All jobs'))}</a>
      <a class="s-bX1C8q" href="${CALC_HREF[locale]}">${esc(t('orphanLanding.ctaCalculator', 'Calculate net salary'))}</a>
    </section>
    <section class="s-86Shfc">
      <p class="s-lx0qs8">${esc(editorialBody)}</p>
      <p class="s-R5y55I">${esc(buildClusterSignalsParagraph(cluster, locale))}</p>
      <p class="s-mLcS-R">${esc(genericBody)}</p>
    </section>
    ${generateRelatedLinksBlock(locale, 'orphan_landing', { city: topCities[0]?.name })}
    ${(() => {
      // Substantive interpretation block — pushes text/HTML ratio above the
      // 10 % Semrush threshold for the orphan-landing leaf pages
      // (~80 KB chrome with little prose otherwise → 5 % ratio).
      // Each block uses the cluster's actual canonicalQuery + median salary
      // + top employer + top city, so every leaf has unique per-page prose.
      const q = cluster.canonicalQuery;
      const employer = topEmployers[0]?.name ?? '';
      const city = topCities[0]?.name ?? '';
      const med = medianSalary > 0 ? `CHF ${medianSalary.toLocaleString('de-CH')}` : '';
      if (locale === 'it') {
        return `<section class="s-OQInrb">
          <h2 class="s-sOn5-B">Come leggere questa ricerca per un frontaliere italo-svizzero</h2>
          <p class="s-zQltsL">Gli annunci sopra sono selezionati per i termini professionali della ricerca <em>${esc(q)}</em>. Verifica nella scheda originale responsabilità, requisiti, sede e stato della candidatura. Il fatto che una posizione compaia qui non conferma automaticamente il riconoscimento di un titolo di studio estero o il diritto individuale a un permesso di lavoro.</p>
          <h2 class="s-sOn5-B">Cosa cambia con il Nuovo Accordo 2026</h2>
          <p class="s-zQltsL">${esc(CROSS_BORDER_TAX_FACTS[locale])} <a href="${CROSS_BORDER_TAX_SOURCE}">ESTV</a></p>
          <h2 class="s-sOn5-B">Per chi è utile questa selezione</h2>
          <p class="s-AA8lz_">Confronta gli annunci per sede, mansioni e condizioni contrattuali. I dati salariali disponibili descrivono solo il campione corrente; l’assenza di una cifra non significa che la posizione non sia retribuita. Per ampliare la ricerca usa le ricerche correlate o la <a href="${esc(jobBoardRootPath)}" style="${LINK_ACCENT_STYLE}">bacheca delle offerte attive</a>.</p>
        </section>`;
      }
      if (locale === 'en') {
        return `<section class="s-OQInrb">
          <h2 class="s-sOn5-B">How to read this search for an Italian-Swiss cross-border worker</h2>
          <p class="s-zQltsL">The listings above are selected for the occupational terms in <em>${esc(q)}</em>. Check the original listing for responsibilities, qualifications, location and application status. Inclusion here does not automatically confirm recognition of a foreign qualification or your individual eligibility for a work permit.</p>
          <h2 class="s-sOn5-B">What the 2026 New Agreement changes</h2>
          <p class="s-zQltsL">${esc(CROSS_BORDER_TAX_FACTS[locale])} <a href="${CROSS_BORDER_TAX_SOURCE}">ESTV</a></p>
          <h2 class="s-sOn5-B">Who this selection is for</h2>
          <p class="s-AA8lz_">Compare location, responsibilities and contractual terms. Available salary data describe only the current sample; a missing amount does not mean a position is unpaid. To broaden your search use related queries or the <a href="${esc(jobBoardRootPath)}" style="${LINK_ACCENT_STYLE}">active job board</a>.</p>
        </section>`;
      }
      if (locale === 'de') {
        return `<section class="s-OQInrb">
          <h2 class="s-sOn5-B">Wie diese Suche für italo-schweizerische Grenzgänger zu lesen ist</h2>
          <p class="s-zQltsL">Die obigen Anzeigen werden nach den Berufsbegriffen der Suche <em>${esc(q)}</em> ausgewählt. Prüfen Sie Aufgaben, Qualifikationen, Arbeitsort und Bewerbungsstatus in der Originalanzeige. Ein Eintrag bestätigt weder automatisch die Anerkennung eines ausländischen Abschlusses noch den persönlichen Anspruch auf eine Arbeitsbewilligung.</p>
          <h2 class="s-sOn5-B">Was sich mit dem Neuen Abkommen 2026 ändert</h2>
          <p class="s-zQltsL">${esc(CROSS_BORDER_TAX_FACTS[locale])} <a href="${CROSS_BORDER_TAX_SOURCE}">ESTV</a></p>
          <h2 class="s-sOn5-B">Für wen diese Auswahl ist</h2>
          <p class="s-AA8lz_">Vergleichen Sie Arbeitsort, Aufgaben und Vertragsbedingungen. Verfügbare Lohndaten beschreiben nur die aktuelle Stichprobe; eine fehlende Angabe bedeutet nicht, dass die Stelle unbezahlt ist. Nutzen Sie verwandte Suchanfragen oder die <a href="${esc(jobBoardRootPath)}" style="${LINK_ACCENT_STYLE}">Jobbörse für offene Stellen</a>.</p>
        </section>`;
      }
      return `<section class="s-OQInrb">
        <h2 class="s-sOn5-B">Comment lire cette recherche pour un frontalier italo-suisse</h2>
          <p class="s-zQltsL">Les annonces ci-dessus sont sélectionnées selon les termes professionnels de la recherche <em>${esc(q)}</em>. Vérifiez les missions, qualifications, le lieu et le statut de candidature dans l’annonce originale. Leur présence ici ne confirme pas automatiquement la reconnaissance d’un diplôme étranger ni votre droit individuel à un permis de travail.</p>
        <h2 class="s-sOn5-B">Ce que change le Nouvel Accord 2026</h2>
        <p class="s-zQltsL">${esc(CROSS_BORDER_TAX_FACTS[locale])} <a href="${CROSS_BORDER_TAX_SOURCE}">ESTV</a></p>
        <h2 class="s-sOn5-B">À qui s'adresse cette sélection</h2>
          <p class="s-AA8lz_">Comparez lieu, missions et conditions contractuelles. Les données salariales décrivent seulement l’échantillon actuel ; un montant absent ne signifie pas que le poste n’est pas rémunéré. Élargissez la recherche avec les requêtes associées ou les <a href="${esc(jobBoardRootPath)}" style="${LINK_ACCENT_STYLE}">offres actives</a>.</p>
      </section>`;
    })()}
    ${buildExtendedFaqAccordion(locale, {
      query: cluster.canonicalQuery,
      employer: topEmployers[0]?.name ?? '',
      city: topCities[0]?.name ?? '',
      med: medianSalary > 0 ? `CHF ${medianSalary.toLocaleString('de-CH')}` : '',
    })}
  `;

  const wordCount = countHtmlBodyWords(body);
  const robots = (indexable && wordCount >= MIN_INDEXABLE_WORDS)
    ? 'index,follow'
    : 'noindex,follow';

  const editorialH1 = buildEditorialH1(cluster.canonicalQuery, locale);
  const editorialPageTitle = buildEditorialTitle(cluster.canonicalQuery, locale);
  const description = buildEditorialDescription(cluster.canonicalQuery, locale, editorialBody);

  const jsonLdScripts = [breadcrumbLd, webPageLd];
  if (itemListLd) jsonLdScripts.push(itemListLd);

  // Keep the existing inline-styled `<main>` so the static shell still renders
  // something readable before React hydrates. buildSimplePage wraps this in
  // `<div id="root">` with `skipMainWrap: true` to avoid nested <main>.
  const bodyHtml = `<article class="s-it71Rt">
        ${body}
        <section class="s-sC82IX" aria-label="advertisement">
          ${adSlotHtml('JOBLIST_END_MULTIPLEX')}
        </section>
      </article>`;

  const html = buildSeoPageHtml({
    locale,
    title: editorialPageTitle,
    description,
    canonicalUrl,
    robots,
    ogType: 'website',
    ogLocale: ORPHAN_LANDING_OG_LOCALE[locale],
    hreflangHtml: alternates,
    jsonLdScripts,
    bodyHtml,
    distDir,
    hubChrome: { hubKey: 'job-board', activeSubTab: 'jobs' },
  });

  return {
    urlPath,
    html,
    wordCount,
    matchingJobsCount: matchingJobs.length,
    indexable: indexable && wordCount >= MIN_INDEXABLE_WORDS,
  };
}

export interface OrphanLandingBuildSummary {
  clustersConsidered: number;
  pagesGenerated: number;
  pagesIndexable: number;
  routes: OrphanLandingRoute[];
}

export function orphanQueryLandingPlugin(rootDir: string): Plugin {
  return {
    name: 'orphan-query-landings',
    apply: 'build',
    async closeBundle() {
      if (process.env.SKIP_ORPHAN_LANDINGS === '1') {
        console.log('\x1b[36m[orphan-query-landings]\x1b[0m skipped (SKIP_ORPHAN_LANDINGS=1)');
        return;
      }

      const distDir = path.resolve(rootDir, 'dist');
      const clustersPath = path.join(rootDir, 'data', 'gsc-orphan-queries-clusters.json');

      if (!fs.existsSync(clustersPath)) {
        console.warn(
          '\x1b[33m[orphan-query-landings]\x1b[0m clusters file missing at data/gsc-orphan-queries-clusters.json — run scripts/cluster-orphan-queries.mjs first. Skipping (soft).',
        );
        return;
      }

      let parsed: OrphanQueryClustersFile | null = null;
      try {
        parsed = JSON.parse(fs.readFileSync(clustersPath, 'utf-8')) as OrphanQueryClustersFile;
      } catch (err) {
        console.warn('\x1b[33m[orphan-query-landings]\x1b[0m failed to parse clusters file:', err);
        return;
      }
      if (!parsed || !Array.isArray(parsed.clusters) || parsed.clusters.length === 0) {
        console.log('\x1b[36m[orphan-query-landings]\x1b[0m 0 clusters in file — nothing to generate');
        return;
      }

      const maxEnv = intFromEnv('MAX_ORPHAN_LANDINGS', 0);
      const maxLandings = Number.isFinite(maxEnv) && maxEnv > 0 ? Math.floor(maxEnv) : DEFAULT_MAX_LANDINGS;

      const jobs = loadAllJobs(rootDir);
      console.log(`\x1b[36m[orphan-query-landings]\x1b[0m loaded ${jobs.length} jobs, ${parsed.clusters.length} clusters (cap ${maxLandings})`);

      const clusters = parsed.clusters.slice(0, maxLandings);

      // Build locale → set-of-slugs map for hreflang decisions.
      const knownSlugsByLocale = new Map<OrphanLandingLocale, Set<string>>();
      for (const loc of ORPHAN_LANDING_LOCALES) knownSlugsByLocale.set(loc, new Set<string>());
      for (const c of clusters) {
        const set = knownSlugsByLocale.get(c.locale);
        if (set) set.add(c.canonicalSlug);
      }

      const localeStrings: Record<OrphanLandingLocale, Record<string, string>> = {
        it: await loadLocaleStrings(rootDir, 'it'),
        en: await loadLocaleStrings(rootDir, 'en'),
        de: await loadLocaleStrings(rootDir, 'de'),
        fr: await loadLocaleStrings(rootDir, 'fr'),
      };

      const collector = new WriteCollector({ distDir, pluginName: 'orphanQueryLandingPlugin' });
      const dateStamp = new Date().toISOString().slice(0, 10);
      const sitemapEntries: string[] = [];
      const routes: OrphanLandingRoute[] = [];
      let pagesGenerated = 0;
      let pagesIndexable = 0;
      let canonicalBridges = 0;

      // Track every indexable cluster per locale so the hub index can list
      // ALL of them (closing the BFS-orphan gap when cron-published
      // clusters arrive without any inbound `<a>` link).
      const indexableByLocale: Record<OrphanLandingLocale, Array<{ slug: string; query: string; path: string }>> = {
        it: [], en: [], de: [], fr: [],
      };

      // Single source of truth for the renderPage(...) arg set + the
      // `filterMatchingJobs(jobs, cluster, 15)` literal shared by the emission
      // pass (below) and the hub-hreflang availability pass (further down).
      // The availability predicate (`hubHreflangAvailability`) keys on the same
      // `render.indexable` the emission pass uses to populate
      // `indexableByLocale`; if the two arg sets ever drifted, a hub could
      // advertise an hreflang alternate to a locale that never gets a page
      // emitted → 404 (funnel-critical: SEO). Deriving both from this one
      // helper makes that drift impossible by construction.
      const renderClusterPage = (cluster: OrphanQueryCluster): RenderedPageResult =>
        renderPage({
          cluster,
          matchingJobs: filterMatchingJobs(jobs, cluster, 15),
          strings: localeStrings[cluster.locale] || {},
          dateStamp,
          knownSlugsByLocale,
          distDir,
        });

      for (const cluster of clusters) {
        // Per-locale shard build (BUILD_LOCALE): a pure non-it shard renders
        // ONLY its own locale's orphan landings. The it/main shard (EMIT_LOCALES
        // has 'it') keeps rendering ALL locales because it owns the root
        // sitemap-orphan-landings.xml, whose per-page inclusion depends on the
        // rendered indexability (matchingJobs>=3 && wordCount>=MIN) — not
        // derivable without rendering. No-op in the default all-locale build.
        if (!shouldEmitLocale(cluster.locale) && !EMIT_LOCALES.has('it')) continue;

        const nursingTarget = resolveNursingOrphanQueryTarget(cluster.canonicalQuery, cluster.canonicalSlug);
        if (nursingTarget) {
          const urlPath = buildOrphanLandingPath(cluster.locale, cluster.canonicalSlug);
          const bridgeHtml = buildNursingOrphanCanonicalBridge(nursingTarget);
          const indexPath = path.join(distDir, urlPath, 'index.html');
          const flatPath = path.join(distDir, urlPath.replace(/\/+$/, '') + '.html');
          collector.add(indexPath, bridgeHtml);
          collector.add(flatPath, bridgeHtml);
          // Historical nursing aliases stay collector-only: publishing this
          // noindex bridge through routes would make it eligible for orphan
          // hub/sitemap navigation despite its canonical redirect target.
          pagesGenerated++;
          canonicalBridges++;
          continue;
        }

        const render = renderClusterPage(cluster);

        // Enforce quality gates. We still WRITE the page (so existing
        // crawled URLs get something back) but we mark it noindex and
        // keep it out of the sitemap when it fails either gate.
        const indexPath = path.join(distDir, render.urlPath, 'index.html');
        const flatPath = path.join(distDir, render.urlPath.replace(/\/+$/, '') + '.html');
        collector.add(indexPath, render.html);
        collector.add(flatPath, render.html);

        routes.push({
          locale: cluster.locale,
          slug: cluster.canonicalSlug,
          path: render.urlPath,
        });
        pagesGenerated++;

        if (render.indexable) {
          pagesIndexable++;
          sitemapEntries.push(
            `  <url>\n    <loc>${BASE_URL}${render.urlPath}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>`,
          );
          indexableByLocale[cluster.locale].push({
            slug: cluster.canonicalSlug,
            query: cluster.canonicalQuery,
            path: render.urlPath,
          });
        }
      }

      // Cross-locale hreflang availability for the hub pages — computed over
      // ALL clusters, INDEPENDENT of the BUILD_LOCALE emit filter. The hub's
      // hreflang block is a cross-locale CONSTANT (per localeEmitFilter.ts
      // contract: the emit filter only gates which FILES are written, never
      // which locales appear in an alternates block) and MUST enumerate the
      // full 4-locale + x-default set on every shard. Deriving it from the
      // emit-gated `indexableByLocale` (populated only for the shard's own
      // locale on a non-it shard) collapsed the en/de/fr hubs to 2 hreflang
      // entries and failed audit-hreflang (deploy 27923956556).
      //
      // The predicate MUST mirror the hub-EMISSION gate below (`if
      // (indexableByLocale[loc].length === 0) continue;`), which keys on
      // `render.indexable = matchingJobs>=MIN_MATCHING_JOBS && wordCount>=
      // MIN_INDEXABLE_WORDS` — i.e. BOTH gates. A jobs-only test
      // (`filterMatchingJobs(...).length >= MIN_MATCHING_JOBS`) is a strict
      // superset: a locale whose jobs-passing clusters all fall under
      // MIN_INDEXABLE_WORDS would be flagged available here yet never get a hub
      // page emitted → hreflang alternate pointing at a 404. So we recompute
      // the FULL render predicate per cluster. `renderPage` is side-effect-free
      // (`buildSeoPageHtml` returns a string; no file writes), so this ungated
      // pass is safe, and the per-locale short-circuit caps it to one indexable
      // cluster per locale. This makes `hubHreflangAvailability.X` exactly
      // `indexableByLocale.X.length > 0` site-wide → byte-identical to the
      // monolith under EMIT_ALL_LOCALES, and 404-free on per-locale shards.
      const hubHreflangAvailability: Record<OrphanLandingLocale, boolean> = {
        it: false, en: false, de: false, fr: false,
      };
      for (const cluster of clusters) {
        if (hubHreflangAvailability[cluster.locale]) continue;
        // Canonical nursing aliases emit a noindex bridge only; they are not
        // indexable orphan entries and must not make an orphan hub appear
        // available when no real cluster exists for that locale.
        if (resolveNursingOrphanQueryTarget(cluster.canonicalQuery, cluster.canonicalSlug)) continue;
        const availabilityRender = renderClusterPage(cluster);
        if (availabilityRender.indexable) {
          hubHreflangAvailability[cluster.locale] = true;
        }
      }

      // ── Hub pages — one per locale, listing ALL indexable orphan-landings.
      // Without this hub, every cron-published cluster lands in
      // `sitemap-orphan-landings.xml` with zero `<a>` inbound and trips the
      // orphan-pages-in-sitemaps audit. The hub is added to the same sitemap
      // and is itself reachable from `/mappa-del-sito/` (linked in
      // staticPagesPlugin's renderHubLinks block), so each cluster is at
      // BFS depth 3 from `/`.
      const HUB_COPY: Record<OrphanLandingLocale, { title: string; description: string; h1: string; intro: string; breadcrumbHome: string; sectionLabel: string }> = {
        it: {
          title: 'Ricerche correlate per frontalieri',
          description: 'Indice completo delle pagine di ricerca lavoro generate da query reali dei frontalieri italo-svizzeri.',
          h1: 'Ricerche correlate per frontalieri',
          intro: 'Questo indice raccoglie tutte le pagine di ricerca lavoro indicizzate, generate a partire dalle query effettive dei frontalieri italo-svizzeri.',
          breadcrumbHome: 'Home',
          sectionLabel: 'Ricerche correlate',
        },
        en: {
          title: 'Cross-border worker job searches',
          description: 'Full index of indexable job search landing pages generated from real cross-border worker queries.',
          h1: 'Cross-border worker job searches',
          intro: 'This index lists every indexable search landing page, generated from actual cross-border worker queries.',
          breadcrumbHome: 'Home',
          sectionLabel: 'Search landings',
        },
        de: {
          title: 'Grenzgänger-Jobsuche — Index',
          description: 'Vollständiger Index der indexierbaren Such-Landingpages, erzeugt aus echten Grenzgänger-Suchanfragen.',
          h1: 'Grenzgänger-Jobsuche — Index',
          intro: 'Dieser Index enthält alle indexierbaren Suchlandingpages, erzeugt aus echten Grenzgänger-Suchanfragen.',
          breadcrumbHome: 'Home',
          sectionLabel: 'Suchseiten',
        },
        fr: {
          title: 'Recherches d\'emploi pour frontaliers',
          description: 'Index complet des pages d\'atterrissage de recherche indexables, générées à partir de vraies requêtes de frontaliers.',
          h1: 'Recherches d\'emploi pour frontaliers',
          intro: 'Cet index liste toutes les pages d\'atterrissage de recherche indexables, générées à partir de vraies requêtes de frontaliers.',
          breadcrumbHome: 'Home',
          sectionLabel: 'Pages de recherche',
        },
      };

      for (const loc of ORPHAN_LANDING_LOCALES) {
        const list = indexableByLocale[loc];
        if (list.length === 0) continue;
        const sorted = [...list].sort((a, b) => a.query.localeCompare(b.query, loc));
        const copy = HUB_COPY[loc];
        const hubPath = buildOrphanLandingHubPath(loc);
        const canonicalUrl = buildOrphanLandingHubUrl(loc);

        const itemsHtml = sorted
          .map((it) => `<li class="s-q3nqK4"><a href="${esc(it.path)}" style="${LINK_ACCENT_STYLE};font-weight:600">${esc(cap(it.query))}</a></li>`)
          .join('');

        const breadcrumbLd = inlineScriptJson({
          '@context': 'https://schema.org',
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: `${BASE_URL}/` },
            { '@type': 'ListItem', position: 2, name: copy.sectionLabel, item: canonicalUrl },
          ],
        });
        const collectionLd = inlineScriptJson({
          '@context': 'https://schema.org',
          '@type': 'CollectionPage',
          name: copy.title,
          url: canonicalUrl,
          description: copy.description,
          inLanguage: loc,

          mainEntity: {
            '@type': 'ItemList',
            numberOfItems: sorted.length,
            itemListElement: sorted.slice(0, 100).map((it, i) => ({
              '@type': 'ListItem',
              position: i + 1,
              name: cap(it.query),
              url: `${BASE_URL}${it.path}`,
            })),
          },
        });

        // hreflang availability is computed over ALL locales site-wide
        // (ungated), NOT just the locales this shard emitted — see
        // hubHreflangAvailability above. The renderer is all-or-nothing: it
        // emits the full 4-locale + x-default set only when every locale has an
        // indexable hub, else '' (audit-hreflang rejects a partial set).
        const hreflangHtml = renderOrphanLandingHubHreflang(hubHreflangAvailability);

        // Locale-aware "how it works" + "who it's for" prose. Without it,
        // the hub renders as breadcrumb + h1 + intro + list — under 50 visible
        // words, tripping `validate:sitemap-pages`'s thin-content gate AND
        // dragging text/HTML ratio below 10 % once chrome is layered on.
        const HUB_PROSE_HOW: Record<OrphanLandingLocale, string> = {
          it: "Ogni pagina raccoglie gli annunci disponibili per una ricerca professionale e le sue varianti. I risultati provengono dal nostro indice di offerte e cambiano quando vengono aggiunte o ritirate posizioni. Il titolo e la sede aiutano a confrontare la pertinenza; prima di candidarti consulta sempre la fonte originale per mansioni, requisiti, orari e disponibilità. La selezione non verifica la tua idoneità individuale al permesso G né la compatibilità degli orari con il tragitto da casa.",
          en: "Each page collects available listings for an occupational search and its variants. Results come from our job index and change as positions are added or withdrawn. Title and location help assess relevance; check the original source for responsibilities, requirements, hours and vacancy status before applying. This selection does not verify your individual eligibility for a G permit or whether working hours fit your commute.",
          de: "Jede Seite sammelt verfügbare Anzeigen für eine berufliche Suchanfrage und ihre Varianten. Die Ergebnisse stammen aus unserem Stellenindex und ändern sich mit neuen oder entfernten Anzeigen. Titel und Arbeitsort helfen beim Vergleich. Prüfen Sie Aufgaben, Anforderungen, Arbeitszeiten und Stellenstatus vor der Bewerbung in der Originalquelle. Die Auswahl bestätigt weder Ihre persönliche Eignung für eine G-Bewilligung noch die Vereinbarkeit der Arbeitszeiten mit Ihrem Arbeitsweg.",
          fr: "Chaque page rassemble les annonces disponibles pour une recherche professionnelle et ses variantes. Les résultats proviennent de notre index et changent lorsque des postes sont ajoutés ou retirés. Le titre et le lieu aident à comparer la pertinence ; consultez la source originale pour les missions, exigences, horaires et disponibilité avant de postuler. La sélection ne vérifie pas votre admissibilité personnelle au permis G ni la compatibilité des horaires avec votre trajet.",
        };
        const HUB_PROSE_WHY: Record<OrphanLandingLocale, string> = {
          it: "Usa questo indice per confrontare una ricerca precisa o esplorare professioni e località. Ogni voce apre i risultati disponibili per quella ricerca, con datori di lavoro e sedi presenti nel campione. Le pagine salariali mostrano una mediana soltanto quando esistono almeno cinque fasce salariali documentate in CHF; in caso contrario dichiarano il limite dei dati. Il calcolatore aiuta a confrontare scenari partendo da un lordo verificato.",
          en: "Use this index to compare a specific search or explore occupations and locations. Each entry opens the available results, including employers and locations in the sample. Salary pages show a median only when at least five documented CHF salary ranges are available; otherwise they state the data limitation. The calculator helps compare scenarios using a verified gross salary.",
          de: "Nutzen Sie den Index für eine konkrete Suche oder zum Vergleich von Berufen und Arbeitsorten. Jeder Eintrag öffnet verfügbare Ergebnisse mit Arbeitgebern und Standorten der Stichprobe. Lohnseiten zeigen einen Median nur bei mindestens fünf dokumentierten CHF-Lohnspannen; andernfalls nennen sie die Datengrenze. Der Rechner ermöglicht Szenarien mit einem geprüften Bruttolohn.",
          fr: "Utilisez cet index pour une recherche précise ou pour explorer métiers et lieux. Chaque entrée présente les résultats disponibles, avec les employeurs et lieux de l’échantillon. Les pages salariales affichent une médiane seulement avec au moins cinq fourchettes documentées en CHF ; sinon elles indiquent la limite des données. Le calculateur permet de comparer des scénarios à partir d’un brut vérifié.",
        };
        // Third prose block — substantive economic + permit context. Keeps the
        // non-IT hubs above the 10 % text/HTML ratio threshold (en/de/fr have
        // fewer indexable clusters than IT, so the <li> list contributes less
        // visible text and the hub previously landed at 8.6-9.1 %).
        const HUB_PROSE_ECON: Record<OrphanLandingLocale, string> = {
          it: 'Per valutare una proposta confronta salario lordo annuo, percentuale di impiego, mensilità, sede e costi di viaggio. Le mediane delle pagine di ricerca descrivono solo il campione disponibile e vengono mostrate soltanto quando vi sono almeno cinque fasce salariali documentate; non sostituiscono il dato del datore di lavoro. Il netto dipende anche dalla situazione fiscale e personale: usa il calcolatore con un lordo verificato.',
          en: 'Compare annual gross pay, working percentage, instalments, location and commuting costs. Search-page medians describe only the available sample and appear only when at least five documented salary ranges are available; they do not replace the employer’s offer. Net pay also depends on tax and personal circumstances: use the calculator with a verified gross amount.',
          de: 'Vergleichen Sie Jahresbruttolohn, Pensum, Auszahlungen, Standort und Fahrtkosten. Die Mediane der Suchseiten beschreiben nur die verfügbare Stichprobe und erscheinen erst bei mindestens fünf dokumentierten Lohnspannen; sie ersetzen kein Arbeitgeberangebot. Der Nettolohn hängt auch von steuerlichen und persönlichen Umständen ab. Nutzen Sie den Rechner mit einem geprüften Bruttobetrag.',
          fr: 'Comparez salaire annuel brut, taux d’activité, versements, lieu et frais de trajet. Les médianes des pages de recherche décrivent uniquement l’échantillon disponible et nécessitent au moins cinq fourchettes documentées ; elles ne remplacent pas l’offre de l’employeur. Le net dépend aussi de la fiscalité et de la situation personnelle : utilisez le calculateur avec un brut vérifié.',
        };

        const bodyHtml = `<article class="s-xzWvwM">
          <nav class="s-bcr">
            <a href="/" class="s-bcl">${esc(copy.breadcrumbHome)}</a>
            <span> / </span>
            <span>${esc(copy.sectionLabel)}</span>
          </nav>
          <header class="s-Nv0GaD">
            <h1 class="s-PGjX_Q">${esc(copy.h1)}</h1>
            <p class="s-JlLVGf">${esc(copy.intro)}</p>
            <p class="s-XLkmUf">${sorted.length} · ${esc(dateStamp)}</p>
          </header>
          <section class="s-H1qo5-">
            <ul class="s-N93mPe">${itemsHtml}</ul>
          </section>
          <section class="s-Kdse50">
            <p class="s-ZcgQDz">${esc(HUB_PROSE_HOW[loc])}</p>
            <p class="s-ZcgQDz">${esc(HUB_PROSE_WHY[loc])}</p>
            <p class="s-wXMVsI">${esc(HUB_PROSE_ECON[loc])}</p>
          </section>
        </article>`;

        const hubHtml = buildSeoPageHtml({
          disableAutoAds: false,
          locale: loc,
          title: clampSiteSuffix(copy.title, 'Frontaliere Ticino', 60),
          description: copy.description,
          canonicalUrl,
          robots: 'index,follow',
          ogType: 'website',
          ogLocale: ORPHAN_LANDING_OG_LOCALE[loc],
          hreflangHtml,
          extraHeadHtml: '',
          jsonLdScripts: [breadcrumbLd, collectionLd],
          bodyHtml,
          distDir,
          hubChrome: { hubKey: 'job-board', activeSubTab: 'jobs' },
        });

        collector.add(path.join(distDir, hubPath, 'index.html'), hubHtml);
        collector.add(path.join(distDir, hubPath.replace(/\/+$/, '') + '.html'), hubHtml);

        sitemapEntries.push(
          `  <url>\n    <loc>${canonicalUrl}</loc>\n    <changefreq>daily</changefreq>\n    <priority>0.7</priority>\n  </url>`,
        );
      }

      // Write dedicated sitemap + patch master sitemap index.
      if (sitemapEntries.length > 0) {
        const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapEntries.join('\n')}\n</urlset>\n`;
        try {
          fs.mkdirSync(distDir, { recursive: true });
          fs.writeFileSync(path.join(distDir, 'sitemap-orphan-landings.xml'), sitemapXml, 'utf-8');

          const masterSitemap = path.join(distDir, 'sitemap.xml');
          if (fs.existsSync(masterSitemap)) {
            let idx = fs.readFileSync(masterSitemap, 'utf-8');
            if (!idx.includes('sitemap-orphan-landings.xml')) {
              idx = idx.replace(
                '</sitemapindex>',
                `  <sitemap>\n    <loc>${BASE_URL}/sitemap-orphan-landings.xml</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`,
              );
            } else {
              idx = idx.replace(
                /(<loc>https:\/\/frontaliereticino\.ch\/sitemap-orphan-landings\.xml<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
                `$1${dateStamp}$2`,
              );
            }
            fs.writeFileSync(masterSitemap, idx, 'utf-8');
          }
        } catch (err) {
          console.warn('\x1b[33m[orphan-query-landings]\x1b[0m sitemap write failed:', err);
        }
      }

      const t0 = Date.now();
      const written = await collector.flush();
      console.log(
        `\x1b[36m[orphan-query-landings]\x1b[0m Generated ${pagesGenerated} pages (${pagesIndexable} indexable, ${pagesGenerated - pagesIndexable} noindex, ${canonicalBridges} canonical nursing bridges) — flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
    },
  };
}

/** Re-export routing data shape for the router. */
export type { OrphanLandingRoute, OrphanLandingLocale };

/**
 * Exported for duplicate-body tests — exercises the per-cluster distinguishing
 * content injected into the page body so that sparse clusters (few matching
 * jobs, `generic` editorial family) cannot collide on body hash.
 */
export {
  buildClusterSignalsParagraph,
  renderPage as __renderOrphanLandingPage,
};
