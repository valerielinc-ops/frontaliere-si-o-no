import { describe, expect, it } from 'vitest';
import { extractBodies } from '../../scripts/lib/blog-body-io.mjs';

describe('extractBodies', () => {
  it('reads generated single-, double- and backtick-quoted body literals', () => {
    const source = [
      'const body = {',
      "  'blog.article.demo.body1': 'Prima\\nL\\'altra',",
      '  "blog.article.demo.body2": "Seconda\\n\\\"citazione\\\"",',
      "  'blog.article.demo.body3': `Terza\\nsezione`,",
      '  "blog.article.demo.body4": "Ultima",',
      '};',
    ].join('\n');

    expect(extractBodies(source, 'demo')).toEqual({
      body1: "Prima\nL'altra",
      body2: 'Seconda\n"citazione"',
      body3: 'Terza\nsezione',
      body4: 'Ultima',
    });
  });
});
