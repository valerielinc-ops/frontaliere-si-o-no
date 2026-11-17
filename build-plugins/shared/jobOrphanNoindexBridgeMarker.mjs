import { readAttr, scanMarkupStartTags } from '../../scripts/lib/html-attr.mjs';

// Explicit ownership marker for the incomplete matched-job fallback emitted by
// jobOrphanBridgePlugin. Keep this as a real meta element rather than an HTML
// comment: the production HTML minifier removes comments, while the
// post-deploy verifier must be able to prove that the live response is this
// deliberately noindex bridge and not an accidentally incomplete detail page.
export const JOB_ORPHAN_NOINDEX_BRIDGE_MARKER_NAME = 'frontaliereticino-bridge';
export const JOB_ORPHAN_NOINDEX_BRIDGE_MARKER_CONTENT = 'job-orphan-noindex';
export const JOB_ORPHAN_NOINDEX_BRIDGE_MARKER = (
  `<meta name="${JOB_ORPHAN_NOINDEX_BRIDGE_MARKER_NAME}" `
  + `content="${JOB_ORPHAN_NOINDEX_BRIDGE_MARKER_CONTENT}">`
);

export function hasJobOrphanNoindexBridgeMarker(html) {
  for (const { raw } of scanMarkupStartTags(String(html ?? ''), 'meta')) {
    if (readAttr(raw, 'name').toLowerCase() !== JOB_ORPHAN_NOINDEX_BRIDGE_MARKER_NAME) continue;
    if (readAttr(raw, 'content').toLowerCase() === JOB_ORPHAN_NOINDEX_BRIDGE_MARKER_CONTENT) return true;
  }
  return false;
}
