import fs from 'node:fs';
import path from 'node:path';

/** Filesystem errors that mean an optional HTML probe has no readable page. */
export function isMissingOrNotDirectoryError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Raised before a file/directory path collision can reach the filesystem. */
export class DistPathCollisionError extends Error {
  readonly blockingPath: string;
  readonly attemptedPath: string;

  constructor(blockingPath: string, attemptedPath: string, reason: string) {
    super(
      `[dist-path-collision] ${reason}: ${attemptedPath} conflicts with ${blockingPath}`,
    );
    this.name = 'DistPathCollisionError';
    this.blockingPath = blockingPath;
    this.attemptedPath = attemptedPath;
  }
}

/**
 * Detects a file emitted at an ancestor path of another emitted file.
 *
 * The check is intentionally string-only and batch-scoped: it runs before any
 * mkdir/write call, so a malformed batch fails without touching the output.
 * Exact duplicate paths are valid and are handled by WriteCollector's
 * last-write-wins semantics.
 */
export function assertNoFileDirectoryPathCollisions(paths: readonly string[]): void {
  const normalized = new Set(paths.map((filePath) => path.resolve(filePath)));

  for (const attemptedPath of normalized) {
    let blockingPath = path.dirname(attemptedPath);
    while (blockingPath !== attemptedPath) {
      if (normalized.has(blockingPath)) {
        throw new DistPathCollisionError(
          blockingPath,
          attemptedPath,
          'un file è previsto anche come directory',
        );
      }
      const parent = path.dirname(blockingPath);
      if (parent === blockingPath) break;
      blockingPath = parent;
    }
  }
}

/**
 * Fail early when an output file is blocked by an existing directory or file
 * ancestor. A missing target is valid: its parent will be created by the
 * writer. ENOTDIR here is the on-disk form of the same collision invariant.
 */
export function assertDistFilePathAvailable(filePath: string): void {
  const resolved = path.resolve(filePath);
  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      throw new DistPathCollisionError(
        resolved,
        resolved,
        'il percorso di output esiste già come directory',
      );
    }
  } catch (error) {
    if (error instanceof DistPathCollisionError) throw error;
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return;
    if (code === 'ENOTDIR') {
      throw new DistPathCollisionError(
        resolved,
        resolved,
        'un antenato del percorso di output è un file',
      );
    }
    throw error;
  }
}
