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
 *   by scripts/lib/upload-cdn-file.sh, for missing content-addressed assets
 *   and a stable alias that is absent from both the CDN and R2.
 *   Stable aliases are never overwritten here: a stored or stale alias makes
 *   this gate fail closed until the full deploy repairs it.
 * Exit: 0 when every file is available, 1 otherwise (nothing may be pushed).
 */
import { listStaticScriptFiles } from '../../build-plugins/staticScriptsPlugin.ts';
import { appendFileSync } from 'node:fs';
import {
  ensureCdnShellAssets,
  shellAssetsFromStaticScripts,
  StaleStableAliasError,
} from '../lib/cdn-shell-assets.mjs';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { startPipelinePhase } from '../lib/pipeline-phase-timing.mjs';

export async function main({
  ensure = ensureCdnShellAssets,
  listFiles = listStaticScriptFiles,
  startTiming = startPipelinePhase,
} = {}) {
  const finishTiming = startTiming('fast-publish', 'ensure-cdn-shell-assets');
  let outcome = 'success';
  try {
    return await ensure({ assets: shellAssetsFromStaticScripts(listFiles()) });
  } catch (error) {
    if (process.env.DEFER_STALE_STABLE_ALIAS === 'true' && error instanceof StaleStableAliasError) {
      outcome = 'skipped';
      if (process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, 'deferred=true\n', 'utf8');
      }
      console.log(
        `::notice::[cdn-shell-assets] ${error.message}; ` +
        'automatic pre-deploy rerender deferred until the validated full deploy dispatches it again',
      );
      return { deferred: true, reason: error.code };
    }
    outcome = 'failure';
    throw error;
  } finally {
    finishTiming(outcome);
  }
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error(`::error::[cdn-shell-assets] ${error.message}`);
    process.exit(1);
  });
}
