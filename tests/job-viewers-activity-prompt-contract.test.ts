import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = readFileSync(resolve(__dirname, '../components/community/JobViewersActivityPrompt.tsx'), 'utf8');
const JOB_BOARD_SOURCE = readFileSync(resolve(__dirname, '../components/community/JobBoard.tsx'), 'utf8');

describe('job viewers activity prompt contract', () => {
  it('shows promptly, then bounds the synthetic viewer count', () => {
    expect(SOURCE).toMatch(/DISPLAY_DELAY_MS\s*=\s*1_500/u);
    expect(SOURCE).toMatch(/AUTO_DISMISS_MS\s*=\s*8_000/u);
    expect(SOURCE).not.toMatch(/SESSION_SEEN_KEY|runtimePromptShown/u);
    expect(SOURCE).toMatch(/viewerPromptVisibleAt/u);
    expect(SOURCE).toMatch(/viewerPromptJobId/u);
    expect(SOURCE).toMatch(/scheduleFallback/u);
    expect(JOB_BOARD_SOURCE).toMatch(
      /gate\.dataset\.viewerPromptJobId\s*=\s*String\(selectedJob\.id\)/u,
    );
    expect(JOB_BOARD_SOURCE).toMatch(
      /gate\.dataset\.viewerPromptVisibleAt\s*=\s*String\(Date\.now\(\)\)/u,
    );
    expect(SOURCE).toMatch(/Math\.floor\(Math\.random\(\) \* 4\) \+ 2/u);
    expect(SOURCE).toMatch(/stored >= 2 && stored <= 5/u);
  });

  it('keeps storage failures fail-open with an in-memory per-job fallback', () => {
    expect(SOURCE).toMatch(/const runtimeViewerCounts = new Map<string, number>\(\)/u);
    expect(SOURCE).toMatch(/window\.sessionStorage\.getItem\(countKey\)/u);
    expect(SOURCE).toMatch(/catch \{\s*const cached = runtimeViewerCounts\.get\(jobId\)/su);
    expect(SOURCE).toMatch(/runtimeViewerCounts\.set\(jobId, count\)/u);
  });

  it('renders independently of the popup queue and keeps the toast above ads', () => {
    expect(SOURCE).toMatch(/if \(!visible \|\| count === null \|\| typeof document === 'undefined'\)/u);
    expect(SOURCE).not.toMatch(/requestSlot\(/u);
    expect(SOURCE).not.toMatch(/POPUP_PRIORITY/u);
    expect(SOURCE).toMatch(/ABOVE_MOBILE_NAV_BOTTOM/u);
    expect(SOURCE).toMatch(/subscribeToAutoAdOverlay\(setAutoAdClearance\)/u);
    expect(SOURCE).toMatch(/--bottom-prompt-ad-clearance/u);
    expect(SOURCE).toMatch(/data-testid="gamification-toast"/u);
    expect(SOURCE).toMatch(/data-bottom-prompt/u);
    expect(SOURCE).toMatch(/--bottom-prompt-offset/u);
    expect(SOURCE).toMatch(/createPortal/u);
    expect(SOURCE).toMatch(/bg-warning-strong text-on-accent rounded-xl shadow-lg/u);
    expect(JOB_BOARD_SOURCE).not.toMatch(/requestSlot\('job-inline-auth-gate'/u);
    expect(JOB_BOARD_SOURCE).not.toMatch(/releaseSlot\('job-inline-auth-gate'/u);
  });

  it('does not render before the delayed state is complete', () => {
    expect(SOURCE).toMatch(/if \(!visible \|\| count === null/u);
  });
});
