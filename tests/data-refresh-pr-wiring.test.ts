import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('protected data refreshes publish through pull requests', () => {
  const refreshes = [
    '.github/workflows/refresh-job-popularity.yml',
    '.github/workflows/refresh-article-trending.yml',
    '.github/workflows/monitor-telegram-member-count.yml',
    '.github/workflows/newsletter-qa.yml',
    '.github/workflows/update-fuel-prices.yml',
    '.github/workflows/telegram-channel-broadcast.yml',
    '.github/workflows/update-exchange-history.yml',
    '.github/workflows/cf-5xx-monitor.yml',
    '.github/workflows/cron-dispatch-canary.yml',
    '.github/workflows/update-weather.yml',
    '.github/workflows/crawl-events.yml',
  ];

  it.each(refreshes)('%s uses the shared PR publisher', (workflowPath) => {
    const workflow = read(workflowPath);
    expect(workflow).toContain('pull-requests: write');
    expect(workflow).toContain('load-rc-env.mjs');
    expect(workflow).toContain('mint-app-token.mjs');
    expect(workflow).toContain('scripts/lib/open-data-refresh-pr.sh');
    expect(workflow).not.toContain('scripts/lib/git-push-with-retry.sh');
    expect(workflow).not.toMatch(/git\s+push\b/);
  });

  it('publishes Newsletter QA artifacts through its stable report PR', () => {
    const workflow = read('.github/workflows/newsletter-qa.yml');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('--path docs/newsletter-qa/');
    expect(workflow).toContain('--branch chore/refresh-newsletter-qa');
    expect(workflow).not.toContain('scripts/lib/git-commit-data.sh');
  });

  it('keeps the shared publisher on the PR path, never main', () => {
    const helper = read('scripts/lib/open-data-refresh-pr.sh');
    expect(helper).toContain('gh pr create');
    expect(helper).toContain('--base main');
    expect(helper).toContain('HEAD:${BRANCH}');
    expect(helper).toContain('--force-with-lease');
    expect(helper).toContain('PUSH_URL="https://x-access-token:${GH_TOKEN}@github.com/${REPOSITORY}.git"');
    expect(helper).toContain('git ls-remote "$PUSH_URL"');
    expect(helper).toContain('if [ "$RECONCILE_COMPAT" = true ]; then');
    expect(helper).toContain(
      'git fetch --no-tags "$PUSH_URL" \\\n      "refs/heads/${BRANCH}:refs/remotes/refresh/${BRANCH}"',
    );
    expect(helper).toContain('git fetch --no-tags --depth=1 "$PUSH_URL"');
    expect(helper).toContain('git show "${REFRESH_BASE}:scripts/ci/merge-open-data-refresh.mjs"');
    expect(helper).toContain('mkdir -p "$MERGE_REFRESH_SCRIPT_DIR/scripts/ci" "$MERGE_REFRESH_SCRIPT_DIR/scripts/lib"');
    expect(helper).toContain('git show "${REFRESH_BASE}:scripts/lib/resolve-git-add-path.mjs"');
    expect(helper).toContain('node "$MERGE_REFRESH_SCRIPT_DIR/scripts/ci/merge-open-data-refresh.mjs"');
    expect(helper).toContain('trap cleanup_refresh_checkout EXIT');
    expect(helper).toContain('git checkout --detach --force "$restore_ref"');
    expect(helper.match(/REFRESH_COMMIT="\$\(git rev-parse HEAD\)"/g)).toHaveLength(1);
    expect(helper).toContain('scripts/ci/merge-open-data-refresh.mjs');
    expect(helper).toContain('--resolve-symlinks');
    expect(helper).toContain('git-add-resolved.mjs');
    expect(helper).not.toMatch(/HEAD:main/);
  });

  it('passes named three-way merge arguments without treating a value as a flag', () => {
    const output = execFileSync(
      process.execPath,
      [
        'scripts/ci/merge-open-data-refresh.mjs',
        '--base', 'HEAD',
        '--remote', 'HEAD',
        '--refresh', 'HEAD',
        // Path fittizi fuori da LIVE_DATA_ROOTS: con base e refresh uguali il
        // diff è vuoto e lo script non legge nessun file, quindi qui conta solo
        // il parsing. Un path di dato vivo faceva fallire live-data-test-guard.
        '--path', 'tests/__fixtures__/refresh-merge/stable.json',
        '--path', 'tests/__fixtures__/refresh-merge/published.json',
      ],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(output).toContain('[merge-open-data-refresh] preserved stable tree');
  });

  it('keeps the current reconciler import tree runnable after a stable-branch checkout', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-reconciler-'));
    try {
      const copied = [
        ['scripts/ci/merge-open-data-refresh.mjs', 'scripts/ci/merge-open-data-refresh.mjs'],
        ['scripts/ci/open-data-refresh-merge.mjs', 'scripts/ci/open-data-refresh-merge.mjs'],
        ['scripts/lib/resolve-git-add-path.mjs', 'scripts/lib/resolve-git-add-path.mjs'],
      ];
      for (const [source, target] of copied) {
        const targetPath = path.join(temp, target);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(path.join(ROOT, source), targetPath);
      }

      const output = execFileSync(
        process.execPath,
        [
          path.join(temp, 'scripts/ci/merge-open-data-refresh.mjs'),
          '--base', 'HEAD',
          '--remote', 'HEAD',
          '--refresh', 'HEAD',
          '--path', 'tests/__fixtures__/refresh-merge/stable.json',
        ],
        { cwd: ROOT, encoding: 'utf8' },
      );
      expect(output).toContain('[merge-open-data-refresh] preserved stable tree');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it.each([
    '.github/workflows/cf-5xx-monitor.yml',
    '.github/workflows/cron-dispatch-canary.yml',
    '.github/workflows/telegram-channel-broadcast.yml',
    '.github/workflows/update-exchange-history.yml',
    '.github/workflows/update-weather.yml',
  ])('%s writes Markdown bodies with a literal heredoc', (workflowPath) => {
    const workflow = read(workflowPath);
    expect(workflow).toContain("cat <<'EOF'");
    expect(workflow).toContain('run_url="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"');
    expect(workflow).not.toContain('cat > "$body" <<EOF');
  });

  it('preserves pending append-only Telegram history before publishing the stable branch', () => {
    const workflow = read('.github/workflows/monitor-telegram-member-count.yml');
    expect(workflow).toContain("branch='chore/telegram-member-count-history'");
    expect(workflow).toContain(
      'refs/remotes/origin/${branch}:${history_path}',
    );
    expect(workflow).toContain('scripts/lib/open-data-refresh-pr.sh');
    expect(workflow).toContain('--branch chore/telegram-member-count-history');
  });

  it('fails closed when the crawler cannot authenticate its stable refresh branch probe', () => {
    const workflow = read('.github/workflows/crawl-events.yml');
    expect(workflow).toContain(
      "GH_TOKEN: ${{ env.APP_TOKEN_DATA_REFRESH == 'true' && env.APP_TOKEN || env.GITHUB_PAT }}",
    );
    expect(workflow).not.toContain('GH_TOKEN: ${{ env.APP_TOKEN || env.GITHUB_PAT }}');
    expect(workflow).toContain(
      'remote_url="https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"',
    );
    expect(workflow).toContain('git ls-remote "$remote_url" "refs/heads/${branch}"');
    expect(workflow).toContain('if [ ! -s "$probe" ]; then');
    expect(workflow).toContain('git fetch --no-tags --depth=1 "$remote_url"');
    expect(workflow).not.toContain('git fetch --no-tags origin');
  });
});
