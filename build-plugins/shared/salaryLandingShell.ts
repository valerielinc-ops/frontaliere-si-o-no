/**
 * Render the mobile-first body for `/calcola-stipendio/*` SEO landings.
 *
 * Replaces the legacy "default" wrapper used by `staticPagesPlugin` for every
 * calculator-style page (`/calcola-stipendio/`, `/calculate-salary/`, etc).
 *
 * Structure mirrors the SEO-landing UI/UX template in CLAUDE.md rule 17:
 *
 *   1. breadcrumb           → `renderBreadcrumb`
 *   2. eyebrow + H1         → `HERO_EYEBROW_STYLE`, `H1_STYLE`
 *   3. lede tagline ≤120c   → `LEDE_STYLE`
 *   4. stat tile grid       → `renderStatGrid`
 *   5. "consiglio" banner   → `STAT_TILE_WARNING`
 *   6. primary CTA          → `CTA_PRIMARY_STYLE` (above mobile fold)
 *   7. comparative table    → `TABLE_*_STYLE`
 *   8. FAQ (collapsed)      → `<details>`
 *   9. long prose at bottom → `editorialHtml`
 *
 * No `dark:` prefixes, no inline hex — every color binds to an OKLCH
 * semantic token defined in `index.css`. Tailwind purges class names from
 * this file scope so inline styles are intentional (see `seoContentTokens`
 * header comment).
 */

import {
  H1_STYLE,
  HERO_EYEBROW_STYLE,
  LEDE_STYLE,
  CTA_PRIMARY_STYLE,
  STAT_TILE_WARNING,
  TABLE_STYLE,
  TABLE_HEAD_STYLE,
  TABLE_CELL_STYLE,
  LINK_ACCENT_STYLE,
  SMALL_HEADING_STYLE,
  esc,
  renderBreadcrumb,
  renderStatGrid,
  type StatTileTone,
} from './seoContentTokens';

export interface SalaryTile {
  readonly label: string;
  readonly value: string;
  readonly tone?: StatTileTone;
}

export interface SalaryTableRow {
  readonly cells: ReadonlyArray<string>;
  /** When true, the row is highlighted (used for the "delta" / takeaway row). */
  readonly emphasized?: boolean;
}

export interface SalaryTable {
  readonly caption: string;
  readonly headers: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<SalaryTableRow>;
  /** Short footnote shown under the table (e.g. fonti, anno aliquote). */
  readonly footnote?: string;
}

export interface SalaryFaqItem {
  readonly q: string;
  readonly a: string;
}

export interface SalaryLandingData {
  readonly eyebrow: string;
  /** ≤120 chars; rendered as the lede tagline under the H1. */
  readonly tagline: string;
  readonly tiles: ReadonlyArray<SalaryTile>;
  /** Short 1-2 sentence interpretation of the tiles. */
  readonly advice?: string;
  readonly ctaPrimary: { label: string; href: string };
  readonly ctaSecondary?: { label: string; href: string };
  readonly table?: SalaryTable;
  readonly faqs?: ReadonlyArray<SalaryFaqItem>;
}

/**
 * Per-canonical-path overrides. Paths NOT in this map fall back to
 * `DEFAULT_SALARY_LANDING_DATA` — that default is intentionally generic and
 * holds for every salary scenario (tax rules apply uniformly).
 */
