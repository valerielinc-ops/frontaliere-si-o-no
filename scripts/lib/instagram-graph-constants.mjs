/**
 * The small, dependency-free Instagram Graph API surface.
 *
 * Keep this module free of site data so the Mac host can include it in the
 * social-robot snapshot. Consumers that need the larger social helpers may
 * still import and re-export these constants from social-post-utils.mjs.
 */
export const GRAPH_API_VERSION = 'v21.0';
export const GRAPH_API = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
