import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const source = readFileSync(new URL('../.github/workflows/refresh-shard-weights.yml', import.meta.url), 'utf8');
const workflow = YAML.parse(source) as {
  jobs?: { refresh?: { steps?: Array<{ name?: string; run?: string }> } };
};
const downloadStep = workflow.jobs?.refresh?.steps?.find(
  (step) => step.name === 'Download latest green main tests timings',
);

describe('refresh vitest shard weights workflow', () => {
  it('walks back from green runs that selected no tests until it finds timing artifacts', () => {
    const run = downloadStep?.run ?? '';

    expect(run).toContain('--limit 20 --json databaseId,createdAt');
    expect(run).not.toContain('--limit 1 --json databaseId');
    expect(run).toContain('while IFS=$\'\\t\' read -r CANDIDATE_ID CANDIDATE_CREATED_AT');
    expect(run).toContain('actions/runs/${CANDIDATE_ID}/artifacts?per_page=100');
    expect(run).toContain('select(.expired == false and (.name | startswith("shard-timing-")))');
    expect(run).toContain('gh run download "$CANDIDATE_ID" -p \'shard-timing-*\' -D .shard-timing');
    expect(run).toContain('if [ "$count" -gt 0 ]; then');
    expect(run).toContain('FOUND_RUN_ID="$CANDIDATE_ID"');
  });

  it('fails closed on API/download errors instead of silently using stale timings', () => {
    const run = downloadStep?.run ?? '';

    expect(run).toMatch(/Unable to list artifacts[\s\S]*exit 1/);
    expect(run).toMatch(/Shard timing artifact is listed but could not be downloaded[\s\S]*exit 1/);
    expect(run).toContain('No live shard-timing-* artifacts found in $SHARD_TIMING_CANDIDATE_COUNT');
  });
});
