/** AdSense ad-unit registry — single source of truth for slot IDs and layout config.
 *
 * `placeholderMinHeight` reserves layout space before the ad loads, preventing CLS (FRO-385).
 * Heights are sized conservatively above real median ad heights measured in production:
 *  - autorelaxed multiplex: 380-450px on mobile → 400px
 *  - fluid in-article: ~220px → 220px
 *  - auto display: ~250-300px → 280px
 */

export const AD_CLIENT = 'ca-pub-8628054934855353';

export const AD_SLOTS = {
  /** Blog: desktop left rail */
  ARTICLE_RAIL_LEFT: {
    slot: '2663155183',
    format: 'auto',
    fullWidthResponsive: true,
    placeholderMinHeight: 280,
  },
  /** Blog: desktop right rail */
  ARTICLE_RAIL_RIGHT: {
    slot: '9739778973',
    format: 'auto',
    fullWidthResponsive: true,
    placeholderMinHeight: 280,
  },
  /** Blog: mobile in-article native */
  ARTICLE_INLINE_MOBILE: {
    slot: '1982411173',
    format: 'fluid',
    layout: 'in-article',
    fullWidthResponsive: false,
    placeholderMinHeight: 220,
  },
  /** Blog: end-of-article multiplex */
  ARTICLE_END_MULTIPLEX: {
    slot: '5196931137',
    format: 'autorelaxed',
    fullWidthResponsive: false,
    placeholderMinHeight: 400,
  },
  /** Job listing: desktop in-feed native */
  JOBLIST_INFEED_DESKTOP: {
    slot: '9770600968',
    format: 'fluid',
    layoutKey: '-f9+5v+4m-d8+7b',
    fullWidthResponsive: false,
    placeholderMinHeight: 220,
  },
  /** Job listing: mobile in-feed native */
  JOBLIST_INFEED_MOBILE: {
    slot: '6979586981',
    format: 'fluid',
    layoutKey: '-f9+5v+4m-d8+7b',
    fullWidthResponsive: false,
    placeholderMinHeight: 220,
  },
  /** Job listing: end-of-list multiplex */
  JOBLIST_END_MULTIPLEX: {
    slot: '5196931137',
    format: 'autorelaxed',
    fullWidthResponsive: false,
    placeholderMinHeight: 400,
  },
  /** Job detail: desktop sidebar display */
  JOBDETAIL_SIDEBAR: {
    slot: '8164676143',
    format: 'auto',
    fullWidthResponsive: true,
    placeholderMinHeight: 280,
  },
  /** Job detail: end multiplex */
  JOBDETAIL_END_MULTIPLEX: {
    slot: '3205192616',
    format: 'autorelaxed',
    fullWidthResponsive: false,
    placeholderMinHeight: 400,
  },
  /** Blog: desktop left rail — secondary (replaces Amazon products) */
  ARTICLE_RAIL_LEFT_2: {
    slot: '9850785535',
    format: 'auto',
    fullWidthResponsive: true,
    placeholderMinHeight: 280,
  },
  /** Blog: desktop right rail — secondary (replaces Amazon products) */
  ARTICLE_RAIL_RIGHT_2: {
    slot: '8537703867',
    format: 'auto',
    fullWidthResponsive: true,
    placeholderMinHeight: 280,
  },
  /** Blog: mobile in-article — secondary (replaces Amazon products) */
  ARTICLE_INLINE_MOBILE_2: {
    slot: '6483829128',
    format: 'fluid',
    layout: 'in-article',
    fullWidthResponsive: false,
    placeholderMinHeight: 220,
  },
} as const;
