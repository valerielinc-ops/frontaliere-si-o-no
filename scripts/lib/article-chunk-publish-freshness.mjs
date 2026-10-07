#!/usr/bin/env node

import fs from 'node:fs';

// The section lock serializes writers, but it cannot make an older checkout
// current after main has moved. Keep that source comparison in one small,
// dependency-free helper so fast-publish and the resync workflow cannot
// implement different refresh rules.

export const GIT_SHA_RE = /^[0-9a-f]{40}$/iu;

// Keep this list in lockstep with the push trigger in the sync workflow. The
// workflow test compares the two lists so this safety decision cannot drift
// away from the event that schedules the replay.
export const ARTICLE_SURFACE_PATHS = Object.freeze([
  'packages/articles/content/**',
  'public/sitemap-news.xml',
  'public/rss*.xml',
  'public/news-ticker-live.json',
  '.github/workflows/sync-articles-sitemaps.yml',
]);

// The code that decides what the replay writes: the scripts its publishing
// steps run to build and upload, and the modules those load to choose keys
// and headers (the edge file table). A change to one of them alters the
// published objects even when no article surface moved, so a source checked
// out before that change is stale too. This is a separate list on purpose:
// the one above answers "which merged change needs a replay" and stays equal
// to the push trigger, this one answers "which change makes a replay already
// in flight stale". The freshness test keeps it complete from both ends: it
// walks from the scripts the publishing steps invoke through everything they
// import or spawn and requires exactly this list, and every file esbuild
// reads for a published chunk must be covered by one of the two lists.
//
// What that walk reaches without it deciding a written byte is named in the
// test, each entry with its reason: the cache purge (it evicts edge keys and
// stores nothing, so an older copy of it cannot leave older bytes at the
// edge; no script may name the purge script without its targeted flag
// anyway, see tests/cf-zone-purge-blast-radius.test.ts), the ticker
// computation the replay skips and the llms.txt generator it never requests.
export const ARTICLE_PUBLISHER_CODE_PATHS = Object.freeze([
  'scripts/publish-article-chunks.mjs',
  'scripts/publish-edge-files.mjs',
  'scripts/lib/upload-cdn-file.sh',
  'infra/cloudflare-worker/locale-router.js',
]);

export const PUBLISH_SOURCE_VERDICTS = Object.freeze({
  CURRENT: 'current',
  UNRELATED_ADVANCE: 'unrelated-advance',
  SUPERSEDED: 'superseded',
});

function requireSha(value, name) {
  if (typeof value !== 'string' || !GIT_SHA_RE.test(value)) {
    throw new Error(`[article-chunk-publish-freshness] ${name} must be a 40-character Git SHA`);
  }
  return value.toLowerCase();
}

function globToRegExp(pattern) {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
      continue;
    }
    source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${source}$`);
}

const ARTICLE_SURFACE_REGEXES = ARTICLE_SURFACE_PATHS.map(globToRegExp);
const ARTICLE_PUBLISHER_CODE_REGEXES = ARTICLE_PUBLISHER_CODE_PATHS.map(globToRegExp);

export function isArticleSurfacePath(changedPath) {
  return typeof changedPath === 'string'
    && ARTICLE_SURFACE_REGEXES.some((pattern) => pattern.test(changedPath));
}

/**
 * True for every path whose change alters what the replay publishes: the
 * article surfaces themselves and the code that builds and uploads them.
 */
export function isArticlePublishInputPath(changedPath) {
  return isArticleSurfacePath(changedPath)
    || (typeof changedPath === 'string'
      && ARTICLE_PUBLISHER_CODE_REGEXES.some((pattern) => pattern.test(changedPath)));
}

/**
 * Reports whether the already-rendered checkout matches the main tip observed
 * after the section lease was acquired. A false result is a refresh signal:
 * callers must re-render/reload origin/main before publishing, never silently
 * turn the article publish into a no-op.
 */
export function isCurrentPublishSource(sourceSha, mainSha) {
  return requireSha(sourceSha, 'source SHA') === requireSha(mainSha, 'main SHA');
}

/**
 * Classifies a source snapshot against main and the paths changed between the
 * two commits. A non-current source is safe only when neither an article
 * surface nor the publisher code changed; a missing path list is an error
 * rather than an optimistic answer.
 */
export function classifyPublishSource(sourceSha, mainSha, changedPaths) {
  const source = requireSha(sourceSha, 'source SHA');
  const main = requireSha(mainSha, 'main SHA');
  if (source === main) return PUBLISH_SOURCE_VERDICTS.CURRENT;
  if (!Array.isArray(changedPaths) || changedPaths.some((changedPath) => typeof changedPath !== 'string')) {
    throw new Error('[article-chunk-publish-freshness] changed paths must be an array of strings');
  }
  return changedPaths.some(isArticlePublishInputPath)
    ? PUBLISH_SOURCE_VERDICTS.SUPERSEDED
    : PUBLISH_SOURCE_VERDICTS.UNRELATED_ADVANCE;
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error(`[article-chunk-publish-freshness] ${flag} requires a value`);
  }
  return args[index + 1];
}

function optionalFlagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  return flagValue(args, flag);
}

function changedPathsFromFile(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch (error) {
    throw new Error(
      `[article-chunk-publish-freshness] cannot read changed paths: ${error?.message ?? error}`,
    );
  }
}

function main(args = process.argv.slice(2)) {
  const sourceSha = flagValue(args, '--source-sha');
  const mainSha = flagValue(args, '--main-sha');
  const changedPathsFile = optionalFlagValue(args, '--changed-paths-file');
  if (changedPathsFile) {
    const verdict = classifyPublishSource(sourceSha, mainSha, changedPathsFromFile(changedPathsFile));
    process.stdout.write(`${verdict}\n`);
    return;
  }
  process.stdout.write(`${isCurrentPublishSource(sourceSha, mainSha)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  }
}
