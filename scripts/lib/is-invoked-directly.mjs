import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Return whether a module was started as the Node entry point rather than
 * imported by a test or another crawler.
 *
 * Keep the argv comparison in one place so crawler wrappers cannot drift
 * between URL-string and filesystem-path semantics.
 */
export function isInvokedDirectly(entryFileUrl, argvPath = process.argv[1]) {
  if (!argvPath) return false;
  try {
    const entryPath = fileURLToPath(entryFileUrl);
    const resolvedArgvPath = path.resolve(argvPath);
    try {
      return fs.realpathSync(entryPath) === fs.realpathSync(resolvedArgvPath);
    } catch {
      return entryPath === resolvedArgvPath;
    }
  } catch {
    return false;
  }
}
