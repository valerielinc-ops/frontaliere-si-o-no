// @vitest-environment node
import { execFileSync, spawn } from 'node:child_process';
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
 * The duration came from the MimeType lsjson prints, read with one HEAD per
 * object in series (5,986 HEAD in 9 min on the production bucket; 26 s for the
 * same listing with --no-mimetype).
 *
 * Two observers:
 *   1. static: every rclone/aws invocation in the deploy scripts runs under
 *      coreutils `timeout`, and the CDN push step has `timeout-minutes`;
 *   2. behavioural: with a ledger read that never answers, the
 *      push stays bounded and bootstraps an empty ledger so current stage
 *      keys are retried even when this run's upload log is empty.
 */

const ROOT = resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/**
 * Scripts that call R2 from inside deploy.yml: the CDN push itself, and the
 * single-file uploader that publish-edge-files.mjs runs in the same IT job
 * ("Publish edge files"). Add any new deploy-path script that calls rclone/aws.
 */
const DEPLOY_R2_SCRIPTS = ['scripts/lib/deploy-it-pages-prep.sh', 'scripts/lib/upload-cdn-file.sh'];
const IMAGE_LEASE_PROCESS_HELPER = 'scripts/lib/r2-image-lease-process.sh';
const R2_RELATED_SOURCE_FILES = [...DEPLOY_R2_SCRIPTS, IMAGE_LEASE_PROCESS_HELPER];

/** `timeout [-k N] <limit>` immediately before the command. */
const BOUNDED_PREFIX = /\btimeout\s+(?:-k\s+\S+\s+)?"?\$?\{?[\w:-]+\}?s?"?\s+$/;

/**
 * Lines (comment-stripped, continuations joined) that run `rclone lsjson`
 * without `--no-mimetype`. lsjson prints a MimeType per entry and, on S3/R2,
 * reads it with one HEAD per object in series: that, not the listing or the
 * hashes, is what kept #11318's lsjson of assets/ running for hours.
 */
export function findLsjsonReadingMimeType(source: string): string[] {
  return source
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
    .replace(/\\\r?\n[ \t]*/g, ' ')
    .split('\n')
    .filter((l) => /\blsjson\b/.test(l) && !/--no-mimetype\b/.test(l))
    .map((l) => l.trim());
}

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

  it('a change to any scanned script selects this test (related-tests pairing)', () => {
    // The scan reads the scripts from disk; no import ties this file to them.
    // Without an explicit entry in the related-tests table, a PR that adds an
    // rclone call to one of them never runs this guard: that is how an lsf
    // lookup with an unrecognised bound reached main (#11879).
    const runner = read('scripts/ci/run-related-tests.mjs');
    const entry = runner.match(/\['tests\/r2-calls-bounded\.test\.ts',\s*\/(.+)\/\],/);
    expect(entry, 'tests/r2-calls-bounded.test.ts is missing from the related-tests table').toBeTruthy();
    const scope = new RegExp(entry![1]);
    for (const file of R2_RELATED_SOURCE_FILES) expect(scope.test(file), file).toBe(true);
  });

  it('both image writers source the shared bounded-cancellation helper', () => {
    for (const file of DEPLOY_R2_SCRIPTS) {
      expect(read(file), file).toContain('r2-image-lease-process.sh');
    }
    expect(read(IMAGE_LEASE_PROCESS_HELPER)).toContain('_r2_image_lease_stop_timeout()');
    expect(read(IMAGE_LEASE_PROCESS_HELPER)).toContain('_r2_image_lease_wait_timeout()');
  });

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
    expect(read('scripts/ci/purge-changed-cdn-assets.mjs')).toMatch(/execFileSync\('node', \[purgeScript[\s\S]{0,200}timeout: Math\.max\(1000, Math\.min\(batchTimeout, remainingMs\)\)/);
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

  for (const file of DEPLOY_R2_SCRIPTS) {
    it(`${file}: no rclone lsjson reads the MimeType (one HEAD per object)`, () => {
      expect(findLsjsonReadingMimeType(read(file))).toEqual([]);
    });
  }

  it('the lsjson scanner goes red without --no-mimetype, also across a continuation', () => {
    expect(findLsjsonReadingMimeType('timeout 60 "${RC[@]}" lsjson -R --files-only --hash "$bkt/assets"')).toHaveLength(1);
    expect(findLsjsonReadingMimeType('timeout 60 "${RC[@]}" lsjson -R \\\n  --hash --no-mimetype "$bkt/assets"')).toEqual([]);
    expect(findLsjsonReadingMimeType('# "${RC[@]}" lsjson -R in a comment')).toEqual([]);
  });

  it('the data/ sync budget holds a backlog push, not only a routine one', () => {
    // Run 37237201212, first green deploy after 30 h of hung runs: data/ took
    // 1,622 s (31,627 changed files). Below that, the early push and the full
    // prep's retry both stop short, the marker is withheld and
    // step_drop_assets fails the deploy.
    const m = read('scripts/lib/deploy-it-pages-prep.sh').match(/^\s*_r2_sync (\d+) "\$stage\/data"/m);
    expect(m, '_r2_sync <limit> "$stage/data" not found').toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(1622);
  });
});

// ── behaviour: a call that never answers falls back, it does not hang ──────

