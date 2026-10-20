import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    const timeoutPath = path.join(binDir, 'timeout');
    const npxPath = path.join(binDir, 'npx');
    const markerPath = path.join(tempDir, 'side-effects.txt');
    const entrypointPath = path.join(tempDir, 'entrypoint.mjs');
    const wrapperPath = path.resolve('scripts/ci/run-pinned-tsx.sh');

    mkdirSync(binDir);
    writeFileSync(timeoutPath, `#!/usr/bin/env bash
set -euo pipefail
shift 2
exec "$@"
`);
    chmodSync(timeoutPath, 0o755);
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
appendFileSync(process.env.SIDE_EFFECT_MARKER, 'published\\n');
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

  it('allows a longer entrypoint timeout while keeping the npm probe timeout unchanged', () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'run-pinned-tsx-timeout-'));
    const binDir = path.join(tempDir, 'bin');
    const timeoutPath = path.join(binDir, 'timeout');
    const npxPath = path.join(binDir, 'npx');
    const timeoutMarkerPath = path.join(tempDir, 'timeouts.txt');
    const entrypointPath = path.join(tempDir, 'entrypoint.mjs');
    const wrapperPath = path.resolve('scripts/ci/run-pinned-tsx.sh');

    mkdirSync(binDir);
    writeFileSync(timeoutPath, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$2" >> "$TIMEOUT_MARKER"
shift 2
exec "$@"
`);
    chmodSync(timeoutPath, 0o755);
    writeFileSync(npxPath, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$#" -ge 3 && "$3" == "--version" ]]; then exit 0; fi
exit 0
`);
    chmodSync(npxPath, 0o755);
    writeFileSync(entrypointPath, '');

    const result = spawnSync('bash', [wrapperPath, entrypointPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        PINNED_TSX_ENTRYPOINT_TIMEOUT_SECONDS: '1800',
        TIMEOUT_MARKER: timeoutMarkerPath,
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(timeoutMarkerPath, 'utf8').trim().split('\n')).toEqual(['120s', '1800s']);
  });
});
