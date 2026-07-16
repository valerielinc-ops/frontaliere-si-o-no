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
 * **TI parity contract.** When called with `{canton: 'TI', display:
 * 'Ticino', locale: 'it', ...}`, this helper emits the same set of strings
 * that `staticPagesPlugin.ts` previously inlined for its TI `isJobsIndex`
 * branch — same order, same array length — with ONE deliberate deviation
 * (2026-06): the hardcoded "oltre 1.500 offerte" claim now interpolates the
 * live `jobsCount` (it contradicted the real count surfaced in the page
 * title), falling back to the legacy fixed claim when `jobsCount <= 0`.
 * `cathedral-canton-hub-parity.test.ts` pins this behaviour. The TI canton
 * navigator (`<details>` listing every other canton) is intentionally NOT
 * part of this helper because it is unique to the TI hub; it stays inline
 * in `staticPagesPlugin.ts`.
 *
 * **Per-canton commuter prose** (Como → Brogeda etc.) is NOT emitted by
 * this helper. The legacy TI prose mentions Lugano, Bellinzona, Locarno,
 * Mendrisio and the Como/Varese border crossings — content that makes
 * no sense on `/cerca-lavoro-zurigo/`. For non-TI cantons the helper
 * emits a canton-agnostic parametric variant that name-drops `display`
 * instead of TI-specific cities; per-canton commuter copy is a Phase 9
 * follow-up.
 */

import { paginatedPath } from '../seoHubsData';
import type { HubLocale as ArchiveHubLocale } from '../seoHubsData';
import { cantonFaqMedianAnnual } from './cantonSalaryIndex';

// ── Real-data block (issue #4303 item 1) ──────────────────────────────
// Adds a sourced-data section for the enriched cathedral canton hubs
// (Zurigo, Berna, Basilea, + the national Svizzera aggregate). All figures
// come from real, already-vetted build-time sources — nothing here is
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
}

