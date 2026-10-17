// Explicit declaration for intentional noindex job-detail targets.
//
// The Bing frontier crawler must distinguish a deliberately retained job
// detail/bridge from an unexpected noindex page. Keep this marker in a small
// Node-compatible module so the TypeScript emitter and the Node crawler share
// one literal and cannot drift.
export const JOB_BOARD_NOINDEX_TARGET_MARKER = '<!--JOB_BOARD_NOINDEX_TARGET-->';
