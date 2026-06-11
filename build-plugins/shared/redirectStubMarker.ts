// redirectStubMarker.ts
//
// TS-facing re-export of the canonical audit:spa-bundle-injection skip
// marker. The literal lives once in ./redirectStubMarker.mjs (plain JS so
// the Node-run auditor in scripts/ can import it without a tsx loader on
// CI Node 20/22). TS build-plugins import REDIRECT_STUB_MARKER from here
// (extensionless, resolved by Vite / moduleResolution:bundler). The marker
// VALUE must stay byte-identical everywhere — see redirectStubMarker.mjs
// for the single definition.
export { REDIRECT_STUB_MARKER } from './redirectStubMarker.mjs';
