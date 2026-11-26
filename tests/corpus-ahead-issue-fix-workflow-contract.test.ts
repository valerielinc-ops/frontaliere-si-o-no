import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(resolve(ROOT, '.github/workflows/issue-fix.yml'), 'utf8');

function stepBlock(name: string) {
  const marker = `      - name: ${name}`;
  const start = SOURCE.indexOf(marker);
  if (start < 0) return '';
  const end = SOURCE.indexOf('\n      - name:', start + marker.length);
  return SOURCE.slice(start, end < 0 ? SOURCE.length : end);
}

describe('issue fix workflow contract', () => {
  it('keeps per-issue serialization and the deterministic fixer entrypoint', () => {
    expect(SOURCE).toContain('Issue fix (Codex Luna Max');
    expect(SOURCE).toContain('per-issue');
  });

  it('freezes and verifies dispatch scope before every capability-bearing step', () => {
    const freeze = SOURCE.indexOf('      - name: Freeze issue-fix dispatch scope');
    const reject = SOURCE.indexOf('      - name: Reject stale issue-fix dispatch');
    expect(freeze).toBeGreaterThan(-1);
    expect(reject).toBeGreaterThan(freeze);
    expect(SOURCE.slice(reject, reject + 1200)).toContain(
      'run: node scripts/ci/check-issue-fix-dispatch.mjs --verify',
    );
    expect(SOURCE.slice(reject, reject + 1200)).toContain('DISPATCH_SCOPE_FINGERPRINT');
    expect(SOURCE).toContain('scripts/ci/check-issue-fix-dispatch.mjs');

    for (const name of [
      'Mint GitHub App token (zero-Claude, pre-npm)',
      'Pre-flight — Codex lane quota telemetry (pre-npm)',
      'Enforce shared quota-floor lease (fail-closed)',
      'Install dependencies',
      'Firebase SA per Remote Config (decisione 2026-08-24)',
      'Load secrets from Remote Config (decisione 2026-08-24)',
      'Pre-flight — in-progress claim gate (zero-Claude, mutex)',
      'Run Codex Luna Max fix',
    ]) {
      const block = stepBlock(name);
      expect(block, `${name} must exist`).toContain("steps.stale_dispatch.outputs.proceed == 'true'");
      expect(SOURCE.indexOf(`      - name: ${name}`)).toBeGreaterThan(reject);
    }
  });

  it('passes the frozen item to tier selection instead of rereading live scope', () => {
    const tier = stepBlock('Determine fix tier');
    expect(tier).toContain('DISPATCH_IS_DAILY');
    expect(tier).toContain('DISPATCH_DAILY_KEY');
    expect(tier).toContain('DISPATCH_ITEM_ID');
    expect(tier).toContain('never reselect from a live read here');
    expect(tier).not.toContain('selectFirstOpenItem');
    expect(tier).not.toContain('parseFollowupItems');
  });
});
