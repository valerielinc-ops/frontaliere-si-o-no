import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

for (const script of ['collect-followup-batch', 'gate-minted-followups']) {
  test(`${script}: REST pagination scopes the endpoint, never gh api --repo`, () => {
    const root = mkdtempSync(join(tmpdir(), 'followup-rest-cli-'));
    const output = join(root, 'outputs');
    const calls = join(root, 'calls');
    const shim = join(root, 'gh');
    writeFileSync(output, '');
    writeFileSync(calls, '');
    writeFileSync(shim, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_GH_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'api') {
  if (args.includes('--repo') || args.includes('-R')) process.exit(64);
  if (args[1].startsWith('search/issues?')) console.log(JSON.stringify([{total_count:0,incomplete_results:false,items:[]}]));
  else if (args[1].startsWith('repos/owner/repo/issues?')) console.log('[[]]');
  else process.exit(65);
} else if (args[0] === 'run' && args[1] === 'list') console.log('[]');
else process.exit(66);
`);
    chmodSync(shim, 0o755);
    try {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL(`../scripts/ci/${script}.mjs`, import.meta.url))], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, GH_REPO: 'owner/repo',
          GITHUB_REPOSITORY: 'owner/repo', TEST_GH_CALLS: calls, GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: '', BATCH_PRS: '', DRY_RUN: '1' },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const api = readFileSync(calls, 'utf8').trim().split('\n').map((row) => JSON.parse(row)).filter((args) => args[0] === 'api');
      assert.equal(api.length, 1);
      assert.ok(api[0].includes('--paginate') && api[0].includes('--slurp'));
      assert.ok(!api[0].includes('--repo'));
      assert.match(decodeURIComponent(api[0][1]), /owner\/repo/);
      if (script === 'collect-followup-batch') assert.match(readFileSync(output, 'utf8'), /collection_ok=true/);
      else assert.match(result.stdout, /Gate sul conio:/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
