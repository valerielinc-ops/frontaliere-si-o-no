/**
 * Guards scripts/ci/close-recovered-failure-issues.mjs's post-consolidation
 * (2026-07) handling of `Crawler Failure:` issues.
 *
 * Before the crawler-workflow consolidation, every `Crawler Failure: <name>`
 * issue title embedded a real, dispatchable workflow name (one workflow per
 * crawler), resolvable via `gh run list -w <name>`. After consolidation, 581
 * individual crawler workflows were replaced by 24 grouped
 * `crawler-group-*.yml` workflows, each launching ~25 crawlers in detached
 * `run:` steps and collecting their results in matching `Run <slug>` steps.
 * `${{ github.workflow }}` inside each crawler's inlined failure-report step
 * now resolves to the shared GROUP's name for every crawler in it — so
 * scripts/generate-crawler-group-workflows.mjs substitutes it with a literal,
 * per-crawler-unique `Run <slug>` identifier at generation time instead (see
 * that script's "HAZARD FIX 3"). This reconciler must therefore resolve
 * `Run <slug>` back to (a) which group currently contains that crawler, and
 * (b) that specific result STEP's own
 * conclusion inside the group's shared job run — NOT the job's overall
 * conclusion, which would incorrectly reflect sibling crawlers' failures too.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TITLE_RE,
  CRAWLER_STEP_RE,
  CRAWLER_MEMBER_FAILURE_ANNOTATION_RE,
  CRAWLER_MEMBER_WARNING_ANNOTATION_RE,
  CRAWLER_MEMBER_QUARANTINE_ANNOTATION_RE,
  CRAWLER_GROUP_COMPLETED_ANNOTATION_RE,
  CRAWLER_GROUP_INTERRUPTED_ANNOTATION_RE,
  CRAWLER_GROUP_TOLERATED_COUNT_RE,
  CRAWLER_QUARANTINE_OUTCOMES_NOTICE_TITLE,
  crawlerRunToken,
  crawlerWorkflowReference,
  checkRunApiPath,
  decideCrawlerMemberConclusion,
  buildRunListArgs,
  failureRunHistorySource,
  filterCrawlerRecoveryRuns,
  findCrawlerGroupWorkflow,
  findCrawlerGroupWorkflowByDisplayName,
  findCrawlerGroupWorkflowName,
  isCrawlerRecoveryBranch,
  sortCrawlerRecoveryRuns,
} from '../scripts/ci/close-recovered-failure-issues.mjs';
import { QUARANTINE_OUTCOMES_NOTICE_TITLE } from '../scripts/lib/crawler-quarantine.mjs';

describe('TITLE_RE — parses the three auto-generated failure-title prefixes', () => {
  it('parses a Crawler Failure title (post-consolidation: "Run <slug>" identifier)', () => {
    const m = TITLE_RE.exec('Crawler Failure: Run roche');
    expect(m).not.toBeNull();
    expect(m![1]).toBe('Run roche');
  });

  it('parses a Workflow Failure title (unaffected by consolidation — real workflow name)', () => {
    const m = TITLE_RE.exec('Workflow Failure: Orchestrate Job Crawlers');
    expect(m).not.toBeNull();
    expect(m![1]).toBe('Orchestrate Job Crawlers');
  });

  it('parses a CI Failure title (unaffected by consolidation)', () => {
    // Il titolo REALE di persist-job-stats.yml, che è il `name:` per intero.
    // L'esempio qui diceva "Persist Job Stats" — il letterale troncato che
    // #5437 ha corretto proprio perché `gh run list -w` non lo risolveva: un
    // campione stantio in un test è il modo più diretto per far tornare vero
    // un difetto appena chiuso.
    const m = TITLE_RE.exec('CI Failure: Persist Job Stats History');
    expect(m).not.toBeNull();
    expect(m![1]).toBe('Persist Job Stats History');
  });

  it('does not match unrelated issue titles', () => {
    expect(TITLE_RE.exec('follow-up: something else')).toBeNull();
  });
});

describe('CRAWLER_STEP_RE — extracts the crawler slug from the "Run <slug>" identifier', () => {
  it('extracts a simple slug', () => {
    const m = CRAWLER_STEP_RE.exec('Run roche');
    expect(m).not.toBeNull();
    expect(m![1]).toBe('roche');
  });

  it('extracts a hyphenated multi-word slug', () => {
    const m = CRAWLER_STEP_RE.exec('Run hoch-health');
    expect(m).not.toBeNull();
    expect(m![1]).toBe('hoch-health');
  });

  it('does not match a real (non-crawler) workflow display name', () => {
    // Sanity: a Workflow/CI Failure's group-2 value should NOT accidentally
    // look like "Run <slug>" and get misrouted into the crawler-step path.
    expect(CRAWLER_STEP_RE.exec('Orchestrate Job Crawlers')).toBeNull();
  });
});

describe('crawler recovery run population', () => {
  it('accepts main and valid generation-shadow branches only', () => {
    expect(isCrawlerRecoveryBranch('main')).toBe(true);
    expect(isCrawlerRecoveryBranch('crawler-generation-shadow-9001-2')).toBe(true);
    expect(isCrawlerRecoveryBranch('crawler-generation-shadow-9001-0')).toBe(false);
    expect(isCrawlerRecoveryBranch('crawler-generation-shadow-9001-2-extra')).toBe(false);
    expect(isCrawlerRecoveryBranch('feature/retry-crawler')).toBe(false);
  });

  it('filters pull-request and unrelated branches from the shadow listing', () => {
    const runs = [
      { databaseId: 1, headBranch: 'crawler-generation-shadow-9001-2' },
      { databaseId: 2, headBranch: 'main' },
      { databaseId: 3, headBranch: 'feature/crawler-debug' },
      { databaseId: 4, headBranch: 'crawler-generation-shadow-9001-0' },
    ];
    expect(filterCrawlerRecoveryRuns(runs).map((run) => run.databaseId)).toEqual([1, 2]);
  });

  it('prioritizes an older production shadow run over a newer main fallback', () => {
    const runs = [
      {
        databaseId: 1,
        conclusion: 'success',
        createdAt: '2026-09-14T12:00:00Z',
        headBranch: 'main',
      },
      {
        databaseId: 2,
        conclusion: 'failure',
        createdAt: '2026-09-14T11:00:00Z',
        headBranch: 'crawler-generation-shadow-9001-2',
      },
    ];
    expect(sortCrawlerRecoveryRuns(filterCrawlerRecoveryRuns(runs)).map((run) => run.databaseId))
      .toEqual([2, 1]);
  });

  it('drops -b main only for crawler recovery and requests headBranch for filtering', () => {
    const crawlerArgs = buildRunListArgs('Crawler Group 02 (26 crawlers)', {
      includeCrawlerShadowBranches: true,
    });
    expect(crawlerArgs).not.toContain('-b');
    expect(crawlerArgs).not.toContain('main');
    expect(crawlerArgs).toContain('databaseId,conclusion,status,createdAt,headBranch');

    const ordinaryArgs = buildRunListArgs('tests');
    expect(ordinaryArgs).toContain('-b');
    expect(ordinaryArgs).toContain('main');
  });
});

describe('findCrawlerGroupWorkflowName — resolves a crawler slug to its CURRENT group workflow', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeGroupFile(dir: string, filename: string, name: string, slugs: string[]) {
    const steps = slugs.map((s) => [
      `      - name: Launch ${s}`,
      `        id: crawler-launch-${s}`,
      '        run: echo launch',
      `      - name: Run ${s}`,
      `        id: crawler-${s}`,
      '        if: always()',
      '        run: echo result',
    ].join('\n') + '\n').join('');
    fs.writeFileSync(
      path.join(dir, filename),
      `name: ${name}\non:\n  workflow_dispatch: {}\njobs:\n  group:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`,
    );
  }

  it('finds the group workflow name containing a given crawler slug', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'close-recovered-test-'));
    writeGroupFile(tmpDir, 'crawler-group-01.yml', 'Crawler Group 01 (2 crawlers)', ['roche', 'novartis']);
    writeGroupFile(tmpDir, 'crawler-group-02.yml', 'Crawler Group 02 (1 crawlers)', ['hoch-health']);

    expect(findCrawlerGroupWorkflowName('roche', tmpDir)).toBe('Crawler Group 01 (2 crawlers)');
    expect(findCrawlerGroupWorkflowName('novartis', tmpDir)).toBe('Crawler Group 01 (2 crawlers)');
    expect(findCrawlerGroupWorkflowName('hoch-health', tmpDir)).toBe('Crawler Group 02 (1 crawlers)');
    expect(findCrawlerGroupWorkflow('roche', tmpDir)).toEqual({
      filename: 'crawler-group-01.yml',
      name: 'Crawler Group 01 (2 crawlers)',
      quarantine: false,
    });
  });

  it('marks the quarantine group from the outcomes notice its aggregate emits', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'close-recovered-test-'));
    writeGroupFile(tmpDir, 'crawler-group-24.yml', 'Crawler Group 24 (quarantine)', ['protectas']);
    fs.appendFileSync(path.join(tmpDir, 'crawler-group-24.yml'),
      `      - name: Aggregate\n        run: echo "::notice title=${CRAWLER_QUARANTINE_OUTCOMES_NOTICE_TITLE}::{}"\n`);
    expect(findCrawlerGroupWorkflow('protectas', tmpDir)?.quarantine).toBe(true);
  });

  it('uses the filename when crawler runs live in a different repository', () => {
    const group = {
      filename: 'crawler-group-22.yml',
      name: 'Crawler Group 22 (28 crawlers)',
    };
    expect(crawlerWorkflowReference(group, 'valerielinc-ops/frontaliere-si-o-no', 'nanakokyobashi-rgb/frontaliere-articles'))
      .toBe('crawler-group-22.yml');
    expect(crawlerWorkflowReference(group, 'valerielinc-ops/frontaliere-si-o-no', 'valerielinc-ops/frontaliere-si-o-no'))
      .toBe('Crawler Group 22 (28 crawlers)');
  });

  it('uses the cross-repo token only for crawler run reads, never for local issue operations', () => {
    const site = 'valerielinc-ops/frontaliere-si-o-no';
    const corpus = 'nanakokyobashi-rgb/frontaliere-articles';
    expect(crawlerRunToken(corpus, site, corpus, 'cross-repo-token')).toBe('cross-repo-token');
    expect(crawlerRunToken(site, site, corpus, 'cross-repo-token')).toBeUndefined();
    expect(crawlerRunToken(corpus, corpus, corpus, 'cross-repo-token')).toBeUndefined();
  });

  it('returns null for a crawler slug not present in any current group file (renamed/removed)', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'close-recovered-test-'));
    writeGroupFile(tmpDir, 'crawler-group-01.yml', 'Crawler Group 01 (1 crawlers)', ['roche']);

    expect(findCrawlerGroupWorkflowName('nonexistent-crawler', tmpDir)).toBeNull();
  });

  it('does not false-match on a slug that is a PREFIX of another slug in the same file', () => {
    // Regression guard: `id: crawler-hoch-health` must not satisfy a lookup for
    // slug "hoch" via naive substring matching without an anchor.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'close-recovered-test-'));
    writeGroupFile(tmpDir, 'crawler-group-01.yml', 'Crawler Group 01 (1 crawlers)', ['hoch-health']);

    // "hoch" is a real prefix of "hoch-health" — `id: crawler-hoch` is NOT
    // present in the file (only `id: crawler-hoch-health` is), so a lookup for
    // the shorter, non-existent slug must return null, not the group that
    // happens to contain a longer slug sharing the same prefix.
    expect(findCrawlerGroupWorkflowName('hoch', tmpDir)).toBeNull();
    expect(findCrawlerGroupWorkflowName('hoch-health', tmpDir)).toBe('Crawler Group 01 (1 crawlers)');
  });

  it('returns null when the workflows directory does not exist', () => {
    expect(findCrawlerGroupWorkflowName('roche', '/nonexistent/path/xyz')).toBeNull();
  });

  it('resolves against the REAL committed crawler-group-*.yml files in this repo', () => {
    // Integration check against the actual generated output (not a synthetic
    // fixture) — picks a handful of real slugs known to exist in the manifest
    // and confirms they resolve to SOME group workflow name.
    const realWorkflowsDir = path.resolve(import.meta.dirname, '..', '.github', 'workflows');
    if (!fs.existsSync(realWorkflowsDir)) return; // skip if run outside the repo checkout
    const groupFiles = fs.readdirSync(realWorkflowsDir).filter((f) => /^crawler-group-\d+\.yml$/.test(f));
    if (groupFiles.length === 0) return; // generator hasn't run in this checkout

    const name = findCrawlerGroupWorkflowName('roche', realWorkflowsDir);
    expect(name).not.toBeNull();
    expect(name).toMatch(/^Crawler Group \d+/);
    // Il gruppo di quarantena reale si riconosce, gli altri no.
    expect(findCrawlerGroupWorkflow('protectas', realWorkflowsDir)?.quarantine).toBe(true);
    expect(findCrawlerGroupWorkflow('roche', realWorkflowsDir)?.quarantine).toBe(false);
  });

  it('wires the site reconciler to the repository that now hosts crawler runs', () => {
    const workflowPath = path.resolve(import.meta.dirname, '..', '.github', 'workflows', 'close-recovered-failure-issues.yml');
    const workflow = fs.readFileSync(workflowPath, 'utf8');
    expect(workflow).toContain('CRAWLER_RUN_REPO: nanakokyobashi-rgb/frontaliere-articles');
    expect(workflow).toContain('Load cross-repo token from Remote Config');
    expect(workflow).toContain('GITHUB_PAT_NANAKO non caricato');
  });
});

// `CI Failure: Crawler Group 19 (27 crawlers)` (issue 10019) nasce da un dispatch
// manuale dell'entry point del sito, che dopo la migrazione non ha piu' run di
// produzione; nel frattempo il roster e' tornato a 28 e il `name:` e' cambiato.
// Senza questa risoluzione la issue resta aperta per sempre mentre il gruppo gira
// verde nel corpus.
describe('failureRunHistorySource — a crawler GROUP failure is judged on its production runs', () => {
  const site = 'valerielinc-ops/frontaliere-si-o-no';
  const corpus = 'nanakokyobashi-rgb/frontaliere-articles';
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeWorkflow(filename: string, name: string) {
    fs.writeFileSync(path.join(tmpDir, filename), `name: ${name}\non:\n  workflow_dispatch: {}\njobs: {}\n`);
  }

  it('resolves a stale `(N crawlers)` suffix to the current group file', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'close-recovered-group-'));
    writeWorkflow('crawler-group-19.yml', 'Crawler Group 19 (28 crawlers)');
    writeWorkflow('crawler-group-19-logic.yml', 'Crawler Group 19 logic (reusable workflow)');

    expect(findCrawlerGroupWorkflowByDisplayName('Crawler Group 19 (27 crawlers)', tmpDir))
      .toEqual({ filename: 'crawler-group-19.yml', name: 'Crawler Group 19 (28 crawlers)' });
    expect(failureRunHistorySource('Crawler Group 19 (27 crawlers)', { workflowsDir: tmpDir, issueRepo: site, runRepo: corpus }))
      .toEqual({ workflowRef: 'crawler-group-19.yml', repo: corpus, includeCrawlerShadowBranches: true });
    // Il twin del corpus legge le proprie run: lo stesso gruppo, per display name.
    expect(failureRunHistorySource('Crawler Group 19 (27 crawlers)', { workflowsDir: tmpDir, issueRepo: corpus, runRepo: corpus }))
      .toEqual({ workflowRef: 'Crawler Group 19 (28 crawlers)', repo: corpus, includeCrawlerShadowBranches: true });
  });

  it('pads the group number like the generator does', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'close-recovered-group-'));
    writeWorkflow('crawler-group-05.yml', 'Crawler Group 05 (25 crawlers)');
    expect(findCrawlerGroupWorkflowByDisplayName('Crawler Group 5 (24 crawlers)', tmpDir)?.filename)
      .toBe('crawler-group-05.yml');
  });

  it('leaves every other workflow on its own name, on main of the issue repo', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'close-recovered-group-'));
    writeWorkflow('crawler-group-19.yml', 'Crawler Group 19 (28 crawlers)');
    for (const name of ['Orchestrate Job Crawlers', 'Crawler Group 19 logic (reusable workflow)']) {
      expect(failureRunHistorySource(name, { workflowsDir: tmpDir, issueRepo: site, runRepo: corpus }))
        .toEqual({ workflowRef: name, repo: site, includeCrawlerShadowBranches: false });
    }
    // Gruppo senza file generato (rimosso): nessuna risoluzione inventata.
    expect(findCrawlerGroupWorkflowByDisplayName('Crawler Group 31 (2 crawlers)', tmpDir)).toBeNull();
  });

  it('resolves the real issue 10019 title against the committed workflows', () => {
    expect(failureRunHistorySource('Crawler Group 19 (27 crawlers)', { issueRepo: site, runRepo: corpus }))
      .toEqual({ workflowRef: 'crawler-group-19.yml', repo: corpus, includeCrawlerShadowBranches: true });
  });
});

// Annotation REALI della run corpus 36328240478 (gruppo 24, 2026-09-27): cinque membri
// falliti, tutti con `conclusion: success` nella Jobs API perché `Run <slug>` è
// continue-on-error. È la run che #9586 citava come «Green run» chiudendo la issue di
// confederazione 36 minuti dopo averla riaperta.
const GROUP_24_RED_ANNOTATIONS = [[
  { annotation_level: 'failure', message: 'Process completed with exit code 1.' },
  {
    annotation_level: 'failure',
    message: 'crawler group completed with 12 succeeded, 5 failed, 0 missing, 0 systemic; healthy siblings were preserved, but the group remains failed until incomplete crawlers are recovered',
  },
  { annotation_level: 'failure', message: 'convit: crawler exited with status 1' },
  { annotation_level: 'failure', message: 'knowledge-lab: crawler exited with status 1' },
  { annotation_level: 'failure', message: 'lwphr: crawler exited with status 1' },
  { annotation_level: 'failure', message: 'protectas: crawler exited with status 1' },
  { annotation_level: 'failure', message: 'confederazione: crawler exited with status 1' },
  { annotation_level: 'failure', message: 'Process completed with exit code 1.' },
  { annotation_level: 'notice', message: 'The ubuntu-latest label will migrate to Ubuntu 26 beginning October 19, 2026.' },
]];

const redMemberStep = { stepStatus: 'completed', stepConclusion: 'success', jobConclusion: 'failure' };

/** The gate's outcome line, in the exact form the generated workflows echo. */
function groupCompleted({ succeeded = 16, failed = 0, missing = 0, systemic = 0, tolerated }: {
  succeeded?: number; failed?: number; missing?: number; systemic?: number; tolerated?: number;
}) {
  const head = `crawler group completed with ${succeeded} succeeded, ${failed} failed, ${missing} missing, ${systemic} systemic; healthy siblings were preserved`;
  return tolerated === undefined
    ? `${head}, but the group remains failed until incomplete crawlers are recovered`
    : `${head}, ${tolerated} known failures are excluded by the quarantine registry, and the failures counted here are new, regressions or past their deadline`;
}

