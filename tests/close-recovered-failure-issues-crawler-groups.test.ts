/**
 * Guards scripts/ci/close-recovered-failure-issues.mjs's post-consolidation
 * (2026-07) handling of `Crawler Failure:` issues.
 *
 * Before the crawler-workflow consolidation, every `Crawler Failure: <name>`
 * issue title embedded a real, dispatchable workflow name (one workflow per
 * crawler), resolvable via `gh run list -w <name>`. After consolidation, 581
 * individual crawler workflows were replaced by 23 grouped
 * `crawler-group-*.yml` workflows, each running ~25 crawlers as concurrent
 * `background: true` steps in ONE job. `${{ github.workflow }}` inside each
 * crawler's inlined failure-report step now resolves to the shared GROUP's
 * name for every crawler in it — so scripts/generate-crawler-group-workflows.mjs
 * substitutes it with a literal, per-crawler-unique `Run <slug>` identifier at
 * generation time instead (see that script's "HAZARD FIX 3"). This reconciler
 * must therefore resolve `Run <slug>` back to (a) which group currently
 * contains that crawler, and (b) that specific background STEP's own
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
  crawlerRunToken,
  crawlerWorkflowReference,
  findCrawlerGroupWorkflow,
  findCrawlerGroupWorkflowName,
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

describe('findCrawlerGroupWorkflowName — resolves a crawler slug to its CURRENT group workflow', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeGroupFile(dir: string, filename: string, name: string, slugs: string[]) {
    const steps = slugs.map((s) => `      - name: Run ${s}\n        id: crawler-${s}\n        background: true\n`).join('');
    fs.writeFileSync(
      path.join(dir, filename),
      `name: ${name}\non:\n  workflow_dispatch: {}\njobs:\n  group:\n    runs-on: ubuntu-latest\n    steps:\n${steps}      - name: Wait\n        wait-all: true\n`,
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
