import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  ARTICLE_PUBLISHER_CODE_PATHS,
  ARTICLE_SURFACE_PATHS,
  classifyPublishSource,
  isArticlePublishInputPath,
  isArticleSurfacePath,
  isCurrentPublishSource,
} from '../../scripts/lib/article-chunk-publish-freshness.mjs';
import { COMPANION_CHUNKS, REGISTRIES } from '../../scripts/publish-article-chunks.mjs';
import { EDGE_PUSHED_FILES } from '../../infra/cloudflare-worker/locale-router.js';

const OLD_SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_PATH = path.join(ROOT_DIR, '.github/workflows/sync-articles-sitemaps.yml');

const FRESHNESS_CLI = path.join(ROOT_DIR, 'scripts/lib/article-chunk-publish-freshness.mjs');

// The steps of the replay job that upload something. The refresh inside the
// edge recheck runs the same generator command as the first one.
const REPLAY_PUBLISHING_STEPS = [
  'Publish client article chunks after article sync merge',
  'Replay article sitemap, RSS and ticker surfaces',
];
const INVOKED_SCRIPT_RE = /scripts\/[\w./-]+\.(?:mjs|cjs|js|ts|sh)/g;
const LOCAL_IMPORT_RE =
  /(?:import|export)\s[^'"`;]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\s*['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
const SOURCED_SHELL_FILE_RE = /^[ \t]*(?:source|\.)[ \t]+\S/m;

// Code the replay reaches without it deciding a single written byte. The walk
// below stops at each entry, has to reach every one of them, and each carries
// the reason it is safe to leave out of the list.
const REPLAY_CODE_THAT_WRITES_NOTHING: Record<string, string> = {
  // Evicts edge keys and stores nothing, so an older copy of it cannot put
  // older bytes at the edge. It is also the one script no other script may
  // name without the targeted flag (tests/cf-zone-purge-blast-radius.test.ts).
  'scripts/cf-purge-cache.mjs': 'cache purge',
  'scripts/lib/cf-analytics.mjs': 'zone lookup for the cache purge',
  'scripts/lib/cf-purge-variants.mjs': 'request bodies of the cache purge',
  // The replay runs the generator with --no-ticker and uploads the committed
  // ticker file, which is an article surface of its own.
  'build-plugins/newsTickerDataPlugin.ts': 'ticker computation, skipped by --no-ticker',
  // Renders the llms.txt family for `generated` entries only; the replay
  // asks for committed files.
  'scripts/generate-llms-txt.mjs': 'llms.txt generator, never requested by the replay',
};

type ReplayStep = { name?: string; run?: string };

function replaySteps(): ReplayStep[] {
  const workflow = parse(fs.readFileSync(WORKFLOW_PATH, 'utf8')) as {
    jobs: { 'replay-after-article-sync': { steps: ReplayStep[] } };
  };
  return workflow.jobs['replay-after-article-sync'].steps;
}

function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('#'));
    })
    .join('\n');
}

/** Local modules a file imports, plus the scripts its code names (child processes). */
function reachedFrom(relativePath: string): string[] {
  const code = codeOnly(fs.readFileSync(path.join(ROOT_DIR, relativePath), 'utf8'));
  // A sourced shell file would be code this walk cannot follow.
  if (relativePath.endsWith('.sh')) expect(code, relativePath).not.toMatch(SOURCED_SHELL_FILE_RE);
  const reached = new Set<string>();
  for (const match of code.matchAll(LOCAL_IMPORT_RE)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    const absolute = path.resolve(ROOT_DIR, path.dirname(relativePath), specifier);
    reached.add(path.relative(ROOT_DIR, absolute).split(path.sep).join('/'));
  }
  for (const match of code.matchAll(INVOKED_SCRIPT_RE)) reached.add(match[0]);
  reached.delete(relativePath);
  return [...reached];
}

const SURFACE_PATHS = [
  ['article content glob', 'packages/articles/content/blog-body/it/x.ts'],
  ['news sitemap', 'public/sitemap-news.xml'],
  ['RSS glob', 'public/rss-it.xml'],
  ['news ticker', 'public/news-ticker-live.json'],
  ['workflow trigger', '.github/workflows/sync-articles-sitemaps.yml'],
] as const;

