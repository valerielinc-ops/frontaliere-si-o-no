import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export const POST_WALK_WALK_INVENTORY_VERSION = 1;
export const POST_WALK_WALK_INVENTORY_FILE = 'post-walk-walk-inventory-v1.jsonl';

export type PostWalkWalkInventory = {
  /** Every walkable dist top-level seen by the completed walk. */
  readonly topLevels: readonly string[];
  /** Top-levels containing paths absent from the producer manifest. */
  readonly unmanifestedTopLevels: readonly string[];
  /** Paths claimed by upstream emitters in the completed build. */
  readonly claimedPaths: readonly string[];
  /** Exact walkable paths not covered by the producer manifest. */
  readonly unmanifestedPaths: readonly string[];
};

export type PostWalkWalkInventoryInput = {
  readonly topLevels: Iterable<string>;
  readonly unmanifestedTopLevels: Iterable<string>;
  readonly claimedPaths: Iterable<string>;
  readonly unmanifestedPaths: Iterable<string>;
};

function inventoryPath(rootDir: string): string {
  return path.join(
    path.resolve(rootDir),
    '.cache',
    'incremental-manifest',
    POST_WALK_WALK_INVENTORY_FILE,
  );
}

function normalizeTopLevel(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value === '<root>') return value;
  if (value.includes('/') || value.includes('\\') || value === '.' || value === '..') return null;
  return value;
}

function migrateLegacyRootFileTopLevel(distDir: string, topLevel: string): string {
  if (
    topLevel !== '<root>'
    && topLevel.endsWith('.html')
    && !topLevel.includes('/')
    && !topLevel.includes('\\')
  ) {
    try {
      if (fs.statSync(path.join(distDir, topLevel)).isFile()) return '<root>';
    } catch {
      // A missing legacy root file is safe to leave as a directory name;
      // the targeted walker will skip it when it is absent.
    }
  }
  return topLevel;
}

function normalizeRelativePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const normalized = value.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.startsWith('../') || normalized.includes('/../')) return null;
  if (!normalized.endsWith('.html')) return null;
  return normalized;
}

function normalizePathInput(distDir: string, value: string): string | null {
  const relative = path.isAbsolute(value)
    ? path.relative(distDir, value)
    : value;
  return normalizeRelativePath(relative);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function validTopLevels(values: unknown): values is string[] {
  return Array.isArray(values)
    && values.every((value) => normalizeTopLevel(value) !== null);
}

/**
 * Load the walk inventory without splitting the whole JSONL file in memory.
 * A missing, partial, or invalid inventory is a safe miss and lets the
 * coordinator use its full-walk fallback.
 */
export async function loadPostWalkWalkInventory(
  rootDir: string,
): Promise<PostWalkWalkInventory | null> {
  const file = inventoryPath(rootDir);
  const distDir = path.join(path.resolve(rootDir), 'dist');
  if (!fs.existsSync(file)) return null;

  const claimedPaths: string[] = [];
  const unmanifestedPaths: string[] = [];
  const seenPaths = new Set<string>();
  let topLevels: string[] | null = null;
  let unmanifestedTopLevels: string[] | null = null;
  let footer: { claimed: number; unmanifested: number } | null = null;

  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.type === 'header') {
        if (
          record.version !== POST_WALK_WALK_INVENTORY_VERSION
          || record.format !== 'jsonl'
          || !validTopLevels(record.topLevels)
          || !validTopLevels(record.unmanifestedTopLevels)
        ) return null;
        topLevels = uniqueSorted(
          record.topLevels.map((value) => migrateLegacyRootFileTopLevel(distDir, value)),
        );
        unmanifestedTopLevels = uniqueSorted(
          record.unmanifestedTopLevels.map((value) => migrateLegacyRootFileTopLevel(distDir, value)),
        );
        continue;
      }
      if (record.type === 'path') {
        if (record.kind !== 'claimed' && record.kind !== 'unmanifested') return null;
        const relative = normalizeRelativePath(record.path);
        if (relative === null || seenPaths.has(`${record.kind}\u0000${relative}`)) return null;
        seenPaths.add(`${record.kind}\u0000${relative}`);
        (record.kind === 'claimed' ? claimedPaths : unmanifestedPaths).push(relative);
        continue;
      }
      if (record.type === 'footer') {
        if (
          footer !== null
          || !Number.isInteger(record.claimed)
          || !Number.isInteger(record.unmanifested)
        ) return null;
        footer = {
          claimed: record.claimed as number,
          unmanifested: record.unmanifested as number,
        };
        continue;
      }
      return null;
    }
  } catch {
    return null;
  } finally {
    lines.close();
    input.destroy();
  }

  if (
    topLevels === null
    || unmanifestedTopLevels === null
    || footer === null
    || footer.claimed !== claimedPaths.length
    || footer.unmanifested !== unmanifestedPaths.length
  ) return null;

  return {
    topLevels,
    unmanifestedTopLevels,
    claimedPaths: claimedPaths.sort(),
    unmanifestedPaths: unmanifestedPaths.sort(),
  };
}

