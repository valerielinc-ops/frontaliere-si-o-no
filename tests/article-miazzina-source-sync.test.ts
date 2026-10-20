import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import miazzinaFrenchBody from './fixtures/miazzina-french-body';

const sourceLiteral = (value: string): string => value
  .replaceAll('\\', '\\\\')
  .replaceAll("'", "\\'")
  .replaceAll('\n', '\\n');

describe('Miazzina French article source synchronization', () => {
  it('keeps the published body2/body3 equal to the pinned regression fixture', () => {
    const source = execFileSync(
      'git',
      ['show', 'HEAD:packages/articles/content/blog-body/fr/miazzina-pendolare-fisco-ticino.ts'],
      { encoding: 'utf8' },
    );

    for (const field of ['body2', 'body3'] as const) {
      const key = 'blog.article.miazzina-pendolare-fisco-ticino.' + field;
      const expected = "'" + key + "': '" + sourceLiteral(miazzinaFrenchBody[key]) + "',";
      expect(source).toContain(expected);
    }
    expect(source).not.toMatch(/blog\.article\.miazzina-pendolare-fisco-ticino\.body[23]'\s*:\s*'\.\.\./u);
  });
});
