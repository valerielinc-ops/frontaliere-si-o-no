// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * NX-SKEW-2b — every R2 call on the deploy path has a wall-clock limit.
 *
 * Failure title if this goes red:
 *   «Deploy: il push CDN resta appeso su una chiamata rclone senza limite di durata»
 *
 * #11318 added an `rclone lsjson -R --hash` of the whole assets/ prefix to
 * scripts/lib/deploy-it-pages-prep.sh with no limit of any kind. Deploy runs
 * 37178543559 and 37198287938 sat in "Push generated assets to CDN" until the
 * 6 h job timeout, and `pages-build-run` (cancel-in-progress: false) held every
 * later deploy behind them from 03-10 16:59Z to 04-10 (reverted by #11489).
 *
 * Two observers:
 *   1. static: every rclone/aws invocation in the deploy scripts runs under
 *      coreutils `timeout`, and the CDN push step has `timeout-minutes`;
 *   2. behavioural: with a listing or a ledger read that never answers, the
 *      push finishes in seconds and purges from this run's upload log.
 */

const ROOT = resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/**
 * Scripts that call R2 from inside deploy.yml: the CDN push itself, and the
 * single-file uploader that publish-edge-files.mjs runs in the same IT job
 * ("Publish edge files"). Add any new deploy-path script that calls rclone/aws.
 */
const DEPLOY_R2_SCRIPTS = ['scripts/lib/deploy-it-pages-prep.sh', 'scripts/lib/upload-cdn-file.sh'];

/** `timeout [-k N] <limit>` immediately before the command. */
const BOUNDED_PREFIX = /\btimeout\s+(?:-k\s+\S+\s+)?"?\$?\{?[\w:-]+\}?s?"?\s+$/;

/**
 * Lines (comment-stripped, continuations joined) that invoke rclone or aws
 * without `timeout` in front. Recognised invocations:
 *   - the `"${RC[@]}"` / `"${AWS[@]}"` command arrays;
 *   - a quoted path to an rclone binary followed by an argument;
 *   - bare `rclone <subcommand>` / `aws s3|s3api` in command position.
 */
export function findUnboundedR2Calls(source: string): string[] {
  const code = source
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
    .replace(/\\\r?\n[ \t]*/g, ' ')
    .split('\n');
  const offenders: string[] = [];
  const patterns = [
    /"\$\{(?:RC|AWS)\[@\]\}"/g,
    /(?:^|[;&|!(]|\bthen\b|\bdo\b|\bif\b|\$\()\s*"[^"\s]*\/rclone"(?=\s+\S)/g,
    /(?:^|[;&|!(]|\bthen\b|\bdo\b|\bif\b|\$\()\s*(?:rclone\s+(?:copy|copyto|sync|lsjson|lsf|lsl|ls|cat|md5sum|hashsum|check|size|delete|deletefile|purge|move|moveto|version|backend|rcat)\b|aws\s+(?:s3|s3api)\b)/g,
  ];
  for (const line of code) {
    for (const re of patterns) {
      for (const m of line.matchAll(re)) {
        const at = (m.index ?? 0) + m[0].search(/"\$\{|"[^"]*\/rclone"|rclone|aws/);
        if (!BOUNDED_PREFIX.test(line.slice(0, at))) offenders.push(line.trim());
      }
    }
  }
  return [...new Set(offenders)];
}

describe('static: no rclone/aws call on the deploy path without a time limit', () => {
  for (const file of DEPLOY_R2_SCRIPTS) {
    it(`${file}: every rclone/aws invocation runs under coreutils timeout`, () => {
      expect(findUnboundedR2Calls(read(file))).toEqual([]);
    });

    it(`${file}: the rclone command array carries connect and IO-idle limits`, () => {
      const rcArray = read(file).match(/RC=\(rclone[\s\S]*?\)\n/);
      expect(rcArray, 'RC=(rclone …) array not found').toBeTruthy();
      expect(rcArray![0]).toMatch(/--contimeout=\d+s/);
      expect(rcArray![0]).toMatch(/--timeout=\d+s/);
    });

    it(`${file}: the rclone download is time-limited too`, () => {
      expect(read(file)).toMatch(/curl -fsSL[^\n]*--max-time \d+/);
    });
  }

  it('the scanner itself goes red on each unbounded shape (and stays green on bounded ones)', () => {
    const bad = [
      '"${RC[@]}" lsjson -R --files-only --hash "$bkt/assets" > "$out"',
      'if "${RC[@]}" copyto "$a" "$b"; then',
      '"${AWS[@]}" s3api list-objects-v2 --bucket "$B"',
      '&& "$rtmp/rclone-bin/rclone" version >/dev/null 2>&1; then',
      'rclone copy "$src" ":s3:$B/assets"',
      'out="$(aws s3api head-object --bucket b --key k)"',
    ];
    for (const line of bad) expect(findUnboundedR2Calls(line), line).toEqual([line.trim()]);
    const good = [
      'timeout -k 10 "$_t_obj" "${RC[@]}" copyto "$a" "$b"',
      'if ! timeout -k 15 "$1" "${RC[@]}" copy "$2" "$bkt/$3" \\\n  --stats=0; then',
      'timeout -k 10 "$t_list" "${AWS[@]}" s3api list-objects-v2 --bucket "$B"',
      '&& timeout -k 5 30 "$rtmp/rclone-bin/rclone" version >/dev/null 2>&1; then',
      'timeout 60 rclone copy a b',
      'echo "CDN→R2 (rclone --checksum): payload"',
      'command -v rclone >/dev/null 2>&1',
      '# "${RC[@]}" lsjson in a comment',
    ];
    for (const src of good) expect(findUnboundedR2Calls(src), src).toEqual([]);
  });

  it('purge-changed-cdn-assets.mjs bounds each cf-purge-cache.mjs call', () => {
    expect(read('scripts/ci/purge-changed-cdn-assets.mjs')).toMatch(/execFileSync\('node', \[purgeScript[\s\S]{0,200}timeout: batchTimeout/);
  });

  it('deploy.yml: the CDN push step has a timeout-minutes coherent with its measured duration', () => {
    const wf = parse(read('.github/workflows/deploy.yml'));
    const steps = Object.values(wf.jobs as Record<string, { steps?: { name?: string; 'timeout-minutes'?: number }[] }>)
      .flatMap((j) => j.steps ?? []);
    const push = steps.find((s) => s.name === 'Push generated assets to CDN (early — ahead of the shard pushes)');
    expect(push, 'early CDN push step not found').toBeTruthy();
    // Measured 449-531 s; a limit near the 360-min job default is no limit.
    expect(push!['timeout-minutes']).toBeGreaterThanOrEqual(15);
    expect(push!['timeout-minutes']).toBeLessThanOrEqual(45);
  });
});

// ── behaviour: a call that never answers falls back, it does not hang ──────

const SCRATCH = mkdtempSync(join(tmpdir(), 'r2-bounded-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** Executable stubs for rclone and aws, driven by env vars. */
function writeStubs(bin: string) {
  mkdirSync(bin, { recursive: true });
  // rclone: skip the global --flags, dispatch on the subcommand.
  writeFileSync(
    join(bin, 'rclone'),
    `#!/usr/bin/env bash
args=()
for a in "$@"; do case "$a" in --*) ;; *) args+=("$a") ;; esac; done
logf=""
for a in "$@"; do case "$a" in --log-file=*) logf="\${a#--log-file=}" ;; esac; done
echo "rclone \${args[*]}" >> "$STUB_CALLS"
case "\${args[0]}" in
  version) exit 0 ;;
  copyto)
    src="\${args[1]}"; dst="\${args[2]}"
    case "$src" in
      :s3:*purge-ledger/assets.json)
        case "\${STUB_LEDGER:-absent}" in
          hang) exec sleep 30 ;;
          absent) exit 0 ;;
          present) cp "$STUB_LEDGER_FILE" "$dst"; exit 0 ;;
        esac ;;
    esac
    case "$dst" in *purge-ledger/assets.json) cp "$src" "$STUB_DIR/ledger-written.json" ;; esac
    exit 0 ;;
  copy)
    dst="\${args[2]}"
    case "$dst" in */assets) [ -n "$logf" ] && printf '%s\\n' "\${STUB_ASSETS_LOG:-}" > "$logf" ;; esac
    case "$dst" in */"\${STUB_FAIL_PREFIX:-none}") exit 1 ;; esac
    exit 0 ;;
esac
exit 0
`,
  );
  writeFileSync(
    join(bin, 'aws'),
    `#!/usr/bin/env bash
echo "aws $*" >> "$STUB_CALLS"
[ "\${STUB_LIST:-ok}" = hang ] && exec sleep 30
printf '%s' "\${STUB_LISTING:-[]}"
`,
  );
  chmodSync(join(bin, 'rclone'), 0o755);
  chmodSync(join(bin, 'aws'), 0o755);
  // Portable coreutils-compatible `timeout` for hosts without one (macOS
  // without coreutils). On the runner and wherever it exists, the real one is
  // used: the stub only fills the gap.
  if (!hasRealTimeout()) {
    writeFileSync(
      join(bin, 'timeout'),
      `#!/usr/bin/env bash
[ "$1" = "-k" ] && shift 2
limit="\${1%s}"; shift
"$@" &
pid=$!
( sleep "$limit"; kill -TERM "$pid" ) >/dev/null 2>&1 &
watcher=$!
wait "$pid"; rc=$?
kill "$watcher" 2>/dev/null
[ "$rc" = 143 ] && exit 124
exit "$rc"
`,
    );
    chmodSync(join(bin, 'timeout'), 0o755);
  }
}

function hasRealTimeout(): boolean {
  try {
    execFileSync('bash', ['-c', 'command -v timeout'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

/** Runs `_publish_cdn_r2` alone (the script is sourced, so `main` does not run). */
function runPublish(name: string, env: Record<string, string>) {
  const dir = join(SCRATCH, name);
  const bin = join(dir, 'bin');
  const stage = join(dir, 'stage');
  writeStubs(bin);
  mkdirSync(join(stage, 'assets'), { recursive: true });
  writeFileSync(join(stage, 'assets', 'a.js'), 'export const a = 2;\n');
  writeFileSync(join(stage, 'assets', 'b.js'), 'export const b = 1;\n');
  writeFileSync(join(stage, 'index.html'), '<!doctype html>');
  mkdirSync(join(stage, 'data'), { recursive: true });
  writeFileSync(join(stage, 'data', 'x.json'), '{}');
  const calls = join(dir, 'calls.log');
  writeFileSync(calls, '');
  const started = Date.now();
  let stdout = '';
  let code = 0;
  try {
    stdout = execFileSync('bash', ['-c', 'source scripts/lib/deploy-it-pages-prep.sh && _publish_cdn_r2 "$1"', '_', stage], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: dir,
        RUNNER_TEMP: dir,
        GITHUB_ENV: join(dir, 'github-env'),
        R2_ACCESS_KEY_ID: 'k',
        R2_SECRET_ACCESS_KEY: 's',
        R2_S3_ENDPOINT: 'https://r2.invalid',
        R2_BUCKET: 'bkt',
        DEPLOY_BUILD_ID: 'b-test',
        R2_TIMEOUT_OBJECT_S: '2',
        R2_TIMEOUT_LIST_S: '2',
        R2_TIMEOUT_PURGE_S: '30',
        STUB_CALLS: calls,
        STUB_DIR: dir,
        ...env,
      },
    });
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string };
    code = err.status ?? 1;
    stdout = err.stdout ?? '';
  }
  const ledgerWritten = join(dir, 'ledger-written.json');
  return {
    code,
    stdout,
    seconds: (Date.now() - started) / 1000,
    calls: readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    ledger: existsSync(ledgerWritten) ? JSON.parse(readFileSync(ledgerWritten, 'utf8')) : null,
  };
}

const COPIED_A = JSON.stringify({ level: 'info', msg: 'Copied (replaced existing)', object: 'a.js' });

describe('behaviour: an R2 call that never answers does not hang the CDN push', () => {
  it('ledger absent + pre-sync listing that never answers → bounded, purge falls back to the upload log', () => {
    const r = runPublish('listing-hangs', { STUB_LEDGER: 'absent', STUB_LIST: 'hang', STUB_ASSETS_LOG: COPIED_A });
    expect(r.code).toBe(0);
    expect(r.seconds, 'the push must not wait out the stubbed 30 s listing').toBeLessThan(25);
    expect(r.stdout).toMatch(/::warning::\[r2\] pre-sync listing of assets\/ failed or exceeded 2s \(exit 124\)/);
    expect(r.stdout).toMatch(/log-only: purging the 1 key\(s\) this run uploaded/);
    expect(r.stdout, 'the payload still publishes').toMatch(/✅ synced CDN payload to R2/);
    expect(r.ledger, 'no ledger may be written from a run that could not seed one').toBeNull();
  });

  it('ledger read that never answers → bounded, purge falls back to the upload log', () => {
    const r = runPublish('ledger-hangs', { STUB_LEDGER: 'hang', STUB_ASSETS_LOG: COPIED_A });
    expect(r.code).toBe(0);
    expect(r.seconds).toBeLessThan(25);
    expect(r.stdout).toMatch(/::warning::\[r2\] purge ledger read failed or exceeded 2s \(exit 124\)/);
    expect(r.stdout).toMatch(/log-only: purging the 1 key\(s\) this run uploaded/);
    expect(r.calls.some((c) => / s3api list-objects-v2 .*Key:Key,ETag:ETag/.test(c)), 'no seed listing after a failed read').toBe(false);
    expect(r.ledger).toBeNull();
  });
});

describe('behaviour: the ledger path end to end (stubbed R2, no network)', () => {
  it('ledger present + EMPTY upload log → the key a dead run uploaded is still selected', () => {
    const ledgerFile = join(SCRATCH, 'ledger-present.json');
    writeFileSync(
      ledgerFile,
      JSON.stringify({ version: 1, keys: { 'assets/a.js': '0'.repeat(32), 'assets/b.js': md5('export const b = 1;\n') } }),
    );
    const r = runPublish('ledger-present', { STUB_LEDGER: 'present', STUB_LEDGER_FILE: ledgerFile, STUB_ASSETS_LOG: '' });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/ledger: 0 key\(s\) uploaded by this run, 1 more changed in R2 since the last successful purge/);
    // No CF_API_TOKEN in the test: nothing is purged, so nothing may be marked clean.
    expect(r.ledger.keys['assets/a.js']).toBe('0'.repeat(32));
    const listCalls = r.calls.filter((c) => /list-objects-v2 .*Key:Key,ETag:ETag/.test(c));
    expect(listCalls, 'no listing when the ledger exists').toEqual([]);
  });

  it('ledger absent + listing OK → seeded and persisted BEFORE the assets copy', () => {
    const listing = JSON.stringify([
      { Key: 'assets/a.js', ETag: `"${'0'.repeat(32)}"` },
      { Key: 'assets/b.js', ETag: `"${md5('export const b = 1;\n')}"` },
    ]);
    const r = runPublish('seed', { STUB_LEDGER: 'absent', STUB_LISTING: listing, STUB_ASSETS_LOG: '' });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/purge ledger seeded from the pre-sync R2 state: 2 key\(s\)/);
    const persistAt = r.calls.findIndex((c) => /^rclone copyto \S+ :s3:bkt\/purge-ledger\/assets\.json /.test(c));
    const assetsAt = r.calls.findIndex((c) => /^rclone copy \S+ :s3:bkt\/assets /.test(c));
    expect(persistAt).toBeGreaterThan(-1);
    expect(persistAt).toBeLessThan(assetsAt);
    expect(r.stdout).toMatch(/ledger: 0 key\(s\) uploaded by this run, 1 more changed/);
  });

  it('a later prefix failing: assets still purged, marker withheld (redflag fix of #11489)', () => {
    const r = runPublish('later-prefix-fails', { STUB_LEDGER: 'hang', STUB_ASSETS_LOG: COPIED_A, STUB_FAIL_PREFIX: 'data' });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/NOT writing marker/);
    expect(r.stdout).toMatch(/log-only: purging the 1 key\(s\) this run uploaded/);
    expect(r.calls.some((c) => /cdn-build-id\.txt/.test(c))).toBe(false);
  });
});
