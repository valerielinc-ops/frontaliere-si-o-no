/** AdSense ad-unit registry — single source of truth for slot IDs and layout config. */

export const AD_CLIENT = 'ca-pub-8628054934855353';

export const AD_SLOTS = {
  /** Blog: desktop right rail */
  ARTICLE_RAIL_RIGHT: {
    slot: '9739778973',
    format: 'auto',
    fullWidthResponsive: true,
  },
  /** Blog: mobile in-article native */
  ARTICLE_INLINE_MOBILE: {
    slot: '1982411173',
    format: 'fluid',
    layout: 'in-article',
    fullWidthResponsive: false,
  },
  /** Blog: end-of-article multiplex */
  ARTICLE_END_MULTIPLEX: {
    slot: '5196931137',
    format: 'autorelaxed',
    fullWidthResponsive: false,
  },
  /** Job listing: desktop in-feed native */
  JOBLIST_INFEED_DESKTOP: {
    slot: '9770600968',
    format: 'fluid',
    layoutKey: '-f9+5v+4m-d8+7b',
    fullWidthResponsive: false,
  },
  /** Job listing: mobile in-feed native */
  JOBLIST_INFEED_MOBILE: {
    slot: '6979586981',
    format: 'fluid',
    layoutKey: '-f9+5v+4m-d8+7b',
    fullWidthResponsive: false,
  },
  /** Job listing: end-of-list multiplex */
  JOBLIST_END_MULTIPLEX: {
    slot: '5196931137',
    format: 'autorelaxed',
    fullWidthResponsive: false,
  },
  /** Job detail: desktop sidebar display */
  JOBDETAIL_SIDEBAR: {
    slot: '8164676143',
    format: 'auto',
    fullWidthResponsive: true,
  },
  /** Job detail: end multiplex */
  JOBDETAIL_END_MULTIPLEX: {
    slot: '3205192616',
    format: 'autorelaxed',
    fullWidthResponsive: false,
  },
} as const;
