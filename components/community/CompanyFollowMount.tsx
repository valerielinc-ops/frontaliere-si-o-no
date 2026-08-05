/**
 * CompanyFollowMount — bridges the static SSG employer-profile pages to the
 * React `CompanyFollowButton` (issue #5012, phase 2).
 *
 * `/aziende/<slug>/` is a `staticOverlay` route: services/router.ts resolves it
 * to `{ activeTab: 'job-board', staticOverlay: true }`, so App.tsx renders only
 * header + footer and the emitted HTML body stays visible. An interactive CTA on
 * that page has to be an island, and this repo already has the pattern —
 * `NewsletterMount` + `newsletterMountPlaceholder`. This is the same contract:
 * scan for `[data-company-follow-mount]`, read the props off `data-*`, portal
 * the canonical component in.
 *
 * Deliberately a MOUNT, not a second button: `CompanyFollowButton` is rendered
 * verbatim, so the employer-profile CTA and the job-detail CTA share one
 * implementation — including the anonymous email capture + double opt-in and the
 * `companyAlertKey` normalisation. A copy here would be a second surface that
 * could drift from the matcher, silently.
 *
 * Auth comes from `useAuth()` (a standalone hook, no provider needed) and is
 * passed through as-is: `undefined`/`null` is the anonymous path, which on this
 * page is the COMMON case — an organic visitor landing on "lavorare in Migros"
 * from search is exactly the email we do not have yet.
 *
 * Mounted unconditionally from App.tsx (like `NewsletterMount`): the scan is a
 * single `querySelectorAll` that finds nothing on every other route.
 */
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Locale } from '@/services/i18n';
import { getLocale } from '@/services/i18n';
import { useAuth } from '@/services/authService';
import { Analytics } from '@/services/analytics';
import CompanyFollowButton from './CompanyFollowButton';

interface MountTarget {
  el: HTMLElement;
  company: string;
  companyKey: string | null;
  locale: Locale;
  surface: string;
}

const VALID_LOCALES: readonly string[] = ['it', 'en', 'de', 'fr'];

const CompanyFollowMount: React.FC = () => {
  const [targets, setTargets] = useState<MountTarget[]>([]);
  const { user } = useAuth();

  useEffect(() => {
    const scan = () => {
      const elements = Array.from(
        document.querySelectorAll<HTMLElement>('[data-company-follow-mount]:not([data-company-follow-mounted])'),
      );
      if (elements.length === 0) return;
      const next: MountTarget[] = [];
      for (const el of elements) {
        const company = (el.dataset.company || '').trim();
        // An employer with no name has no alert key either — leave the
        // placeholder untouched rather than mounting a button that would
        // render null and strand an empty box.
        if (!company) continue;
        el.dataset.companyFollowMounted = '1';
        // createPortal appends; it does NOT clear the container. Drop the
        // pre-hydration skeleton first or it stays under the real button.
        el.innerHTML = '';
        const raw = el.dataset.locale || '';
        next.push({
          el,
          company,
          companyKey: (el.dataset.companyKey || '').trim() || null,
          locale: (VALID_LOCALES.includes(raw) ? raw : getLocale()) as Locale,
          surface: el.dataset.surface || 'employer_profile',
        });
      }
      if (next.length > 0) setTargets((prev) => [...prev, ...next]);
    };
    scan();
    // Re-scan when the SPA navigates between static-overlay pages without a
    // full reload: the router emits popstate, and the observer catches the
    // static body being swapped in after a client-side transition.
    const onPop = () => scan();
    window.addEventListener('popstate', onPop);
    const observer = new MutationObserver(() => scan());
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      window.removeEventListener('popstate', onPop);
      observer.disconnect();
    };
  }, []);

  if (targets.length === 0) return null;
  return (
    <>
      {targets.map((t, i) =>
        createPortal(
          <CompanyFollowButton
            company={t.company}
            companyKey={t.companyKey}
            userId={user?.uid ?? null}
            email={user?.email ?? null}
            locale={t.locale}
            onSubscribed={() => {
              Analytics.trackJobAlertCtaClick('company_follow_button', 'success', t.company);
              Analytics.trackJobAlertCreated({
                keywords: t.company,
                frequency: 'immediate',
                surface: 'company_follow_button',
              });
            }}
            onOptInRequested={() => {
              // 'accept', not 'success': the address is captured but the follow
              // is still parked pending confirmation. Counting it as a created
              // alert would inflate the funnel with un-consented subscriptions.
              Analytics.trackJobAlertCtaClick('company_follow_button', 'accept', t.company);
            }}
            onErrored={() => {
              Analytics.trackJobAlertCtaClick('company_follow_button', 'error', t.company);
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
