// @vitest-environment node
/**
 * `Crawler Failure: Run <slug>` must carry the failing member's own error.
 *
 * Issue 11553 (csvp-poschiavo, 3 red waves) was opened with only the run URL,
 * the branch and the trigger; the automatic cycle closed its diagnosis as
 * `no-root-cause` because the cause lived in the log of one member of a
 * 29-crawler group job. The member log already existed on the runner (the
 * detached worker's stdout): these tests pin that the generated reporter
 * passes it to the issue creator and that the creator quotes it in the body.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MEMBER_LOG_FILE_ENV,
  buildCrawlerLaunchShellBody,
  buildCrawlerShellBody,
} from '../scripts/generate-crawler-group-workflows.mjs';
import { appendLogExcerpt, buildLogExcerptSection } from '../scripts/lib/github-issue-creator.mjs';

const ROOT = path.resolve(__dirname, '..');
const CREATOR = path.join(ROOT, 'scripts/lib/github-issue-creator.mjs');
const CSVP_MEMBER_LOG = path.join(ROOT, 'tests/fixtures/crawler-failure-report/csvp-poschiavo-member-log.txt');
const CSVP_ERROR_LINE = 'snapshot is not a proven authoritative empty state: rows=0, state=(unset)';

// The one reporter form every crawler in data/crawler-manifest.json uses.
const MANIFEST_REPORTER_RUN = `node scripts/lib/github-issue-creator.mjs \\
  --title "Crawler Failure: \${{ github.workflow }}" \\
  --description "## Crawler fallito
**Run:** https://github.com/\${{ github.repository }}/actions/runs/\${{ github.run_id }}
**Branch:** \${{ github.ref_name }}
**Trigger:** \${{ github.event_name }}" \\
  --priority 2 \\
  --label Bug \\
  --workflow "\${{ github.workflow }}"
`;

const dirs: string[] = [];
function tmp(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('issue creator — log excerpt of the failed step', () => {
  it('quotes the error line of the real csvp-poschiavo member log', () => {
    const body = appendLogExcerpt('## Crawler fallito\n**Run:** x', CSVP_MEMBER_LOG);

    expect(body.startsWith('## Crawler fallito\n**Run:** x')).toBe(true);
    expect(body).toContain('### Errore del passo (estratto del log del membro)');
    const errorBlock = body.split('**Righe di errore:**')[1]?.split('**Ultime righe del log**')[0] ?? '';
    expect(errorBlock).toContain(CSVP_ERROR_LINE);
  });

  it('strips ANSI colours and keeps only the tail of a long log', () => {
    const noise = Array.from({ length: 200 }, (_, i) => `progress line ${i}`);
    const section = buildLogExcerptSection(['\u001b[31m❌ early failure\u001b[0m', ...noise].join('\n'));

    expect(section).not.toContain('\u001b[');
    expect(section).toContain('❌ early failure');
    expect(section).toContain(`progress line ${noise.length - 1}`);
    expect(section).not.toContain('progress line 0\n');
  });

  it('says so when the log is missing instead of failing the report', () => {
    expect(appendLogExcerpt('d', '')).toContain('Estratto del log non disponibile');
    expect(appendLogExcerpt('d', path.join(tmp('no-log-'), 'absent.log'))).toContain('ENOENT');
  });

  it('CLI: --log-excerpt-file puts the member error into the created issue body', () => {
    const stubDir = tmp('gh-excerpt-stub-');
    const calls = path.join(stubDir, 'calls.log');
    fs.writeFileSync(path.join(stubDir, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === 'issue' && args[1] === 'list') { process.stdout.write('[]'); process.exit(0); }
if (args[0] === 'issue' && args[1] === 'create') { process.stdout.write('https://github.com/o/r/issues/1'); process.exit(0); }
process.exit(0);
`, { mode: 0o755 });

    const res = spawnSync(process.execPath, [
      CREATOR,
      '--title', 'Crawler Failure: Run csvp-poschiavo',
      '--description', '## Crawler fallito\n**Run:** fixture',
      '--log-excerpt-file', CSVP_MEMBER_LOG,
      '--priority', '2',
      '--label', 'Bug',
      '--workflow', 'Run csvp-poschiavo',
      '--consecutive-gate', '-1',
      '--no-reopen',
    ], { encoding: 'utf8', env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, GH_REPO: 'o/r' } });

    expect(res.status, res.stderr).toBe(0);
    const create = fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as string[])
      .find((args) => args[0] === 'issue' && args[1] === 'create');
    expect(create).toBeDefined();
    const body = create![create!.indexOf('--body') + 1];
    expect(body).toContain('**Run:** fixture');
    expect(body).toContain(CSVP_ERROR_LINE);
  });
});

describe('generated group workflow — reporter receives the member log', () => {
  function crawler(runCommand: string) {
    return {
      slug: 'excerpt-crawler',
      runStep: { env: {}, run: runCommand },
      postSteps: [{ name: 'Report failure to GitHub Issues', if: 'failure()', env: {}, run: MANIFEST_REPORTER_RUN }],
    };
  }

  // Executes the generated body exactly as the detached worker does: stdout
  // and stderr go to the member log, and the worker exports its path. A stub
  // `node` on PATH records what the reporter was given at the moment it ran.
  function runAsWorker(rawBody: string) {
    // Actions substitutes `${{ … }}` before bash ever sees the script; raw,
    // bash rejects them as a bad substitution and the reporter never runs.
    const body = rawBody.replace(/\$\{\{[^}]*\}\}/g, 'actions-expression');
    expect(body).not.toContain('${{');
    const dir = tmp('member-log-');
    const log = path.join(dir, 'excerpt-crawler.log');
    const seen = path.join(dir, 'reporter-saw.txt');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'node'), [
      '#!/usr/bin/env bash',
      'prev=""; file=""',
      'for a in "$@"; do if [ "$prev" = "--log-excerpt-file" ]; then file="$a"; fi; prev="$a"; done',
      `{ printf 'ARGS=%s\\n' "$*"; printf 'FILE=%s\\n' "$file"; if [ -n "$file" ]; then cat "$file"; fi; } > ${JSON.stringify(seen)}`,
      '',
    ].join('\n'), { mode: 0o755 });
    // Portable timeout(1): macOS has none; the wrapper semantics are not under test.
    fs.writeFileSync(path.join(bin, 'timeout'), [
      '#!/usr/bin/env bash',
      'while [[ "$1" == --* ]]; do shift; done',
      'shift',
      'exec "$@"',
      '',
    ].join('\n'), { mode: 0o755 });
    const fd = fs.openSync(log, 'w');
    try {
      execFileSync('bash', ['-c', body], {
        stdio: ['ignore', fd, fd],
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, [MEMBER_LOG_FILE_ENV]: log, GITHUB_STEP_SUMMARY: '/dev/null' },
      });
    } catch {
      // The body exits non-zero for a failed crawl; the reporter output is what matters.
    } finally {
      fs.closeSync(fd);
    }
    return { log, seen: fs.existsSync(seen) ? fs.readFileSync(seen, 'utf8') : '' };
  }

  it('the per-crawler reporter is handed the log that already holds the crawl error', () => {
    const { log, seen } = runAsWorker(buildCrawlerShellBody(crawler(`( echo '❌ fixture crawler failed: ${CSVP_ERROR_LINE}'; exit 1 )`)));

    expect(seen).toContain(`FILE=${log}`);
    expect(seen).toContain(CSVP_ERROR_LINE);
  });

  it('the target-timeout variant hands over the same log', () => {
    const { log, seen } = runAsWorker(buildCrawlerShellBody({
      ...crawler(`( echo '❌ fixture crawler failed: ${CSVP_ERROR_LINE}'; exit 1 )`),
      targetTimeoutMinutes: 30,
    }));

    expect(seen).toContain(`FILE=${log}`);
    expect(seen).toContain(CSVP_ERROR_LINE);
  });

  it('the detached worker exports the same file the launcher redirects into', () => {
    const launch = buildCrawlerLaunchShellBody({ ...crawler('true'), slug: 'excerpt-crawler' }, 13);

    expect(launch).toContain('log_path="$state_dir/excerpt-crawler.log"');
    expect(launch).toContain(`export ${MEMBER_LOG_FILE_ENV}="$RUNNER_TEMP/crawler-generation/group-13/excerpt-crawler.log"`);
    expect(launch).toContain('state_dir="$RUNNER_TEMP/crawler-generation/group-13"');
  });

  it('every committed group workflow reporter passes --log-excerpt-file', () => {
    const files = [
      ...fs.readdirSync(path.join(ROOT, '.github/workflows'))
        .filter((f) => /^crawler-group-\d+(?:-logic)?\.yml$/.test(f))
        .map((f) => path.join(ROOT, '.github/workflows', f)),
      ...fs.readdirSync(path.join(ROOT, '.github/corpus-workflows'))
        .filter((f) => /^crawler-group-\d+\.yml$/.test(f))
        .map((f) => path.join(ROOT, '.github/corpus-workflows', f)),
    ];
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const invocations = text.match(/node scripts\/lib\/github-issue-creator\.mjs(?: --log-excerpt-file)?/g) ?? [];
      const bare = invocations.filter((call) => !call.endsWith('--log-excerpt-file'));
      // The watchdog reporter names the log path itself, after --description.
      const watchdog = text.match(/--description "\$watchdog_description" --log-excerpt-file /g) ?? [];
      if (bare.length !== watchdog.length) offenders.push(`${path.basename(file)}: ${bare.length - watchdog.length} reporter(s) without the member log`);
      const launchers = text.match(/log_path="\$state_dir\/[^"]+\.log"/g) ?? [];
      const exports = text.match(new RegExp(`export ${MEMBER_LOG_FILE_ENV}=`, 'g')) ?? [];
      if (launchers.length !== exports.length) offenders.push(`${path.basename(file)}: ${launchers.length} launchers, ${exports.length} log exports`);
    }
    expect(offenders, 'regenerate with node scripts/generate-crawler-group-workflows.mjs').toEqual([]);
  });
});
