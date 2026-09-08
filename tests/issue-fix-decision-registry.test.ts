import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const VISION_PATH = path.join(ROOT, 'VISION.md');
const DECISIONS_PATH = path.join(ROOT, 'DECISIONS.md');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'issue-fix.yml');
const DECISIONS_MAX_BYTES = 12 * 1024;

const vision = fs.readFileSync(VISION_PATH, 'utf8');
const decisions = fs.readFileSync(DECISIONS_PATH, 'utf8');
const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
const tierStart = workflow.indexOf('- name: Determine fix tier');
const nextStep = workflow.indexOf('\n      - name:', tierStart + 1);
const tier = workflow.slice(tierStart, nextStep === -1 ? workflow.length : nextStep);
const promptStart = workflow.indexOf('          prompt: |');
const promptEnd = workflow.indexOf('\n      - ', promptStart + 1);
const prompt = workflow.slice(promptStart, promptEnd === -1 ? workflow.length : promptEnd);

describe('issue-fix — il registro delle decisioni arriva al fixer', () => {
  it('VISION.md punta al registro esistente e il registro resta bounded', () => {
    expect(fs.existsSync(DECISIONS_PATH)).toBe(true);
    expect(vision).toContain('[`DECISIONS.md`](DECISIONS.md)');
    expect(Buffer.byteLength(decisions, 'utf8')).toBeLessThanOrEqual(DECISIONS_MAX_BYTES);
    expect(decisions.match(/^\| \d{4}-\d{2}-\d{2} \| /gm)?.length ?? 0).toBeGreaterThan(0);
  });

  it('collega lo stesso file allo step output e al prompt Claude', () => {
    expect(tierStart).toBeGreaterThanOrEqual(0);
    expect(tier).toContain('DECISIONS_FILE="DECISIONS.md"');
    expect(tier).toContain('DECISIONS_MAX_BYTES=12288');
    expect(tier).toContain('if [ ! -f "$DECISIONS_FILE" ]');
    expect(tier).toContain('DECISIONS_BYTES=$(wc -c < "$DECISIONS_FILE")');
    expect(tier).toMatch(/if \[ "\$DECISIONS_BYTES" -gt "\$DECISIONS_MAX_BYTES" \]/);

    const outputStart = tier.indexOf('echo "decision_registry<<DECISION_REGISTRY_EOF"');
    const fileRead = tier.indexOf('cat "$DECISIONS_FILE"', outputStart);
    const outputEnd = tier.indexOf('echo "DECISION_REGISTRY_EOF"', fileRead);
    expect(outputStart).toBeGreaterThanOrEqual(0);
    expect(fileRead).toBeGreaterThan(outputStart);
    expect(outputEnd).toBeGreaterThan(fileRead);
    const outputSink = tier.indexOf('} >> "$GITHUB_OUTPUT"', outputEnd);
    expect(outputSink).toBeGreaterThan(outputEnd);

    const promptValue = '${{ steps.tier.outputs.decision_registry }}';
    expect(prompt).toContain(promptValue);
    expect(prompt).toContain('precaricato deterministicamente dal workflow');
    expect(prompt).not.toContain('Leggi `DECISIONS.md`');
    expect(workflow.indexOf('echo "decision_registry<<DECISION_REGISTRY_EOF"')).toBeLessThan(
      workflow.indexOf(promptValue),
    );
  });
});