const SCRATCH = mkdtempSync(join(tmpdir(), 'r2-bounded-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** Executable stubs for rclone and aws, driven by env vars. */
function writeStubs(bin: string) {
  mkdirSync(bin, { recursive: true });
  // Route only the image-namespace CLI through a deterministic lease stub;
  // other Node scripts still execute with the real runtime.
  writeFileSync(
    join(bin, 'node'),
    `#!/usr/bin/env bash
case "\${1:-}" in scripts/lib/r2-image-namespace-lock.mjs|*/scripts/lib/r2-image-namespace-lock.mjs)
  shift
  command="$1"; shift
  case "$command" in
    acquire)
      [ "$1" = "--namespace" ] || exit 87
      case "$2" in
        blog) namespace_context='{"version":1,"leases":[{"namespace":"blog","owner":"test-owner","leaseId":"acquired-blog-lease","expiresAt":1800000000000}]}' ;;
        places) namespace_context='{"version":1,"leases":[{"namespace":"places","owner":"test-owner","leaseId":"acquired-places-lease","expiresAt":1800000000000}]}' ;;
        blog,places) namespace_context='{"version":1,"leases":[{"namespace":"blog","owner":"test-owner","leaseId":"acquired-blog-lease","expiresAt":1800000000000},{"namespace":"places","owner":"test-owner","leaseId":"acquired-places-lease","expiresAt":1800000000000}]}' ;;
        *) exit 87 ;;
      esac
      printf 'acquire:%s\\n' "$2" >> "$STUB_LEASE_CALLS"
      [ "\${STUB_LEASE_ACQUIRE_STATUS:-0}" = 0 ] || exit "$STUB_LEASE_ACQUIRE_STATUS"
      if [ -n "\${STUB_LEASE_STATE:-}" ]; then
        [ ! -e "$STUB_LEASE_STATE" ] || exit 124
        printf '%s\\n' "$2" > "$STUB_LEASE_STATE"
      fi
      printf '%s' "$namespace_context"
      exit 0 ;;
    verify)
      [ "$1" = "--namespace" ] || exit 87
      case "$2" in blog|places) ;; *) exit 87 ;; esac
      [ "$3" = "--context" ] || exit 87
      printf 'verify:%s:%s\\n' "$2" "$4" >> "$STUB_LEASE_CALLS"
      exit "\${STUB_LEASE_VERIFY_STATUS:-0}" ;;
    release)
      [ "$1" = "--context" ] || exit 87
      printf 'release:%s\\n' "$2" >> "$STUB_LEASE_CALLS"
      if [ -n "\${STUB_IMAGE_WRITER_EVENT_FILE:-}" ]; then
        printf 'release\\n' >> "$STUB_IMAGE_WRITER_EVENT_FILE"
      fi
      if [ -n "\${STUB_LEASE_STATE:-}" ]; then
        [ -f "$STUB_LEASE_STATE" ] || exit 1
        rm -f "$STUB_LEASE_STATE"
      fi
      exit "\${STUB_LEASE_RELEASE_STATUS:-0}" ;;
    *) exit 87 ;;
  esac
  ;;
esac
exec "$STUB_REAL_NODE" "$@"
`,
  );
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
    if [ "\${STUB_IMAGE_WRITER_COPYTO:-0}" = 1 ] \
      && [ -n "\${STUB_IMAGE_WRITER_EVENT_FILE:-}" ] && [[ "$src" != :s3:* ]]; then
      printf 'copyto-started\\n' >> "$STUB_IMAGE_WRITER_EVENT_FILE"
      trap 'sleep 0.2; printf "copyto-stopped\\n" >> "$STUB_IMAGE_WRITER_EVENT_FILE"; exit 0' TERM
      sleep 30
    fi
    case "$src" in
      :s3:*purge-ledger/assets.json)
        case "\${STUB_LEDGER:-absent}" in
          hang) exec sleep 30 ;;
          absent) exit 0 ;;
          present) cp "$STUB_LEDGER_FILE" "$dst"; exit 0 ;;
        esac ;;
      :s3:*cdn-build-id.txt)
        build="\${STUB_BUILD_MARKER:-b-test}"
        if [ "\${STUB_PUBLISH_INCOMPLETE:-0}" = 1 ] && [ -z "\${STUB_BUILD_MARKER+x}" ]; then build=previous-build; fi
        printf '%s' "$build" > "$dst"
        exit 0 ;;
      :s3:*cdn-publish-start-id.txt)
        printf '%s' "\${STUB_PUBLISH_START:-1700000000000}" > "$dst"
        exit 0 ;;
      :s3:*cdn-publish-complete-id.txt)
        start="\${STUB_PUBLISH_START:-1700000000000}"
        complete="\${STUB_PUBLISH_COMPLETE:-$start}"
        if [ "\${STUB_PUBLISH_INCOMPLETE:-0}" = 1 ] && [ -z "\${STUB_PUBLISH_COMPLETE+x}" ]; then complete=1600000000000; fi
        printf '%s' "$complete" > "$dst"
        exit 0 ;;
    esac
    case "$dst" in
      *cdn-publish-start-id.txt) [ "\${STUB_FAIL_START:-0}" = 1 ] && exit 1 ;;
      *cdn-publish-complete-id.txt) [ "\${STUB_FAIL_COMPLETE:-0}" = 1 ] && exit 1 ;;
    esac
    case "$dst" in *purge-ledger/assets.json) cp "$src" "$STUB_DIR/ledger-written.json" ;; esac
    exit 0 ;;
  copy)
    dst="\${args[2]}"
    case "$dst" in
      */images)
        printf 'copy:images:%s\\n' "\${FRONTALIERE_R2_IMAGE_LEASE_CONTEXT:-<missing>}" >> "$STUB_LEASE_CALLS"
        if [ -n "\${STUB_IMAGE_WRITER_EVENT_FILE:-}" ]; then
          printf 'copy-started\\n' >> "$STUB_IMAGE_WRITER_EVENT_FILE"
          trap 'sleep 0.2; printf "copy-stopped\\n" >> "$STUB_IMAGE_WRITER_EVENT_FILE"; exit 0' TERM
          sleep 30
        fi ;;
    esac
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
`,
  );
  chmodSync(join(bin, 'rclone'), 0o755);
  chmodSync(join(bin, 'aws'), 0o755);
  chmodSync(join(bin, 'node'), 0o755);
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
  if (env.STUB_BLOG_IMAGES === '1') {
    mkdirSync(join(stage, 'images', 'blog'), { recursive: true });
    writeFileSync(join(stage, 'images', 'blog', 'cover.webp'), 'fixture bytes');
  }
  if (env.STUB_PLACES_IMAGES === '1') {
    mkdirSync(join(stage, 'images', 'places'), { recursive: true });
    writeFileSync(join(stage, 'images', 'places', 'station.webp'), 'fixture bytes');
  }
  const calls = join(dir, 'calls.log');
  writeFileSync(calls, '');
  const leaseCalls = join(dir, 'lease-calls.log');
  writeFileSync(leaseCalls, '');
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
        R2_TIMEOUT_PURGE_S: '30',
        STUB_CALLS: calls,
        STUB_LEASE_CALLS: leaseCalls,
        STUB_REAL_NODE: process.execPath,
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
    leaseCalls: readFileSync(leaseCalls, 'utf8').split('\n').filter(Boolean),
    ledger: existsSync(ledgerWritten) ? JSON.parse(readFileSync(ledgerWritten, 'utf8')) : null,
  };
}

async function runPublishInterrupted(name: string, env: Record<string, string>) {
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
  mkdirSync(join(stage, 'images', 'blog'), { recursive: true });
  writeFileSync(join(stage, 'images', 'blog', 'cover.webp'), 'fixture bytes');

  const calls = join(dir, 'calls.log');
  const leaseCalls = join(dir, 'lease-calls.log');
  const copyEvents = join(dir, 'writer-events.log');
  const leaseState = join(dir, 'lease-state');
  writeFileSync(calls, '');
  writeFileSync(leaseCalls, '');
  writeFileSync(copyEvents, '');
  const child = spawn('bash', ['-c', 'source scripts/lib/deploy-it-pages-prep.sh && _publish_cdn_r2 "$1"', '_', stage], {
    cwd: ROOT,
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
      R2_TIMEOUT_OBJECT_S: '120',
      R2_TIMEOUT_PURGE_S: '30',
      STUB_CALLS: calls,
      STUB_LEASE_CALLS: leaseCalls,
      STUB_IMAGE_WRITER_EVENT_FILE: copyEvents,
      STUB_LEASE_STATE: leaseState,
      STUB_REAL_NODE: process.execPath,
      STUB_DIR: dir,
      STUB_BLOG_IMAGES: '1',
      ...env,
    },
  });
  let stderr = '';
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const waitForCopyStart = async () => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (readFileSync(copyEvents, 'utf8').includes('copy-started')) return;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`publish exited before image copy began (${child.exitCode ?? child.signalCode}): ${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`image copy did not start before the test deadline: ${stderr}`);
  };
  const deadline = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try {
    await waitForCopyStart();
    child.kill('SIGTERM');
    const result = await exit;
    return {
      ...result,
      stderr,
      leaseState,
      copyEvents: readFileSync(copyEvents, 'utf8').split('\n').filter(Boolean),
      leaseCalls: readFileSync(leaseCalls, 'utf8').split('\n').filter(Boolean),
    };
  } catch (error) {
    child.kill('SIGTERM');
    await exit;
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

async function runUploadInterrupted(name: string, cdnKey = 'images/blog/cover.webp') {
  const dir = join(SCRATCH, name);
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeStubs(bin);
  const file = join(dir, cdnKey.endsWith('.html') ? 'index.html' : 'cover.webp');
  writeFileSync(file, 'fixture bytes');
  const calls = join(dir, 'calls.log');
  const leaseCalls = join(dir, 'lease-calls.log');
  const writerEvents = join(dir, 'writer-events.log');
  const leaseState = join(dir, 'lease-state');
  writeFileSync(calls, '');
  writeFileSync(leaseCalls, '');
  writeFileSync(writerEvents, '');

  const child = spawn('bash', ['scripts/lib/upload-cdn-file.sh', file, cdnKey], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HOME: dir,
      RUNNER_TEMP: dir,
      R2_ACCESS_KEY_ID: 'k',
      R2_SECRET_ACCESS_KEY: 's',
      R2_S3_ENDPOINT: 'https://r2.invalid',
      R2_BUCKET: 'bkt',
      R2_TIMEOUT_OBJECT_S: '120',
      STUB_CALLS: calls,
      STUB_LEASE_CALLS: leaseCalls,
      STUB_IMAGE_WRITER_EVENT_FILE: writerEvents,
      STUB_IMAGE_WRITER_COPYTO: '1',
      STUB_LEASE_STATE: leaseState,
      STUB_REAL_NODE: process.execPath,
      STUB_DIR: dir,
    },
  });
  let stderr = '';
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let deadline = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try {
    const startDeadline = Date.now() + 5_000;
    while (Date.now() < startDeadline && !readFileSync(writerEvents, 'utf8').includes('copyto-started')) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`single-file upload exited before copyto began (${child.exitCode ?? child.signalCode}): ${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!readFileSync(writerEvents, 'utf8').includes('copyto-started')) {
      throw new Error(`single-file upload did not start before the test deadline: ${stderr}`);
    }
    clearTimeout(deadline);
    deadline = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.kill('SIGTERM');
    const result = await exit;
    return {
      ...result,
      stderr,
      dir,
      bin,
      file,
      calls,
      leaseCalls,
      leaseState,
      writerEvents,
    };
  } catch (error) {
    child.kill('SIGTERM');
    await exit;
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

async function runTimeoutLeaderExit(name: string) {
  const dir = join(SCRATCH, name);
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const events = join(dir, 'events.log');
  const writerScript = join(dir, 'writer.sh');
  writeFileSync(events, '');
  writeFileSync(writerScript, `#!/usr/bin/env bash
trap 'printf "leader-term\\n" >> "$STUB_PROCESS_EVENTS"; exit 0' TERM
(
  trap '' TERM
  printf 'writer-started\\n' >> "$STUB_PROCESS_EVENTS"
  sleep 30
  printf 'writer-after-stop\\n' >> "$STUB_PROCESS_EVENTS"
) &
wait
`);
  writeFileSync(join(bin, 'timeout'), `#!/usr/bin/env bash
[ "$1" = "-k" ] && shift 2
shift
exec "$@"
`);
  chmodSync(writerScript, 0o755);
  chmodSync(join(bin, 'timeout'), 0o755);

  const shell = `
set -m
source scripts/lib/r2-image-lease-process.sh
_R2_IMAGE_LEASE_ACTIVE=1
_R2_IMAGE_LEASE_TIMEOUT_PID=
_R2_IMAGE_LEASE_TIMEOUT_PGID=
_R2_IMAGE_LEASE_RELEASE_ALLOWED=1
_R2_IMAGE_LEASE_SIGNAL_HANDLER=_test_signal_cleanup
_test_signal_cleanup() {
  local status="$1" pgid="$_R2_IMAGE_LEASE_TIMEOUT_PGID"
  if ! _r2_image_lease_stop_timeout; then
    printf 'lease-kept\\n' >> "$STUB_PROCESS_EVENTS"
    exit "$status"
  fi
  if ps -axo pgid=,stat= 2>/dev/null | awk -v pgid="$pgid" '$1 == pgid && $2 !~ /^Z/ { live = 1 } END { exit (live ? 0 : 1) }'; then
    printf 'release-with-live-writer\\n' >> "$STUB_PROCESS_EVENTS"
    exit 91
  fi
  printf 'release-safe\\n' >> "$STUB_PROCESS_EVENTS"
  exit "$status"
}
trap '_r2_image_lease_dispatch_signal 143' TERM
_r2_image_lease_wait_timeout timeout -k 10 120 bash "$STUB_WRITER_SCRIPT"
printf 'unexpected-natural-exit\\n' >> "$STUB_PROCESS_EVENTS"
`;
  const child = spawn('bash', ['-c', shell], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      STUB_PROCESS_EVENTS: events,
      STUB_WRITER_SCRIPT: writerScript,
    },
  });
  let stderr = '';
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 7_000);
  try {
    const startDeadline = Date.now() + 5_000;
    while (Date.now() < startDeadline && !readFileSync(events, 'utf8').includes('writer-started')) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`timeout writer exited before its child started (${child.exitCode ?? child.signalCode}): ${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!readFileSync(events, 'utf8').includes('writer-started')) {
      throw new Error(`timeout writer child did not start before the test deadline: ${stderr}`);
    }
    child.kill('SIGTERM');
    return {
      ...(await exit),
      events: readFileSync(events, 'utf8').split('\n').filter(Boolean),
      stderr,
    };
  } catch (error) {
    child.kill('SIGTERM');
    await exit;
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

const COPIED_A = JSON.stringify({ level: 'info', msg: 'Copied (replaced existing)', object: 'a.js' });

function completionMarkerPuts(calls: string[]): string[] {
  return calls.filter((call) => (
    /^rclone copyto (?!:s3:)\S+ :s3:bkt\/cdn-publish-complete-id\.txt(?:\s|$)/.test(call)
  ));
}

describe('behaviour: the R2 images batch holds every present namespace lease', () => {
  const acquiredContext = '{"version":1,"leases":[{"namespace":"blog","owner":"test-owner","leaseId":"acquired-blog-lease","expiresAt":1800000000000}]}';
  const acquiredPlacesContext = '{"version":1,"leases":[{"namespace":"places","owner":"test-owner","leaseId":"acquired-places-lease","expiresAt":1800000000000}]}';
  const acquiredBothContext = '{"version":1,"leases":[{"namespace":"blog","owner":"test-owner","leaseId":"acquired-blog-lease","expiresAt":1800000000000},{"namespace":"places","owner":"test-owner","leaseId":"acquired-places-lease","expiresAt":1800000000000}]}';

  it('acquires once, holds the capability through the images copy, then releases that lease', () => {
    const r = runPublish('blog-lease-held', { STUB_BLOG_IMAGES: '1' });
    expect(r.code).toBe(0);
    expect(r.leaseCalls).toEqual([
      'acquire:blog',
      `copy:images:${acquiredContext}`,
      `release:${acquiredContext}`,
    ]);
    expect(r.calls.some((call) => /^rclone copy \S+ :s3:bkt\/images /.test(call))).toBe(true);
  });

  it('a places-only batch acquires and releases the places lease around the images copy', () => {
    const r = runPublish('places-lease-only', { STUB_PLACES_IMAGES: '1' });
    expect(r.code).toBe(0);
    expect(r.leaseCalls).toEqual([
      'acquire:places',
      `copy:images:${acquiredPlacesContext}`,
      `release:${acquiredPlacesContext}`,
    ]);
  });

  it('a batch with blog and places acquires both leases before the images copy', () => {
    const r = runPublish('blog-and-places-leases', {
      STUB_BLOG_IMAGES: '1',
      STUB_PLACES_IMAGES: '1',
    });
    expect(r.code).toBe(0);
    expect(r.leaseCalls).toEqual([
      'acquire:blog,places',
      `copy:images:${acquiredBothContext}`,
      `release:${acquiredBothContext}`,
    ]);
  });

  it('an acquire timeout skips the whole images batch and withholds the completion marker', () => {
    const r = runPublish('blog-lease-timeout', {
      STUB_BLOG_IMAGES: '1',
      STUB_LEASE_ACQUIRE_STATUS: '124',
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/could not acquire the image namespace lease; skipping images\/ sync/);
    expect(r.leaseCalls).toEqual(['acquire:blog']);
    expect(r.calls.some((call) => /^rclone copy \S+ :s3:bkt\/images /.test(call))).toBe(false);
    expect(completionMarkerPuts(r.calls)).toEqual([]);
  });

  it('a release error withholds the completion marker after the protected copy', () => {
    const r = runPublish('blog-lease-release-fails', {
      STUB_BLOG_IMAGES: '1',
      STUB_LEASE_RELEASE_STATUS: '1',
    });
    expect(r.code).toBe(0);
    expect(r.leaseCalls).toEqual([
      'acquire:blog',
      `copy:images:${acquiredContext}`,
      `release:${acquiredContext}`,
    ]);
    expect(r.stdout).toMatch(/image namespace lease release failed; refusing to mark the R2 payload complete/);
    expect(completionMarkerPuts(r.calls)).toEqual([]);
  });

  it('TERM stops and reaps the image writer before releasing its lease, then permits the next acquire', async () => {
    const interrupted = await runPublishInterrupted('blog-lease-term-cleanup', {});
    expect(interrupted.code ?? (interrupted.signal === 'SIGTERM' ? 143 : null)).toBe(143);
    expect(interrupted.copyEvents).toEqual(['copy-started', 'copy-stopped', 'release']);
    expect(interrupted.leaseCalls).toEqual([
      'acquire:blog',
      expect.stringMatching(/^copy:images:/),
      expect.stringMatching(/^release:/),
    ]);
    expect(existsSync(interrupted.leaseState)).toBe(false);

    const nextWriter = runPublish('blog-lease-after-term', {
      STUB_BLOG_IMAGES: '1',
      STUB_LEASE_STATE: interrupted.leaseState,
    });
    expect(nextWriter.code).toBe(0);
    expect(nextWriter.leaseCalls[0]).toBe('acquire:blog');
    expect(nextWriter.leaseCalls).toContain('release:{"version":1,"leases":[{"namespace":"blog","owner":"test-owner","leaseId":"acquired-blog-lease","expiresAt":1800000000000}]}');
    expect(existsSync(interrupted.leaseState)).toBe(false);
  });

  it('single-file image upload stops and reaps copyto before releasing its owned lease', async () => {
    const interrupted = await runUploadInterrupted('single-image-lease-term-cleanup');
    expect(interrupted.code ?? (interrupted.signal === 'SIGTERM' ? 143 : null)).toBe(143);
    expect(readFileSync(interrupted.writerEvents, 'utf8').split('\n').filter(Boolean))
      .toEqual(['copyto-started', 'copyto-stopped', 'release']);
    const firstCalls = readFileSync(interrupted.leaseCalls, 'utf8').split('\n').filter(Boolean);
    expect(firstCalls[0]).toBe('acquire:blog');
    expect(firstCalls[1]).toMatch(/^verify:blog:/);
    expect(firstCalls[2]).toMatch(/^release:/);
    expect(existsSync(interrupted.leaseState)).toBe(false);

    execFileSync('bash', ['scripts/lib/upload-cdn-file.sh', interrupted.file, 'images/blog/cover.webp'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 5_000,
      env: {
        PATH: `${interrupted.bin}:${process.env.PATH ?? ''}`,
        HOME: interrupted.dir,
        RUNNER_TEMP: interrupted.dir,
        R2_ACCESS_KEY_ID: 'k',
        R2_SECRET_ACCESS_KEY: 's',
        R2_S3_ENDPOINT: 'https://r2.invalid',
        R2_BUCKET: 'bkt',
        R2_TIMEOUT_OBJECT_S: '120',
        STUB_CALLS: interrupted.calls,
        STUB_LEASE_CALLS: interrupted.leaseCalls,
        STUB_LEASE_STATE: interrupted.leaseState,
        STUB_REAL_NODE: process.execPath,
        STUB_DIR: interrupted.dir,
      },
    });
    const allLeaseCalls = readFileSync(interrupted.leaseCalls, 'utf8').split('\n').filter(Boolean);
    expect(allLeaseCalls.filter((call) => call === 'acquire:blog')).toHaveLength(2);
    expect(allLeaseCalls.filter((call) => call.startsWith('release:'))).toHaveLength(2);
    expect(existsSync(interrupted.leaseState)).toBe(false);
  });

  it('single-file non-image upload stops and reaps copyto without acquiring or releasing an image lease', async () => {
    const interrupted = await runUploadInterrupted('single-page-lease-free-term-cleanup', 'edge/frontaliere/index.html');
    expect(interrupted.code ?? (interrupted.signal === 'SIGTERM' ? 143 : null)).toBe(143);
    expect(readFileSync(interrupted.writerEvents, 'utf8').split('\n').filter(Boolean))
      .toEqual(['copyto-started', 'copyto-stopped']);
    expect(readFileSync(interrupted.leaseCalls, 'utf8').trim()).toBe('');
    expect(existsSync(interrupted.leaseState)).toBe(false);
  });

  it('verifies a caller-owned capability and never releases it', () => {
    const callerContext = '{"version":1,"leases":[{"namespace":"blog","owner":"test-owner","leaseId":"caller-owned","expiresAt":1800000000000}]}';
    const r = runPublish('blog-lease-inherited', {
      STUB_BLOG_IMAGES: '1',
      FRONTALIERE_R2_IMAGE_LEASE_CONTEXT: callerContext,
    });
    expect(r.code).toBe(0);
    expect(r.leaseCalls).toEqual([
      `verify:blog:${callerContext}`,
      `copy:images:${callerContext}`,
    ]);
  });

  it('verifies each namespace in a caller-owned multi-namespace capability independently', () => {
    const callerContext = JSON.stringify({
      version: 1,
      leases: ['blog', 'places'].map((namespace) => ({
        namespace,
        owner: 'test-owner',
        leaseId: `caller-owned-${namespace}`,
        expiresAt: 1_800_000_000_000,
      })),
    });
    const r = runPublish('multi-namespace-lease-inherited', {
      STUB_BLOG_IMAGES: '1',
      STUB_PLACES_IMAGES: '1',
      FRONTALIERE_R2_IMAGE_LEASE_CONTEXT: callerContext,
    });
    expect(r.code).toBe(0);
    expect(r.leaseCalls).toEqual([
      `verify:blog:${callerContext}`,
      `verify:places:${callerContext}`,
      `copy:images:${callerContext}`,
    ]);
  });

  it('an invalid caller-owned capability is fail-closed without acquire, copy, or release', () => {
    const callerContext = '{"version":1,"leases":[{"namespace":"places","owner":"test-owner","leaseId":"wrong-namespace","expiresAt":1800000000000}]}';
    const r = runPublish('blog-lease-invalid-inherited', {
      STUB_BLOG_IMAGES: '1',
      FRONTALIERE_R2_IMAGE_LEASE_CONTEXT: callerContext,
      STUB_LEASE_VERIFY_STATUS: '1',
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/existing image lease does not cover the requested namespaces or is no longer valid; skipping images\/ sync/);
    expect(r.leaseCalls).toEqual([`verify:blog:${callerContext}`]);
    expect(r.calls.some((call) => /^rclone copy \S+ :s3:bkt\/images /.test(call))).toBe(false);
    expect(completionMarkerPuts(r.calls)).toEqual([]);
  });
});

describe('behaviour: timeout cleanup retains the verified process group after its leader exits', () => {
  it('keeps the lease until a TERM-ignoring descendant is killed with its former leader group', async () => {
    const result = await runTimeoutLeaderExit('timeout-leader-exits-before-child');
    expect(result.code ?? (result.signal === 'SIGTERM' ? 143 : null)).toBe(143);
    expect(result.events).toContain('leader-term');
    expect(result.events).toContain('release-safe');
    expect(result.events).not.toContain('release-with-live-writer');
    expect(result.events).not.toContain('lease-kept');
    expect(result.events).not.toContain('writer-after-stop');
    expect(result.events.indexOf('leader-term')).toBeLessThan(result.events.indexOf('release-safe'));
  });
});

describe('behaviour: an R2 call that never answers does not hang the CDN push', () => {
  it('ledger read that never answers → bounded; empty upload log still leaves every stage key dirty', () => {
    const r = runPublish('ledger-hangs', { STUB_LEDGER: 'hang', STUB_ASSETS_LOG: '' });
    expect(r.code).toBe(0);
    expect(r.seconds).toBeLessThan(25);
    expect(r.stdout).toMatch(/::warning::\[r2\] purge ledger read failed or exceeded 2s \(exit 124\) — starting from an empty ledger/);
    expect(r.stdout).toMatch(/ledger: 0 key\(s\) uploaded by this run, 2 more changed in R2/);
    expect(r.calls.some((c) => / s3api list-objects-v2 .*Key:Key,ETag:ETag/.test(c)), 'no R2 listing after a failed read').toBe(false);
    // No CF_API_TOKEN in the test: no batch succeeds, so neither fingerprint
    // may be persisted as clean even though the ledger object is writable.
    expect(r.ledger).toEqual(expect.objectContaining({ version: 1, keys: {} }));
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

  it('ledger absent → no R2 listing; it starts empty, every stage key is dirty and none is marked clean without a purge', () => {
    const r = runPublish('ledger-absent', { STUB_LEDGER: 'absent', STUB_ASSETS_LOG: '' });
    expect(r.code).toBe(0);
    // The janitor's dry-run scan (after the marker) is the only aws call left;
    // nothing lists R2 on the way to the assets copy.
    const assetsAt = r.calls.findIndex((c) => /^rclone copy \S+ :s3:bkt\/assets /.test(c));
    expect(assetsAt).toBeGreaterThan(-1);
    expect(r.calls.slice(0, assetsAt).filter((c) => /^aws /.test(c)), 'no R2 listing before the assets copy').toEqual([]);
    expect(r.calls.some((c) => /Key:Key,ETag:ETag/.test(c)), 'no seed-style listing anywhere').toBe(false);
    expect(r.stdout).toMatch(/no usable purge ledger — starting from an empty one/);
    expect(r.stdout).toMatch(/ledger: 0 key\(s\) uploaded by this run, 2 more changed in R2/);
    // No CF_API_TOKEN in the test: nothing is purged, so nothing may be marked clean.
    expect(r.ledger).toEqual(expect.objectContaining({ version: 1, keys: {} }));
  });

  it('a later prefix failing: an incomplete publish window blocks the asset purge', () => {
    const r = runPublish('later-prefix-fails', {
      STUB_LEDGER: 'hang',
      STUB_ASSETS_LOG: COPIED_A,
      STUB_FAIL_PREFIX: 'data',
      STUB_PUBLISH_INCOMPLETE: '1',
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/NOT writing marker/);
    expect(r.stdout).toMatch(/skipping targeted CDN purge: publish window is not coherent/);
    expect(r.stdout).not.toMatch(/ledger: 1 key\(s\) uploaded by this run/);
    expect(r.ledger).toBeNull();
    expect(completionMarkerPuts(r.calls)).toEqual([]);
    expect(r.calls.some((c) => /rclone \S+\/stage\/cdn-build-id\.txt :s3:bkt\/cdn-build-id\.txt/.test(c))).toBe(false);
  });

  it('a failed complete marker PUT: the just-uploaded payload is not purged', () => {
    const r = runPublish('complete-marker-fails', {
      STUB_LEDGER: 'absent',
      STUB_ASSETS_LOG: COPIED_A,
      STUB_FAIL_COMPLETE: '1',
      STUB_PUBLISH_INCOMPLETE: '1',
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/R2 publish-complete marker PUT failed/);
    expect(r.stdout).toMatch(/skipping targeted CDN purge: publish window is not coherent/);
    expect(r.stdout).not.toMatch(/ledger: 1 key\(s\) uploaded by this run/);
    expect(r.ledger).toBeNull();
    expect(r.calls.some((c) => /:s3:bkt\/cdn-build-id\.txt/.test(c))).toBe(true);
    expect(completionMarkerPuts(r.calls)).toHaveLength(1);
  });
});

// ── the limit itself: `timeout 0` is NO limit ───────────────────────────────
//
// GNU `timeout` reads a duration of 0 as "never time out", so a limit taken
// straight from `${R2_TIMEOUT_OBJECT_S:-120}` let `R2_TIMEOUT_OBJECT_S=0` (or
// an empty-but-set value through `:-`'s cousins, or "2m", "inf") turn every
// bounded R2 call back into an unbounded one — the shape NX-SKEW-2b exists to
// forbid. `_r2_timeout_s` takes a whole number of seconds from 1 to 9999 and
// falls back to the default otherwise.

/** The `_r2_timeout_s() { … }` block of a script, as written. */
function r2TimeoutFunction(source: string): string | null {
  return source.match(/^_r2_timeout_s\(\) \{\n[\s\S]*?\n\}\n/m)?.[0] ?? null;
}

describe('static: R2 limits from the environment go through _r2_timeout_s', () => {
  for (const file of DEPLOY_R2_SCRIPTS) {
    it(`${file}: no R2_TIMEOUT_* is read raw with a :- default`, () => {
      const code = read(file).split('\n').filter((l) => !l.trim().startsWith('#'));
      expect(code.filter((l) => /\$\{R2_TIMEOUT_\w+:?-/.test(l)).map((l) => l.trim())).toEqual([]);
    });
  }

  it('the validator is byte-identical in every deploy R2 script', () => {
    const copies = DEPLOY_R2_SCRIPTS.map((f) => r2TimeoutFunction(read(f)));
    for (const [i, copy] of copies.entries()) expect(copy, `${DEPLOY_R2_SCRIPTS[i]}: _r2_timeout_s not found`).toBeTruthy();
    expect(new Set(copies).size).toBe(1);
  });
});

describe('behaviour: _r2_timeout_s rejects 0 and every non-positive or open-ended value', () => {
  const cases: Array<[string | undefined, string]> = [
    ['30', '30'],
    ['1', '1'],
    ['9999', '9999'],
    ['0', '120'],
    ['00', '120'],
    ['', '120'],
    [undefined, '120'],
    ['-5', '120'],
    ['2m', '120'],
    ['inf', '120'],
    ['1.5', '120'],
    ['10000', '120'],
    ['99999999999999999999', '120'],
  ];
  for (const [value, expected] of cases) {
    it(`R2_TIMEOUT_OBJECT_S=${value === undefined ? '(unset)' : JSON.stringify(value)} → ${expected}`, () => {
      const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
      if (value !== undefined) env.R2_TIMEOUT_OBJECT_S = value;
      const out = execFileSync(
        'bash',
        ['-c', 'set -uo pipefail; source scripts/lib/deploy-it-pages-prep.sh && _r2_timeout_s R2_TIMEOUT_OBJECT_S 120'],
        { cwd: ROOT, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      expect(out.trim()).toBe(expected);
    });
  }

  /** Runs upload-cdn-file.sh with a `timeout` stub that records its limit. */
  function uploadLimit(name: string, value: string): string {
    const dir = join(SCRATCH, name);
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'rclone'), '#!/usr/bin/env bash\nexit 0\n');
    writeFileSync(
      join(bin, 'timeout'),
      '#!/usr/bin/env bash\n[ "$1" = "-k" ] && shift 2\necho "$1" >> "$STUB_LIMITS"\nshift\nexec "$@"\n',
    );
    chmodSync(join(bin, 'rclone'), 0o755);
    chmodSync(join(bin, 'timeout'), 0o755);
    const file = join(dir, 'hero.webp');
    writeFileSync(file, 'x');
    const limits = join(dir, 'limits.log');
    writeFileSync(limits, '');
    const out = execFileSync('bash', ['scripts/lib/upload-cdn-file.sh', file, 'images/hero.webp'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        RUNNER_TEMP: dir,
        R2_ACCESS_KEY_ID: 'k',
        R2_SECRET_ACCESS_KEY: 's',
        R2_S3_ENDPOINT: 'https://r2.invalid',
        R2_BUCKET: 'bkt',
        R2_TIMEOUT_OBJECT_S: value,
        STUB_LIMITS: limits,
      },
    });
    expect(out).toMatch(/✅ uploaded/);
    return readFileSync(limits, 'utf8').trim();
  }

  /** Runs `upload-cdn-file.sh --check` with a deterministic rclone stat result. */
  function checkObjectKey(
    name: string,
    key: string,
    statJson: string,
    rcloneStatus = 0,
    timeoutSeconds = '120',
  ) {
    const dir = join(SCRATCH, name);
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, 'rclone'),
      '#!/usr/bin/env bash\nprintf "%s\\0" "$@" > "$STUB_RCLONE_ARGS"\nprintf "%s" "$STUB_RCLONE_OUTPUT"\nexit "$STUB_RCLONE_STATUS"\n',
    );
    writeFileSync(
      join(bin, 'timeout'),
      '#!/usr/bin/env bash\n[ "$1" = "-k" ] && shift 2\necho "$1" >> "$STUB_LIMITS"\nshift\nexec "$@"\n',
    );
    chmodSync(join(bin, 'rclone'), 0o755);
    chmodSync(join(bin, 'timeout'), 0o755);
    const limits = join(dir, 'limits.log');
    const argsFile = join(dir, 'rclone-args.bin');
    writeFileSync(limits, '');
    const out = execFileSync('bash', ['scripts/lib/upload-cdn-file.sh', '--check', key], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        RUNNER_TEMP: dir,
        R2_ACCESS_KEY_ID: 'k',
        R2_SECRET_ACCESS_KEY: 's',
        R2_S3_ENDPOINT: 'https://r2.invalid',
        R2_BUCKET: 'bkt',
        R2_TIMEOUT_OBJECT_S: timeoutSeconds,
        STUB_LIMITS: limits,
        STUB_RCLONE_ARGS: argsFile,
        STUB_RCLONE_OUTPUT: statJson,
        STUB_RCLONE_STATUS: String(rcloneStatus),
      },
    });
    return {
      out,
      limits: readFileSync(limits, 'utf8').trim(),
      args: readFileSync(argsFile, 'utf8').split('\0').filter(Boolean),
    };
  }

  /** Runs the timed lookup and asserts that a prefix-only R2 stat is missing. */
  function lookupLimit(name: string, value: string): string {
    const output = JSON.stringify({ Name: 'hero.webp', Path: 'images/hero.webp', Size: -1, IsDir: true });
    const result = checkObjectKey(name, 'images/hero.webp', output, 0, value);
    expect(result.out).toMatch(/missing images\/hero\.webp/);
    return result.limits;
  }

  it('upload-cdn-file.sh --check: the lookup runs under the same per-object limit', () => {
    expect(lookupLimit('lookup-valid', '45')).toBe('45');
    expect(lookupLimit('lookup-zero', '0')).toBe('120');
  });

  it('upload-cdn-file.sh --check: a zero-byte object exists even with special key characters', () => {
    const key = "images/équipe, \"hero\"; l'été.webp";
    const output = JSON.stringify({ Name: key.split('/').at(-1), Path: key, Size: 0, IsDir: false });
    const result = checkObjectKey('lookup-zero-byte-special-key', key, output);
    expect(result.out).toMatch(/✅ exists/);
    expect(result.args).toContain('lsjson');
    expect(result.args).toContain('--stat');
    expect(result.args.at(-1)).toBe(`:s3:bkt/${key}`);
  });

  it('upload-cdn-file.sh --check: malformed stat metadata is indeterminate, not a miss', () => {
    const result = checkObjectKey('lookup-invalid-stat', 'images/hero.webp', 'not-json');
    expect(result.out).toMatch(/check indeterminate.*invalid R2 object metadata/);
    expect(result.out).not.toMatch(/❌ missing/);
  });

  it('upload-cdn-file.sh --check: preserves an R2 lookup failure as indeterminate', () => {
    const result = checkObjectKey('lookup-failed', 'images/hero.webp', '{}', 5);
    expect(result.out).toMatch(/check indeterminate.*R2 lookup failed \(exit 5\)/);
  });

  it('upload-cdn-file.sh: R2_TIMEOUT_OBJECT_S=0 still runs the PUT under the 120 s default', () => {
    expect(uploadLimit('upload-zero', '0')).toBe('120');
  });

  it('upload-cdn-file.sh: a valid R2_TIMEOUT_OBJECT_S is passed through', () => {
    expect(uploadLimit('upload-valid', '45')).toBe('45');
  });
});
