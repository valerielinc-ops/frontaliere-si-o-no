/**
 * CompanyFollowPlaceholder — the space «Segui questa azienda» is about to take.
 *
 * WHY IT EXISTS
 * -------------
 * The follow CTA arrives twice-deferred: `CompanyFollowCta` is a `lazyRetry`
 * import (a chunk fetch), and `CompanyFollowButton` then renders `null` while
 * `findCompanyAlert` resolves whether this employer is already followed. Both
 * gaps used to be free, because the CTA sat ~200 lines down the job detail,
 * under the apply/share row — an insertion below the fold costs nothing.
 *
 * It now sits in the header, directly under the employer-hub link, where it is
 * above the fold on every viewport. Inserting ~130px there once the chunk lands
 * would push the whole article down: a large, measurable layout shift on the
 * site's highest-traffic template, and exactly the class of regression the
 * neighbouring gate teaser carries a fixed-height clamp for.
 *
 * WHAT IS RESERVED, AND WHAT IS APPROXIMATE — said plainly
 * --------------------------------------------------------
 * The button and the hint reserve EXACTLY, because they render the real
 * strings, in the real typography, invisibly: same text, same wrapping, same
 * height at every breakpoint and in every locale. No guess to drift.
 *
 * The consent formula underneath cannot be reserved the same way. Rendering it
 * here would put the sentence on screen from a component that records no proof
 * — the register in `services/consentTexts.ts` is explicit that the displayed
 * sentence and the stored one must come from one place — so this reserves
 * shimmer lines instead.
 *
 * TWO lines of 10px, not three of 12px, since the formula lost the spelled-out
 * URL (`CONSENT_PAGE_LABELS` in `services/consentTexts.ts`: the page is named
 * by one linked word now) and the notice moved to `text-[10px] leading-snug`.
 * At ~92 characters it is one line on the desktop column and two on a 390px
 * phone, so the reservation is exact on mobile and one line long on desktop —
 * the opposite of the old three-bar block, which over-reserved on desktop and
 * under-reserved by ~2 lines on a phone (#6110). Keep the two numbers in step:
 * change the notice's size or the sentence's length and this block is stale.
 */
import React from 'react';

import { useTranslation } from '@/services/i18n';

const CompanyFollowPlaceholder: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div className="mt-3" aria-hidden="true" data-testid="company-follow-placeholder">
      <div className="inline-flex items-center gap-2 px-4 py-2 min-h-[44px] text-sm font-semibold rounded-lg border border-edge bg-surface-raised animate-pulse">
        <span className="w-4 h-4 rounded-full bg-surface" />
        <span className="invisible">{t('jobAlert.companyFollow.cta')}</span>
      </div>
      <p className="mt-2 text-[11px] text-muted invisible">{t('jobAlert.companyFollow.hint')}</p>
      <div className="mt-2 space-y-1">
        <div className="h-2.5 w-full rounded bg-surface-raised animate-pulse" />
        <div className="h-2.5 w-3/4 rounded bg-surface-raised animate-pulse" />
      </div>
    </div>
  );
};

export default CompanyFollowPlaceholder;
