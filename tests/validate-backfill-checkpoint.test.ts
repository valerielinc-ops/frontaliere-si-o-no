// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const script = path.resolve('scripts/ci/validate-backfill-checkpoint.mjs');

function fixture({
  active = JSON.stringify({ crawlerKey: 'alpha', assembledAt: '2026-11-16T08:00:00.000Z', jobs: [] }) + '\n',
  expired = '[]\n',
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-checkpoint-'));
  const activeDir = path.join(root, 'data/jobs/by-crawler');
  const expiredDir = path.join(root, 'data/jobs/expired/by-crawler');
  fs.mkdirSync(activeDir, { recursive: true });
  fs.mkdirSync(expiredDir, { recursive: true });
  fs.writeFileSync(path.join(activeDir, 'alpha.json'), active);
  fs.writeFileSync(path.join(expiredDir, 'alpha.json'), expired);
  return root;
}

function run(root: string, crawlerKeys?: string) {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: 'utf8',
    env: crawlerKeys === undefined ? undefined : { ...process.env, CRAWLER_KEYS: crawlerKeys },
  });
}

describe('validate-backfill-checkpoint', () => {
  it('accepts active slices and expired arrays with parsable dates', () => {
    const root = fixture({
      active: JSON.stringify({
        crawlerKey: 'alpha',
        assembledAt: '2026-11-16T08:00:00.000Z',
        jobs: [{ id: 'a', slug: 'alpha' }],
      }) + '\n',
      expired: JSON.stringify([{ slug: 'old-alpha', expiredAt: '2026-11-16T08:00:00.000Z' }]) + '\n',
    });
    try {
      const result = run(root);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('raw slices are safe to checkpoint');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a malformed active slice and an unorderable expired entry', () => {
    const root = fixture({
      active: JSON.stringify([{ id: 'a', slug: 'alpha' }]) + '\n',
      expired: JSON.stringify([{ expiredAt: '2026-11-16T08:00:00.000Z' }]) + '\n',
    });
    try {
      const result = run(root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('active/alpha.json: expected an object with a jobs array');
      expect(result.stderr).toContain('expired/alpha.json[0]: requires a non-empty slug route identity');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an active slice owned by another crawler', () => {
    const root = fixture({
      active: JSON.stringify({ crawlerKey: 'beta', assembledAt: '2026-11-16T08:00:00.000Z', jobs: [] }) + '\n',
    });
    try {
      const result = run(root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("active/alpha.json: crawlerKey must equal 'alpha'");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an unrecognised JSON file in the expired slice directory', () => {
    const root = fixture();
    fs.writeFileSync(
      path.join(root, 'data/jobs/expired/by-crawler', 'alpha-locale-cache.json'),
      '[]\n',
    );
    try {
      const result = run(root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('not a recognised crawler slice or shard');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('scopes intermediate validation to the requested crawler keys', () => {
    const root = fixture();
    fs.writeFileSync(
      path.join(root, 'data/jobs/by-crawler', 'beta.json'),
      '{"jobs":null}\n',
    );
    try {
      const result = run(root, 'alpha');
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('0 active rows');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
