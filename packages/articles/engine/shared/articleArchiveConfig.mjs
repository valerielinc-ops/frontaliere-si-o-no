/**
 * One page-size constant for the article archive emitter and its corpus-side
 * verifier. The host re-exports this value through `host/seoHubsData.ts` so
 * build-api and the runtime archive renderer cannot drift apart.
 */
export const ARTICLES_PAGE_SIZE = 100;
