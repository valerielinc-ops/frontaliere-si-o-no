#!/usr/bin/env node
/**
 * Fast-emitter step: every static shell script is on the CDN before any HTML
 * that references it is pushed (#12270). Rationale and logic:
 * scripts/lib/cdn-shell-assets.mjs.
 *
 * Runs under tsx, like the emitters it precedes: the files come from the
 * TypeScript module the full build writes them from
 * (build-plugins/staticScriptsPlugin.ts), read at the commit being published,
 * so the names checked here are the names that end up in the HTML.
 *
 * Usage:
 *   npx -y tsx@4.23.15 scripts/ci/ensure-cdn-shell-assets.mjs
 *
 * Env: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_S3_ENDPOINT, R2_BUCKET — read
 *   by scripts/lib/upload-cdn-file.sh, and only for a file the CDN did not serve.
 * Exit: 0 when every file is available, 1 otherwise (nothing may be pushed).
 */
import { listStaticScriptFiles } from '../../build-plugins/staticScriptsPlugin.ts';
import { ensureCdnShellAssets, shellAssetsFromStaticScripts } from '../lib/cdn-shell-assets.mjs';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';

export async function main({ ensure = ensureCdnShellAssets, listFiles = listStaticScriptFiles } = {}) {
  return ensure({ assets: shellAssetsFromStaticScripts(listFiles()) });
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error(`::error::[cdn-shell-assets] ${error.message}`);
    process.exit(1);
  });
}
