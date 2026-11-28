// scripts/ci/host-heartbeat.sh: the only record of a deploy leg whose runner is
// lost, so it must publish off-runner, fail open, and keep the token to itself.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve('scripts/ci/host-heartbeat.sh');
const TOKEN = 'ghs_heartbeat_test_token';
let dir: string;

function writeProc(availMb: number, stallAvg10 = 0): void {
  const proc = path.join(dir, 'proc');
  fs.mkdirSync(path.join(proc, 'pressure'), { recursive: true });
  fs.writeFileSync(path.join(proc, 'meminfo'), `MemAvailable: ${availMb * 1024} kB\nSwapFree: ${8000 * 1024} kB\n`);
  fs.writeFileSync(path.join(proc, 'vmstat'), 'pswpin 0\npswpout 0\n');
  fs.writeFileSync(path.join(proc, 'loadavg'), '3.50 3.00 2.00 1/100 1\n');
  for (const name of ['memory', 'io', 'cpu']) {
    fs.writeFileSync(
      path.join(proc, 'pressure', name),
      `some avg10=1.00 avg60=7.00 avg300=0.00 total=1\nfull avg10=${stallAvg10}.00 avg60=2.00 avg300=0.00 total=1\n`,
    );
  }
}

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
      FAKE_DIR: dir,
      HEARTBEAT_PROC_ROOT: path.join(dir, 'proc'),
      HEARTBEAT_HEADERS_FILE: path.join(dir, 'headers'),
      HEARTBEAT_BUILD_LOGS: path.join(dir, 'build.log'),
      HEARTBEAT_TOKEN: TOKEN,
      HEARTBEAT_LOCALE: 'de',
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_SHA: 'a'.repeat(40),
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '2',
      ...env,
    },
  });
}

const read = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8');
const bodies = () => read('bodies').trim().split('\n').map((line) => JSON.parse(line));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-heartbeat-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  // Fake curl: records argv, stdin config and JSON body; answers FAKE_CODE.
  fs.writeFileSync(
    path.join(dir, 'bin', 'curl'),
    `#!/usr/bin/env bash
cat >> "$FAKE_DIR/stdin"
printf '%s\\n' "$*" >> "$FAKE_DIR/argv"
while [ $# -gt 0 ]; do
  case "$1" in
    --data) printf '%s\\n' "$2" >> "$FAKE_DIR/bodies"; shift ;;
    --dump-header) printf 'x-ratelimit-remaining: %s\\r\\n' "\${FAKE_REMAINING:-4000}" > "$2"; shift ;;
  esac
  shift
done
printf '%s' "\${FAKE_CODE:-201}"
`,
    { mode: 0o755 },
  );
  writeProc(9000);
  fs.writeFileSync(path.join(dir, 'build.log'), '[profile-mem] static-pages    rss_mb=1\n[profile-mem] jobs-seo-pages   rss_mb=2\n');
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('host-heartbeat.sh', () => {
  it('publishes one success status carrying the host sample and the last plugin', () => {
    const result = run(['--once']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('status deploy-host/de pubblicato');
    const [body] = bodies();
    expect(body.state).toBe('success');
    expect(body.context).toBe('deploy-host/de');
    expect(body.target_url).toBe('https://github.com/o/r/actions/runs/123/attempts/2');
    expect(body.description.length).toBeLessThanOrEqual(140);
    expect(body.description).toMatch(/^t=\d+ av=9000\/9000 swf=8000 si=0 so=0 pm=2 pio=2 pc=7 ld=3\.50 d=/);
    expect(read('argv')).toContain(`/repos/o/r/statuses/${'a'.repeat(40)}`);
  });

  it('passes the token on stdin, never in argv or in the log', () => {
    const result = run(['--once']);
    expect(read('stdin')).toContain(`Authorization: Bearer ${TOKEN}`);
    expect(read('argv')).not.toContain(TOKEN);
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
  });

  it('keeps the whole sample within 140 characters with worst-case values', () => {
    writeProc(15983, 99);
    fs.writeFileSync(path.join(dir, 'build.log'), `[profile-mem] ${'x'.repeat(80)} rss_mb=1\n`);
    run(['--once']);
    expect(bodies()[0].description.length).toBeLessThanOrEqual(140);
  });

  it('fails open and says so when GitHub refuses the status', () => {
    const result = run(['--once'], { FAKE_CODE: '403' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('::warning::[host-heartbeat] status non pubblicato (HTTP 403)');
  });

  const loop = { HEARTBEAT_TICK_S: '1', HEARTBEAT_LIFETIME_S: '4', HEARTBEAT_NORMAL_S: '60', HEARTBEAT_PRESSURE_S: '1' };

  it('stays at the slow cadence on a healthy host and speeds up under pressure', () => {
    run([], loop);
    expect(bodies()).toHaveLength(1);
    fs.rmSync(path.join(dir, 'bodies'));
    writeProc(400);
    run([], loop);
    expect(bodies().length).toBeGreaterThanOrEqual(2);
  });

  it('slows down when the remaining API quota is below the floor, and honours the post cap', () => {
    writeProc(400);
    run([], { ...loop, FAKE_REMAINING: '100' });
    expect(bodies()).toHaveLength(1);
    fs.rmSync(path.join(dir, 'bodies'));
    run([], { ...loop, HEARTBEAT_MAX_POSTS: '1' });
    expect(bodies()).toHaveLength(1);
  });
});

describe('deploy.yml wiring', () => {
  const workflow = fs.readFileSync(path.resolve('.github/workflows/deploy.yml'), 'utf8');
  const job = workflow.slice(workflow.indexOf('\n  build-locale:\n'), workflow.indexOf('\n  build-history-commit:\n'));

  it('starts the heartbeat before any build step, fail-open, with a kill switch', () => {
    const start = job.indexOf('- name: Start off-runner host heartbeat');
    expect(start).toBeGreaterThan(job.indexOf('bash scripts/ci/grow-build-swap.sh'));
    expect(start).toBeLessThan(job.indexOf('- name: Build IT Rollup bundle'));
    const step = job.slice(start, job.indexOf('- name: Setup Node.js', start));
    expect(step).toContain("if: vars.DEPLOY_HOST_HEARTBEAT != '0'");
    expect(step).toContain('continue-on-error: true');
    expect(step).toContain('nohup bash scripts/ci/host-heartbeat.sh');
  });

  it('keeps the token in that one step and has the scope to write statuses', () => {
    expect(workflow.match(/HEARTBEAT_TOKEN:/g)).toHaveLength(1);
    expect(job).toMatch(/\n {6}statuses: write\b/);
  });
});
