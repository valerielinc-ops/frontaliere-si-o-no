import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const uploader = resolve(__dirname, '../../scripts/lib/upload-cdn-file.sh');
const tempDirs: string[] = [];

function writeExecutable(path: string, source: string) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function setup({ acquireFails = false, verifyFails = false, namespace = 'blog' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cdn-image-lease-'));
  tempDirs.push(dir);
  const binDir = join(dir, 'bin');
  mkdirSync(binDir);
  const eventsPath = join(dir, 'events.log');
  const localFile = join(dir, 'cover.webp');
  writeFileSync(localFile, 'test image bytes');
  const context = JSON.stringify({
    version: 1,
    leases: [{ namespace, owner: 'test-owner', leaseId: 'test-lease', expiresAt: 9_999_999_999_999 }],
  });

  writeExecutable(join(binDir, 'node'), `#!/bin/sh
case "$1" in
  */r2-image-namespace-lock.mjs)
    shift
    action="$1"
    shift
    namespace=""
    case "$action" in
      acquire|verify)
        [ "\${1:-}" = "--namespace" ] || exit 92
        namespace="\${2:-}"
        printf '%s:%s\\n' "$action" "$namespace" >> "$LEASE_TEST_EVENTS"
        ;;
      *) printf '%s\\n' "$action" >> "$LEASE_TEST_EVENTS" ;;
    esac
    case "$action" in
      acquire)
        ${acquireFails ? 'exit 1' : `printf '%s\\n' '${context}'`}
        ;;
      verify)
        ${verifyFails ? 'exit 1' : 'exit 0'}
        ;;
      release) exit 0 ;;
      *) exit 90 ;;
    esac
    ;;
  *) echo "unexpected node command" >&2; exit 91 ;;
esac
`);
  writeExecutable(join(binDir, 'rclone'), `#!/bin/sh
printf 'copy\\n' >> "$LEASE_TEST_EVENTS"
exit 0
`);
  writeExecutable(join(binDir, 'timeout'), `#!/bin/sh
if [ "$1" = "-k" ]; then shift 2; fi
shift
exec "$@"
`);

  return {
    dir,
    eventsPath,
    localFile,
    context,
    env: {
      PATH: `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      LEASE_TEST_EVENTS: eventsPath,
      RUNNER_TEMP: dir,
      R2_ACCESS_KEY_ID: 'test-access',
      R2_SECRET_ACCESS_KEY: 'test-secret',
      R2_S3_ENDPOINT: 'https://example.invalid',
      R2_BUCKET: 'test-bucket',
      R2_TIMEOUT_OBJECT_S: '5',
    },
  };
}

function runUpload(fixture: ReturnType<typeof setup>, key: string, context?: string) {
  return execFileSync('bash', [uploader, fixture.localFile, key], {
    encoding: 'utf8',
    env: {
      ...fixture.env,
      ...(context ? { FRONTALIERE_R2_IMAGE_LEASE_CONTEXT: context } : {}),
    },
  });
}

function events(fixture: ReturnType<typeof setup>) {
  try {
    return readFileSync(fixture.eventsPath, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('upload-cdn-file image namespace lease integration', () => {
  it.each([
    ['blog', 'images/blog/article/hero.webp'],
    ['places', 'images/places/lugano.webp'],
  ])(
    'acquires, verifies, uploads, and releases a standalone %s write',
    (namespace, key) => {
      const fixture = setup({ namespace });
      runUpload(fixture, key);
      expect(events(fixture)).toEqual([`acquire:${namespace}`, `verify:${namespace}`, 'copy', 'release']);
    },
  );

  it('validates and reuses a scoped caller lease without reacquiring or releasing it', () => {
    const fixture = setup();
    runUpload(fixture, 'images/blog/article/hero.webp', fixture.context);
    expect(events(fixture)).toEqual(['verify:blog', 'copy']);
  });

  it('skips the PUT when acquisition or caller verification fails', () => {
    const acquisitionFailure = setup({ acquireFails: true });
    runUpload(acquisitionFailure, 'images/blog/article/hero.webp');
    expect(events(acquisitionFailure)).toEqual(['acquire:blog']);

    const verificationFailure = setup({ verifyFails: true });
    runUpload(verificationFailure, 'images/blog/article/hero.webp', verificationFailure.context);
    expect(events(verificationFailure)).toEqual(['verify:blog']);
  });
});
