/**
 * cantonJobBoardPrefix.ts — shared "find-jobs-{canton}" URL segment prefix,
 * locale-keyed. Every canton-scoped job-board family (job-market snapshot,
 * weekly employers) builds its canonical path as `{prefix}-{cantonSlug}/`,
 * so this literal is centralised here instead of copy-pasted per family
 * (AGENTS.md rule #6 — a literal duplicated in ≥2 files goes in one shared
 * module so drift is impossible by construction).
 */

export type CantonJobBoardLocale = 'it' | 'en' | 'de' | 'fr';

export const CANTON_JOB_BOARD_PREFIX: Record<CantonJobBoardLocale, string> = {
  it: 'cerca-lavoro',
  en: 'find-jobs',
  de: 'jobs-im',
  fr: 'trouver-emploi',
};
