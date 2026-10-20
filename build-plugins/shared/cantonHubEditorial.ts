/**
 * Shared editorial blocks for cathedral canton landing pages.
 *
 * The Ticino hub (`/cerca-lavoro-ticino/`) has shipped since launch with a
 * rich editorial body: H2 definition block for AI extraction, deep-link
 * archive navigator, frontaliere context prose, and a collapsible FAQ.
 *
 * Phase 8(g) of the cathedral-canton-aware rewrite brings the same
 * editorial richness to every cathedral canton landing — `/cerca-lavoro-zurigo/`,
 * `/cerca-lavoro-svizzera/`, etc. Until this helper landed, those pages
 * shipped only with tiles + CTA + listing grid + `buildCantonContextProse`,
 * a thin set that struggled to clear the text/HTML 10 % ratio gate and
 * gave neither AI extractors nor crawlers the same definition surface as
 * the TI hub.
 *
 * **TI Italian structure.** The established heading, archive navigator,
 * prose order and FAQ remain, while claims about active vacancies, employer
 * totals, update cadence, permit eligibility and salary estimates have been
 * removed. `cathedral-canton-hub-parity.test.ts` protects the structure and
 * source-derived count, not the retired claims. Other locale/canton variants
 * use localized copy and the same reusable archive navigator.
 *
 * **Per-canton commuter prose** (Como → Brogeda etc.) is NOT emitted by
 * this helper. The legacy TI prose mentions Lugano, Bellinzona, Locarno,
 * Mendrisio and the Como/Varese border crossings — content that makes
 * no sense on `/cerca-lavoro-zurigo/`. Non-Ticino pages use neutral guidance
 * to verify the original listing, its location and explicit language
 * requirements instead of applying Italian-specific tax or permit claims.
 */

import {
  PAGINATION_INDEX_THRESHOLD,
  paginationIndexCount,
  paginationIndexLabel,
  paginationIndexPath,
  paginationIndexRange,
  paginatedPath,
} from '../seoHubsData';
import type { HubLocale as ArchiveHubLocale } from '../seoHubsData';
import { cantonFaqMedianAnnual } from './cantonSalaryIndex';

// ── Real-data block (issue #4303 item 1) ──────────────────────────────
// Adds a sourced-data section for canton hubs except those whose localized
// regional guidance replaces it. Figures come from build-time sources — nothing here is
// invented: sector medians are computed from live `data/jobs.json`
// baseSalary fields (BFS LSE has no per-profession breakdown, only the
// 7-Grossregion wage level already used by `cantonSalaryIndex.ts`),
// wage-level + LAMal premium are the two real cross-canton axes for a
// "cost of living vs Ticino" comparison (no cross-canton rent/CPI dataset
// exists in-repo — `data/seo/fso-rental-medians.json` is Ticino-only), and
// the employer list reuses the same live `data/jobs.json` company field
// that `weeklyEmployersData.ts` and the existing per-canton company-hub
// navigator (`jobsSeoPagesPlugin.ts`) already draw from.

