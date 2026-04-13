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
    slot: '8414202909',
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
  /** Homepage: mid-content display ad (between results and widgets) */
  HOMEPAGE_MID_DISPLAY: {
    slot: '2093992129',
    format: 'auto',
    fullWidthResponsive: true,
    placeholderMinHeight: 280,
  },
  /** Job detail: between related jobs and related articles sections */
  JOBDETAIL_BETWEEN_SECTIONS: {
    slot: '7767335647',
    format: 'autorelaxed',
    fullWidthResponsive: false,
    placeholderMinHeight: 400,
  },
  /** Job detail: second sidebar ad (desktop, below first sidebar ad) */
  JOBDETAIL_SIDEBAR_2: {
    slot: '6065026724',
    format: 'auto',
    fullWidthResponsive: true,
    placeholderMinHeight: 280,
  },
  /** Blog: desktop left rail — tertiary */
  ARTICLE_RAIL_LEFT_3: {
    slot: '2040366243',
    format: 'auto',
    fullWidthResponsive: true,
    placeholderMinHeight: 280,
  },
  /** Blog: desktop right rail — tertiary */
  ARTICLE_RAIL_RIGHT_3: {
    slot: '3590906628',
    format: 'auto',
    fullWidthResponsive: true,
    placeholderMinHeight: 280,
  },
  /** Blog: in-article — tertiary (after body3) */
  ARTICLE_INLINE_MOBILE_3: {
    slot: '7011276883',
    format: 'fluid',
    layout: 'in-article',
    fullWidthResponsive: false,
    placeholderMinHeight: 220,
  },
  /** Blog: in-article — quaternary (after body5) */
  ARTICLE_INLINE_MOBILE_4: {
    slot: '6037106565',
    format: 'fluid',
    layout: 'in-article',
    fullWidthResponsive: false,
    placeholderMinHeight: 220,
  },
  /** Blog: in-article — quinary (after body7) */
  ARTICLE_INLINE_MOBILE_5: {
    slot: '7389107873',
    format: 'fluid',
    layout: 'in-article',
    fullWidthResponsive: false,
    placeholderMinHeight: 220,
  },
  /** Blog: after related jobs, before footer */
  ARTICLE_AFTER_JOBS: {
    slot: '4385113543',
    format: 'auto',
    fullWidthResponsive: true,
    placeholderMinHeight: 280,
  },
  /** Blog listing: display ad after featured hero */
  BLOG_LIST_TOP: {
    slot: '6759995448',
    format: 'auto',
    fullWidthResponsive: true,
    placeholderMinHeight: 280,
  },
  /** Blog listing: in-feed ad between card rows #1 */
  BLOG_LIST_INFEED_1: {
    slot: '9727284578',
    format: 'auto',
    fullWidthResponsive: true,
    placeholderMinHeight: 280,
  },
  /** Blog listing: in-feed ad between card rows #2 */
  BLOG_LIST_INFEED_2: {
    slot: '4724024898',
    format: 'auto',
    fullWidthResponsive: true,
    placeholderMinHeight: 280,
  },
} as const;
