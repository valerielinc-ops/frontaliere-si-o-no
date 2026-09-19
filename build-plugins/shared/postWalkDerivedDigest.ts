import fs from 'node:fs';
import path from 'node:path';

import { getBuildGeneration, getPathHistory, hashContent } from '../sharedWriteRegistry';

export const POST_WALK_DERIVED_SIDECAR_VERSION = 2;
export const POST_WALK_DERIVED_SIDECAR_FILE = 'post-walk-derived-v2.jsonl';
export const POST_WALK_UNMANIFESTED_SIDECAR_VERSION = 1;
export const POST_WALK_UNMANIFESTED_SIDECAR_FILE = 'post-walk-unmanifested-v1.json';

const DERIVED_KINDS = ['bridge', 'blog'] as const;
export type PostWalkDerivedKind = (typeof DERIVED_KINDS)[number];

export type PostWalkDerivedDigestRecord = {
  readonly path: string;
  readonly kind: PostWalkDerivedKind;
  /** Hash of the upstream bytes before the post-walk transform. */
  readonly inputHash: string | null;
  /** Path of the source whose change also invalidates this derived output. */
  readonly sourcePath: string;
  /** Hash of the source dependency before the post-walk transform. */
  readonly sourceHash: string | null;
  /** Bump when the corresponding transform/template changes. */
  readonly templateHash: string;
};

type LoadedSidecar = ReadonlyMap<string, PostWalkDerivedDigestRecord>;

const templateHashes: Readonly<Record<PostWalkDerivedKind, string>> = {
  bridge: 'flat-bridge@1',
  blog: 'contextual-blog-links@1',
};

const sidecarCache = new Map<string, LoadedSidecar>();
const preservedByRoot = new Map<string, Set<string>>();
let preservedBuildGeneration = -1;

function sidecarPath(rootDir: string): string {
  return path.join(
    path.resolve(rootDir),
    '.cache',
    'incremental-manifest',
    POST_WALK_DERIVED_SIDECAR_FILE,
  );
}

function relativePath(distDir: string, filePath: string): string {
  return path.relative(distDir, filePath).split(path.sep).join('/');
}

function normalizeRecord(value: unknown): PostWalkDerivedDigestRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.path !== 'string'
    || !record.path
    || !DERIVED_KINDS.includes(record.kind as PostWalkDerivedKind)
    || (record.inputHash !== null && typeof record.inputHash !== 'string')
    || typeof record.sourcePath !== 'string'
    || !record.sourcePath
    || (record.sourceHash !== null && typeof record.sourceHash !== 'string')
    || typeof record.templateHash !== 'string'
  ) return null;
  const kind = record.kind as PostWalkDerivedKind;
  if (record.templateHash !== templateHashes[kind]) return null;
  return {
    path: record.path,
    kind,
    inputHash: record.inputHash as string | null,
    sourcePath: record.sourcePath,
    sourceHash: record.sourceHash as string | null,
    templateHash: record.templateHash,
  };
}

function readSidecar(file: string): LoadedSidecar {
  if (!fs.existsSync(file)) return new Map();
  try {
    const records = new Map<string, PostWalkDerivedDigestRecord>();
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    const header = lines.shift()?.trim();
    if (!header) return new Map();
    const parsedHeader = JSON.parse(header) as Record<string, unknown>;
    if (
      parsedHeader.type !== 'header'
      || parsedHeader.version !== POST_WALK_DERIVED_SIDECAR_VERSION
      || parsedHeader.format !== 'jsonl'
    ) return new Map();
    let footerCount: number | null = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.type === 'footer') {
        if (footerCount !== null || !Number.isInteger(parsed.count)) return new Map();
        footerCount = parsed.count as number;
        continue;
      }
      if (parsed.type !== 'derived') return new Map();
      const record = normalizeRecord(parsed);
      if (!record || records.has(record.path)) return new Map();
      records.set(record.path, record);
    }
    if (footerCount !== records.size) return new Map();
    return records;
  } catch {
    // A stale/partial cache is a safe miss: the normal verifier/full path
    // repopulates it after the build.
    return new Map();
  }
}

export function postWalkDerivedTemplateHash(kind: PostWalkDerivedKind): string {
  return templateHashes[kind];
}

export function loadPostWalkDerivedDigestSidecar(rootDir: string): LoadedSidecar {
  const root = path.resolve(rootDir);
  const cached = sidecarCache.get(root);
  if (cached) return cached;
  const loaded = readSidecar(sidecarPath(root));
  sidecarCache.set(root, loaded);
  return loaded;
}

export function latestClaimHash(filePath: string): string | null {
  const versions = getPathHistory().get(filePath);
  return versions && versions.length > 0
    ? versions[versions.length - 1].contentHash
    : null;
}

function inferCurrentDerivedKind(distDir: string, filePath: string): PostWalkDerivedKind | null {
  const baseName = path.basename(filePath);
  if (baseName === 'index.html' || baseName.startsWith('.') || !baseName.endsWith('.html')) {
    return null;
  }
  const siblingIndex = path.join(filePath.slice(0, -'.html'.length), 'index.html');
  return fs.existsSync(siblingIndex) ? 'bridge' : null;
}

