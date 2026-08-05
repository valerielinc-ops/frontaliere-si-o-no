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
import { useAuth } from '@/services/authService';
import { useHydrationIslands } from '@/hooks/useHydrationIslands';
import { Analytics } from '@/services/analytics';
import CompanyFollowButton from './CompanyFollowButton';

interface CompanyFollowMountProps {
  company: string;
  companyKey: string | null;
  locale: Locale;
  surface: string;
}

const VALID_LOCALES: readonly string[] = ['it', 'en', 'de', 'fr'];

const CompanyFollowMount: React.FC = () => {
  const { user } = useAuth();
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
        surface: el.dataset.surface || 'employer_profile',
      };
    },
  });

  if (targets.length === 0) return null;
  return (
    <>
      {targets.map((t, i) =>
        createPortal(
          <CompanyFollowButton
            company={t.props.company}
            companyKey={t.props.companyKey}
            userId={user?.uid ?? null}
            email={user?.email ?? null}
            locale={t.props.locale}
            onSubscribed={() => {
              Analytics.trackJobAlertCtaClick('company_follow_button', 'success', t.props.company);
              Analytics.trackJobAlertCreated({
                keywords: t.props.company,
                frequency: 'immediate',
                surface: 'company_follow_button',
              });
            }}
            onOptInRequested={() => {
              // 'accept', not 'success': the address is captured but the follow
              // is still parked pending confirmation. Counting it as a created
              // alert would inflate the funnel with un-consented subscriptions.
              Analytics.trackJobAlertCtaClick('company_follow_button', 'accept', t.props.company);
            }}
            onErrored={() => {
              Analytics.trackJobAlertCtaClick('company_follow_button', 'error', t.props.company);
            }}
          />,
          t.el,
          `company-follow-mount-${i}`,
        ),
      )}
    </>
  );
};

export default CompanyFollowMount;
