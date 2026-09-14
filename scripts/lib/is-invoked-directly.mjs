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
    return fileURLToPath(entryFileUrl) === path.resolve(argvPath);
  } catch {
    return false;
  }
}
