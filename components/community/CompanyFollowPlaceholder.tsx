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
 *
 * Measured, not assumed — rendered at 10px / leading-snug in the real column
 * width (viewport x 0.95, minus the page's px-3 and the header's p-4):
 *
 *     390px viewport -> 315px column: it 96ch, en 89ch, de 102ch, fr 93ch -> 2 lines each
 *     320px viewport -> 248px column: it/en/fr 2 lines, de 3 lines
 *
 * Hence two bars for everyone plus a third for German below 360px. Keep the
 * numbers in step: change the notice's size or the sentence's length and this
 * block is stale (#6110).
 */
import React from 'react';

import { useTranslation } from '@/services/i18n';

const CompanyFollowPlaceholder: React.FC = () => {
  const { t, locale } = useTranslation();

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
        {/* German only, and only on the narrowest phones. Measured at 10px /
            leading-snug in the real column width: at a 390px viewport (315px
            column) all four locales wrap to 2 lines, but at 320px (248px
            column) German — 102 characters against 89-96 for the others —
            takes 3. Reserving the third bar unconditionally would over-reserve
            13px for everyone else; reserving it never leaves exactly the
            German-on-a-small-phone residual this component exists to remove. */}
        {locale === 'de' && (
          <div className="hidden max-[359px]:block h-2.5 w-1/2 rounded bg-surface-raised animate-pulse" />
        )}
      </div>
    </div>
  );
};

export default CompanyFollowPlaceholder;