describe('decideCrawlerMemberConclusion — the Run <slug> step conclusion is not the member outcome', () => {
  it('keeps a failed member red although its continue-on-error step reports success', () => {
    expect(decideCrawlerMemberConclusion({
      ...redMemberStep,
      slug: 'confederazione',
      annotationPages: GROUP_24_RED_ANNOTATIONS,
    })).toBe('failure');
  });

  it('treats a member of a red group as recovered when only siblings failed', () => {
    expect(decideCrawlerMemberConclusion({
      ...redMemberStep,
      slug: 'anicura',
      annotationPages: GROUP_24_RED_ANNOTATIONS,
    })).toBe('success');
  });

  it('does not confuse a slug with a longer sibling slug sharing its prefix', () => {
    expect(decideCrawlerMemberConclusion({
      ...redMemberStep,
      slug: 'knowledge',
      annotationPages: GROUP_24_RED_ANNOTATIONS,
    })).toBe('success');
  });

  it('trusts a green group job without reading annotations', () => {
    expect(decideCrawlerMemberConclusion({
      slug: 'confederazione',
      stepStatus: 'completed',
      stepConclusion: 'success',
      jobConclusion: 'success',
    })).toBe('success');
  });

  it('keeps a known quarantine failure non-green even when the quarantine job is green', () => {
    const greenQuarantineJob = {
      stepStatus: 'completed',
      stepConclusion: 'success',
      jobConclusion: 'success',
    };
    const pages = [[
      {
        annotation_level: 'warning',
        message: 'protectas: fallimento noto in quarantena (exit 1), tracciato da #10084 fino al 2026-10-03; escluso dal verdetto del gruppo',
      },
      { annotation_level: 'notice', message: '{"schemaVersion":1}' },
    ]];
    expect(decideCrawlerMemberConclusion({ ...greenQuarantineJob, slug: 'protectas', annotationPages: pages })).toBe('failure');
    expect(decideCrawlerMemberConclusion({ ...greenQuarantineJob, slug: 'anicura', annotationPages: pages })).toBe('success');
    // A fully green group can have no annotations at all.
    expect(decideCrawlerMemberConclusion({ ...greenQuarantineJob, slug: 'anicura', annotationPages: [] })).toBe('success');
    // Unreadable annotations are missing evidence, not a green.
    expect(decideCrawlerMemberConclusion({ ...greenQuarantineJob, slug: 'protectas', annotationPages: null })).toBeNull();
    // On a red job the same warning counts as the member's own non-green outcome.
    expect(decideCrawlerMemberConclusion({ ...greenQuarantineJob, jobConclusion: 'failure', slug: 'protectas', annotationPages: pages })).toBe('failure');
  });

  it('returns the step conclusion when the step itself did not succeed', () => {
    expect(decideCrawlerMemberConclusion({
      slug: 'confederazione',
      stepStatus: 'completed',
      stepConclusion: 'skipped',
      jobConclusion: 'failure',
    })).toBe('skipped');
  });

  it('never calls a cancelled or timed-out group green', () => {
    for (const jobConclusion of ['cancelled', 'timed_out']) {
      expect(decideCrawlerMemberConclusion({
        slug: 'anicura',
        stepStatus: 'completed',
        stepConclusion: 'success',
        jobConclusion,
      })).toBe(jobConclusion);
    }
  });

  it('keeps missing (warning) and systemic exit-143 members non-green', () => {
    const pages = [[
      { annotation_level: 'warning', message: 'lidl: no terminal status was published' },
      { annotation_level: 'warning', message: 'fust: runner shutdown recorded as systemic outcome (exit 143); no per-crawler issue filed' },
    ]];
    expect(decideCrawlerMemberConclusion({ ...redMemberStep, slug: 'lidl', annotationPages: pages })).toBe('failure');
    expect(decideCrawlerMemberConclusion({ ...redMemberStep, slug: 'fust', annotationPages: pages })).toBe('failure');
  });

  it('ignores a free-form warning of the same crawler', () => {
    const pages = [[
      { annotation_level: 'failure', message: groupCompleted({ failed: 1 }) },
      { annotation_level: 'failure', message: 'lwphr: crawler exited with status 1' },
      { annotation_level: 'warning', message: 'lidl: detail page fell back to listing description' },
    ]];
    expect(decideCrawlerMemberConclusion({ ...redMemberStep, slug: 'lidl', annotationPages: pages })).toBe('success');
  });

  it('keeps the exit-43 shared-precondition message non-green', () => {
    const pages = [[{
      annotation_level: 'failure',
      message: "alpiq: crawl OK but the crawler group's shared deferred-commit precondition failed (exit 43). Group-wide fault, identical for every sibling — step stays red, no per-crawler issue filed (systemic class).",
    }]];
    expect(decideCrawlerMemberConclusion({ ...redMemberStep, slug: 'alpiq', annotationPages: pages })).toBe('failure');
  });

  it('returns null when a failed job has unreadable or empty annotations', () => {
    for (const annotationPages of [null, undefined, [], [[]], [[{ annotation_level: 'failure' }]]]) {
      expect(decideCrawlerMemberConclusion({ ...redMemberStep, slug: 'anicura', annotationPages })).toBeNull();
    }
  });

  it('returns null when GitHub may have truncated the per-member annotations', () => {
    const tenFailures = Array.from({ length: 10 }, (_, index) => ({
      annotation_level: 'failure',
      message: `member-${index}: crawler exited with status 43`,
    }));
    expect(decideCrawlerMemberConclusion({ ...redMemberStep, slug: 'anicura', annotationPages: [tenFailures] })).toBeNull();

    const fiftyNotices = Array.from({ length: 50 }, () => ({ annotation_level: 'notice', message: 'noise' }));
    expect(decideCrawlerMemberConclusion({ ...redMemberStep, slug: 'anicura', annotationPages: [fiftyNotices] })).toBeNull();
  });
});

