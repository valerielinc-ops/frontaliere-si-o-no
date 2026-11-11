import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createItShardGroupPlan,
  IT_SHARD_GROUP_IDS,
  validateItShardGroupPlan,
} from '../scripts/ci/it-shard-group-plan.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SLUGS = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/lib/section-shard-slugs.json'), 'utf8'));

function writeFiles(root: string, count: number) {
  fs.mkdirSync(root, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    fs.writeFileSync(path.join(root, `${index}.html`), `page ${index}`);
  }
}

describe('IT section shard group plan', () => {
  it('keeps Zurich and Switzerland alone and balances the remaining sections by file count', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'it-shard-groups-'));
    const dist = path.join(temp, 'dist');
    try {
      const sections = ['zurigo', 'svizzera', 'ticino', 'argovia', 'berna', 'ginevra', 'lucerna'];
      const sizes: Record<string, number> = {
        zurigo: 40,
        svizzera: 30,
        ticino: 20,
        argovia: 9,
        berna: 8,
        ginevra: 7,
        lucerna: 6,
      };
      for (const section of sections) writeFiles(path.join(dist, SLUGS[section].it), sizes[section]);

      const plan = createItShardGroupPlan({
        repoRoot: ROOT,
        distDir: dist,
        sections,
        sourceRunId: '12345',
        sourceSha: 'a'.repeat(40),
        buildId: '98765',
      });

      expect(plan.groups.map((group) => group.id)).toEqual(IT_SHARD_GROUP_IDS);
      expect(plan.groups.find((group) => group.id === 'zurigo')?.sections).toEqual(['zurigo']);
      expect(plan.groups.find((group) => group.id === 'svizzera')?.sections).toEqual(['svizzera']);
      expect(plan.groups.flatMap((group) => group.sections).sort()).toEqual([...sections].sort());
      expect(plan.fileCounts).toMatchObject(sizes);
      expect(validateItShardGroupPlan(plan, {
        sourceRunId: '12345',
        sourceSha: 'a'.repeat(40),
        buildId: '98765',
      })).toEqual({ valid: true, errors: [] });
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('rejects identity drift and duplicate or missing section assignment', () => {
    const plan = {
      schemaVersion: 1,
      kind: 'it-shard-push-group-plan',
      sourceRunId: '12345',
      sourceSha: 'a'.repeat(40),
      buildId: '98765',
      requiredSections: ['zurigo'],
      groups: IT_SHARD_GROUP_IDS.map((id) => ({
        id,
        sections: id === 'zurigo' ? ['zurigo'] : [],
        files: id === 'zurigo' ? 1 : 0,
      })),
    };
    expect(validateItShardGroupPlan(plan, { sourceRunId: '12345', sourceSha: 'b'.repeat(40) }).valid).toBe(false);
    plan.groups.find((group) => group.id === 'small-1')!.sections.push('zurigo');
    expect(validateItShardGroupPlan(plan).errors).toContain('group sections do not partition requiredSections');
  });

  it('fails closed when the required section set is empty', () => {
    expect(() => createItShardGroupPlan({
      repoRoot: ROOT,
      sections: [],
      sourceRunId: '12345',
      sourceSha: 'a'.repeat(40),
      buildId: '98765',
    })).toThrow('non-empty required section set');

    const emptyPlan = {
      schemaVersion: 1,
      kind: 'it-shard-push-group-plan',
      sourceRunId: '12345',
      sourceSha: 'a'.repeat(40),
      buildId: '98765',
      requiredSections: [],
      groups: IT_SHARD_GROUP_IDS.map((id) => ({ id, sections: [], files: 0 })),
    };
    expect(validateItShardGroupPlan(emptyPlan).errors).toContain('requiredSections is empty or missing');
  });

  it('fails a publisher group with an empty assignment before attempting a shard push', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'it-shard-empty-group-'));
    const planFile = path.join(temp, 'plan.json');
    const plan = {
      schemaVersion: 1,
      kind: 'it-shard-push-group-plan',
      sourceRunId: '12345',
      sourceSha: 'a'.repeat(40),
      buildId: '98765',
      requiredSections: ['ticino'],
      groups: IT_SHARD_GROUP_IDS.map((id) => ({
        id,
        sections: id === 'small-1' ? ['ticino'] : [],
        files: id === 'small-1' ? 1 : 0,
      })),
    };
    fs.writeFileSync(planFile, JSON.stringify(plan));
    try {
      let failure: any;
      try {
        execFileSync('bash', ['scripts/ci/push-it-shard-group.sh', 'zurigo'], {
          cwd: ROOT,
          env: {
            ...process.env,
            IT_SHARD_PLAN_FILE: planFile,
            SOURCE_RUN_ID: '12345',
            SOURCE_SHA: 'a'.repeat(40),
            DEPLOY_BUILD_ID: '98765',
            CDN_JOB_START_EPOCH: String(Math.floor(Date.now() / 1000)),
            RUNNER_TEMP: temp,
          },
          stdio: 'pipe',
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeDefined();
      expect(failure.status).toBe(2);
      expect(`${String(failure.stdout)}${String(failure.stderr)}`).toContain('has an empty assigned section set');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
