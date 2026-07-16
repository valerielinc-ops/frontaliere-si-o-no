/**
 * email-cascade.mjs — re-export shim.
 *
 * Canonical implementation moved to functions/src/emailCascade.js on
 * 2026-07-16 so Cloud Functions (functions/src/*.js, functions/index.js) can
 * import sendEmailCascade directly — functions/ has no bundler, so it can
 * only import from within functions/, never from scripts/lib/* (the inverse
 * direction works fine, since scripts/ has no such boundary). Zero-import
 * module (only Node/web globals: fetch, URL, Buffer, console, process.env),
 * so the relocation carries no path-resolution risk.
 *
 * Edit functions/src/emailCascade.js, not this file — this file only
 * re-exports live bindings so every scripts/ caller and tests/*.test.ts
 * import path keeps working unchanged.
 */
export * from '../../functions/src/emailCascade.js';
