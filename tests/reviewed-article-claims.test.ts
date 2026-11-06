import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

function readReviewedArticle(relativePath: string): string {
  try {
    return readFileSync(join(repoRoot, relativePath), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const ref = process.env.GITHUB_SHA || 'HEAD';
    return execFileSync('git', ['show', `${ref}:${relativePath}`], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  }
}

describe('reviewed article claims', () => {
  it('rejects the contradictory Ukraine and cross-border tax claims', () => {
    const reviewedArticles = [
      'packages/articles/content/blog-body-ch/en/seco-ordinanza-ucraina-2026.ts',
      'packages/articles/content/blog-body/it/trasferirsi-a-sarre-da-frontaliere-pro-e-contro.ts',
      'packages/articles/content/blog-body/it/vivere-agra-lavorare-ticino-frontalieri.ts',
      'packages/articles/content/blog-body/it/vivere-lozza-lavorare-ticino.ts',
      'packages/articles/content/blog-body/it/vivere-valfurva-e-lavorare-grigioni-da-frontaliere.ts',
    ];
    const forbiddenPatterns = [
      /even if he does not have a minimum income/i,
      /fino a\s*€\s*20[.'’]?000/i,
      /€\s*75[.'’]?000/i,
      /solo in Svizzera/i,
      /non dovrai pagare l\\?['’]imposta italiana/i,
    ];

    const violations = reviewedArticles.flatMap((relativePath) => {
      const article = readReviewedArticle(relativePath);
      return forbiddenPatterns
        .filter((pattern) => pattern.test(article))
        .map((pattern) => `${relativePath}: ${pattern}`);
    });

    expect(violations).toEqual([]);
  });
});
