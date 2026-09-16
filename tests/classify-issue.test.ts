/**
 * classify-issue — regression test per classificazione deterministica del
 * triage (scripts/lib/classify-issue.mjs). Garantisce che il routing autonomo
 * non drifti silenziosamente: un mis-routing instrada
 * `agent:fix` immediato dove dovrebbe passare dalla coda (o viceversa), o
 * lascia instradata una categoria F1/F7 che richiede gestione umana.
 */

import { describe, it, expect } from 'vitest';
import { classifyIssue, isFixerExempt, FIXER_EXEMPT_LABELS } from '../scripts/lib/classify-issue.mjs';
import {
  classifyAutomationRisk,
  CONTROL_PLANE_PATHS,
  extractIssuePathCandidates,
  findSeparateHumanApproval,
  KNOWN_ORDINARY_ISSUE_LABELS,
  isControlPlanePath,
  isAutomationTestPath,
  isRecognizedAutomationPath,
  isSeparateHumanApproval,
} from '../scripts/ci/lib/automation-risk-policy.mjs';

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
    // funnel-seo è F1/F7: la categoria resta leggibile, ma non viene instradata.
    { title: 'follow-up(#852): 7 crawler senza fallback', labels: ['follow-up', 'funnel-seo'], category: 'follow-up', autofix: false, route: 'none', fuPrio: null },
    // validation-failure → autofix esteso (2026-07-05): coda, high (priority:urgent)
    { title: 'Validation Failure (dist)', labels: ['bug', 'priority:urgent'], category: 'validation-failure', autofix: true, route: 'queue', fuPrio: 'high' },
    // revenue è F1/F7: billing/revenue/partner non entra nella coda automatica.
    { title: 'RPM canary regression', labels: ['revenue'], category: 'revenue', autofix: false, route: 'none', fuPrio: null },
    { title: 'master tracker: Q3 migration', labels: [], category: 'tracker', autofix: true, route: 'queue', fuPrio: 'low' },
    // SEO è F1/F7 anche se la categoria nominale resta `other`.
    { title: 'Random unclassified issue', labels: ['seo-audit'], category: 'other', autofix: false, route: 'none', fuPrio: null },
    { title: 'Random unclassified issue', labels: ['seo-audit', 'priority:high'], category: 'other', autofix: false, route: 'none', fuPrio: null },
    // company-name collision guards (#933 item 1): conservative ordering fires
    // revenue/tracker BEFORE crawler — intentional override; prevents future
    // code reordering from silently removing guardrail. autofix/route ora
    // uguali a ogni altra categoria, salvo la policy F1/F7 sul dominio revenue.
    { title: '[crawler-health] RPM Software AG broken', labels: ['priority:high', 'bug'], category: 'revenue', autofix: false, route: 'none', fuPrio: null },
    { title: '[parser-health] recovery GmbH boilerplate-only', labels: ['parser-broken', 'automated'], category: 'tracker', autofix: true, route: 'queue', fuPrio: 'low' },
    // Auto Ads/monetization è F1/F7, anche senza il token RPM.
    { title: 'follow-up(#900): tune AdSense vignette threshold', labels: ['follow-up', 'funnel-monetization'], category: 'follow-up', autofix: false, route: 'none', fuPrio: null },
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
    { title: '[job-content] hotel-international: booking-offer (5/5 record)', labels: ['job-content-quality'], category: 'other', autofix: false, route: 'none', fuPrio: null },
    // --urgent: `parser-broken` da SOLA basta a dare categoria `crawler`.
    // È l'unica leva che questo meccanismo usa per il fix immediato, ed è
    // deliberatamente opt-in (vedi il blocco ROUTING in
    // report-crawler-content-error.mjs).
    { title: '[job-content] schindler: titolo = widget consenso cookie', labels: ['job-content-quality', 'parser-broken'], category: 'crawler', autofix: false, route: 'none', fuPrio: null },
    // priority:high SENZA parser-broken resta in coda: il prefisso [job-content]
    // non matcha /crawler|parser/i, quindi il ramo `priority:high`+crawler/parser
    // non scatta. Alzare la priorità NON deve cambiare la route di nascosto.
    { title: '[job-content] gemeinde-st-moritz: no-job-signal (5 record)', labels: ['job-content-quality', 'priority:high'], category: 'other', autofix: false, route: 'none', fuPrio: null },
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

  it('autofix segue la policy: solo le categorie ordinarie restano automatizzabili', () => {
    for (const c of cases) {
      expect(classifyIssue(c.title, c.labels).autofix).toBe(c.autofix);
    }
  });

  it("route='fix' SOLO per crawler ordinari; il resto è coda o escalation umana", () => {
    for (const c of cases) {
      const out = classifyIssue(c.title, c.labels);
      if (out.category === 'crawler') {
        expect(out.route).toBe(c.route);
      } else if (out.automationBlocked) {
        expect(out.route).toBe('none');
      } else {
        expect(out.route).toBe('queue');
      }
    }
  });

  it('una categoria F1/F7 produce route none e richiede approvazione umana separata', () => {
    const out = classifyIssue('Aggiornare il workflow di deploy del service account con permessi', ['follow-up']);
    expect(out).toMatchObject({
      route: 'none',
      autofix: false,
      automationBlocked: true,
      humanApprovalRequired: true,
    });
    expect(out.riskDomains).toEqual(expect.arrayContaining([
      'deploy-workflow-functions',
      'secrets-roles-permissions',
    ]));
  });
});

