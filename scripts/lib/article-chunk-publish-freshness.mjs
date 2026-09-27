#!/usr/bin/env node

// The section lock serializes writers, but it cannot make an older checkout
// current after main has moved. Keep that source comparison in one small,
// dependency-free helper so fast-publish and the resync workflow cannot
// implement different refresh rules.

export const GIT_SHA_RE = /^[0-9a-f]{40}$/iu;

function requireSha(value, name) {
  if (typeof value !== 'string' || !GIT_SHA_RE.test(value)) {
    throw new Error(`[article-chunk-publish-freshness] ${name} must be a 40-character Git SHA`);
  }
  return value.toLowerCase();
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

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error(`[article-chunk-publish-freshness] ${flag} requires a value`);
  }
  return args[index + 1];
}

function main(args = process.argv.slice(2)) {
  const sourceSha = flagValue(args, '--source-sha');
  const mainSha = flagValue(args, '--main-sha');
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
