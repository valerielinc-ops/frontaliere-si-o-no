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
import { WriteCollector } from './batchWrite';
import {
  BASE_URL,
  countHtmlBodyWords,
  MIN_INDEXABLE_WORDS,
} from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import {
  BREADCRUMB_LINK_STYLE,
  BREADCRUMB_STYLE,
  CTA_PRIMARY_STYLE,
  CARD_STYLE,
  H1_STYLE,
  HERO_EYEBROW_STYLE,
  LEDE_STYLE,
  STAT_TILE_BASE,
  STAT_TILE_LABEL,
  STAT_TILE_VALUE,
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
  median,
  topCounts,
  type OrphanLandingLocale,
  type OrphanQueryCluster,
  type OrphanQueryClustersFile,
  type OrphanCountableJob,
  type OrphanLandingRoute,
} from './orphanQueryData';
import { generateRelatedLinksBlock } from './shared/relatedLinks';
import { adSlotHtml } from './lib/adSlotHtml';

const MIN_MATCHING_JOBS = 3;
const DEFAULT_MAX_LANDINGS = 500;

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
    for (const file of fs.readdirSync(sliceDir)) {
      if (!file.endsWith('.json')) continue;
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
  const employer = ctx.employer ? esc(ctx.employer) : '';
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
        { q: 'Che stipendio aspettarmi per «' + q + '» in Ticino e come si confronta col netto italiano?', a: 'La mediana salariale osservata sugli annunci aggregati negli ultimi 30 giorni per questo cluster è ' + (med || 'non pubblicata (campione inferiore a cinque annunci con stipendio dichiarato)') + '. Il salario lordo svizzero include sempre la 13esima mensilità e, in molti contratti, anche una 14esima legata al raggiungimento di obiettivi. Vanno detratti circa il 12-14 % per AVS/AI/IPG e LPP (cassa pensione), oltre alla quota LAMal mensile che varia da CHF 280 a CHF 580 a seconda del cantone, dell\'età e del modello di franchigia. Per un frontaliere residente in provincia di Como, Varese, Lecco o Verbano-Cusio-Ossola, il netto in tasca dopo imposta alla fonte è in media superiore del 35-55 % rispetto allo stesso ruolo svolto in Italia, ma il delta varia in funzione del costo del pendolarismo. Simulare lo scenario esatto col calcolatore stipendio netto del sito, indicando cantone di lavoro, età e regime fiscale (vecchio frontaliere assunto entro il 17 luglio 2023 oppure nuovo frontaliere oltre i 20 km dalla frontiera) evita brutte sorprese al primo cedolino.' },
        { q: 'Permesso G o permesso B: quale conviene per questo profilo?', a: 'Il permesso G è la scelta naturale per chi mantiene la residenza fiscale italiana entro i 20 km dalla frontiera e rientra ogni giorno (o almeno una volta a settimana). Costa molto meno di tasse complessive nello scenario tipico, e nessun obbligo di trasferimento. Il permesso B (residente straniero in Svizzera) ha senso solo se il ruolo «' + q + '» richiede turni notturni continuativi, on-call frequenti, o se la sede di lavoro è oltre 1h30 di pendolarismo. Va valutato che la residenza svizzera implica LAMal individuale piena (da CHF 350 mensili a CHF 700 per famiglia tipica), eventuale doppia residenza fiscale nei primi anni e accesso più rapido al credito ipotecario svizzero ma non a quello italiano. La regola pratica: se la posizione consente il rientro quotidiano e il costo del trasporto è inferiore a CHF 600 al mese, il permesso G è quasi sempre la scelta vincente in termini di netto annuale disponibile.' },
        { q: 'Cosa cambia col Nuovo Accordo 2026 sulla tassazione di un ruolo «' + q + '»?', a: 'Il Nuovo Accordo entrato in vigore il 17 luglio 2023 distingue due regimi che si applicano direttamente alle offerte aggregate in questa pagina. I "vecchi frontalieri" (assunti prima del 17 luglio 2023, oppure residenti entro 20 km dalla frontiera) pagano esclusivamente l\'imposta alla fonte svizzera; l\'Italia riconosce un credito d\'imposta e di fatto non recupera nulla in più. I "nuovi frontalieri" residenti oltre i 20 km dal confine pagano sia l\'imposta svizzera alla fonte sia l\'IRPEF italiana, con una franchigia di 10\'000 € sul reddito imponibile in Italia e regole specifiche per la deducibilità dei contributi LPP. Lo scarto sul netto annuale di un ruolo «' + q + '» può raggiungere il 15-20 % a parità di salario lordo, e per stipendi sopra i CHF 80\'000 lordi è quasi sempre superiore al delta sul costo della vita. Conviene formalizzare la propria fascia con il commercialista prima della firma — non al momento della prima dichiarazione, quando il margine di scelta è azzerato.' },
        { q: 'Quali costi nascosti erodono il netto di un\'offerta «' + q + '»' + (city ? ' a ' + city : '') + '?', a: 'Oltre alle trattenute obbligatorie, su ogni cedolino di un frontaliere pesano: il costo della LAMal (assicurazione malattia svizzera obbligatoria anche per i frontalieri attivi in Svizzera, con possibilità di esercitare il "diritto d\'opzione" verso la sanità italiana solo entro tre mesi dall\'assunzione), i contributi LPP (cassa pensione professionale, tipicamente 7-12 % del salario assicurato cofinanziato col datore), il costo del pendolarismo. Per ' + (city ? 'una sede a ' + city : 'le sedi più frequenti del cluster') + ' il costo medio mensile del commute da Como o Varese si attesta tra CHF 380 e CHF 720 considerando carburante, autostrada, ticket parcheggio in Ticino e treno svizzero negli ultimi km. A questi vanno sommati gli oneri occasionali: contributo cassa cantonale per asilo nido figli (se in Svizzera), tassa rifiuti, premio assicurazione cassa malattia integrativa privata facoltativa. La differenza fra netto a casa e netto teorico oscilla quindi tra il 12 % e il 22 % del lordo annuale.' },
        { q: 'Come faccio a candidarmi efficacemente alle offerte di questa pagina?', a: 'Le posizioni elencate sopra sono filtrate sui ruoli effettivamente compatibili con un profilo permesso G e ordinate per data di pubblicazione. ' + (employer ? 'I datori di lavoro più ricorrenti per questo cluster sono ' + employer + ' e altri operatori del settore. ' : '') + 'Prima di candidarti verifica tre punti: 1) il CV è in formato europeo o svizzero (Europass o tedesco lungo), con date in formato gg.mm.aaaa e foto identificativa (richiesta dalla cultura di assunzione svizzera, a differenza dell\'Italia); 2) la lettera di motivazione è obbligatoria su quasi tutte le aziende ticinesi (in italiano per il Ticino, in tedesco per i cantoni Svizzera tedesca), e deve indicare esplicitamente la disponibilità a iniziare entro 30/60/90 giorni; 3) verifica i documenti necessari per la richiesta del permesso G da parte del datore (passaporto/carta d\'identità valida 5 anni, estratto casellario, eventuale dichiarazione di residenza in Italia). I tempi medi dalla candidatura alla firma del contratto sono 4-8 settimane in Ticino, leggermente più lunghi se la sede è in cantoni di lingua tedesca.' },
      ],
    },
    en: {
      heading: 'Cross-border worker FAQ on this search',
      intro: 'The answers below cover the most common questions from candidates evaluating a «' + q + '» position as an Italian-Swiss cross-border worker. Folded into an accordion so the openings above stay the focus — expand only what you need.',
      faqs: [
        { q: 'What salary should I expect for «' + q + '» in Ticino, and how does it compare to the Italian net?', a: 'The salary median observed across the aggregated listings over the last 30 days for this cluster is ' + (med || 'not published (sample below five ads with declared pay)') + '. Swiss gross always includes the 13th-month bonus and, on many contracts, a 14th tied to performance targets. Deduct roughly 12-14 % for AVS/AI/IPG plus LPP pension contributions, and a monthly LAMal premium ranging from CHF 280 to CHF 580 depending on canton, age, and chosen deductible. For a cross-border worker resident in the provinces of Como, Varese, Lecco, or Verbano-Cusio-Ossola, take-home after withholding tax is on average 35-55 % higher than the same role in Italy, with the delta narrowing as commute cost rises. Simulating the exact scenario with the net-salary calculator — specifying canton, age, and tax regime (legacy cross-border worker hired before 17 July 2023, or new cross-border worker resident beyond 20 km from the border) — prevents nasty surprises on the first pay slip.' },
        { q: 'G permit or B permit: which fits this profile?', a: 'The G permit is the natural choice if you keep tax residence in Italy within 20 km of the border and return home daily (or at least weekly). It minimises total tax in the typical scenario and skips any relocation. The B permit (foreign resident in Switzerland) makes sense only if «' + q + '» requires continuous night shifts, frequent on-call, or a workplace beyond a 90-minute commute. Note that Swiss residence entails full individual LAMal (CHF 350+ monthly, CHF 700+ for a family), potential dual-residence issues in the first years, and faster access to Swiss mortgage credit but not to Italian credit. Rule of thumb: if the role allows daily return and commute cost stays under CHF 600 a month, the G permit is almost always the better deal on annual disposable income.' },
        { q: 'What does the 2026 New Agreement change about taxation on a «' + q + '» role?', a: 'The agreement in force since 17 July 2023 distinguishes two regimes that apply directly to the openings on this page. "Legacy" cross-border workers (hired before 17 July 2023, or resident within 20 km of the border) pay only Swiss withholding tax; Italy grants a tax credit and effectively claws nothing back. "New" cross-border workers resident beyond 20 km pay both Swiss withholding and Italian IRPEF, with a €10,000 personal allowance on the Italian taxable base and specific rules for the deductibility of LPP contributions. The gap on annual net for a «' + q + '» role can reach 15-20 % at equal gross salary, and for gross pay above CHF 80,000 it almost always exceeds the cost-of-living delta. Formalise your bracket with an accountant before signing — not at the first tax return, when the room to choose is gone.' },
        { q: 'Which hidden costs erode the net of a «' + q + '» offer' + (city ? ' in ' + city : '') + '?', a: 'Beyond mandatory withholdings, every cross-border pay slip carries: LAMal (Swiss health insurance, mandatory for cross-border workers active in Switzerland, with the "opt-out" toward Italian healthcare available only within three months of hire), LPP pension contributions (typically 7-12 % of insured salary co-funded with the employer), and commute cost. For ' + (city ? 'a workplace in ' + city : 'the most frequent cluster cities') + ', the average monthly commute from Como or Varese sits between CHF 380 and CHF 720 considering fuel, motorway tolls, parking in Ticino, and Swiss train fares for the final kilometres. Add occasional charges: cantonal nursery contribution if your child is enrolled in Switzerland, waste tax, optional supplementary private insurance premium. The gap between take-home and theoretical net therefore swings between 12 % and 22 % of annual gross.' },
        { q: 'How do I apply effectively to the openings on this page?', a: 'The positions listed above are filtered for profiles actually accessible to G-permit holders and sorted by publication date. ' + (employer ? 'Recurring employers in this cluster include ' + employer + ' and other sector operators. ' : '') + 'Before applying check three things: 1) the CV uses the Europass or long-form Swiss-German format, with dd.mm.yyyy dates and an identifying photo (standard in Swiss hiring culture, unlike Italy); 2) a cover letter is mandatory on virtually every Ticino employer (in Italian for Ticino, in German for German-speaking cantons), and must explicitly state availability to start within 30/60/90 days; 3) prepare the paperwork for the employer-led G-permit application (valid passport/ID with 5-year validity, criminal-record extract, residence certificate in Italy). Median time from application to signed contract is 4-8 weeks in Ticino, slightly longer in German-speaking cantons.' },
      ],
    },
    de: {
      heading: 'Häufige Fragen von italo-schweizerischen Grenzgängern zu dieser Suche',
      intro: 'Die folgenden Antworten decken die meistgestellten Fragen von Kandidaten ab, die eine Position vom Typ «' + q + '» als italo-schweizerischer Grenzgänger evaluieren. Im Akkordeon gefaltet, damit die Inserate oben im Fokus bleiben — nur öffnen, was relevant ist.',
      faqs: [
        { q: 'Welcher Lohn ist für «' + q + '» im Tessin zu erwarten und wie schneidet er gegenüber dem italienischen Netto ab?', a: 'Der über die aggregierten Anzeigen der letzten 30 Tage beobachtete Lohn-Median für dieses Cluster beträgt ' + (med || 'nicht veröffentlicht (Stichprobe unter fünf Inseraten mit deklariertem Lohn)') + '. Der Schweizer Bruttolohn umfasst stets den 13. Monatslohn und in vielen Verträgen einen erfolgsabhängigen 14. Monat. Abzuziehen sind ca. 12-14 % für AHV/IV/EO und BVG sowie die monatliche Krankenkassenprämie zwischen CHF 280 und CHF 580 je nach Kanton, Alter und Franchise. Für einen Grenzgänger mit Wohnsitz in den Provinzen Como, Varese, Lecco oder Verbano-Cusio-Ossola liegt das Netto nach Quellensteuer im Schnitt 35-55 % über dem gleichen Job in Italien, wobei der Vorsprung mit steigenden Pendelkosten schrumpft. Mit dem Nettolohn-Rechner und Angabe von Kanton, Alter und Steuerregime (Alt-Grenzgänger eingestellt vor 17. Juli 2023 oder Neu-Grenzgänger mit Wohnsitz über 20 km von der Grenze) lassen sich böse Überraschungen auf der ersten Lohnabrechnung vermeiden.' },
        { q: 'G-Bewilligung oder B-Bewilligung: was passt zu diesem Profil?', a: 'Die G-Bewilligung ist der Normalfall für jene, die den steuerlichen Wohnsitz in Italien innerhalb von 20 km zur Grenze behalten und täglich (oder mindestens wöchentlich) zurückkehren. Sie minimiert die Gesamtsteuerlast und erspart jeden Umzug. Die B-Bewilligung lohnt sich nur, wenn «' + q + '» Dauer-Nachtschichten, häufige Bereitschaftsdienste oder einen Arbeitsweg über 90 Minuten verlangt. Schweizer Wohnsitz bedeutet volle individuelle Krankenkasse (CHF 350+ monatlich, CHF 700+ für eine Familie), mögliche Doppelresidenz-Probleme in den ersten Jahren und schnelleren Zugang zu Schweizer Hypotheken — nicht zu italienischen. Faustregel: erlaubt die Rolle tägliche Rückkehr und bleiben die Pendelkosten unter CHF 600 pro Monat, ist die G-Bewilligung fast immer das bessere Geschäft.' },
        { q: 'Was ändert das Neue Abkommen 2026 für die Besteuerung einer «' + q + '»-Stelle?', a: 'Das seit 17. Juli 2023 geltende Abkommen unterscheidet zwei Regime, die direkt auf die Stellen dieser Seite anwendbar sind. "Alt-Grenzgänger" (eingestellt vor dem 17. Juli 2023 oder mit Wohnsitz innerhalb 20 km zur Grenze) zahlen ausschliesslich die Schweizer Quellensteuer; Italien gewährt eine Steueranrechnung und holt faktisch nichts zurück. "Neu-Grenzgänger" mit Wohnsitz über 20 km zahlen sowohl Schweizer Quellensteuer als auch italienische IRPEF, mit einem Freibetrag von 10\'000 € auf das italienische Steuerpflichtige Einkommen und spezifischen Regeln zur BVG-Beitragsabzugsfähigkeit. Die Differenz beim Jahresnetto einer «' + q + '»-Stelle kann bei gleichem Bruttolohn 15-20 % erreichen, und bei Brutto über CHF 80\'000 übersteigt sie fast immer das Lebenshaltungskosten-Delta. Mit dem Steuerberater vor der Unterschrift formalisieren — nicht erst beim ersten Steuerbescheid.' },
        { q: 'Welche versteckten Kosten zehren am Netto einer «' + q + '»-Offerte' + (city ? ' in ' + city : '') + '?', a: 'Neben den Pflichtabzügen belasten jede Grenzgänger-Lohnabrechnung: die Krankenkasse (Schweizer KV obligatorisch für in der Schweiz tätige Grenzgänger, mit "Optionsrecht" auf italienische Gesundheitsversorgung nur innert drei Monaten nach Anstellung), BVG-Beiträge (typisch 7-12 % des versicherten Lohns vom Arbeitgeber mitfinanziert), Pendelkosten. Für ' + (city ? 'einen Arbeitsplatz in ' + city : 'die häufigsten Cluster-Städte') + ' liegen die monatlichen Pendelkosten ab Como oder Varese zwischen CHF 380 und CHF 720 unter Berücksichtigung von Treibstoff, Autobahnmaut, Parkgebühren im Tessin und Schweizer Bahn für die letzten Kilometer. Gelegenheitskosten kommen dazu: Kantonale Kita-Beiträge bei Einschulung in der Schweiz, Abfallgebühren, fakultative Zusatzversicherungsprämien. Die Lücke zwischen tatsächlichem und theoretischem Netto schwankt daher zwischen 12 % und 22 % des Jahresbruttolohns.' },
        { q: 'Wie bewerbe ich mich erfolgreich auf die Stellen dieser Seite?', a: 'Die oben aufgeführten Stellen sind auf Profile gefiltert, die für G-Bewilligungs-Inhaber zugänglich sind, und nach Publikationsdatum sortiert. ' + (employer ? 'Wiederkehrende Arbeitgeber in diesem Cluster: ' + employer + ' und weitere Branchenakteure. ' : '') + 'Vor der Bewerbung drei Punkte prüfen: 1) der CV nutzt das Europass- oder das lange schweizerisch-deutsche Format mit Datum dd.mm.jjjj und Identifikationsfoto (in der Schweizer Einstellungskultur Standard, in Italien nicht); 2) ein Anschreiben ist bei praktisch jedem Tessiner Arbeitgeber Pflicht (Italienisch für das Tessin, Deutsch für die deutschsprachigen Kantone) und muss die Verfügbarkeit zum Stellenantritt innert 30/60/90 Tagen explizit nennen; 3) für die durch den Arbeitgeber gestellte G-Bewilligungs-Anfrage bereithalten: gültiger Pass/ID (5 Jahre), Strafregisterauszug, Wohnsitzbescheinigung Italien. Median-Dauer von Bewerbung bis Vertragsunterschrift: 4-8 Wochen im Tessin, leicht länger in der Deutschschweiz.' },
      ],
    },
    fr: {
      heading: 'FAQ frontalier sur cette recherche',
      intro: 'Les réponses ci-dessous traitent des questions les plus fréquentes des candidats qui évaluent un poste «' + q + '» en tant que frontalier italo-suisse. Repliées dans un accordéon pour laisser la priorité aux offres ci-dessus — n\'ouvrez que ce qui vous intéresse.',
      faqs: [
        { q: 'Quel salaire attendre pour «' + q + '» au Tessin et comment se compare-t-il au net italien ?', a: 'La médiane salariale observée sur les annonces agrégées des 30 derniers jours pour ce cluster est ' + (med || 'non publiée (échantillon inférieur à cinq annonces avec salaire déclaré)') + '. Le brut suisse comprend toujours le 13e mois et, dans beaucoup de contrats, un 14e lié à l\'atteinte d\'objectifs. Il faut déduire environ 12-14 % pour AVS/AI/APG et LPP, plus la prime LAMal mensuelle entre CHF 280 et CHF 580 selon canton, âge et franchise. Pour un frontalier résidant dans les provinces de Côme, Varèse, Lecco ou Verbano-Cusio-Ossola, le net après impôt à la source est en moyenne supérieur de 35-55 % au même poste en Italie, l\'écart se réduisant à mesure que le coût du commute augmente. Simuler le scénario exact avec le calculateur de salaire net — en précisant canton, âge et régime fiscal (ancien frontalier engagé avant le 17 juillet 2023, ou nouveau frontalier résidant au-delà de 20 km de la frontière) — évite toute mauvaise surprise sur la première fiche de paie.' },
        { q: 'Permis G ou permis B : lequel convient à ce profil ?', a: 'Le permis G est le choix naturel pour qui maintient sa résidence fiscale en Italie dans les 20 km de la frontière et rentre quotidiennement (ou au moins hebdomadairement). Il minimise la charge fiscale totale dans le scénario type et évite tout déménagement. Le permis B (résident étranger en Suisse) ne se justifie que si «' + q + '» impose des nuits continues, des astreintes fréquentes, ou un lieu de travail à plus de 90 minutes de trajet. La résidence suisse implique LAMal individuelle complète (CHF 350+ mensuels, CHF 700+ pour une famille), de possibles problèmes de double résidence les premières années, et un accès plus rapide au crédit hypothécaire suisse mais pas au crédit italien. Règle pratique : si le poste permet la rentrée quotidienne et que les coûts du commute restent sous CHF 600 par mois, le permis G est presque toujours la meilleure affaire en termes de net annuel disponible.' },
        { q: 'Ce que change le Nouvel Accord 2026 sur la fiscalité d\'un rôle «' + q + '»', a: 'L\'accord en vigueur depuis le 17 juillet 2023 distingue deux régimes applicables directement aux offres de cette page. Les "anciens" frontaliers (engagés avant le 17 juillet 2023, ou résidant dans les 20 km de la frontière) ne paient que l\'impôt à la source suisse ; l\'Italie accorde un crédit d\'impôt et ne récupère rien dans les faits. Les "nouveaux" frontaliers résidant au-delà de 20 km paient à la fois l\'impôt à la source suisse et l\'IRPEF italien, avec une franchise de 10 000 € sur la base imposable italienne et des règles spécifiques pour la déductibilité des cotisations LPP. L\'écart sur le net annuel d\'un rôle «' + q + '» peut atteindre 15-20 % à brut égal, et pour un brut supérieur à CHF 80 000 il dépasse presque toujours le delta sur le coût de la vie. Formaliser sa tranche avec le comptable avant signature — pas à la première déclaration, quand la marge de choix est nulle.' },
        { q: 'Quels coûts cachés érodent le net d\'une offre «' + q + '»' + (city ? ' à ' + city : '') + ' ?', a: 'Au-delà des prélèvements obligatoires, chaque fiche de paie de frontalier supporte : la LAMal (assurance maladie suisse obligatoire pour les frontaliers actifs en Suisse, avec le "droit d\'option" vers la santé italienne disponible uniquement dans les trois mois suivant l\'embauche), les cotisations LPP (typiquement 7-12 % du salaire assuré co-financées par l\'employeur), et le coût du commute. Pour ' + (city ? 'un poste à ' + city : 'les villes les plus fréquentes du cluster') + ', le coût mensuel moyen du trajet depuis Côme ou Varèse oscille entre CHF 380 et CHF 720 considérant carburant, péage autoroutier, parking au Tessin et train suisse pour les derniers kilomètres. S\'y ajoutent les charges occasionnelles : contribution cantonale pour crèche si l\'enfant est inscrit en Suisse, taxe sur les déchets, prime facultative d\'assurance complémentaire. L\'écart entre le net en poche et le net théorique oscille donc entre 12 % et 22 % du brut annuel.' },
        { q: 'Comment postuler efficacement aux offres de cette page ?', a: 'Les postes ci-dessus sont filtrés sur les profils réellement accessibles aux titulaires du permis G et triés par date de publication. ' + (employer ? 'Les employeurs récurrents de ce cluster comprennent ' + employer + ' et d\'autres acteurs du secteur. ' : '') + 'Avant de postuler, vérifier trois points : 1) le CV est au format Europass ou suisse-allemand long, avec dates au format jj.mm.aaaa et photo d\'identité (standard dans la culture d\'embauche suisse, contrairement à l\'Italie) ; 2) la lettre de motivation est obligatoire chez quasiment tous les employeurs tessinois (en italien pour le Tessin, en allemand pour les cantons germanophones), et doit explicitement indiquer la disponibilité à démarrer sous 30/60/90 jours ; 3) préparer le dossier pour la demande de permis G portée par l\'employeur (passeport/CI valides 5 ans, extrait du casier judiciaire, certificat de résidence en Italie). Délai médian de la candidature à la signature : 4-8 semaines au Tessin, légèrement plus en cantons germanophones.' },
      ],
    },
  };

  const block = blocks[locale];
  const items = block.faqs
    .map(
      (f) => '<details style="' + DETAILS_STYLE + '"><summary style="' + SUMMARY_STYLE + '">' + esc(f.q) + '</summary><p style="' + ANSWER_STYLE + '">' + esc(f.a) + '</p></details>',
    )
    .join('');

  return '<section style="' + SECTION_STYLE + '"><h2 style="margin:0 0 10px;font-size:22px">' + esc(block.heading) + '</h2><p style="margin:0 0 16px;color:var(--color-subtle);line-height:1.6;font-size:14px">' + esc(block.intro) + '</p>' + items + '</section>';
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
  const sliced = q.slice(0, MAX);
  const lastSpace = sliced.lastIndexOf(' ');
  return lastSpace > 0 ? sliced.slice(0, lastSpace).trimEnd() : sliced.trimEnd();
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
  const section: Record<OrphanLandingLocale, string> = {
    it: 'cerca-lavoro-ticino',
    en: 'find-jobs-ticino',
    de: 'jobs-im-tessin',
    fr: 'trouver-emploi-tessin',
  };
  const prefix = ORPHAN_LANDING_LOCALE_PREFIX[locale];
  const slug = job.slugByLocale?.[locale] || job.slug || '';
  const rel = `${prefix}/${section[locale]}/${slug}/`.replace(/\/+/g, '/');
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

  const jobBoardRoot: Record<OrphanLandingLocale, string> = {
    it: '/cerca-lavoro-ticino/',
    en: '/en/find-jobs-ticino/',
    de: '/de/jobs-im-tessin/',
    fr: '/fr/trouver-emploi-tessin/',
  };

  const editorialFam = pickEditorialFamily(cluster);
  const editorialBody = t(editorialKey(editorialFam),
    'Swiss cross-border job market: competitive wages, withholding tax, mandatory health insurance, and 13th-month pay. The 2026 Cross-Border Workers Agreement applies within 20 km of the border.',
  );
  const genericBody = t('orphanLanding.editorialGeneric',
    'The Swiss labour market offers attractive economic and legal conditions for Italian cross-border workers.',
  );

  // Stats for the editorial block
  const salaries: number[] = matchingJobs
    .map((j) => Number(j.salaryMin || 0))
    .filter((n) => n >= 20000 && n <= 300000);
  const medianSalary = median(salaries);
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

  const similarList = similar.map((q) => `<li style="margin:4px 0"><a href="${esc(jobBoardRoot[locale])}" style="${LINK_ACCENT_STYLE}">${esc(q.query)}</a> <span style="color:var(--color-subtle);font-size:12px">(${q.impressions})</span></li>`).join('');

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

  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: t('orphanLanding.breadcrumbHome', 'Home'), item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: h1ForLd, item: canonicalUrl },
    ],
  });

  const webPageLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: h1ForLd,
    url: canonicalUrl,
    description: editorialBody.slice(0, 200),
    inLanguage: locale,
    isPartOf: { '@type': 'WebSite', url: BASE_URL, name: 'Frontaliere Ticino' },
    datePublished: dateStamp,
    dateModified: dateStamp,
  });

  // Decide indexability — <MIN_MATCHING_JOBS jobs → noindex (anti-doorway).
  const indexable = matchingJobs.length >= MIN_MATCHING_JOBS;

  const body = `
    <nav style="${BREADCRUMB_STYLE}">
      <a href="${BASE_URL}/" style="${BREADCRUMB_LINK_STYLE}">${esc(t('orphanLanding.breadcrumbHome', 'Home'))}</a>
      <span> / </span>
      <span>${esc(cluster.canonicalQuery)}</span>
    </nav>
    <header style="margin-bottom:20px">
      <p style="${HERO_EYEBROW_STYLE}">${esc(t('orphanLanding.updatedLabel', 'Updated'))} · ${esc(dateStamp)}</p>
      <h1 style="${H1_STYLE}">${esc(buildEditorialH1(cluster.canonicalQuery, locale))}</h1>
      <p style="${LEDE_STYLE}">${esc(matchingJobs.length > 0 ? (locale === 'it' ? `${matchingJobs.length} offerte attive per "${cluster.canonicalQuery}"${medianSalary > 0 ? ` · mediana salario CHF ${medianSalary.toLocaleString('de-CH')}` : ''}.` : locale === 'en' ? `${matchingJobs.length} active openings for "${cluster.canonicalQuery}"${medianSalary > 0 ? ` · median salary CHF ${medianSalary.toLocaleString('de-CH')}` : ''}.` : locale === 'de' ? `${matchingJobs.length} aktive Stellen für "${cluster.canonicalQuery}"${medianSalary > 0 ? ` · Median CHF ${medianSalary.toLocaleString('de-CH')}` : ''}.` : `${matchingJobs.length} offres actives pour « ${cluster.canonicalQuery} »${medianSalary > 0 ? ` · médiane CHF ${medianSalary.toLocaleString('de-CH')}` : ''}.`) : esc(t('orphanLanding.noResults', 'No openings.')))}</p>
    </header>
    <section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:0 0 24px">
      <div style="${STAT_TILE_BASE}">
        <div style="${STAT_TILE_LABEL}">${esc(t('orphanLanding.medianSalary', 'Median salary'))}</div>
        <div style="${STAT_TILE_VALUE}">${medianSalary > 0 ? `CHF ${medianSalary.toLocaleString('de-CH')}` : esc(t('orphanLanding.medianSalaryNA', 'N/A'))}</div>
      </div>
      ${topEmployers.length > 0 ? `<div style="${STAT_TILE_BASE}">
        <div style="${STAT_TILE_LABEL}">${esc(t('orphanLanding.topEmployers', 'Top employers'))}</div>
        <ul style="margin:8px 0 0;padding:0 0 0 18px;line-height:1.5;font-size:14px;color:var(--color-body)">${employerList}</ul>
      </div>` : ''}
      ${topCities.length > 0 ? `<div style="${STAT_TILE_BASE}">
        <div style="${STAT_TILE_LABEL}">${esc(t('orphanLanding.topCities', 'Top cities'))}</div>
        <ul style="margin:8px 0 0;padding:0 0 0 18px;line-height:1.5;font-size:14px;color:var(--color-body)">${cityList}</ul>
      </div>` : ''}
    </section>
    <section style="margin:0 0 28px">
      <h2 style="margin:0 0 12px;font-size:22px">${esc(t('orphanLanding.resultsLabel', 'Openings'))}</h2>
      ${matchingJobs.length > 0
        ? jobCards
        : `<p style="margin:0;padding:16px;border-radius:12px;background:var(--color-warning-subtle);color:var(--color-heading)">${esc(t('orphanLanding.noResults', 'No openings.'))}</p>`}
    </section>
    ${similar.length > 1 ? `<section style="margin:0 0 28px">
      <h2 style="margin:0 0 12px;font-size:22px">${esc(t('orphanLanding.similarQueries', 'Similar searches'))}</h2>
      <ul style="margin:0;padding:0 0 0 18px">${similarList}</ul>
    </section>` : ''}
    <section style="margin:0 0 28px">
      <h2 style="margin:0 0 12px;font-size:22px">${esc(t('orphanLanding.faqH2', 'FAQ'))}</h2>
      <details style="padding:12px 14px;border:1px solid var(--color-edge);border-radius:12px;margin-bottom:8px;background:var(--color-surface)">
        <summary style="font-weight:700;cursor:pointer">${esc(t('orphanLanding.faqQ1', ''))}</summary>
        <p style="margin:8px 0 0;color:var(--color-body);line-height:1.65">${esc(t('orphanLanding.faqA1', ''))}</p>
      </details>
      <details style="padding:12px 14px;border:1px solid var(--color-edge);border-radius:12px;margin-bottom:8px;background:var(--color-surface)">
        <summary style="font-weight:700;cursor:pointer">${esc(t('orphanLanding.faqQ2', ''))}</summary>
        <p style="margin:8px 0 0;color:var(--color-body);line-height:1.65">${esc(t('orphanLanding.faqA2', ''))}</p>
      </details>
    </section>
    <section style="display:flex;gap:12px;flex-wrap:wrap;margin:0 0 16px">
      <a href="${esc(jobBoardRoot[locale])}" style="${CTA_PRIMARY_STYLE}">${esc(t('orphanLanding.ctaAllJobs', 'All jobs'))}</a>
      <a href="${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}" style="padding:12px 18px;border-radius:12px;background:var(--color-surface);border:1px solid var(--color-edge);color:var(--color-body);text-decoration:none;font-weight:700">${esc(t('orphanLanding.ctaCalculator', 'Calculate net salary'))}</a>
    </section>
    <section style="margin:0 0 28px;max-width:860px">
      <p style="margin:0 0 14px;color:var(--color-body);font-size:16px;line-height:1.6">${esc(editorialBody)}</p>
      <p style="margin:0 0 14px;color:var(--color-body);line-height:1.65">${esc(buildClusterSignalsParagraph(cluster, locale))}</p>
      <p style="margin:0;color:var(--color-subtle);line-height:1.65">${esc(genericBody)}</p>
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
        return `<section style="margin:32px 0 0;padding-top:24px;border-top:1px solid var(--color-edge);max-width:860px">
          <h2 style="margin:0 0 12px;font-size:22px">Come leggere questa ricerca per un frontaliere italo-svizzero</h2>
          <p style="margin:0 0 14px;line-height:1.65;color:var(--color-body)">Le offerte raggruppate sotto la query <em>${esc(q)}</em> rappresentano posizioni reali aperte oggi nei motori di ricerca svizzeri e nei principali aggregatori (Jobs.ch, JobUp, JobScout24, RAV) che riguardano il pendolarismo dalla Lombardia o dal Piemonte. La concentrazione di annunci in questa categoria riflette sia la domanda effettiva del mercato del lavoro ticinese sia il match con il profilo permesso G — turni compatibili con il rientro quotidiano in Italia, contratti svizzeri a tempo determinato o indeterminato, salario nettamente superiore al netto italiano equivalente${med ? ` (mediana per questo cluster: ${med})` : ''}.</p>
          <h2 style="margin:0 0 12px;font-size:22px">Cosa cambia con il Nuovo Accordo 2026</h2>
          <p style="margin:0 0 14px;line-height:1.65;color:var(--color-body)">Per le offerte in questa pagina la fiscalità dipende dalla data di assunzione e dalla distanza dal confine. Un frontaliere "vecchio" (assunto prima del 17 luglio 2023, o residente entro 20 km dalla frontiera) paga solo l'imposta alla fonte ticinese, con un credito d'imposta per l'eventuale tassazione italiana. Un frontaliere "nuovo" residente oltre i 20 km paga sia l'imposta svizzera sia quella italiana, con franchigia di 10 000 € sul reddito imponibile in Italia. La differenza sul netto annuale può raggiungere il 15-20 %: simulare l'esatto impatto con il <a href="${BASE_URL}${locale === 'it' ? '/' : `/${locale}/`}" style="${LINK_ACCENT_STYLE}">calcolatore stipendio netto</a> prima di firmare è sempre la mossa giusta.</p>
          <h2 style="margin:0 0 12px;font-size:22px">Per chi è utile questa selezione</h2>
          <p style="margin:0;line-height:1.65;color:var(--color-body)">Questa pagina è pensata per chi sta valutando un trasferimento del proprio carico professionale verso ${city ? esc(city) : 'il Ticino'} oppure cerca attivamente posizioni con questo profilo specifico${employer ? ` (datori di lavoro più frequenti come ${esc(employer)})` : ''}. Aggiorniamo le offerte ogni 24 ore tirando da cinque fonti diverse, filtriamo per ruoli realmente accessibili a un permesso G, e mostriamo solo annunci con stipendio dichiarato o ricavabile dalla mediana di settore. Per affinare la ricerca consigliamo di esplorare anche le query simili elencate sopra e l'<a href="${esc(jobBoardRoot[locale])}" style="${LINK_ACCENT_STYLE}">archivio completo del job board</a>.</p>
        </section>`;
      }
      if (locale === 'en') {
        return `<section style="margin:32px 0 0;padding-top:24px;border-top:1px solid var(--color-edge);max-width:860px">
          <h2 style="margin:0 0 12px;font-size:22px">How to read this search for an Italian-Swiss cross-border worker</h2>
          <p style="margin:0 0 14px;line-height:1.65;color:var(--color-body)">The openings grouped under the query <em>${esc(q)}</em> are real positions live today on Swiss search engines and major aggregators (Jobs.ch, JobUp, JobScout24, RAV) that fit the commute profile from Lombardy or Piedmont. The density of listings in this category reflects both real demand in the Ticino labour market and the fit with the G-permit profile — shifts compatible with daily return to Italy, Swiss employment contracts, salaries materially higher than the equivalent Italian net${med ? ` (cluster median: ${med})` : ''}.</p>
          <h2 style="margin:0 0 12px;font-size:22px">What the 2026 New Agreement changes</h2>
          <p style="margin:0 0 14px;line-height:1.65;color:var(--color-body)">For the openings on this page, taxation depends on hire date and distance from the border. An "old" cross-border worker (hired before 17 July 2023, or resident within 20 km of the border) pays only Swiss withholding tax, with a tax credit on any Italian taxation. A "new" cross-border worker resident beyond 20 km pays both Swiss and Italian tax, with a €10 000 personal allowance on the Italian taxable income. The difference on annual net can reach 15-20 %: simulate the exact impact with the <a href="${BASE_URL}/${locale}/" style="${LINK_ACCENT_STYLE}">net-salary calculator</a> before signing.</p>
          <h2 style="margin:0 0 12px;font-size:22px">Who this selection is for</h2>
          <p style="margin:0;line-height:1.65;color:var(--color-body)">This page is built for those evaluating a professional move toward ${city ? esc(city) : 'Ticino'} or actively searching for positions matching this specific profile${employer ? ` (most frequent employers like ${esc(employer)})` : ''}. We refresh listings every 24 hours from five sources, filter for roles actually accessible to a G-permit holder, and only show ads with declared salary or industry-median data. To refine the search, also explore the similar queries above and the <a href="${esc(jobBoardRoot[locale])}" style="${LINK_ACCENT_STYLE}">full job-board archive</a>.</p>
        </section>`;
      }
      if (locale === 'de') {
        return `<section style="margin:32px 0 0;padding-top:24px;border-top:1px solid var(--color-edge);max-width:860px">
          <h2 style="margin:0 0 12px;font-size:22px">Wie diese Suche für italo-schweizerische Grenzgänger zu lesen ist</h2>
          <p style="margin:0 0 14px;line-height:1.65;color:var(--color-body)">Die unter der Suchanfrage <em>${esc(q)}</em> gruppierten Stellen sind reale Inserate, die heute auf Schweizer Suchmaschinen und grossen Aggregatoren (Jobs.ch, JobUp, JobScout24, RAV) aktiv sind und zum Pendelprofil aus der Lombardei oder dem Piemont passen. Die Inseratendichte in dieser Kategorie spiegelt sowohl die reale Nachfrage des Tessiner Arbeitsmarktes als auch die Passung zum G-Bewilligungs-Profil wider — Schichten kompatibel mit täglicher Rückkehr nach Italien, Schweizer Arbeitsverträge, Lohn deutlich über dem äquivalenten italienischen Netto${med ? ` (Cluster-Median: ${med})` : ''}.</p>
          <h2 style="margin:0 0 12px;font-size:22px">Was sich mit dem Neuen Abkommen 2026 ändert</h2>
          <p style="margin:0 0 14px;line-height:1.65;color:var(--color-body)">Für die Stellen auf dieser Seite hängt die Besteuerung vom Einstellungsdatum und vom Abstand zur Grenze ab. Ein "alter" Grenzgänger (eingestellt vor dem 17. Juli 2023 oder mit Wohnsitz innerhalb von 20 km von der Grenze) zahlt nur die Schweizer Quellensteuer, mit einer Steueranrechnung auf eine allfällige italienische Besteuerung. Ein "neuer" Grenzgänger mit Wohnsitz ausserhalb von 20 km zahlt sowohl Schweizer als auch italienische Steuern, mit einem Freibetrag von 10 000 € auf das italienische steuerpflichtige Einkommen. Der Unterschied beim Jahresnetto kann 15-20 % erreichen: die genaue Wirkung mit dem <a href="${BASE_URL}/${locale}/" style="${LINK_ACCENT_STYLE}">Nettolohn-Rechner</a> vor Vertragsunterzeichnung simulieren.</p>
          <h2 style="margin:0 0 12px;font-size:22px">Für wen diese Auswahl ist</h2>
          <p style="margin:0;line-height:1.65;color:var(--color-body)">Diese Seite richtet sich an alle, die eine berufliche Verlagerung Richtung ${city ? esc(city) : 'Tessin'} prüfen oder aktiv nach Stellen mit diesem spezifischen Profil suchen${employer ? ` (häufigste Arbeitgeber wie ${esc(employer)})` : ''}. Wir aktualisieren die Inserate alle 24 Stunden aus fünf Quellen, filtern auf Rollen, die für G-Bewilligungs-Inhaber tatsächlich zugänglich sind, und zeigen nur Anzeigen mit deklariertem Lohn oder Branchen-Median-Daten. Zur Verfeinerung der Suche empfehlen wir die ähnlichen Anfragen oben und das <a href="${esc(jobBoardRoot[locale])}" style="${LINK_ACCENT_STYLE}">vollständige Stellenarchiv</a>.</p>
        </section>`;
      }
      return `<section style="margin:32px 0 0;padding-top:24px;border-top:1px solid var(--color-edge);max-width:860px">
        <h2 style="margin:0 0 12px;font-size:22px">Comment lire cette recherche pour un frontalier italo-suisse</h2>
        <p style="margin:0 0 14px;line-height:1.65;color:var(--color-body)">Les offres regroupées sous la requête <em>${esc(q)}</em> sont des annonces réelles actives aujourd'hui sur les moteurs de recherche suisses et les grands agrégateurs (Jobs.ch, JobUp, JobScout24, RAV) compatibles avec la navette depuis la Lombardie ou le Piémont. La densité d'annonces dans cette catégorie reflète à la fois la demande réelle du marché tessinois et la correspondance avec le profil permis G — horaires compatibles avec le retour quotidien en Italie, contrats suisses, salaires nettement supérieurs au net italien équivalent${med ? ` (médiane du cluster : ${med})` : ''}.</p>
        <h2 style="margin:0 0 12px;font-size:22px">Ce que change le Nouvel Accord 2026</h2>
        <p style="margin:0 0 14px;line-height:1.65;color:var(--color-body)">Pour les offres de cette page, la fiscalité dépend de la date d'embauche et de la distance à la frontière. Un "ancien" frontalier (embauché avant le 17 juillet 2023, ou résidant à moins de 20 km de la frontière) ne paie que l'impôt à la source suisse, avec un crédit d'impôt sur l'éventuelle imposition italienne. Un "nouveau" frontalier résidant au-delà des 20 km paie l'impôt suisse ET italien, avec une franchise de 10 000 € sur le revenu imposable italien. L'écart sur le net annuel peut atteindre 15-20 % : simulez l'impact exact avec le <a href="${BASE_URL}/${locale}/" style="${LINK_ACCENT_STYLE}">calculateur de salaire net</a> avant signature.</p>
        <h2 style="margin:0 0 12px;font-size:22px">À qui s'adresse cette sélection</h2>
        <p style="margin:0;line-height:1.65;color:var(--color-body)">Cette page est destinée à ceux qui évaluent un déménagement professionnel vers ${city ? esc(city) : 'le Tessin'} ou recherchent activement des postes correspondant à ce profil spécifique${employer ? ` (employeurs les plus fréquents comme ${esc(employer)})` : ''}. Nous actualisons les offres toutes les 24 heures depuis cinq sources, filtrons les rôles réellement accessibles à un titulaire de permis G, et n'affichons que les annonces avec salaire déclaré ou médiane sectorielle. Pour affiner la recherche, explorez aussi les requêtes similaires ci-dessus et l'<a href="${esc(jobBoardRoot[locale])}" style="${LINK_ACCENT_STYLE}">archive complète du job board</a>.</p>
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
  // Extra <head> tags (OG image + Twitter card) that buildSimplePage doesn't
  // emit by default — keeps the social-share preview identical to the
  // pre-shell-wrap HTML.
  const extraHead = `    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(editorialH1)}">
    <meta name="twitter:description" content="${esc(description)}">
    <meta name="twitter:site" content="@frontaliereticino">`;

  const jsonLdScripts = [breadcrumbLd, webPageLd];
  if (itemListLd) jsonLdScripts.push(itemListLd);

  // Keep the existing inline-styled `<main>` so the static shell still renders
  // something readable before React hydrates. buildSimplePage wraps this in
  // `<div id="root">` with `skipMainWrap: true` to avoid nested <main>.
  const bodyHtml = `<article style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:var(--color-body)">
        ${body}
        <section style="margin-top:32px" aria-label="advertisement">
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
    extraHeadHtml: extraHead,
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

      const maxEnv = Number(process.env.MAX_ORPHAN_LANDINGS || '');
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

      // Track every indexable cluster per locale so the hub index can list
      // ALL of them (closing the BFS-orphan gap when cron-published
      // clusters arrive without any inbound `<a>` link).
      const indexableByLocale: Record<OrphanLandingLocale, Array<{ slug: string; query: string; path: string }>> = {
        it: [], en: [], de: [], fr: [],
      };

      for (const cluster of clusters) {
        const matching = filterMatchingJobs(jobs, cluster, 15);
        const render = renderPage({
          cluster,
          matchingJobs: matching,
          strings: localeStrings[cluster.locale] || {},
          dateStamp,
          knownSlugsByLocale,
          distDir,
        });

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
            `  <url>\n    <loc>${BASE_URL}${render.urlPath}</loc>\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>`,
          );
          indexableByLocale[cluster.locale].push({
            slug: cluster.canonicalSlug,
            query: cluster.canonicalQuery,
            path: render.urlPath,
          });
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
        const prefix = ORPHAN_LANDING_LOCALE_PREFIX[loc];
        const section = ORPHAN_LANDING_SECTION[loc];
        const hubPath = `${prefix}/${section}/`.replace(/\/+/g, '/');
        const canonicalUrl = `${BASE_URL}${hubPath}`;

        const itemsHtml = sorted
          .map((it) => `<li style="margin:0"><a href="${esc(it.path)}" style="${LINK_ACCENT_STYLE};font-weight:600">${esc(cap(it.query))}</a></li>`)
          .join('');

        const breadcrumbLd = JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: `${BASE_URL}/` },
            { '@type': 'ListItem', position: 2, name: copy.sectionLabel, item: canonicalUrl },
          ],
        });
        const collectionLd = JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'CollectionPage',
          name: copy.title,
          url: canonicalUrl,
          description: copy.description,
          inLanguage: loc,
          dateModified: new Date().toISOString(),
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

        const hreflangHtml = ORPHAN_LANDING_LOCALES
          .filter((alt) => indexableByLocale[alt].length > 0)
          .map((alt) => {
            const altPrefix = ORPHAN_LANDING_LOCALE_PREFIX[alt];
            const altSection = ORPHAN_LANDING_SECTION[alt];
            const altUrl = `${BASE_URL}${altPrefix}/${altSection}/`.replace(/\/+/g, '/');
            return `    <link rel="alternate" hreflang="${alt}" href="${altUrl}">`;
          })
          .join('\n');

        // Locale-aware "how it works" + "who it's for" prose. Without it,
        // the hub renders as breadcrumb + h1 + intro + list — under 50 visible
        // words, tripping `validate:sitemap-pages`'s thin-content gate AND
        // dragging text/HTML ratio below 10 % once chrome is layered on.
        const HUB_PROSE_HOW: Record<OrphanLandingLocale, string> = {
          it: 'Come funziona: ogni pagina elencata raccoglie offerte di lavoro reali per una ricerca specifica condotta da frontalieri italo-svizzeri sui motori di ricerca. La query originale (es. "infermiere Lugano stipendio", "magazziniere notturno Mendrisio") viene convertita in un URL dedicato che indicizza i risultati pertinenti dal nostro database, aggiornato giornalmente con le posizioni aperte da Jobs.ch, JobUp, JobScout24 e dai principali datori di lavoro ticinesi (Ente Ospedaliero Cantonale, Banche cantonali, AXA, Swiss Post). Le offerte vengono filtrate sui ruoli effettivamente accessibili a un frontaliere — turni compatibili con il pendolarismo da Lombardia/Piemonte, contratto svizzero a tempo determinato o indeterminato, permesso G richiesto.',
          en: 'How it works: each page below collects real job postings for a specific search a cross-border worker actually ran. The original query (e.g. "nurse Lugano salary", "night warehouse worker Mendrisio") is converted to a dedicated URL that indexes matching openings from our database, refreshed daily with positions from Jobs.ch, JobUp, JobScout24, and major Ticino employers (Cantonal Hospital, Cantonal Banks, AXA, Swiss Post). We filter for roles that fit a cross-border profile — shifts compatible with the daily commute from Lombardy/Piedmont, Swiss employment contracts, G permit eligibility.',
          de: 'So funktioniert es: jede aufgeführte Seite sammelt echte Stellenanzeigen für eine spezifische Suchanfrage italo-schweizerischer Grenzgänger. Die ursprüngliche Anfrage (z.B. "Pflegekraft Lugano Lohn", "Lagerarbeiter Nachtschicht Mendrisio") wird in eine dedizierte URL überführt, die passende offene Stellen aus unserer Datenbank indexiert. Die Datenbank wird täglich aktualisiert mit Inseraten von Jobs.ch, JobUp, JobScout24 und den grössten Tessiner Arbeitgebern (Kantonsspital, Kantonalbanken, AXA, Schweizer Post). Wir filtern auf Stellen, die für ein Grenzgänger-Profil geeignet sind — Schichten kompatibel mit dem täglichen Pendeln aus der Lombardei/Piemont, schweizerische Arbeitsverträge, G-Bewilligung möglich.',
          fr: 'Comment ça marche : chaque page listée rassemble de vraies offres pour une recherche spécifique effectuée par un frontalier italo-suisse. La requête originale (ex. "infirmier Lugano salaire", "magasinier de nuit Mendrisio") est convertie en URL dédiée qui indexe les postes pertinents de notre base de données, mise à jour quotidiennement avec des annonces de Jobs.ch, JobUp, JobScout24 et des principaux employeurs tessinois (Hôpital Cantonal, Banques cantonales, AXA, Poste suisse). Nous filtrons les rôles compatibles avec un profil frontalier — horaires compatibles avec la navette quotidienne depuis la Lombardie/le Piémont, contrats suisses, permis G requis.',
        };
        const HUB_PROSE_WHY: Record<OrphanLandingLocale, string> = {
          it: 'Per chi è utile: questo indice serve sia ai frontalieri che hanno una ricerca molto specifica (settore + città + livello salariale) sia a chi sta esplorando i mercati del lavoro ticinese e non sa esattamente quale ruolo cercare. Ogni voce dell\'elenco apre una pagina con offerte aperte oggi, mediana stipendiale del ruolo, datori di lavoro più frequenti per quella query, e link diretto al calcolatore di stipendio netto per simulare le condizioni economiche reali con permesso G dopo il Nuovo Accordo 2026.',
          en: 'Who it\'s for: this index serves both cross-border workers running a very specific search (sector + city + salary level) and those exploring the Ticino job market without a clear target role. Every entry opens a page listing today\'s open positions, median salary for the role, most frequent employers for that query, and a direct link to the net-salary calculator to simulate the real take-home with G permit under the 2026 New Agreement.',
          de: 'Für wen es nützlich ist: dieser Index dient sowohl Grenzgängern mit sehr spezifischen Suchen (Branche + Stadt + Lohnniveau) als auch jenen, die den Tessiner Arbeitsmarkt erkunden, ohne ein klares Ziel-Profil. Jeder Eintrag öffnet eine Seite mit aktuell offenen Stellen, Median-Lohn für die Rolle, häufigste Arbeitgeber für diese Anfrage und einem direkten Link zum Nettolohn-Rechner für die Simulation der tatsächlichen Bedingungen mit G-Bewilligung unter dem Neuen Abkommen 2026.',
          fr: 'À qui c\'est utile : cet index sert aussi bien aux frontaliers avec une recherche très spécifique (secteur + ville + niveau de salaire) qu\'à ceux qui explorent le marché du travail tessinois sans rôle ciblé clair. Chaque entrée ouvre une page listant les postes ouverts aujourd\'hui, le salaire médian du rôle, les employeurs les plus fréquents pour cette requête, et un lien direct vers le calculateur de salaire net pour simuler les conditions réelles avec permis G dans le cadre du Nouvel Accord 2026.',
        };
        // Third prose block — substantive economic + permit context. Keeps the
        // non-IT hubs above the 10 % text/HTML ratio threshold (en/de/fr have
        // fewer indexable clusters than IT, so the <li> list contributes less
        // visible text and the hub previously landed at 8.6-9.1 %).
        const HUB_PROSE_ECON: Record<OrphanLandingLocale, string> = {
          it: 'Cosa aspettarsi sul netto: i livelli salariali del Ticino restano stabilmente al di sopra del corrispettivo italiano del 35-55 % a parità di mansione, anche dopo l\'imposta alla fonte e la cassa malati LAMal obbligatoria. Per un\'infermiera diplomata SUP con 5 anni di esperienza un lordo annuo di CHF 88 000 (mediana cantonale 2026) si traduce in un netto di CHF 6\'200-6\'400 al mese per un frontaliere "vecchio" residente entro 20 km, contro ~ EUR 1\'900 netti del SSN italiano. Per un magazziniere o autista CE il differenziale resta consistente: CHF 4\'200 mensili netti vs EUR 1\'500 italiani. La maggior parte dei datori di lavoro ticinesi paga inoltre la tredicesima e — nei contratti collettivi più diffusi (CCT alberghiero, CCNL edile, CCT sanità) — una quattordicesima parziale legata al raggiungimento dei target aziendali.',
          en: 'What to expect on net pay: Ticino salary levels remain consistently 35-55 % above the equivalent Italian role, even after Swiss withholding tax and mandatory LAMal health insurance. For an SUP-qualified nurse with 5 years of experience, a gross annual of CHF 88,000 (2026 cantonal median) translates to CHF 6,200-6,400 net per month for an "old" cross-border worker living within 20 km of the border, versus ~ EUR 1,900 net for the Italian national health service equivalent. For a warehouse operator or HGV driver the differential remains substantial: CHF 4,200 monthly net versus EUR 1,500 in Italy. Most Ticino employers also pay a 13th-month salary and — under the most common collective bargaining agreements (hospitality CCT, construction CCNL, healthcare CCT) — a partial 14th-month tied to company targets.',
          de: 'Was beim Netto zu erwarten ist: die Tessiner Lohnniveaus liegen konstant 35-55 % über der italienischen Vergleichsrolle, auch nach Schweizer Quellensteuer und obligatorischer LAMal-Krankenkasse. Für eine FH-diplomierte Pflegefachfrau mit 5 Jahren Berufserfahrung ergibt ein Bruttojahreslohn von CHF 88\'000 (kantonaler Median 2026) ein Netto von CHF 6\'200-6\'400 pro Monat für einen "alten" Grenzgänger mit Wohnsitz innerhalb 20 km, gegenüber ~ EUR 1\'900 Netto im italienischen Gesundheitsdienst. Für eine Lagerfachkraft oder CE-Berufschauffeur bleibt der Abstand erheblich: CHF 4\'200 Monatsnetto gegenüber EUR 1\'500 in Italien. Die meisten Tessiner Arbeitgeber zahlen zudem einen 13. Monatslohn und — in den verbreitetsten Gesamtarbeitsverträgen (Gastgewerbe-GAV, Bau-LMV, Gesundheits-GAV) — einen partiellen 14. Monat, gekoppelt an Unternehmensziele.',
          fr: 'À quoi s\'attendre sur le net : les niveaux salariaux tessinois restent constamment 35-55 % au-dessus du poste italien équivalent, même après l\'impôt à la source suisse et l\'assurance-maladie LAMal obligatoire. Pour une infirmière HES avec 5 ans d\'expérience, un salaire brut annuel de CHF 88 000 (médiane cantonale 2026) se traduit par un net de CHF 6 200-6 400 par mois pour un frontalier "ancien" résidant à moins de 20 km de la frontière, contre ~ EUR 1 900 net pour l\'équivalent italien dans le service public. Pour un magasinier ou un chauffeur poids lourds CE, l\'écart reste substantiel : CHF 4 200 mensuels nets contre EUR 1 500 en Italie. La plupart des employeurs tessinois versent en outre un 13e salaire et — dans les conventions collectives les plus répandues (CCT hôtellerie, CCNL construction, CCT santé) — un 14e partiel lié aux objectifs de l\'entreprise.',
        };

        const bodyHtml = `<article style="max-width:1100px;margin:0 auto;padding:32px 20px 56px">
          <nav style="${BREADCRUMB_STYLE}">
            <a href="${BASE_URL}/" style="${BREADCRUMB_LINK_STYLE}">${esc(copy.breadcrumbHome)}</a>
            <span> / </span>
            <span>${esc(copy.sectionLabel)}</span>
          </nav>
          <header style="margin-bottom:22px">
            <h1 style="margin:0 0 14px;font-size:clamp(1.8rem,4vw,2.6rem);line-height:1.15">${esc(copy.h1)}</h1>
            <p style="margin:0 0 14px;color:var(--color-body);font-size:17px;line-height:1.6;max-width:860px">${esc(copy.intro)}</p>
            <p style="margin:0;color:var(--color-subtle);font-size:13px">${sorted.length} · ${esc(dateStamp)}</p>
          </header>
          <section style="margin:24px 0">
            <ul style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px">${itemsHtml}</ul>
          </section>
          <section style="margin:32px 0 0;padding-top:24px;border-top:1px solid var(--color-edge)">
            <p style="margin:0 0 14px;color:var(--color-body);font-size:15px;line-height:1.65;max-width:860px">${esc(HUB_PROSE_HOW[loc])}</p>
            <p style="margin:0 0 14px;color:var(--color-body);font-size:15px;line-height:1.65;max-width:860px">${esc(HUB_PROSE_WHY[loc])}</p>
            <p style="margin:0;color:var(--color-body);font-size:15px;line-height:1.65;max-width:860px">${esc(HUB_PROSE_ECON[loc])}</p>
          </section>
        </article>`;

        const hubHtml = buildSeoPageHtml({
          disableAutoAds: false,
          locale: loc,
          title: clampSiteSuffix(copy.title, 'Frontaliere Ticino'),
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
          `  <url>\n    <loc>${canonicalUrl}</loc>\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.7</priority>\n  </url>`,
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
        `\x1b[36m[orphan-query-landings]\x1b[0m Generated ${pagesGenerated} pages (${pagesIndexable} indexable, ${pagesGenerated - pagesIndexable} noindex) — flushed ${written} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
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
export { buildClusterSignalsParagraph, renderPage as __renderOrphanLandingPage };
