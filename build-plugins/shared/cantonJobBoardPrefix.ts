/**
 * cantonJobBoardPrefix.ts — shared "find-jobs-{canton}" URL segment prefix,
 * locale-keyed. Every canton-scoped job-board family (job-market snapshot,
 * weekly employers) builds its canonical path as `{prefix}-{cantonSlug}/`,
 * so this literal is centralised here instead of copy-pasted per family
 * (AGENTS.md rule #6 — a literal duplicated in ≥2 files goes in one shared
 * module so drift is impossible by construction).
 *
 * Issue #7306: this module used to RE-DECLARE the four prefixes, which made it
 * the second of four literal copies in the repo. It now DERIVES them from the
 * canonical table in `services/jobBoardSlugs.ts`, which is a leaf module
 * (slug JSON + cantonList, no SPA graph — see its header), so importing it
 * here costs nothing at build time. `tests/job-board-prefix-parity.test.ts`
 * holds the two copies that cannot import it.
 *
 * THE DE PREFIX IS DELIBERATELY THE LEGACY `jobs-im`, NOT `jobs-in`.
 * Measured on production 2026-09-05, not inferred from the code:
 *   /de/jobs-im-zurich/snapshot/ → 200, "Arbeitsmarkt-Snapshot — Kanton
 *                                  Zürich", robots noindex,follow
 *   /de/jobs-in-zurich/snapshot/ → 200 but 67 KB of the SPA job-board shell
 *                                  ("Grenzgänger-Jobs in Zürich"): no such
 *                                  page is emitted there.
 * So `jobs-im-{canton}` is the URL these two families have actually been
 * serving. Switching the constant to the router's `jobs-in-` would silently
 * move 23 cantons × 2 families × 4 locales of already-emitted paths. That is a
 * redirect exercise, not a constant edit — hence the pin below and in the
 * parity test. The router does not need to parse these segments: both families
 * recognise their own paths through their `PATH_INDEX` lookup
 * (`isChCantonSnapshotPath` / the weekly-employers equivalent), not through
 * `parseJobBoardSlug`.
 */

import { JOB_BOARD_PREFIX, JOB_BOARD_PREFIX_LEGACY_DE } from '../../services/jobBoardSlugs';

export type CantonJobBoardLocale = 'it' | 'en' | 'de' | 'fr';

/** The canonical table stores prefixes with a trailing `-`; paths here join it themselves. */
const withoutTrailingDash = (prefix: string): string => prefix.replace(/-$/, '');

export const CANTON_JOB_BOARD_PREFIX: Record<CantonJobBoardLocale, string> = {
  it: withoutTrailingDash(JOB_BOARD_PREFIX.it),
  en: withoutTrailingDash(JOB_BOARD_PREFIX.en),
  // Frozen: the live URLs of these two families use the legacy DE form.
  de: withoutTrailingDash(JOB_BOARD_PREFIX_LEGACY_DE),
  fr: withoutTrailingDash(JOB_BOARD_PREFIX.fr),
};
