/**
 * companyFollowMountPlaceholder — the "Segui questa azienda" hydration island
 * for the SSG employer-profile pages `/aziende/<slug>/` (issue #5012, phase 2).
 *
 * The issue names this surface FIRST ("Ogni pagina azienda … deve avere un
 * pulsante/CTA: Segui questa azienda") and it is the one that matters most for
 * growth: `/aziende/<slug>/` is indexed and takes organic traffic from "lavorare
 * in Migros" — high intent, and the only surface reached by a visitor who is NOT
 * looking at one specific ad, which is exactly when "follow the employer" is the
 * natural action. The job-detail CTA catches the bottom of the funnel; this
 * catches the top. Without it the anonymous email capture built in this same PR
 * stays largely unused.
 *
 * These pages are STATIC: services/router.ts resolves `/aziende/<slug>/` to
 * `{ activeTab: 'job-board', staticOverlay: true }`, so the SPA renders header +
 * footer only and this HTML stays visible. The CTA therefore cannot be a React
 * child of the page — it is an island, following the pattern that already
 * exists in this repo for exactly this problem:
 *
 *   build-time `[data-…-mount]` div + `data-*` props
 *     → client scan + `createPortal` (components/community/CompanyFollowMount.tsx)
 *
 * — the same contract as `newsletterMountPlaceholder` / `NewsletterMount`. No
 * new hydration mechanism, and the button component itself is reused verbatim,
 * not re-implemented.
 *
 * ── WHY name + companyKey AND NOT THE SLUG ────────────────────────────────
 * `companyAlertKey(company, companyKey)` in services/jobAlertService.ts IS
 * `canonicalCompanyProfileSlug(company, companyKey)` — the very function this
 * plugin uses to build the `/aziende/<slug>/` URL. Passing the two raw inputs
 * lets the button re-derive the token through the ONE shared normalisation, so
 * the page's URL and the persisted CompanyAlert key cannot disagree. Emitting
 * the already-computed slug instead would introduce a second way to produce
 * that token — the drift #5151 spent its whole review deleting four copies of.
 *
 * The pre-hydration skeleton is non-interactive and `aria-hidden`; CompanyFollowMount
 * clears `innerHTML` before mounting (createPortal does NOT clear the container).
 * It reserves the BUTTON only — not the hint line, not the consent notice, both
 * of which the hydrated `CompanyFollowButton` renders underneath it. This
 * comment used to claim "button + hint"; it never emitted the hint. Said
 * plainly because the gap is real: hydration here still costs the height of
 * those two lines. The React-side twin, `components/community/CompanyFollowPlaceholder.tsx`,
 * DOES reserve them, and that asymmetry is deliberate only in the sense that
 * nobody has measured this surface (#6110 covers the job detail, not
 * `/aziende/<slug>/`).
 */
import { escHtml } from './htmlEscape';

/**
 * Skeleton label, in all four locales. Mirrors `jobAlert.companyFollow.cta` in
 * services/locales/*-core.ts — the string the hydrated button shows — so the
 * placeholder and the real CTA read identically and hydration costs no visible
 * text swap. Duplicated rather than imported because build plugins cannot pull
 * the runtime i18n bundle; asserted against the locale files by
 * tests/company-alert.test.ts.
 */
const FOLLOW_CTA_LABEL: Record<string, string> = {
  it: 'Segui questa azienda',
  en: 'Follow this company',
  de: 'Diesem Unternehmen folgen',
  fr: 'Suivre cette entreprise',
};

interface CompanyFollowMountPlaceholderOptions {
  /** Employer display name — `EmployerProfile.name`. */
  company: string;
  /** Crawler company key — `EmployerProfile.companyKey`. Improves canonicalisation. */
  companyKey?: string | null;
  /** Page locale, so the mounted alert is created in the language being read. */
  locale: string;
  /** Funnel provenance (`employer_profile`, `employer_below_floor`). */
  surface: string;
}

export function companyFollowMountPlaceholder({
  company,
  companyKey,
  locale,
  surface,
}: CompanyFollowMountPlaceholderOptions): string {
  // An employer with no name has no alert key either (`companyAlertKey('')` is
  // ''), so emit nothing rather than a placeholder that would hydrate into a
  // button rendering null and leave an empty box on the page.
  if (!company) return '';
  const label = FOLLOW_CTA_LABEL[locale] || FOLLOW_CTA_LABEL.it;
  return `<div data-company-follow-mount data-company="${escHtml(company)}" data-company-key="${escHtml(companyKey || '')}" data-locale="${escHtml(locale)}" data-surface="${escHtml(surface)}" class="mb-5">
<div aria-hidden="true" class="inline-flex items-center gap-2 px-4 py-2 min-h-[44px] text-sm font-semibold rounded-lg border border-edge bg-surface-raised text-muted">${escHtml(label)}</div>
</div>`;
}
