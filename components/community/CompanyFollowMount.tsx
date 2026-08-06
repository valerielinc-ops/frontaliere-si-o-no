/**
 * CompanyFollowMount — bridges the static SSG employer-profile pages to the
 * React `CompanyFollowButton` (issue #5012, phase 2).
 *
 * `/aziende/<slug>/` is a `staticOverlay` route: services/router.ts resolves it
 * to `{ activeTab: 'job-board', staticOverlay: true }`, so App.tsx renders only
 * header + footer and the emitted HTML body stays visible. An interactive CTA on
 * that page has to be an island, and this repo already has the pattern —
 * `NewsletterMount` + `newsletterMountPlaceholder`. This is the same contract,
 * over the same shared loop (`hooks/useHydrationIslands.ts`): scan for
 * `[data-company-follow-mount]`, read the props off `data-*`, portal the
 * canonical component in.
 *
 * Deliberately a MOUNT, not a second button: `CompanyFollowButton` is rendered
 * verbatim, so the employer-profile CTA and the job-detail CTA share one
 * implementation — including the anonymous email capture + double opt-in and the
 * `companyAlertKey` normalisation. A copy here would be a second surface free to
 * drift from the matcher, silently.
 *
 * Auth comes from `useAuth()` (a standalone hook, no provider needed) and is
 * passed through as-is: `null` is the anonymous path, which on this page is the
 * COMMON case — an organic visitor landing on "lavorare in Migros" from search
 * is exactly the email we do not have yet.
 *
 * Mounted unconditionally from App.tsx (like `NewsletterMount`): gating it on a
 * route would mean re-parsing the pathname, because the employer route carries
 * no slug in its `AppRoute`. On every other page the scan is one
 * `querySelectorAll` that matches nothing.
 */
import React from 'react';
import { createPortal } from 'react-dom';
import type { Locale } from '@/services/i18n';
import { getLocale } from '@/services/i18n';
import { useHydrationIslands } from '@/hooks/useHydrationIslands';
import CompanyFollowCta, { type CompanyFollowSurface } from './CompanyFollowCta';

interface CompanyFollowMountProps {
  company: string;
  companyKey: string | null;
  locale: Locale;
  surface: CompanyFollowSurface;
}

const VALID_LOCALES: readonly string[] = ['it', 'en', 'de', 'fr'];

/**
 * Placeholder `data-surface` → analytics CTA surface.
 *
 * The build plugin emits two kinds of employer page — the full profile and the
 * below-floor stub for an employer under `MIN_ACTIVE_JOBS` — and this component
 * used to read that attribute and then report both as one undifferentiated
 * `company_follow_button`. The prop was live in `readProps` and dead one line
 * later, so "does the thin below-floor page convert?" had no answer in the data
 * even though the markup carried it all along.
 *
 * Unknown values fall back to the profile bucket rather than inventing one: a
 * new plugin surface should show up as an existing bucket until it is added
 * here, not as a silently untracked click.
 */
const ANALYTICS_SURFACE: Record<string, CompanyFollowSurface> = {
  employer_profile: 'company_follow_profile',
  employer_below_floor: 'company_follow_below_floor',
};

const CompanyFollowMount: React.FC = () => {
  const targets = useHydrationIslands<CompanyFollowMountProps>({
    attribute: 'data-company-follow-mount',
    mountedAttribute: 'data-company-follow-mounted',
    readProps: (el) => {
      const company = (el.dataset.company || '').trim();
      // An employer with no name has no alert key either — returning null
      // leaves the placeholder untouched rather than mounting a button that
      // renders null and strands an empty box.
      if (!company) return null;
      const raw = el.dataset.locale || '';
      return {
        company,
        companyKey: (el.dataset.companyKey || '').trim() || null,
        // The page's own locale wins: a German reader must not end up with an
        // Italian-locale alert.
        locale: (VALID_LOCALES.includes(raw) ? raw : getLocale()) as Locale,
        surface: ANALYTICS_SURFACE[el.dataset.surface || ''] || 'company_follow_profile',
      };
    },
  });

  if (targets.length === 0) return null;
  return (
    <>
      {targets.map((t, i) =>
        createPortal(
          <CompanyFollowCta
            company={t.props.company}
            companyKey={t.props.companyKey}
            locale={t.props.locale}
            surface={t.props.surface}
          />,
          t.el,
          `company-follow-mount-${i}`,
        ),
      )}
    </>
  );
};

export default CompanyFollowMount;
