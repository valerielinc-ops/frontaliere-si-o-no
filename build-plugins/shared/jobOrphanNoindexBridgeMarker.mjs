// Explicit ownership marker for the incomplete matched-job fallback emitted by
// jobOrphanBridgePlugin. The post-deploy verifier must not treat every
// noindex job-shaped response as this bridge: an active detail can be
// accidentally noindex and still needs to be reported.
export const JOB_ORPHAN_NOINDEX_BRIDGE_MARKER = '<!--JOB_ORPHAN_NOINDEX_BRIDGE-->';
