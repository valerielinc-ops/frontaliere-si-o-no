#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeJobsSeoEmitterFingerprints,
  computeJobsSeoHtmlCacheFingerprint,
} from '../../build-plugins/shared/incrementalHtmlReuse.mjs';
import { readIncrementalManifestHeader } from '../../build-plugins/shared/incrementalManifest.mjs';

const SUPPORTED_LOCALES = new Set(['it', 'en', 'de', 'fr']);

/**
 * Select the exact previous HTML-cache key when output probing can validate a
 * renderer change. The manifest hash remains part of the workflow key, so the
 * restored pack still belongs to the exact manifest being read.
 */
export function resolveJobsSeoHtmlCacheFingerprintOutputs({
  repoRoot,
  locale,
  currentFingerprints,
  probeEnabled,
}) {
  const fingerprint = computeJobsSeoHtmlCacheFingerprint(currentFingerprints);
  let restoreFingerprint = fingerprint;
  let restoreSource = 'current';

  if (probeEnabled && SUPPORTED_LOCALES.has(locale)) {
    const previousManifestPath = path.join(
      repoRoot,
      '.cache',
      'incremental-manifest',
      `${locale}.jsonl`,
    );
    try {
      const previous = readIncrementalManifestHeader(previousManifestPath);
      const previousFingerprints = previous.jobsSeoEmitterFingerprint;
      if (
        previous.locale === locale
        && previousFingerprints
        && Object.keys(previousFingerprints).length > 0
      ) {
        restoreFingerprint = computeJobsSeoHtmlCacheFingerprint(previousFingerprints);
        restoreSource = 'previous-manifest';
      }
    } catch {
      // Cache restoration is optional. An unreadable/missing manifest falls
      // back to the current key and cannot relax HTML reuse validation.
    }
  }

  return {
    fingerprint,
    restore_fingerprint: restoreFingerprint,
    restore_source: restoreSource,
  };
}

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const fingerprints = computeJobsSeoEmitterFingerprints(repoRoot);
  const locale = process.env.JOBS_SEO_HTML_CACHE_LOCALE;
  const outputs = resolveJobsSeoHtmlCacheFingerprintOutputs({
    repoRoot,
    locale,
    currentFingerprints: fingerprints,
    probeEnabled: process.env.JOBS_SEO_REUSE_PROBE === '1',
  });
  if (locale) {
    console.error(`[jobs-seo-html-cache] restore-source=${outputs.restore_source} locale=${locale}`);
  }
  process.stdout.write(
    `fingerprint=${outputs.fingerprint}\n`
    + `restore_fingerprint=${outputs.restore_fingerprint}\n`
    + `restore_source=${outputs.restore_source}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
