import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

describe('run-pinned-tsx', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('does not rerun an entrypoint after it has produced a side effect and failed', () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'run-pinned-tsx-'));
    const binDir = path.join(tempDir, 'bin');
    const npxPath = path.join(binDir, 'npx');
    const markerPath = path.join(tempDir, 'side-effects.txt');
    const entrypointPath = path.join(tempDir, 'entrypoint.mjs');
    const wrapperPath = path.resolve('scripts/ci/run-pinned-tsx.sh');

    writeFileSync(npxPath, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$#" -ge 3 && "$3" == "--version" ]]; then
  exit 0
fi
if [[ "$#" -lt 3 || "$1" != "--yes" || "$2" != "tsx@4.23.15" ]]; then
  exit 90
fi
exec node "$3" "\${@:4}"
`);
    chmodSync(npxPath, 0o755);
    writeFileSync(entrypointPath, `
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.SIDE_EFFECT_MARKER, 'published\n');
process.exit(17);
`);

    const result = spawnSync('bash', [wrapperPath, entrypointPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        SIDE_EFFECT_MARKER: markerPath,
      },
    });

    expect(result.status).toBe(17);
    expect(readFileSync(markerPath, 'utf8').split('\n').filter(Boolean)).toEqual(['published']);
  });
});
