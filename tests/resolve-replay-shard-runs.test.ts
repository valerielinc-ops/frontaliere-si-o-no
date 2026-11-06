import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// scripts/ci/resolve-replay-shard-runs.sh: the en/de/fr shard tars of a build
// live on the deploy-publish run that published it — frequently the CANCELLED
// one (its report job hit the 350-minute ceiling), while the later SUCCESS runs
// are receipt-only reconciliations with no artifacts (build 39917633944:
// publish 39946751902 cancelled holds them, 39956978145/39957703210 success
// hold none). Replays 39927368320/39952023039 never found them and audited
// trunk-of-then under shards-of-today.

const SCRIPT = resolve('scripts/ci/resolve-replay-shard-runs.sh');
const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

interface Fixture { runs: Array<{ id: string; title: string }>; artifacts: Record<string, string[]> }

function run(fx: Fixture, allowMixed = 'false'): { status: number; out: string; env: string } {
  const root = mkdtempSync(join(tmpdir(), 'resolve-replay-'));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(root, 'runs.json'), JSON.stringify(fx.runs.map((r) => ({ databaseId: Number(r.id), displayTitle: r.title }))));
  for (const [id, names] of Object.entries(fx.artifacts)) {
    writeFileSync(join(root, `art-${id}.json`), JSON.stringify({ artifacts: names.map((name) => ({ name, expired: name.endsWith(':expired') })).map((a) => ({ ...a, name: a.name.replace(':expired', '') })) }));
  }
  // Fake gh: `run list` prints the fixture runs; `api …/runs/<id>/artifacts`
  // applies the caller's --jq filter to the fixture artifacts with real jq.
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
case "$1" in
  run) cat "${root}/runs.json" ;;
  api)
    id=$(sed -E 's#.*/runs/([0-9]+)/artifacts.*#\\1#' <<< "$2")
    f="${root}/art-$id.json"; [ -f "$f" ] || f=/dev/null
    jq -r "$4" < <(cat "$f" 2>/dev/null || echo '{"artifacts":[]}') ;;
esac
`, { mode: 0o755 });
  const envFile = join(root, 'github-env');
  writeFileSync(envFile, '');
  try {
    const out = execFileSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEPLOY_RUN_ID: '100', GH_REPO: 'o/r', ALLOW_MIXED: allowMixed, GITHUB_ENV: envFile },
    });
    return { status: 0, out, env: readFileSync(envFile, 'utf8') };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}`, env: readFileSync(envFile, 'utf8') };
  }
}

const build = ['jobs-master-100', 'shard-batch-1-dist-it-100'];
const locales = (rid: string) => ['en', 'de', 'fr'].map((l) => `locale-dist-${l}-${rid}`);

describe('resolve-replay-shard-runs.sh', () => {
  it('picks the publish run that HOLDS the artifacts, whatever its conclusion', () => {
    const r = run({
      runs: [
        { id: '300', title: 'Publish Pages build 100 @ abc' }, // receipt-only success
        { id: '200', title: 'Publish Pages build 100 @ abc' }, // the cancelled one that published
        { id: '150', title: 'Publish Pages build 99 @ def' },
      ],
      artifacts: { 100: build, 300: [], 200: locales('200'), 150: locales('150') },
    });
    expect(r.status, r.out).toBe(0);
    expect(r.env.trim().split('\n')).toEqual(['SHARD_ARTIFACT_RUN_ID_EN=200', 'SHARD_ARTIFACT_RUN_ID_DE=200', 'SHARD_ARTIFACT_RUN_ID_FR=200']);
  });

  it('refuses an incoherent replay when the build artifacts expired', () => {
    const r = run({
      runs: [{ id: '200', title: 'Publish Pages build 100 @ abc' }],
      artifacts: { 100: ['jobs-master-100:expired', 'shard-batch-1-dist-it-100'], 200: locales('200').map((n) => `${n}:expired`) },
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain('jobs-master-100 scaduto o assente');
    expect(r.out).toContain('locale-dist-en-* assente/scaduto');
    expect(r.out).toContain('::error::replay incoerente per il build 100');
  });

  it('lets an explicit allow_mixed_shards replay proceed, saying what it audits', () => {
    const r = run({ runs: [], artifacts: { 100: build } }, 'true');
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('::warning::allow_mixed_shards=true');
    expect(r.env).toBe('');
  });
});