// #7483, review 🔴 della discesa nel corpus (nanakokyobashi-rgb/frontaliere-articles#1973):
// «nessuna riga per questo slug» prova il verde solo se l'elenco dell'aggregato e' completo.
describe('decideCrawlerMemberConclusion — a missing line proves green only against the gate outcome', () => {
  const exit1 = { annotation_level: 'failure', message: 'Process completed with exit code 1.' };

  it('returns null when the job is red for a group error that names no member', () => {
    for (const message of [
      'crawler aggregate step did not complete; group failed after preserving already-running siblings',
      'crawler aggregate produced an invalid count: invalid',
      'timeout command unavailable; refusing to run an unbounded crawler worker',
    ]) {
      const pages = [[{ annotation_level: 'failure', message }, exit1]];
      expect(decideCrawlerMemberConclusion({ ...redMemberStep, slug: 'anicura', annotationPages: pages }), message).toBeNull();
    }
  });

  it('returns null when the job is red with no gate outcome line at all (e.g. a commit step)', () => {
    const pages = [[{ annotation_level: 'failure', message: 'crawler group 24 failed (exit 1); token-bound output was not published' }, exit1]];
    expect(decideCrawlerMemberConclusion({ ...redMemberStep, slug: 'anicura', annotationPages: pages })).toBeNull();
  });

  it('returns null when fewer members are listed than the gate declares (dropped annotations)', () => {
    // Tre `quarantena scaduta` e sette `crawler exited` riempiono i 10 errori dello step:
    // l'undicesimo fallito sparisce, e il vecchio contatore ne vedeva solo 7.
    const expired = ['a1', 'a2', 'a3'].map((slug) => ({
      annotation_level: 'failure',
      message: `${slug}: quarantena scaduta il 2026-09-20 senza recupero (issue #1, exit 1); il crawler va riparato o ritirato`,
    }));
    const exited = Array.from({ length: 7 }, (_, index) => ({
      annotation_level: 'failure',
      message: `b${index}: crawler exited with status 1`,
    }));
    const pages = [[{ annotation_level: 'failure', message: groupCompleted({ failed: 11, tolerated: 0 }) }, ...expired, ...exited, exit1]];
    expect(decideCrawlerMemberConclusion({ ...redMemberStep, slug: 'anicura', annotationPages: pages })).toBeNull();
    // Stesso elenco, ma il gate ne dichiara 10: completo, il membro assente e' verde...
    const complete = [[{ annotation_level: 'failure', message: groupCompleted({ failed: 9, missing: 1 }) }, ...expired, ...exited.slice(0, 6),
      { annotation_level: 'warning', message: 'c1: no terminal status was published' }, exit1]];
    expect(decideCrawlerMemberConclusion({ ...redMemberStep, slug: 'anicura', annotationPages: complete })).toBe('success');
    // ...e la riga `quarantena scaduta` rende rosso il suo membro.
    expect(decideCrawlerMemberConclusion({ ...redMemberStep, slug: 'a2', annotationPages: complete })).toBe('failure');
  });

  it('counts errors and warnings on their own GitHub limits: 6 failures + 4 missing is a complete list', () => {
    const failures = Array.from({ length: 6 }, (_, index) => ({ annotation_level: 'failure', message: `f${index}: crawler exited with status 2` }));
    const missing = Array.from({ length: 4 }, (_, index) => ({ annotation_level: 'warning', message: `m${index}: no terminal status was published` }));
    const pages = [[{ annotation_level: 'failure', message: groupCompleted({ failed: 6, missing: 4 }) }, ...failures, ...missing, exit1]];
    expect(decideCrawlerMemberConclusion({ ...redMemberStep, slug: 'anicura', annotationPages: pages })).toBe('success');
  });

  it('checks the systemic-only outcome line against the systemic warnings', () => {
    const shutdown = (slug: string) => ({
      annotation_level: 'warning',
      message: `${slug}: runner shutdown recorded as systemic outcome (exit 143); no per-crawler issue filed`,
    });
    const interrupted = (count: number) => ({
      annotation_level: 'failure',
      message: `crawler group interrupted: ${count} member(s) stopped by a runner shutdown (exit 143) before completing; 15 succeeded and were preserved, no per-crawler issue filed (systemic class), and the interrupted crawlers keep their previous data until the next wave`,
    });
    expect(decideCrawlerMemberConclusion({ ...redMemberStep, slug: 'anicura', annotationPages: [[interrupted(2), shutdown('s1'), shutdown('s2'), exit1]] })).toBe('success');
    expect(decideCrawlerMemberConclusion({ ...redMemberStep, slug: 'anicura', annotationPages: [[interrupted(2), shutdown('s1'), exit1]] })).toBeNull();
  });

  it('checks the quarantine group\'s tolerated count as well', () => {
    const tolerated = (slug: string) => ({
      annotation_level: 'warning',
      message: `${slug}: fallimento noto in quarantena (exit 1), tracciato da #10084 fino al 2026-10-03; escluso dal verdetto del gruppo`,
    });
    const failed = { annotation_level: 'failure', message: 'n1: crawler exited with status 1' };
    const outcome = (count: number) => ({ annotation_level: 'failure', message: groupCompleted({ failed: 1, tolerated: count }) });
    expect(decideCrawlerMemberConclusion({ ...redMemberStep, slug: 'anicura', annotationPages: [[outcome(2), failed, tolerated('t1'), tolerated('t2'), exit1]] })).toBe('success');
    expect(decideCrawlerMemberConclusion({ ...redMemberStep, slug: 'anicura', annotationPages: [[outcome(3), failed, tolerated('t1'), tolerated('t2'), exit1]] })).toBeNull();
  });

  it('returns null when two outcome lines disagree', () => {
    const pages = [[
      { annotation_level: 'failure', message: groupCompleted({ failed: 1 }) },
      { annotation_level: 'failure', message: groupCompleted({ failed: 2 }) },
      { annotation_level: 'failure', message: 'lwphr: crawler exited with status 1' },
    ]];
    expect(decideCrawlerMemberConclusion({ ...redMemberStep, slug: 'anicura', annotationPages: pages })).toBeNull();
  });
});

