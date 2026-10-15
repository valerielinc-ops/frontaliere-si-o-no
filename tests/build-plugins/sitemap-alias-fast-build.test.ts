import { describe, expect, it } from 'vitest';

import { shouldAwaitJobsSeoPagesFlushed } from '../../build-plugins/shared/buildSignals';

describe('sitemap alias jobs barrier', () => {
  it('does not wait for the omitted jobs producer in FAST_BUILD', () => {
    expect(shouldAwaitJobsSeoPagesFlushed(true)).toBe(false);
  });

  it('keeps the jobs barrier for complete builds', () => {
    expect(shouldAwaitJobsSeoPagesFlushed(false)).toBe(true);
  });
});
