import { readFileSync } from 'node:fs';

/**
 * Keep mocked `gh` calls observable when production uses `--body-file`.
 * GitHub CLI reads the file before the process returns; the test double must
 * do the same while the transport's temporary file is still alive.
 */
export function hydrateGhBodyFileArgs(args: string[]): string[] {
  const bodyFileIndex = args.indexOf('--body-file');
  if (bodyFileIndex < 0) return args;

  const bodyFile = args[bodyFileIndex + 1];
  if (!bodyFile) throw new Error('--body-file in mock gh call has no path');

  return [
    ...args.slice(0, bodyFileIndex),
    '--body',
    readFileSync(bodyFile, 'utf8'),
    ...args.slice(bodyFileIndex + 2),
  ];
}
