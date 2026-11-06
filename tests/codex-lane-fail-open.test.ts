import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const ACTION = readFileSync(
  new URL('../.github/actions/setup-claude-haiku-fallback/action.yml', import.meta.url),
  'utf8',
);

const runtimeStart = ACTION.indexOf('- name: Resolve trusted Node/npm toolchain');
const runtimeEnd = ACTION.indexOf('\n    # Keep the Codex binary outside', runtimeStart);
const RUNTIME = ACTION.slice(runtimeStart, runtimeEnd);

describe('Codex article lane bootstrap', () => {
  it('disables only the optional lane when the pinned runtime cannot be prepared', () => {
    expect(runtimeStart).toBeGreaterThanOrEqual(0);
    expect(runtimeEnd).toBeGreaterThan(runtimeStart);
    expect(RUNTIME).toContain('disable_codex_lane()');
    expect(RUNTIME).toContain('CODEX_ARTICLE_LANE_GATE=0');
    expect(RUNTIME).toMatch(/if ! download_pinned_node_archive[\s\S]*?disable_codex_lane/);
    expect(RUNTIME).not.toMatch(/exit 1/);
  });

  it('bounds a slow Node mirror instead of holding a crawler group open', () => {
    expect(RUNTIME).toContain('download_pinned_node_archive "$node_url" "$archive_path" "$node_runtime_root" 8 60 15');
    expect(RUNTIME).toContain('--max-time "$max_time"');
    expect(RUNTIME).toContain('local chunk_bytes=4194304');
    expect(RUNTIME).toContain('range_end_request=$((archive_size + chunk_bytes - 1))');
    expect(RUNTIME).toContain('--range "${archive_size}-${range_end_request}"');
    expect(RUNTIME).toContain('content-range:*');
    expect(RUNTIME).toContain('[ "$range_end" -lt "$range_total" ]');
    expect(RUNTIME).not.toContain('--range "${archive_size}-"');
  });
});
