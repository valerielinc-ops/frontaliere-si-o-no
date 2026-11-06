import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const engine = (name: string) => readFileSync(
  resolve(ROOT, 'packages/articles/engine', name),
  'utf8',
);

describe('articles engine X Card coverage', () => {
  it('uses one shared X Card emitter in every engine-owned HTML template', () => {
    for (const file of ['ogPagesPlugin.ts', 'articleHubPagesPlugin.ts', 'cantonSectionPages.ts']) {
      const source = engine(file);
      expect(source).toContain("from './shared/twitterCardMeta'");
      expect(source).toContain('${twitterCardMeta}');
    }
  });

  it('emits all four required tags and clamps the description through the shell', () => {
    const source = engine('shared/twitterCardMeta.ts');
    expect(source).toContain('twitter:card');
    expect(source).toContain('twitter:title');
    expect(source).toContain('twitter:description');
    expect(source).toContain('twitter:image');
    expect(source).toContain('shell.clampMetaDescription');
    expect(source).toContain('shell.esc(opts.title)');
  });
});
