import { execFileSync } from 'node:child_process';

export function readGitBlob(ref, file, { encoding = 'utf8' } = {}) {
  const object = `${ref}:${file}`;
  // Generated datasets exceed Node's default 1 MiB output buffer. Git reports
  // the byte size, including multibyte text, before the full blob is read.
  const bytes = Number(execFileSync('git', ['cat-file', '-s', object], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim());
  return execFileSync('git', ['show', object], {
    encoding, stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: Math.max(1024 * 1024, bytes + 1),
  });
}

/**
 * `null` only when `file` is not a path of the tree of `ref`.
 *
 * Git answers 128 both for a path that is not there and for an object it
 * cannot read. The second is a broken or incomplete object store, not a file
 * that one side deleted: a three-way merge that read it as absent would drop
 * that side's content without a word.
 */
export function readGitBlobIfPresent(ref, file, options = {}) {
  try {
    return readGitBlob(ref, file, options);
  } catch (error) {
    if (error?.status !== 128) throw error;
    const listed = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', ref, '--', file], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).split('\0').includes(file);
    if (listed) throw error;
    return null;
  }
}