/**
 * Called from WriteCollector before it queues an upstream file. When the
 * exact upstream bytes match the previous post-walk input and the transformed
 * output is still present, retaining that output avoids re-emitting it only
 * to have the coordinator read and rewrite it again.
 */
export function preservePostWalkDerivedOutput(
  distDir: string,
  filePath: string,
  content: string,
  currentKind?: PostWalkDerivedKind | null,
): boolean {
  if (process.env.POST_WALK_INCREMENTAL !== '1' || !distDir) return false;
  const buildGeneration = getBuildGeneration();
  if (buildGeneration !== preservedBuildGeneration) {
    preservedByRoot.clear();
    preservedBuildGeneration = buildGeneration;
  }
  const rootDir = path.resolve(distDir, '..');
  const record = loadPostWalkDerivedDigestSidecar(rootDir).get(relativePath(distDir, filePath));
  const effectiveKind = currentKind === undefined
    ? inferCurrentDerivedKind(distDir, filePath)
    : currentKind;
  if (
    !record
    || effectiveKind === null
    || record.kind !== effectiveKind
    || record.inputHash === null
    || record.sourceHash === null
    || !fs.existsSync(filePath)
  ) return false;
  if (record.inputHash !== hashContent(content)) return false;
  const sourceFilePath = path.join(distDir, record.sourcePath);
  if (latestClaimHash(sourceFilePath) !== record.sourceHash) return false;
  let preserved = preservedByRoot.get(rootDir);
  if (!preserved) {
    preserved = new Set();
    preservedByRoot.set(rootDir, preserved);
  }
  preserved.add(filePath);
  return true;
}

export function filterPostWalkDerivedDigestRecords(
  records: ReadonlyMap<string, PostWalkDerivedDigestRecord>,
  distDir: string,
  failures: ReadonlyArray<{ readonly filePath: string }>,
): ReadonlyMap<string, PostWalkDerivedDigestRecord> {
  if (failures.length === 0) return records;
  const failed = new Set(failures.map(({ filePath }) => relativePath(distDir, filePath)));
  return new Map([...records].filter(([relative]) => !failed.has(relative)));
}

export function wasPostWalkDerivedOutputPreserved(rootDir: string, filePath: string): boolean {
  return preservedByRoot.get(path.resolve(rootDir))?.has(filePath) ?? false;
}

export function writePostWalkDerivedDigestSidecar(
  rootDir: string,
  records: ReadonlyMap<string, PostWalkDerivedDigestRecord>,
): void {
  const target = sidecarPath(rootDir);
  const directory = path.dirname(target);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.mkdirSync(directory, { recursive: true });
  const lines = [
    JSON.stringify({
      type: 'header',
      version: POST_WALK_DERIVED_SIDECAR_VERSION,
      format: 'jsonl',
    }),
  ];
  const sorted = [...records.values()].sort((left, right) => left.path.localeCompare(right.path));
  for (const record of sorted) {
    lines.push(JSON.stringify({ type: 'derived', ...record }));
  }
  lines.push(JSON.stringify({ type: 'footer', count: sorted.length }));
  fs.writeFileSync(temporary, `${lines.join('\n')}\n`, 'utf-8');
  fs.renameSync(temporary, target);
}

function unmanifestedSidecarPath(rootDir: string): string {
  return path.join(
    path.resolve(rootDir),
    '.cache',
    'incremental-manifest',
    POST_WALK_UNMANIFESTED_SIDECAR_FILE,
  );
}

/** Returns null when the inventory is unavailable and [] when it is valid. */
export function loadPostWalkUnmanifestedTopLevels(rootDir: string): readonly string[] | null {
  const file = unmanifestedSidecarPath(rootDir);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    if (
      parsed.type !== 'post-walk-unmanifested'
      || parsed.version !== POST_WALK_UNMANIFESTED_SIDECAR_VERSION
      || !Array.isArray(parsed.topLevels)
      || parsed.topLevels.some((value) => typeof value !== 'string' || value.length === 0)
    ) return null;
    const distDir = path.join(path.resolve(rootDir), 'dist');
    const normalized = (parsed.topLevels as string[]).map((topLevel) => {
      // Version 1 recorded root-level files by filename (for example
      // `404.html`) even though the targeted walker accepts only directory
      // roots plus the <root> sentinel. Migrate an existing cache on load
      // when that filename is still a real root-level HTML file.
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
    });
    return [...new Set(normalized)].sort();
  } catch {
    return null;
  }
}

export function writePostWalkUnmanifestedTopLevels(
  rootDir: string,
  topLevels: Iterable<string>,
): void {
  const target = unmanifestedSidecarPath(rootDir);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const normalized = [...new Set(topLevels)].sort();
  fs.writeFileSync(
    temporary,
    `${JSON.stringify({
      type: 'post-walk-unmanifested',
      version: POST_WALK_UNMANIFESTED_SIDECAR_VERSION,
      topLevels: normalized,
    })}\n`,
    'utf-8',
  );
  fs.renameSync(temporary, target);
}

export function clearPostWalkDerivedDigestCacheForTest(): void {
  sidecarCache.clear();
  preservedByRoot.clear();
  preservedBuildGeneration = -1;
}
