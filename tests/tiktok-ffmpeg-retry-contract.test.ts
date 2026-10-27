import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = ['tiktok-daily-broadcast.yml', 'instagram-reel-experiment.yml'];

describe('social broadcast FFmpeg bootstrap', () => {
  it('retries a transient release download before fail-closed verification', () => {
    for (const workflowName of WORKFLOWS) {
      const document = YAML.parse(fs.readFileSync(path.join(ROOT, '.github', 'workflows', workflowName), 'utf8'));
      const job = Object.values(document.jobs)[0] as { steps: Array<Record<string, unknown>> };
      const setupIndex = job.steps.findIndex((step) => step.name === 'Setup FFmpeg toolchain');
      const retryIndex = job.steps.findIndex((step) => step.name === 'Retry FFmpeg toolchain after transient download failure');
      const setup = job.steps[setupIndex];
      const retry = job.steps[retryIndex];

      expect(setup, workflowName).toMatchObject({
        id: 'setup_ffmpeg',
        uses: 'FedericoCarboni/setup-ffmpeg@v3.1',
        'continue-on-error': true,
      });
      expect(retry, workflowName).toMatchObject({
        if: "steps.setup_ffmpeg.outcome == 'failure'",
        uses: 'FedericoCarboni/setup-ffmpeg@v3.1',
      });
      expect(retryIndex, workflowName).toBeGreaterThan(setupIndex);
    }
  });
});
