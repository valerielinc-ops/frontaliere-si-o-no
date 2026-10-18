import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

// @ts-expect-error — .mjs module without type declarations
import { sentCountFromResult, writeSentOutput } from '@/scripts/send-daily-brief.mjs';

const workflowSource = readFileSync(
  new URL('../.github/workflows/send-daily-brief.yml', import.meta.url),
  'utf8',
);
const scriptSource = readFileSync(
  new URL('../scripts/send-daily-brief.mjs', import.meta.url),
  'utf8',
);
const workflow = parse(workflowSource);
const steps = workflow.jobs['send-brief'].steps;

describe('daily brief sent output', () => {
  it('derives the provider-accepted count and writes the GitHub output', () => {
    expect(sentCountFromResult({ sent: [{}, {}] })).toBe(2);
    expect(sentCountFromResult({ sent: [] })).toBe(0);
    expect(sentCountFromResult(undefined)).toBe(0);

    const dir = mkdtempSync(join(tmpdir(), 'daily-brief-send-output-'));
    const output = join(dir, 'github-output');
    try {
      writeSentOutput(2, output);
      writeSentOutput(0, output);
      expect(readFileSync(output, 'utf8')).toBe('sent=2\nsent=0\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('daily brief workflow contract', () => {
  it('runs cadence only after this run actually sent an email', () => {
    const send = steps.find((step: any) => step.name === 'Send daily brief');
    const cadence = steps.find((step: any) => step.name === 'Cadence report');

    expect(send?.id).toBe('send-brief');
    expect(cadence?.if).toBe("steps.send-brief.outputs.sent > 0");
    expect(cadence?.['continue-on-error']).toBe(true);
    expect(String(cadence?.run)).toContain('report-daily-brief-cadence.mjs --days 14');
  });

  it('finalizes the sent output even when post-send work throws', () => {
    expect(scriptSource).toContain('runState.sent += 1;');
    expect(scriptSource).toContain('writeSentOutput(runState.sent);');
  });
});
