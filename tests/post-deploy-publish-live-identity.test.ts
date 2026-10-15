import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isExactBuildId,
  isNewerBuildId,
  verifyLiveBuildIdentity,
} from '../scripts/ci/verify-live-build-identity.mjs';

const SOURCE_REF_A = 'a'.repeat(40);

describe('post-deploy live build identity guard', () => {
  it('accepts only the exact source build-id', () => {
    expect(isExactBuildId('1718000000123', '1718000000123')).toBe(true);
    expect(isExactBuildId('1718000000123', '1718000000124')).toBe(false);
    expect(isExactBuildId('1718000000123', 'older')).toBe(false);
  });

  it('classifies only a numerically newer live build as the safe stale race', () => {
    expect(isNewerBuildId('1718000000123', '1718000000124')).toBe(true);
    expect(isNewerBuildId('1718000000123', '1718000000122')).toBe(false);
    expect(isNewerBuildId('1718000000123', 'malformed')).toBe(false);
  });

  it('rejects a newer live build before side-effects can be admitted', async () => {
    const verdict = await verifyLiveBuildIdentity({
      expectedBuildId: '1718000000123',
      sourceRef: SOURCE_REF_A,
      fetchBuildId: async () => ({ value: '1718000000124', status: 200, error: null }),
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.kind).toBe('stale');
    expect(verdict.reason).toMatch(/stale publisher source/);
    expect(verdict.expected).toBe('1718000000123');
    expect(verdict.live).toBe('1718000000124');
  });

  it('fails closed when the marker cannot be fetched', async () => {
    const verdict = await verifyLiveBuildIdentity({
      expectedBuildId: '1718000000123',
      sourceRef: SOURCE_REF_A,
      fetchBuildId: async () => ({ value: null, status: 503, error: 'unavailable' }),
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.kind).toBe('fetch-failure');
    expect(verdict.reason).toContain('HTTP 503');
  });
});

describe('post-deploy-publish.yml — live identity placement', () => {
  const workflow = readFileSync(
    resolve('.github/workflows/post-deploy-publish.yml'),
    'utf8',
  );

  it('runs the exact identity check before every irreversible publisher step', () => {
    const guard = workflow.indexOf('- name: Verify live build identity before post-deploy side effects');
    const firstSideEffect = workflow.indexOf('- name: Sync previous-slug winners registry');
    expect(guard).toBeGreaterThan(-1);
    expect(firstSideEffect).toBeGreaterThan(guard);

    const guardBlock = workflow.slice(guard, firstSideEffect);
    expect(guardBlock).toContain('verify-live-build-identity.mjs');
    expect(guardBlock).toContain('EXPECTED_BUILD_ID_FILE');
    expect(guardBlock).toContain('SOURCE_DEPLOY_REF');
    expect(guardBlock).toContain('id: live_identity');
    expect(guardBlock).toContain('--stale-policy=skip');

    for (const stepName of [
      'Sync previous-slug winners registry',
      'Post to LinkedIn Company Page',
      'Post to Reddit Communities',
      'Post-deploy indexing (parallel)',
      'Mark this deploy as last_known_good',
    ]) {
      const step = workflow.indexOf(`- name: ${stepName}`);
      expect(step, stepName).toBeGreaterThan(guard);
      const nextStep = workflow.indexOf('\n      - name:', step + 1);
      const stepBlock = workflow.slice(step, nextStep === -1 ? workflow.length : nextStep);
      expect(stepBlock, stepName).toContain("steps.live_identity.outputs.status == 'match'");
    }
  });
});
