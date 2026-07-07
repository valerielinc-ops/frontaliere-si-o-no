import os from 'node:os';
import path from 'node:path';

/**
 * Per-crawler-scoped scratch path — unique per companyKey, so it is never
 * shared with sibling crawlers running concurrently in the same
 * crawler-group CI job (post-#3701, ~25+ dedicated crawlers run as sibling
 * `background: true` steps in ONE job/filesystem). This eliminates the
 * cross-process race by construction: nothing else is ever written to this
 * path, so there is no read-modify-write cycle to serialize.
 *
 * Kept dependency-free (no imports besides node:os/node:path) so both
 * crawler-template.mjs and dedicated-crawler-common.mjs can import it
 * without creating a circular import between the two.
 *
 * @param {string} key
 * @returns {string}
 */
export function crawlerScratchPathFor(key) {
  return path.join(os.tmpdir(), `frontaliere-jobs-scratch-${key}.json`);
}
