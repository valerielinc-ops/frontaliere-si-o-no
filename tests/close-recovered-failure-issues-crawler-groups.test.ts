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
  crawlerRunToken,
  crawlerWorkflowReference,
  checkRunApiPath,
  decideCrawlerMemberConclusion,
  buildRunListArgs,
  filterCrawlerRecoveryRuns,
  findCrawlerGroupWorkflow,
  findCrawlerGroupWorkflowName,
  isCrawlerRecoveryBranch,
  sortCrawlerRecoveryRuns,
} from '../scripts/ci/close-recovered-failure-issues.mjs';

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
    });
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
  });

  it('wires the site reconciler to the repository that now hosts crawler runs', () => {
    const workflowPath = path.resolve(import.meta.dirname, '..', '.github', 'workflows', 'close-recovered-failure-issues.yml');
    const workflow = fs.readFileSync(workflowPath, 'utf8');
    expect(workflow).toContain('CRAWLER_RUN_REPO: nanakokyobashi-rgb/frontaliere-articles');
    expect(workflow).toContain('Load cross-repo token from Remote Config');
    expect(workflow).toContain('GITHUB_PAT_NANAKO non caricato');
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
      expect(content).toContain(failureLine);
      expect(content).toContain(missingLine);
      expect(CRAWLER_MEMBER_FAILURE_ANNOTATION_RE.test(`${slug}: crawler exited with status 1`)).toBe(true);
      expect(CRAWLER_MEMBER_WARNING_ANNOTATION_RE.test(`${slug}: no terminal status was published`)).toBe(true);
    }
  });
});
