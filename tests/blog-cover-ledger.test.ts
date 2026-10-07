import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const BASELINE_PATH = path.join(ROOT, 'data/blog-cover-corpus-baseline.json');
// A same-URL article-hero generation must remain article-specific; four is a
// deliberately small safety ceiling for any future explicit substitution.
const MAX_ARTICLES_PER_SUBSTITUTED_COVER = 4;

const REGISTRIES = [
  'packages/articles/content/blog-articles-data.ts',
  'packages/articles/content/swiss-articles-data.ts',
] as const;

function parseRegistry(source: string): Map<string, string> {
  const articles = new Map<string, string>();
  const objectRx = /\{\s*\n\s*id:\s*'([^']+)'([\s\S]*?)\n\s*\},?/g;
  let match: RegExpExecArray | null;
  while ((match = objectRx.exec(source))) {
    const image = match[2].match(/\n\s*image:\s*'([^']+)'/)?.[1];
    if (image) articles.set(match[1], image);
  }
  return articles;
}

function readRegistry(file: string, root = ROOT): Map<string, string> {
  return parseRegistry(fs.readFileSync(path.join(root, file), 'utf8'));
}

describe('blog cover ledger invariants', () => {
  it('never drops distinct covers below the corpus registry', () => {
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as {
      registries: Record<string, { articles: number; distinctImages: number }>;
    };
    for (const file of REGISTRIES) {
      const articles = readRegistry(file);
      const expected = baseline.registries[file];
      expect(articles.size, file).toBe(expected.articles);
      expect(new Set(articles.values()).size, file).toBeGreaterThanOrEqual(expected.distinctImages);
    }
  });

  it('compares every article by ID when a local corpus checkout is available', () => {
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as {
      sourceCommit: string;
    };
    const corpusRoot = process.env.FRONTALIERE_ARTICLES_ROOT;
    const corpusGitRoot = process.env.FRONTALIERE_ARTICLES_GIT_ROOT;
    if ((!corpusRoot || !fs.existsSync(corpusRoot)) && (!corpusGitRoot || !fs.existsSync(corpusGitRoot))) return;
    if (corpusGitRoot) {
      const commit = execFileSync('git', ['rev-parse', 'origin/main'], { cwd: corpusGitRoot, encoding: 'utf8' }).trim();
      expect(commit, 'corpus baseline commit').toBe(baseline.sourceCommit);
    }
    for (const file of REGISTRIES) {
      const site = readRegistry(file);
      const corpus = corpusGitRoot
        ? readGitRegistry(file, corpusGitRoot)
        : readRegistry(baselinePath(file), corpusRoot);
      expect(corpus.size, `${file}: corpus article count`).toBe(site.size);
      const differences = [...site].filter(([id, image]) => corpus.get(id) !== image);
      expect(differences, file).toEqual([]);
    }
  });

  it(`rejects cross-article substitutions above N=${MAX_ARTICLES_PER_SUBSTITUTED_COVER}`, () => {
    const plan = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/blog-cover-replacements.json'), 'utf8')) as {
      items?: Record<string, { mode?: string; fromCover?: string; toCover?: string }>;
    };
    const byTarget = new Map<string, string[]>();
    for (const [key, item] of Object.entries(plan.items || {})) {
      if (!item.fromCover || !item.toCover || item.fromCover === item.toCover) continue;
      const keys = byTarget.get(item.toCover) || [];
      keys.push(key);
      byTarget.set(item.toCover, keys);
      expect(item.mode, key).toBe('generated');
    }
    for (const [cover, keys] of byTarget) {
      expect(keys.length, `${cover}: substituted article count`).toBeLessThanOrEqual(MAX_ARTICLES_PER_SUBSTITUTED_COVER);
    }
  });
});

function baselinePath(file: string): string {
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')).registries[file].corpusPath;
}

function readGitRegistry(file: string, root: string): Map<string, string> {
  const source = execFileSync('git', ['show', `origin/main:${baselinePath(file)}`], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return parseRegistry(source);
}
