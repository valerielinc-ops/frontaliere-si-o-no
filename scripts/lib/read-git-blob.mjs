import { execFileSync } from 'node:child_process';

export function readGitBlob(ref, file) {
  const object = `${ref}:${file}`;
  // Generated datasets exceed Node's default 1 MiB output buffer. Git reports
  // the byte size, including multibyte text, before the full blob is read.
  const bytes = Number(execFileSync('git', ['cat-file', '-s', object], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim());
  return execFileSync('git', ['show', object], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: Math.max(1024 * 1024, bytes + 1),
  });
}
