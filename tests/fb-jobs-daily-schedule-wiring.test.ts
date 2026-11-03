import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const WORKFLOWS = [
  ['.github/workflows/fb-jobs-daily-schedule.yml', 'schedule', 'Schedule FB jobs'],
  ['.github/workflows/reddit-jobs-daily-schedule.yml', 'schedule', 'Schedule Reddit jobs'],
  ['.github/workflows/telegram-channel-broadcast.yml', 'broadcast', 'Broadcast jobs digest'],
  ['.github/workflows/linkedin-member-daily.yml', 'post', 'Post to LinkedIn (member)'],
  ['.github/workflows/instagram-daily-broadcast.yml', 'post', 'Post to Instagram'],
  ['.github/workflows/tiktok-daily-broadcast.yml', 'preview', 'Generate TikTok content preview'],
] as const;

function workflow(file: string): any {
  return YAML.parse(fs.readFileSync(file, 'utf8'));
}

describe('social jobs dataset assembly wiring', () => {
  it('caches the exact no-summary dataset used by each jobs consumer', () => {
    for (const [file, jobId, consumerName] of WORKFLOWS) {
      const steps = workflow(file).jobs[jobId].steps;
      const key = steps.find((step: any) => step.id === 'assemble_cache_key');
      const restore = steps.find((step: any) => step.id === 'assemble_cache');
      const assemble = steps.find((step: any) => step.id === 'assemble');
      const save = steps.find((step: any) => step.uses === 'actions/cache/save@v6');

      expect(key?.uses, file).toBe('./.github/actions/assemble-jobs-cache-key');
      expect(key?.with?.args, file).toBe('--no-summaries');
      expect(restore?.uses, file).toBe('actions/cache/restore@v6');
      expect(restore?.with?.path, file).toBe('.cache/assemble-jobs');
      expect(restore?.with?.key, file).toBe('assemble-jobs-${{ runner.os }}-${{ steps.assemble_cache_key.outputs.key }}');
      expect(assemble?.run, file).toBe('node scripts/assemble-jobs-dataset.mjs --no-summaries');
      expect(save?.with?.path, file).toBe('.cache/assemble-jobs');
      expect(save?.with?.key, file).toBe('assemble-jobs-${{ runner.os }}-${{ steps.assemble_cache_key.outputs.key }}');

      const order = steps.map((step: any) => step.id || step.name);
      expect(order.indexOf('assemble_cache_key'), file).toBeLessThan(order.indexOf('assemble_cache'));
      expect(order.indexOf('assemble_cache'), file).toBeLessThan(order.indexOf('assemble'));
      expect(order.indexOf('assemble'), file).toBeLessThan(order.indexOf(consumerName));
    }
  });
});
