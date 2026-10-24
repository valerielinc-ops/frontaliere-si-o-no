import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  checkOssScannerEnrollment,
  readRepositoryHead,
} from '../scripts/ci/check-oss-scanner-enrollment.mjs';

const ROOT = process.cwd();
const DOCKERFILE_PATH = `${ROOT}/.oss-scanner/Dockerfile`;
// The PR test job uses a sparse checkout that intentionally omits hidden
// build-context directories. Read the tracked blob directly when the path is
// absent so the contract still validates the PR head instead of the checkout
// profile.
const DOCKERFILE = existsSync(DOCKERFILE_PATH)
  ? readFileSync(DOCKERFILE_PATH, 'utf8')
  : execFileSync('git', ['show', 'HEAD:.oss-scanner/Dockerfile'], { cwd: ROOT, encoding: 'utf8' });

describe('FU-2026-10-21-009 — OSS Scanner recurring enrollment', () => {
  it('accepts the repository-owned written proof and exact checked-out commit', () => {
    const result = checkOssScannerEnrollment({
      repoRoot: ROOT,
      dockerfilePath: DOCKERFILE_PATH,
      dockerfileSource: DOCKERFILE,
    });

    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(result.record).toMatchObject({
      'approval-kind': 'written',
      'approval-ref': 'github:valerielinc-ops/frontaliere-si-o-no/issues/14549',
      'image-ref': 'dockerfile:.oss-scanner/Dockerfile',
      scanner: 'anthropic-oss-scanner',
      'source-contract': 'exact-commit',
    });
    expect(result.commit).toBe(readRepositoryHead(ROOT));
  });

  it.each([
    ['missing approval', DOCKERFILE.replace('# approval-kind: written\n', '')],
    ['wrong approval reference', DOCKERFILE.replace('issues/14549', 'issues/99999')],
    ['moving-ref Dockerfile', DOCKERFILE.replace('COPY .git/ /tmp/oss-scanner-git/', 'COPY . /src/')],
  ])('rejects %s', (_label, source) => {
    const result = checkOssScannerEnrollment({
      repoRoot: ROOT,
      dockerfilePath: DOCKERFILE_PATH,
      dockerfileSource: source,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects a runtime image contract or commit that does not match the proof', () => {
    const head = readRepositoryHead(ROOT);
    expect(head).toMatch(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
    const differentCommit = head === '0'.repeat(head.length)
      ? '1'.repeat(head.length)
      : '0'.repeat(head.length);

    const imageMismatch = checkOssScannerEnrollment({
      repoRoot: ROOT,
      dockerfilePath: DOCKERFILE_PATH,
      dockerfileSource: DOCKERFILE,
      imageContract: `sha256:${'0'.repeat(64)}`,
    });
    const commitMismatch = checkOssScannerEnrollment({
      repoRoot: ROOT,
      dockerfilePath: DOCKERFILE_PATH,
      dockerfileSource: DOCKERFILE,
      expectedCommit: differentCommit,
    });

    expect(imageMismatch.ok).toBe(false);
    expect(imageMismatch.errors.join('\n')).toContain('image contract');
    expect(commitMismatch.ok).toBe(false);
    expect(commitMismatch.errors.join('\n')).toContain('differs from checked-out HEAD');
  });
});