describe('article chunk publish freshness fence', () => {
  it('allows the checkout at the current main tip', () => {
    expect(isCurrentPublishSource(NEW_SHA, NEW_SHA)).toBe(true);
    expect(isCurrentPublishSource(NEW_SHA.toUpperCase(), NEW_SHA)).toBe(true);
  });

  it('flags an older checkout for refresh after main moves', () => {
    // This is the ordering the section lease alone cannot prevent: the new run
    // wins the lease first, then the old queued run acquires it afterwards.
    // The workflows use false as a signal to re-render origin/main, not to
    // silently skip the publish.
    expect(isCurrentPublishSource(OLD_SHA, NEW_SHA)).toBe(false);
  });

  it('classifies an unchanged tip as current', () => {
    expect(classifyPublishSource(NEW_SHA, NEW_SHA, [])).toBe('current');
  });

  it('classifies an advance with no article-surface changes as unrelated', () => {
    expect(classifyPublishSource(OLD_SHA, NEW_SHA, [])).toBe('unrelated-advance');
    expect(classifyPublishSource(OLD_SHA, NEW_SHA, ['README.md', 'scripts/lib/example.mjs'])).toBe(
      'unrelated-advance',
    );
  });

  for (const [label, changedPath] of SURFACE_PATHS) {
    it(`classifies ${label} changes as superseded`, () => {
      expect(classifyPublishSource(OLD_SHA, NEW_SHA, [changedPath])).toBe('superseded');
    });
  }

  it('matches the workflow path filter exactly, including its glob families', () => {
    const workflow = parse(fs.readFileSync(WORKFLOW_PATH, 'utf8')) as {
      on: { push: { paths: string[] } };
    };

    expect(workflow.on.push.paths).toEqual([...ARTICLE_SURFACE_PATHS]);
    expect(isArticleSurfacePath('public/rss-it.xml')).toBe(true);
    expect(isArticleSurfacePath('packages/articles/content/blog-body/it/x.ts')).toBe(true);
    expect(isArticleSurfacePath('public/rss-it.txt')).toBe(false);
    expect(isArticleSurfacePath('packages/articles/engine/index.mjs')).toBe(false);
  });

  for (const publisherPath of ARTICLE_PUBLISHER_CODE_PATHS) {
    it(`classifies a change to ${publisherPath} as superseded`, () => {
      expect(classifyPublishSource(OLD_SHA, NEW_SHA, [publisherPath])).toBe('superseded');
      expect(classifyPublishSource(OLD_SHA, NEW_SHA, ['README.md', publisherPath])).toBe('superseded');
    });
  }

  it('answers superseded from the CLI when only the chunk generator changed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'article-chunk-freshness-'));
    try {
      const changed = path.join(dir, 'changed-paths.txt');
      fs.writeFileSync(changed, 'scripts/publish-article-chunks.mjs\n', 'utf8');
      const result = spawnSync(process.execPath, [
        FRESHNESS_CLI,
        '--source-sha', '1'.repeat(40),
        '--main-sha', '2'.repeat(40),
        '--changed-paths-file', changed,
      ], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('superseded\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the publisher code out of the replay trigger and pointing at real files', () => {
    for (const publisherPath of ARTICLE_PUBLISHER_CODE_PATHS) {
      // A publisher change makes a replay in flight stale; it does not by
      // itself schedule one, so it must not leak into the push path filter.
      expect(isArticleSurfacePath(publisherPath), publisherPath).toBe(false);
      expect(isArticlePublishInputPath(publisherPath), publisherPath).toBe(true);
      expect(fs.existsSync(path.join(ROOT_DIR, publisherPath)), publisherPath).toBe(true);
    }
    expect(isArticlePublishInputPath('scripts/lib/example.mjs')).toBe(false);
    expect(isArticlePublishInputPath(undefined)).toBe(false);
  });

  it('lists exactly the code that decides what the replay writes', () => {
    const steps = replaySteps();
    const invoked = new Set<string>();
    for (const name of REPLAY_PUBLISHING_STEPS) {
      const step = steps.find((candidate) => candidate.name === name);
      expect(step?.run, name).toBeTruthy();
      for (const match of String(step?.run).matchAll(INVOKED_SCRIPT_RE)) invoked.add(match[0]);
    }
    expect(invoked.size).toBeGreaterThan(0);

    const closure = new Set<string>();
    const cut = new Set<string>();
    const queue = [...invoked];
    while (queue.length > 0) {
      const current = queue.pop() as string;
      if (current in REPLAY_CODE_THAT_WRITES_NOTHING) {
        cut.add(current);
        continue;
      }
      if (closure.has(current)) continue;
      // An import this walk cannot resolve is a file it cannot vouch for.
      expect(fs.existsSync(path.join(ROOT_DIR, current)), current).toBe(true);
      closure.add(current);
      queue.push(...reachedFrom(current));
    }

    // A script or module added to the publishing path without being listed
    // would let a concurrent change to it pass as an unrelated advance.
    expect([...closure].sort()).toEqual([...ARTICLE_PUBLISHER_CODE_PATHS].sort());
    // An exclusion the replay no longer reaches has lost its reason.
    expect([...cut].sort()).toEqual(Object.keys(REPLAY_CODE_THAT_WRITES_NOTHING).sort());
  });

  it('keeps the two conditions the conditional exclusions rest on', () => {
    const steps = replaySteps();

    // --no-ticker on every generator run of the job, the refresh included.
    const generatorRuns = steps
      .flatMap((step) => String(step.run ?? '').split('\n'))
      .filter((line) => line.includes('scripts/publish-article-chunks.mjs') && !line.trim().startsWith('#'));
    expect(generatorRuns.length).toBeGreaterThanOrEqual(2);
    for (const line of generatorRuns) expect(line.includes('--no-ticker'), line.trim()).toBe(true);

    // Every edge path the replay asks for is a committed file, so the
    // llms.txt generator never runs for it.
    const edgeStep = steps.find((step) => step.name === 'Replay article sitemap, RSS and ticker surfaces');
    const requested = [...String(edgeStep?.run).matchAll(/--only=([^\s"']+)/g)].flatMap((match) => match[1].split(','));
    expect(requested.length).toBeGreaterThan(0);
    const table = EDGE_PUSHED_FILES as Record<string, { source?: string }>;
    for (const pathname of requested) {
      expect(table[pathname], pathname).toBeTruthy();
      expect(table[pathname]?.source === 'generated', pathname).toBe(false);
    }
  });

  it('does not make a replay stale for a change to code that writes nothing in it', () => {
    for (const excluded of Object.keys(REPLAY_CODE_THAT_WRITES_NOTHING)) {
      expect(fs.existsSync(path.join(ROOT_DIR, excluded)), excluded).toBe(true);
      expect(isArticlePublishInputPath(excluded), excluded).toBe(false);
      expect(classifyPublishSource(OLD_SHA, NEW_SHA, [excluded])).toBe('unrelated-advance');
    }
  });

  it('covers every file esbuild reads for a published chunk', async () => {
    const uncovered: string[] = [];
    let bundledInputs = 0;
    for (const { source } of [...REGISTRIES, ...COMPANION_CHUNKS]) {
      const result = await build({
        entryPoints: [path.join(ROOT_DIR, source)],
        bundle: true,
        format: 'esm',
        write: false,
        metafile: true,
        alias: { '@': ROOT_DIR },
        absWorkingDir: ROOT_DIR,
        logLevel: 'silent',
      });
      for (const input of Object.keys(result.metafile.inputs)) {
        bundledInputs += 1;
        const relative = path.relative(ROOT_DIR, path.resolve(ROOT_DIR, input)).split(path.sep).join('/');
        if (!isArticlePublishInputPath(relative)) uncovered.push(`${source} <- ${relative}`);
      }
    }

    // Each published source resolves (through its symlink) into the article
    // content tree. A runtime import from anywhere else would change the
    // published bytes without making an in-flight replay stale.
    expect(bundledInputs).toBeGreaterThanOrEqual(REGISTRIES.length + COMPANION_CHUNKS.length);
    expect(uncovered).toEqual([]);
  });

  it('fails closed when the changed path list is not available', () => {
    expect(() => classifyPublishSource(OLD_SHA, NEW_SHA, undefined)).toThrow(/changed paths/);
  });

  it('fails closed for malformed source or main SHAs', () => {
    expect(() => isCurrentPublishSource('old', NEW_SHA)).toThrow(/source SHA/);
    expect(() => isCurrentPublishSource(OLD_SHA, 'new')).toThrow(/main SHA/);
    expect(() => classifyPublishSource('old', NEW_SHA, [])).toThrow(/source SHA/);
    expect(() => classifyPublishSource(OLD_SHA, 'new', [])).toThrow(/main SHA/);
  });
});