const SALARY_LANDING_DATA: Record<string, SalaryLandingData> = {
  '/calcola-stipendio/nuovi-frontalieri-oltre-20-km': {
    eyebrow: 'Nuovo Accordo 2024 · Oltre 20 km',
    tagline:
      'Tassazione concorrente: la Svizzera trattiene il 100%, poi l\'Italia ricalcola con credito d\'imposta.',
    tiles: [
      { label: 'Imposta alla fonte CH', value: '100%', tone: 'accent' },
      { label: 'Quota ai comuni IT', value: '0%', tone: 'danger' },
      { label: 'Carico fiscale extra', value: '+2-4k EUR/anno', tone: 'warning' },
      { label: 'Da quando', value: 'dal 17.07.2023', tone: 'neutral' },
    ],
    advice:
      'Su una RAL di CHF 70.000, la residenza oltre 20 km (es. Milano) costa circa 3.000 EUR/anno in più rispetto a una entro 20 km (es. Como), a parità di stipendio.',
    ctaPrimary: { label: 'Calcola il tuo netto', href: '/calcola-stipendio/' },
    ctaSecondary: {
      label: 'Confronta scenari entro vs oltre 20 km',
      href: '/calcola-stipendio/cosa-cambia-se/',
    },
    table: {
      caption: 'Differenza netto annuo: entro 20 km vs oltre 20 km (stato civile A0N, Ticino)',
      headers: ['RAL (CHF)', 'Netto entro 20 km', 'Netto oltre 20 km', 'Δ EUR/anno'],
      rows: [
        { cells: ['60.000', '~46.000 EUR', '~44.500 EUR', '-1.500'] },
        { cells: ['80.000', '~58.000 EUR', '~55.000 EUR', '-3.000'], emphasized: true },
        { cells: ['100.000', '~70.000 EUR', '~66.000 EUR', '-4.200'] },
      ],
      footnote:
        'Stime indicative basate su tabelle Canton Ticino 2026 + IRPEF italiana con franchigia 10.000 EUR. Cambio CHF/EUR del giorno. Per il tuo caso usa il simulatore.',
    },
    faqs: [
      {
        q: 'Chi rientra tra i nuovi frontalieri oltre 20 km?',
        a: 'Chi ha iniziato il rapporto di lavoro transfrontaliero dal 17 luglio 2023 in poi e risiede in un comune italiano oltre 20 km dalla frontiera svizzera.',
      },
      {
        q: 'Cosa cambia rispetto a chi vive entro 20 km?',
        a: 'Per i nuovi frontalieri oltre 20 km la Svizzera trattiene il 100% dell\'imposta alla fonte. Entro 20 km la Svizzera trattiene l\'80% e l\'Italia tassa il reddito con credito per le imposte già pagate.',
      },
      {
        q: 'Questa pagina sostituisce la consulenza fiscale?',
        a: 'No. Aiuta a capire scenari e ordini di grandezza, ma per casi particolari resta consigliabile una verifica con un professionista fiscale specializzato in frontalieri.',
      },
    ],
  },
};

const DEFAULT_SALARY_LANDING_DATA: SalaryLandingData = {
  eyebrow: 'Simulatore frontaliere · Ticino 2026',
  tagline:
    'Calcola il netto reale con tabelle Canton Ticino 2026, IRPEF italiana e franchigia 10.000 EUR.',
  tiles: [
    { label: 'Aliquote', value: 'Ticino 2026', tone: 'accent' },
    { label: 'Franchigia IT', value: 'EUR 10.000', tone: 'success' },
    { label: 'Cambio', value: 'CHF/EUR del giorno', tone: 'neutral' },
    { label: 'Tabelle fonte', value: 'A · B · C · H', tone: 'neutral' },
  ],
  ctaPrimary: { label: 'Apri il simulatore', href: '/calcola-stipendio/' },
  ctaSecondary: {
    label: 'Cosa cambia se… (what-if)',
    href: '/calcola-stipendio/cosa-cambia-se/',
  },
};

export function getSalaryLandingData(canonicalPath: string): SalaryLandingData {
  const stripped = canonicalPath.replace(/\/+$/, '');
  return SALARY_LANDING_DATA[stripped] ?? DEFAULT_SALARY_LANDING_DATA;
}

// ── Renderers ────────────────────────────────────────────────────────────────

function renderAdvice(text: string): string {
  return `<aside data-salary-advice style="${STAT_TILE_WARNING};margin:0 0 18px"><p style="${SMALL_HEADING_STYLE};margin:0 0 6px">Consiglio</p><p style="margin:0;color:var(--color-heading);line-height:1.55;font-size:15px">${esc(text)}</p></aside>`;
}

function renderCtaBlock(
  primary: SalaryLandingData['ctaPrimary'],
  secondary: SalaryLandingData['ctaSecondary'],
): string {
  const secondaryHtml = secondary
    ? `<a href="${esc(secondary.href)}" style="${LINK_ACCENT_STYLE};font-weight:600;font-size:15px;align-self:center">${esc(secondary.label)} →</a>`
    : '';
  return `<div style="display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin:0 0 28px"><a href="${esc(primary.href)}" style="${CTA_PRIMARY_STYLE}">${esc(primary.label)} →</a>${secondaryHtml}</div>`;
}

