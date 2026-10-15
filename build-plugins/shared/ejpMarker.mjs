// ejpMarker.mjs
//
// Canonical audit:text-html-ratio skip marker — the SINGLE source of truth
// for the `<!--EJP_STRIPPED-->` literal. Deliberately-thin SEO shells
// (expired-job soft-landings, cluster/bridge/gsc-keyword thin bodies) embed
// this comment so scripts/audit-text-html-ratio.mjs knows the low word-count
// is intentional and skips the page. Uppercase so it survives HTML
// minification (the prior lowercase `<!--ejp-stripped-->` was being stripped,
// defeating the skip).
//
// This file is plain `.mjs` so the Node-run auditor (scripts/, no tsx loader,
// CI Node 20/22 without type-stripping) can import it directly. The TS
// build-plugins import it via ./ejpMarker.ts, which re-exports this value.
// The literal must stay byte-identical everywhere — define it ONCE, here.
export const EJP_STRIPPED_MARKER = '<!--EJP_STRIPPED-->';
