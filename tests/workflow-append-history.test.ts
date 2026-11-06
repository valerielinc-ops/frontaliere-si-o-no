import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeAppendOnlyDocument, mergeUniqueArrays } from '../scripts/lib/merge-generated-json.mjs';

const ROOT = join(__dirname, '..');
const workflows = [
  'seo-serp-autopilot.yml',
  'campaign-goal-check.yml',
  'monitor-seo-ctr-by-template.yml',
].map((file) => readFileSync(join(ROOT, '.github', 'workflows', file), 'utf8'));

describe('generated-state rebase recovery (#7448)', () => {
  it('does not restore the append-only history through checkout', () => {
    const serp = workflows[0];
    expect(serp).toMatch(/restore-generated-files\.sh|merge-seo-serp-experiment-history\.mjs/);
    expect(serp).toMatch(/--merge-array-field data\/seo-serp-experiment-history\.json:snapshots|merge-seo-serp-experiment-history\.mjs/);
    expect(serp).not.toContain('git checkout $COMMIT_SHA -- data/seo-serp-experiment-history.json');
  });

  it('keeps every snapshot from both concurrent writers and chooses newest metadata', () => {
    const current = { updatedAt: '2026-09-08T10:00:00.000Z', snapshots: [{ createdAt: '2026-09-08T10:00:00.000Z', id: 'main' }] };
    const incoming = { updatedAt: '2026-09-08T09:00:00.000Z', snapshots: [{ createdAt: '2026-09-08T09:00:00.000Z', id: 'run' }] };
    expect(mergeAppendOnlyDocument(current, incoming, 'snapshots')).toEqual({
      updatedAt: current.updatedAt,
      snapshots: [incoming.snapshots[0], current.snapshots[0]],
    });
  });

  it('deduplicates concurrent auto-family registrations without dropping either one', () => {
    expect(mergeUniqueArrays([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }])).toEqual([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ]);
  });

  it('keeps the latest record when concurrent writers update one family', () => {
    expect(mergeUniqueArrays(
      [{ id: 'cerca-lavoro-berna', pathContains: 'berna', targetCtr: 0.12 }],
      [{ id: 'cerca-lavoro-berna', pathContains: 'berna', targetCtr: 0.18, monitored: true }],
    )).toEqual([
      { id: 'cerca-lavoro-berna', pathContains: 'berna', targetCtr: 0.18, monitored: true },
    ]);
  });

  it('retries a transient checkout lock and fails closed for other errors', () => {
    const helper = readFileSync(join(ROOT, 'scripts', 'lib', 'restore-generated-files.sh'), 'utf8');
    expect(helper).toContain('for attempt in 1 2 3 4');
    expect(helper).toContain('index.lock');
    expect(helper).toContain('return 1');
  });
});
