// ─────────────────────────────────────────────────────────────────────────────
// scripts/lib/crawler-manifest-entry.mjs
//
// Single source of truth for the shape of one crawler's entry in
// data/crawler-manifest.json (consumed by
// scripts/generate-crawler-group-workflows.mjs). Both
// scripts/extract-crawler-manifest.mjs (bulk, parses existing
// .github/workflows/update-jobs-*.yml — used once, during the 2026-07
// consolidation, and available for any future re-import) and
// scripts/scaffold-crawler.mjs (one new crawler at a time, going forward)
// must agree on this shape; duplicating the bespoke-step field list in two
// places would let them drift (AGENTS.md sibling-pattern-fix rule).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the standard "bespoke steps" tail for a newly scaffolded crawler —
 * the same step sequence every crawler workflow had after
 * checkout/setup-node: install deps, (optional Playwright), Firebase prep,
 * RC secrets load, run crawler, scoped housekeeping, commit+push, report
 * failure. This mirrors scripts/scaffold-crawler.mjs's OLD per-crawler
 * workflowContent template byte-for-byte (verified against the pre-
 * consolidation corpus) — just structured as manifest step objects instead
 * of a YAML string, so scripts/generate-crawler-group-workflows.mjs can
 * splice it into a composite background step exactly like every other
 * crawler's extracted steps.
 *
 * @param {object} opts
 * @param {string} opts.companyKey        crawler slug, e.g. "my-company"
 * @param {string} opts.companyName       display name, e.g. "My Company SA"
 * @param {string} opts.constPrefix       upper-snake key used in env var names, e.g. "MY_COMPANY"
 * @param {boolean} [opts.playwright]     whether to include the Playwright browser-install step
 * @param {string} [opts.commitEmoji]     optional leading emoji for the commit message (cosmetic, matches old template's absence of emoji by default)
 * @returns {object[]} bespokeSteps array, same shape as data/crawler-manifest.json entries
 */
export function buildBespokeStepsForNewCrawler({
  companyKey,
  companyName,
  constPrefix,
  playwright = false,
  commitEmoji = '',
}) {
  const steps = [];

  steps.push({ name: 'Install dependencies', run: 'npm ci' });

  if (playwright) {
    steps.push({
      name: 'Install Playwright browsers',
      run: 'npx playwright install --with-deps chromium',
    });
  }

  steps.push({
    name: 'Prepare Firebase credentials (optional)',
    env: { FIREBASE_SERVICE_ACCOUNT_JSON: '${{ secrets.FIREBASE_SERVICE_ACCOUNT_JSON }}' },
    run:
      'if [ -n "$FIREBASE_SERVICE_ACCOUNT_JSON" ]; then\n' +
      "  printf '%s' \"$FIREBASE_SERVICE_ACCOUNT_JSON\" > /tmp/firebase-sa.json\n" +
      'else\n' +
      '  echo "ℹ️ Firebase secrets not set — crawler will use file config only."\n' +
      '  exit 0\n' +
      'fi\n' +
      'echo "GOOGLE_APPLICATION_CREDENTIALS=/tmp/firebase-sa.json" >> "$GITHUB_ENV"\n',
  });

  steps.push({
    name: 'Load secrets from Remote Config',
    env: { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' },
    run: 'node scripts/load-rc-env.mjs\necho "GH_TOKEN=$GH_TOKEN" >> "$GITHUB_ENV"\n',
  });

  const runInvocation = playwright
    ? `xvfb-run -a node scripts/update-${companyKey}-jobs.mjs`
    : `node scripts/update-${companyKey}-jobs.mjs`;

  steps.push({
    name: `Run dedicated ${companyName} crawler`,
    env: {
      JOBS_CRAWLER_TIMEOUT_MS: "${{ github.event.inputs.timeout_ms || '' }}",
      JOBS_CRAWLER_USE_FIRESTORE_CONFIG: '1',
      [`JOBS_${constPrefix}_STRICT`]: "${{ github.event.inputs.strict_localization || '1' }}",
      CRAWLER_SLICE_ONLY: '1',
      SKIP_AI_TRANSLATION: "${{ github.event.inputs.skip_ai_translation || '0' }}",
    },
    run: runInvocation,
  });

  steps.push({
    name: 'Housekeeping — remove expired job listings (scoped)',
    env: {
      JOBS_HOUSEKEEPING_SCOPE: companyKey,
      JOBS_SLICE_FILE: `data/jobs/by-crawler/${companyKey}.json`,
    },
    run: 'node scripts/cleanup-jobs.mjs',
    'continue-on-error': true,
  });

  const commitMessage = commitEmoji
    ? `${commitEmoji} Auto-update ${companyName} jobs (dedicated crawler)`
    : `Auto-update ${companyName} jobs (dedicated crawler)`;

  steps.push({
    name: 'Commit and push',
    id: 'changes',
    env: { SKIP_AI_TRANSLATION: "${{ github.event.inputs.skip_ai_translation || '0' }}" },
    run: `bash scripts/lib/git-commit-data.sh --slice-only "${commitMessage}" data/jobs-crawler-adapters/`,
  });

  steps.push({
    name: 'Report failure to GitHub Issues',
    if: 'failure()',
    'continue-on-error': true,
    env: { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' },
    run:
      'node scripts/lib/github-issue-creator.mjs \\\n' +
      '  --title "Crawler Failure: ${{ github.workflow }}" \\\n' +
      '  --description "## Crawler fallito\n' +
      '**Run:** https://github.com/${{ github.repository }}/actions/runs/${{ github.run_id }}\n' +
      '**Branch:** ${{ github.ref_name }}\n' +
      '**Trigger:** ${{ github.event_name }}" \\\n' +
      '  --priority 2 \\\n' +
      '  --label Bug \\\n' +
      '  --workflow "${{ github.workflow }}"\n',
  });

  return steps;
}

/**
 * Build a full manifest entry (same shape as one element of
 * data/crawler-manifest.json) for a newly scaffolded crawler.
 */
export function buildManifestEntryForNewCrawler({ companyKey, companyName, constPrefix, playwright = false, commitEmoji = '' }) {
  return {
    file: `update-jobs-${companyKey}.yml`, // synthetic — no such file exists post-consolidation; kept for traceability/diffing against the historical corpus
    workflowName: `Update ${companyName} Jobs (Dedicated)`,
    crawlerSlug: companyKey,
    originalJobKey: `update-${companyKey}-jobs`,
    originalTimeoutMinutes: 360,
    originalConcurrencyGroup: `jobs-crawler-${companyKey}`,
    bespokeSteps: buildBespokeStepsForNewCrawler({ companyKey, companyName, constPrefix, playwright, commitEmoji }),
  };
}