async function writeLine(stream: fs.WriteStream, line: string): Promise<void> {
  if (stream.write(line)) return;
  await new Promise<void>((resolve) => stream.once('drain', resolve));
}

/** Persist the exact path inputs used to replace the next full filesystem walk. */
export async function writePostWalkWalkInventory(
  rootDir: string,
  distDir: string,
  input: PostWalkWalkInventoryInput,
): Promise<void> {
  const target = inventoryPath(rootDir);
  const temporary = `${target}.${process.pid}.tmp`;
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });

  const topLevels = uniqueSorted(
    [...input.topLevels]
      .map(normalizeTopLevel)
      .filter((value): value is string => value !== null),
  ).map((value) => migrateLegacyRootFileTopLevel(distDir, value));
  const unmanifestedTopLevels = uniqueSorted(
    [...input.unmanifestedTopLevels]
      .map(normalizeTopLevel)
      .filter((value): value is string => value !== null),
  ).map((value) => migrateLegacyRootFileTopLevel(distDir, value));
  const claimed = uniqueSorted(
    [...input.claimedPaths]
      .map((value) => normalizePathInput(distDir, value))
      .filter((value): value is string => value !== null),
  );
  const claimedSet = new Set(claimed);
  const unmanifested = uniqueSorted(
    [...input.unmanifestedPaths]
      .map((value) => normalizePathInput(distDir, value))
      .filter((value): value is string => value !== null && !claimedSet.has(value)),
  );

  const stream = fs.createWriteStream(temporary, { encoding: 'utf8' });
  const finished = new Promise<void>((resolve, reject) => {
    stream.once('finish', resolve);
    stream.once('error', reject);
  });
  try {
    await writeLine(stream, `${JSON.stringify({
      type: 'header',
      version: POST_WALK_WALK_INVENTORY_VERSION,
      format: 'jsonl',
      topLevels,
      unmanifestedTopLevels,
    })}\n`);
    for (const relative of claimed) {
      await writeLine(stream, `${JSON.stringify({ type: 'path', kind: 'claimed', path: relative })}\n`);
    }
    for (const relative of unmanifested) {
      await writeLine(stream, `${JSON.stringify({ type: 'path', kind: 'unmanifested', path: relative })}\n`);
    }
    await writeLine(stream, `${JSON.stringify({
      type: 'footer',
      claimed: claimed.length,
      unmanifested: unmanifested.length,
    })}\n`);
    stream.end();
    await finished;
    fs.renameSync(temporary, target);
  } catch (error) {
    stream.destroy();
    try {
      fs.unlinkSync(temporary);
    } catch {
      // A partial cache is a safe miss; preserve the build's primary result.
    }
    throw error;
  }
}
