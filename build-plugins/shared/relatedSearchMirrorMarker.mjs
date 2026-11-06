// Explicit declaration for the legacy per-canton mirrors emitted by
// relatedSearchClustersPlugin.  The generic REDIRECT_STUB marker is shared by
// unrelated bridge families, so Bing's frontier crawler must have a dedicated
// signal before it can apply the narrower mirror-path/canonical contract.
// Keep this in a Node-compatible module so the TypeScript emitter and the raw
// Node crawler import the same literal.
export const RELATED_SEARCH_MIRROR_MARKER = '<!--RELATED_SEARCH_MIRROR-->';
