import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = readFileSync(resolve(__dirname, '../components/community/JobViewersActivityPrompt.tsx'), 'utf8');

describe('job viewers activity prompt contract (follow-up #14492)', () => {
  it('keeps the prompt delayed and bounds the synthetic viewer count', () => {
    expect(SOURCE).toMatch(/DISPLAY_DELAY_MS\s*=\s*8_000/u);
    expect(SOURCE).toMatch(/AUTO_DISMISS_MS\s*=\s*7_000/u);
    expect(SOURCE).toMatch(/Math\.floor\(Math\.random\(\) \* 4\) \+ 2/u);
    expect(SOURCE).toMatch(/stored >= 2 && stored <= 5/u);
  });

  it('keeps storage failures fail-open with an in-memory per-job fallback', () => {
    expect(SOURCE).toMatch(/const runtimeViewerCounts = new Map<string, number>\(\)/u);
    expect(SOURCE).toMatch(/window\.sessionStorage\.getItem\(countKey\)/u);
    expect(SOURCE).toMatch(/catch \{\s*const cached = runtimeViewerCounts\.get\(jobId\)/su);
    expect(SOURCE).toMatch(/runtimeViewerCounts\.set\(jobId, count\)/u);
  });

  it('does not render before the delayed state is complete and uses the popup queue', () => {
    expect(SOURCE).toMatch(/if \(!visible \|\| count === null\) return null/u);
    expect(SOURCE).toMatch(/<BottomPromptShell/u);
    expect(SOURCE).toMatch(/priority=\{POPUP_PRIORITY\.JOB_VIEWERS_ACTIVITY\}/u);
    expect(SOURCE).toMatch(/onShown=\{handleShown\}/u);
  });
});
