import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { filterResolvableCandidates } from '../scripts/discover-404s-via-cloudflare.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const read = (relativePath: string) => readFileSync(resolve(ROOT, relativePath), 'utf8');

const WORKFLOWS = [
  {
    path: '.github/workflows/discover-404s.yml',
    branch: 'chore/discover-404s-url-inspection',
    paths: ['data/seo-404-compat', 'data/inspection-state.json'],
  },
  {
    path: '.github/workflows/discover-404s-via-cloudflare.yml',
    branch: 'chore/discover-404s-cloudflare',
    paths: ['data/seo-404-compat', 'data/cf-hot-404s.json'],
  },
] as const;

describe('404 discovery workflows publish protected data through PRs', () => {
  it.each(WORKFLOWS)('$path uses the shared PR publisher', ({ path, branch, paths }) => {
    const workflow = read(path);

    expect(workflow).toContain('pull-requests: write');
    expect(workflow).toContain('scripts/lib/open-data-refresh-pr.sh');
    expect(workflow).not.toContain('scripts/lib/git-push-with-retry.sh');
    expect(workflow).not.toMatch(/^\s*git\s+push\b/m);
    expect(workflow).not.toContain('trigger-deploy.sh');
    expect(workflow).toContain(`--branch ${branch}`);
    for (const dataPath of paths) {
      expect(workflow).toContain(`--path ${dataPath}`);
    }
  });

  it.each(WORKFLOWS)('$path runs the Cloudflare producer with the shared TS resolver', ({ path }) => {
    const workflow = read(path);

    expect(workflow).toContain('npx --no-install tsx scripts/discover-404s-via-cloudflare.mjs');
    expect(workflow).not.toContain('node scripts/discover-404s-via-cloudflare.mjs');
  });

  it('uses the repository bot identity for generated data commits', () => {
    const publisher = read('scripts/lib/open-data-refresh-pr.sh');

    expect(publisher).toContain('git add --sparse -A --');
    expect(publisher).toContain('frontaliere-automation[bot]');
    expect(publisher).toContain('296434481+frontaliere-automation[bot]@users.noreply.github.com');
  });

  it('reconciles pending 404 stable branches with main using the shard merge driver', () => {
    const publisher = read('scripts/lib/open-data-refresh-pr.sh');

    expect(publisher).toContain('RECONCILE_COMPAT=true');
    expect(publisher).toContain('if [ "$RECONCILE_COMPAT" = true ]; then');
    // Branch tips only: the compat path names its merge bases and never reads
    // the history of the stable branch or of main (issue 12262).
    expect(publisher).toContain(
      'git fetch --no-tags --depth=1 "$PUSH_URL" \\\n      "+refs/heads/${BRANCH}:refs/remotes/refresh/${BRANCH}"',
    );
    // Forced: a depth-1 tip cannot be proven a fast-forward of the checkout's main.
    expect(publisher).toContain(
      'git fetch --no-tags --depth=1 "$PUSH_URL" \\\n    "+refs/heads/main:refs/remotes/origin/main"',
    );
    expect(publisher).not.toMatch(/--depth=1 "\$PUSH_URL" \\\n\s+"refs\/heads\//);
    expect(publisher).toContain("git config merge.compat-shard.driver 'node scripts/ci/merge-compat-shard.mjs %O %A %B'");
    expect(publisher).toContain('refs/heads/${BRANCH}:refs/remotes/refresh/${BRANCH}');
    expect(publisher).toContain(
      'node "$MERGE_REFRESH_SCRIPT_DIR/scripts/ci/reconcile-data-refresh-main.mjs" \\\n    --compat \\\n    --base "$merge_base" --main "$theirs" --message "$COMMIT_MESSAGE"',
    );
    expect(publisher).toContain('reconcile_compat_ref "$COMPAT_REFRESH_BASE" "$REFRESH_COMMIT"');
    expect(publisher).toContain('reconcile_compat_ref "$COMPAT_MAIN_BASE" origin/main');
    // A real merge needs the ancestry of both sides on the runner.
    expect(publisher).not.toContain('git merge --no-edit');
  });

  it('pins the current compat reconciler and its relative imports before checking out a stale stable branch', () => {
    const publisher = read('scripts/lib/open-data-refresh-pr.sh');
    const reconciler = read('scripts/ci/reconcile-data-refresh-main.mjs');
    const pinnedReconciler = publisher.indexOf(
      'scripts/ci/reconcile-data-refresh-main.mjs" \\\n    > "$MERGE_REFRESH_SCRIPT_DIR/scripts/ci/reconcile-data-refresh-main.mjs"',
    );
    const stableBranchCheckout = publisher.indexOf(
      'git checkout -B "$BRANCH" "refs/remotes/refresh/',
    );

    expect(pinnedReconciler).toBeGreaterThanOrEqual(0);
    expect(pinnedReconciler).toBeLessThan(stableBranchCheckout);
    expect(publisher).toContain(
      'git show "$' + '{REFRESH_BASE}:scripts/ci/open-data-refresh-merge.mjs"',
    );
    expect(publisher).toContain(
      'git show "$' + '{REFRESH_BASE}:scripts/lib/read-git-blob.mjs"',
    );
    expect(publisher).toContain(
      'git show "$' + '{REFRESH_BASE}:scripts/lib/compat-path-safety.mjs"',
    );
    expect(publisher).toContain(
      'if [ "$RECONCILE_COMPAT" = true ] || [ "$RECONCILE_MAIN" = true ]; then',
    );
    expect(reconciler).toContain("if (flag === '--compat')");
    expect(reconciler).toContain("['--base', '--main', '--message']");
  });

  it('anchors a new compat branch to reconciled main and cleans before retry checkout', () => {
    const publisher = read('scripts/lib/open-data-refresh-pr.sh');

    expect(publisher.match(/PUBLISH_BASE="\$COMPAT_MAIN_HEAD"/g)).toHaveLength(2);
    expect(publisher).toContain('-f "ref=refs/heads/${BRANCH}" -f "sha=${PUBLISH_BASE}"');
    expect(publisher).toContain('REMOTE_BASE_SHA="$PUBLISH_BASE"');
    expect(publisher).toContain('git commit-tree "$merged_tree" -p "$PUBLISH_BASE" -m "$COMMIT_MESSAGE"');
    expect(publisher).toContain('git -C "$REFRESH_SOURCE_ROOT" reset --hard "$REFRESH_COMMIT"');
  });

  it.each(WORKFLOWS)('$path escapes Markdown backticks in its generated body', ({ path }) => {
    const workflow = read(path);
    const bodyStart = workflow.indexOf("cat <<'EOF'");
    const bodyEnd = workflow.indexOf('\n          EOF', bodyStart);
    expect(bodyStart).toBeGreaterThanOrEqual(0);
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    const generatedBody = workflow.slice(bodyStart, bodyEnd);

    expect(workflow).toContain('} > "$body"');
    expect(generatedBody).toContain('`data/');
    expect(generatedBody).toContain('`vitest (unit + integration)`');
    expect(generatedBody).not.toContain('\\`');
  });

  it('assigns the compat shard merge driver in the repository attributes contract', () => {
    const attributes = read('.gitattributes');
    const publisher = read('scripts/lib/open-data-refresh-pr.sh');
    const compatShardAttribute = ['data/seo-404-compat', 'part-00.json'].join('/')
      + ': merge: compat-shard';

    expect(attributes).toMatch(/^data\/seo-404-compat\/part-\*\.json merge=compat-shard$/m);
    expect(publisher).toContain('git check-attr merge -- data/seo-404-compat/part-00.json');
    expect(publisher).toContain(compatShardAttribute);
  });
});

describe('Cloudflare 404 candidate boundary', () => {
  it('drops resolver-unknown paths before they can trigger family-loss pruning', () => {
    const resolverCalls: string[] = [];
    const result = filterResolvableCandidates([
      { path: '/known-content', count: 3 },
      { path: '/unknown-bot-family', count: 4 },
      { path: '/assets/logo.svg', count: 10 },
      { path: '/low-count', count: 1 },
    ], {
      resolvePath: (path: string) => {
        resolverCalls.push(path);
        return path === '/known-content' ? { canonicalPath: '/known-content/' } : null;
      },
    });

    expect([...result.candidates]).toEqual(['/known-content']);
    expect(result).toMatchObject({ skipped: 1, lowCount: 1, unresolved: 1 });
    expect(resolverCalls).toEqual(['/known-content', '/unknown-bot-family']);
  });
});
