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
  const cases: Array<{
    title: string;
    labels: string[];
    category: string;
    autofix: boolean;
    route: string;
    fuPrio: string | null;
  }> = [
    // crawler → agent:fix immediato (route='fix', non passa dalla coda)
    { title: '[crawler-health] Coop Ticino broken', labels: ['priority:high', 'bug'], category: 'crawler', autofix: true, route: 'fix', fuPrio: null },
    { title: 'Crawler Failure: Update TECAN', labels: ['bug'], category: 'crawler', autofix: true, route: 'fix', fuPrio: null },
    // parser-health → crawler (🟡 review #927: era 'other' sotto regex bash)
    { title: '[parser-health] octapharma boilerplate-only', labels: ['parser-broken', 'automated'], category: 'crawler', autofix: true, route: 'fix', fuPrio: null },
    // follow-up → coda (route='queue'); fuPrio da funnel/priority
    { title: 'follow-up(#852): 7 crawler senza fallback', labels: ['follow-up', 'funnel-seo'], category: 'follow-up', autofix: true, route: 'queue', fuPrio: 'high' },
    // validation-failure → NO autofix (transiente)
    { title: 'Validation Failure (dist): post-deploy', labels: ['bug', 'priority:urgent'], category: 'validation-failure', autofix: false, route: 'none', fuPrio: null },
    { title: 'Validation Failure (live): post-deploy', labels: ['bug', 'priority:urgent'], category: 'validation-failure', autofix: false, route: 'none', fuPrio: null },
    // revenue → NO autofix (anche se è un follow-up: RPM vince, conservativo)
    { title: 'RPM canary regression detected', labels: ['revenue'], category: 'revenue', autofix: false, route: 'none', fuPrio: null },
    { title: 'follow-up(#851): Verifica RPM recovery', labels: ['follow-up', 'funnel-monetization'], category: 'revenue', autofix: false, route: 'none', fuPrio: null },
    // tracker → NO autofix
    { title: 'Master tracker: SEO recovery plan', labels: [], category: 'tracker', autofix: false, route: 'none', fuPrio: null },
    // other → NO autofix (fail-safe)
    { title: 'Qualche cosa di strano', labels: [], category: 'other', autofix: false, route: 'none', fuPrio: null },
    // company-name collision guards (#933 item 1): conservative ordering fires
    // revenue/tracker BEFORE crawler — intentional override; prevents future
    // code reordering from silently removing the guardrail.
    { title: '[crawler-health] RPM Software AG broken', labels: ['priority:high', 'bug'], category: 'revenue', autofix: false, route: 'none', fuPrio: null },
    { title: '[parser-health] recovery GmbH boilerplate-only', labels: ['parser-broken', 'automated'], category: 'tracker', autofix: false, route: 'none', fuPrio: null },
    // follow-up + funnel-monetization without RPM → queue, high (#933 item 2):
    // body is NOT inspected; funnel sensitivity is gated by pr-review-loop ## LGTM.
    { title: 'follow-up(#900): tune AdSense vignette threshold', labels: ['follow-up', 'funnel-monetization'], category: 'follow-up', autofix: true, route: 'queue', fuPrio: 'high' },
    // follow-up senza funnel/priority → coda a priorità bassa
    { title: 'follow-up(#910): de-rot comment anchor', labels: ['follow-up', 'funnel-ux'], category: 'follow-up', autofix: true, route: 'queue', fuPrio: 'low' },
  ];

  for (const c of cases) {
    it(`"${c.title}" [${c.labels.join(',')}] → ${c.category} (route=${c.route})`, () => {
      const out = classifyIssue(c.title, c.labels);
      expect(out.category).toBe(c.category);
      expect(out.autofix).toBe(c.autofix);
      expect(out.route).toBe(c.route);
      expect(out.fuPrio).toBe(c.fuPrio);
    });
  }

  it('autofix è true SOLO per crawler e follow-up', () => {
    for (const c of cases) {
      const out = classifyIssue(c.title, c.labels);
      if (out.autofix) expect(['crawler', 'follow-up']).toContain(out.category);
    }
  });

  it("route='queue' SOLO per follow-up; 'fix' SOLO per crawler", () => {
    for (const c of cases) {
      const out = classifyIssue(c.title, c.labels);
      if (out.route === 'queue') expect(out.category).toBe('follow-up');
      if (out.route === 'fix') expect(out.category).toBe('crawler');
    }
  });

  it('label con virgola nel nome non rompe il match (array, non comma-join)', () => {
    // un nome label con virgola non deve falsare il set
    const out = classifyIssue('follow-up(#1): x', ['weird,label', 'follow-up']);
    expect(out.category).toBe('follow-up');
  });

  it('input vuoto/degenere → other, no autofix, no route', () => {
    expect(classifyIssue('', [])).toEqual({ category: 'other', autofix: false, route: 'none', fuPrio: null });
    expect(classifyIssue(undefined as unknown as string, undefined as unknown as string[])).toEqual({ category: 'other', autofix: false, route: 'none', fuPrio: null });
  });
});
