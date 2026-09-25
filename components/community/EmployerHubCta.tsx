/**
 * EmployerHubCta — the ONE link into the evergreen `/aziende/<slug>/` hub,
 * rendered identically by every runtime surface that is ABOUT one employer.
 *
 * ── WHY IT IS A COMPONENT AND NOT A THIRD COPY ─────────────────────────────
 * JobExpiredView and JobOrphanView shipped this block byte-for-byte identical
 * except for the expression that names the company. A third copy in
 * JobBoard's active-ad detail would have made drift a matter of time — and
 * drift here is not cosmetic: the anchor text IS the ranking signal for the
 * destination, so two surfaces phrasing it differently split one page's
 * inbound signal into two phrases. `employerHubAnchor` already guarantees the
 * WORDS are shared; this component makes the LINK shared, which is the half
 * that carries the `<a href>`, the analytics label and the fail-closed gate.
 *
 * ── WHY IT EXISTS AT ALL ───────────────────────────────────────────────────
 * The 505 `/aziende/<slug>/` hubs took 571 impressions and 29 clicks in the
 * 28 days to 6 Aug 2026, against 28 826 / 1 257 of brand demand that maps
 * straight onto them. They are not broken, they are unlinked. Every surface
 * about one employer has to hand the reader over.
 *
 * The active ad is the surface where that matters MOST and was missing
 * longest: an expired ad and an orphan slug both pointed at the hub, the LIVE
 * ad — where reader intent is highest — did not. `jobsSeoPagesPlugin` emits
 * the link into the STATIC job page, so it existed for a crawler and
 * disappeared the moment React hydrated over it. This closes that gap on the
 * hydrated side.
 *
 * ── THE HAZARD IT REMOVES ──────────────────────────────────────────────────
 * A real `<a href>` with a full navigation, NOT the SPA `<button>` the company
 * NAME uses on all three surfaces. The two are opposites on purpose:
 *
 *  · the company-name control targets the job-board company FILTER, whose
 *    static page may not exist for a rotated-out employer — a full navigation
 *    there is the 404 → 404.html → `location.replace('/')` → SPA restore →
 *    `staticOverlay: true` → header + footer over static HTML that never
 *    existed chain (the burkhalter-group incident). It stays a `<button>`;
 *  · this link is rendered ONLY when `useEmployerHub` found the slug in the
 *    map `employerProfilePagesPlugin` writes for the pages it ACTUALLY
 *    emitted, above `MIN_ACTIVE_JOBS`. That existence proof is what buys back
 *    the `<a href>` — and the href is the point: middle-click, cmd-click and
 *    "open in new tab" all have to work, and a crawler has to see a real
 *    internal link, which is the whole mechanism by which the hub stops being
 *    an orphan.
 *
 * Renders `null` for every case the hook cannot prove (map in flight, fetch
 * failed, slug absent, count under the floor, no usable company name), so a
 * caller can drop it anywhere without a guard of its own.
 *
 * Deliberately takes NO `className` / variant prop. A surface that could
 * restyle it is a surface that can diverge, and divergence is the defect this
 * component exists to make impossible.
 */

import { ArrowRight, Building2 } from 'lucide-react';

import { Analytics } from '@/services/analytics';
import { useEmployerHub, employerHubAnchor, employerOpenRolesLabel } from '@/hooks/useEmployerHub';
import type { Locale } from '@/services/i18n';

export interface EmployerHubCtaProps {
  /** Employer display name, as the surface knows it. */
  company: string | null | undefined;
  /** Stable employer key when the surface has one — folds brand aliases. */
  companyKey?: string | null;
  locale: Locale;
}

export default function EmployerHubCta({ company, companyKey = null, locale }: EmployerHubCtaProps) {
  // Called unconditionally, before any early return: this is the only hook in
  // the component, and hosting it here is what lets callers place the CTA
  // AFTER their own conditional returns (JobBoard's auth-gate layout is one).
  const employerHub = useEmployerHub(company, companyKey, locale);

  if (!employerHub || !company) return null;

  return (
    <a
      href={employerHub.href}
      onClick={() => Analytics.trackSelectContent('employer_hub_open', employerHub.slug)}
      // Denser below `sm`: at 390px this box was 64-84px tall (the anchor
      // wraps to two lines on any employer with a long name) and it sits
      // between the title block and the follow CTA, so every pixel here is a
      // pixel of the ad itself pushed under the fold. Padding, type scale and
      // leading tighten together; the 44px touch target is untouched.
      className="mt-3 flex items-center gap-2 sm:gap-2.5 rounded-xl border border-accent-border bg-accent-subtle px-3 py-2 sm:px-3.5 sm:py-3 min-h-[44px] text-[13px] sm:text-sm font-semibold leading-snug text-accent hover:bg-accent-subtle/70 transition-colors"
    >
      <Building2 size={16} className="shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        {employerHubAnchor(company, locale)}
        <span className="block text-[11px] sm:text-xs font-normal text-subtle mt-0.5">
          {employerOpenRolesLabel(employerHub.activeJobs, locale)}
        </span>
      </span>
      <ArrowRight size={14} className="shrink-0" aria-hidden="true" />
    </a>
  );
}