/**
 * Pin fuori dal ciclo (#7648). `keep-open` vietava l'auto-close del reconcile ma
 * non la PROMOZIONE al fixer: #7648 nasce dichiarando nel body «senza
 * agent:fix-queued/agent:fix», ha attraversato triage → coda → `agent:fix` e ha
 * speso un run Max su un'attesa che nessun turn-budget può chiudere (due review
 * esterne, Meta e TikTok). Stessa asimmetria di `agent:no-age-out`, che #5544
 * aveva chiuso solo nel pool del PARKED-RETRY del drainer.
 */
describe('classifyIssue — pin fuori dal ciclo di fix', () => {
  it('keep-open → route none / autofix false, categoria invariata', () => {
    const out = classifyIssue('Instagram/TikTok publishing: attivare i poster', ['follow-up', 'funnel-seo', 'keep-open']);
    expect(out.category).toBe('follow-up'); // la categoria resta leggibile
    expect(out.route).toBe('none');
    expect(out.autofix).toBe(false);
    expect(out.fuPrio).toBeNull(); // niente priorità di coda: non è in coda
  });

  it('agent:no-age-out → nemmeno un crawler pinnato viene instradato a agent:fix', () => {
    // Senza il pin questo titolo è l'unica categoria a route diretto.
    expect(classifyIssue('[crawler-health] X broken', ['parser-broken']).route).toBe('fix');
    expect(classifyIssue('[crawler-health] X broken', ['parser-broken', 'agent:no-age-out']).route).toBe('none');
  });

  it('le label del veto auto-close che NON pinnano restano instradate', () => {
    // `pinned`/`do-not-close` dicono «non chiudere», non «non riparare»;
    // `tracker` resta ordinario, mentre `revenue` è protetto dalla policy F1/F7.
    for (const l of ['pinned', 'do-not-close', 'revenue', 'tracker']) {
      const expected = l === 'revenue' ? 'none' : 'queue';
      expect(classifyIssue('follow-up(#1): qualcosa', ['follow-up', l]).route).toBe(expected);
    }
  });

  it('isFixerExempt accetta sia stringhe sia oggetti label GitHub, case-insensitive', () => {
    expect(isFixerExempt(['keep-open'])).toBe(true);
    expect(isFixerExempt([{ name: 'Keep-Open' }])).toBe(true);
    expect(isFixerExempt([{ name: 'agent:no-age-out' }, { name: 'bug' }])).toBe(true);
    expect(isFixerExempt(['follow-up', 'funnel-seo'])).toBe(false);
    expect(isFixerExempt([])).toBe(false);
    expect(isFixerExempt(undefined as unknown as string[])).toBe(false);
  });

  it('ogni label esente produce davvero route none (nessun drift fra lista e comportamento)', () => {
    for (const l of FIXER_EXEMPT_LABELS) {
      expect(classifyIssue('follow-up(#1): qualcosa', ['follow-up', l]).route).toBe('none');
    }
  });
});