/** Format a CHF integer with the '.' thousands separator used in this editorial. */
function fmtChfDot(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

export interface CantonHubEditorialOpts {
  /** Canton code, e.g. 'TI', 'ZH', 'GE', or AGGREGATE_KEY for the federal hub. */
  canton: string;
  /** Locale of the page being emitted. */
  locale: ArchiveHubLocale;
  /** Display label, e.g. 'Ticino', 'Zurigo', 'Svizzera'. */
  display: string;
  /** Total jobs counted for this canton (used in intro copy). */
  jobsCount: number;
  /** Total number of paginated archive pages (`Math.ceil(jobsCount / JOBS_PAGE_SIZE)`). */
  totalPages: number;
  /** Base path for the paginated archive, e.g. '/cerca-lavoro-zurigo/tutti/'. */
  archiveBaseHref: string;
  /** Number of archive pages actually emitted for this locale/canton. */
  archiveNavigablePages?: number;
}

type CantonHubArchiveNavigationOpts = Pick<
  CantonHubEditorialOpts,
  'locale' | 'totalPages' | 'archiveBaseHref' | 'archiveNavigablePages'
>;

// Local escape helper. Matches the staticPagesPlugin / jobsSeoPages
// implementations so a shared move stays byte-identical.
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Build the archive page navigator independently from long-form copy. */
export function buildCantonHubArchiveNavigation(opts: CantonHubArchiveNavigationOpts): string {
  const navigablePages = Math.max(1, Math.floor(opts.archiveNavigablePages ?? opts.totalPages));
  if (navigablePages <= 1) return '';

  const { locale, archiveBaseHref } = opts;
  const jobsNavLabel = locale === 'it' ? 'Sfoglia tutto l\'archivio offerte per pagina'
    : locale === 'en' ? 'Browse the full job archive by page'
    : locale === 'de' ? 'Vollständiges Stellenarchiv nach Seite durchsuchen'
    : 'Parcourir toutes les offres par page';
  const jobsPageWord = locale === 'it' ? 'Pagina' : locale === 'en' ? 'Page' : locale === 'de' ? 'Seite' : 'Page';
  const jobsPagesWord = { it: 'pagine', en: 'pages', de: 'Seiten', fr: 'pages' }[locale];
  const anchorFor = (p: number): string => {
    const href = paginatedPath(archiveBaseHref, p);
    return `<a class="s-040ZNE" href="${href}">${jobsPageWord}&nbsp;${p}</a>`;
  };
  const jobsAnchors: string[] = [];
  if (navigablePages <= PAGINATION_INDEX_THRESHOLD) {
    for (let p = 1; p <= navigablePages; p++) jobsAnchors.push(anchorFor(p));
  } else {
    jobsAnchors.push(anchorFor(1));
    for (let indexPage = 1; indexPage <= paginationIndexCount(navigablePages); indexPage++) {
      const range = paginationIndexRange(navigablePages, indexPage);
      jobsAnchors.push(
        `<a class="s-040ZNE" href="${paginationIndexPath(archiveBaseHref, indexPage)}">${esc(paginationIndexLabel(locale, range.start, range.end))}</a>`,
      );
    }
  }
  return `<details class="s-01GpQM"><summary class="s-hQKogV">${esc(jobsNavLabel)} (${navigablePages} ${jobsPagesWord})</summary><nav class="s-SMVope" aria-label="${esc(jobsNavLabel)}">${jobsAnchors.join('')}</nav></details>`;
}

function buildLocalizedCantonHubEditorial(opts: CantonHubEditorialOpts): string[] {
  const count = Math.max(0, Math.floor(opts.jobsCount));
  const countLabel = count.toLocaleString(`${opts.locale}-CH`);
  const name = esc(opts.display);
  const isAggregate = ['Svizzera', 'Switzerland', 'Schweiz', 'Suisse'].includes(opts.display);
  const copy = {
    it: {
      heading: isAggregate ? 'Offerte di lavoro in Svizzera' : `Offerte di lavoro nel Canton ${name}`,
      intro: `L’archivio ${isAggregate ? 'in Svizzera' : `del Canton ${name}`} raccoglie ${countLabel} annunci. Il numero descrive i contenuti raccolti dal sito e non è un censimento completo dei posti vacanti. Apri l’annuncio originale per verificare disponibilità, requisiti e modalità di candidatura.`,
      summary: 'Domande frequenti sulla ricerca di lavoro',
      questions: [
        ['Gli annunci sono ancora disponibili?', 'La disponibilità può cambiare: controlla la pagina originale prima di candidarti.'],
        ['Come valutare la sede e il tragitto?', 'Parti dall’indirizzo riportato nell’annuncio e confrontalo con gli orari effettivi del lavoro e dei trasporti.'],
        ['La lingua della pagina indica le lingue richieste?', 'No. La lingua della pagina o della traduzione non prova quali lingue richieda il ruolo. Controlla i requisiti espliciti nell’annuncio originale o chiedi conferma al datore di lavoro.'],
      ],
    },
    en: {
      heading: isAggregate ? 'Job listings in Switzerland' : `Job listings in the canton of ${name}`,
      intro: `The archive ${isAggregate ? 'for Switzerland' : `for the canton of ${name}`} contains ${countLabel} collected listings. This number describes content gathered by the site and is not a complete count of vacancies. Open the original listing to check availability, requirements and application instructions.`,
      summary: 'Frequently asked questions about job search',
      questions: [
        ['Are the listings still available?', 'Availability can change, so check the original page before applying.'],
        ['How should I assess the work location and commute?', 'Start with the address in the listing and compare it with the actual work schedule and transport times.'],
        ['Does the page language show which languages the job requires?', 'No. The page language or a translation does not establish the role’s language requirements. Check the explicit requirements in the original listing or ask the employer.'],
      ],
    },
    de: {
      heading: isAggregate ? 'Stellenangebote in der Schweiz' : `Stellenangebote im Kanton ${name}`,
      intro: `Das Archiv ${isAggregate ? 'der Schweiz' : `für den Kanton ${name}`} enthält ${countLabel} gesammelte Einträge. Diese Zahl beschreibt die von der Website gesammelten Inhalte und ist keine vollständige Erhebung offener Stellen. Prüfen Sie Verfügbarkeit, Anforderungen und Bewerbungshinweise in der ursprünglichen Ausschreibung.`,
      summary: 'Häufige Fragen zur Stellensuche',
      questions: [
        ['Sind die Einträge noch verfügbar?', 'Angebote können sich ändern; prüfen Sie deshalb die ursprüngliche Ausschreibung vor einer Bewerbung.'],
        ['Wie lassen sich Arbeitsort und Arbeitsweg beurteilen?', 'Orientieren Sie sich an der Adresse in der Ausschreibung und vergleichen Sie diese mit den tatsächlichen Arbeitszeiten und Verbindungen.'],
        ['Zeigt die Seitensprache, welche Sprachen verlangt werden?', 'Nein. Die Seitensprache oder eine Übersetzung belegt keine Sprachanforderungen der Stelle. Prüfen Sie die ausdrücklichen Anforderungen in der ursprünglichen Ausschreibung oder fragen Sie beim Arbeitgeber nach.'],
      ],
    },
    fr: {
      heading: isAggregate ? 'Offres d’emploi en Suisse' : `Offres d’emploi dans le canton de ${name}`,
      intro: `L’archive ${isAggregate ? 'de la Suisse' : `du canton de ${name}`} regroupe ${countLabel} annonces recueillies. Ce nombre décrit les contenus recueillis par le site et ne constitue pas un recensement complet des postes vacants. Ouvrez l’annonce d’origine pour vérifier sa disponibilité, les exigences et les modalités de candidature.`,
      summary: 'Questions fréquentes sur la recherche d’emploi',
      questions: [
        ['Les annonces sont-elles encore disponibles ?', 'Les offres peuvent évoluer : consultez la page d’origine avant de postuler.'],
        ['Comment évaluer le lieu de travail et le trajet ?', 'Partez de l’adresse indiquée dans l’annonce et comparez-la aux horaires réels du poste et des transports.'],
        ['La langue de la page indique-t-elle les langues demandées ?', 'Non. La langue de la page ou d’une traduction ne prouve pas les exigences linguistiques du poste. Consultez les exigences explicites dans l’annonce d’origine ou demandez confirmation à l’employeur.'],
      ],
    },
  }[opts.locale];
  const nav = buildCantonHubArchiveNavigation(opts);
  const faq = copy.questions
    .map(([question, answer]) => `<p class="s-F2hp6o"><strong>${esc(question)}</strong> ${esc(answer)}</p>`)
    .join('');
  const heading = `<h2 class="s-o3IET6">${copy.heading}</h2>`;
  const intro = `<p class="s-6g7z41">${copy.intro}</p>`;
  const generalGuidance = opts.locale === 'it'
    ? '<h3 class="s-8S_vke">Confrontare le offerte con la propria situazione</h3><p class="s-L9sOKI">Controlla sede, orari, mansioni e requisiti direttamente nella fonte originale. La traduzione facilita la lettura, ma non sostituisce le informazioni del datore di lavoro.</p>'
    : opts.locale === 'en'
      ? '<h3 class="s-8S_vke">Compare listings with your situation</h3><p class="s-L9sOKI">Check the location, schedule, duties and requirements in the original source. A translation can help with reading, but it does not replace information from the employer.</p>'
      : opts.locale === 'de'
        ? '<h3 class="s-8S_vke">Stellen mit der eigenen Situation vergleichen</h3><p class="s-L9sOKI">Prüfen Sie Arbeitsort, Arbeitszeiten, Aufgaben und Anforderungen in der ursprünglichen Quelle. Eine Übersetzung erleichtert das Lesen, ersetzt aber keine Angaben des Arbeitgebers.</p>'
        : '<h3 class="s-8S_vke">Comparer les offres avec sa situation</h3><p class="s-L9sOKI">Vérifiez le lieu, les horaires, les tâches et les exigences dans la source d’origine. Une traduction peut faciliter la lecture, mais elle ne remplace pas les informations de l’employeur.</p>';
  const faqHtml = `<details class="s-01GpQM"><summary class="s-qAjSfB">${esc(copy.summary)}</summary><div class="s-4vhLHi">${faq}</div></details>`;
  return [
    `<section class="s-IE_H9o" data-canton-context-prose data-canton-editorial>${heading}${intro}${nav}${generalGuidance}${faqHtml}</section>`,
  ];
}

/**
 * Build the canton-hub editorial blocks. Returns an array of HTML strings
 * suitable for `editorialBlocks.push(...buildCantonHubEditorial(...))`
 * (staticPagesPlugin), or for joining into a single string before
 * concatenation into the canton-landing `bodyHtml` (jobsSeoPagesPlugin).
 *
 * Each returned entry already begins with a block-level HTML element so
 * the staticPagesPlugin auto-`<p>`-wrap regex (`/^<(h[1-6]|p|nav|div|details|section|ul|ol|table|figure|aside|blockquote)\b/`)
 * leaves them untouched.
 */
export function buildCantonHubEditorial(opts: CantonHubEditorialOpts): string[] {
  // Keep the long-running Ticino/Italian page shape for its dedicated owner;
  // every other locale/canton receives localized, inventory-bound copy.
  if (opts.canton !== 'TI' || opts.locale !== 'it') {
    return buildLocalizedCantonHubEditorial(opts);
  }

  const {
    canton,
    locale,
    display,
    jobsCount,
    totalPages,
    archiveBaseHref,
    archiveNavigablePages,
  } = opts;
  const navigablePages = Math.max(1, Math.floor(archiveNavigablePages ?? totalPages));
  const isTi = canton === 'TI';
  const out: string[] = [];

  // Zero is a measured empty inventory, never a reason to invent vacancies.
  const tiJobsClaim = `<strong>${jobsCount.toLocaleString('de-CH')}</strong>`;

  // ── 1. H2 + intro paragraph (definition block for AI extraction) ────────
  if (isTi) {
    // Keep the established TI heading while describing only what this
    // archive actually guarantees: a collected listing and a source link.
    out.push(
      `<h2 class="s-o3IET6">Offerte di Lavoro in Ticino — Bacheca Lavoro per Frontalieri</h2>`,
      `<p class="s-6g7z41">Cerchi <strong>lavoro in Ticino</strong>? Questa bacheca raccoglie ${tiJobsClaim} <strong>annunci</strong>. Il numero descrive i contenuti raccolti dal sito e non è un censimento completo dei posti vacanti. Apri l’annuncio originale per verificare disponibilità, requisiti e modalità di candidatura.</p>`,
    );
  } else {
    // Canton-agnostic intro. Uses `display` so it reads naturally for
    // ZH/GE/VD/etc. and avoids any TI-specific city or border-crossing
    // reference (those are Phase 9 follow-up).
    out.push(
      `<h2 class="s-o3IET6">${esc(`Offerte di Lavoro ${display === 'Svizzera' ? 'in Svizzera' : `nel Canton ${display}`} — Bacheca Lavoro per Frontalieri`)}</h2>`,
      `<p class="s-6g7z41">${esc(`Cerchi lavoro ${display === 'Svizzera' ? 'in Svizzera' : `nel Canton ${display}`}?`)} Questa bacheca raccoglie <strong>${jobsCount.toLocaleString('de-CH')}</strong> <strong>offerte di lavoro</strong> ${display === 'Svizzera' ? 'attive in tutta la Svizzera' : `attive nel Canton ${esc(display)}`}, aggiornate ogni 12 ore. Le posizioni coprono tutti i principali settori — banca, pharma, IT, edilizia, sanità, logistica — e sono disponibili in italiano, inglese, tedesco e francese. Ogni annuncio è collegato direttamente al sito ufficiale dell’azienda per la candidatura.</p>`,
    );
  }

  // ── 2. Deep-link archive navigator ────────────────────────────────────
  // Re-enabled for non-TI cantons 2026-05-13 — `seoHubsPlugin.emitThinCantonHubs`
  // now re-emits every `tutti/page-N` as minimal-body static HTML so the
  // navigator anchors resolve correctly. TI keeps the navigator via its
  // master `emitHub` which always emits full page-N HTML.
  //
  // Page-weight guard: for long archives, a flat page-1 ladder grows with
  // every archive page and can dominate the canton landing. The parent now
  // links to a bounded set of page-range indexes; each index links one
  // sqrt-sized range of archive pages. This keeps the parent → index → page
  // graph shallow enough for job leaves while making the page-1 payload
  // O(sqrt(totalPages)). Small archives retain the direct ladder.
  const archiveNav = buildCantonHubArchiveNavigation(opts);
  if (archiveNav) out.push(archiveNav);

  // ── 3. TI context prose + official source ─────────────────────────────
  if (isTi) {
    out.push(
      `La sezione <strong>offerte lavoro Ticino</strong> raccoglie annunci con informazioni sul ruolo e sulla sede, quando presenti nella fonte. Apri la pagina originale per leggere le condizioni pubblicate dal datore di lavoro e controllare se l’annuncio è ancora disponibile.`,
      `I dettagli mostrati possono includere data di pubblicazione, azienda, località e requisiti. La completezza dipende dalla fonte: verifica sulla pagina originale le informazioni necessarie per valutare e inviare la candidatura.`,
      `Le condizioni per lavorare in Svizzera dipendono dalla situazione personale. Per verificare autorizzazioni, requisiti e procedura applicabili, consulta le informazioni ufficiali della <a class="s-676LjN" href="https://www.sem.admin.ch/sem/it/home/themen/aufenthalt.html" rel="noopener noreferrer">Segreteria di Stato della migrazione (SEM)</a>; questa pagina non determina quale autorizzazione si applichi.`,
      `Puoi usare la ricerca e i filtri disponibili per esplorare gli annunci. La lingua della pagina o di una traduzione non indica le lingue richieste dal datore: controlla i requisiti espliciti nella fonte originale o chiedi conferma all’azienda.`,
      `<p class="s-M4r-xq">Fonte: <a class="s-676LjN" href="https://www.seco.admin.ch" rel="noopener">SECO - Segretariato di Stato dell'economia</a></p>`,
    );
  } else {
    const cantonOrCh = display === 'Svizzera' ? 'in Svizzera' : `nel Canton ${display}`;
    const cantonOrSwiss = display === 'Svizzera' ? 'svizzera' : `del Canton ${display}`;
    out.push(
      `La sezione <strong>offerte lavoro ${esc(cantonOrSwiss)}</strong> raccoglie annunci pubblicati su fonti aziendali ufficiali, con normalizzazione dei dati principali per facilitare il confronto tra ruolo, sede, contratto e coerenza con il proprio profilo professionale. Gli annunci provengono da aziende ${esc(cantonOrSwiss)} monitorate quotidianamente da crawler dedicati.`,
      `Per ogni posizione vengono mantenuti metadati utili alla valutazione: data di pubblicazione, azienda, località, requisiti richiesti e collegamento diretto alla candidatura sul sito originale del datore di lavoro. Le offerte sono filtrate ${esc(cantonOrCh)} e vengono aggiornate ogni 12 ore.`,
      `I frontalieri con permesso G hanno diritto a candidarsi a posizioni in tutta la Svizzera; la guida inclusa nella sezione lavoro spiega la procedura per richiedere un permesso di lavoro, i settori con maggiore domanda e i salari mediani per categoria professionale nel mercato del lavoro ${esc(cantonOrSwiss)}.`,
      `Il motore di ricerca integrato permette di filtrare per settore, tipo di contratto (tempo indeterminato, determinato, part-time), località e data di pubblicazione. La funzione di allerta e-mail notifica automaticamente le nuove offerte che corrispondono ai criteri salvati, così non si perde nessuna opportunità.`,
      `<p class="s-M4r-xq">Fonte: <a class="s-676LjN" href="https://www.seco.admin.ch" rel="noopener">SECO - Segretariato di Stato dell'economia</a></p>`,
    );
  }

  // ── 4. FAQ block (collapsible, AI-extractable) ────────────────────────
  if (isTi) {
    out.push(
      `<details class="s-01GpQM"><summary class="s-qAjSfB">Domande frequenti sulla ricerca lavoro in Ticino</summary><div class="s-4vhLHi">` +
      `<p class="s-F2hp6o"><strong>Gli annunci raccolti sono ancora disponibili?</strong> La disponibilità può cambiare: controlla la pagina originale prima di candidarti.</p>` +
      `<p class="s-F2hp6o"><strong>Come posso confrontare gli annunci in Ticino?</strong> Esamina mansioni, sede, orari e requisiti riportati nella fonte originale. Le informazioni disponibili possono variare da un annuncio all’altro.</p>` +
      `<p class="s-F2hp6o"><strong>Dove verifico le autorizzazioni per lavorare in Svizzera?</strong> Dipendono dalla situazione personale. Consulta le informazioni ufficiali della <a class="s-676LjN" href="https://www.sem.admin.ch/sem/it/home/themen/aufenthalt.html" rel="noopener noreferrer">SEM</a> per verificare requisiti e procedura; questa pagina non stabilisce quale autorizzazione si applichi.</p>` +
      `<p class="s-F2hp6o"><strong>La lingua dell’annuncio tradotto indica le lingue richieste?</strong> No. Controlla i requisiti linguistici espliciti nell’annuncio originale o chiedi conferma al datore di lavoro.</p>` +
      `<p class="s-F2hp6o"><strong>Come verifico la retribuzione?</strong> Consulta gli importi e le condizioni indicati dal datore nella fonte originale. Questa pagina non stima il salario del ruolo.</p>` +
      `<p class="s-F2hp6o"><strong>Come ritrovare gli annunci che mi interessano?</strong> Usa gli strumenti di ricerca disponibili e verifica sempre i dettagli e la disponibilità sulla pagina originale.</p>` +
      `<p class="s-fb-foD">Fonte: <a class="s-676LjN" href="https://www.bfs.admin.ch" rel="noopener">UST/BFS</a> · <a class="s-676LjN" href="https://www.seco.admin.ch" rel="noopener">SECO</a> · Dati Frontaliere Ticino</p>` +
      `</div></details>`,
    );
  } else {
    const cantonOrCh = display === 'Svizzera' ? 'in Svizzera' : `nel Canton ${display}`;
    const cantonOrSwiss = display === 'Svizzera' ? 'svizzero' : `del Canton ${display}`;
    const faqSalary = cantonFaqMedianAnnual(display);
    const summary = `Domande frequenti sulla ricerca lavoro ${cantonOrCh}`;
    out.push(
      `<details class="s-01GpQM"><summary class="s-qAjSfB">${esc(summary)}</summary><div class="s-4vhLHi">` +
      `<p class="s-F2hp6o"><strong>${esc(`Quante offerte di lavoro sono disponibili ${cantonOrCh}?`)}</strong> ${esc(`La sezione lavoro ${cantonOrCh} raccoglie ${jobsCount.toLocaleString('de-CH')} offerte attive, aggiornate ogni 12 ore tramite crawler automatici che monitorano i siti ufficiali delle aziende.`)}</p>` +
      `<p class="s-F2hp6o"><strong>${esc(`Come posso cercare lavoro ${cantonOrCh} come frontaliere?`)}</strong> Usa il motore di ricerca integrato per filtrare le posizioni per settore (banca, pharma, IT, edilizia, sanità), tipo di contratto (tempo indeterminato, determinato, part-time), località e data di pubblicazione. Ogni annuncio include il collegamento diretto alla candidatura sul sito aziendale.</p>` +
      `<p class="s-F2hp6o"><strong>Serve il permesso G per candidarsi?</strong> I frontalieri con permesso G (Grenzgängerbewilligung) possono candidarsi a qualsiasi posizione in Svizzera. Il permesso viene richiesto dal datore di lavoro dopo l'assunzione. Per i dettagli, consulta la <a class="s-676LjN" href="/guida-frontaliere/permessi-di-lavoro/">guida permessi di lavoro</a>.</p>` +
      `<p class="s-F2hp6o"><strong>${esc(`Quali sono i settori con più domanda ${cantonOrCh}?`)}</strong> I settori con maggiore domanda per frontalieri nel 2026 sono: servizi finanziari e bancari, farmaceutico e chimico, IT e software, edilizia e impiantistica, sanità e assistenza, ristorazione e turismo, logistica e trasporti.</p>` +
      `<p class="s-F2hp6o"><strong>${esc(`Qual è lo stipendio medio per un frontaliere ${cantonOrCh}?`)}</strong> ${esc(`Lo stipendio mediano lordo ${cantonOrSwiss} è di circa CHF ${fmtChfDot(faqSalary.medianLow)}-${fmtChfDot(faqSalary.medianHigh)} annui (fonte BFS, rilevazione struttura salari ${display === 'Svizzera' ? 'nazionale' : `Grossregion del Canton ${display}`}), variabile per settore: IT/Software CHF ${fmtChfDot(faqSalary.it)}+, Banca/Finanza CHF ${fmtChfDot(faqSalary.finance)}+, Pharma CHF ${fmtChfDot(faqSalary.pharma)}+, Commercio CHF ${fmtChfDot(faqSalary.retail)}.`)} Usa il <a class="s-676LjN" href="/calcola-stipendio/">simulatore fiscale</a> per calcolare il netto.</p>` +
      `<p class="s-F2hp6o"><strong>Come attivare le notifiche per nuove offerte?</strong> Imposta i tuoi criteri di ricerca (settore, località, parole chiave) e attiva le allerte e-mail: riceverai una notifica automatica quando vengono pubblicate nuove posizioni corrispondenti.</p>` +
      `<p class="s-fb-foD">Fonte: <a class="s-676LjN" href="https://www.bfs.admin.ch" rel="noopener">UST/BFS</a> · <a class="s-676LjN" href="https://www.seco.admin.ch" rel="noopener">SECO</a> · Dati Frontaliere Ticino</p>` +
      `</div></details>`,
    );
  }

  return out;
}

// ── Real-data block (issue #4303 item 1) ──────────────────────────────

export interface CantonRealDataSectorRow {
  /** Locale-resolved sector display label (SECTOR_HUB_DISPLAY[locale][sector]). */
  label: string;
  /** Median annual gross salary in CHF, computed from live job salaryMin/salaryMax for this canton×sector. */
  medianAnnualChf: number;
  /** Canonical job count backing the median (caller only passes rows that clear a stability floor). */
  jobCount: number;
  /** Href to the canton×sector landing page, or null when no such self-canonical page exists (aggregate hub). */
  href: string | null;
}

export interface CantonRealDataEmployer {
  name: string;
  jobCount: number;
  /** Href to the company hub page, or null when no such page exists (aggregate hub — plain text). */
  href: string | null;
}

export interface CantonRealDataBlockOpts {
  locale: ArchiveHubLocale;
  /** Display label, e.g. 'Zurigo', 'Berna', 'Basilea', 'Svizzera'. */
  display: string;
  isAggregate: boolean;
  /** Top sector rows, already sorted desc by jobCount and capped by the caller. */
  sectorRows: CantonRealDataSectorRow[];
  /** Wage-level factor vs Ticino (1.0 = same as Ticino), from cantonSalaryFactor(). */
  wageFactorVsTicino: number;
  /** Canton's own median monthly LAMal premium (standard adult 26+), CHF. */
  lamalMonthlyChf: number;
  /** Ticino's median monthly LAMal premium, CHF (comparison baseline). */
  lamalMonthlyTicinoChf: number;
  /** Whether the canton borders a foreign country, per cantonSalaryIndex.BORDER_CANTONS. */
  isBorderCanton: boolean;
  /** Top employers, already sorted desc by jobCount and capped by the caller. */
  employers: CantonRealDataEmployer[];
}

const REAL_DATA_H2: Record<ArchiveHubLocale, (display: string) => string> = {
  it: (d) => `Dati reali per chi lavora a ${d}`,
  en: (d) => `Real data for working in ${d}`,
  de: (d) => `Echte Daten für die Arbeit in ${d}`,
  fr: (d) => `Données réelles pour travailler à ${d}`,
};

const REAL_DATA_SUBHEAD: Record<ArchiveHubLocale, { salary: string; cost: string; permit: string; employers: string }> = {
  it: { salary: 'Salari mediani per professione', cost: 'Costo della vita vs Ticino', permit: 'Informazioni sulle autorizzazioni di lavoro', employers: 'Aziende che assumono' },
  en: { salary: 'Median salary by profession', cost: 'Cost of living vs Ticino', permit: 'Work authorization information', employers: 'Companies hiring' },
  de: { salary: 'Medianlohn nach Beruf', cost: 'Lebenshaltungskosten vs. Tessin', permit: 'Informationen zu Arbeitsbewilligungen', employers: 'Unternehmen, die einstellen' },
  fr: { salary: 'Salaire médian par profession', cost: 'Coût de la vie vs Tessin', permit: 'Informations sur les autorisations de travail', employers: 'Entreprises qui recrutent' },
};

const REAL_DATA_JOBS_WORD: Record<ArchiveHubLocale, (n: number) => string> = {
  it: (n) => `${n} offert${n === 1 ? 'a' : 'e'}`,
  en: (n) => `${n} job${n === 1 ? '' : 's'}`,
  de: (n) => `${n} Stelle${n === 1 ? '' : 'n'}`,
  fr: (n) => `${n} offre${n === 1 ? '' : 's'}`,
};

const REAL_DATA_PER_YEAR: Record<ArchiveHubLocale, string> = {
  it: '/anno', en: '/year', de: '/Jahr', fr: '/an',
};

/** Cost-of-living comparison paragraph — wage-level factor + LAMal premium delta vs Ticino. Both real, sourced axes (BFS LSE Grossregion wage index + BAG/UFSP LAMal medians); no fabricated CPI/rent index. */
function costOfLivingParagraph(
  locale: ArchiveHubLocale,
  display: string,
  wageFactorVsTicino: number,
  lamalMonthlyChf: number,
  lamalMonthlyTicinoChf: number,
): string {
  const wagePct = Math.round((wageFactorVsTicino - 1) * 100);
  const lamalDelta = lamalMonthlyChf - lamalMonthlyTicinoChf;
  const lamalPct = lamalMonthlyTicinoChf > 0 ? Math.round((lamalDelta / lamalMonthlyTicinoChf) * 100) : 0;
  const wageChf = fmtChfDot(lamalMonthlyChf);
  const tiChf = fmtChfDot(lamalMonthlyTicinoChf);
  switch (locale) {
    case 'en': {
      const wageDir = wagePct >= 0 ? 'about' : 'about';
      const lamalDir = lamalDelta >= 0 ? 'higher' : 'lower';
      return `The median gross salary in ${display} is ${wageDir} ${Math.abs(wagePct)}% ${wagePct >= 0 ? 'higher' : 'lower'} than in Ticino (BFS LSE 2024 regional wage-level data). The median LAMal health-insurance premium is also ${lamalDir}: CHF ${wageChf}/month vs CHF ${tiChf}/month in Ticino (${Math.abs(lamalPct)}% ${lamalDir}, BAG/UFSP data) — a real extra cost to factor into your net income.`;
    }
    case 'de': {
      const dir = wagePct >= 0 ? 'höher' : 'niedriger';
      const lamalDir = lamalDelta >= 0 ? 'höher' : 'niedriger';
      return `Der Medianlohn brutto in ${display} liegt rund ${Math.abs(wagePct)}% ${dir} als im Tessin (BFS-LSE-2024-Lohnniveau nach Grossregion). Auch die mediane LAMal-Krankenkassenprämie ist ${lamalDir}: CHF ${wageChf}/Monat gegenüber CHF ${tiChf}/Monat im Tessin (${Math.abs(lamalPct)}% ${lamalDir}, BAG-Daten) — ein realer Zusatzkosten-Faktor für das Nettoeinkommen.`;
    }
    case 'fr': {
      const dir = wagePct >= 0 ? 'supérieur' : 'inférieur';
      const lamalDir = lamalDelta >= 0 ? 'plus élevée' : 'plus basse';
      return `Le salaire brut médian à ${display} est environ ${Math.abs(wagePct)}% ${dir} par rapport au Tessin (niveau salarial régional BFS LSE 2024). La prime LAMal médiane est aussi ${lamalDir}: CHF ${wageChf}/mois contre CHF ${tiChf}/mois au Tessin (${Math.abs(lamalPct)}%, données OFSP) — un coût réel à intégrer dans le calcul du net.`;
    }
    default: {
      const dir = wagePct >= 0 ? 'più alto' : 'più basso';
      const lamalDir = lamalDelta >= 0 ? 'più alto' : 'più basso';
      return `Il salario mediano lordo a ${display} è circa il ${Math.abs(wagePct)}% ${dir} rispetto al Ticino (dato BFS LSE 2024 sul livello salariale regionale). Anche il premio mediano di cassa malati (LAMal) è ${lamalDir}: CHF ${wageChf}/mese contro CHF ${tiChf}/mese in Ticino (${Math.abs(lamalPct)}%, dato UFSP/BAG) — un costo reale da considerare nel calcolo del netto.`;
    }
  }
}

/** Link to official information without inferring a permit from a canton or residence country. */
function workAuthorizationParagraph(locale: ArchiveHubLocale): string {
  const copy: Record<ArchiveHubLocale, { before: string; link: string; after: string; href: string }> = {
    it: {
      before: 'Per informazioni ufficiali sul permesso G per cittadini UE/AELS, consulta la ',
      link: 'Segreteria di Stato della migrazione (SEM)',
      after: '. Per il tuo caso, verifica requisiti e procedura presso l’autorità competente.',
      href: 'https://www.sem.admin.ch/sem/it/home/themen/aufenthalt/eu_efta/ausweis_g_eu_efta.html',
    },
    en: {
      before: 'For official information about the G permit for EU/EFTA nationals, consult the ',
      link: 'State Secretariat for Migration (SEM)',
      after: '. Check the applicable requirements and process with the competent authority for your situation.',
      href: 'https://www.sem.admin.ch/sem/en/home/themen/aufenthalt/eu_efta/ausweis_g_eu_efta.html',
    },
    de: {
      before: 'Offizielle Informationen zur G-Bewilligung für EU/EFTA-Staatsangehörige bietet das ',
      link: 'Staatssekretariat für Migration (SEM)',
      after: '. Prüfen Sie die für Ihre Situation geltenden Anforderungen und das Verfahren bei der zuständigen Behörde.',
      href: 'https://www.sem.admin.ch/sem/de/home/themen/aufenthalt/eu_efta/ausweis_g_eu_efta.html',
    },
    fr: {
      before: 'Pour des informations officielles sur le permis G des ressortissants UE/AELE, consultez le ',
      link: 'Secrétariat d’État aux migrations (SEM)',
      after: '. Vérifiez les exigences et la procédure applicables à votre situation auprès de l’autorité compétente.',
      href: 'https://www.sem.admin.ch/sem/fr/home/themen/aufenthalt/eu_efta/ausweis_g_eu_efta.html',
    },
  };
  const text = copy[locale];
  return `${text.before}<a href="${text.href}" rel="noopener noreferrer">${text.link}</a>${text.after}`;
}

/**
 * Real-data block for the item 1 cathedral canton hubs (Zurigo, Berna,
 * Basilea, + the Svizzera aggregate). Placed AFTER the data/listing area
 * (mobile-first — see the caller's insertion point in jobsSeoPagesPlugin.ts,
 * right after `cantonEditorialSection`). Every figure is sourced from a
 * real build-time dataset — see the module-header comment above for the
 * per-axis source rationale.
 */
export function buildCantonRealDataBlock(opts: CantonRealDataBlockOpts): string {
  const { locale, display, sectorRows, wageFactorVsTicino, lamalMonthlyChf, lamalMonthlyTicinoChf, employers } = opts;
  const sub = REAL_DATA_SUBHEAD[locale] || REAL_DATA_SUBHEAD.it;
  const jobsWord = REAL_DATA_JOBS_WORD[locale] || REAL_DATA_JOBS_WORD.it;
  const perYear = REAL_DATA_PER_YEAR[locale] || REAL_DATA_PER_YEAR.it;
  const h2 = (REAL_DATA_H2[locale] || REAL_DATA_H2.it)(display);

  const parts: string[] = [`<h2 class="s-h0yI7F">${esc(h2)}</h2>`];

  if (sectorRows.length > 0) {
    parts.push(`<h3 class="s-8S_vke">${esc(sub.salary)}</h3>`);
    parts.push(
      `<ul class="s-N93mPe">` +
      sectorRows
        .map((r) => {
          const text = `${esc(r.label)}: CHF ${fmtChfDot(r.medianAnnualChf)}${esc(perYear)} · ${esc(jobsWord(r.jobCount))}`;
          return r.href
            ? `<li><a class="s-7DS5hj" href="${esc(r.href)}">${text}</a></li>`
            : `<li><span class="s-7DS5hj">${text}</span></li>`;
        })
        .join('') +
      `</ul>`,
    );
  }

  parts.push(`<h3 class="s-8S_vke">${esc(sub.cost)}</h3>`);
  parts.push(`<p class="s-L9sOKI">${costOfLivingParagraph(locale, display, wageFactorVsTicino, lamalMonthlyChf, lamalMonthlyTicinoChf)}</p>`);

  parts.push(`<h3 class="s-8S_vke">${esc(sub.permit)}</h3>`);
  parts.push(`<p class="s-L9sOKI">${workAuthorizationParagraph(locale)}</p>`);

  if (employers.length > 0) {
    parts.push(`<h3 class="s-8S_vke">${esc(sub.employers)}</h3>`);
    parts.push(
      `<ul class="s-N93mPe">` +
      employers
        .map((e) => {
          const text = `${esc(e.name)} · ${esc(jobsWord(e.jobCount))}`;
          return e.href
            ? `<li><a class="s-7DS5hj" href="${esc(e.href)}">${text}</a></li>`
            : `<li><span class="s-7DS5hj">${text}</span></li>`;
        })
        .join('') +
      `</ul>`,
    );
  }

  return `<section class="s-IE_H9o" data-canton-real-data>${parts.join('')}</section>`;
}
