import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

function coverBlobSize(cover: string) {
  const materialized = path.join(ROOT, 'public', cover);
  if (fs.existsSync(materialized)) return fs.statSync(materialized).size;
  return Number(execFileSync(
    'git',
    ['cat-file', '-s', `HEAD:public${cover}`],
    { cwd: ROOT, encoding: 'utf8' },
  ).trim());
}

describe('blog article publication contract', () => {
  it('keeps the Malnate cleanup cover dedicated, declared and consistent with SEO', () => {
    const cover = '/images/blog/article-mcdonalds-pulizia-malnate-2026.webp';
    const registry = fs.readFileSync(path.join(ROOT, 'packages/articles/content/blog-articles-data.ts'), 'utf8');
    const seo = fs.readFileSync(path.join(ROOT, 'packages/articles/content/seo/seo-blog-5.ts'), 'utf8');
    const generated = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/blog-generated-image-registry.json'), 'utf8'));
    const article = registry.match(/id: 'mcdonalds-pulizia-malnate-2026',[\s\S]*?\n\s*\},?/)?.[0];
    const metadata = seo.match(/'blog-mcdonalds-pulizia-malnate-2026': \{[\s\S]*?\n\s*\},\n\n/)?.[0];

    expect(article).toContain(`image: '${cover}'`);
    expect(metadata).toContain('${BASE_URL}' + cover);
    expect(coverBlobSize(cover)).toBeGreaterThan(0);
    expect(generated.assets).toContainEqual(expect.objectContaining({
      assetId: 'article-mcdonalds-pulizia-malnate-2026',
      imageUrl: cover,
      sha256: 'dd28d3eb59d3a63eb0659d9040234a98d642e650c1835bf1ef4934b26eae3662',
    }));
  });

  it('keeps the Festival del Racconto cover dedicated, declared and consistent with SEO', () => {
    const cover = '/images/blog/article-festival-racconto-varese-ottobre.webp';
    const registry = fs.readFileSync(path.join(ROOT, 'packages/articles/content/blog-articles-data.ts'), 'utf8');
    const seo = fs.readFileSync(path.join(ROOT, 'packages/articles/content/seo/seo-blog-5.ts'), 'utf8');
    const generated = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/blog-generated-image-registry.json'), 'utf8'));
    const article = registry.match(/id: 'festival-racconto-varese-ottobre',[\s\S]*?\n\s*\},?/)?.[0];
    const metadata = seo.match(/'blog-festival-racconto-varese-ottobre': \{[\s\S]*?\n\s*\},\n\n/)?.[0];

    expect(article).toContain(`image: '${cover}'`);
    expect(metadata).toContain('${BASE_URL}' + cover);
    expect(coverBlobSize(cover)).toBeGreaterThan(0);
    expect(generated.assets).toContainEqual(expect.objectContaining({
      assetId: 'article-festival-racconto-varese-ottobre',
      imageUrl: cover,
      sha256: '40161bee5a8662281eae77801b7ede56f9b78382aac0680cca2bb51871381476',
    }));
  });
});
