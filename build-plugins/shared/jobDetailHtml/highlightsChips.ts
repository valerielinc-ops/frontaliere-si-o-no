/**
 * Highlights chips row, emitted directly under the "Panoramica" section
 * of the static job-detail page. SPA-parity backport of the React
 * `<JobBoard>` highlights pill row.
 *
 * Source priority:
 *   1. `canonicalLocale.highlights` (AI-curated, 6 cap)
 *   2. `canonicalKeywords` (fallback, same cap)
 *
 * Returns '' when neither source yields any chips (no empty <ul>).
 *
 * SPA-parity regression coverage:
 *   tests/seo/static-job-page-spa-alignment.test.ts
 *   ("highlights chips below Panoramica")
 */
import type { JobDetailLocale, JobDetailRenderContext } from './context';

const ARIA_LABEL: Record<JobDetailLocale, string> = {
  it: 'Competenze chiave',
  en: 'Key skills',
  de: 'Schlüsselkompetenzen',
  fr: 'Compétences clés',
};

export type HighlightsChipsContext = Pick<
  JobDetailRenderContext,
  'locale' | 'canonicalLocale' | 'canonicalKeywords' | 'esc'
>;

export function renderHighlightsChips(ctx: HighlightsChipsContext): string {
  const { locale, canonicalLocale, canonicalKeywords, esc } = ctx;
  const rawHighlights = Array.isArray(
    (canonicalLocale as { highlights?: unknown })?.highlights,
  )
    ? ((canonicalLocale as { highlights?: unknown[] }).highlights as unknown[])
        .map((h) => String(h ?? '').trim())
        .filter((h) => h.length > 0)
    : [];
  const source = rawHighlights.length > 0 ? rawHighlights : canonicalKeywords;
  const chips = source.slice(0, 6);
  if (chips.length === 0) return '';
  const items = chips
    .map((c) => `<li class="chip">${esc(String(c))}</li>`)
    .join('');
  return `<ul class="highlights" aria-label="${esc(ARIA_LABEL[locale])}">${items}</ul>`;
}
