import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { archiveKey, restoreFromR2, saveToR2 } from '../scripts/ci/job-og-cache-r2.mjs';

const VERSION = 'v-test';
const A = 'ruolo-a.photo.no-logo.v-test.webp';
const B = 'ruolo-b.photo.abc123.v-test.webp';
const workspaces: string[] = [];

afterEach(() => {
  for (const dir of workspaces.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Real tar, fake `aws`: `s3 cp` reads or writes one file per key under `bucket/`. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'job-og-cache-r2-'));
  workspaces.push(root);
  const bin = path.join(root, 'bin');
  const bucket = path.join(root, 'bucket');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'aws'), `#!/bin/sh
while [ "$1" != cp ]; do shift; done
local_path() { printf '%s' "$FAKE_BUCKET/\${1#s3://fixture-bucket/}"; }
if [ "$2" = - ]; then
  target="$(local_path "$3")"; mkdir -p "$(dirname "$target")"; cat > "$target"
else
  cat "$(local_path "$2")"
fi
`, { mode: 0o755 });
  const env = {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FAKE_BUCKET: bucket,
    R2_ACCESS_KEY_ID: 'id',
    R2_SECRET_ACCESS_KEY: 'secret',
    R2_S3_ENDPOINT: 'https://r2.invalid',
    R2_BUCKET: 'fixture-bucket',
  };
  const build = (name: string) => {
    const rootDir = path.join(root, name);
    const cache = path.join(rootDir, '.cache/og-jobs');
    fs.mkdirSync(cache, { recursive: true });
    return { rootDir, cache };
  };
  return { object: path.join(bucket, archiveKey(VERSION)), env, build };
}

function writeMarker(cache: string, deferred: number, liveEntries: string[]) {
  fs.writeFileSync(path.join(cache, '.complete'), JSON.stringify({ deferred, liveEntries }));
}

describe('job OG cache R2 tier', () => {
  it('round-trips the live cards byte for byte and leaves orphans behind', async () => {
    const { env, build } = fixture();
    const source = build('source');
    const bytesA = Buffer.from([0, 1, 2, 255, 10, 13]);
    fs.writeFileSync(path.join(source.cache, A), bytesA);
    fs.writeFileSync(path.join(source.cache, B), 'card-b');
    fs.writeFileSync(path.join(source.cache, 'closed-job.photo.no-logo.v-test.webp'), 'orphan');
    writeMarker(source.cache, 0, [A, B, 'never-rendered.photo.no-logo.v-test.webp']);
    await expect(saveToR2({ rootDir: source.rootDir, env, version: VERSION })).resolves.toEqual({ saved: 2 });

    const target = build('target');
    await expect(restoreFromR2({ rootDir: target.rootDir, env, version: VERSION })).resolves.toEqual({ restored: 2 });
    expect(fs.readdirSync(target.cache).sort()).toEqual([A, B]);
    expect(fs.readFileSync(path.join(target.cache, A)).equals(bytesA)).toBe(true);
    expect(fs.readdirSync(path.join(target.rootDir, '.cache'))).toEqual(['og-jobs']);
  });

  it('does not replace the stored set after a partial render pass', async () => {
    const { env, build, object } = fixture();
    const source = build('source');
    fs.writeFileSync(path.join(source.cache, A), 'card-a');
    writeMarker(source.cache, 12, [A]);
    await expect(saveToR2({ rootDir: source.rootDir, env, version: VERSION })).resolves.toMatchObject({ saved: 0 });
    expect(fs.existsSync(object)).toBe(false);
  });

  it('publishes nothing from a missing or truncated archive', async () => {
    const { env, build, object } = fixture();
    const target = build('target');
    await expect(restoreFromR2({ rootDir: target.rootDir, env, version: VERSION })).rejects.toThrow();

    const source = build('source');
    fs.writeFileSync(path.join(source.cache, A), Buffer.alloc(40_000, 1));
    fs.writeFileSync(path.join(source.cache, B), Buffer.alloc(40_000, 2));
    writeMarker(source.cache, 0, [A, B]);
    await saveToR2({ rootDir: source.rootDir, env, version: VERSION });
    fs.truncateSync(object, 50_000);
    await expect(restoreFromR2({ rootDir: target.rootDir, env, version: VERSION })).rejects.toThrow();
    expect(fs.readdirSync(target.cache)).toEqual([]);
    expect(fs.readdirSync(path.join(target.rootDir, '.cache'))).toEqual(['og-jobs']);
  });
});

describe('deploy.yml wiring of the R2 tier', () => {
  const steps: any[] = YAML.parse(fs.readFileSync(path.resolve('.github/workflows/deploy.yml'), 'utf8'))
    .jobs['build-locale'].steps;
  const index = (command: string) => steps.findIndex((step) => step.run === `node scripts/ci/job-og-cache-r2.mjs ${command}`);

  it('hydrates only on an actions/cache miss, before the build, and never blocks it', () => {
    const restore = index('restore');
    expect(restore).toBeGreaterThan(steps.findIndex((step) => step.id === 'job_og_images_cache'));
    expect(restore).toBeLessThan(steps.findIndex((step) => step.id === 'build_step'));
    expect(steps[restore].if).toBe("matrix.locale == 'it' && steps.job_og_images_cache.outputs.cache-matched-key == ''");
    expect(steps[restore]['continue-on-error']).toBe(true);
  });

  it('persists under the same condition as the actions/cache save', () => {
    const save = steps[index('save')];
    expect(save.if).toBe(steps.find((step) => step.name === 'Save per-job OG images after successful build').if);
    expect(save['continue-on-error']).toBe(true);
  });
});
