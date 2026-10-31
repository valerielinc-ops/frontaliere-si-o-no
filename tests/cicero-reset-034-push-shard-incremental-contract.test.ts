import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, "scripts/lib/push-article-shard-incremental.sh"), 'utf8');

describe('push-shard-incremental contract', () => {
  it('keeps the source-backed automation invariants explicit', () => {
    expect(SOURCE).toContain("MERGE-aware");
    expect(SOURCE).toContain("FULL-REPLACE");
  });

  it('reconciles the deploy-key path with the owner-aware HTTPS PAT fallback', () => {
    const keyResolutionStart = SOURCE.indexOf('key_var=');
    const keyResolutionEnd = SOURCE.indexOf('# A fast publisher renders');
    expect(keyResolutionStart).toBeGreaterThan(-1);
    expect(keyResolutionEnd).toBeGreaterThan(keyResolutionStart);
    expect(SOURCE.slice(keyResolutionStart, keyResolutionEnd)).not.toContain('exit 1');
    expect(SOURCE).toContain('SHARD_PUSH_TOKEN="$(shard_push_token_for_repo "$SHARD_REPO")"');
    expect(SOURCE).toContain('shard_remote="$(shard_https_push_url "$SHARD_REPO")"');
    expect(SOURCE).toContain('credential.helper=$_SHARD_CRED_HELPER');
    expect(SOURCE).toContain('no $key_var and no SHARD_PUSH_PAT/GITHUB_PAT credential');
  });
});
