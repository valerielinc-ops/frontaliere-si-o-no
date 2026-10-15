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
    return execFileSync('git', ['cat-file', 'blob', `HEAD:${relative}`], {
      cwd: root,
      maxBuffer: MAX_COVER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}