// #7483, secondo 🔴 della review di nanakokyobashi-rgb/frontaliere-articles#1973: il gruppo di
// quarantena chiude verde anche con fallimenti noti, e il warning che li segnala può
// essere scartato dai tetti di GitHub. Il verdetto per membro si legge dal notice.
describe('decideCrawlerMemberConclusion — the quarantine group reads the outcomes notice', () => {
  const quarantineJob = (jobConclusion: string) => ({
    stepStatus: 'completed', stepConclusion: 'success', jobConclusion, quarantineGroup: true,
  });
  const notice = (outcomes: Record<string, string>) => ({
    annotation_level: 'notice',
    title: CRAWLER_QUARANTINE_OUTCOMES_NOTICE_TITLE,
    message: JSON.stringify({ schemaVersion: 1, group: '24', outcomes }),
  });
  const outcomes = { anicura: 'success', protectas: 'failure', lidl: 'missing', fust: 'systemic' };

  it('keeps the title in sync with the quarantine module that generates the notice', () => {
    expect(CRAWLER_QUARANTINE_OUTCOMES_NOTICE_TITLE).toBe(QUARANTINE_OUTCOMES_NOTICE_TITLE);
  });

  it('a known failure stays non-green on a green job even when its warning was dropped', () => {
    // Nessun warning `protectas: fallimento noto in quarantena`: prima bastava a dire verde.
    const pages = [[notice(outcomes)]];
    expect(decideCrawlerMemberConclusion({ ...quarantineJob('success'), slug: 'protectas', annotationPages: pages })).toBe('failure');
    expect(decideCrawlerMemberConclusion({ ...quarantineJob('success'), slug: 'anicura', annotationPages: pages })).toBe('success');
  });

  it('missing and systemic members are not green, on a green or red job', () => {
    for (const jobConclusion of ['success', 'failure']) {
      for (const slug of ['lidl', 'fust']) {
        expect(decideCrawlerMemberConclusion({ ...quarantineJob(jobConclusion), slug, annotationPages: [[notice(outcomes)]] })).toBe('failure');
      }
    }
  });

  it('returns null without a single readable notice naming the member', () => {
    for (const annotationPages of [
      undefined, null, [], [[]],
      [[{ annotation_level: 'warning', message: 'quarantine group: 16 succeeded, 1 known failures excluded' }]],
      [[{ ...notice(outcomes), message: '{not json' }]],
      [[notice(outcomes), notice(outcomes)]],
      [[notice({ protectas: 'failure' })]],
    ]) {
      expect(decideCrawlerMemberConclusion({ ...quarantineJob('success'), slug: 'anicura', annotationPages })).toBeNull();
    }
  });

  it('a cancelled or timed-out quarantine job keeps its own conclusion', () => {
    for (const jobConclusion of ['cancelled', 'timed_out']) {
      expect(decideCrawlerMemberConclusion({ ...quarantineJob(jobConclusion), slug: 'anicura', annotationPages: [[notice(outcomes)]] })).toBe(jobConclusion);
    }
  });
});

