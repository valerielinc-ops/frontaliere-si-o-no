import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const DOCKERFILE = execFileSync('git', ['show', 'HEAD:.oss-scanner/Dockerfile'], { encoding: 'utf8' });

describe('FU-2026-10-21-008 — OSS Scanner build contract', () => {
  it('uses the CI-sized builder and bounded heap', () => {
    expect(DOCKERFILE).toContain('FROM node:22-bookworm');
    expect(DOCKERFILE).toContain('FRONTALIERE_BUILD_MAX_OLD_SPACE_SIZE=14336');
    expect(DOCKERFILE).toContain('npm ci --no-audit --no-fund');
    expect(DOCKERFILE).toContain('npm run build:fast');
  });

  it('builds from the exact checked-out commit instead of a moving ref', () => {
    expect(DOCKERFILE).toContain('COPY .git/ /tmp/oss-scanner-git/');
    expect(DOCKERFILE).toContain('git -C /src fetch --quiet --no-tags --depth=1 origin "$commit"');
    expect(DOCKERFILE).toContain('git -C /src rev-parse HEAD)" = "$commit"');
  });
});