// Local escape helper. Matches the staticPagesPlugin / jobsSeoPages
// implementations so a shared move stays byte-identical.
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
  const { canton, locale, display, jobsCount, totalPages, archiveBaseHref } = opts;
  const isTi = canton === 'TI';
  const out: string[] = [];

  // TI claim: interpolate the live jobsCount like the non-TI branch does
  // (the hardcoded "oltre 1.500" contradicted the title's real count, e.g.
  // 5914, on the indexed hub). Falls back to the legacy fixed claim only
  // when the caller has no usable count (jobsCount <= 0).
  const tiJobsClaim = jobsCount > 0
    ? `<strong>${jobsCount.toLocaleString('de-CH')}</strong>`
    : 'oltre 1.500';
  const tiFaqJobsClaim = jobsCount > 0 ? jobsCount.toLocaleString('de-CH') : 'oltre 1.500';

  // ── 1. H2 + intro paragraph (definition block for AI extraction) ────────
  if (isTi) {
    // Legacy TI strings (Italian). Other locales served the same Italian
    // filler historically — preserved even though it is not idiomatic for
    // EN/DE/FR pages. The job count is the only live interpolation.
    out.push(
      `<h2 class="s-o3IET6">Offerte di Lavoro in Ticino — Bacheca Lavoro per Frontalieri</h2>`,
      `<p class="s-6g7z41">Cerchi <strong>lavoro in Ticino</strong>? Questa bacheca raccoglie ${tiJobsClaim} <strong>offerte di lavoro</strong> attive da più di 100 aziende del Canton Ticino, aggiornate ogni 12 ore. Le posizioni coprono tutti i principali settori — banca, pharma, IT, edilizia, sanità, logistica — e sono disponibili in italiano, inglese, tedesco e francese. Ogni annuncio è collegato direttamente al sito ufficiale dell’azienda per la candidatura.</p>`,
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
  // Page-weight guard: for very long archives (e.g. TI with ~400 pages)
  // emitting one anchor per page-N pushed the IT root over the 200 KB
  // audit:page-weight budget (~93 KB just for this nav). Crawler reach
  // is preserved by the sequential prev/next/first/last links emitted on
  // every `/tutti/page-N/` page itself, so we only need head+tail anchors
  // here. We render pages 1..PAGINATOR_HEAD + last PAGINATOR_TAIL pages
  // with a non-link ellipsis between them. For small archives
  // (totalPages <= PAGINATOR_HEAD + PAGINATOR_TAIL) we still emit every
  // page — byte-identical to the legacy output for cathedral cantons
  // (which all have small page counts).
  if (totalPages > 1) {
    const jobsNavLabel = locale === 'it' ? 'Sfoglia tutto l\'archivio offerte per pagina'
      : locale === 'en' ? 'Browse the full job archive by page'
      : locale === 'de' ? 'Vollständiges Stellenarchiv nach Seite durchsuchen'
      : 'Parcourir toutes les offres par page';
    const jobsPageWord = locale === 'it' ? 'Pagina' : locale === 'en' ? 'Page' : locale === 'de' ? 'Seite' : 'Page';
    const PAGINATOR_HEAD = 20;
    const PAGINATOR_TAIL = 5;
    const anchorFor = (p: number): string => {
      const href = paginatedPath(archiveBaseHref, p);
      return `<a class="s-040ZNE" href="${href}">${jobsPageWord}&nbsp;${p}</a>`;
    };
    const jobsAnchors: string[] = [];
    if (totalPages <= PAGINATOR_HEAD + PAGINATOR_TAIL) {
      for (let p = 1; p <= totalPages; p++) jobsAnchors.push(anchorFor(p));
    } else {
      for (let p = 1; p <= PAGINATOR_HEAD; p++) jobsAnchors.push(anchorFor(p));
      jobsAnchors.push('<span class="s-NG7ZI_" aria-hidden="true">…</span>');
      for (let p = totalPages - PAGINATOR_TAIL + 1; p <= totalPages; p++) jobsAnchors.push(anchorFor(p));
    }
    out.push(
      `<details class="s-01GpQM"><summary class="s-hQKogV">${esc(jobsNavLabel)} (${totalPages} pagine)</summary><nav class="s-SMVope" aria-label="${esc(jobsNavLabel)}">${jobsAnchors.join('')}</nav></details>`,
    );
  }

  // ── 3. Frontaliere context prose (4 paragraphs) + sources line ────────
  // TODO: per-canton commuter prose (Phase 9). The TI variant references
  // Lugano/Bellinzona/Locarno/Mendrisio and the Como/Varese crossings;
  // non-TI cantons get a canton-agnostic variant that name-drops `display`
  // and otherwise sticks to generic G-permit + filter-tool messaging.
  if (isTi) {
    out.push(
      `La sezione <strong>offerte lavoro Ticino</strong> raccoglie annunci pubblicati su fonti aziendali ufficiali, con normalizzazione dei dati principali per facilitare il confronto tra ruolo, sede, contratto e coerenza con il proprio profilo professionale. Gli annunci provengono da oltre 100 aziende ticinesi monitorate quotidianamente da crawler dedicati.`,
      `Per ogni posizione vengono mantenuti metadati utili alla valutazione: data di pubblicazione, azienda, località, requisiti richiesti e collegamento diretto alla candidatura sul sito originale del datore di lavoro. Le offerte sono filtrate per il Canton Ticino e vengono aggiornate ogni 12 ore.`,
      `I frontalieri con permesso G hanno diritto a candidarsi a posizioni in tutta la Svizzera; la guida inclusa nella sezione lavoro spiega la procedura per richiedere un permesso di lavoro, i settori con maggiore domanda e i salari mediani per categoria professionale nel mercato del lavoro ticinese.`,
      `Il motore di ricerca integrato permette di filtrare per settore, tipo di contratto (tempo indeterminato, determinato, part-time), località e data di pubblicazione. La funzione di allerta e-mail notifica automaticamente le nuove offerte che corrispondono ai criteri salvati, così non si perde nessuna opportunità.`,
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
      `<p class="s-F2hp6o"><strong>Quante offerte di lavoro sono disponibili?</strong> La sezione lavoro Ticino raccoglie ${tiFaqJobsClaim} offerte attive da più di 100 aziende ticinesi, aggiornate ogni 12 ore tramite crawler automatici che monitorano i siti ufficiali delle aziende.</p>` +
      `<p class="s-F2hp6o"><strong>Come posso cercare lavoro in Ticino come frontaliere?</strong> Usa il motore di ricerca integrato per filtrare le posizioni per settore (banca, pharma, IT, edilizia, sanità), tipo di contratto (tempo indeterminato, determinato, part-time), località (Lugano, Bellinzona, Locarno, Mendrisio) e data di pubblicazione. Ogni annuncio include il collegamento diretto alla candidatura sul sito aziendale.</p>` +
      `<p class="s-F2hp6o"><strong>Serve il permesso G per candidarsi?</strong> I frontalieri con permesso G (Grenzgängerbewilligung) possono candidarsi a qualsiasi posizione in Svizzera. Il permesso viene richiesto dal datore di lavoro dopo l'assunzione. Per i dettagli, consulta la <a class="s-676LjN" href="/guida-frontaliere/permessi-di-lavoro/">guida permessi di lavoro</a>.</p>` +
      `<p class="s-F2hp6o"><strong>Quali sono i settori con più domanda in Ticino?</strong> I settori con maggiore domanda per frontalieri nel 2026 sono: servizi finanziari e bancari, farmaceutico e chimico, IT e software, edilizia e impiantistica, sanità e assistenza, ristorazione e turismo, logistica e trasporti.</p>` +
      `<p class="s-F2hp6o"><strong>Qual è lo stipendio medio per un frontaliere in Ticino?</strong> Lo stipendio mediano lordo in Canton Ticino è di circa CHF 62.000-68.000 annui, variabile per settore: IT/Software CHF 95.000, Banca/Finanza CHF 110.000, Pharma CHF 105.000, Commercio CHF 55.000. Usa il <a class="s-676LjN" href="/calcola-stipendio/">simulatore fiscale</a> per calcolare il netto.</p>` +
      `<p class="s-F2hp6o"><strong>Come attivare le notifiche per nuove offerte?</strong> Imposta i tuoi criteri di ricerca (settore, località, parole chiave) e attiva le allerte e-mail: riceverai una notifica automatica quando vengono pubblicate nuove posizioni corrispondenti.</p>` +
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
  it: { salary: 'Salari mediani per professione', cost: 'Costo della vita vs Ticino', permit: 'Permesso G e zona di confine', employers: 'Aziende che assumono' },
  en: { salary: 'Median salary by profession', cost: 'Cost of living vs Ticino', permit: 'G permit and border zone', employers: 'Companies hiring' },
  de: { salary: 'Medianlohn nach Beruf', cost: 'Lebenshaltungskosten vs. Tessin', permit: 'G-Bewilligung und Grenzzone', employers: 'Unternehmen, die einstellen' },
  fr: { salary: 'Salaire médian par profession', cost: 'Coût de la vie vs Tessin', permit: 'Permis G et zone frontalière', employers: 'Entreprises qui recrutent' },
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

/** G-permit / border-zone paragraph. Deliberately does NOT reuse the existing generic 20km-Italy prose (that already runs on every non-TI canton hub, see buildCantonContextProse) — this adds canton-specific context instead. No fabricated km figures for non-Italy borders: only the real BORDER_CANTONS classification already used elsewhere in cantonSalaryIndex.ts. */
function gPermitParagraph(locale: ArchiveHubLocale, display: string, isAggregate: boolean, isBorderCanton: boolean): string {
  const copy: Record<ArchiveHubLocale, { aggregate: string; border: string; interior: string }> = {
    it: {
      aggregate: `Il permesso G per frontalieri è riservato a chi risiede in un Comune di confine di un Paese limitrofo alla Svizzera e rientra quotidianamente al domicilio: per i residenti in Italia questo vale soprattutto per Ticino, Grigioni e Vallese. Per le offerte in cantoni più lontani dal confine italiano — come quelle di questo elenco — la soluzione più comune è un permesso B (dimorante) o il trasferimento della residenza in Svizzera.`,
      border: `${display} confina con Germania e Francia, non con l'Italia: il permesso G frontaliere qui è tipicamente rilasciato a residenti tedeschi o francesi delle zone di confine. Chi vive in Italia e valuta un'offerta a ${display} normalmente opta per un permesso B (dimorante) piuttosto che lo status di frontaliere, riservato a chi risiede in un Comune di confine del Paese limitrofo.`,
      interior: `Il permesso G per frontalieri richiede la residenza in un Comune di confine di un Paese limitrofo alla Svizzera e il rientro quotidiano al domicilio. ${display} non confina con l'Italia: chi vive in Italia e valuta un'offerta qui affronta un tragitto quotidiano molto più lungo rispetto al Ticino e in pratica opta per un permesso B (dimorante) o il trasferimento della residenza in Svizzera, non lo status di frontaliere.`,
    },
    en: {
      aggregate: `The G cross-border permit is reserved for residents of a border municipality in a country neighbouring Switzerland who return home daily: for Italian residents that mainly means Ticino, Graubünden and Valais. For roles in cantons farther from the Italian border — like the ones listed here — the common path is a B residence permit or relocating to Switzerland.`,
      border: `${display} borders Germany and France, not Italy: the G permit here is typically issued to German or French residents of the border zone. Italian residents considering a role in ${display} usually apply for a B residence permit instead of cross-border-commuter status, which is reserved for residents of a border municipality in the neighbouring country.`,
      interior: `The G cross-border permit requires residency in a border municipality of a country neighbouring Switzerland and a daily return home. ${display} does not border Italy: Italian residents considering a role here face a much longer commute than in Ticino and in practice opt for a B residence permit or relocation to Switzerland, not cross-border-commuter status.`,
    },
    de: {
      aggregate: `Die G-Grenzgängerbewilligung ist Bewohnern einer Grenzgemeinde eines Nachbarlands vorbehalten, die täglich heimkehren: für Personen aus Italien betrifft das vor allem Tessin, Graubünden und Wallis. Für Stellen in weiter von der italienischen Grenze entfernten Kantonen — wie in dieser Liste — ist eine B-Bewilligung oder der Wohnsitzwechsel in die Schweiz der übliche Weg.`,
      border: `${display} grenzt an Deutschland und Frankreich, nicht an Italien: Die G-Bewilligung wird hier meist an deutsche oder französische Bewohner der Grenzzone vergeben. Wer in Italien wohnt und eine Stelle in ${display} prüft, beantragt üblicherweise eine B-Bewilligung statt des Grenzgängerstatus, der Bewohnern einer Grenzgemeinde im Nachbarland vorbehalten ist.`,
      interior: `Die G-Grenzgängerbewilligung setzt Wohnsitz in einer Grenzgemeinde eines Nachbarlands der Schweiz sowie tägliche Heimkehr voraus. ${display} grenzt nicht an Italien: Wer in Italien wohnt und eine Stelle hier prüft, hat einen deutlich längeren Arbeitsweg als im Tessin und wählt in der Praxis eine B-Bewilligung oder den Wohnsitzwechsel in die Schweiz statt des Grenzgängerstatus.`,
    },
    fr: {
      aggregate: `Le permis frontalier G est réservé aux résidents d'une commune frontalière d'un pays voisin qui rentrent chaque jour: pour les résidents italiens, cela concerne surtout le Tessin, les Grisons et le Valais. Pour les postes dans des cantons plus éloignés de la frontière italienne — comme ceux listés ici — la voie courante est un permis B ou un transfert de domicile en Suisse.`,
      border: `${display} touche l'Allemagne et la France, pas l'Italie: le permis G y est généralement délivré à des résidents allemands ou français de la zone frontalière. Qui réside en Italie et envisage un poste à ${display} opte en général pour un permis B plutôt que le statut de frontalier, réservé aux résidents d'une commune frontalière du pays voisin.`,
      interior: `Le permis frontalier G exige une résidence dans une commune frontalière d'un pays voisin de la Suisse et un retour quotidien au domicile. ${display} ne touche pas l'Italie: qui réside en Italie et envisage un poste ici affronte un trajet bien plus long qu'au Tessin et opte en pratique pour un permis B (séjour) ou un transfert de domicile en Suisse, pas le statut de frontalier.`,
    },
  };
  const t = copy[locale] || copy.it;
  return isAggregate ? t.aggregate : isBorderCanton ? t.border : t.interior;
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
  const { locale, display, isAggregate, sectorRows, wageFactorVsTicino, lamalMonthlyChf, lamalMonthlyTicinoChf, isBorderCanton, employers } = opts;
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
  parts.push(`<p class="s-L9sOKI">${gPermitParagraph(locale, display, isAggregate, isBorderCanton)}</p>`);

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
