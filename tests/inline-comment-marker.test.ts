import { describe, expect, it } from 'vitest';
import { isRegexLiteralStart } from '../scripts/lib/inline-comment-marker.mjs';

describe('isRegexLiteralStart — confronto minore-di seguito da regex', () => {
  it('mantiene regex dopo un confronto con spazio', () => {
    const line = 'if (a < /x/.test(b))';
    expect(isRegexLiteralStart(line, line.indexOf('/x/'))).toBe(true);
  });

  it('mantiene la guardia per uno slash di tag HTML di chiusura', () => {
    const line = '</div>';
    expect(isRegexLiteralStart(line, line.indexOf('/'))).toBe(false);
  });
});
