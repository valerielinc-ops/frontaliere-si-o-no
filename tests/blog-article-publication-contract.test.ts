import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const COVER = '/images/blog/article-mcdonalds-pulizia-malnate-2026.webp';

describe('blog article publication contract', () => {
  it('keeps the Malnate cleanup cover dedicated, declared and consistent with SEO', () => {
    const registry = fs.readFileSync(path.join(ROOT, 'packages/articles/content/blog-articles-data.ts'), 'utf8');
    const seo = fs.readFileSync(path.join(ROOT, 'packages/articles/content/seo/seo-blog-5.ts'), 'utf8');
    const generated = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/blog-generated-image-registry.json'), 'utf8'));
    const article = registry.match(/id: 'mcdonalds-pulizia-malnate-2026',[\s\S]*?\n\s*\},?/)?.[0];
    const metadata = seo.match(/'blog-mcdonalds-pulizia-malnate-2026': \{[\s\S]*?\n\s*\},\n\n/)?.[0];

    expect(article).toContain(`image: '${COVER}'`);
    expect(metadata).toContain('${BASE_URL}' + COVER);
    expect(fs.existsSync(path.join(ROOT, `public${COVER}`))).toBe(true);
    expect(generated.assets).toContainEqual(expect.objectContaining({
      assetId: 'article-mcdonalds-pulizia-malnate-2026',
      imageUrl: COVER,
      sha256: 'dd28d3eb59d3a63eb0659d9040234a98d642e650c1835bf1ef4934b26eae3662',
    }));
  });
});