describe('checkRunApiPath', () => {
  it('turns the Jobs API check_run_url into a relative gh api path', () => {
    expect(checkRunApiPath('https://api.github.com/repos/nanakokyobashi-rgb/frontaliere-articles/check-runs/108645067464'))
      .toBe('repos/nanakokyobashi-rgb/frontaliere-articles/check-runs/108645067464');
    expect(checkRunApiPath('repos/o/r/check-runs/1')).toBe('repos/o/r/check-runs/1');
  });

  it('rejects anything that is not a check-run URL', () => {
    for (const value of [undefined, '', 'https://example.com/repos/o/r/check-runs/1', 'repos/o/r/actions/runs/1']) {
      expect(checkRunApiPath(value)).toBeNull();
    }
  });
});

describe('crawler member annotations stay aligned with the generated group workflows', () => {
  // Osservatore: se il generatore cambia il testo delle annotation dell'aggregato o
  // toglie continue-on-error allo step di risultato, la lettura qui sopra va rivista.
  const corpusWorkflowsDir = path.resolve(import.meta.dirname, '..', '.github', 'corpus-workflows');
  const groupFiles = fs.existsSync(corpusWorkflowsDir)
    ? fs.readdirSync(corpusWorkflowsDir).filter((file) => /^crawler-group-\d+\.yml$/.test(file))
    : [];

  it('finds the generated corpus group workflows', () => {
    expect(groupFiles.length).toBeGreaterThan(0);
  });

  it.each(groupFiles)('%s emits the per-member messages the reconciler parses', (file) => {
    const content = fs.readFileSync(path.join(corpusWorkflowsDir, file), 'utf8');
    const slugs = [...content.matchAll(/^\s*- name: Run (\S+)\s*$/gm)].map((match) => match[1]);
    expect(slugs.length).toBeGreaterThan(0);
    for (const slug of slugs) {
      const stepStart = content.search(new RegExp(`^\\s*- name: Run ${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm'));
      const stepHead = content.slice(stepStart, stepStart + 400);
      expect(stepHead).toMatch(/continue-on-error: true/);

      const failureLine = `echo "::error::${slug}: crawler exited with status $status"`;
      const missingLine = `echo "::warning::${slug}: no terminal status was published"`;
      // A known failure in the quarantine group reports itself with the
      // quarantine warning until its deadline and with an error after it.
      const toleratedLine = `echo "::warning::${slug}: fallimento noto in quarantena`;
      const expiredLine = `echo "::error::${slug}: quarantena scaduta il `;
      if (content.includes(toleratedLine)) {
        expect(content).toContain(expiredLine);
        expect(CRAWLER_MEMBER_QUARANTINE_ANNOTATION_RE.test(`${slug}: fallimento noto in quarantena (exit 1)`)).toBe(true);
        expect(CRAWLER_MEMBER_WARNING_ANNOTATION_RE.test(`${slug}: fallimento noto in quarantena (exit 1)`)).toBe(true);
      } else {
        expect(content).toContain(failureLine);
      }
      expect(content).toContain(missingLine);
      expect(CRAWLER_MEMBER_FAILURE_ANNOTATION_RE.test(`${slug}: crawler exited with status 1`)).toBe(true);
      expect(CRAWLER_MEMBER_FAILURE_ANNOTATION_RE.test(`${slug}: quarantena scaduta il 2026-10-03 senza recupero`)).toBe(true);
      expect(CRAWLER_MEMBER_WARNING_ANNOTATION_RE.test(`${slug}: no terminal status was published`)).toBe(true);
    }
  });

  it.each(groupFiles)('%s gate emits the outcome lines whose counts prove the member list complete', (file) => {
    const content = fs.readFileSync(path.join(corpusWorkflowsDir, file), 'utf8');
    const completed = /echo "::error::(crawler group completed with \$success_count succeeded, \$failure_count failed, \$missing_count missing, \$systemic_count systemic;[^"]*)"/.exec(content);
    const interrupted = /echo "::error::(crawler group interrupted: \$systemic_count member\(s\) stopped by a runner shutdown[^"]*)"/.exec(content);
    expect(completed).not.toBeNull();
    expect(interrupted).not.toBeNull();
    // I numeri al posto delle variabili: la riga reale deve leggere come la leggiamo qui.
    const render = (line: string) => line.replace(/\$(success|failure|missing|systemic|tolerated)_count/g, '3');
    expect(CRAWLER_GROUP_COMPLETED_ANNOTATION_RE.test(render(completed![1]))).toBe(true);
    expect(CRAWLER_GROUP_INTERRUPTED_ANNOTATION_RE.test(render(interrupted![1]))).toBe(true);
    if (content.includes('fallimento noto in quarantena')) {
      expect(CRAWLER_GROUP_TOLERATED_COUNT_RE.test(render(completed![1]))).toBe(true);
    }
  });
});
