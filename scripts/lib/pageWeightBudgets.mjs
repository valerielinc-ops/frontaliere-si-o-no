/**
 * Page-weight budgets shared by the standalone and multi-audit entrypoints.
 * Keep these values in one module so the two gates cannot drift.
 */

/**
 * Owner-approved exception (2026-09-14) for complete facility inventories.
 * Measured against the current assembled `data/jobs.json`: all 127 facilities
 * × 4 locales render below 582,787 bytes; Hirslanden/de is the heaviest case
 * at 411 visible cards. The finite 640 KB ceiling leaves growth headroom while
 * still failing loudly before an unbounded inventory becomes acceptable.
 */
export const HEALTH_FACILITY_PAGE_BUDGET_BYTES = 640 * 1024;
