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

// Strip residual markdown markers (`**bold**`, `*em*`, leading `#+`, mid-string
// `[_=~]{3,}` separator runs) before HTML-escaping into <li class="chip">. The
// chip renderer feeds `canonicalLocale.highlights` / `canonicalKeywords` (often
// produced by the fallback splitter at services/jobs/canonicalFallback.ts, which
// preserves source `**bold**` markers verbatim) through `esc()` only — so
// `**Flexible Arbeitszeiten**` survived as literal text and tripped
// audit:no-literal-markdown (166 offenders in validate-dist run 26316291019,
// pattern observed: Axpo benefit chips + Casale SA `** e **` + Fonte
// `**luglio 2026**`). Markers don't render as bold inside chips anyway — they
// just leak as visible asterisks — so unwrap to plain text.
function stripChipMarkdown(value: string): string {
  return String(value || '')
    .replace(/\*\*([^*\n]+?)\*\*/g, '$1')
    .replace(/\*([^*\n]+?)\*/g, '$1')
    .replace(/^#+\s*/, '')
    .replace(/[_=~]{3,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function renderHighlightsChips(ctx: HighlightsChipsContext): string {
  const { locale, canonicalLocale, canonicalKeywords, esc } = ctx;
  const rawHighlights = Array.isArray(
    (canonicalLocale as { highlights?: unknown })?.highlights,
  )
    ? ((canonicalLocale as { highlights?: unknown[] }).highlights as unknown[])
        .map((h) => stripChipMarkdown(String(h ?? '')))
        .filter((h) => h.length > 0)
    : [];
  const source = rawHighlights.length > 0
    ? rawHighlights
    : canonicalKeywords.map((c) => stripChipMarkdown(String(c))).filter((c) => c.length > 0);
  const chips = source.slice(0, 6);
  if (chips.length === 0) return '';
  const items = chips
    .map((c) => `<li class="chip">${esc(String(c))}</li>`)
    .join('');
  return `<ul class="highlights" aria-label="${esc(ARIA_LABEL[locale])}">${items}</ul>`;
}
