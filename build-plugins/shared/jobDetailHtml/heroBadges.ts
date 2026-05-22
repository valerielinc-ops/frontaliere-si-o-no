/**
 * Hero badges block (Featured ★ / "Nuovo" / salary pill) for the static
 * job-detail page. Mirrors the React `<JobBoard>` badge row so the
 * crawler-facing HTML stops looking visibly stale next to the hydrated
 * view. Each badge gates on its own signal — when all three are false
 * the emitter returns '' (no empty wrapper).
 *
 * SPA-parity regression coverage:
 *   tests/seo/static-job-page-spa-alignment.test.ts ("hero badges block")
 */
import type { JobDetailLocale, JobDetailRenderContext } from './context';

const FEATURED_LABEL: Record<JobDetailLocale, string> = {
  it: '★ In evidenza',
  en: '★ Featured',
  de: '★ Empfohlen',
  fr: '★ En vedette',
};

const NEW_LABEL: Record<JobDetailLocale, string> = {
  it: 'Nuovo',
  en: 'New',
  de: 'Neu',
  fr: 'Nouveau',
};

export type HeroBadgesContext = Pick<
  JobDetailRenderContext,
  'job' | 'locale' | 'salaryMin' | 'salaryText' | 'esc'
>;

export function renderHeroBadges(ctx: HeroBadgesContext): string {
  const { job, locale, salaryMin, salaryText, esc } = ctx;
  const isFeatured = job.featured === true;
  const isNew = (() => {
    const dateStr = String(job.postedDate ?? job.crawledAt ?? '');
    if (!dateStr) return false;
    const t = new Date(dateStr).getTime();
    if (!Number.isFinite(t)) return false;
    return (Date.now() - t) < 7 * 86400000;
  })();
  const hasSalaryPill = Number.isFinite(salaryMin);
  if (!isFeatured && !isNew && !hasSalaryPill) return '';
  const featuredHtml = isFeatured
    ? `<span class="badge badge-featured">${esc(FEATURED_LABEL[locale])}</span>`
    : '';
  const newHtml = isNew
    ? `<span class="badge badge-new">${esc(NEW_LABEL[locale])}</span>`
    : '';
  const salaryPillHtml = hasSalaryPill
    ? `<span class="badge badge-salary">${esc(salaryText)}</span>`
    : '';
  return `<div class="hero-badges">${featuredHtml}${newHtml}${salaryPillHtml}</div>`;
}
