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
 * **TI byte-identity contract.** When called with `{canton: 'TI', display:
 * 'Ticino', locale: 'it', ...}`, this helper emits the exact same set of
 * strings that `staticPagesPlugin.ts` previously inlined for its TI
 * `isJobsIndex` branch — same characters, same order, same array length.
 * The `cathedral-canton-hub-parity.test.ts` snapshot test enforces this
 * invariance. The TI canton navigator (`<details>` listing every other
 * canton) is intentionally NOT part of this helper because it is unique
 * to the TI hub; it stays inline in `staticPagesPlugin.ts`.
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

  // ── 1. H2 + intro paragraph (definition block for AI extraction) ────────
  if (isTi) {
    // Byte-identical TI strings (Italian). Other locales served the same
    // Italian filler historically — preserved for byte-identity even though
    // it is not idiomatic for EN/DE/FR pages.
    out.push(
      `<h2 style="font-size:1.05rem;font-weight:700;margin:1rem 0 .5rem">Offerte di Lavoro in Ticino — Bacheca Lavoro per Frontalieri</h2>`,
      `<p style="margin:.5rem 0;font-weight:500;font-size:1rem;line-height:1.7">Cerchi <strong>lavoro in Ticino</strong>? Questa bacheca raccoglie oltre 1.500 <strong>offerte di lavoro</strong> attive da più di 100 aziende del Canton Ticino, aggiornate ogni 12 ore. Le posizioni coprono tutti i principali settori — banca, pharma, IT, edilizia, sanità, logistica — e sono disponibili in italiano, inglese, tedesco e francese. Ogni annuncio è collegato direttamente al sito ufficiale dell’azienda per la candidatura.</p>`,
    );
  } else {
    // Canton-agnostic intro. Uses `display` so it reads naturally for
    // ZH/GE/VD/etc. and avoids any TI-specific city or border-crossing
    // reference (those are Phase 9 follow-up).
    out.push(
      `<h2 style="font-size:1.05rem;font-weight:700;margin:1rem 0 .5rem">${esc(`Offerte di Lavoro ${display === 'Svizzera' ? 'in Svizzera' : `nel Canton ${display}`} — Bacheca Lavoro per Frontalieri`)}</h2>`,
      `<p style="margin:.5rem 0;font-weight:500;font-size:1rem;line-height:1.7">${esc(`Cerchi lavoro ${display === 'Svizzera' ? 'in Svizzera' : `nel Canton ${display}`}?`)} Questa bacheca raccoglie <strong>${jobsCount.toLocaleString('de-CH')}</strong> <strong>offerte di lavoro</strong> ${display === 'Svizzera' ? 'attive in tutta la Svizzera' : `attive nel Canton ${esc(display)}`}, aggiornate ogni 12 ore. Le posizioni coprono tutti i principali settori — banca, pharma, IT, edilizia, sanità, logistica — e sono disponibili in italiano, inglese, tedesco e francese. Ogni annuncio è collegato direttamente al sito ufficiale dell’azienda per la candidatura.</p>`,
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
      return `<a href="${href}" style="display:inline-block;padding:3px 8px;margin:1px;border-radius:4px;background:#f1f5f9;color:#1e293b;text-decoration:none;font-size:12px;border:1px solid #e2e8f0">${jobsPageWord}&nbsp;${p}</a>`;
    };
    const jobsAnchors: string[] = [];
    if (totalPages <= PAGINATOR_HEAD + PAGINATOR_TAIL) {
      for (let p = 1; p <= totalPages; p++) jobsAnchors.push(anchorFor(p));
    } else {
      for (let p = 1; p <= PAGINATOR_HEAD; p++) jobsAnchors.push(anchorFor(p));
      jobsAnchors.push('<span aria-hidden="true" style="display:inline-block;padding:3px 4px;margin:1px;font-size:12px;color:#64748b">…</span>');
      for (let p = totalPages - PAGINATOR_TAIL + 1; p <= totalPages; p++) jobsAnchors.push(anchorFor(p));
    }
    out.push(
      `<details style="margin:.75rem 0;border:1px solid #e2e8f0;border-radius:8px;padding:.5rem .75rem"><summary style="cursor:pointer;font-weight:600;font-size:.95rem;color:#1e293b;padding:.25rem 0">${esc(jobsNavLabel)} (${totalPages} pagine)</summary><nav aria-label="${esc(jobsNavLabel)}" style="margin-top:.5rem;line-height:1.8">${jobsAnchors.join('')}</nav></details>`,
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
      `<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Fonte: <a href="https://www.seco.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">SECO - Segretariato di Stato dell'economia</a></p>`,
    );
  } else {
    const cantonOrCh = display === 'Svizzera' ? 'in Svizzera' : `nel Canton ${display}`;
    const cantonOrSwiss = display === 'Svizzera' ? 'svizzera' : `del Canton ${display}`;
    out.push(
      `La sezione <strong>offerte lavoro ${esc(cantonOrSwiss)}</strong> raccoglie annunci pubblicati su fonti aziendali ufficiali, con normalizzazione dei dati principali per facilitare il confronto tra ruolo, sede, contratto e coerenza con il proprio profilo professionale. Gli annunci provengono da aziende ${esc(cantonOrSwiss)} monitorate quotidianamente da crawler dedicati.`,
      `Per ogni posizione vengono mantenuti metadati utili alla valutazione: data di pubblicazione, azienda, località, requisiti richiesti e collegamento diretto alla candidatura sul sito originale del datore di lavoro. Le offerte sono filtrate ${esc(cantonOrCh)} e vengono aggiornate ogni 12 ore.`,
      `I frontalieri con permesso G hanno diritto a candidarsi a posizioni in tutta la Svizzera; la guida inclusa nella sezione lavoro spiega la procedura per richiedere un permesso di lavoro, i settori con maggiore domanda e i salari mediani per categoria professionale nel mercato del lavoro ${esc(cantonOrSwiss)}.`,
      `Il motore di ricerca integrato permette di filtrare per settore, tipo di contratto (tempo indeterminato, determinato, part-time), località e data di pubblicazione. La funzione di allerta e-mail notifica automaticamente le nuove offerte che corrispondono ai criteri salvati, così non si perde nessuna opportunità.`,
      `<p style="color:#64748b;font-size:0.8rem;margin-top:4px;">Fonte: <a href="https://www.seco.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">SECO - Segretariato di Stato dell'economia</a></p>`,
    );
  }

  // ── 4. FAQ block (collapsible, AI-extractable) ────────────────────────
  if (isTi) {
    out.push(
      `<details style="margin:.75rem 0;border:1px solid #e2e8f0;border-radius:8px;padding:.5rem .75rem"><summary style="cursor:pointer;font-weight:700;font-size:1rem;color:#1e293b;padding:.25rem 0">Domande frequenti sulla ricerca lavoro in Ticino</summary><div style="margin-top:.5rem">` +
      `<p style="margin:.5rem 0"><strong>Quante offerte di lavoro sono disponibili?</strong> La sezione lavoro Ticino raccoglie oltre 1.500 offerte attive da più di 100 aziende ticinesi, aggiornate ogni 12 ore tramite crawler automatici che monitorano i siti ufficiali delle aziende.</p>` +
      `<p style="margin:.5rem 0"><strong>Come posso cercare lavoro in Ticino come frontaliere?</strong> Usa il motore di ricerca integrato per filtrare le posizioni per settore (banca, pharma, IT, edilizia, sanità), tipo di contratto (tempo indeterminato, determinato, part-time), località (Lugano, Bellinzona, Locarno, Mendrisio) e data di pubblicazione. Ogni annuncio include il collegamento diretto alla candidatura sul sito aziendale.</p>` +
      `<p style="margin:.5rem 0"><strong>Serve il permesso G per candidarsi?</strong> I frontalieri con permesso G (Grenzgängerbewilligung) possono candidarsi a qualsiasi posizione in Svizzera. Il permesso viene richiesto dal datore di lavoro dopo l'assunzione. Per i dettagli, consulta la <a href="/guida-frontaliere/permessi-di-lavoro/" style="color:#2563eb;text-decoration:none;">guida permessi di lavoro</a>.</p>` +
      `<p style="margin:.5rem 0"><strong>Quali sono i settori con più domanda in Ticino?</strong> I settori con maggiore domanda per frontalieri nel 2026 sono: servizi finanziari e bancari, farmaceutico e chimico, IT e software, edilizia e impiantistica, sanità e assistenza, ristorazione e turismo, logistica e trasporti.</p>` +
      `<p style="margin:.5rem 0"><strong>Qual è lo stipendio medio per un frontaliere in Ticino?</strong> Lo stipendio mediano lordo in Canton Ticino è di circa CHF 62.000-68.000 annui, variabile per settore: IT/Software CHF 95.000, Banca/Finanza CHF 110.000, Pharma CHF 105.000, Commercio CHF 55.000. Usa il <a href="/calcola-stipendio/" style="color:#2563eb;text-decoration:none;">simulatore fiscale</a> per calcolare il netto.</p>` +
      `<p style="margin:.5rem 0"><strong>Come attivare le notifiche per nuove offerte?</strong> Imposta i tuoi criteri di ricerca (settore, località, parole chiave) e attiva le allerte e-mail: riceverai una notifica automatica quando vengono pubblicate nuove posizioni corrispondenti.</p>` +
      `<p style="color:#64748b;font-size:0.8rem;margin-top:.5rem;">Fonte: <a href="https://www.bfs.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">UST/BFS</a> · <a href="https://www.seco.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">SECO</a> · Dati Frontaliere Ticino</p>` +
      `</div></details>`,
    );
  } else {
    const cantonOrCh = display === 'Svizzera' ? 'in Svizzera' : `nel Canton ${display}`;
    const summary = `Domande frequenti sulla ricerca lavoro ${cantonOrCh}`;
    out.push(
      `<details style="margin:.75rem 0;border:1px solid #e2e8f0;border-radius:8px;padding:.5rem .75rem"><summary style="cursor:pointer;font-weight:700;font-size:1rem;color:#1e293b;padding:.25rem 0">${esc(summary)}</summary><div style="margin-top:.5rem">` +
      `<p style="margin:.5rem 0"><strong>${esc(`Quante offerte di lavoro sono disponibili ${cantonOrCh}?`)}</strong> ${esc(`La sezione lavoro ${cantonOrCh} raccoglie ${jobsCount.toLocaleString('de-CH')} offerte attive, aggiornate ogni 12 ore tramite crawler automatici che monitorano i siti ufficiali delle aziende.`)}</p>` +
      `<p style="margin:.5rem 0"><strong>${esc(`Come posso cercare lavoro ${cantonOrCh} come frontaliere?`)}</strong> Usa il motore di ricerca integrato per filtrare le posizioni per settore (banca, pharma, IT, edilizia, sanità), tipo di contratto (tempo indeterminato, determinato, part-time), località e data di pubblicazione. Ogni annuncio include il collegamento diretto alla candidatura sul sito aziendale.</p>` +
      `<p style="margin:.5rem 0"><strong>Serve il permesso G per candidarsi?</strong> I frontalieri con permesso G (Grenzgängerbewilligung) possono candidarsi a qualsiasi posizione in Svizzera. Il permesso viene richiesto dal datore di lavoro dopo l'assunzione. Per i dettagli, consulta la <a href="/guida-frontaliere/permessi-di-lavoro/" style="color:#2563eb;text-decoration:none;">guida permessi di lavoro</a>.</p>` +
      `<p style="margin:.5rem 0"><strong>${esc(`Quali sono i settori con più domanda ${cantonOrCh}?`)}</strong> I settori con maggiore domanda per frontalieri nel 2026 sono: servizi finanziari e bancari, farmaceutico e chimico, IT e software, edilizia e impiantistica, sanità e assistenza, ristorazione e turismo, logistica e trasporti.</p>` +
      `<p style="margin:.5rem 0"><strong>${esc(`Qual è lo stipendio medio per un frontaliere ${cantonOrCh}?`)}</strong> Lo stipendio mediano lordo svizzero è di circa CHF 78.000-85.000 annui, variabile per settore e cantone: IT/Software CHF 95.000+, Banca/Finanza CHF 110.000+, Pharma CHF 105.000+, Commercio CHF 55.000. Usa il <a href="/calcola-stipendio/" style="color:#2563eb;text-decoration:none;">simulatore fiscale</a> per calcolare il netto.</p>` +
      `<p style="margin:.5rem 0"><strong>Come attivare le notifiche per nuove offerte?</strong> Imposta i tuoi criteri di ricerca (settore, località, parole chiave) e attiva le allerte e-mail: riceverai una notifica automatica quando vengono pubblicate nuove posizioni corrispondenti.</p>` +
      `<p style="color:#64748b;font-size:0.8rem;margin-top:.5rem;">Fonte: <a href="https://www.bfs.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">UST/BFS</a> · <a href="https://www.seco.admin.ch" style="color:#2563eb;text-decoration:none;" rel="noopener">SECO</a> · Dati Frontaliere Ticino</p>` +
      `</div></details>`,
    );
  }

  return out;
}
