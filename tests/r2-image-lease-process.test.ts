// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const HELPER = resolve(ROOT, 'scripts/lib/r2-image-lease-process.sh');

describe('R2 image lease timeout process cleanup', () => {
  it('clears the reaped child PID and PGID while preserving the child exit status', () => {
    const helper = readFileSync(HELPER, 'utf8');
    expect(helper).toMatch(/wait "\$timeout_pid" \|\| timeout_status=\$\?\s+_R2_IMAGE_LEASE_TIMEOUT_PID= _R2_IMAGE_LEASE_TIMEOUT_PGID=/u);

    const output = execFileSync('/bin/bash', ['-c', `
      source "$1"
      _R2_IMAGE_LEASE_ACTIVE=1
      _R2_IMAGE_LEASE_TIMEOUT_PID=
      _R2_IMAGE_LEASE_TIMEOUT_PGID=
      _R2_IMAGE_LEASE_RELEASE_ALLOWED=1
      status=0
      _r2_image_lease_wait_timeout python3 -c 'import os, sys, time; os.setsid(); time.sleep(0.25); sys.exit(37)' || status=$?
      printf 'status=%s pid=%s pgid=%s\\n' "$status" "$_R2_IMAGE_LEASE_TIMEOUT_PID" "$_R2_IMAGE_LEASE_TIMEOUT_PGID"
    `, 'test-r2-image-lease-process', HELPER], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 5_000,
    });

    expect(output.trim()).toBe('status=37 pid= pgid=');
  });
});
