/**
 * classify-issue — regression test per classificazione deterministica del
 * triage (scripts/lib/classify-issue.mjs). Garantisce che il routing autonomo
 * non drifti silenziosamente: un mis-routing instrada
 * `agent:fix` immediato dove dovrebbe passare dalla coda (o viceversa). Dal
 * 2026-09-24 (policy f1-f7-v4, DECISIONS «Nessun veto sul ciclo autonomo»)
 * nessuna categoria F1/F7 resta fuori dal routing: i domini sono evidenza.
 */

import { describe, it, expect } from 'vitest';
import { classifyIssue, isFixerExempt, FIXER_EXEMPT_LABELS } from '../scripts/lib/classify-issue.mjs';
import {
  classifyAutomationRisk,
  CONTROL_PLANE_PATHS,
  extractIssueReferences,
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
    // funnel-seo è un dominio F1/F7: evidenza, non veto → coda ad alta priorità.
    { title: 'follow-up(#852): 7 crawler senza fallback', labels: ['follow-up', 'funnel-seo'], category: 'follow-up', autofix: true, route: 'queue', fuPrio: 'high' },
    // validation-failure → autofix esteso (2026-07-05): coda, high (priority:urgent)
    { title: 'Validation Failure (dist)', labels: ['bug', 'priority:urgent'], category: 'validation-failure', autofix: true, route: 'queue', fuPrio: 'high' },
    // revenue entra in coda come ogni categoria (DECISIONS 2026-07-05 e 2026-09-24).
    { title: 'RPM canary regression', labels: ['revenue'], category: 'revenue', autofix: true, route: 'queue', fuPrio: 'high' },
    { title: 'master tracker: Q3 migration', labels: [], category: 'tracker', autofix: true, route: 'queue', fuPrio: 'low' },
    // Una categoria `other` sconosciuta non è più deny-by-default.
    { title: 'Random unclassified issue', labels: ['seo-audit'], category: 'other', autofix: true, route: 'queue', fuPrio: 'low' },
    { title: 'Random unclassified issue', labels: ['seo-audit', 'priority:high'], category: 'other', autofix: true, route: 'queue', fuPrio: 'high' },
    // company-name collision guards (#933 item 1): conservative ordering fires
    // revenue/tracker BEFORE crawler — intentional override; prevents future
    // code reordering from silently removing guardrail.
    { title: '[crawler-health] RPM Software AG broken', labels: ['priority:high', 'bug'], category: 'revenue', autofix: true, route: 'queue', fuPrio: 'high' },
    { title: '[parser-health] recovery GmbH boilerplate-only', labels: ['parser-broken', 'automated'], category: 'tracker', autofix: true, route: 'queue', fuPrio: 'low' },
    // Auto Ads/monetization: evidenza per la review, non veto.
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

  it('autofix: ogni categoria non pinnata è automatizzabile', () => {
    for (const c of cases) {
      expect(classifyIssue(c.title, c.labels).autofix).toBe(c.autofix);
    }
  });

  it("route='fix' SOLO per crawler; il resto è coda", () => {
    for (const c of cases) {
      const out = classifyIssue(c.title, c.labels);
      expect(out.route).toBe(out.category === 'crawler' ? 'fix' : 'queue');
    }
  });

  it('una categoria F1/F7 resta instradata e porta i domini come evidenza', () => {
    const out = classifyIssue('Aggiornare il workflow di deploy del service account con permessi', ['follow-up']);
    expect(out).toMatchObject({
      route: 'queue',
      autofix: true,
      automationBlocked: false,
      riskBlocked: false,
      humanApprovalRequired: false,
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
    // `tracker` e `revenue` restano instradate come ogni altra categoria.
    for (const l of ['pinned', 'do-not-close', 'revenue', 'tracker']) {
      expect(classifyIssue('follow-up(#1): qualcosa', ['follow-up', l]).route).toBe('queue');
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

  it.each(riskCases)('riporta il dominio %s come evidenza senza bloccare', (_label, input, domain) => {
    const out = classifyAutomationRisk(input);
    expect(out).toMatchObject({ blocked: false, decision: 'allow', verifiable: true, humanApprovalRequired: false });
    expect(out.domains).toContain(domain);
  });

  it('classifica anche un segnale presente solo nel body della issue', () => {
    const out = classifyAutomationRisk({ title: 'Issue generica', body: 'sitemap pubblicata da correggere', labels: [] });
    expect(out).toMatchObject({ blocked: false, verifiable: true });
    expect(out.domains).toContain('published-content-seo-auto-ads');
  });

  it.each([
    ['.github/workflows/release.yml', 'deploy-workflow-functions'],
    ['config/iam/roles.yml', 'secrets-roles-permissions'],
    ['services/partner/billing.ts', 'billing-revenue-partner'],
    ['packages/articles/content/guide.md', 'published-content-seo-auto-ads'],
    ['scripts/newsletter/send.mjs', 'outreach-communications'],
  ])('instrada il path %s sulla superficie issue, con il dominio %s come evidenza', (path, domain) => {
    const out = classifyAutomationRisk({ paths: [path], pathsComplete: true });
    expect(out).toMatchObject({ blocked: false, decision: 'allow', verifiable: true });
    expect(out.evidence.path.concat(out.evidence.issue)).toContain(domain);
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

  it('conserva il match F1 come evidenza su una PR control-plane con segnale deploy', () => {
    expect(classifyAutomationRisk({
      title: 'ci(deploy): riordina i job del workflow',
      body: '',
      labels: [],
      paths: ['.github/workflows/deploy.yml'],
      pathsComplete: true,
      surface: 'pull-request',
    })).toMatchObject({
      blocked: false,
      decision: 'allow',
      denyCode: null,
      humanApprovalRequired: false,
      evidence: { issue: ['deploy-workflow-functions'] },
    });
  });

  it('un file list incompleto sulla issue è evidenza, non deny', () => {
    expect(classifyAutomationRisk({ paths: ['src/safe.ts', ''], pathsComplete: false })).toMatchObject({
      blocked: false,
      decision: 'allow',
      verifiable: true,
      pathsComplete: false,
      humanApprovalRequired: false,
    });
  });

  it('continua a negare metadata issue illeggibili (retry, non veto)', () => {
    expect(classifyAutomationRisk({ title: null, body: '', labels: [] })).toMatchObject({
      blocked: true,
      decision: 'deny',
      denyCode: 'metadata-unverifiable',
      verifiable: false,
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
        humanApprovalRequired: false,
      });
    }
  });

  it('nega metadata PR non verificabili senza introdurre approvazione umana', () => {
    expect(classifyAutomationRisk({
      title: null,
      body: 'PR con metadata corrotti',
      labels: [],
      paths: ['src/safe.ts'],
      pathsComplete: true,
      surface: 'pull-request',
    })).toMatchObject({
      blocked: true,
      decision: 'deny',
      denyCode: 'metadata-unverifiable',
      verifiable: false,
      needsHumanVeto: false,
      humanApprovalRequired: false,
    });
  });

  it('non usa i nomi dei test-only path come segnale di dominio', () => {
    expect(isAutomationTestPath('tests/seo/workflow.test.ts')).toBe(true);
    expect(classifyAutomationRisk({
      paths: ['tests/seo/workflow.test.ts'],
      pathsComplete: true,
    })).toMatchObject({ blocked: false, verifiable: true });
  });

  it('routes every explicit control-plane path on the issue surface, flagged as evidence', () => {
    for (const path of CONTROL_PLANE_PATHS) {
      expect(isControlPlanePath(path), path).toBe(true);
      const out = classifyAutomationRisk({ paths: [path], pathsComplete: true });
      expect(out).toMatchObject({
        blocked: false,
        decision: 'allow',
        denyCode: null,
        controlPlane: true,
        humanApprovalRequired: false,
      });
      expect(out.domains).toContain('control-plane');
    }
  });

  it('allows control-plane paths for PR auto-merge too', () => {
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

  it('lets an unrecognised path or generic issue text enter automation, reported as evidence', () => {
    expect(isRecognizedAutomationPath('unknown-zone/agent-target.ts')).toBe(false);
    const unknownPath = classifyAutomationRisk({
      paths: ['unknown-zone/agent-target.ts'],
      pathsComplete: true,
    });
    expect(unknownPath).toMatchObject({ blocked: false, decision: 'allow', denyCode: null });
    expect(unknownPath.unknownPaths).toEqual(['unknown-zone/agent-target.ts']);
    expect(classifyAutomationRisk({
      title: 'Please investigate this',
      body: 'No deterministic category is declared.',
      labels: [],
    })).toMatchObject({ blocked: false, decision: 'allow', denyCode: null, knownIssue: false });
  });

  it('reports locale-audit labels as known ordinary signals', () => {
    for (const label of KNOWN_ORDINARY_ISSUE_LABELS) {
      expect(classifyAutomationRisk({
        title: 'Metric anomaly',
        labels: [label],
      })).toMatchObject({ blocked: false, decision: 'allow', denyCode: null, knownIssue: true });
    }
    expect(classifyAutomationRisk({
      title: 'Metric anomaly',
      labels: ['locale-audit'],
    })).toMatchObject({ blocked: false, decision: 'allow', knownIssue: false });
  });

  it('treats needs-human as tracking on the issue surface too (no veto)', () => {
    expect(classifyAutomationRisk({
      title: 'follow-up: safe maintenance',
      body: 'A deterministic maintenance change with a complete safe path.',
      labels: ['needs-human'],
      category: 'follow-up',
      paths: ['src/safe.ts'],
      pathsComplete: true,
      surface: 'issue',
    })).toMatchObject({
      blocked: false,
      decision: 'allow',
      denyCode: null,
      needsHumanVeto: false,
      humanLabel: true,
      humanApprovalRequired: false,
    });
  });

  it('treats automation-deferred as a technical pin, separate from the owner veto', () => {
    expect(classifyAutomationRisk({
      title: 'follow-up: safe maintenance',
      body: 'A deterministic maintenance change with a complete safe path.',
      labels: ['automation-deferred'],
      category: 'follow-up',
      paths: ['src/safe.ts'],
      pathsComplete: true,
      surface: 'issue',
    })).toMatchObject({ blocked: false, decision: 'allow', needsHumanVeto: false });
    expect(classifyIssue('follow-up: safe maintenance', ['follow-up', 'automation-deferred'], 'A deterministic maintenance change.', {
      ignoreAutomationDeferred: true,
    })).toMatchObject({
      automationDeferred: false,
      riskBlocked: false,
      automationBlocked: false,
      route: 'queue',
      humanApprovalRequired: false,
    });
    expect(classifyIssue('follow-up: safe maintenance', ['follow-up', 'automation-deferred'], 'A deterministic maintenance change.'))
      .toMatchObject({ automationDeferred: true, riskBlocked: false, automationBlocked: true, route: 'none' });
  });

  it('routes an issue carrying needs-human (tracking, not veto)', () => {
    expect(classifyIssue(
      'follow-up: safe maintenance',
      ['follow-up', 'needs-human'],
      'A deterministic maintenance change with a complete safe path.',
    )).toMatchObject({
      autofix: true,
      route: 'queue',
      riskBlocked: false,
      automationBlocked: false,
      needsHumanVeto: false,
    });
  });

  it('una CI Failure su un workflow entra nel ciclo con o senza VISION approval', () => {
    for (const labels of [['needs-human'], ['needs-human', 'agent:vision-approved'], ['agent:vision-approved'], []]) {
      const out = classifyAutomationRisk({
        title: 'CI Failure: Publish to GitHub Pages',
        body: 'Il monitor ha rilevato il guasto nel workflow.',
        labels,
        paths: ['.github/workflows/publish.yml'],
        pathsComplete: true,
      });
      expect(out, labels.join(',')).toMatchObject({
        blocked: false,
        decision: 'allow',
        denyCode: null,
        controlPlane: true,
        visionApproved: labels.includes('agent:vision-approved'),
        humanApprovalRequired: false,
      });
    }
  });

  it('treats needs-human as tracking only on the pull-request surface', () => {
    expect(classifyAutomationRisk({
      title: 'follow-up: safe maintenance',
      body: 'A deterministic maintenance change with a complete safe path.',
      labels: ['needs-human'],
      category: 'follow-up',
      paths: ['src/safe.ts'],
      pathsComplete: true,
      surface: 'pull-request',
    })).toMatchObject({
      blocked: false,
      decision: 'allow',
      denyCode: null,
      needsHumanVeto: false,
      humanApprovalRequired: false,
    });
  });

  it('extracts path candidates without treating URLs as repository paths', () => {
    expect(extractIssuePathCandidates(
      'Fix `src/safe.ts`; reference https://github.com/example/repo/blob/main/secret/key.txt.',
    )).toEqual(['src/safe.ts']);
  });

  it('condivide snapshot URL/comando tra classifier e issue-fix', () => {
    const repository = 'valerielinc-ops/frontaliere-si-o-no';
    const code = String.fromCharCode(96);
    expect(extractIssueReferences(
      'Workflow run: https://github.com/valerielinc-ops/frontaliere-si-o-no/actions/runs/123',
      { repository },
    )).toMatchObject({
      paths: [],
      pathsComplete: false,
      hasReferences: false,
    });
    expect(extractIssueReferences(
      'Workflow run: https://github.com/valerielinc-ops/frontaliere-si-o-no/actions/runs/123/',
      { repository },
    )).toMatchObject({
      paths: [],
      pathsComplete: false,
      hasReferences: false,
    });
    expect(extractIssueReferences('Modifica `package.json`', { repository })).toMatchObject({
      paths: ['package.json'],
      pathsComplete: true,
      hasReferences: true,
    });
    expect(extractIssueReferences('Modifica `unknown.json`', { repository })).toMatchObject({
      paths: ['unknown.json'],
      pathsComplete: true,
      hasReferences: true,
    });
    expect(extractIssueReferences(code + 'cat unknown.json' + code, { repository })).toMatchObject({
      paths: ['unknown.json'],
      pathsComplete: true,
      hasReferences: true,
    });
    expect(extractIssueReferences(code + 'git show origin/main:package.json' + code, { repository })).toMatchObject({
      paths: ['package.json'],
      pathsComplete: true,
      hasReferences: true,
    });
    expect(classifyIssue(
      'Follow-up: update the source module',
      ['follow-up'],
      code + 'cat unknown.json' + code,
      { repository },
    )).toMatchObject({
      automationBlocked: false,
      riskDenyCode: null,
    });
    expect(extractIssueReferences(
      code + "git show origin/main:data/crawler-health.json | jq -r '.status'" + code,
      { repository },
    )).toMatchObject({
      paths: ['data/crawler-health.json'],
      pathsComplete: true,
      hasReferences: true,
    });
    expect(extractIssueReferences(
      'Europe/Zurich gh/push REST/GraphQL github.event_name',
      { repository },
    )).toMatchObject({
      paths: [],
      pathsComplete: false,
      hasReferences: false,
    });
    expect(extractIssueReferences(
      '> .github/workflows/pr-redflag-fixer.yml:L147: fix the blockquote target',
      { repository },
    )).toMatchObject({
      paths: ['.github/workflows/pr-redflag-fixer.yml'],
      pathsComplete: true,
      hasReferences: true,
    });
    expect(extractIssueReferences(
      'https://github.com/valerielinc-ops/frontaliere-si-o-no/blob/feature/docs/src/fix.ts',
      { repository },
    )).toMatchObject({
      paths: [],
      pathsComplete: false,
      hasReferences: true,
    });
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