function renderTable(table: SalaryTable): string {
  const headCells = table.headers
    .map((h) => `<th scope="col" style="${TABLE_HEAD_STYLE}">${esc(h)}</th>`)
    .join('');
  const bodyRows = table.rows
    .map((row) => {
      const rowStyle = row.emphasized
        ? 'background:var(--color-accent-subtle)'
        : '';
      const cells = row.cells
        .map(
          (c, i) =>
            `<td style="${TABLE_CELL_STYLE}${i === row.cells.length - 1 ? ';font-weight:700;color:var(--color-heading)' : ''}">${esc(c)}</td>`,
        )
        .join('');
      return `<tr style="${rowStyle}">${cells}</tr>`;
    })
    .join('');
  const footnote = table.footnote
    ? `<p style="margin:8px 0 0;font-size:12px;color:var(--color-subtle);line-height:1.5">${esc(table.footnote)}</p>`
    : '';
  return `<section style="margin:0 0 28px" aria-labelledby="salary-table-caption"><p id="salary-table-caption" style="${SMALL_HEADING_STYLE};margin:0 0 10px">${esc(table.caption)}</p><div style="overflow-x:auto;-webkit-overflow-scrolling:touch"><table style="${TABLE_STYLE}"><thead><tr>${headCells}</tr></thead><tbody>${bodyRows}</tbody></table></div>${footnote}</section>`;
}

function renderFaqs(faqs: ReadonlyArray<SalaryFaqItem>): string {
  if (!faqs.length) return '';
  const items = faqs
    .map(
      (f) =>
        `<details style="border-top:1px solid var(--color-edge);padding:14px 0"><summary style="cursor:pointer;font-weight:600;color:var(--color-heading);font-size:15px;line-height:1.4;list-style:none">${esc(f.q)}</summary><p style="margin:10px 0 0;color:var(--color-body);line-height:1.6;font-size:15px">${esc(f.a)}</p></details>`,
    )
    .join('');
  return `<section style="margin:0 0 28px"><p style="${SMALL_HEADING_STYLE};margin:0 0 4px">Domande frequenti</p>${items}</section>`;
}

export interface BuildSalaryLandingArgs {
  readonly canonicalPath: string;
  readonly h1Text: string;
  readonly seoDesc: string;
  readonly editorialHtml: string;
  readonly navHtml: string;
}

export function buildSalaryLandingBody(args: BuildSalaryLandingArgs): string {
  const data = getSalaryLandingData(args.canonicalPath);

  const breadcrumb = renderBreadcrumb([
    { label: 'Home', href: '/' },
    { label: 'Calcola stipendio', href: '/calcola-stipendio/' },
    { label: args.h1Text },
  ]);

  const eyebrow = `<p style="${HERO_EYEBROW_STYLE}">${esc(data.eyebrow)}</p>`;
  const h1 = `<h1 style="${H1_STYLE}">${esc(args.h1Text)}</h1>`;
  const lede = `<p style="${LEDE_STYLE}">${esc(data.tagline)}</p>`;

  const tilesHtml = renderStatGrid(data.tiles);
  const adviceHtml = data.advice ? renderAdvice(data.advice) : '';
  const ctaHtml = renderCtaBlock(data.ctaPrimary, data.ctaSecondary);
  const tableHtml = data.table ? renderTable(data.table) : '';
  const faqsHtml = data.faqs ? renderFaqs(data.faqs) : '';

  // Long prose lives at the bottom — preserves text-to-HTML ratio without
  // pushing the data area below the mobile fold (CLAUDE.md rule 16).
  const prose = args.editorialHtml
    ? `<section style="margin:32px 0 0;border-top:1px solid var(--color-edge);padding-top:24px">${args.editorialHtml}</section>`
    : '';

  return `<div style="max-width:64rem;margin:0 auto;padding:16px 16px 32px">${breadcrumb}<header style="margin:0 0 20px">${eyebrow}${h1}${lede}</header>${tilesHtml}${adviceHtml}${ctaHtml}${tableHtml}${faqsHtml}${prose}<nav aria-label="Sito" style="margin-top:32px;padding-top:20px;border-top:1px solid var(--color-edge);font-size:13px;color:var(--color-subtle);line-height:1.9">${args.navHtml}</nav></div>`;
}
