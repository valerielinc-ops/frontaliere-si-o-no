/**
 * borderMunicipalityCorridors.ts — single source of truth for the Ticino
 * "vivere a {comune}" corridor province set (issue #4893).
 *
 * Was a private `TICINO_CORRIDOR_PROVINCES` literal inside
 * borderMunicipalityPagesPlugin.ts. Extracted so fiscalMunicipalityPagesPlugin.ts
 * can check "is this comune inside the Ticino vivere-a corridor?" without
 * copy-pasting the same province list (AGENTS.md rule #6: a constant
 * duplicated across >=2 files must live in ONE shared module — the drift
 * risk here is concrete: fiscalMunicipalityPagesPlugin.ts unconditionally
 * cross-links to a "vivere a {comune}" page for every above-floor fiscal
 * comune; issue #4893 widened the FISCAL corridor to all 11 Italian
 * border provinces while deliberately leaving the "vivere a" page family
 * Ticino-only (its content — commute times to Mendrisio/Lugano/Locarno — is
 * irreducibly Ticino-specific, unlike the fiscal addizionale-comunale
 * content). Without this shared Set, the fiscal plugin could not tell which
 * of its now-198-province-wider comuni still have a live "vivere a" target
 * and which would 404).
 */

/**
 * Provinces whose comuni get a "vivere a {comune} e lavorare in Ticino"
 * page (borderMunicipalityPagesPlugin.ts). Kept intentionally narrower than
 * the fiscal corridor (scripts/build-fiscal-municipalities.mjs) — see that
 * script's CORRIDOR CRITERION doc comment for the full rationale on why the
 * two corridors are allowed to diverge.
 */
export const TICINO_VITA_CORRIDOR_PROVINCES: ReadonlySet<string> = new Set(['CO', 'VA', 'VB']);
