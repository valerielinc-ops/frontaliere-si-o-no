/**
 * classify-issue — regression test per classificazione deterministica del
 * triage (scripts/lib/classify-issue.mjs). Garantisce che il routing autonomo
 * (autofix su TUTTE le categorie dal 2026-07-05, owner decision) non drifti
 * silenziosamente: un mis-routing instrada `agent:fix` immediato dove
 * dovrebbe passare dalla coda (o viceversa), o lascia inerte una categoria.
 */

import { describe, it, expect } from 'vitest';
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
    // validation-failure → autofix esteso (2026-07-05): coda, high (priority:urgent)
    { title: 'Validation Failure (dist)', labels: ['bug', 'priority:urgent'], category: 'validation-failure', autofix: true, route: 'queue', fuPrio: 'high' },
    // revenue/tracker → autofix esteso (2026-07-05): coda, high di default (strategico)
    { title: 'RPM canary regression', labels: ['revenue'], category: 'revenue', autofix: true, route: 'queue', fuPrio: 'high' },
    { title: 'master tracker: Q3 migration', labels: [], category: 'tracker', autofix: true, route: 'queue', fuPrio: 'low' },
    // other (nessun match) → autofix esteso (2026-07-05): coda, low senza segnali forti
    { title: 'Random unclassified issue', labels: ['seo-audit'], category: 'other', autofix: true, route: 'queue', fuPrio: 'low' },
    { title: 'Random unclassified issue', labels: ['seo-audit', 'priority:high'], category: 'other', autofix: true, route: 'queue', fuPrio: 'high' },
    // company-name collision guards (#933 item 1): conservative ordering fires
    // revenue/tracker BEFORE crawler — intentional override; prevents future
    // code reordering from silently removing guardrail. autofix/route ora
    // uguali a ogni altra categoria (guardia resta solo sulla CATEGORY).
    { title: '[crawler-health] RPM Software AG broken', labels: ['priority:high', 'bug'], category: 'revenue', autofix: true, route: 'queue', fuPrio: 'high' },
    { title: '[parser-health] recovery GmbH boilerplate-only', labels: ['parser-broken', 'automated'], category: 'tracker', autofix: true, route: 'queue', fuPrio: 'low' },
    // follow-up + funnel-monetization without RPM → queue, high (#933 item 2):
    // body NOT inspected; funnel sensitivity gated pr-review-loop ## LGTM.
    { title: 'follow-up(#900): tune AdSense vignette threshold', labels: ['follow-up', 'funnel-monetization'], category: 'follow-up', autofix: true, route: 'queue', fuPrio: 'high' },
    // follow-up senza funnel/priority → coda priorità bassa
    { title: 'follow-up(#910): de-rot comment anchor', labels: ['follow-up', 'funnel-ux'], category: 'follow-up', autofix: true, route: 'queue', fuPrio: 'low' },
    // [job-content] — audit di plausibilità + segnalazione manuale
    // (scripts/audit-job-content-plausibility.mjs,
    // scripts/report-crawler-content-error.mjs). Il DEFAULT deve restare la
    // coda: il prefisso non contiene nessuno dei token che aprono la route
    // immediata, e la label `job-content-quality` non è di routing. Se un
    // domani il prefisso cambiasse in qualcosa che matcha /crawler|parser/i,
    // una label `priority:high` lo promuoverebbe a `crawler` senza che nessuno
    // l'abbia deciso — questi tre casi fissano la scelta.
    { title: '[job-content] hotel-international: booking-offer (5/5 record)', labels: ['job-content-quality'], category: 'other', autofix: true, route: 'queue', fuPrio: 'low' },
    // --urgent: `parser-broken` da SOLA basta a dare categoria `crawler`.
    // È l'unica leva che questo meccanismo usa per il fix immediato, ed è
    // deliberatamente opt-in (vedi il blocco ROUTING in
    // report-crawler-content-error.mjs).
    { title: '[job-content] schindler: titolo = widget consenso cookie', labels: ['job-content-quality', 'parser-broken'], category: 'crawler', autofix: true, route: 'fix', fuPrio: null },
    // priority:high SENZA parser-broken resta in coda: il prefisso [job-content]
    // non matcha /crawler|parser/i, quindi il ramo `priority:high`+crawler/parser
    // non scatta. Alzare la priorità NON deve cambiare la route di nascosto.
    { title: '[job-content] gemeinde-st-moritz: no-job-signal (5 record)', labels: ['job-content-quality', 'priority:high'], category: 'other', autofix: true, route: 'queue', fuPrio: 'high' },
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

  it('autofix è true per QUALUNQUE categoria (2026-07-05: guardrail category-based rimosse)', () => {
    for (const c of cases) {
      expect(classifyIssue(c.title, c.labels).autofix).toBe(true);
    }
  });

  it("route='fix' SOLO per crawler; ogni altra categoria passa dalla coda ('queue')", () => {
    for (const c of cases) {
      const out = classifyIssue(c.title, c.labels);
      if (out.category === 'crawler') {
        expect(out.route).toBe('fix');
      } else {
        expect(out.route).toBe('queue');
      }
    }
  });

  it("nessuna categoria produce più route='none' (era il branch 'umano' pre-estensione)", () => {
    for (const c of cases) {
      expect(classifyIssue(c.title, c.labels).route).not.toBe('none');
    }
  });
});
