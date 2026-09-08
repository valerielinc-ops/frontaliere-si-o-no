import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('..', import.meta.url).pathname;
const SCRIPT = join(ROOT, 'scripts/ci/claude-usage-summary.mjs');

describe('claude usage summary', () => {
  it('resta best-effort quando i numeri dell execution file sono malformati', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-usage-summary-'));
    const executionFile = join(dir, 'execution.json');
    writeFileSync(executionFile, JSON.stringify({
      type: 'result',
      usage: {
        input_tokens: 'not-a-number',
        output_tokens: -4,
        cache_creation_input_tokens: '12',
      },
      total_cost_usd: 'not-a-number',
      cost_usd: '1.25',
      num_turns: 'also-not-a-number',
      duration_ms: -1,
    }));

    try {
      const output = execFileSync('node', [SCRIPT, executionFile, 'test'], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_STEP_SUMMARY: join(dir, 'summary.md') },
      });
      expect(output).toContain('CLAUDE_USAGE workflow="test" parsed=true');
      expect(output).toContain('cache_create=12');
      expect(output).toContain('cost_usd=1.2500');
      expect(readFileSync(join(dir, 'summary.md'), 'utf8')).toContain('$1.2500');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