describe('policy automazione F1/F7', () => {
  const riskCases = [
    ['deploy/workflow/functions', { title: 'Aggiornare il workflow di deploy', labels: [] }, 'deploy-workflow-functions'],
    ['secrets/ruoli/permessi', { title: 'Ruotare il service account e i permessi', labels: [] }, 'secrets-roles-permissions'],
    ['billing/revenue/partner', { title: 'Correggere il billing del partner', labels: [] }, 'billing-revenue-partner'],
    ['contenuti pubblicati/SEO/Auto Ads', { title: 'Aggiornare il canonical SEO pubblicato', labels: [] }, 'published-content-seo-auto-ads'],
    ['outreach/comunicazioni', { title: 'Inviare la newsletter di outreach', labels: [] }, 'outreach-communications'],
  ] as const;

  it.each(riskCases)('blocca il dominio %s', (_label, input, domain) => {
    const out = classifyAutomationRisk(input);
    expect(out).toMatchObject({ blocked: true, verifiable: true, humanApprovalRequired: true });
    expect(out.domains).toContain(domain);
  });

  it('classifica anche un segnale presente solo nel body della issue', () => {
    const out = classifyAutomationRisk({ title: 'Issue generica', body: 'sitemap pubblicata da correggere', labels: [] });
    expect(out).toMatchObject({ blocked: true, verifiable: true });
    expect(out.domains).toContain('published-content-seo-auto-ads');
  });

  it.each([
    ['.github/workflows/release.yml', 'deploy-workflow-functions'],
    ['config/iam/roles.yml', 'secrets-roles-permissions'],
    ['services/partner/billing.ts', 'billing-revenue-partner'],
    ['packages/articles/content/guide.md', 'published-content-seo-auto-ads'],
    ['scripts/newsletter/send.mjs', 'outreach-communications'],
  ])('blocca il path %s nella superficie issue, nel dominio %s', (path, domain) => {
    const out = classifyAutomationRisk({ paths: [path], pathsComplete: true });
    expect(out).toMatchObject({ blocked: true, verifiable: true });
    expect(out.domains).toContain(domain);
  });

  it.each([
    ['workflow/control-plane', '.github/workflows/release.yml'],
    ['secrets/ruoli/permessi', 'config/iam/roles.yml'],
    ['billing/revenue/partner', 'services/partner/billing.ts'],
    ['contenuti pubblicati/SEO/Auto Ads', 'packages/articles/content/guide.md'],
    ['outreach/comunicazioni', 'scripts/newsletter/send.mjs'],
    ['path sconosciuto', 'unknown-zone/agent-target.ts'],
  ])('consente %s sulla superficie PR con snapshot completo', (_label, path) => {
    expect(classifyAutomationRisk({
      title: 'Aggiornamento verificato',
      body: '',
      labels: [],
      paths: [path],
      pathsComplete: true,
      surface: 'pull-request',
    })).toMatchObject({
      blocked: false,
      decision: 'allow',
      denyCode: null,
      verifiable: true,
      humanApprovalRequired: false,
    });
  });

  it('nega per default quando il file list della PR è incompleto', () => {
    expect(classifyAutomationRisk({ paths: ['src/safe.ts'], pathsComplete: false })).toMatchObject({
      blocked: true,
      verifiable: false,
      humanApprovalRequired: true,
    });
  });

  it('richiede metadata e file-list verificabili sulla superficie PR', () => {
    for (const input of [
      { paths: undefined, pathsComplete: undefined },
      { paths: ['src/safe.ts'], pathsComplete: false },
      { paths: [], pathsComplete: true },
    ]) {
      expect(classifyAutomationRisk({
        title: 'PR verificabile',
        body: '',
        labels: [],
        ...input,
        surface: 'pull-request',
      })).toMatchObject({
        blocked: true,
        decision: 'deny',
        denyCode: 'paths-unverifiable',
        verifiable: false,
        humanApprovalRequired: true,
      });
    }
  });

  it('non usa i nomi dei test-only path come segnale di dominio', () => {
    expect(isAutomationTestPath('tests/seo/workflow.test.ts')).toBe(true);
    expect(classifyAutomationRisk({
      paths: ['tests/seo/workflow.test.ts'],
      pathsComplete: true,
    })).toMatchObject({ blocked: false, verifiable: true });
  });

  it('denies every explicit control-plane path on the issue surface', () => {
    for (const path of CONTROL_PLANE_PATHS) {
      expect(isControlPlanePath(path), path).toBe(true);
      expect(classifyAutomationRisk({ paths: [path], pathsComplete: true })).toMatchObject({
        blocked: true,
        decision: 'deny',
        denyCode: 'control-plane',
        controlPlane: true,
        humanApprovalRequired: true,
      });
    }
  });

  it('allows control-plane paths for PR auto-merge while issue classification stays deny-by-default', () => {
    for (const path of CONTROL_PLANE_PATHS) {
      const out = classifyAutomationRisk({
        title: 'Aggiornare il workflow di auto-merge',
        body: 'La PR modifica la pipeline e gli script CI del control-plane.',
        paths: [path],
        pathsComplete: true,
        surface: 'pull-request',
      });
      expect(out).toMatchObject({ blocked: false, decision: 'allow', controlPlane: false });
      expect(out.domains).not.toContain('control-plane');
    }
  });

  it('does not let an unrecognised path or generic issue text enter automation', () => {
    expect(isRecognizedAutomationPath('unknown-zone/agent-target.ts')).toBe(false);
    expect(classifyAutomationRisk({
      paths: ['unknown-zone/agent-target.ts'],
      pathsComplete: true,
    })).toMatchObject({ blocked: true, decision: 'deny', denyCode: 'unknown-path' });
    expect(classifyAutomationRisk({
      title: 'Please investigate this',
      body: 'No deterministic category is declared.',
      labels: [],
    })).toMatchObject({ blocked: true, decision: 'deny', denyCode: 'unknown-issue' });
  });

  it('allows only the explicit locale-audit issue signals without weakening unknown deny', () => {
    for (const label of KNOWN_ORDINARY_ISSUE_LABELS) {
      expect(classifyAutomationRisk({
        title: 'Metric anomaly',
        labels: [label],
      })).toMatchObject({ blocked: false, decision: 'allow', denyCode: null });
    }
    expect(classifyAutomationRisk({
      title: 'Metric anomaly',
      labels: ['locale-audit'],
    })).toMatchObject({ blocked: true, decision: 'deny', denyCode: 'unknown-issue' });
    expect(classifyAutomationRisk({
      title: 'Metric anomaly',
      body: 'Fix canonical SEO before the locale audit',
      labels: ['job-title-locale'],
    })).toMatchObject({ blocked: true, decision: 'deny', denyCode: 'high-risk-domain' });
  });

  it.each(['issue', 'pull-request'] as const)('keeps needs-human as a persistent hard veto on %s', (surface) => {
    expect(classifyAutomationRisk({
      labels: ['needs-human'],
      paths: ['src/safe.ts'],
      pathsComplete: true,
      surface,
    })).toMatchObject({
      blocked: true,
      decision: 'deny',
      denyCode: 'needs-human-veto',
      needsHumanVeto: true,
      humanApprovalRequired: true,
    });
  });

  it('extracts path candidates without treating URLs as repository paths', () => {
    expect(extractIssuePathCandidates(
      'Fix `src/safe.ts`; reference https://github.com/example/repo/blob/main/secret/key.txt.',
    )).toEqual(['src/safe.ts']);
  });

  it('riconosce solo una review umana APPROVED sulla HEAD esatta', () => {
    const head = 'c'.repeat(40);
    const human = {
      id: 7,
      user: { type: 'User', login: 'owner' },
      state: 'APPROVED',
      commit_id: head,
      submitted_at: '2026-09-13T12:00:00Z',
    };
    expect(isSeparateHumanApproval(human, head)).toBe(true);
    expect(findSeparateHumanApproval([human], head)).toMatchObject({ id: 7 });
    expect(isSeparateHumanApproval({ ...human, user: { type: 'Bot', login: 'owner[bot]' } }, head)).toBe(false);
    expect(isSeparateHumanApproval({ ...human, commit_id: 'd'.repeat(40) }, head)).toBe(false);
    expect(isSeparateHumanApproval({ ...human, state: 'COMMENTED' }, head)).toBe(false);
  });
});
