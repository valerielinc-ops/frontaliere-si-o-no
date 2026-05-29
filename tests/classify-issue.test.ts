/**
 * classify-issue — regression test per la classificazione deterministica del
 * triage (scripts/lib/classify-issue.mjs). Garantisce che il routing autonomo
 * (`agent:fix` solo su crawler/follow-up) non drifti silenziosamente:
 * un mis-routing instrada `agent:fix` → PR automatica indesiderata, o lascia
 * inerte una categoria auto-fixabile.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — modulo .mjs senza tipi
import { classifyIssue } from '../scripts/lib/classify-issue.mjs';

describe('classifyIssue', () => {
  const cases: Array<{ title: string; labels: string[]; category: string; autofix: boolean }> = [
    // crawler → autofix
    { title: '[crawler-health] Coop Ticino broken', labels: ['priority:high', 'bug'], category: 'crawler', autofix: true },
    { title: 'Crawler Failure: Update TECAN', labels: ['bug'], category: 'crawler', autofix: true },
    // parser-health → crawler (🟡 review #927: era 'other' sotto regex bash)
    { title: '[parser-health] octapharma boilerplate-only', labels: ['parser-broken', 'automated'], category: 'crawler', autofix: true },
    // follow-up → autofix
    { title: 'follow-up(#852): 7 crawler senza fallback', labels: ['follow-up', 'funnel-seo'], category: 'follow-up', autofix: true },
    // validation-failure → NO autofix (transiente)
    { title: 'Validation Failure (dist): post-deploy', labels: ['bug', 'priority:urgent'], category: 'validation-failure', autofix: false },
    { title: 'Validation Failure (live): post-deploy', labels: ['bug', 'priority:urgent'], category: 'validation-failure', autofix: false },
    // revenue → NO autofix (anche se è un follow-up: RPM vince, conservativo)
    { title: 'RPM canary regression detected', labels: ['revenue'], category: 'revenue', autofix: false },
    { title: 'follow-up(#851): Verifica RPM recovery', labels: ['follow-up', 'funnel-monetization'], category: 'revenue', autofix: false },
    // tracker → NO autofix
    { title: 'Master tracker: SEO recovery plan', labels: [], category: 'tracker', autofix: false },
    // other → NO autofix (fail-safe)
    { title: 'Qualche cosa di strano', labels: [], category: 'other', autofix: false },
    // company-name collision guards (#933 item 1): conservative ordering fires
    // revenue/tracker BEFORE crawler — intentional override; prevents future
    // code reordering from silently removing the guardrail.
    { title: '[crawler-health] RPM Software AG broken', labels: ['priority:high', 'bug'], category: 'revenue', autofix: false },
    { title: '[parser-health] recovery GmbH boilerplate-only', labels: ['parser-broken', 'automated'], category: 'tracker', autofix: false },
    // follow-up + funnel-monetization without RPM → autofix=true (#933 item 2):
    // body is NOT inspected; funnel sensitivity is gated by pr-review-loop ## LGTM.
    { title: 'follow-up(#900): tune AdSense vignette threshold', labels: ['follow-up', 'funnel-monetization'], category: 'follow-up', autofix: true },
  ];

  for (const c of cases) {
    it(`"${c.title}" [${c.labels.join(',')}] → ${c.category} (autofix=${c.autofix})`, () => {
      const out = classifyIssue(c.title, c.labels);
      expect(out.category).toBe(c.category);
      expect(out.autofix).toBe(c.autofix);
    });
  }

  it('autofix è true SOLO per crawler e follow-up', () => {
    for (const c of cases) {
      const out = classifyIssue(c.title, c.labels);
      if (out.autofix) expect(['crawler', 'follow-up']).toContain(out.category);
    }
  });

  it('label con virgola nel nome non rompe il match (array, non comma-join)', () => {
    // un nome label con virgola non deve falsare il set
    const out = classifyIssue('follow-up(#1): x', ['weird,label', 'follow-up']);
    expect(out.category).toBe('follow-up');
  });

  it('input vuoto/degenere → other, no autofix', () => {
    expect(classifyIssue('', [])).toEqual({ category: 'other', autofix: false });
    expect(classifyIssue(undefined as unknown as string, undefined as unknown as string[])).toEqual({ category: 'other', autofix: false });
  });
});
