import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_COVER_BYTES = 16 * 1024 * 1024;

export function readPublishedBlogCoverBytes(root, imageUrl, { rejectInvalidPath = false } = {}) {
  const relative = `public/${String(imageUrl).replace(/^\/+/, '')}`;
  const expectedRoot = path.resolve(root, 'public/images/blog');
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(`${expectedRoot}${path.sep}`)) {
    if (rejectInvalidPath) throw new Error(`Refusing non-blog cover path: ${imageUrl}`);
    return null;
  }
  if (fs.existsSync(absolute)) return fs.readFileSync(absolute);
  try {
    // Treeless partial clones may have the commit but not its tree objects
    // materialised yet. Resolve the path to a blob object first so Git can
    // lazily fetch the missing tree before reading the blob itself.
    const objectId = execFileSync('git', ['rev-parse', '--verify', `HEAD:${relative}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!/^[0-9a-f]{40}$/.test(objectId)) return null;
    return execFileSync('git', ['cat-file', 'blob', objectId], {
      cwd: root,
      maxBuffer: MAX_COVER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}
