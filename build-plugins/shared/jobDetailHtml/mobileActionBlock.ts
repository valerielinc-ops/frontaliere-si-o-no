/**
 * Mobile-first action block (above-the-fold on small screens) for the
 * static job-detail page. Mirrors the React
 * `<section className="lg:hidden">` block in
 * `components/community/JobBoard.tsx` — Apply CTA + 3 key stats +
 * optional salary line. Hidden on lg+ via
 * `.mobile-action-block { display:none }` in seo-static.css.
 *
 * SPA-parity regression coverage:
 *   tests/seo/static-job-page-spa-alignment.test.ts indirectly via the
 *   shared CSS class definitions; functional coverage via the snapshot
 *   test in tests/seo/job-detail-html-snapshot.test.ts.
 */
import type { JobDetailLocale, JobDetailRenderContext } from './context';

const PUBLISHED_LABEL: Record<JobDetailLocale, string> = {
  it: 'Pubblicato',
  en: 'Posted',
  de: 'Veröffentlicht',
  fr: 'Publié',
};

const SALARY_LABEL: Record<JobDetailLocale, string> = {
  it: 'Salario',
  en: 'Salary',
  de: 'Lohn',
  fr: 'Salaire',
};

const DAYS_AGO_FORMATTER: Record<JobDetailLocale, (n: number) => string> = {
  it: (n) => (n === 0 ? 'Oggi' : n === 1 ? 'Ieri' : `${n} giorni fa`),
  en: (n) => (n === 0 ? 'Today' : n === 1 ? 'Yesterday' : `${n} days ago`),
  de: (n) => (n === 0 ? 'Heute' : n === 1 ? 'Gestern' : `vor ${n} Tagen`),
  fr: (n) =>
    n === 0 ? "Aujourd'hui" : n === 1 ? 'Hier' : `il y a ${n} jours`,
};

export type MobileActionBlockContext = Pick<
  JobDetailRenderContext,
  | 'job'
  | 'locale'
  | 'canonicalUrl'
  | 'addressLocality'
  | 'salaryMin'
  | 'salaryText'
  | 'localeLabels'
  | 'referralUrl'
  | 'esc'
>;

export function renderMobileActionBlock(ctx: MobileActionBlockContext): string {
  const {
    job,
    locale,
    canonicalUrl,
    addressLocality,
    salaryMin,
    salaryText,
    localeLabels,
    referralUrl,
    esc,
  } = ctx;
  const daysAgo = (() => {
    const dateStr = String(job.postedDate ?? job.crawledAt ?? '');
    if (!dateStr) return '—';
    const t = new Date(dateStr).getTime();
    if (!Number.isFinite(t)) return '—';
    const days = Math.max(0, Math.round((Date.now() - t) / 86400000));
    return DAYS_AGO_FORMATTER[locale](days);
  })();
  const contractText = String(job.contract || 'other');
  // Salary line — only when we actually have a number; the "non indicato"
  // fallback is meaningless as a money signal so we suppress it instead of
  // rendering a tile that adds zero information.
  const salaryLineHtml = Number.isFinite(salaryMin)
    ? `<div class="mab-salary"><span class="mab-salary-label">${esc(
        SALARY_LABEL[locale],
      )}</span><span class="mab-salary-value">${esc(salaryText)}</span></div>`
    : '';
  return `<section class="mobile-action-block" aria-label="${esc(localeLabels.quickDetails)}">
 <a href="${referralUrl(job.url || canonicalUrl, job)}" rel="noopener noreferrer" class="mab-cta">${esc(localeLabels.applyNow)}</a>
 <dl class="mab-grid">
 <div class="mab-tile"><dt>${esc(localeLabels.location)}</dt><dd>${esc(addressLocality)}</dd></div>
 <div class="mab-tile"><dt>${esc(localeLabels.contract)}</dt><dd>${esc(contractText)}</dd></div>
 <div class="mab-tile"><dt>${esc(PUBLISHED_LABEL[locale])}</dt><dd>${esc(daysAgo)}</dd></div>
 </dl>${salaryLineHtml}
 </section>`;
}
