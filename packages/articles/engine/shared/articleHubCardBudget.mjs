/**
 * Shared static-card budget for article hubs.
 *
 * This stays plain ESM so the TypeScript renderers and the standalone
 * production watchdog consume the same shared card-count value.
 */
export const ARTICLE_HUB_CARD_LIMIT = 16;
