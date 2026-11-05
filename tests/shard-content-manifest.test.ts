import { createHash } from 'node:crypto';
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSectionManifest } from '../scripts/ci/shard-content-manifest.mjs';

let tempDir: string;
let shardRoot: string;
// SHA-256 of exactly 2 GiB + 1 zero bytes, matching the sparse fixture below.
const LARGE_SPARSE_ZERO_SHA256 = 'b8030a8ab89280935633d8d991da3d9907c0f12e8b6fc3bfc515f4d440872b6e';

function makeManifest(tarPath: string) {
  return createSectionManifest({
    root: shardRoot,
    prefix: 'friburgo',
    locale: 'it',
    section: 'friburgo',
    sourceRunId: '41940430871',
    sourceSha: 'a'.repeat(40),
    artifactRunId: '41940430871',
    tarPath,
  });
}

describe('shard-content-manifest file digests', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'shard-content-manifest-'));
    shardRoot = join(tempDir, 'shard');
    mkdirSync(shardRoot);
    writeFileSync(join(shardRoot, 'index.html'), '<html>shard</html>');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('preserves the SHA-256 digest for ordinary files', () => {
    const tarPath = join(tempDir, 'shard.tar');
    const contents = Buffer.from('tar bytes');
    writeFileSync(tarPath, contents);

    const manifest = makeManifest(tarPath);

    expect(manifest.tarSha256).toBe(createHash('sha256').update(contents).digest('hex'));
  });

  it('hashes tar files larger than Node can read into one Buffer', () => {
    const tarPath = join(tempDir, 'large-shard.tar');
    const fd = openSync(tarPath, 'w');
    try {
      // Sparse fixture crosses fs.readFileSync's 2 GiB Buffer limit without
      // allocating a multi-gigabyte file on disk.
      ftruncateSync(fd, 2 * 1024 * 1024 * 1024 + 1);
    } finally {
      closeSync(fd);
    }

    const manifest = makeManifest(tarPath);

    expect(manifest.tarSha256).toBe(LARGE_SPARSE_ZERO_SHA256);
  }, 120_000);
});
