// ejpMarker.ts
//
// TS-facing re-export of the canonical audit:text-html-ratio skip marker.
// The literal lives once in ./ejpMarker.mjs (plain JS so the Node-run
// auditor in scripts/ can import it without a tsx loader on CI Node 20/22).
// TS build-plugins import EJP_STRIPPED_MARKER from here (extensionless,
// resolved by Vite / moduleResolution:bundler). The marker VALUE must stay
// byte-identical everywhere — see ejpMarker.mjs for the single definition.
export { EJP_STRIPPED_MARKER } from './ejpMarker.mjs';
