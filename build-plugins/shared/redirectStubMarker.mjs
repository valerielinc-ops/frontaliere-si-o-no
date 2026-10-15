// redirectStubMarker.mjs
//
// Canonical audit:spa-bundle-injection skip marker — the SINGLE source of
// truth for the `<!--REDIRECT_STUB-->` literal. Every page built by
// `buildCanonicalBridgePage` (legacy redirects, cathedral migration stubs,
// canton orphan redirects, jobsSeoPages self-healing tombstones) embeds this
// comment so scripts/audit-spa-bundle-injection.mjs knows the missing SPA
// bundle is intentional: the page is a deliberate noindex redirect bridge.
//
// Why a marker instead of the old `location.replace(` sniff: the redirect
// behaviour was externalised into `/assets/early-boot-{hash}.js`
// (constants.ts EARLY_BOOT_SCRIPT, ~150 B/page saved across ~822k pages),
// so the literal no longer appears inline and the audit's REDIRECT_SHAPE_RX
// stopped recognising these stubs (run 27371848400: +32k "missing bundle"
// false regressions, all "Pagina spostata" stubs at legacy-TI job paths).
//
// Uppercase so it survives HTML minification (same lesson as
// EJP_STRIPPED_MARKER: lowercase comments get stripped). Plain `.mjs` so the
// Node-run auditor (scripts/, no tsx loader) can import it directly; the TS
// build-plugins import it via ./redirectStubMarker.ts which re-exports this
// value. The literal must stay byte-identical everywhere — define it ONCE,
// here.
export const REDIRECT_STUB_MARKER = '<!--REDIRECT_STUB-->';
