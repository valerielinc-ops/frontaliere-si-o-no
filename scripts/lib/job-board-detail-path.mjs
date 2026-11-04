/**
 * Shared route shape for a flat job detail below a canton-aware job board.
 * Route families that share this shape still need their own hub/editorial
 * exclusions at the call site.
 */
export const JOB_BOARD_DETAIL_PATH_RE = /^\/(?:cerca-lavoro-[a-z0-9-]+|en\/find-jobs-[a-z0-9-]+|de\/jobs-(?:im|in)-[a-z0-9-]+|fr\/trouver-emploi-[a-z0-9-]+)\/[^/]+\/$/i;
