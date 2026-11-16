// standaloneRedirectStubMarker.mjs
//
// Explicit declaration for the noindex/follow bridge shape emitted by
// buildCanonicalBridgePage({ crossPageSignals: false }). The generic
// REDIRECT_STUB marker is also used by canonical bridges and audit tooling;
// keeping this declaration separate prevents the Bing crawler from treating
// every marked bridge as a canonical-less redirect.
export const STANDALONE_REDIRECT_STUB_MARKER = '<!--STANDALONE_REDIRECT_STUB-->';
