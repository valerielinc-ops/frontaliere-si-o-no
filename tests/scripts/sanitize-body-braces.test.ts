// @vitest-environment node

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { sanitizeBodyText } from '../../scripts/lib/sanitize-body-braces.mjs';

describe('sanitizeBodyText (#7704)', () => {
  it('drops stray closing and unmatched opening braces while keeping balanced pairs', () => {
    const log = vi.fn();
    const value = sanitizeBodyText('prima } coppia {intatta} finale {aperta', log);

    expect(value).toBe('prima  coppia {intatta} finale aperta');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('2 stray brace'));
  });

  it('removes a stray closing brace from a translated low-quote sentence', () => {
    expect(sanitizeBodyText('Deutsche Übersetzung „Zitat}" endet hier.'))
      .toBe('Deutsche Übersetzung „Zitat" endet hier.');
  });

  it('is wired into the object-object repair output before it is returned', () => {
    const source = readFileSync(
      new URL('../../scripts/repair-object-object-bodies.mjs', import.meta.url),
      'utf8',
    );

    expect(source).toContain("import { sanitizeBodyText } from './lib/sanitize-body-braces.mjs';");
    const sanitizeCall = "const next = sanitizeBodyText([core, ...keep].join('\\n\\n'));";
    expect(source).toContain(sanitizeCall);
    expect(source.indexOf(sanitizeCall)).toBeLessThan(source.indexOf('writeFileSync(t.path, src)'));
  });
});
