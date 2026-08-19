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
 * sentence and the stored one must come from one place — so this reserves three
 * shimmer lines instead. That is right at the article column's desktop width
 * (~2-3 lines) and short on a narrow phone, where the same sentence wraps to
 * about five. The residual shift there is ~2 lines of 11px text, against the
 * ~130px it replaces.
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
      <p className="mt-2 text-xs text-muted invisible">{t('jobAlert.companyFollow.hint')}</p>
      <div className="mt-2 space-y-1">
        <div className="h-3 w-full rounded bg-surface-raised animate-pulse" />
        <div className="h-3 w-11/12 rounded bg-surface-raised animate-pulse" />
        <div className="h-3 w-2/3 rounded bg-surface-raised animate-pulse" />
      </div>
    </div>
  );
};

export default CompanyFollowPlaceholder;
