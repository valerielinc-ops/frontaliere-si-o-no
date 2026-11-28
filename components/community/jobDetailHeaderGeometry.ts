/**
 * Reserved geometry of the job-detail header (CLS, issue 20412).
 *
 * Pure string constants (no React / icon imports) so the loading skeleton in
 * `components/shared/Skeletons.tsx` can paint the SAME box the real header
 * will occupy, without pulling the presentation module into its bundle.
 *
 * Derivation (Tailwind px, line-height `leading-tight` = 1.25):
 *  - title `text-xl` 20px -> 25px/line, `sm:text-2xl` 24px -> 30px/line,
 *    `md:text-3xl` 30px -> 37.5px/line;
 *  - subtitle: `mt-1` 4px + the 44px touch target of the location link = 48px;
 *  - below `sm` the copy column is ~230px wide at 390px, so a typical 30-60
 *    character title takes TWO lines (2 x 25 + 48 = 98px); from `sm` the column
 *    is wide enough for ONE line (30 + 48 = 78, the 80px logo frame wins), and
 *    from `md` one line is 37.5 + 48 = ~86px (rounded up to 93 with the line box);
 *  - a meta pill is `text-xs` 16px + `py-1` 8px = 24px; rows are 8px apart, so
 *    two wrapped rows = 56px.
 * These are MINIMUMS: a longer title still grows the box, a short one leaves at
 * most one line of slack, instead of the whole body below moving at hydration.
 */
export const JOB_DETAIL_HEADER_CONTENT_RESERVE_CLASS = 'min-h-[98px] sm:min-h-[80px] md:min-h-[93px]';

/** One pill row (default: expired/orphan views show 1-2 pills). */
export const JOB_DETAIL_METADATA_RESERVE_1_CLASS = 'min-h-[24px]';
/** Two wrapped rows below `sm`, one from `sm` (live job: 4-5 pills at 390px wrap). */
export const JOB_DETAIL_METADATA_RESERVE_2_CLASS = 'min-h-[56px] sm:min-h-[24px]';
